// content.js

const OVERLAY_ID = "vc-overlay-root";

let currentTabId = null;
let pinnedNote = false;

// ---- Calibration UI state ----
let calState = "idle"; // idle | confirm | running

// ---- Calibration audio (in-page) ----
let calCtx = null;
let calSrc = null;
let calGain = null;
let calTimer = null;

const CAL_SEC_DEFAULT = 15;
const CAL_TARGET_RMS_DB = -20; // offscreen target と合わせる

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function ensureOverlay() {
  let root = document.getElementById(OVERLAY_ID);
  if (root) return root;

  root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.innerHTML = `
    <div class="vc-box vc-ok">
      <div class="vc-row">
        <div class="vc-title">Volume</div>
        <div class="vc-status" id="vc-status">—</div>
      </div>

      <div class="vc-metrics">
        <div>peak: <span id="vc-peak">—</span></div>
        <div class="vc-line">
          <div>rms: <span id="vc-rms">—</span> dB</div>
          <div id="vc-comfort" class="vc-comfort">快適（-18〜-22）</div>
        </div>
      </div>

      <div class="vc-controls">
        <label class="vc-toggle">
          <input type="checkbox" id="vc-audio-out">
          <span>音声出力</span>
        </label>

        <button class="vc-btn" id="vc-calibrate" type="button">Calibration</button>
      </div>

      <div class="vc-note" id="vc-note" style="display:none;">
        <div id="vc-note-text"></div>
        <button id="vc-note-dismiss" class="vc-note-dismiss" style="display:none;">Calibration終了</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const cb = root.querySelector("#vc-audio-out");

  // 初期: OFF（無音）
  cb.checked = false;

  cb.addEventListener("change", () => {
    if (typeof currentTabId !== "number") return;
    chrome.runtime.sendMessage({
      type: "VC_SET_OUTPUT",
      tabId: currentTabId,
      enabled: cb.checked
    });
  });

  const btn = root.querySelector("#vc-calibrate");
  btn.addEventListener("click", async () => {
    if (typeof currentTabId !== "number") {
      showNote("タブ情報が取得できません。ページを再読み込みしてから再度お試しください。");
      return;
    }

    if (calState === "idle") {
      // 1st click: confirm
      calState = "confirm";
      btn.textContent = "Calibration実行";

      // ★ VC_UPDATE が来ても消えないよう pinned
      showNote("動画を一時停止し、右上が「無音」になってから実行を押してください。", {
        pinned: true,
        showDismiss: true
      });
      return;
    }

    if (calState === "confirm") {
      // 2nd click: run
      calState = "running";
      btn.disabled = true;
      btn.textContent = "Calibrating…";

      const sec = CAL_SEC_DEFAULT;

      try {
        // 1) play calibration noise in this tab (so tabCapture sees it)
        await startCalibrationNoise(sec);

        // 2) ask SW/offscreen to accumulate for sec and compute correction
        await chrome.runtime.sendMessage({
          type: "VC_CALIBRATE_RUN",
          tabId: currentTabId,
          sec
        });

        // completion will come via VC_CALIB_DONE / VC_UPDATE error
        showNote(`校正中…（${sec}秒）この間は動画を停止/ミュート推奨`, {
          pinned: true,
          showDismiss: true
        });
      } catch (e) {
        stopCalibrationNoise();
        calState = "confirm";
        btn.disabled = false;
        btn.textContent = "Calibration実行";
        showNote(`Calibrationに失敗: ${String(e?.message ?? e)}`, {
          pinned: true,
          showDismiss: true
        });
      }
      return;
    }

    // running: ignore
  });

  const dismissBtn = root.querySelector("#vc-note-dismiss");
  dismissBtn.addEventListener("click", () => {
    pinnedNote = false;
    const noteEl = root.querySelector("#vc-note");
    const noteText = root.querySelector("#vc-note-text");
    noteEl.style.display = "none";
    noteText.textContent = "";
    dismissBtn.style.display = "none";
  });

  return root;
}

function setVisible(visible) {
  const root = ensureOverlay();
  root.style.display = visible ? "block" : "none";
}

function showNote(text, opts = {}) {
  const { pinned = false, showDismiss = false } = opts;
  const root = ensureOverlay();
  const noteEl = root.querySelector("#vc-note");
  const noteText = root.querySelector("#vc-note-text");
  const dismissBtn = root.querySelector("#vc-note-dismiss");

  pinnedNote = !!pinned;

  noteEl.style.display = "block";
  noteText.textContent = text;

  dismissBtn.style.display = showDismiss ? "inline-block" : "none";
}

function clearNote() {
  const root = ensureOverlay();
  const noteEl = root.querySelector("#vc-note");
  const noteText = root.querySelector("#vc-note-text");
  const dismissBtn = root.querySelector("#vc-note-dismiss");

  pinnedNote = false;

  noteEl.style.display = "none";
  noteText.textContent = "";
  dismissBtn.style.display = "none";
}

function resetCalibrateButton() {
  const root = ensureOverlay();
  const btn = root.querySelector("#vc-calibrate");
  calState = "idle";
  btn.disabled = false;
  btn.textContent = "Calibration";
}

function setStatus(status, peak, rms_db, message) {
  const root = ensureOverlay();
  const box = root.querySelector(".vc-box");
  const statusEl = root.querySelector("#vc-status");
  const peakEl = root.querySelector("#vc-peak");
  const rmsEl = root.querySelector("#vc-rms");
  const noteEl = root.querySelector("#vc-note");

  let label = status;
  if (status === "OK") label = "🟢 OK";
  if (status === "SMALL") label = "🟡 小さい";
  if (status === "LOUD") label = "🟡 大きい";
  if (status === "WARN") label = "🟡 音量注意";
  if (status === "SILENT") label = "🟣 無音";
  if (status === "DANGER") label = "🔴 危険";
  if (status === "ERROR") label = "⚠️ ERROR";

  statusEl.textContent = label;

  if (typeof peak === "number") peakEl.textContent = peak.toFixed(3);
  if (typeof rms_db === "number") {
    const v = Number.isFinite(rms_db) ? rms_db : -999;
    rmsEl.textContent = v.toFixed(1);
  }

  const comfortEl = root.querySelector("#vc-comfort");
  if (typeof rms_db === "number" && Number.isFinite(rms_db)) {
    const hi = -18;
    const lo = -22;
    const inComfort = (rms_db <= hi && rms_db >= lo);
    comfortEl.classList.toggle("is-on", inComfort);
  } else {
    comfortEl.classList.remove("is-on");
  }

  box.classList.remove("vc-ok", "vc-small", "vc-loud", "vc-warn", "vc-danger", "vc-silent", "vc-error");

  if (status === "OK") box.classList.add("vc-ok");
  else if (status === "SMALL") box.classList.add("vc-small");
  else if (status === "LOUD") box.classList.add("vc-loud");
  else if (status === "WARN") box.classList.add("vc-warn");
  else if (status === "DANGER") box.classList.add("vc-danger");
  else if (status === "SILENT") box.classList.add("vc-silent");
  else box.classList.add("vc-error");

  // --- note handling ---
  // ★重要: VC_UPDATE が来ても note を自動で消さない
  // ただし ERROR のときは message を上書き表示
  const noteText = root.querySelector("#vc-note-text");
  const dismissBtn = root.querySelector("#vc-note-dismiss");

  if (status === "ERROR" && message) {
    pinnedNote = true; // エラーもユーザーが消すまで残す
    noteEl.style.display = "block";
    noteText.textContent = message;
    dismissBtn.style.display = "inline-block";
  }
  // それ以外は「何もしない」（既存noteを維持）
}

// ---- calibration noise (in-page) ----
async function startCalibrationNoise(sec) {
  stopCalibrationNoise();

  // user gesture (button click) context, so resume is usually allowed
  calCtx = new AudioContext({ latencyHint: "playback" });
  try { if (calCtx.state === "suspended") await calCtx.resume(); } catch {}

  const sr = calCtx.sampleRate;
  const len = sr * 1; // 1 sec buffer
  const buf = calCtx.createBuffer(1, len, sr);
  const ch0 = buf.getChannelData(0);

  // white noise
  for (let i = 0; i < len; i++) ch0[i] = (Math.random() * 2 - 1);

  // normalize RMS to target (-20 dB)
  let sumSq = 0;
  for (let i = 0; i < len; i++) sumSq += ch0[i] * ch0[i];
  const rms = Math.sqrt(sumSq / len) || 1e-9;

  const targetGain = dbToGain(CAL_TARGET_RMS_DB);
  const scale = targetGain / rms;
  for (let i = 0; i < len; i++) ch0[i] *= scale;

  calSrc = calCtx.createBufferSource();
  calSrc.buffer = buf;
  calSrc.loop = true;

  calGain = calCtx.createGain();
  calGain.gain.value = 1.0;

  calSrc.connect(calGain);
  calGain.connect(calCtx.destination);

  calSrc.start();

  calTimer = setTimeout(() => {
    stopCalibrationNoise();
    // 結果は offscreen → SW → content の VC_CALIB_DONE を待つ
  }, sec * 1000);
}

function stopCalibrationNoise() {
  try { clearTimeout(calTimer); } catch {}
  calTimer = null;

  try { calSrc?.stop(); } catch {}
  try { calSrc?.disconnect(); } catch {}
  try { calGain?.disconnect(); } catch {}
  try { calCtx?.close(); } catch {}

  calSrc = null;
  calGain = null;
  calCtx = null;
}

// ---- SW messages ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "VC_SHOW") {
    currentTabId = msg.tabId ?? null;
    setVisible(true);
  }

  if (msg.type === "VC_HIDE") {
    setVisible(false);
  }

  if (msg.type === "VC_UPDATE") {
    setVisible(true);
    setStatus(msg.status, msg.peak, msg.rms_db, msg.message);
  }

  if (msg.type === "VC_CALIB_STARTED") {
    // optional hook
  }

  if (msg.type === "VC_CALIB_DONE") {
    stopCalibrationNoise();

    const c = (typeof msg.correction_db === "number" && Number.isFinite(msg.correction_db)) ? msg.correction_db : null;
    const m = (typeof msg.measured_db === "number" && Number.isFinite(msg.measured_db)) ? msg.measured_db : null;

    showNote(
      `校正完了: 補正 ${c.toFixed(1)} dB（測定 ${m.toFixed(1)} dB）`,
      { pinned: true, showDismiss: true }
    );

    resetCalibrateButton();
    return;
  }

  if (msg.type === "VC_CALIB_ERROR") {
    stopCalibrationNoise();
    showNote(`校正に失敗: ${msg.message ?? "unknown error"}`, { pinned: true, showDismiss: true });

    // confirm に戻す（すぐ再試行できる）
    const root = ensureOverlay();
    const btn = root.querySelector("#vc-calibrate");
    calState = "confirm";
    btn.disabled = false;
    btn.textContent = "Calibration実行";
  }
});

// content.js

const OVERLAY_ID = "vc-overlay-root";

let currentTabId = null;
let pinnedNote = false;

// UI sync guard (avoid loop when we set checkbox programmatically)
let suppressOutputChange = false;

// Manual correction
let currentCorrectionDb = 0;

// Test tone (in-page)
let toneCtx = null;
let toneOsc = null;
let toneGain = null;

// Test tone overrides (do NOT change UI toggle; internal only)
let testTonePrevOutputEnabled = null; // null | boolean

const TEST_TONE_HZ = 1000; // 1kHz
const TEST_TONE_DB = -17;  // 表示が -20 dB 前後になるように、内部音量を少し上げている

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

        <div class="vc-line vc-corr">
          <div class="vc-corr-left">
            補正:
            <input id="vc-corr" class="vc-corr-input" type="number" step="0.1" value="0">
            dB
          </div>
          <button class="vc-btn" id="vc-test-tone" type="button">テストトーン</button>
        </div>
      </div>

      <div class="vc-controls">
        <label class="vc-toggle">
          <input type="checkbox" id="vc-audio-out">
          <span>音声出力</span>
        </label>
      </div>

      <div class="vc-note" id="vc-note" style="display:none;">
        <div id="vc-note-text"></div>
        <button id="vc-note-dismiss" class="vc-note-dismiss" style="display:none;">閉じる</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  // --- Output toggle ---
  const cb = root.querySelector("#vc-audio-out");
  cb.checked = false;

  cb.addEventListener("change", () => {
    if (suppressOutputChange) return;
    if (typeof currentTabId !== "number") return;

    chrome.runtime.sendMessage({
      type: "VC_SET_OUTPUT",
      tabId: currentTabId,
      enabled: cb.checked
    });
  });

  // --- Manual correction input ---
  const corr = root.querySelector("#vc-corr");
  corr.addEventListener("change", () => {
    if (typeof currentTabId !== "number") return;

    const v = Number(corr.value);
    if (!Number.isFinite(v)) return;

    currentCorrectionDb = v;

    chrome.runtime.sendMessage({
      type: "VC_SET_CORRECTION",
      tabId: currentTabId,
      correctionDb: v
    });
  });

  // --- Test tone ---
  const toneBtn = root.querySelector("#vc-test-tone");
  toneBtn.addEventListener("click", async () => {
    if (typeof currentTabId !== "number") return;

    // STOP
    if (toneOsc) {
      stopTestTone();
      toneBtn.textContent = "テストトーン";

      // Restore output state (internal only, do not change UI)
      if (testTonePrevOutputEnabled !== null) {
        chrome.runtime.sendMessage({
          type: "VC_TEMP_SET_OUTPUT",
          tabId: currentTabId,
          enabled: testTonePrevOutputEnabled
        });
      }
      testTonePrevOutputEnabled = null;

      // Keep note unless user closes it (pinned note)
      // If you prefer, you can clear note on stop when not pinned:
      // clearNoteIfNotPinned();
      return;
    }

    // START
    try {
      // Capture current toggle state (UI) as "previous output state"
      // (We won't flip the UI; we just restore to this later.)
      const cb = root.querySelector("#vc-audio-out");
      testTonePrevOutputEnabled = !!cb.checked;

      // Force output ON internally so the tone can be heard even if tab is muted / output is off
      chrome.runtime.sendMessage({
        type: "VC_TEMP_SET_OUTPUT",
        tabId: currentTabId,
        enabled: true
      });

      await startTestTone();
      toneBtn.textContent = "停止";

      showNote(
        "動画は一時停止するかミュートにして下さい。15秒ほどテストトーンを再生して、\n目安として「rms が -20 dB 前後」になるように補正値を調整してください。",
        { pinned: true, showDismiss: true }
      );
    } catch (e) {
      showNote(`テストトーン開始に失敗: ${String(e?.message ?? e)}`, { pinned: true, showDismiss: true });
    }
  });

  // note dismiss
  const dismissBtn = root.querySelector("#vc-note-dismiss");
  dismissBtn.addEventListener("click", () => {
    pinnedNote = false;
    hideNote();
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

function hideNote() {
  const root = ensureOverlay();
  const noteEl = root.querySelector("#vc-note");
  const noteText = root.querySelector("#vc-note-text");
  const dismissBtn = root.querySelector("#vc-note-dismiss");

  noteEl.style.display = "none";
  noteText.textContent = "";
  dismissBtn.style.display = "none";
}

function clearNoteIfNotPinned() {
  if (pinnedNote) return;
  hideNote();
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

  box.classList.remove("vc-ok", "vc-small", "vc-loud", "vc-warn", "vc-silent", "vc-error");

  if (status === "OK") box.classList.add("vc-ok");
  else if (status === "SMALL") box.classList.add("vc-small");
  else if (status === "LOUD") box.classList.add("vc-loud");
  else if (status === "WARN") box.classList.add("vc-warn");
  else if (status === "SILENT") box.classList.add("vc-silent");
  else box.classList.add("vc-error");

  // Note behavior:
  // - VC_UPDATEが来ても note は消さない
  // - ERRORだけ message を上書き（ユーザーが閉じるまで残す）
  if (status === "ERROR" && message) {
    pinnedNote = true;
    noteEl.style.display = "block";
    root.querySelector("#vc-note-text").textContent = message;
    root.querySelector("#vc-note-dismiss").style.display = "inline-block";
  }
}

// ---- Test tone (in-page) ----
async function startTestTone() {
  stopTestTone();

  toneCtx = new AudioContext({ latencyHint: "playback" });
  try { if (toneCtx.state === "suspended") await toneCtx.resume(); } catch {}

  toneOsc = toneCtx.createOscillator();
  toneOsc.type = "sine";
  toneOsc.frequency.value = TEST_TONE_HZ;

  toneGain = toneCtx.createGain();

  // Conservative, users adjust correction until overlay reads around -20 dB
  toneGain.gain.value = dbToGain(TEST_TONE_DB);

  toneOsc.connect(toneGain);
  toneGain.connect(toneCtx.destination);

  toneOsc.start();
}

function stopTestTone() {
  try { toneOsc?.stop(); } catch {}
  try { toneOsc?.disconnect(); } catch {}
  try { toneGain?.disconnect(); } catch {}
  try { toneCtx?.close(); } catch {}

  toneOsc = null;
  toneGain = null;
  toneCtx = null;
}

// ---- SW messages ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "VC_SHOW") {
    currentTabId = msg.tabId ?? null;
    setVisible(true);

    // initial UI state from SW
    const root = ensureOverlay();

    // output state
    const cb = root.querySelector("#vc-audio-out");
    suppressOutputChange = true;
    cb.checked = !!msg.outputEnabled;
    suppressOutputChange = false;

    // correction
    const corr = root.querySelector("#vc-corr");
    const c = Number(msg.correctionDb ?? 0);
    currentCorrectionDb = Number.isFinite(c) ? c : 0;
    corr.value = String(currentCorrectionDb.toFixed(1));
  }

  if (msg.type === "VC_HIDE") {
    setVisible(false);
    stopTestTone();

    // Restore output state if tone was active
    if (typeof currentTabId === "number" && testTonePrevOutputEnabled !== null) {
      chrome.runtime.sendMessage({
        type: "VC_TEMP_SET_OUTPUT",
        tabId: currentTabId,
        enabled: testTonePrevOutputEnabled
      });
    }
    testTonePrevOutputEnabled = null;
  }

  if (msg.type === "VC_UPDATE") {
    setVisible(true);
    setStatus(msg.status, msg.peak, msg.rms_db, msg.message);
  }

  // ACK: actual output state from offscreen/SW
  if (msg.type === "VC_OUTPUT_STATE") {
    // NOTE: user asked not to flip UI for test tone.
    // We only reflect real state when it's from normal toggling / start.
    // (If you want to always reflect, remove this guard.)
    if (toneOsc) return;

    const root = ensureOverlay();
    const cb = root.querySelector("#vc-audio-out");
    suppressOutputChange = true;
    cb.checked = !!msg.enabled;
    suppressOutputChange = false;
  }

  // correction state from SW (optional UI sync)
  if (msg.type === "VC_CORRECTION_STATE") {
    const root = ensureOverlay();
    const corr = root.querySelector("#vc-corr");
    const c = Number(msg.correctionDb ?? 0);
    if (Number.isFinite(c)) {
      currentCorrectionDb = c;
      corr.value = String(currentCorrectionDb.toFixed(1));
    }
  }
});

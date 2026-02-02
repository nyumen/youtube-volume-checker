// content.js

const OVERLAY_ID = "vc-overlay-root";

let currentTabId = null;

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
      </div>

      <div class="vc-note" id="vc-note" style="display:none;"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const cb = root.querySelector("#vc-audio-out");

  // 初期: OFF（無音）
  cb.checked = false;

  // ★ change リスナーは1つだけ：tabId付きで送る
  cb.addEventListener("change", () => {
    if (typeof currentTabId !== "number") return;
    chrome.runtime.sendMessage({
      type: "VC_SET_OUTPUT",
      tabId: currentTabId,
      enabled: cb.checked
    });
  });

  return root;
}

function setVisible(visible) {
  const root = ensureOverlay();
  root.style.display = visible ? "block" : "none";
}

function setStatus(status, peak, rms_db, message) {
  const root = ensureOverlay();
  const box = root.querySelector(".vc-box");
  const statusEl = root.querySelector("#vc-status");
  const peakEl = root.querySelector("#vc-peak");
  const rmsEl = root.querySelector("#vc-rms");
  const noteEl = root.querySelector("#vc-note");

  // 表示テキスト
  let label = status;
  if (status === "OK") label = "🟢 OK";
  if (status === "SMALL") label = "🟡 小さい";
  if (status === "LOUD") label = "🟡 大きい";
  if (status === "WARN") label = "🟡 音量注意";
  if (status === "SILENT") label = "🟣 無音";
  if (status === "DANGER") label = "🔴 危険";
  if (status === "ERROR") label = "⚠️ ERROR";

  statusEl.textContent = label;

  // 数値（小数整形）
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

  // クラス
  box.classList.remove(
    "vc-ok",
    "vc-small",
    "vc-loud",
    "vc-warn",
    "vc-danger",
    "vc-silent",
    "vc-error"
  );

  if (status === "OK") box.classList.add("vc-ok");
  else if (status === "SMALL") box.classList.add("vc-small");
  else if (status === "LOUD") box.classList.add("vc-loud");
  else if (status === "WARN") box.classList.add("vc-warn");
  else if (status === "DANGER") box.classList.add("vc-danger");
  else if (status === "SILENT") box.classList.add("vc-silent");
  else box.classList.add("vc-error");

  // エラー文
  if (status === "ERROR" && message) {
    noteEl.style.display = "block";
    noteEl.textContent = message;
  } else {
    noteEl.style.display = "none";
    noteEl.textContent = "";
  }
}

// SW からの更新を受ける
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
});

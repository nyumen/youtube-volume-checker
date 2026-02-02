// service_worker.js (MV3, module)

const OFFSCREEN_URL = "offscreen.html";
const stateByTab = new Map();

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const offscreen = contexts.find((c) => c.contextType === "OFFSCREEN_DOCUMENT");
  if (offscreen) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Analyze tab audio and optionally play it back (mute/unmute) via GainNode."
  });
}

function isRunning(tabId) {
  return stateByTab.get(tabId)?.running === true;
}

async function startForTab(tabId) {
  await ensureOffscreen();
  stateByTab.set(tabId, { running: true });

  chrome.tabs.sendMessage(tabId, { type: "VC_SHOW", tabId }).catch(() => {});

  // ★ ここが重要: SWで streamId を取る（Chrome 116+）
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  // offscreen に streamId を渡して getUserMedia させる
  chrome.runtime.sendMessage({
    type: "VC_START",
    tabId,
    streamId
  });
}

async function stopForTab(tabId) {
  stateByTab.set(tabId, { running: false });

  chrome.runtime.sendMessage({ type: "VC_STOP", tabId });
  chrome.tabs.sendMessage(tabId, { type: "VC_HIDE" }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;

  try {
    if (isRunning(tabId)) {
      await stopForTab(tabId);
    } else {
      await startForTab(tabId);
    }
  } catch (err) {
    chrome.tabs.sendMessage(tabId, {
      type: "VC_UPDATE",
      status: "ERROR",
      peak: 0,
      rms_db: -Infinity,
      message: String(err?.message ?? err)
    }).catch(() => {});
  }
});

// offscreen からメトリクスを受けて content に中継
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  // content script -> SW -> offscreen（音声出力トグル）
  if (msg.type === "VC_SET_OUTPUT") {
    const { tabId, enabled } = msg;
    if (typeof tabId !== "number") return;

    // offscreen に転送
    chrome.runtime.sendMessage({
      type: "VC_SET_OUTPUT",
      tabId,
      enabled: !!enabled
    });
    return;
  }

  // offscreen -> SW -> content（解析メトリクス）
  if (msg.type === "VC_METRICS") {
    const { tabId, status, peak, rms_db } = msg;
    if (typeof tabId !== "number") return;

    chrome.tabs.sendMessage(tabId, {
      type: "VC_UPDATE",
      status,
      peak,
      rms_db
    }).catch(() => {});
    return;
  }

  // offscreen -> SW -> content（エラー）
  if (msg.type === "VC_ERROR") {
    const { tabId, message } = msg;
    if (typeof tabId !== "number") return;

    chrome.tabs.sendMessage(tabId, {
      type: "VC_UPDATE",
      status: "ERROR",
      peak: 0,
      rms_db: -Infinity,
      message
    }).catch(() => {});
    return;
  }
});

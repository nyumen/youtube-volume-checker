// service_worker.js (MV3, module)

const OFFSCREEN_URL = "offscreen.html";
const stateByTab = new Map();

// Storage keys
const KEY_CORRECTION_DB = "correction_db";
const KEY_OUTPUT_ENABLED = "output_enabled";

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

async function loadSettings() {
  try {
    const v = await chrome.storage.local.get([KEY_CORRECTION_DB, KEY_OUTPUT_ENABLED]);
    const correctionDb =
      (typeof v?.[KEY_CORRECTION_DB] === "number" && Number.isFinite(v[KEY_CORRECTION_DB]))
        ? v[KEY_CORRECTION_DB]
        : 0;

    const outputEnabled = (typeof v?.[KEY_OUTPUT_ENABLED] === "boolean")
      ? v[KEY_OUTPUT_ENABLED]
      : false;

    return { correctionDb, outputEnabled };
  } catch {
    return { correctionDb: 0, outputEnabled: false };
  }
}

async function saveCorrectionDb(correctionDb) {
  try {
    await chrome.storage.local.set({ [KEY_CORRECTION_DB]: correctionDb });
  } catch {}
}

async function saveOutputEnabled(outputEnabled) {
  try {
    await chrome.storage.local.set({ [KEY_OUTPUT_ENABLED]: !!outputEnabled });
  } catch {}
}

async function startForTab(tabId) {
  await ensureOffscreen();
  stateByTab.set(tabId, { running: true });

  const { correctionDb, outputEnabled } = await loadSettings();

  // content に表示（初期値も渡す）
  chrome.tabs.sendMessage(tabId, {
    type: "VC_SHOW",
    tabId,
    correctionDb,
    outputEnabled
  }).catch(() => {});

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  chrome.runtime.sendMessage({
    type: "VC_START",
    tabId,
    streamId,
    correctionDb,
    outputEnabled
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
    if (isRunning(tabId)) await stopForTab(tabId);
    else await startForTab(tabId);
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

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  // content -> SW : テストトーン用（保存しない）一時出力切替
  if (msg.type === "VC_TEMP_SET_OUTPUT") {
    const { tabId, enabled } = msg;
    if (typeof tabId !== "number") return;

    // offscreenへ反映（保存しない）
    chrome.runtime.sendMessage({
      type: "VC_SET_OUTPUT",
      tabId,
      enabled: !!enabled
    });

    // contentへ確定状態を通知（UI同期）
    chrome.tabs.sendMessage(tabId, {
      type: "VC_OUTPUT_STATE",
      enabled: !!enabled
    }).catch(() => {});

    return;
  }

  // content -> SW : 音声出力トグル（永続化 + offscreenへ）
  if (msg.type === "VC_SET_OUTPUT") {
    const { tabId, enabled } = msg;
    if (typeof tabId !== "number") return;

    (async () => {
      await saveOutputEnabled(!!enabled);

      // offscreenへ反映
      chrome.runtime.sendMessage({
        type: "VC_SET_OUTPUT",
        tabId,
        enabled: !!enabled
      });

      // contentへ “確定した状態” を通知（UI同期）
      chrome.tabs.sendMessage(tabId, {
        type: "VC_OUTPUT_STATE",
        enabled: !!enabled
      }).catch(() => {});
    })();

    return;
  }

  // content -> SW : 補正値（永続化 + offscreenへ）
  if (msg.type === "VC_SET_CORRECTION") {
    const { tabId, correctionDb } = msg;
    if (typeof tabId !== "number") return;

    const n = Number(correctionDb);
    if (!Number.isFinite(n)) return;

    (async () => {
      await saveCorrectionDb(n);

      chrome.runtime.sendMessage({
        type: "VC_SET_CORRECTION",
        tabId,
        correctionDb: n
      });

      // contentにも反映（必要ならUI同期用）
      chrome.tabs.sendMessage(tabId, {
        type: "VC_CORRECTION_STATE",
        correctionDb: n
      }).catch(() => {});
    })();

    return;
  }

  // offscreen -> SW : 解析メトリクス
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

  // offscreen -> SW : エラー
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

  // offscreen -> SW : 実際の出力状態（ACK）→ contentへ（UI同期）
  if (msg.type === "VC_OUTPUT_STATE") {
    const { tabId, enabled } = msg;
    if (typeof tabId !== "number") return;

    chrome.tabs.sendMessage(tabId, {
      type: "VC_OUTPUT_STATE",
      enabled: !!enabled
    }).catch(() => {});
    return;
  }
});

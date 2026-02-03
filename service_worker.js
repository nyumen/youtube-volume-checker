// service_worker.js (MV3, module)

const OFFSCREEN_URL = "offscreen.html";
const stateByTab = new Map();

// in-memory fallback if storage permission not present
let correctionDbMemory = 0;

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

async function loadCorrectionDb() {
  try {
    if (!chrome?.storage?.local) return correctionDbMemory ?? 0;
    const v = await chrome.storage.local.get(["correction_db"]);
    const n = v?.correction_db;
    return (typeof n === "number" && Number.isFinite(n)) ? n : 0;
  } catch {
    return correctionDbMemory ?? 0;
  }
}

async function saveCorrectionDb(correction_db, measured_db, target_db) {
  correctionDbMemory = correction_db;
  try {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.set({
      correction_db,
      measured_db,
      target_db,
      calibrated_at: Date.now()
    });
  } catch {}
}

async function startForTab(tabId) {
  await ensureOffscreen();
  stateByTab.set(tabId, { running: true });

  chrome.tabs.sendMessage(tabId, { type: "VC_SHOW", tabId }).catch(() => {});

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  const correctionDb = await loadCorrectionDb();

  chrome.runtime.sendMessage({
    type: "VC_START",
    tabId,
    streamId,
    correctionDb
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

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  // content script -> SW -> offscreen（音声出力トグル）
  if (msg.type === "VC_SET_OUTPUT") {
    const { tabId, enabled } = msg;
    if (typeof tabId !== "number") return;

    chrome.runtime.sendMessage({
      type: "VC_SET_OUTPUT",
      tabId,
      enabled: !!enabled
    });
    return;
  }

  // content script -> SW -> offscreen（校正開始）
  if (msg.type === "VC_CALIBRATE_RUN") {
    const { tabId, sec } = msg;
    if (typeof tabId !== "number") return;

    (async () => {
      // running でなければ開始
      if (!isRunning(tabId)) {
        await startForTab(tabId);
      } else {
        await ensureOffscreen();
      }

      // offscreenへ「今のセッションで校正集計開始」
      chrome.runtime.sendMessage({
        type: "VC_BEGIN_CALIB",
        tabId,
        sec: (typeof sec === "number" && sec > 0) ? sec : 15
      });

      chrome.tabs.sendMessage(tabId, { type: "VC_CALIB_STARTED" }).catch(() => {});
    })().catch((e) => {
      chrome.tabs.sendMessage(tabId, {
        type: "VC_CALIB_ERROR",
        message: String(e?.message ?? e)
      }).catch(() => {});
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

    // 校正中のボタン復帰用（content側）
    chrome.tabs.sendMessage(tabId, {
      type: "VC_CALIB_ERROR",
      message
    }).catch(() => {});
    return;
  }

  // offscreen -> SW : 校正結果
  if (msg.type === "VC_CALIB_RESULT") {
    const { tabId, measured_db, correction_db, target_db } = msg;
    if (typeof tabId !== "number") return;

    (async () => {
      await saveCorrectionDb(correction_db, measured_db, target_db);

      // offscreen に補正値を反映（以後の表示/判定が補正済みに）
      chrome.runtime.sendMessage({
        type: "VC_SET_CORRECTION",
        tabId,
        correctionDb: correction_db
      });

      // content に完了通知
      chrome.tabs.sendMessage(tabId, {
        type: "VC_CALIB_DONE",
        measured_db,
        correction_db,
        target_db
      }).catch(() => {});
    })().catch((e) => {
      chrome.tabs.sendMessage(tabId, {
        type: "VC_CALIB_ERROR",
        message: String(e?.message ?? e)
      }).catch(() => {});
    });

    return;
  }
});

// offscreen.js (MV3 offscreen document, module)
console.log("[VC] offscreen loaded");

// ===== Config =====
const UPDATE_INTERVAL_MS = 500;
const WINDOW_SEC = 10;

// Thresholds
const PEAK_WARN = 0.98;        // 🟡 音量注意: accumulated >= 0.5s in last 10s
const WARN_HOLD_SEC = 0.5;

const RMS_SMALL_DB = -24;
const RMS_LOUD_DB  = -16;

// Silent detection (avoid "SMALL" when paused)
const SILENT_RMS_DB = -60;
const SILENT_PEAK   = 0.01;

// Worklet report chunk size
const WORKLET_REPORT_SAMPLES = 4096;

const sessions = new Map();

function nowMs() { return performance.now(); }

function rmsToDb(rms) {
  const v = Math.max(rms, 1e-10);
  return 20 * Math.log10(v);
}

function pruneOldBlocks(blocks, cutoffMs) {
  while (blocks.length && blocks[0].t < cutoffMs) blocks.shift();
}

function computeWindowMetrics(blocks, cutoffMs) {
  pruneOldBlocks(blocks, cutoffMs);

  let peak = 0;
  let sumSq = 0;
  let n = 0;
  let warnTimeSec = 0;

  for (const b of blocks) {
    peak = Math.max(peak, b.peak);
    sumSq += b.sumSq;
    n += b.n;

    if (b.peak > PEAK_WARN) warnTimeSec += (b.durSec ?? 0);
  }

  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const rms_db = rmsToDb(rms);

  return { peak, rms_db, warnTimeSec };
}

function classify({ peak, rms_db, warnTimeSec }) {
  // priority: WARN > SILENT > SMALL > LOUD > OK
  if (warnTimeSec >= WARN_HOLD_SEC) return "WARN";
  if (rms_db <= SILENT_RMS_DB && peak <= SILENT_PEAK) return "SILENT";
  if (rms_db < RMS_SMALL_DB) return "SMALL";
  if (rms_db > RMS_LOUD_DB) return "LOUD";
  return "OK";
}

async function startWithStreamId(tabId, streamId, correctionDb = 0, outputEnabled = false) {
  if (sessions.has(tabId)) await stop(tabId);

  try {
    console.log("[VC] startWithStreamId", { tabId, streamId });

    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    const audioCtx = new AudioContext({ latencyHint: "playback" });
    try { if (audioCtx.state === "suspended") await audioCtx.resume(); } catch {}

    const source = audioCtx.createMediaStreamSource(media);

    // Playback control
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = outputEnabled ? 1.0 : 0.0;

    // Analysis path is silent (avoid audible artifacts)
    const silentOut = audioCtx.createGain();
    silentOut.gain.value = 0.0;

    // Worklet meter
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("vc-meter-processor.js"));
    const meterNode = new AudioWorkletNode(audioCtx, "vc-meter", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { reportSamples: WORKLET_REPORT_SAMPLES }
    });

    const blocks = [];

    const session = {
      tabId,
      media,
      audioCtx,
      source,
      meterNode,
      gainNode,
      silentOut,
      blocks,
      timer: null,
      outputEnabled: !!outputEnabled,
      correctionDb: Number.isFinite(correctionDb) ? correctionDb : 0
    };

    // Receive block metrics from worklet
    meterNode.port.onmessage = (ev) => {
      const d = ev?.data || {};
      if (typeof d.peak !== "number") return;

      session.blocks.push({
        t: nowMs(),
        peak: d.peak,
        sumSq: typeof d.sumSq === "number" ? d.sumSq : 0,
        n: typeof d.n === "number" ? d.n : 0,
        durSec: typeof d.durSec === "number" ? d.durSec : 0
      });

      pruneOldBlocks(session.blocks, nowMs() - (WINDOW_SEC + 2) * 1000);
    };

    // ===== Graph =====
    // Playback path: source -> gain -> destination
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // Analysis path: source -> meter -> silent -> destination
    source.connect(meterNode);
    meterNode.connect(silentOut);
    silentOut.connect(audioCtx.destination);

    // Send initial ACK to sync UI
    chrome.runtime.sendMessage({
      type: "VC_OUTPUT_STATE",
      tabId,
      enabled: session.outputEnabled
    });

    const timer = setInterval(() => {
      const cutoffMs = nowMs() - WINDOW_SEC * 1000;
      const metrics = computeWindowMetrics(session.blocks, cutoffMs);

      // Apply correction to RMS(dB) only (peak unchanged)
      const rms_db_corrected = metrics.rms_db + session.correctionDb;

      const status = classify({
        peak: metrics.peak,
        rms_db: rms_db_corrected,
        warnTimeSec: metrics.warnTimeSec
      });

      chrome.runtime.sendMessage({
        type: "VC_METRICS",
        tabId,
        status,
        peak: metrics.peak,
        rms_db: rms_db_corrected
      });
    }, UPDATE_INTERVAL_MS);

    session.timer = timer;
    sessions.set(tabId, session);

  } catch (err) {
    console.error("[VC] offscreen start error", err);
    chrome.runtime.sendMessage({
      type: "VC_ERROR",
      tabId,
      message: String(err?.message ?? err)
    });
  }
}

async function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;

  try {
    clearInterval(s.timer);

    try { s.meterNode?.port?.postMessage({ type: "STOP" }); } catch {}
    try { s.meterNode?.disconnect(); } catch {}
    try { s.source?.disconnect(); } catch {}
    try { s.gainNode?.disconnect(); } catch {}
    try { s.silentOut?.disconnect(); } catch {}

    try { await s.audioCtx.close(); } catch {}
    try { s.media.getTracks().forEach(t => t.stop()); } catch {}
  } finally {
    sessions.delete(tabId);
  }
}

function setOutput(tabId, enabled) {
  const s = sessions.get(tabId);
  if (!s) return;

  s.outputEnabled = !!enabled;
  s.gainNode.gain.value = s.outputEnabled ? 1.0 : 0.0;

  // ACK back
  chrome.runtime.sendMessage({
    type: "VC_OUTPUT_STATE",
    tabId,
    enabled: s.outputEnabled
  });

  console.log("[VC] output", tabId, s.outputEnabled ? "ON" : "OFF");
}

function setCorrection(tabId, correctionDb) {
  const s = sessions.get(tabId);
  if (!s) return;
  if (typeof correctionDb !== "number" || !Number.isFinite(correctionDb)) return;

  s.correctionDb = correctionDb;
  console.log("[VC] correction", tabId, correctionDb.toFixed(2), "dB");
}

// ===== Message bridge =====
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "VC_START" && typeof msg.tabId === "number") {
    if (!msg.streamId) {
      chrome.runtime.sendMessage({
        type: "VC_ERROR",
        tabId: msg.tabId,
        message: "Missing streamId (tabCapture.getMediaStreamId failed)."
      });
      return;
    }
    startWithStreamId(
      msg.tabId,
      msg.streamId,
      msg.correctionDb ?? 0,
      msg.outputEnabled ?? false
    );
    return;
  }

  if (msg.type === "VC_STOP" && typeof msg.tabId === "number") {
    stop(msg.tabId);
    return;
  }

  if (msg.type === "VC_SET_OUTPUT" && typeof msg.tabId === "number") {
    setOutput(msg.tabId, !!msg.enabled);
    return;
  }

  if (msg.type === "VC_SET_CORRECTION" && typeof msg.tabId === "number") {
    setCorrection(msg.tabId, msg.correctionDb);
    return;
  }
});

// offscreen.js (MV3 offscreen document, module)
//
// - Receive {tabId, streamId} from SW
// - getUserMedia with chromeMediaSourceId
// - Analyze last 10s: peak, rms_db
// - Status every 0.5s
// - Optional playback via GainNode (default muted)
// - Rules (priority): DANGER(0.995 any) > WARN(0.98 >=0.5s) > SILENT > SMALL > LOUD > OK

console.log("[VC] offscreen loaded");

// ===== Config =====
const UPDATE_INTERVAL_MS = 500;
const WINDOW_SEC = 10;

// Thresholds (user spec)
const PEAK_DANGER_ANY = 0.995;    // DANGER: any occurrence in window
const PEAK_WARN = 0.98;           // WARN: accumulated time in window
const WARN_HOLD_SEC = 0.5;

const RMS_SMALL_DB = -24;        // user requested
const RMS_LOUD_DB = -16;         // user adjusted

// "Silent" detection (to avoid "SMALL" when paused)
// You can tune these after trying.
const SILENT_RMS_DB = -60;        // below this is effectively silent
const SILENT_PEAK = 0.01;         // also require peak small

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
  let dangerSeen = false;

  for (const b of blocks) {
    peak = Math.max(peak, b.peak);
    sumSq += b.sumSq;
    n += b.n;

    if (b.peak > PEAK_DANGER_ANY) dangerSeen = true;
    if (b.peak > PEAK_WARN) warnTimeSec += (b.durSec ?? 0);
  }

  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const rms_db = rmsToDb(rms);

  return { peak, rms_db, warnTimeSec, dangerSeen };
}

function classify({ peak, rms_db, warnTimeSec, dangerSeen }) {
  // priority: DANGER > WARN > SILENT > SMALL > LOUD > OK
  if (dangerSeen) return "DANGER";
  if (warnTimeSec >= WARN_HOLD_SEC) return "WARN";

  // silent (pause) should not show SMALL
  if (rms_db <= SILENT_RMS_DB && peak <= SILENT_PEAK) return "SILENT";

  if (rms_db < RMS_SMALL_DB) return "SMALL";
  if (rms_db > RMS_LOUD_DB) return "LOUD";
  return "OK";
}

async function startWithStreamId(tabId, streamId) {
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

    const audioCtx = new AudioContext();
    try { if (audioCtx.state === "suspended") await audioCtx.resume(); } catch {}

    const source = audioCtx.createMediaStreamSource(media);

    // IMPORTANT: output channels = 2, so we can pass-through to outputBuffer
    const processor = audioCtx.createScriptProcessor(4096, 2, 2);

    // Playback control (default muted)
    const gainNode = audioCtx.createGain();
    const outputEnabled = false;
    gainNode.gain.value = outputEnabled ? 1.0 : 0.0;

    const blocks = [];

    processor.onaudioprocess = (e) => {
      const inBuf = e.inputBuffer;
      const outBuf = e.outputBuffer;

      // ---- pass-through: copy input -> output ----
      const inCh0 = inBuf.getChannelData(0);
      const outCh0 = outBuf.getChannelData(0);
      outCh0.set(inCh0);

      const outCh1 = outBuf.getChannelData(1);
      if (inBuf.numberOfChannels > 1) {
        const inCh1 = inBuf.getChannelData(1);
        outCh1.set(inCh1);
      } else {
        outCh1.set(inCh0); // duplicate mono
      }

      // ---- analysis: use ch0 for metrics ----
      const sr = audioCtx.sampleRate;
      const durSec = inCh0.length / sr;

      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < inCh0.length; i++) {
        const v = inCh0[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sumSq += v * v;
      }

      blocks.push({
        t: nowMs(),
        peak,
        sumSq,
        n: inCh0.length,
        durSec
      });

      pruneOldBlocks(blocks, nowMs() - (WINDOW_SEC + 2) * 1000);
    };

    // Graph: source -> processor -> gain -> destination
    source.connect(processor);
    processor.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const timer = setInterval(() => {
      const cutoffMs = nowMs() - WINDOW_SEC * 1000;
      const metrics = computeWindowMetrics(blocks, cutoffMs);
      const status = classify(metrics);

      chrome.runtime.sendMessage({
        type: "VC_METRICS",
        tabId,
        status,
        peak: metrics.peak,
        rms_db: metrics.rms_db
      });
    }, UPDATE_INTERVAL_MS);

    sessions.set(tabId, {
      tabId,
      media,
      audioCtx,
      source,
      processor,
      gainNode,
      blocks,
      timer,
      outputEnabled
    });

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
    try { s.processor.disconnect(); } catch {}
    try { s.source.disconnect(); } catch {}
    try { s.gainNode.disconnect(); } catch {}
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
  console.log("[VC] output", tabId, s.outputEnabled ? "ON" : "OFF");
}

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
    startWithStreamId(msg.tabId, msg.streamId);
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
});

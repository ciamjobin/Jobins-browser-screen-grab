const shareButton = document.getElementById('share');
const stateEl = document.getElementById('state');
const video = document.getElementById('preview');

let stream = null;
let monitorTimer = 0;
let memoryReportTimer = 0;
let settleTimer = 0;
let previousSample = null;
let lastAutomaticCaptureSample = null;
let lastVisualChangeAt = 0;
let visualChangeStartedAt = 0;
let suppressMonitorUntil = 0;
let missedSampleCount = 0;
let screenLossNotified = false;
let unhealthySampleCount = 0;
let unhealthyScreenNotified = false;
let captureActive = true;
let sharedWidth = 0;
let sharedHeight = 0;
let automaticFramePendingId = null;
let automaticFrameWatchdog = 0;
let visualChangePending = false;
let nextFrameId = 1;
let bufferedBytes = 0;
let frameEncodeChain = Promise.resolve();
const bufferedFrames = new Map();
const sampleCanvas = document.createElement('canvas');
const SAMPLE_WIDTH = 128;
const SAMPLE_HEIGHT = 72;
const MONITOR_INTERVAL_MS = 250;
const MEMORY_REPORT_INTERVAL_MS = 5000;
const MONITOR_SETTLE_MS = 350;
const MONITOR_MAX_SETTLE_MS = 1500;
const AUTOMATIC_FRAME_WATCHDOG_MS = 25000;
const MIN_CHANGED_PIXEL_RATIO = 0.0008;
const MIN_AUTOMATIC_CAPTURE_CHANGED_PIXEL_RATIO = 0.006;
const MIN_AUTOMATIC_CAPTURE_DETAIL_RATIO = 0.006;
const MAX_DOMINANT_COLOR_RATIO = 0.9;
const UNHEALTHY_SAMPLE_LIMIT = 8;
const FRAME_HEAL_ATTEMPTS = 5;
const FRAME_HEAL_WAIT_MS = 250;
const MAX_BUFFERED_FRAMES = 100;
const MAX_BUFFERED_BYTES = 512 * 1024 * 1024;

function reportScreenMemoryStatus() {
  const memory = globalThis.performance?.memory;
  const bytes = (value) => Number.isFinite(value) && value >= 0 ? value : null;
  const deviceMemory = Number(globalThis.navigator?.deviceMemory);
  const status = {
    type: 'SCREEN_MEMORY_STATUS',
    source: 'screen-window',
    jsHeapUsedBytes: bytes(memory?.usedJSHeapSize),
    jsHeapLimitBytes: bytes(memory?.jsHeapSizeLimit),
    deviceMemoryGb: Number.isFinite(deviceMemory) && deviceMemory >= 0 ? deviceMemory : null,
    screenBufferedBytes: bufferedBytes,
    screenBufferedFrames: bufferedFrames.size
  };
  try {
    Promise.resolve(chrome.runtime.sendMessage(status)).catch(() => {});
  } catch {}
}

function setState(text, kind) {
  stateEl.textContent = text;
  stateEl.className = `status ${kind}`;
}

function clearBufferedCaptureState() {
  clearInterval(monitorTimer);
  clearInterval(memoryReportTimer);
  clearTimeout(settleTimer);
  clearTimeout(automaticFrameWatchdog);
  monitorTimer = 0;
  memoryReportTimer = 0;
  settleTimer = 0;
  previousSample = null;
  lastAutomaticCaptureSample = null;
  visualChangeStartedAt = 0;
  automaticFramePendingId = null;
  automaticFrameWatchdog = 0;
  visualChangePending = false;
  missedSampleCount = 0;
  unhealthySampleCount = 0;
  unhealthyScreenNotified = false;
  sharedWidth = 0;
  sharedHeight = 0;
  bufferedFrames.clear();
  bufferedBytes = 0;
  reportScreenMemoryStatus();
}

function stopStream() {
  clearBufferedCaptureState();
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
}

function waitForFreshVideoFrame() {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const timeout = setTimeout(finish, FRAME_HEAL_WAIT_MS);
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        clearTimeout(timeout);
        finish();
      });
    }
  });
}

function drawCaptureCanvas() {
  if (!stream || !hasStableMonitorDimensions()) return null;
  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  captureCanvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0);
  if (!isUsableScreenSample(sampleSource(captureCanvas, captureCanvas.width, captureCanvas.height))) {
    return null;
  }
  return captureCanvas;
}

async function captureHealthyCanvas() {
  for (let attempt = 0; attempt < FRAME_HEAL_ATTEMPTS; attempt += 1) {
    const captureCanvas = drawCaptureCanvas();
    if (captureCanvas) return captureCanvas;
    if (attempt < FRAME_HEAL_ATTEMPTS - 1) await waitForFreshVideoFrame();
  }
  return null;
}

async function frameDataUrl(type = 'image/png', quality) {
  return queueFrameEncode(async () => {
    const captureCanvas = await captureHealthyCanvas();
    if (!captureCanvas) return null;
    try {
      return captureCanvas.toDataURL(type, quality);
    } finally {
      captureCanvas.width = 0;
      captureCanvas.height = 0;
    }
  });
}

async function frameBlob(type = 'image/jpeg', quality = 0.82) {
  return queueFrameEncode(async () => {
    const captureCanvas = await captureHealthyCanvas();
    if (!captureCanvas) return null;
    try {
      return await new Promise((resolve) => captureCanvas.toBlob(resolve, type, quality));
    } finally {
      captureCanvas.width = 0;
      captureCanvas.height = 0;
    }
  });
}

function queueFrameEncode(task) {
  const result = frameEncodeChain.catch(() => {}).then(task);
  frameEncodeChain = result.then(() => {}, () => {});
  return result;
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read buffered screen frame.'));
    reader.readAsDataURL(blob);
  });
}

async function bufferFrame() {
  const blob = await frameBlob();
  if (!blob) {
    return { error: stream ? 'The shared screen frame is blank or unavailable.' : 'No active screen stream.' };
  }
  if (bufferedFrames.size >= MAX_BUFFERED_FRAMES || bufferedBytes + blob.size > MAX_BUFFERED_BYTES) {
    reportScreenMemoryStatus();
    return { error: 'The screen capture buffer is full. Wait for pending screenshots to finish.' };
  }
  const frameId = `screen-${Date.now()}-${nextFrameId++}`;
  bufferedFrames.set(frameId, blob);
  bufferedBytes += blob.size;
  reportScreenMemoryStatus();
  return { frameId };
}

function suppressVisualMonitor(durationMs = 1000) {
  suppressMonitorUntil = Math.max(suppressMonitorUntil, Date.now() + durationMs);
  clearTimeout(settleTimer);
  settleTimer = 0;
  visualChangeStartedAt = 0;
}

async function takeBufferedFrame(frameId) {
  const blob = bufferedFrames.get(frameId);
  if (!blob) return { error: 'Buffered screen frame expired.' };
  bufferedFrames.delete(frameId);
  bufferedBytes -= blob.size;
  reportScreenMemoryStatus();
  return { dataUrl: await blobDataUrl(blob) };
}

function sampleSource(source, width, height) {
  try {
    sampleCanvas.width = SAMPLE_WIDTH;
    sampleCanvas.height = SAMPLE_HEIGHT;
    const context = sampleCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const sourceTop = Math.round(height * 0.1);
    const sourceHeight = Math.max(1, Math.round(height * 0.84));
    context.drawImage(source, 0, sourceTop, width, sourceHeight, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    return context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
  } catch {
    return null;
  }
}

function sampleFrame() {
  if (!stream || !video.videoWidth) return null;
  return sampleSource(video, video.videoWidth, video.videoHeight);
}

function notifyScreenLoss() {
  if (screenLossNotified) return;
  screenLossNotified = true;
  chrome.runtime.sendMessage({ type: 'SCREEN_ENDED', source: 'screen-window' }).catch(() => {});
}

function changedPixelRatio(previous, current) {
  if (!previous || !current || previous.length !== current.length) return 1;
  let changed = 0;
  const pixels = current.length / 4;
  for (let index = 0; index < current.length; index += 4) {
    const difference =
      Math.abs(current[index] - previous[index]) +
      Math.abs(current[index + 1] - previous[index + 1]) +
      Math.abs(current[index + 2] - previous[index + 2]);
    if (difference >= 48) changed += 1;
  }
  return changed / pixels;
}

function detailedPixelRatio(sample) {
  if (!sample?.length) return 0;
  const cornerIndexes = [0, SAMPLE_WIDTH - 1, (SAMPLE_HEIGHT - 1) * SAMPLE_WIDTH, SAMPLE_WIDTH * SAMPLE_HEIGHT - 1];
  const background = [0, 1, 2].map((channel) =>
    Math.round(cornerIndexes.reduce((sum, pixel) => sum + sample[pixel * 4 + channel], 0) / cornerIndexes.length)
  );
  let detailed = 0;
  for (let index = 0; index < sample.length; index += 4) {
    if (
      Math.abs(sample[index] - background[0]) > 18 ||
      Math.abs(sample[index + 1] - background[1]) > 18 ||
      Math.abs(sample[index + 2] - background[2]) > 18
    ) detailed += 1;
  }
  return detailed / (sample.length / 4);
}

function dominantColorRatio(sample) {
  if (!sample?.length) return 1;
  const buckets = new Map();
  let dominant = 0;
  for (let index = 0; index < sample.length; index += 4) {
    const key = `${sample[index] >> 4}:${sample[index + 1] >> 4}:${sample[index + 2] >> 4}`;
    const count = (buckets.get(key) || 0) + 1;
    buckets.set(key, count);
    dominant = Math.max(dominant, count);
  }
  return dominant / (sample.length / 4);
}

function isUsableScreenSample(sample) {
  return Boolean(
    sample?.length &&
    detailedPixelRatio(sample) >= MIN_AUTOMATIC_CAPTURE_DETAIL_RATIO &&
    dominantColorRatio(sample) < MAX_DOMINANT_COLOR_RATIO
  );
}

function hasStableMonitorDimensions() {
  return Boolean(
    video.videoWidth &&
    video.videoHeight &&
    sharedWidth &&
    sharedHeight &&
    Math.abs(video.videoWidth - sharedWidth) <= 2 &&
    Math.abs(video.videoHeight - sharedHeight) <= 2
  );
}

function notifyUnhealthyScreen(message = 'The shared screen is blank or incomplete. Select Entire Screen again.') {
  if (unhealthyScreenNotified) return;
  unhealthyScreenNotified = true;
  clearTimeout(settleTimer);
  settleTimer = 0;
  setState(message, 'error');
  shareButton.textContent = 'Share again';
  chrome.runtime.sendMessage({ type: 'SCREEN_UNHEALTHY', source: 'screen-window' }).catch(() => {});
}

async function notifySettledVisualChange() {
  settleTimer = 0;
  visualChangeStartedAt = 0;
  if (automaticFramePendingId) {
    visualChangePending = true;
    return;
  }
  const settledSample = sampleFrame();
  if (!settledSample) return;
  if (!isUsableScreenSample(settledSample)) return;
  if (
    lastAutomaticCaptureSample &&
    changedPixelRatio(lastAutomaticCaptureSample, settledSample) <
      MIN_AUTOMATIC_CAPTURE_CHANGED_PIXEL_RATIO
  ) return;
  const buffered = await bufferFrame();
  if (!buffered.frameId) return;
  automaticFramePendingId = buffered.frameId;
  automaticFrameWatchdog = setTimeout(
    () => releaseAutomaticFrame(buffered.frameId),
    AUTOMATIC_FRAME_WATCHDOG_MS
  );
  const response = await chrome.runtime.sendMessage({
    type: 'SCREEN_FRAME_BUFFERED',
    source: 'screen-window',
    frameId: buffered.frameId,
    actionAt: lastVisualChangeAt,
    label: 'DevTools panel updated'
  }).catch(() => null);
  if (response?.accepted) {
    lastAutomaticCaptureSample = settledSample;
  } else {
    releaseAutomaticFrame(buffered.frameId);
  }
}

function releaseAutomaticFrame(frameId) {
  if (frameId !== automaticFramePendingId) return;
  clearTimeout(automaticFrameWatchdog);
  automaticFramePendingId = null;
  automaticFrameWatchdog = 0;
  if (!visualChangePending) return;
  visualChangePending = false;
  lastVisualChangeAt = Date.now();
  visualChangeStartedAt = lastVisualChangeAt;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(notifySettledVisualChange, MONITOR_SETTLE_MS);
}

function monitorVisualChanges() {
  if (!captureActive) return;
  if (!hasStableMonitorDimensions()) {
    notifyUnhealthyScreen('The shared source changed size and cannot include DevTools reliably. Select Entire Screen again.');
    return;
  }
  const current = sampleFrame();
  if (!current) {
    missedSampleCount += 1;
    if (missedSampleCount >= 8) notifyScreenLoss();
    return;
  }
  missedSampleCount = 0;
  if (!isUsableScreenSample(current)) {
    unhealthySampleCount += 1;
    if (unhealthySampleCount >= UNHEALTHY_SAMPLE_LIMIT) notifyUnhealthyScreen();
    return;
  }
  unhealthySampleCount = 0;
  unhealthyScreenNotified = false;
  const changed = changedPixelRatio(previousSample, current);
  previousSample = current;
  if (Date.now() < suppressMonitorUntil) return;
  if (changed < MIN_CHANGED_PIXEL_RATIO) return;
  lastVisualChangeAt = Date.now();
  if (automaticFramePendingId) {
    visualChangePending = true;
    return;
  }
  if (!visualChangeStartedAt) visualChangeStartedAt = lastVisualChangeAt;
  const remainingBurstMs = Math.max(
    0,
    MONITOR_MAX_SETTLE_MS - (lastVisualChangeAt - visualChangeStartedAt)
  );
  clearTimeout(settleTimer);
  settleTimer = setTimeout(
    notifySettledVisualChange,
    Math.min(MONITOR_SETTLE_MS, remainingBurstMs)
  );
}

function startVisualMonitor() {
  clearInterval(monitorTimer);
  screenLossNotified = false;
  missedSampleCount = 0;
  previousSample = sampleFrame();
  lastAutomaticCaptureSample = previousSample;
  monitorTimer = setInterval(monitorVisualChanges, MONITOR_INTERVAL_MS);
}

function startMemoryMonitor() {
  clearInterval(memoryReportTimer);
  reportScreenMemoryStatus();
  memoryReportTimer = setInterval(reportScreenMemoryStatus, MEMORY_REPORT_INTERVAL_MS);
}

// getDisplayMedia requires transient user activation, which only a real click provides.
shareButton.addEventListener('click', async () => {
  shareButton.disabled = true;
  setState('Opening the share picker\u2026', 'idle');
  let nextStream = null;

  try {
    nextStream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { cursor: 'never', frameRate: { ideal: 6, max: 8 } }
    });

    const selectedTrack = nextStream.getVideoTracks()[0];
    const displaySurface = selectedTrack?.getSettings?.().displaySurface;
    if (displaySurface && displaySurface !== 'monitor' && displaySurface !== 'window') {
      throw new Error('Select Entire Screen, or select the Chrome window when DevTools is docked.');
    }

    video.srcObject = nextStream;
    await video.play();
    for (let attempt = 0; attempt < 50 && !video.videoWidth; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!video.videoWidth) throw new Error('The shared surface produced no video frames.');

    const previousStream = stream;
    clearBufferedCaptureState();
    stream = nextStream;
    nextStream = null;
    sharedWidth = video.videoWidth;
    sharedHeight = video.videoHeight;
    previousStream?.getTracks().forEach((track) => track.stop());
    const sharedStream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (stream !== sharedStream) return;
      stopStream();
      notifyScreenLoss();
      setState('Sharing stopped. Recording will fall back to tab capture.', 'error');
      shareButton.disabled = false;
      shareButton.textContent = 'Share again';
    });

    setState(`Sharing ${video.videoWidth}\u00d7${video.videoHeight}. Recording is live.`, 'recording');
    shareButton.textContent = 'Change what is shared';
    shareButton.disabled = false;
    chrome.runtime.sendMessage({
      type: 'SCREEN_READY',
      source: 'screen-window',
      displaySurface: displaySurface || 'unknown'
    });
    startVisualMonitor();
    startMemoryMonitor();
  } catch (error) {
    nextStream?.getTracks().forEach((track) => track.stop());
    if (stream) {
      video.srcObject = stream;
      await video.play().catch(() => {});
      setState(`Sharing ${video.videoWidth}\u00d7${video.videoHeight}. Recording is live.`, 'recording');
    } else {
      stopStream();
      setState(`${error.message} \u2014 press the button to try again.`, 'error');
    }
    shareButton.disabled = false;
  }
});

async function captureFrame() {
  const dataUrl = await frameDataUrl();
  return dataUrl ? { dataUrl } : { error: 'The shared screen frame is blank or unavailable.' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'screen') return false;

  switch (message.type) {
    case 'SCREEN_PING':
      sendResponse({ ok: Boolean(stream) });
      break;
    case 'SCREEN_CAPTURE':
      captureFrame().then(sendResponse, (error) => sendResponse({ error: error.message }));
      break;
    case 'SCREEN_BUFFER_CAPTURE':
      suppressVisualMonitor();
      bufferFrame().then(sendResponse, (error) => sendResponse({ error: error.message }));
      break;
    case 'SCREEN_BUFFER_CAPTURE_DELAYED': {
      const delayMs = Math.max(0, Math.min(1000, Number(message.delayMs) || 0));
      suppressVisualMonitor(delayMs + 1000);
      new Promise((resolve) => setTimeout(resolve, delayMs))
        .then(bufferFrame)
        .then(sendResponse, (error) => sendResponse({ error: error.message }));
      break;
    }
    case 'SCREEN_TAKE_BUFFERED':
      takeBufferedFrame(message.frameId).then(
        sendResponse,
        (error) => sendResponse({ error: error.message })
      );
      break;
    case 'SCREEN_FRAME_PROCESSED':
      releaseAutomaticFrame(message.frameId);
      sendResponse({ ok: true });
      break;
    case 'SCREEN_SUPPRESS_MONITOR':
      suppressVisualMonitor(message.durationMs);
      sendResponse({ ok: true });
      break;
    case 'SCREEN_SET_ACTIVE':
      captureActive = Boolean(message.active);
      if (captureActive) {
        startVisualMonitor();
      } else {
        clearInterval(monitorTimer);
        clearTimeout(settleTimer);
        monitorTimer = 0;
        settleTimer = 0;
        visualChangeStartedAt = 0;
      }
      sendResponse({ ok: true, active: captureActive });
      break;
    case 'SCREEN_STOP':
      stopStream();
      sendResponse({ ok: true });
      break;
    default:
      sendResponse({ error: `Unknown screen message: ${message.type}` });
  }
  return true;
});

window.addEventListener('pagehide', stopStream);

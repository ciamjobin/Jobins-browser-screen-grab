const shareButton = document.getElementById('share');
const stateEl = document.getElementById('state');
const video = document.getElementById('preview');

let stream = null;
let monitorTimer = 0;
let settleTimer = 0;
let previousSample = null;
let lastVisualChangeAt = 0;
let visualChangeStartedAt = 0;
let suppressMonitorUntil = 0;
let missedSampleCount = 0;
let screenLossNotified = false;
let automaticFramePendingId = null;
let automaticFrameWatchdog = 0;
let visualChangePending = false;
let nextFrameId = 1;
let bufferedBytes = 0;
const bufferedFrames = new Map();
const frameCanvas = document.createElement('canvas');
const sampleCanvas = document.createElement('canvas');
const SAMPLE_WIDTH = 128;
const SAMPLE_HEIGHT = 72;
const MONITOR_INTERVAL_MS = 250;
const MONITOR_SETTLE_MS = 350;
const MONITOR_MAX_SETTLE_MS = 1500;
const AUTOMATIC_FRAME_WATCHDOG_MS = 25000;
const MIN_CHANGED_PIXEL_RATIO = 0.0008;
const MAX_BUFFERED_FRAMES = 100;
const MAX_BUFFERED_BYTES = 512 * 1024 * 1024;

function setState(text, kind) {
  stateEl.textContent = text;
  stateEl.className = `status ${kind}`;
}

function clearBufferedCaptureState() {
  clearInterval(monitorTimer);
  clearTimeout(settleTimer);
  clearTimeout(automaticFrameWatchdog);
  monitorTimer = 0;
  settleTimer = 0;
  previousSample = null;
  visualChangeStartedAt = 0;
  automaticFramePendingId = null;
  automaticFrameWatchdog = 0;
  visualChangePending = false;
  missedSampleCount = 0;
  bufferedFrames.clear();
  bufferedBytes = 0;
}

function stopStream() {
  clearBufferedCaptureState();
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
}

function frameDataUrl(type = 'image/png', quality) {
  if (!stream || !video.videoWidth) return null;
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameCanvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0);
  return frameCanvas.toDataURL(type, quality);
}

function frameBlob(type = 'image/jpeg', quality = 0.82) {
  if (!stream || !video.videoWidth) return Promise.resolve(null);
  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  captureCanvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0);
  return new Promise((resolve) => captureCanvas.toBlob(resolve, type, quality));
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
  if (!blob) return { error: 'No active screen stream.' };
  if (bufferedFrames.size >= MAX_BUFFERED_FRAMES || bufferedBytes + blob.size > MAX_BUFFERED_BYTES) {
    return { error: 'The screen capture buffer is full. Wait for pending screenshots to finish.' };
  }
  const frameId = `screen-${Date.now()}-${nextFrameId++}`;
  bufferedFrames.set(frameId, blob);
  bufferedBytes += blob.size;
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
  return { dataUrl: await blobDataUrl(blob) };
}

function sampleFrame() {
  if (!stream || !video.videoWidth) return null;
  try {
    sampleCanvas.width = SAMPLE_WIDTH;
    sampleCanvas.height = SAMPLE_HEIGHT;
    const context = sampleCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const sourceTop = Math.round(video.videoHeight * 0.1);
    const sourceHeight = Math.max(1, Math.round(video.videoHeight * 0.84));
    context.drawImage(video, 0, sourceTop, video.videoWidth, sourceHeight, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    return context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
  } catch {
    return null;
  }
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

async function notifySettledVisualChange() {
  settleTimer = 0;
  visualChangeStartedAt = 0;
  if (automaticFramePendingId) {
    visualChangePending = true;
    return;
  }
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
  if (!response?.accepted) releaseAutomaticFrame(buffered.frameId);
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
  const current = sampleFrame();
  if (!current) {
    missedSampleCount += 1;
    if (missedSampleCount >= 8) notifyScreenLoss();
    return;
  }
  missedSampleCount = 0;
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
  monitorTimer = setInterval(monitorVisualChanges, MONITOR_INTERVAL_MS);
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
    chrome.runtime.sendMessage({ type: 'SCREEN_READY', source: 'screen-window' });
    startVisualMonitor();
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

function captureFrame() {
  const dataUrl = frameDataUrl();
  return dataUrl ? { dataUrl } : { error: 'No active screen stream.' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'screen') return false;

  switch (message.type) {
    case 'SCREEN_PING':
      sendResponse({ ok: Boolean(stream) });
      break;
    case 'SCREEN_CAPTURE':
      sendResponse(captureFrame());
      break;
    case 'SCREEN_BUFFER_CAPTURE':
      suppressVisualMonitor();
      bufferFrame().then(sendResponse, (error) => sendResponse({ error: error.message }));
      break;
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

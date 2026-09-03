const shareButton = document.getElementById('share');
const stateEl = document.getElementById('state');
const video = document.getElementById('preview');

let stream = null;

function setState(text, kind) {
  stateEl.textContent = text;
  stateEl.className = `status ${kind}`;
}

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
}

// getDisplayMedia requires transient user activation, which only a real click provides.
shareButton.addEventListener('click', async () => {
  shareButton.disabled = true;
  setState('Opening the share picker\u2026', 'idle');

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: 5, max: 10 } }
    });

    video.srcObject = stream;
    await video.play();
    for (let attempt = 0; attempt < 50 && !video.videoWidth; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!video.videoWidth) throw new Error('The shared surface produced no video frames.');

    stream.getVideoTracks()[0].addEventListener('ended', () => {
      stopStream();
      setState('Sharing stopped. Recording will fall back to tab capture.', 'error');
      shareButton.disabled = false;
      shareButton.textContent = 'Share again';
    });

    setState(`Sharing ${video.videoWidth}\u00d7${video.videoHeight}. Recording is live.`, 'recording');
    shareButton.textContent = 'Change what is shared';
    shareButton.disabled = false;
    chrome.runtime.sendMessage({ type: 'SCREEN_READY' });
  } catch (error) {
    stopStream();
    setState(`${error.message} \u2014 press the button to try again.`, 'error');
    shareButton.disabled = false;
  }
});

function captureFrame() {
  if (!stream || !video.videoWidth) return { error: 'No active screen stream.' };
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  try {
    canvas.getContext('2d').drawImage(video, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png') };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
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

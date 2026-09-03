import { buildPdf } from './pdf.js';

const FRAMES_KEY = 'flowRecorderFrames';
const FRAME_PREFIX = `${FRAMES_KEY}:`;
const stateEl = document.getElementById('state');

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const onChanged = (progress) => {
      if (progress.id !== downloadId || !progress.state) return;
      if (progress.state.current === 'in_progress') return;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(progress.state.current);
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// Pre-2.3 frames packed the URL into a single `meta` string; pull it back into its own field.
function fieldsFor(frame) {
  if (frame.url) {
    return { url: frame.url, time: frame.time || '(time not recorded)' };
  }

  const legacy = frame.time || frame.meta || '';
  const found = legacy.match(/https?:\/\/\S+/);
  const time = (found ? legacy.replace(found[0], '') : legacy).replace(/[\s|?\u00b7]+$/, '');

  return {
    url: found ? found[0] : '(URL not recorded)',
    time: time || '(time not recorded)'
  };
}

// A real extension page is required here: offscreen documents expose only chrome.runtime,
// and service workers cannot create blob URLs.
async function run() {
  const filename = new URLSearchParams(location.search).get('filename');

  try {
    const stored = await chrome.storage.local.get(null);
    const frames = Object.entries(stored)
      .filter(([key]) => key.startsWith(FRAME_PREFIX))
      .map(([, frame]) => frame)
      .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
    if (!frames.length && Array.isArray(stored[FRAMES_KEY])) frames.push(...stored[FRAMES_KEY]);
    if (!frames.length) throw new Error('No frames were captured, so no PDF was written.');

    stateEl.textContent = `Assembling ${frames.length} page(s)\u2026`;

    const bytes = buildPdf(
      frames.map((frame) => ({
        title: frame.title,
        apiRows: frame.apiRows || [],
        ...fieldsFor(frame),
        width: frame.width,
        height: frame.height,
        jpeg: base64ToBytes(frame.base64)
      }))
    );

    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    const outcome = await waitForDownload(downloadId);
    URL.revokeObjectURL(url);

    if (outcome !== 'complete') throw new Error(`PDF download ${outcome}.`);

    stateEl.textContent = `Saved ${frames.length} page(s).`;
    // The background closes this window once it sees the message, avoiding a close/message race.
    chrome.runtime.sendMessage({ type: 'PDF_DONE', pageCount: frames.length });
  } catch (error) {
    stateEl.textContent = error.message;
    stateEl.className = 'status error';
    chrome.runtime.sendMessage({ type: 'PDF_DONE', error: error.message });
  }
}

run();

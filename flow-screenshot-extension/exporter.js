import { buildDocx } from './docx.js';
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

function dataUrl(bytes, mimeType) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
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

function sequencesFromParams(params, key) {
  if (!params.has(key)) return null;
  return new Set(
    params
      .get(key)
      .split(',')
      .map(Number)
      .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0)
  );
}

function outputFilesFromParams(params) {
  const encoded = params.get('outputs');
  if (!encoded) {
    const filename = params.get('filename');
    return filename ? [{ format: 'pdf', filename }] : [];
  }

  try {
    const outputs = JSON.parse(encoded);
    if (!Array.isArray(outputs)) return [];
    return outputs.filter(
      (output) =>
        output &&
        (output.format === 'pdf' || output.format === 'docx') &&
        typeof output.filename === 'string' &&
        output.filename.trim()
    );
  } catch {
    return [];
  }
}

function buildOutput(format, pages) {
  return format === 'docx' ? buildDocx(pages) : buildPdf(pages);
}

function outputMimeType(format) {
  return format === 'docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/pdf';
}

// A real extension page is required here: offscreen documents expose only chrome.runtime,
// and service workers cannot create blob URLs.
async function run() {
  const params = new URLSearchParams(location.search);
  const outputFiles = outputFilesFromParams(params);
  const selectedSequences = sequencesFromParams(params, 'selected');
  const excludedSequences = sequencesFromParams(params, 'excluded');

  try {
    if (!outputFiles.length) throw new Error('Choose PDF, Word, or both before saving.');
    const stored = await chrome.storage.local.get(null);
    const frames = Object.entries(stored)
      .filter(([key]) => key.startsWith(FRAME_PREFIX))
      .map(([, frame]) => frame)
      .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
    if (!frames.length && Array.isArray(stored[FRAMES_KEY])) frames.push(...stored[FRAMES_KEY]);
    const includedFrames = selectedSequences
      ? frames.filter((frame) => selectedSequences.has(Number(frame.sequence)))
      : excludedSequences
        ? frames.filter((frame) => !excludedSequences.has(Number(frame.sequence)))
        : frames;
    if (!includedFrames.length) {
      throw new Error(
        selectedSequences || excludedSequences
          ? 'No selected screenshots are available for the requested output.'
          : 'No frames were captured, so no output was written.'
      );
    }

    stateEl.textContent = `Assembling ${includedFrames.length} page(s)\u2026`;
    const pages = includedFrames.map((frame) => ({
      title: frame.title,
      note: frame.note,
      apiRows: frame.apiRows || [],
      ...fieldsFor(frame),
      width: frame.width,
      height: frame.height,
      jpeg: base64ToBytes(frame.base64)
    }));
    const downloadIds = [];
    for (const output of outputFiles) {
      const bytes = buildOutput(output.format, pages);
      const downloadId = await chrome.downloads.download({
        url: dataUrl(bytes, outputMimeType(output.format)),
        filename: output.filename,
        saveAs: false
      });
      const outcome = await waitForDownload(downloadId);
      if (outcome !== 'complete') throw new Error(`${output.format.toUpperCase()} download ${outcome}.`);
      downloadIds.push(downloadId);
    }

    stateEl.textContent = `Saved ${includedFrames.length} page(s).`;
    // The background closes this window once it sees the message, avoiding a close/message race.
    chrome.runtime.sendMessage({
      type: 'OUTPUT_DONE',
      pageCount: includedFrames.length,
      downloadIds,
      savedOutputFilenames: outputFiles.map((output) => output.filename)
    });
  } catch (error) {
    stateEl.textContent = error.message;
    stateEl.className = 'status error';
    chrome.runtime.sendMessage({ type: 'OUTPUT_DONE', error: error.message });
  }
}

run();

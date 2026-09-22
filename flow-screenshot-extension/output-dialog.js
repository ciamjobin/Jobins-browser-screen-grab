import {
  getSavedCaptureFolder,
  requestReadWritePermissionFromUserGesture
} from './capture-folder.js';

const titleEl = document.getElementById('dialogTitle');
const summaryEl = document.getElementById('dialogSummary');
const filenameEl = document.getElementById('outputFilename');
const pdfEl = document.getElementById('outputPdf');
const docxEl = document.getElementById('outputDocx');
const statusEl = document.getElementById('dialogStatus');
const toastEl = document.getElementById('dialogToast');
const saveEl = document.getElementById('saveOutput');
const saveAndOpenEl = document.getElementById('saveAndOpenOutput');
const cancelEl = document.getElementById('cancelOutput');

const labels = {
  checkpoint: { title: 'Save checkpoint (Ctrl+Shift+S)', button: 'Save checkpoint (Ctrl+Shift+S)' },
  final: {
    title: 'Save and stop recording',
    button: 'Save and stop (Ctrl+S)'
  }
};
const params = new URLSearchParams(location.search);
const requestedMode = params.get('mode');
const mode = Object.hasOwn(labels, requestedMode) ? requestedMode : 'checkpoint';
let state = null;
let folderHandle = null;
let folderReady = false;
let saving = false;
let completed = false;
let toastTimer = 0;

function send(type, payload = {}) {
  return Promise.resolve(chrome.runtime.sendMessage({ type, ...payload }));
}

function outputFormats() {
  return [pdfEl.checked && 'pdf', docxEl.checked && 'docx'].filter(Boolean);
}

function selectedCaptureCount() {
  const excluded = new Set(state?.pdfExcludedSequences || []);
  return (state?.captures || []).filter((capture) => !excluded.has(capture.sequence)).length;
}

function setStatus(message, tone = 'idle') {
  statusEl.textContent = message;
  statusEl.className = `status ${tone}`;
}

function showToast(message, tone = 'success') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast${tone === 'error' ? ' error' : ''}`;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3000);
}

function defaultFileName() {
  const sessionId = state?.sessionId || 'JShotz-session';
  return mode === 'checkpoint' ? `${sessionId}_checkpoint` : sessionId;
}

function updateSaveControl() {
  const needsFolder = Boolean(state?.outputFolder?.name);
  const disabled = completed || saving || !state?.recording || !outputFormats().length || !selectedCaptureCount() ||
    (needsFolder && !folderReady);
  saveEl.disabled = disabled;
  saveAndOpenEl.disabled = disabled;
}

function setSavedStatus(result, reveal = false) {
  const names = Array.isArray(result?.savedOutputFilenames)
    ? result.savedOutputFilenames
    : result?.savedPdfFilename
      ? [result.savedPdfFilename]
      : [];
  if (!names.length) throw new Error(result?.lastError || 'JShotz did not create an output file.');
  let message = `Saved ${names.join(' and ')}.`;
  if (reveal && state?.outputFolder?.name) {
    message += ' Opened Downloads; Chrome cannot directly open the selected capture folder.';
  } else if (reveal && result?.fileLocationOpened === false) {
    message += ` Could not open the file location: ${result.fileLocationError || 'Chrome did not provide a download location.'}`;
  } else if (reveal) {
    message += result?.fileLocationFallback ? ' Opened Downloads.' : ' Opened the file location.';
  }
  setStatus(message, reveal && result?.fileLocationOpened === false ? 'error' : 'idle');
  if (!reveal) showToast(message);
}

async function preloadFolder() {
  if (!state?.outputFolder?.name) {
    folderReady = true;
    updateSaveControl();
    return;
  }

  try {
    folderHandle = await getSavedCaptureFolder();
    if (folderHandle?.name !== state.outputFolder.name) {
      throw new Error('Reconnect the selected capture folder before saving.');
    }
    folderReady = true;
    setStatus('Ready to save.');
  } catch (error) {
    folderReady = false;
    setStatus(error.message || 'Reconnect the selected capture folder before saving.', 'error');
  }
  updateSaveControl();
}

function outputMessage(reveal = false) {
  const payload = {
    outputFilename: filenameEl.value,
    outputFormats: outputFormats(),
    excludedSequences: state?.pdfExcludedSequences || []
  };
  if (mode === 'final') {
    return { type: 'STOP', payload: { ...payload, keepFiles: true, createPdf: true, reveal } };
  }
  return { type: 'SAVE_FLOW', payload };
}

async function save(reveal = false) {
  if (saveEl.disabled) return;
  const formats = outputFormats();
  if (!formats.length) {
    const message = 'Choose PDF, Word, or both before saving.';
    setStatus(message, 'error');
    showToast(message, 'error');
    return;
  }
  if (!selectedCaptureCount()) {
    const message = 'Select at least one screenshot in JShotz before saving.';
    setStatus(message, 'error');
    showToast(message, 'error');
    return;
  }

  let permissionRequest = null;
  if (state?.outputFolder?.name) {
    if (!folderHandle || folderHandle.name !== state.outputFolder.name) {
      const message = 'Reconnect the selected capture folder before saving.';
      setStatus(message, 'error');
      showToast(message, 'error');
      return;
    }
    // This starts in the click handler while the browser still grants user activation.
    permissionRequest = requestReadWritePermissionFromUserGesture(folderHandle);
  }

  saving = true;
  updateSaveControl();
  const willReveal = mode === 'final' && reveal;
  setStatus(
    mode === 'checkpoint'
      ? 'Writing output files...'
      : willReveal
        ? 'Finalizing recording and opening the download location...'
        : 'Finalizing recording...'
  );
  try {
    if (permissionRequest && !(await permissionRequest)) {
      throw new Error('JShotz needs permission to write to the selected capture folder.');
    }
    const request = outputMessage(reveal);
    const result = await send(request.type, request.payload);
    if (result?.lastError) throw new Error(result.lastError);
    setSavedStatus(result, reveal);
    completed = true;
    setTimeout(() => window.close(), 3200);
  } catch (error) {
    const message = error.message || 'Could not save the recording.';
    setStatus(message, 'error');
    showToast(message, 'error');
  } finally {
    saving = false;
    updateSaveControl();
  }
}

async function load() {
  const label = labels[mode];
  titleEl.textContent = label.title;
  try {
    state = await send('GET_STATE');
    if (!state?.recording || !state?.captures?.length) {
      throw new Error('There is no captured recording to save.');
    }
    filenameEl.value = defaultFileName();
    summaryEl.textContent = `${selectedCaptureCount()} screenshot(s) selected.`;
    saveEl.textContent = label.button;
    saveAndOpenEl.hidden = mode !== 'final';
    setStatus(state.outputFolder?.name ? 'Preparing selected capture folder...' : 'Ready to save.');
    await preloadFolder();
    filenameEl.focus();
    filenameEl.select();
  } catch (error) {
    setStatus(error.message || 'Could not load the recording.', 'error');
    updateSaveControl();
  }
}

pdfEl.addEventListener('change', updateSaveControl);
docxEl.addEventListener('change', updateSaveControl);
function isSaveAndStopShortcut(event) {
  return (
    mode === 'final' &&
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function isSaveAndOpenLocationShortcut(event) {
  return (
    mode === 'final' &&
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function isCheckpointSaveShortcut(event) {
  return (
    mode === 'checkpoint' &&
    event.ctrlKey &&
    !event.altKey &&
    event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

document.addEventListener('keydown', (event) => {
  const reveal = isSaveAndOpenLocationShortcut(event);
  if (!reveal && !isSaveAndStopShortcut(event) && !isCheckpointSaveShortcut(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) save(reveal);
});

saveEl.addEventListener('click', () => save());
saveAndOpenEl.addEventListener('click', () => save(true));
cancelEl.addEventListener('click', () => window.close());
load();
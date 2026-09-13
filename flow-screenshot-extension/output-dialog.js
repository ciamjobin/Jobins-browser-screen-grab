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
const saveEl = document.getElementById('saveOutput');
const cancelEl = document.getElementById('cancelOutput');

const labels = {
  checkpoint: { title: 'Save checkpoint', button: 'Save checkpoint' },
  final: { title: 'Save and stop recording', button: 'Save and stop' },
  'new-recording': { title: 'Save and start new recording', button: 'Save and start new' }
};
const requestedMode = new URLSearchParams(location.search).get('mode');
const mode = Object.hasOwn(labels, requestedMode) ? requestedMode : 'checkpoint';

let state = null;
let folderHandle = null;
let folderReady = false;
let saving = false;

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

function defaultFileName() {
  const sessionId = state?.sessionId || 'JShotz-session';
  return mode === 'checkpoint' ? `${sessionId}_checkpoint` : sessionId;
}

function updateSaveControl() {
  const needsFolder = Boolean(state?.outputFolder?.name);
  saveEl.disabled = saving || !state?.recording || !outputFormats().length || !selectedCaptureCount() ||
    (needsFolder && !folderReady);
}

function setSavedStatus(result) {
  const names = Array.isArray(result?.savedOutputFilenames)
    ? result.savedOutputFilenames
    : result?.savedPdfFilename
      ? [result.savedPdfFilename]
      : [];
  if (!names.length) throw new Error(result?.lastError || 'JShotz did not create an output file.');
  setStatus(`Saved ${names.join(' and ')}.`, 'idle');
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

function outputMessage() {
  const payload = {
    outputFilename: filenameEl.value,
    outputFormats: outputFormats(),
    excludedSequences: state?.pdfExcludedSequences || []
  };
  if (mode === 'final') return { type: 'STOP', payload: { ...payload, keepFiles: true, createPdf: true } };
  if (mode === 'new-recording') {
    return { type: 'START_NEW_RECORDING', payload: { ...payload, settings: state?.settings || {} } };
  }
  return { type: 'SAVE_FLOW', payload };
}

async function save() {
  if (saveEl.disabled) return;
  const formats = outputFormats();
  if (!formats.length) {
    setStatus('Choose PDF, Word, or both before saving.', 'error');
    return;
  }
  if (!selectedCaptureCount()) {
    setStatus('Select at least one screenshot in JShotz before saving.', 'error');
    return;
  }

  let permissionRequest = null;
  if (state?.outputFolder?.name) {
    if (!folderHandle || folderHandle.name !== state.outputFolder.name) {
      setStatus('Reconnect the selected capture folder before saving.', 'error');
      return;
    }
    // This starts in the click handler while the browser still grants user activation.
    permissionRequest = requestReadWritePermissionFromUserGesture(folderHandle);
  }

  saving = true;
  updateSaveControl();
  setStatus(mode === 'checkpoint' ? 'Writing output files...' : 'Finalizing recording...');
  try {
    if (permissionRequest && !(await permissionRequest)) {
      throw new Error('JShotz needs permission to write to the selected capture folder.');
    }
    const request = outputMessage();
    const result = await send(request.type, request.payload);
    if (result?.lastError) throw new Error(result.lastError);
    setSavedStatus(result);
    setTimeout(() => window.close(), 900);
  } catch (error) {
    setStatus(error.message || 'Could not save the recording.', 'error');
  } finally {
    saving = false;
    updateSaveControl();
  }
}

async function load() {
  const label = labels[mode];
  titleEl.textContent = label.title;
  saveEl.textContent = label.button;
  try {
    state = await send('GET_STATE');
    if (!state?.recording || !state?.captures?.length) {
      throw new Error('There is no captured recording to save.');
    }
    filenameEl.value = defaultFileName();
    summaryEl.textContent = `${selectedCaptureCount()} screenshot(s) selected.`;
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
saveEl.addEventListener('click', save);
cancelEl.addEventListener('click', () => window.close());
load();
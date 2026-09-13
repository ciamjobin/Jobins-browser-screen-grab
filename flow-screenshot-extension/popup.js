import {
  getSavedCaptureFolder,
  requestReadWritePermissionFromUserGesture,
  saveCaptureFolder
} from './capture-folder.js';

const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const toggleEl = document.getElementById('toggle');
const pauseResumeEl = document.getElementById('pauseResume');
const captureNowEl = document.getElementById('captureNow');
const captureLaterEl = document.getElementById('captureLater');
const saveFlowEl = document.getElementById('saveFlow');
const saveAndOpenEl = document.getElementById('saveAndOpen');
const startNewRecordingEl = document.getElementById('startNewRecording');
const exportPdfNowEl = document.getElementById('exportPdfNow');
const captureListEl = document.getElementById('captureList');
const settingsEl = document.querySelector('.settings');
const mainActionsEl = document.getElementById('mainActions');
const confirmEl = document.getElementById('confirm');
const filenamePromptEl = document.getElementById('filenamePrompt');
const deleteConfirmEl = document.getElementById('deleteConfirm');
const outputFilenameEl = document.getElementById('outputFilename');
const outputPdfEl = document.getElementById('outputPdf');
const outputDocxEl = document.getElementById('outputDocx');
const shortcutHintEl = document.getElementById('shortcutHint');
const selectAllCapturesEl = document.getElementById('selectAllCaptures');
const captureSelectionSummaryEl = document.getElementById('captureSelectionSummary');
const saveWithNameEl = document.getElementById('saveWithName');
const fullPageProgressEl = document.getElementById('fullPageProgress');
const fullPageProgressLabelEl = document.getElementById('fullPageProgressLabel');
const fullPageProgressPercentEl = document.getElementById('fullPageProgressPercent');
const fullPageProgressBarEl = document.getElementById('fullPageProgressBar');
const fullPageProgressTrackEl = fullPageProgressBarEl.parentElement;
const resumeCaptureFromFolderEl = document.getElementById('resumeCaptureFromFolder');
const extensionOnlyButtons = [...document.querySelectorAll('button')];
const CAPTURE_LIST_PAGE_SIZE = 50;

let awaitingChoice = false;
let pendingOutputAction = null;
let returnToStopChoice = false;
let standalonePopup = false;
let selectedCaptureSequences = new Set();
let knownCaptureSequences = new Set();
let captureSelectionSessionId = null;
let currentCaptures = [];
let currentSettings = {};
let selectionUpdateChain = Promise.resolve();
let noteUpdateChain = Promise.resolve();
let captureListLimit = CAPTURE_LIST_PAGE_SIZE;
let renderedCaptureListKey = null;
let renderedState = null;
let toastTimer = 0;
let selectedCaptureFolderHandle = null;
let selectedCaptureFolderHandleLoad = null;

const controls = {
  captureMode: document.getElementById('captureMode'),
  captureOnClick: document.getElementById('captureOnClick'),
  captureOnScroll: document.getElementById('captureOnScroll'),
  stampTimestamp: document.getElementById('stampTimestamp'),
  fullPage: document.getElementById('fullPage'),
  savePng: document.getElementById('savePng'),
  savePdf: document.getElementById('savePdf')
};

function hasExtensionRuntime() {
  try {
    return (
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime?.id === 'string' &&
      Boolean(chrome.runtime.id) &&
      typeof chrome.runtime.sendMessage === 'function'
    );
  } catch {
    return false;
  }
}

function showRuntimeError() {
  statusEl.textContent = standalonePopup
    ? 'Open JShotz from the browser toolbar after loading the extension.'
    : 'JShotz is unavailable. Reload the extension, then reopen this popup.';
  statusEl.className = 'status error';
}

function showToast(message, tone = 'success') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast${tone === 'error' ? ' error' : ''}`;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 5000);
}

function showActionError(action, error) {
  const message = error?.message || `${action} failed.`;
  showToast(message, 'error');
  statusEl.textContent = message;
  statusEl.className = 'status error';
}

function showSaveResult(state) {
  const names = Array.isArray(state?.savedOutputFilenames)
    ? state.savedOutputFilenames
    : state?.savedPdfFilename
      ? [state.savedPdfFilename]
      : [];
  if (names.length) {
    showToast(`Saved as ${names.join(' and ')}`);
    return;
  }
  showToast(state?.lastError || 'Save failed: JShotz did not create an output file.', 'error');
}

function showStandalonePopup() {
  standalonePopup = true;
  for (const button of extensionOnlyButtons) button.disabled = true;
  for (const control of Object.values(controls)) control.disabled = true;
  selectAllCapturesEl.disabled = true;
  showRuntimeError();
}

function send(type, payload = {}) {
  if (!hasExtensionRuntime()) {
    return Promise.reject(new Error('JShotz must run from an installed extension popup.'));
  }
  try {
    return Promise.resolve(chrome.runtime.sendMessage({ type, ...payload }));
  } catch (error) {
    return Promise.reject(error);
  }
}

function folderPermissionError() {
  return new Error(
    'The selected capture folder needs permission again. Click "Reconnect capture folder" to continue.'
  );
}

function rememberSelectedCaptureFolder(directoryHandle) {
  selectedCaptureFolderHandle = directoryHandle?.kind === 'directory' ? directoryHandle : null;
}

function preloadSelectedCaptureFolder() {
  if (selectedCaptureFolderHandleLoad) return selectedCaptureFolderHandleLoad;
  const handleBeforeLoad = selectedCaptureFolderHandle;
  selectedCaptureFolderHandleLoad = getSavedCaptureFolder()
    .then((directoryHandle) => {
      if (selectedCaptureFolderHandle === handleBeforeLoad) {
        rememberSelectedCaptureFolder(directoryHandle);
      }
      return selectedCaptureFolderHandle;
    })
    .catch(() => null)
    .finally(() => {
      selectedCaptureFolderHandleLoad = null;
    });
  return selectedCaptureFolderHandleLoad;
}

function renewSelectedCaptureFolderWritePermission() {
  const folderName = renderedState?.recording ? renderedState.outputFolder?.name : null;
  if (!folderName) return Promise.resolve();

  const directoryHandle = selectedCaptureFolderHandle;
  if (directoryHandle?.name !== folderName) {
    preloadSelectedCaptureFolder();
    return Promise.reject(folderPermissionError());
  }

  // requestPermission() must run in this click or key event, before awaiting a runtime message.
  return requestReadWritePermissionFromUserGesture(directoryHandle).then((granted) => {
    if (!granted) throw folderPermissionError();
  });
}

function readSettings() {
  return {
    captureMode: controls.captureMode.value,
    captureOnClick: controls.captureOnClick.checked,
    captureOnScroll: controls.captureOnScroll.checked,
    stampTimestamp: controls.stampTimestamp.checked,
    fullPage: controls.fullPage.checked,
    savePng: controls.savePng.checked,
    savePdf: controls.savePdf.checked
  };
}

function captureSequences(captures = currentCaptures) {
  return captures
    .map((capture) => capture.sequence)
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0);
}

function captureListKey(captures) {
  return captures
    .map((capture) => [capture.sequence, capture.capturedAt, capture.title, capture.note, capture.url, capture.reason].join('\u001f'))
    .join('\u001e');
}

function syncCaptureSelection(sessionId, captures, excludedSequences = []) {
  const sequences = new Set(captureSequences(captures));
  if (sessionId !== captureSelectionSessionId) {
    captureSelectionSessionId = sessionId;
    captureListLimit = CAPTURE_LIST_PAGE_SIZE;
    renderedCaptureListKey = null;
    const excluded = new Set(
      Array.isArray(excludedSequences)
        ? excludedSequences.filter((sequence) => sequences.has(sequence))
        : []
    );
    selectedCaptureSequences = new Set([...sequences].filter((sequence) => !excluded.has(sequence)));
  } else {
    for (const sequence of sequences) {
      if (!knownCaptureSequences.has(sequence)) selectedCaptureSequences.add(sequence);
    }
    selectedCaptureSequences = new Set(
      [...selectedCaptureSequences].filter((sequence) => sequences.has(sequence))
    );
  }
  knownCaptureSequences = sequences;
  currentCaptures = captures;
}

function selectedCaptureSequenceList() {
  return captureSequences().filter((sequence) => selectedCaptureSequences.has(sequence));
}

function excludedCaptureSequenceList() {
  return captureSequences().filter((sequence) => !selectedCaptureSequences.has(sequence));
}

function outputFormats() {
  return [outputPdfEl.checked && 'pdf', outputDocxEl.checked && 'docx'].filter(Boolean);
}

function persistCaptureSelection() {
  const sessionId = captureSelectionSessionId;
  if (!sessionId) return;
  const excludedSequences = excludedCaptureSequenceList();
  selectionUpdateChain = selectionUpdateChain
    .catch(() => {})
    .then(() => send('SET_PDF_EXCLUSIONS', { sessionId, excludedSequences }).catch(() => {}));
}

function persistCaptureNote(sequence, note) {
  const sessionId = captureSelectionSessionId;
  if (!sessionId) return Promise.resolve();
  noteUpdateChain = noteUpdateChain
    .catch(() => {})
    .then(async () => {
      const state = await send('SET_CAPTURE_NOTE', { sessionId, sequence, note });
      if (state?.lastError) throw new Error(state.lastError);
      render(state);
      return state;
    });
  return noteUpdateChain;
}

function updateCaptureSelectionControls() {
  const total = captureSequences().length;
  const selected = selectedCaptureSequenceList().length;
  selectAllCapturesEl.disabled = !total;
  selectAllCapturesEl.checked = total > 0 && selected === total;
  selectAllCapturesEl.indeterminate = false;
  captureSelectionSummaryEl.textContent = total ? `${selected} of ${total} selected for output.` : '';

  const needsSelection = Boolean(pendingOutputAction);
  saveWithNameEl.disabled =
    !filenamePromptEl.hidden &&
    (!outputFormats().length || (needsSelection && total > 0 && selected === 0));
}

function renderCaptures(captures, force = false) {
  const renderKey = `${captureListLimit}\u001d${captureListKey(captures)}`;
  const activeElement = document.activeElement;
  if (
    !force &&
    activeElement instanceof HTMLInputElement &&
    activeElement.classList.contains('capture-note')
  ) {
    updateCaptureSelectionControls();
    return;
  }
  if (!force && renderKey === renderedCaptureListKey) {
    updateCaptureSelectionControls();
    return;
  }
  renderedCaptureListKey = renderKey;
  captureListEl.replaceChildren();

  if (!captures.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No captures yet.';
    captureListEl.append(empty);
    updateCaptureSelectionControls();
    return;
  }

  const fragment = document.createDocumentFragment();
  const visibleCaptures = captures.slice(-captureListLimit).reverse();
  for (const capture of visibleCaptures) {
    const item = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedCaptureSequences.has(capture.sequence);
    checkbox.setAttribute('aria-label', `Include screenshot ${capture.sequence} in output`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedCaptureSequences.add(capture.sequence);
      } else {
        selectedCaptureSequences.delete(capture.sequence);
      }
      updateCaptureSelectionControls();
      persistCaptureSelection();
    });

    const title = document.createElement('span');
    title.className = 'capture-title';
    title.textContent = `${capture.sequence}. ${capture.title || capture.url}`;
    title.title = capture.url || '';

    const meta = document.createElement('span');
    meta.className = 'capture-meta';
    meta.textContent = `${new Date(capture.capturedAt).toLocaleTimeString()} · ${capture.reason}`;

    const selection = document.createElement('label');
    selection.className = 'capture-select';
    selection.append(checkbox, title);

    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'capture-note';
    note.maxLength = 50;
    note.value = typeof capture.note === 'string' ? capture.note : '';
    note.placeholder = 'Add a note (50 characters)';
    note.setAttribute('aria-label', `Note for screenshot ${capture.sequence}`);
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') note.blur();
    });
    note.addEventListener('change', async () => {
      note.disabled = true;
      try {
        await persistCaptureNote(capture.sequence, note.value);
      } catch (error) {
        showActionError('Could not save screenshot note', error);
        note.disabled = false;
      }
    });

    item.append(selection, meta, note);
    fragment.append(item);
  }

  const remainingCaptureCount = captures.length - visibleCaptures.length;
  if (remainingCaptureCount > 0) {
    const item = document.createElement('li');
    const reveal = document.createElement('button');
    const revealCount = Math.min(CAPTURE_LIST_PAGE_SIZE, remainingCaptureCount);
    reveal.type = 'button';
    reveal.className = 'capture-more';
    reveal.textContent = `Show ${revealCount} older screenshot${revealCount === 1 ? '' : 's'}`;
    reveal.addEventListener('click', () => {
      captureListLimit = Math.min(currentCaptures.length, captureListLimit + CAPTURE_LIST_PAGE_SIZE);
      renderCaptures(currentCaptures, true);
    });
    item.append(reveal);
    fragment.append(item);
  }
  captureListEl.append(fragment);
  updateCaptureSelectionControls();
}

function renderFullPageProgress(progress) {
  const active = Boolean(progress?.active);
  fullPageProgressEl.hidden = !active;
  if (!active) return;

  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  fullPageProgressLabelEl.textContent = progress.label || 'Capturing full page';
  fullPageProgressPercentEl.textContent = `${percent}%`;
  fullPageProgressBarEl.style.width = `${percent}%`;
  fullPageProgressTrackEl.setAttribute('aria-valuenow', String(percent));
}

function canReconnectCaptureFolder(state) {
  return Boolean(state?.recording && state?.outputFolder?.name && state?.folderAccessNeeded);
}

function isFolderReconnectNotice(state) {
  return Boolean(
    canReconnectCaptureFolder(state) &&
      /^The selected capture folder needs permission again\./.test(String(state?.lastError || ''))
  );
}

function updateResumeCaptureButton(state) {
  const reconnecting = canReconnectCaptureFolder(state);
  resumeCaptureFromFolderEl.textContent = reconnecting
    ? 'Reconnect capture folder'
    : 'Resume capture from folder';
  resumeCaptureFromFolderEl.disabled = Boolean(state?.recording) && !reconnecting;
}

function render(state) {
  renderedState = state ?? null;
  const recording = Boolean(state?.recording);
  const paused = recording && Boolean(state?.paused);
  const settings = state?.settings ?? {};
  currentSettings = settings;
  syncCaptureSelection(state?.sessionId ?? null, state?.captures ?? [], state?.pdfExcludedSequences);
  renderFullPageProgress(state?.fullPageProgress);

  // Polling must not steal a control the user is currently interacting with.
  const apply = (control, assign) => {
    if (document.activeElement !== control) assign();
  };
  apply(controls.captureMode, () => (controls.captureMode.value = settings.captureMode ?? 'tab'));
  apply(controls.captureOnClick, () => (controls.captureOnClick.checked = settings.captureOnClick !== false));
  apply(controls.captureOnScroll, () => (controls.captureOnScroll.checked = settings.captureOnScroll !== false));
  apply(controls.stampTimestamp, () => (controls.stampTimestamp.checked = settings.stampTimestamp !== false));
  apply(controls.fullPage, () => (controls.fullPage.checked = settings.fullPage !== false));
  apply(controls.savePng, () => (controls.savePng.checked = settings.savePng !== false));
  apply(controls.savePdf, () => (controls.savePdf.checked = settings.savePdf !== false));
  settingsEl.classList.toggle('locked', recording);
  shortcutHintEl.hidden = controls.captureMode.value !== 'screen';

  const reconnectingFolder = canReconnectCaptureFolder(state);
  const problem = state?.error || (isFolderReconnectNotice(state) ? null : state?.lastError);
  if (problem) {
    statusEl.textContent = problem;
    statusEl.className = 'status error';
  } else if (paused) {
    statusEl.textContent = `Paused \u00b7 ${state.sequence} screenshot(s)`;
    statusEl.className = 'status paused';
  } else if (recording) {
    const api = settings.captureApi ? ` \u00b7 ${state.apiSeen} API call(s)` : '';
    const folderFallback = reconnectingFolder ? ' \u00b7 saving in Downloads' : '';
    statusEl.textContent = `Recording \u00b7 ${state.sequence} screenshot(s)${api}${folderFallback}`;
    statusEl.className = 'status recording';
  } else {
    statusEl.textContent = 'Idle';
    statusEl.className = 'status idle';
  }

  toggleEl.textContent = recording ? 'Stop recording' : 'Start recording';
  toggleEl.classList.toggle('stop', recording);
  pauseResumeEl.hidden = !recording;
  pauseResumeEl.disabled = !recording;
  pauseResumeEl.textContent = paused ? 'Continue recording' : 'Pause recording';
  captureNowEl.disabled = !recording || paused || Boolean(state?.fullPageProgress?.active);
  captureLaterEl.disabled = !recording || paused;
  saveFlowEl.disabled = !recording || !state?.captures?.length;
  saveAndOpenEl.disabled = !recording || !state?.captures?.length;
  startNewRecordingEl.disabled = !recording;
  exportPdfNowEl.disabled = !recording || !state?.captures?.length;
  updateResumeCaptureButton(state);

  renderCaptures(currentCaptures);
}

async function refresh() {
  // Polling must not dismiss the keep-or-delete prompt out from under the user.
  if (awaitingChoice || standalonePopup) return;
  try {
    render(await send('GET_STATE'));
  } catch {
    showRuntimeError();
  }
}

toggleEl.addEventListener('click', async () => {
  try {
    const state = await send('GET_STATE');
    if (state.recording) {
      awaitingChoice = true;
      mainActionsEl.classList.add('awaiting-stop-choice');
      toggleEl.disabled = true;
      confirmEl.hidden = false;
      filenamePromptEl.hidden = true;
      deleteConfirmEl.hidden = true;
      return;
    }
    render(await send('START', { settings: readSettings() }));
  } catch {
    showRuntimeError();
  }
});

pauseResumeEl.addEventListener('click', async () => {
  const state = await send('GET_STATE');
  if (!state.recording) {
    render(state);
    return;
  }
  pauseResumeEl.disabled = true;
  render(await send('SET_PAUSED', { paused: !state.paused }));
  pauseResumeEl.disabled = false;
});

async function finishRecording(keepFiles, outputFilename, selectedOutputFormats, createPdf = true) {
  const folderPermission = renewSelectedCaptureFolderWritePermission();
  confirmEl.hidden = true;
  filenamePromptEl.hidden = true;
  deleteConfirmEl.hidden = true;
  awaitingChoice = false;
  toggleEl.disabled = true;
  statusEl.textContent = keepFiles
    ? 'Finishing up \u2014 writing files and opening the folder\u2026'
    : 'Deleting captured files\u2026';
  const payload = { keepFiles, outputFilename, outputFormats: selectedOutputFormats, createPdf };
  if (keepFiles && createPdf) {
    payload.excludedSequences = excludedCaptureSequenceList();
  }
  try {
    await folderPermission;
    await noteUpdateChain;
    const state = await send('STOP', payload);
    render(state);
    if (keepFiles && createPdf && !state.lastError) showSaveResult(state);
    if (keepFiles && !createPdf && !state.lastError) {
      showToast('Recording stopped without creating a document.');
    }
  } catch (error) {
    showActionError('Could not stop recording', error);
  } finally {
    mainActionsEl.classList.remove('awaiting-stop-choice');
    mainActionsEl.hidden = false;
    toggleEl.disabled = false;
    pendingOutputAction = null;
    returnToStopChoice = false;
  }
}

async function exportOutputNow(outputFilename, selectedOutputFormats) {
  const folderPermission = renewSelectedCaptureFolderWritePermission();
  filenamePromptEl.hidden = true;
  mainActionsEl.hidden = false;
  awaitingChoice = false;
  pendingOutputAction = null;
  returnToStopChoice = false;
  statusEl.textContent = 'Writing checkpoint output\u2026';
  try {
    await folderPermission;
    await noteUpdateChain;
    const state = await send('EXPORT_PDF_NOW', {
      outputFilename,
      outputFormats: selectedOutputFormats,
      excludedSequences: excludedCaptureSequenceList()
    });
    render(state);
    showSaveResult(state);
  } catch (error) {
    showActionError('Save failed', error);
  }
}

async function saveFlow(outputFilename, selectedOutputFormats) {
  const folderPermission = renewSelectedCaptureFolderWritePermission();
  filenamePromptEl.hidden = true;
  mainActionsEl.hidden = false;
  awaitingChoice = false;
  pendingOutputAction = null;
  returnToStopChoice = false;
  try {
    await folderPermission;
    await noteUpdateChain;
    const state = await send('GET_STATE');
    render(state);
    if (!state.recording || !state.captures.length) return;
    statusEl.textContent = 'Saving checkpoint output...';
    statusEl.className = 'status recording';
    const saved = await send('SAVE_FLOW', {
      outputFilename,
      outputFormats: selectedOutputFormats,
      excludedSequences: excludedCaptureSequenceList()
    });
    render(saved);
    showSaveResult(saved);
  } catch (error) {
    showActionError('Save failed', error);
  }
}

async function startNewRecording(outputFilename, selectedOutputFormats) {
  const folderPermission = renewSelectedCaptureFolderWritePermission();
  filenamePromptEl.hidden = true;
  mainActionsEl.hidden = false;
  awaitingChoice = false;
  pendingOutputAction = null;
  returnToStopChoice = false;
  try {
    await folderPermission;
    await noteUpdateChain;
    const state = await send('GET_STATE');
    render(state);
    if (!state.recording) return;
    statusEl.textContent = 'Saving the current flow and starting a new recording...';
    statusEl.className = 'status recording';
    const started = await send('START_NEW_RECORDING', {
      settings: readSettings(),
      outputFilename,
      outputFormats: selectedOutputFormats,
      excludedSequences: excludedCaptureSequenceList()
    });
    render(started);
    if (started?.savedOutputFilenames?.length || started?.savedPdfFilename) showSaveResult(started);
  } catch (error) {
    showActionError('Could not start a new recording', error);
  }
}

function outputPromptLabel(action) {
  if (action === 'final') return 'Save and stop';
  if (action === 'new-recording') return 'Save and start new';
  return 'Save checkpoint';
}

function openOutputPrompt(action, state, restoreStopChoice = false) {
  pendingOutputAction = action;
  returnToStopChoice = restoreStopChoice;
  awaitingChoice = true;
  const sessionId = state?.sessionId || 'JShotz-session';
  outputFilenameEl.value = action === 'final' || action === 'new-recording'
    ? sessionId
    : `${sessionId}_checkpoint`;
  outputPdfEl.checked = currentSettings.savePdf !== false;
  outputDocxEl.checked = false;
  saveWithNameEl.textContent = outputPromptLabel(action);
  confirmEl.hidden = true;
  deleteConfirmEl.hidden = true;
  mainActionsEl.hidden = true;
  filenamePromptEl.hidden = false;
  updateCaptureSelectionControls();
  outputFilenameEl.focus();
  outputFilenameEl.select();
}

async function beginOutputAction(action) {
  const state = await send('GET_STATE');
  render(state);
  if (!state.recording) return;
  if (!state.captures.length) {
    if (action === 'new-recording') {
      await startNewRecording(undefined, undefined);
    }
    return;
  }
  openOutputPrompt(action, state);
}

document.getElementById('keepYes').addEventListener('click', async () => {
  const state = await send('GET_STATE');
  render(state);
  openOutputPrompt('final', state, true);
});

document.getElementById('keepNo').addEventListener('click', () => {
  confirmEl.hidden = true;
  deleteConfirmEl.hidden = false;
});
document.getElementById('filenameCancel').addEventListener('click', () => {
  filenamePromptEl.hidden = true;
  mainActionsEl.hidden = false;
  const restoreStopChoice = returnToStopChoice;
  pendingOutputAction = null;
  returnToStopChoice = false;
  if (restoreStopChoice) {
    awaitingChoice = true;
    confirmEl.hidden = false;
    toggleEl.disabled = false;
  } else {
    awaitingChoice = false;
  }
});
document.getElementById('saveWithName').addEventListener('click', () => {
  const selectedOutputFormats = outputFormats();
  if (!selectedOutputFormats.length) {
    statusEl.textContent = 'Choose PDF, Word, or both before saving.';
    statusEl.className = 'status error';
    return;
  }
  if (currentCaptures.length && !selectedCaptureSequenceList().length) {
    statusEl.textContent = 'Select at least one screenshot for output.';
    statusEl.className = 'status error';
    return;
  }
  const action = pendingOutputAction;
  if (action === 'final') finishRecording(true, outputFilenameEl.value, selectedOutputFormats);
  else if (action === 'new-recording') startNewRecording(outputFilenameEl.value, selectedOutputFormats);
  else if (action === 'checkpoint') saveFlow(outputFilenameEl.value, selectedOutputFormats);
  else exportOutputNow(outputFilenameEl.value, selectedOutputFormats);
});
document.getElementById('keepWithoutPdf').addEventListener('click', () => finishRecording(true, undefined, undefined, false));
document.getElementById('deleteConfirmYes').addEventListener('click', () => finishRecording(false));
document.getElementById('deleteConfirmNo').addEventListener('click', () => {
  deleteConfirmEl.hidden = true;
  confirmEl.hidden = false;
});

resumeCaptureFromFolderEl.addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') {
    statusEl.textContent = 'Resume from a folder is available in Chrome or Edge.';
    statusEl.className = 'status error';
    return;
  }

  resumeCaptureFromFolderEl.disabled = true;
  const reconnecting = canReconnectCaptureFolder(renderedState);
  statusEl.textContent = 'Choose the folder containing the earlier screenshots.';
  statusEl.className = 'status idle';
  try {
    const directoryHandle = await window.showDirectoryPicker({
      id: 'jshotz-resume-capture',
      mode: 'readwrite',
      startIn: 'downloads'
    });
    rememberSelectedCaptureFolder(directoryHandle);
    if (!(await requestReadWritePermissionFromUserGesture(directoryHandle))) {
      throw new Error('JShotz needs permission to read and add screenshots in that folder.');
    }
    await saveCaptureFolder(directoryHandle);
    const state = await send(
      reconnecting ? 'RECONNECT_CAPTURE_FOLDER' : 'RESUME_FROM_FOLDER',
      reconnecting ? {} : { settings: readSettings() }
    );
    if (state.recording && !reconnecting) {
      captureSelectionSessionId = null;
      knownCaptureSequences = new Set();
      selectedCaptureSequences = new Set();
    }
    render(state);
    if (state.notice) {
      showToast(state.notice);
    } else if (state.lastError) {
      showToast(state.lastError, 'error');
    } else if (reconnecting) {
      showToast('Capture folder reconnected.');
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      statusEl.textContent = 'Folder selection cancelled.';
      statusEl.className = 'status idle';
    } else {
      statusEl.textContent = error?.message || 'Could not resume from that folder.';
      statusEl.className = 'status error';
      showToast(statusEl.textContent, 'error');
    }
  } finally {
    if (!standalonePopup) {
      const state = await send('GET_STATE').catch(() => null);
      renderedState = state;
      updateResumeCaptureButton(state);
    }
  }
});

captureNowEl.addEventListener('click', async () => {
  render(await send('CAPTURE_NOW'));
});

saveFlowEl.addEventListener('click', () => beginOutputAction('checkpoint').catch(showRuntimeError));
saveAndOpenEl.addEventListener('click', () => beginOutputAction('final').catch(showRuntimeError));
startNewRecordingEl.addEventListener('click', () => beginOutputAction('new-recording').catch(showRuntimeError));
exportPdfNowEl.addEventListener('click', () => beginOutputAction('export').catch(showRuntimeError));

selectAllCapturesEl.addEventListener('change', () => {
  selectedCaptureSequences = selectAllCapturesEl.checked
    ? new Set(captureSequences())
    : new Set();
  renderCaptures(currentCaptures, true);
  persistCaptureSelection();
});

outputPdfEl.addEventListener('change', updateCaptureSelectionControls);
outputDocxEl.addEventListener('change', updateCaptureSelectionControls);

// The popup closes as soon as focus moves to DevTools, so the countdown lives in the background.
captureLaterEl.addEventListener('click', async () => {
  render(await send('CAPTURE_LATER'));
  statusEl.textContent = 'Capturing in 5s \u2014 click into DevTools now\u2026';
  window.close();
});

function isPlainControlShortcut(event, key) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === key
  );
}

function isFinalSaveShortcut(event) {
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function preventShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
}

document.addEventListener('keydown', (event) => {
  if (standalonePopup || !renderedState?.recording || awaitingChoice) return;
  if (isFinalSaveShortcut(event)) {
    preventShortcut(event);
    if (!event.repeat) beginOutputAction('final').catch(showRuntimeError);
    return;
  }
  if (isPlainControlShortcut(event, 's')) {
    preventShortcut(event);
    if (!event.repeat) beginOutputAction('checkpoint').catch(showRuntimeError);
    return;
  }
  if (isPlainControlShortcut(event, 'n')) {
    preventShortcut(event);
    if (!event.repeat) beginOutputAction('new-recording').catch(showRuntimeError);
  }
});

for (const control of Object.values(controls)) {
  control.addEventListener('change', () => {
    shortcutHintEl.hidden = controls.captureMode.value !== 'screen';
    send('SET_SETTINGS', { settings: readSettings() }).catch(showRuntimeError);
  });
}

// Chrome closes the popup when the share picker opens, so re-sync on open and while visible.
render(null);
if (hasExtensionRuntime()) {
  preloadSelectedCaptureFolder();
  refresh();
  setInterval(refresh, 1000);
} else {
  showStandalonePopup();
}

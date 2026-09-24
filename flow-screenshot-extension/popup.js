import {
  getSavedCaptureFolder,
  requestReadWritePermissionFromUserGesture,
  saveCaptureFolder
} from './capture-folder.js';

const statusEl = document.getElementById('status');
const extensionVersionEl = document.getElementById('extensionVersion');
const toastEl = document.getElementById('toast');
const toggleEl = document.getElementById('toggle');
const pauseResumeEl = document.getElementById('pauseResume');
const captureNowEl = document.getElementById('captureNow');
const captureLaterEl = document.getElementById('captureLater');
const saveFlowEl = document.getElementById('saveFlow');
const captureListEl = document.getElementById('captureList');
const settingsEl = document.querySelector('.settings');
const mainActionsEl = document.getElementById('mainActions');
const confirmEl = document.getElementById('confirm');
const filenamePromptEl = document.getElementById('filenamePrompt');
const deleteConfirmEl = document.getElementById('deleteConfirm');
const sessionFolderPromptEl = document.getElementById('sessionFolderPrompt');
const sessionFolderNameEl = document.getElementById('sessionFolderName');
const sessionFolderStartEl = document.getElementById('sessionFolderStart');
const sessionFolderCancelEl = document.getElementById('sessionFolderCancel');
const sessionFolderConflictEl = document.getElementById('sessionFolderConflict');
const uniqueSessionFolderNameEl = document.getElementById('uniqueSessionFolderName');
const folderConflictChoiceEls = [...document.querySelectorAll('input[name="folderConflictChoice"]')];
const captureOptionsSummaryEl = document.getElementById('captureOptionsSummary');
const outputFilenameEl = document.getElementById('outputFilename');
const outputPromptTitleEl = document.getElementById('outputPromptTitle');
const outputPdfEl = document.getElementById('outputPdf');
const outputDocxEl = document.getElementById('outputDocx');
const shortcutHintEl = document.getElementById('shortcutHint');
const selectAllCapturesEl = document.getElementById('selectAllCaptures');
const captureSelectionSummaryEl = document.getElementById('captureSelectionSummary');
const saveWithNameEl = document.getElementById('saveWithName');
const saveWithNameAndOpenEl = document.getElementById('saveWithNameAndOpen');
const fullPageProgressEl = document.getElementById('fullPageProgress');
const fullPageProgressLabelEl = document.getElementById('fullPageProgressLabel');
const fullPageProgressPercentEl = document.getElementById('fullPageProgressPercent');
const fullPageProgressBarEl = document.getElementById('fullPageProgressBar');
const fullPageProgressTrackEl = fullPageProgressBarEl.parentElement;
const resumeCaptureFromFolderEl = document.getElementById('resumeCaptureFromFolder');
const completedEvidenceActionsEl = document.getElementById('completedEvidenceActions');
const generateEvidenceEl = document.getElementById('generateEvidence');
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

async function getCurrentTabId() {
  try {
    const tabs = await globalThis.chrome?.tabs?.query?.({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    return Number.isSafeInteger(tabId) ? tabId : null;
  } catch {
    return null;
  }
}

function showExtensionVersion() {
  try {
    const version = chrome.runtime?.getManifest?.().version;
    if (!version) return;
    extensionVersionEl.textContent = `v${version}`;
    extensionVersionEl.hidden = false;
  } catch {}
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

function showSaveResult(state, { locationRequested = false, selectedFolderName = null } = {}) {
  const names = Array.isArray(state?.savedOutputFilenames)
    ? state.savedOutputFilenames
    : state?.savedPdfFilename
      ? [state.savedPdfFilename]
      : [];
  if (names.length) {
    if (locationRequested) {
      const message = selectedFolderName
        ? `Saved as ${names.join(' and ')}. Opened Downloads; Chrome cannot directly open the selected capture folder.`
        : state?.fileLocationOpened === false
          ? `Saved as ${names.join(' and ')}, but could not open the file location: ${state.fileLocationError || 'Chrome did not provide a download location.'}`
          : state?.fileLocationFallback
            ? `Saved as ${names.join(' and ')} and opened Downloads.`
            : `Saved as ${names.join(' and ')} and opened the file location.`;
      statusEl.textContent = message;
      statusEl.className = state?.fileLocationOpened === false ? 'status error' : 'status idle';
      return;
    }
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

async function getPopupState() {
  const [state, currentTabId] = await Promise.all([send('GET_STATE'), getCurrentTabId()]);
  const trackedTabIds = Array.isArray(state?.trackedTabIds) ? state.trackedTabIds : [];
  return {
    ...state,
    recordingElsewhere: Boolean(
      state?.recording &&
        Number.isSafeInteger(currentTabId) &&
        trackedTabIds.length &&
        !trackedTabIds.includes(currentTabId)
    )
  };
}

function isRecordingHere(state) {
  return Boolean(state?.recording && !state?.recordingElsewhere);
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

function renewSelectedCaptureFolderWritePermission(folderName = null) {
  const targetFolderName = folderName ?? (renderedState?.recording ? renderedState.outputFolder?.name : null);
  if (!targetFolderName) return Promise.resolve();

  const directoryHandle = selectedCaptureFolderHandle;
  if (directoryHandle?.name !== targetFolderName) {
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
    fullPage: controls.fullPage.checked,
    savePng: controls.savePng.checked,
    savePdf: controls.savePdf.checked
  };
}

function suggestedSessionFolderName(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `JShotz_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  );
}

function timestampedConflictFolderName(folderName, date = new Date()) {
  const suffix = suggestedSessionFolderName(date).slice('JShotz_'.length);
  return `${folderName.slice(0, Math.max(1, 99 - suffix.length))}_${suffix}`;
}

function resetSessionFolderConflict() {
  sessionFolderConflictEl.hidden = true;
  uniqueSessionFolderNameEl.value = '';
  uniqueSessionFolderNameEl.disabled = true;
  folderConflictChoiceEls.find(({ value }) => value === 'reuse').checked = true;
}

async function checkedSessionFolderName(folderName) {
  const result = await send('CHECK_SESSION_FOLDER', { sessionFolderName: folderName });
  return {
    exists: Boolean(result?.exists),
    folderName: String(result?.folderName || folderName).trim()
  };
}

function updateCaptureOptionsSummary() {
  const optionControls = Object.values(controls).filter((control) => control.type === 'checkbox');
  const selectedCount = optionControls.filter((control) => control.checked).length;
  captureOptionsSummaryEl.textContent = `${selectedCount} selected`;
  for (const control of optionControls) {
    control.closest('[role="option"]')?.setAttribute('aria-selected', String(control.checked));
  }
}

async function beginRecording(sessionFolderName) {
  const state = await getPopupState();
  const startsFromResumeFolder = Boolean(state.pendingResumeFolder?.name);
  const started = await send('START', {
    settings: readSettings(),
    ...(startsFromResumeFolder ? {} : { sessionFolderName })
  });
  sessionFolderPromptEl.hidden = true;
  awaitingChoice = false;
  if (startsFromResumeFolder && started.recording) {
    captureSelectionSessionId = null;
    knownCaptureSequences = new Set();
    selectedCaptureSequences = new Set();
  }
  render(started);
  if (started.notice) showToast(started.notice);
  else if (started.lastError) showToast(started.lastError, 'error');
}

function captureSequences(captures = currentCaptures) {
  return captures
    .map((capture) => capture.sequence)
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0);
}

function captureListKey(captures) {
  return captures
    .map((capture) => [capture.sequence, capture.actionAt, capture.capturedAt, capture.title, capture.note, capture.url, capture.reason].join('\u001f'))
    .join('\u001e');
}

function captureActionMilliseconds(capture) {
  const milliseconds = Date.parse(capture?.actionAt || '');
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function captureSequence(capture) {
  const sequence = Number(capture?.sequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

function captureRequestOrder(capture) {
  const requestSequence = Number(capture?.requestSequence);
  return Number.isSafeInteger(requestSequence) && requestSequence > 0 ? requestSequence : null;
}

function compareCaptureFlow(left, right) {
  const leftActionAt = captureActionMilliseconds(left);
  const rightActionAt = captureActionMilliseconds(right);
  if (leftActionAt !== null && rightActionAt !== null && leftActionAt !== rightActionAt) {
    return leftActionAt - rightActionAt;
  }
  const leftRequestOrder = captureRequestOrder(left);
  const rightRequestOrder = captureRequestOrder(right);
  if (leftRequestOrder !== null && rightRequestOrder !== null && leftRequestOrder !== rightRequestOrder) {
    return leftRequestOrder - rightRequestOrder;
  }
  return captureSequence(left) - captureSequence(right);
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
  const saveDisabled =
    !filenamePromptEl.hidden &&
    (!outputFormats().length || (needsSelection && total > 0 && selected === 0));
  saveWithNameEl.disabled = saveDisabled;
  saveWithNameAndOpenEl.disabled = saveDisabled;
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
  const visibleCaptures = [...captures].sort(compareCaptureFlow).slice(-captureListLimit).reverse();
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
    const actionTime = capture.actionAt || capture.capturedAt;
    meta.textContent = `${new Date(actionTime).toLocaleTimeString()} · ${capture.reason}`;

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
  const pendingFolderName = !state?.recording ? state?.pendingResumeFolder?.name : null;
  resumeCaptureFromFolderEl.textContent = reconnecting
    ? 'Reconnect capture folder'
    : pendingFolderName
      ? 'Change resume capture folder'
      : 'Resume capture from folder';
  resumeCaptureFromFolderEl.disabled = Boolean(state?.recording) && !reconnecting;
}

function hasCompletedEvidence(state) {
  return Boolean(
    !state?.recording &&
      state?.completedEvidence?.sessionId &&
      state.completedEvidence.sessionId === state.sessionId
  );
}

function updateCompletedEvidenceButton(state) {
  const available = hasCompletedEvidence(state);
  completedEvidenceActionsEl.hidden = !available;
  generateEvidenceEl.disabled = !available || !state?.captures?.length;
}

function interruptedRecordingMessage(state) {
  const interrupted = state?.interruptedRecording;
  if (!interrupted || interrupted.sessionId !== state?.sessionId) return null;

  const captureCount = Number(interrupted.captureCount) || state?.captures?.length || 0;
  const interimOutput = state?.interimOutput;
  if (interimOutput?.sessionId === state.sessionId) {
    const interimCount = Number(interimOutput.captureCount) || captureCount;
    return `Recording ended after the browser restarted. Interim backup includes ${interimCount} screenshot(s).`;
  }
  return captureCount
    ? `Recording ended after the browser restarted. ${captureCount} screenshot(s) remain available for evidence.`
    : 'Recording ended after the browser restarted.';
}

function render(state) {
  renderedState = state ?? null;
  const sessionRecording = Boolean(state?.recording);
  const recordingElsewhere = sessionRecording && Boolean(state?.recordingElsewhere);
  const recording = sessionRecording && !recordingElsewhere;
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
  apply(controls.fullPage, () => (controls.fullPage.checked = settings.fullPage !== false));
  apply(controls.savePng, () => (controls.savePng.checked = settings.savePng !== false));
  apply(controls.savePdf, () => (controls.savePdf.checked = settings.savePdf !== false));
  updateCaptureOptionsSummary();
  settingsEl.classList.toggle('locked', sessionRecording);
  for (const control of Object.values(controls)) {
    control.disabled = standalonePopup || recordingElsewhere;
  }
  shortcutHintEl.hidden = controls.captureMode.value !== 'screen';

  const reconnectingFolder = canReconnectCaptureFolder(state);
  const problem = state?.error || state?.interimOutputError || (isFolderReconnectNotice(state) ? null : state?.lastError);
  const interruptedMessage = interruptedRecordingMessage(state);
  if (problem) {
    statusEl.textContent = problem;
    statusEl.className = 'status error';
  } else if (recordingElsewhere) {
    statusEl.textContent = 'This tab is not being recorded.';
    statusEl.className = 'status idle';
  } else if (paused) {
    statusEl.textContent = `Paused \u00b7 ${state.sequence} screenshot(s)`;
    statusEl.className = 'status paused';
  } else if (recording) {
    const api = settings.captureApi ? ` \u00b7 ${state.apiSeen} API call(s)` : '';
    const folderFallback = reconnectingFolder ? ' \u00b7 saving in Downloads' : '';
    statusEl.textContent = `Recording \u00b7 ${state.sequence} screenshot(s)${api}${folderFallback}`;
    statusEl.className = 'status recording';
  } else if (interruptedMessage) {
    statusEl.textContent = interruptedMessage;
    statusEl.className = 'status idle';
  } else if (state?.pendingResumeFolder?.name) {
    statusEl.textContent = 'Ready to start in the selected capture folder.';
    statusEl.className = 'status idle';
  } else {
    statusEl.textContent = 'Idle';
    statusEl.className = 'status idle';
  }

  toggleEl.textContent = recordingElsewhere
    ? 'Recording on another tab'
    : recording
      ? 'Stop recording'
      : 'Start recording';
  toggleEl.classList.toggle('stop', recording);
  if (!awaitingChoice) toggleEl.disabled = standalonePopup || recordingElsewhere;
  pauseResumeEl.hidden = !recording;
  pauseResumeEl.disabled = !recording;
  pauseResumeEl.textContent = paused ? 'Continue recording' : 'Pause recording';
  captureNowEl.disabled = !recording || paused || Boolean(state?.fullPageProgress?.active);
  captureLaterEl.disabled = !recording || paused || !state?.devToolsOpen;
  saveFlowEl.disabled = !recording || !state?.captures?.length;
  updateResumeCaptureButton(state);
  updateCompletedEvidenceButton(state);

  renderCaptures(currentCaptures);
}

async function refresh() {
  // Polling must not dismiss the keep-or-delete prompt out from under the user.
  if (awaitingChoice || standalonePopup) return;
  try {
    render(await getPopupState());
  } catch {
    showRuntimeError();
  }
}

toggleEl.addEventListener('click', async () => {
  try {
    const state = await getPopupState();
    if (state.recordingElsewhere) {
      render(state);
      return;
    }
    if (isRecordingHere(state)) {
      awaitingChoice = true;
      mainActionsEl.classList.add('awaiting-stop-choice');
      toggleEl.disabled = true;
      confirmEl.hidden = false;
      filenamePromptEl.hidden = true;
      deleteConfirmEl.hidden = true;
      return;
    }
    if (state.pendingResumeFolder?.name) {
      await beginRecording();
      return;
    }
    awaitingChoice = true;
    toggleEl.disabled = true;
    resetSessionFolderConflict();
    sessionFolderNameEl.value = suggestedSessionFolderName();
    sessionFolderPromptEl.hidden = false;
    sessionFolderNameEl.focus();
    sessionFolderNameEl.select();
  } catch {
    showRuntimeError();
  }
});

sessionFolderStartEl.addEventListener('click', async () => {
  let sessionFolderName = sessionFolderNameEl.value.trim();
  if (!sessionFolderName) {
    showToast('Enter a name for the evidence folder.', 'error');
    sessionFolderNameEl.focus();
    return;
  }
  sessionFolderStartEl.disabled = true;
  try {
    if (sessionFolderConflictEl.hidden) {
      const checked = await checkedSessionFolderName(sessionFolderName);
      sessionFolderName = checked.folderName;
      if (checked.exists) {
        sessionFolderNameEl.value = sessionFolderName;
        uniqueSessionFolderNameEl.value = `${sessionFolderName}_new`;
        sessionFolderConflictEl.hidden = false;
        return;
      }
    } else {
      const choice = folderConflictChoiceEls.find(({ checked }) => checked)?.value;
      if (choice === 'timestamp') {
        sessionFolderName = timestampedConflictFolderName(sessionFolderName);
        const checked = await checkedSessionFolderName(sessionFolderName);
        if (checked.exists) {
          showToast('The timestamped folder also exists. Try again.', 'error');
          return;
        }
        sessionFolderName = checked.folderName;
      } else if (choice === 'rename') {
        const uniqueName = uniqueSessionFolderNameEl.value.trim();
        if (!uniqueName) {
          showToast('Enter a new unique folder name.', 'error');
          uniqueSessionFolderNameEl.focus();
          return;
        }
        const checked = await checkedSessionFolderName(uniqueName);
        if (checked.exists) {
          showToast('That folder already exists. Enter a unique folder name.', 'error');
          uniqueSessionFolderNameEl.focus();
          uniqueSessionFolderNameEl.select();
          return;
        }
        sessionFolderName = checked.folderName;
      }
    }
    await beginRecording(sessionFolderName);
  } catch (error) {
    showActionError('Start recording', error);
  } finally {
    sessionFolderStartEl.disabled = false;
  }
});

sessionFolderCancelEl.addEventListener('click', () => {
  sessionFolderPromptEl.hidden = true;
  resetSessionFolderConflict();
  awaitingChoice = false;
  toggleEl.disabled = false;
});

sessionFolderNameEl.addEventListener('input', resetSessionFolderConflict);

for (const choiceEl of folderConflictChoiceEls) {
  choiceEl.addEventListener('change', () => {
    uniqueSessionFolderNameEl.disabled = choiceEl.value !== 'rename' || !choiceEl.checked;
    if (!uniqueSessionFolderNameEl.disabled) uniqueSessionFolderNameEl.focus();
  });
}

sessionFolderNameEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sessionFolderStartEl.click();
  }
});

for (const control of Object.values(controls)) {
  if (control.type === 'checkbox') control.addEventListener('change', updateCaptureOptionsSummary);
}

pauseResumeEl.addEventListener('click', async () => {
  const state = await getPopupState();
  if (!isRecordingHere(state)) {
    render(state);
    return;
  }
  pauseResumeEl.disabled = true;
  render(await send('SET_PAUSED', { paused: !state.paused }));
  pauseResumeEl.disabled = false;
});

async function finishRecording(
  keepFiles,
  outputFilename,
  selectedOutputFormats,
  createPdf = true,
  reveal = false
) {
  const folderPermission = renewSelectedCaptureFolderWritePermission();
  confirmEl.hidden = true;
  filenamePromptEl.hidden = true;
  deleteConfirmEl.hidden = true;
  awaitingChoice = true;
  toggleEl.disabled = true;
  const selectedFolderName = renderedState?.outputFolder?.name || null;
  const opensDownloadLocation = reveal && !selectedFolderName;
  statusEl.textContent = keepFiles
    ? 'The document is being created. Please wait...'
    : 'Deleting captured files\u2026';
  if (keepFiles && opensDownloadLocation) {
    statusEl.textContent = 'The document is being created. Please wait. The folder will open when ready...';
  }
  const payload = {
    keepFiles,
    outputFilename,
    outputFormats: selectedOutputFormats,
    createPdf,
    reveal
  };
  if (keepFiles && createPdf) {
    payload.excludedSequences = excludedCaptureSequenceList();
  }
  try {
    await folderPermission;
    await noteUpdateChain;
    const state = await send('STOP', payload);
    render(state);
    if (keepFiles && createPdf && !state.lastError) {
      showSaveResult(state, { locationRequested: reveal, selectedFolderName });
    }
    if (keepFiles && !createPdf && !state.lastError) {
      showToast('Recording stopped without creating a document.');
    }
  } catch (error) {
    showActionError('Could not stop recording', error);
  } finally {
    awaitingChoice = false;
    mainActionsEl.classList.remove('awaiting-stop-choice');
    mainActionsEl.hidden = false;
    toggleEl.disabled = false;
    pendingOutputAction = null;
    returnToStopChoice = false;
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
    const state = await getPopupState();
    render(state);
    if (!isRecordingHere(state) || !state.captures.length) return;
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

async function generateEvidence(outputFilename, selectedOutputFormats) {
  const evidenceFolderName = renderedState?.completedEvidence?.outputFolderName || null;
  const folderPermission = renewSelectedCaptureFolderWritePermission(evidenceFolderName);
  filenamePromptEl.hidden = true;
  mainActionsEl.hidden = false;
  completedEvidenceActionsEl.hidden = true;
  awaitingChoice = false;
  pendingOutputAction = null;
  returnToStopChoice = false;
  try {
    await folderPermission;
    await noteUpdateChain;
    const saved = await send('GENERATE_EVIDENCE', {
      outputFilename,
      outputFormats: selectedOutputFormats,
      excludedSequences: excludedCaptureSequenceList()
    });
    render(saved);
    if (saved.lastError) throw new Error(saved.lastError);
    showSaveResult(saved);
  } catch (error) {
    showActionError('Could not generate evidence', error);
    updateCompletedEvidenceButton(renderedState);
  }
}

function outputPromptConfig(action) {
  if (action === 'checkpoint') {
    return {
      checkpoint: true,
      final: false,
      title: 'Save checkpoint (Ctrl+Shift+S)',
      button: 'Save checkpoint (Ctrl+Shift+S)',
      reveal: false,
      showLocationButton: false
    };
  }
  if (action === 'evidence') {
    return {
      checkpoint: false,
      final: false,
      evidence: true,
      title: 'Generate evidences',
      button: 'Generate evidences',
      reveal: false,
      showLocationButton: false
    };
  }
  if (action === 'final-save') {
    return {
      checkpoint: false,
      final: true,
      title: 'Save and stop (Ctrl+S)',
      button: 'Save and stop (Ctrl+S)',
      reveal: false,
      showLocationButton: false
    };
  }
  if (action === 'final-reveal') {
    return {
      checkpoint: false,
      final: true,
      title: 'Save, stop, and open file location (Ctrl+Alt+S)',
      button: 'Save, stop, and open file location (Ctrl+Alt+S)',
      reveal: true,
      showLocationButton: false
    };
  }
  return {
    checkpoint: false,
    final: true,
    title: 'Save and stop recording',
    button: 'Save and stop (Ctrl+S)',
    reveal: false,
    showLocationButton: true
  };
}

function openOutputPrompt(action, state, restoreStopChoice = false) {
  const prompt = outputPromptConfig(action);
  pendingOutputAction = action;
  returnToStopChoice = restoreStopChoice;
  awaitingChoice = true;
  const sessionId = state?.sessionId || 'JShotz-session';
  outputFilenameEl.value = prompt.checkpoint
    ? `${sessionId}_checkpoint`
    : prompt.evidence
      ? `${sessionId}_evidence`
      : sessionId;
  outputPdfEl.checked = currentSettings.savePdf !== false;
  outputDocxEl.checked = false;
  outputPromptTitleEl.textContent = prompt.title;
  saveWithNameEl.textContent = prompt.button;
  saveWithNameAndOpenEl.hidden = !prompt.showLocationButton;
  confirmEl.hidden = true;
  deleteConfirmEl.hidden = true;
  mainActionsEl.hidden = true;
  completedEvidenceActionsEl.hidden = true;
  filenamePromptEl.hidden = false;
  updateCaptureSelectionControls();
  outputFilenameEl.focus();
  outputFilenameEl.select();
}

async function beginOutputAction(action) {
  const state = await getPopupState();
  render(state);
  if (!isRecordingHere(state)) return;
  if (!state.captures.length) return;
  openOutputPrompt(action, state);
}

document.getElementById('keepYes').addEventListener('click', async () => {
  const state = await getPopupState();
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
  updateCompletedEvidenceButton(renderedState);
});
function saveNamedOutput(reveal) {
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
  if (!action) return;
  const prompt = outputPromptConfig(action);
  if (prompt.final) {
    finishRecording(true, outputFilenameEl.value, selectedOutputFormats, true, reveal ?? prompt.reveal);
  } else if (prompt.checkpoint) {
    saveFlow(outputFilenameEl.value, selectedOutputFormats);
  } else if (prompt.evidence) {
    generateEvidence(outputFilenameEl.value, selectedOutputFormats);
  }
}

document.getElementById('saveWithName').addEventListener('click', () => {
  saveNamedOutput();
});
saveWithNameAndOpenEl.addEventListener('click', () => {
  saveNamedOutput(true);
});
generateEvidenceEl.addEventListener('click', async () => {
  try {
    const state = await getPopupState();
    render(state);
    if (!hasCompletedEvidence(state) || !state.captures?.length) return;
    openOutputPrompt('evidence', state);
  } catch {
    showRuntimeError();
  }
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
      reconnecting ? 'RECONNECT_CAPTURE_FOLDER' : 'PREPARE_RESUME_FROM_FOLDER'
    );
    render(state);
    if (state.notice) {
      showToast(state.notice);
    } else if (state.lastError) {
      showToast(state.lastError, 'error');
    } else if (reconnecting) {
      showToast('Capture folder reconnected.');
    } else if (state.pendingResumeFolder?.name) {
      showToast(`Capture folder selected: ${state.pendingResumeFolder.name}.`);
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
      const state = await getPopupState().catch(() => null);
      renderedState = state;
      updateResumeCaptureButton(state);
    }
  }
});

captureNowEl.addEventListener('click', async () => {
  render(await send('CAPTURE_NOW'));
});

saveFlowEl.addEventListener('click', () => beginOutputAction('checkpoint').catch(showRuntimeError));

selectAllCapturesEl.addEventListener('change', () => {
  selectedCaptureSequences = selectAllCapturesEl.checked
    ? new Set(captureSequences())
    : new Set();
  renderCaptures(currentCaptures, true);
  persistCaptureSelection();
});

outputPdfEl.addEventListener('change', updateCaptureSelectionControls);
outputDocxEl.addEventListener('change', updateCaptureSelectionControls);

captureLaterEl.addEventListener('click', async () => {
  await send('CAPTURE_LATER');
  window.close();
});

function isSaveAndOpenLocationShortcut(event) {
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function isSaveAndStopShortcut(event) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function isCheckpointSaveShortcut(event) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function preventShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
}

document.addEventListener('keydown', (event) => {
  if (standalonePopup || !renderedState?.recording) return;
  if (awaitingChoice) {
    if (
      (pendingOutputAction === 'final' || pendingOutputAction === 'final-reveal') &&
      isSaveAndOpenLocationShortcut(event)
    ) {
      preventShortcut(event);
      if (!event.repeat) saveNamedOutput(pendingOutputAction === 'final' ? true : undefined);
      return;
    }
    if (
      (pendingOutputAction === 'final' || pendingOutputAction === 'final-save') &&
      isSaveAndStopShortcut(event)
    ) {
      preventShortcut(event);
      if (!event.repeat) saveNamedOutput();
      return;
    }
    if (pendingOutputAction === 'checkpoint' && isCheckpointSaveShortcut(event)) {
      preventShortcut(event);
      if (!event.repeat) saveNamedOutput();
    }
    return;
  }
  if (isSaveAndOpenLocationShortcut(event)) {
    preventShortcut(event);
    if (!event.repeat) beginOutputAction('final-reveal').catch(showRuntimeError);
    return;
  }
  if (isCheckpointSaveShortcut(event)) {
    preventShortcut(event);
    if (!event.repeat) beginOutputAction('checkpoint').catch(showRuntimeError);
    return;
  }
  if (isSaveAndStopShortcut(event)) {
    preventShortcut(event);
    if (!event.repeat) beginOutputAction('final-save').catch(showRuntimeError);
  }
});

for (const control of Object.values(controls)) {
  control.addEventListener('change', () => {
    shortcutHintEl.hidden = controls.captureMode.value !== 'screen';
    send('SET_SETTINGS', { settings: readSettings() }).catch(showRuntimeError);
  });
}

// Chrome closes the popup when the share picker opens, so re-sync on open and while visible.
showExtensionVersion();
render(null);
if (hasExtensionRuntime()) {
  preloadSelectedCaptureFolder();
  refresh();
  setInterval(refresh, 1000);
} else {
  showStandalonePopup();
}

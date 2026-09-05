const statusEl = document.getElementById('status');
const toggleEl = document.getElementById('toggle');
const captureNowEl = document.getElementById('captureNow');
const captureListEl = document.getElementById('captureList');
const settingsEl = document.querySelector('.settings');
const mainActionsEl = document.getElementById('mainActions');
const confirmEl = document.getElementById('confirm');
const filenamePromptEl = document.getElementById('filenamePrompt');
const deleteConfirmEl = document.getElementById('deleteConfirm');
const pdfFilenameEl = document.getElementById('pdfFilename');
const shortcutHintEl = document.getElementById('shortcutHint');

let awaitingChoice = false;

const controls = {
  captureMode: document.getElementById('captureMode'),
  captureOnClick: document.getElementById('captureOnClick'),
  stampTimestamp: document.getElementById('stampTimestamp'),
  savePng: document.getElementById('savePng'),
  savePdf: document.getElementById('savePdf')
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function readSettings() {
  return {
    captureMode: controls.captureMode.value,
    captureOnClick: controls.captureOnClick.checked,
    stampTimestamp: controls.stampTimestamp.checked,
    savePng: controls.savePng.checked,
    savePdf: controls.savePdf.checked
  };
}

function renderCaptures(captures) {
  captureListEl.replaceChildren();

  if (!captures.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No captures yet.';
    captureListEl.append(empty);
    return;
  }

  // Newest first, and build nodes with textContent so untrusted page titles can't inject markup.
  for (const capture of [...captures].reverse()) {
    const item = document.createElement('li');

    const title = document.createElement('span');
    title.className = 'capture-title';
    title.textContent = `${capture.sequence}. ${capture.title || capture.url}`;
    title.title = capture.url || '';

    const meta = document.createElement('span');
    meta.className = 'capture-meta';
    meta.textContent = `${new Date(capture.capturedAt).toLocaleTimeString()} · ${capture.reason}`;

    item.append(title, meta);
    captureListEl.append(item);
  }
}

function render(state) {
  const recording = Boolean(state?.recording);
  const settings = state?.settings ?? {};

  // Polling must not steal a control the user is currently interacting with.
  const apply = (control, assign) => {
    if (document.activeElement !== control) assign();
  };
  apply(controls.captureMode, () => (controls.captureMode.value = settings.captureMode ?? 'tab'));
  apply(controls.captureOnClick, () => (controls.captureOnClick.checked = settings.captureOnClick !== false));
  apply(controls.stampTimestamp, () => (controls.stampTimestamp.checked = settings.stampTimestamp !== false));
  apply(controls.savePng, () => (controls.savePng.checked = settings.savePng !== false));
  apply(controls.savePdf, () => (controls.savePdf.checked = settings.savePdf !== false));
  settingsEl.classList.toggle('locked', recording);
  shortcutHintEl.hidden = controls.captureMode.value !== 'screen';

  const problem = state?.error || state?.lastError;
  if (problem) {
    statusEl.textContent = problem;
    statusEl.className = 'status error';
  } else if (recording) {
    const api = settings.captureApi ? ` \u00b7 ${state.apiSeen} API call(s)` : '';
    const background = state.headlessCaptureActive
      ? ' \u00b7 background capture: on'
      : ' \u00b7 background capture: off (view may scroll)';
    statusEl.textContent = `Recording \u00b7 ${state.sequence} screenshot(s)${api}${background}`;
    statusEl.className = 'status recording';
  } else {
    statusEl.textContent = 'Idle';
    statusEl.className = 'status idle';
  }

  toggleEl.textContent = recording ? 'Stop recording' : 'Start recording';
  toggleEl.classList.toggle('stop', recording);
  captureNowEl.disabled = !recording;

  renderCaptures(state?.captures ?? []);
}

async function refresh() {
  // Polling must not dismiss the keep-or-delete prompt out from under the user.
  if (awaitingChoice) return;
  render(await send('GET_STATE').catch(() => null));
}

toggleEl.addEventListener('click', async () => {
  const state = await send('GET_STATE');
  if (state.recording) {
    awaitingChoice = true;
    mainActionsEl.hidden = true;
    confirmEl.hidden = false;
    filenamePromptEl.hidden = true;
    deleteConfirmEl.hidden = true;
    return;
  }
  render(await send('START', { settings: readSettings() }));
});

async function finishRecording(keepFiles, pdfFilename) {
  confirmEl.hidden = true;
  filenamePromptEl.hidden = true;
  deleteConfirmEl.hidden = true;
  mainActionsEl.hidden = false;
  awaitingChoice = false;
  toggleEl.disabled = true;
  statusEl.textContent = keepFiles ? 'Finishing up \u2014 writing files\u2026' : 'Deleting captured files\u2026';
  render(await send('STOP', { keepFiles, pdfFilename }));
  toggleEl.disabled = false;
}

document.getElementById('keepYes').addEventListener('click', async () => {
  const state = await send('GET_STATE');
  pdfFilenameEl.value = `${state.sessionId || 'JShotz-session'}.pdf`;
  confirmEl.hidden = true;
  filenamePromptEl.hidden = false;
  pdfFilenameEl.focus();
  pdfFilenameEl.select();
});

document.getElementById('keepNo').addEventListener('click', () => {
  confirmEl.hidden = true;
  deleteConfirmEl.hidden = false;
});
document.getElementById('filenameCancel').addEventListener('click', () => {
  filenamePromptEl.hidden = true;
  confirmEl.hidden = false;
});
document.getElementById('saveWithName').addEventListener('click', () => {
  finishRecording(true, pdfFilenameEl.value);
});
document.getElementById('deleteConfirmYes').addEventListener('click', () => finishRecording(false));
document.getElementById('deleteConfirmNo').addEventListener('click', () => {
  deleteConfirmEl.hidden = true;
  confirmEl.hidden = false;
});

document.getElementById('createPdfLater').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pdf-import.html') });
});

captureNowEl.addEventListener('click', async () => {
  render(await send('CAPTURE_NOW'));
});

for (const control of Object.values(controls)) {
  control.addEventListener('change', () => {
    shortcutHintEl.hidden = controls.captureMode.value !== 'screen';
    send('SET_SETTINGS', { settings: readSettings() });
  });
}

// Chrome closes the popup when the share picker opens, so re-sync on open and while visible.
refresh();
setInterval(refresh, 1000);

import {
  getSavedCaptureFolder,
  imageFileToDataUrl,
  removeCaptureFolderFiles,
  scanCaptureFolder,
  writeCaptureFolderFile
} from './capture-folder.js';
import { handlers as localImageWorkerHandlers } from './image-worker.js';
import { buildDocx } from './docx.js';
import { buildPdf } from './pdf.js';

const STATE_KEY = 'flowRecorderState';
const PDF_EXCLUSIONS_KEY = 'flowRecorderPdfExcludedSequences';
const SESSION_CONTROL_KEY = 'flowRecorderSessionControl';
const SESSION_TRACKING_KEY = 'flowRecorderSessionTracking';
const FRAMES_KEY = 'flowRecorderFrames';
const FRAME_PREFIX = `${FRAMES_KEY}:`;
const OFFSCREEN_PATH = 'offscreen.html';

// captureVisibleTab is rate limited; serialize captures and pace them.
let captureChain = Promise.resolve();
let pendingCaptureCount = 0;
let interimOutputChain = Promise.resolve();
let interimOutputRunning = false;
let queuedInterimOutputRequest = null;
let captureRequestSequence = 0;
let lastRawCaptureHash = '';
let lastTabTitles = new Map();
const pendingNavigationTabIds = new Set();
const captureCancellationSignals = new Map();
let sessionRecoveryPending = false;
let sessionRecoveryChain = Promise.resolve();
let browserRestartInterruptionChain = Promise.resolve();
let recoveredSessionId = null;
let outputRequestSequence = 0;
const pendingNewTabLinkTargets = new Map();
const recentNewTabLinkTargets = new Map();
const recentUnlinkedNewTabs = [];
const pendingUserActionCaptures = new Set();

// Held in memory rather than storage: concurrent API events would race a read-modify-write.
let apiQueue = [];
let apiHeaderRecords = [];

const API_HEADER_TTL_MS = 120000;
const DEVTOOLS_POPUP_CLOSE_GRACE_MS = 75;
const STOP_CAPTURE_DRAIN_MS = 1500;
const INTERIM_OUTPUT_CAPTURE_INTERVAL = 5;
const INTERIM_OUTPUT_FILENAME = 'JShotz-interim.pdf';
const EMPTY_CAPTURE_FOLDER_NOTICE =
  'No previous screenshots found in selected folder, JShotz is still capturing the current flows to the selected folder.';
const NO_READABLE_CAPTURE_FOLDER_NOTICE =
  'No readable screenshots found in selected folder. JShotz is still capturing the current flow in that folder.';

function skippedUnreadableCaptureNotice(count) {
  return `Skipped ${count} unreadable image file${count === 1 ? '' : 's'} while resuming the selected folder.`;
}

// A per-session debug log, cleared at the start of each new recording, mirroring capture attempts,
// timings, errors and mode switches - so "screenshot #N at time T had a problem" can be answered
// from what actually happened, not guessed at. Storage is the only source of truth (not an in-memory
// array): the service worker can be evicted and restarted mid-recording (MV3 idles it after periods
// with no activity), which would silently reset a plain variable and lose everything logged before
// that point - exactly what produced a near-empty log despite 43 captures having happened. It stays
// in background storage during a recording and is included in the final session manifest, so a
// diagnostic log never interrupts the user with a browser download prompt.
const LOG_KEY = 'flowRecorderLog';
const MAX_LOG_LINES = 1000;
let logChain = Promise.resolve();

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  logChain = logChain
    .then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      log.push(line);
      if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
      await chrome.storage.local.set({ [LOG_KEY]: log });
    })
    .catch(() => {});
}

function logFileSave(status, type, filename, destination) {
  logLine(`FILE_SAVE status=${status} type=${type} destination=${destination} filename=${filename}`);
}

async function flushLog() {
  await logChain.catch(() => {});
}

async function readDebugLog() {
  await flushLog();
  const stored = await chrome.storage.local.get(LOG_KEY);
  const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  return log;
}


const defaultState = {
  recording: false,
  paused: false,
  captureGeneration: 0,
  tabId: null,
  windowId: null,
  sessionId: null,
  sessionFolderName: null,
  sequence: 0,
  captures: [],
  pdfExcludedSequences: [],
  trackedTabIds: [],
  trackedWindowIds: [],
  downloadIds: [],
  outputFolder: null,
  pendingResumeFolder: null,
  completedEvidence: null,
  interruptedRecording: null,
  interimOutput: null,
  interimOutputError: null,
  folderWrittenFiles: [],
  folderAccessNeeded: false,
  apiSeen: 0,
  apiHookReady: false,
  streamActive: false,
  screenWindowId: null,
  fullPageProgress: null,
  lastError: null,
  settings: {
    // 'tab' = viewport only, 'api' = viewport + API table, 'screen' = desktop stream (DevTools/taskbar)
    captureMode: 'tab',
    captureOnClick: true,
    captureOnScroll: true,
    captureApi: false,
    fullPage: true,
    savePng: true,
    savePdf: true
  }
};

async function getState() {
  const stored = await chrome.storage.local.get([
    STATE_KEY,
    PDF_EXCLUSIONS_KEY,
    SESSION_CONTROL_KEY,
    SESSION_TRACKING_KEY
  ]);
  const state = stored[STATE_KEY] || {};
  const selection = stored[PDF_EXCLUSIONS_KEY];
  const control = stored[SESSION_CONTROL_KEY];
  const tracking = stored[SESSION_TRACKING_KEY];
  const hasCurrentSessionRecord = (record) => Boolean(state.sessionId) && record?.sessionId === state.sessionId;
  const pdfExcludedSequences = hasCurrentSessionRecord(selection)
    ? normalizeSequenceList(selection.sequences)
    : [];
  const hasCurrentControl = hasCurrentSessionRecord(control);
  const hasCurrentTracking = hasCurrentSessionRecord(tracking);
  const trackedTabIds = hasCurrentTracking
    ? normalizeIdList(tracking.tabIds)
    : normalizeIdList([state.tabId]);
  const trackedWindowIds = hasCurrentTracking
    ? normalizeIdList(tracking.windowIds)
    : normalizeIdList([state.windowId]);
  return {
    ...defaultState,
    ...state,
    pdfExcludedSequences,
    paused: hasCurrentControl ? Boolean(control.paused) : false,
    captureGeneration: hasCurrentControl ? normalizeCaptureGeneration(control.captureGeneration) : 0,
    trackedTabIds,
    trackedWindowIds,
    settings: { ...defaultState.settings, ...state.settings }
  };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch, settings: { ...current.settings, ...patch.settings } };
  const storedState = { ...next };
  delete storedState.pdfExcludedSequences;
  delete storedState.paused;
  delete storedState.captureGeneration;
  delete storedState.trackedTabIds;
  delete storedState.trackedWindowIds;
  await chrome.storage.local.set({ [STATE_KEY]: storedState });
  return next;
}

function normalizeIdList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function normalizeSequenceList(sequences) {
  return normalizeIdList(sequences);
}

function normalizeCaptureGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

let trackingUpdateChain = Promise.resolve();

function replaceSessionTracking(sessionId, tabIds, windowIds) {
  trackingUpdateChain = trackingUpdateChain
    .catch(() => {})
    .then(() =>
      chrome.storage.local.set({
        [SESSION_TRACKING_KEY]: {
          sessionId,
          tabIds: normalizeIdList(tabIds),
          windowIds: normalizeIdList(windowIds)
        }
      })
    );
  return trackingUpdateChain;
}

function updateSessionTracking(sessionId, update) {
  trackingUpdateChain = trackingUpdateChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(SESSION_TRACKING_KEY);
      const current = stored[SESSION_TRACKING_KEY];
      if (current?.sessionId !== sessionId) return null;
      const next = update({
        tabIds: normalizeIdList(current.tabIds),
        windowIds: normalizeIdList(current.windowIds)
      });
      const tracking = {
        sessionId,
        tabIds: normalizeIdList(next.tabIds),
        windowIds: normalizeIdList(next.windowIds)
      };
      await chrome.storage.local.set({ [SESSION_TRACKING_KEY]: tracking });
      return tracking;
    });
  return trackingUpdateChain;
}

function clearSessionTracking() {
  trackingUpdateChain = trackingUpdateChain
    .catch(() => {})
    .then(() => chrome.storage.local.remove(SESSION_TRACKING_KEY));
  return trackingUpdateChain;
}

async function trackSessionTab(state, tab) {
  if (!state.sessionId || !Number.isSafeInteger(tab?.id)) return Promise.resolve();
  if (typeof tab.title === 'string') lastTabTitles.set(tab.id, tab.title);
  const tracking = await updateSessionTracking(state.sessionId, (tracking) => ({
    tabIds: [...tracking.tabIds, tab.id],
    windowIds: [...tracking.windowIds, tab.windowId]
  }));
  await configureApiHookForTab(tab.id, state.settings.captureApi);
  return tracking;
}

function untrackSessionTab(state, tabId) {
  if (!state.sessionId) return Promise.resolve();
  return updateSessionTracking(state.sessionId, (tracking) => ({
    tabIds: tracking.tabIds.filter((trackedTabId) => trackedTabId !== tabId),
    windowIds: tracking.windowIds
  }));
}

function sanitize(value, maxLength = 60) {
  return (value || 'untitled')
    .replace(/[\\/:*?"<>|#]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .slice(0, maxLength);
}

function fileTimestamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

function defaultSessionFolderName(date = new Date()) {
  return `JShotz_${fileTimestamp(date)}`;
}

function sessionDownloadDirectory(state) {
  const folderName = sanitize(state?.sessionFolderName || state?.sessionId || defaultSessionFolderName(), 100);
  return `Jshotz/${folderName}`;
}

function outputRequestId() {
  outputRequestSequence += 1;
  return `output_${Date.now()}_${outputRequestSequence}_${Math.random().toString(36).slice(2, 10)}`;
}

function stampText(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const abbreviation =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `UTC${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;

  const clock =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  return `${clock}  ${abbreviation} (${offset})  |  ${zone}`;
}

function pruneApiHeaderRecords(now = Date.now()) {
  apiHeaderRecords = apiHeaderRecords.filter((record) => now - record.at < API_HEADER_TTL_MS).slice(-250);
}

function headerListValue(headers, name) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function rememberApiRequestHeaders(details) {
  if (details.tabId < 0 || !/^https?:/i.test(details.url)) return;

  const record = {
    tabId: details.tabId,
    method: String(details.method || 'GET').toUpperCase(),
    url: details.url,
    requestUrl: details.url,
    origin: headerListValue(details.requestHeaders, 'origin'),
    referer: headerListValue(details.requestHeaders, 'referer'),
    at: Date.now()
  };

  apiHeaderRecords.push(record);
  pruneApiHeaderRecords(record.at);
}

function registerWebRequestHeaderCapture() {
  if (!chrome.webRequest?.onBeforeSendHeaders) return;
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      rememberApiRequestHeaders,
      { urls: ['<all_urls>'] },
      ['requestHeaders', 'extraHeaders']
    );
  } catch {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      rememberApiRequestHeaders,
      { urls: ['<all_urls>'] },
      ['requestHeaders']
    );
  }
}

registerWebRequestHeaderCapture();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}

// Page lifecycle signals can repeat while the user has not performed another action.
const DEDUPE_REASONS = new Set(['navigation', 'url-change']);
const PAGE_TRANSITION_REASONS = new Set(['navigation', 'url-change', 'title-change', 'refresh', 'history-navigation', 'typed-navigation']);
const USER_ACTION_REASONS = new Set([
  'click',
  'selection',
  'link',
  'link-action',
  'modal-click',
  'modal-selection',
  'modal-link',
  'modal-link-action'
]);

function shouldKeepDuplicate(reason, apiRows) {
  return apiRows.length > 0 || !DEDUPE_REASONS.has(reason);
}

function hasPendingUserActionCapture(tabId) {
  return [...pendingUserActionCaptures].some((target) => target.tabId === tabId);
}

// The download bubble overlays the page and would otherwise land in screen captures.
async function setDownloadUi(enabled) {
  if (typeof chrome.downloads?.setUiOptions !== 'function') return false;
  try {
    await chrome.downloads.setUiOptions({ enabled });
    return true;
  } catch (error) {
    console.warn('Could not toggle the download UI:', error.message);
    return false;
  }
}

// MV3 workers may be restarted between captures. Reassert the profile-level setting at the
// actual download boundary so a later PNG cannot reopen Chrome's Downloads bubble.
async function downloadWithHiddenUi(options) {
  await setDownloadUi(false);
  return chrome.downloads.download(options);
}

async function updateBadge(state) {
  const paused = state.recording && state.paused;
  await chrome.action.setBadgeBackgroundColor({ color: paused ? '#f9a825' : state.recording ? '#c62828' : '#455a64' });
  await chrome.action.setBadgeText({ text: paused ? '||' : state.recording ? String(state.sequence) : '' });
}

/* ---------------------------------------------------------------- offscreen */

// Chromium runs the background as a DOM-less service worker and needs an offscreen document for
// canvas work. Firefox runs it as an event page that already has a DOM, so it renders in place.
const HAS_OFFSCREEN = typeof chrome.offscreen !== 'undefined';

function localImageWorker() {
  return { handlers: localImageWorkerHandlers };
}

async function ensureOffscreen() {
  if (!HAS_OFFSCREEN) {
    await localImageWorker();
    return;
  }

  if (!(await chrome.offscreen.hasDocument())) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: 'Stamp screenshots on a canvas and assemble the PDF export.'
      });
    } catch (error) {
      // A concurrent call may have created it already; anything else is fatal.
      if (!(await chrome.offscreen.hasDocument())) throw error;
    }
  }

  // The module script registers its listener asynchronously, so wait for it to answer.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pong = await chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'OFFSCREEN_PING' })
      .catch(() => null);
    if (pong?.ok) return;
    await delay(100);
  }
  throw new Error('The offscreen worker did not start.');
}

async function closeOffscreen() {
  if (!HAS_OFFSCREEN) return;
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function askOffscreen(type, payload = {}) {
  try {
    if (!HAS_OFFSCREEN) {
      const worker = await localImageWorker();
      return await worker.handlers[type]({ type, ...payload });
    }

    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
    return response ?? { error: `No response from offscreen worker for ${type}.` };
  } catch (error) {
    return { error: error.message };
  }
}

/* ------------------------------------------------------------ screen window */

function askScreen(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: 'screen', type, ...payload }).catch((error) => ({ error: error.message }));
}

async function closeScreenWindow() {
  const { screenWindowId } = await getState();
  if (screenWindowId !== null) {
    await askScreen('SCREEN_STOP');
    await chrome.windows.remove(screenWindowId).catch(() => {});
    await setState({ screenWindowId: null });
  }
}

// getDisplayMedia needs a real user click in a real window; a service worker cannot host the picker.
async function openScreenWindow() {
  await closeScreenWindow();

  const win = await chrome.windows.create({
    url: 'capture-window.html',
    type: 'popup',
    width: 520,
    height: 340,
    focused: true
  });
  await setState({ screenWindowId: win.id });

  const result = await new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.windows.onRemoved.removeListener(onRemoved);
      resolve(result);
    };
    const onMessage = (message) => {
      if (message?.type === 'SCREEN_READY' && message.source === 'screen-window') finish({ ok: true });
    };
    const onRemoved = (windowId) => {
      if (windowId === win.id) finish({ error: 'The sharing window was closed before sharing started.' });
    };
    const timer = setTimeout(
      () => finish({ error: 'Timed out waiting for screen sharing to start.' }),
      180000
    );

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.windows.onRemoved.addListener(onRemoved);
  });

  // Minimised so the helper window itself never appears in a full-screen capture.
  if (result.ok) await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
  return result;
}

/* ------------------------------------------------------------------ capture */

const CAPTURE_QUEUE_WATCHDOG_MS = 20000;
const FULL_PAGE_CAPTURE_QUEUE_WATCHDOG_MS = 330000;
const NEW_TAB_LINK_HANDOFF_MS = 800;

// However a single capture fails or hangs, the queue must keep moving - otherwise every capture
// requested after it (including the popup's own manual capture buttons) would wait
// behind a promise that never settles, which looks exactly like the extension has stopped responding.
const QUEUE_WATCHDOG_TOKEN = Symbol('queue-watchdog-timeout');
function captureActionTime(value) {
  const actionAt = Number(value);
  const date = new Date(actionAt);
  return Number.isFinite(actionAt) && actionAt > 0 && !Number.isNaN(date.getTime()) ? actionAt : Date.now();
}

function isLinkCaptureReason(reason) {
  return reason === 'link' || reason === 'modal-link';
}

// External links commonly use rel="noopener", so Chrome can create their tab without an opener ID.
// Retain one recent unlinked tab long enough for its originating content-script message to arrive.
function takeRecentUnlinkedNewTab() {
  pruneRecentNewTabs();
  return recentUnlinkedNewTabs.length === 1 ? recentUnlinkedNewTabs.pop() : null;
}

function pruneRecentNewTabs(now = Date.now()) {
  for (const [sourceTabId, recentTab] of recentNewTabLinkTargets) {
    if (now - recentTab.createdAt > NEW_TAB_LINK_HANDOFF_MS) {
      recentNewTabLinkTargets.delete(sourceTabId);
    }
  }
  for (let index = recentUnlinkedNewTabs.length - 1; index >= 0; index -= 1) {
    if (now - recentUnlinkedNewTabs[index].createdAt > NEW_TAB_LINK_HANDOFF_MS) {
      recentUnlinkedNewTabs.splice(index, 1);
    }
  }
}

function takeRecentNewTabForSource(sourceTabId) {
  const recentTab = recentNewTabLinkTargets.get(sourceTabId);
  recentNewTabLinkTargets.delete(sourceTabId);
  if (recentTab && Date.now() - recentTab.createdAt <= NEW_TAB_LINK_HANDOFF_MS) return recentTab;
  return takeRecentUnlinkedNewTab();
}

function prepareNewTabLinkTarget(target, reason) {
  if (!isLinkCaptureReason(reason) || !target?.opensNewTab || !Number.isSafeInteger(target.tabId)) return;
  let completeHandoff;
  target.sourceTabId = target.tabId;
  target.newTabHandoff = new Promise((resolve) => {
    completeHandoff = resolve;
  });
  target.completeNewTabHandoff = completeHandoff;
  target.newTabHandoffStartedAt = Date.now();
  pendingNewTabLinkTargets.set(target.sourceTabId, target);

  const recentTab = takeRecentNewTabForSource(target.sourceTabId);
  if (recentTab) {
    pendingNewTabLinkTargets.delete(target.sourceTabId);
    target.tabId = recentTab.tab.id;
    target.windowId = recentTab.tab.windowId;
    if (recentTab.needsTracking) target.preexistingNewTab = recentTab.tab;
    completeNewTabLinkHandoff(target);
  }
}

function completeNewTabLinkHandoff(target) {
  if (typeof target?.completeNewTabHandoff === 'function') {
    const completeHandoff = target.completeNewTabHandoff;
    target.completeNewTabHandoff = null;
    completeHandoff();
  }
}

function clearNewTabLinkTarget(target) {
  if (!target) return;
  if (pendingNewTabLinkTargets.get(target.sourceTabId) === target) {
    pendingNewTabLinkTargets.delete(target.sourceTabId);
  }
  completeNewTabLinkHandoff(target);
}

function claimNewTabLinkTarget(tab) {
  pruneRecentNewTabs();
  const hasOpener = Number.isSafeInteger(tab.openerTabId);
  let target = hasOpener ? pendingNewTabLinkTargets.get(tab.openerTabId) : null;
  if (!target && !hasOpener) {
    const pendingTargets = [...pendingNewTabLinkTargets.values()].filter(
      (candidate) => Date.now() - candidate.newTabHandoffStartedAt <= NEW_TAB_LINK_HANDOFF_MS
    );
    target = pendingTargets.length === 1 ? pendingTargets[0] : null;
  }
  if (!target) {
    if (hasOpener) {
      recentNewTabLinkTargets.set(tab.openerTabId, { tab, createdAt: Date.now() });
    } else {
      recentUnlinkedNewTabs.push({ tab, createdAt: Date.now(), needsTracking: true });
    }
    return null;
  }
  if (Date.now() - target.newTabHandoffStartedAt > NEW_TAB_LINK_HANDOFF_MS) {
    clearNewTabLinkTarget(target);
    return null;
  }
  pendingNewTabLinkTargets.delete(target.sourceTabId);
  recentNewTabLinkTargets.delete(target.sourceTabId);
  target.tabId = tab.id;
  target.windowId = tab.windowId;
  return target;
}

async function waitForNewTabLinkTarget(target) {
  if (!target?.newTabHandoff) return;
  await Promise.race([target.newTabHandoff, delay(NEW_TAB_LINK_HANDOFF_MS)]);
  clearNewTabLinkTarget(target);
}

function clearNewTabLinkTargets() {
  for (const target of pendingNewTabLinkTargets.values()) clearNewTabLinkTarget(target);
  recentNewTabLinkTargets.clear();
  recentUnlinkedNewTabs.length = 0;
}

function createCaptureRequest(reason, label, state, modal, target, actionAt, requestSequence) {
  const captureTarget = target || {};
  if (!Number.isSafeInteger(captureTarget.tabId)) captureTarget.tabId = state.tabId;
  if (!Number.isSafeInteger(captureTarget.windowId)) captureTarget.windowId = state.windowId;
  return {
    reason,
    label,
    modal,
    actionAt,
    requestSequence,
    sessionId: state.sessionId,
    captureGeneration: state.captureGeneration,
    target: captureTarget,
    settings: { ...state.settings },
    streamActive: Boolean(state.streamActive),
    expectedUrl: typeof captureTarget.expectedUrl === 'string' ? captureTarget.expectedUrl : '',
    expectedTitle: typeof captureTarget.expectedTitle === 'string' ? captureTarget.expectedTitle : ''
  };
}

function captureNow(reason, label, requestedState, modal, target) {
  const captureTarget = target ? { ...target } : {};
  prepareNewTabLinkTarget(captureTarget, reason);
  const ownsResultingNavigation = USER_ACTION_REASONS.has(reason);
  if (ownsResultingNavigation) pendingUserActionCaptures.add(captureTarget);
  const actionAt = captureActionTime(captureTarget.actionAt);
  const requestSequence = ++captureRequestSequence;
  const captureState = requestedState
    ? Promise.resolve(requestedState)
    : recoverRecordingSession(captureTarget.tabId);
  const bufferedScreenFrame = captureTarget.bufferedScreenFrameId
    ? Promise.resolve({ frameId: captureTarget.bufferedScreenFrameId })
    : captureState.then((state) => {
      if (
        state.settings.captureMode !== 'screen' ||
        !state.streamActive ||
        PAGE_TRANSITION_REASONS.has(reason)
      ) return null;
      return askScreen('SCREEN_BUFFER_CAPTURE');
    });
  pendingCaptureCount += 1;

  // Add the task to the queue before any asynchronous state recovery. This preserves the order in
  // which page actions arrive, rather than the order in which storage reads happen to complete.
  captureChain = captureChain
    .then(async () => {
      const state = await captureState;
      if (!state.recording || state.paused) return state;
      const bufferedFrame = await bufferedScreenFrame;
      if (captureTarget.preexistingNewTab) {
        const tab = await chrome.tabs.get(captureTarget.tabId).catch(() => captureTarget.preexistingNewTab);
        await trackAndFocusNewTab(state, tab);
      }
      const captureRequest = createCaptureRequest(
        reason,
        label,
        state,
        modal,
        captureTarget,
        actionAt,
        requestSequence
      );
      captureRequest.bufferedScreenFrameId = bufferedFrame?.frameId || null;
      const longCaptureLikely = captureRequest.settings.fullPage && FULL_PAGE_REASONS.has(reason);
      const captureWatchdogMs =
        longCaptureLikely
          ? FULL_PAGE_CAPTURE_QUEUE_WATCHDOG_MS
          : CAPTURE_QUEUE_WATCHDOG_MS;
      let watchdogTimer;
      try {
        const result = await Promise.race([
          performCapture(captureRequest),
          new Promise((resolve) => {
            watchdogTimer = setTimeout(() => resolve(QUEUE_WATCHDOG_TOKEN), captureWatchdogMs);
          })
        ]);
        if (result === QUEUE_WATCHDOG_TOKEN) {
          logLine(
            `QUEUE_WATCHDOG ${reason}${label ? ` "${label}"` : ''} exceeded ${captureWatchdogMs}ms, moving on`
          );
          await clearFullPageProgress(captureRequest.target.tabId);
        }
      } finally {
        clearTimeout(watchdogTimer);
      }
    })
    .catch(async (error) => {
      if (isTabAccessDenied(error)) {
        logLine(`CAPTURE_SKIPPED ${reason}${label ? ` "${label}"` : ''}: ${error.message}`);
        await flushLog();
        const state = await getState();
        await clearFullPageProgress(captureTarget.tabId ?? state.tabId);
        if (state.recording) {
          await setState({
            lastError: 'Capture skipped: JShotz needs access to the current page. Open the JShotz popup on that page, then continue recording.'
          });
        }
        return;
      }
      if (needsFolderReconnect(error)) {
        logLine(`FOLDER_ACCESS_NEEDED ${reason}${label ? ` "${label}"` : ''}: ${error.message}`);
        await flushLog();
        const state = await getState();
        await clearFullPageProgress(captureTarget.tabId ?? state.tabId);
        if (state.recording) {
          await setState({ folderAccessNeeded: true, lastError: error.message });
        }
        return;
      }
      logLine(`ERROR ${reason}${label ? ` "${label}"` : ''}: ${error.message}`);
      await flushLog();
      console.error('Capture failed:', error);
      const state = await getState();
      await clearFullPageProgress(captureTarget.tabId ?? state.tabId);
      await setState({
        folderAccessNeeded: needsFolderReconnect(error),
        lastError: `Capture failed: ${error.message}`
      });
    })
    .finally(() => {
      if (ownsResultingNavigation) pendingUserActionCaptures.delete(captureTarget);
      pendingCaptureCount = Math.max(0, pendingCaptureCount - 1);
      if (captureTarget.bufferedScreenFrameId) {
        askScreen('SCREEN_FRAME_PROCESSED', { frameId: captureTarget.bufferedScreenFrameId });
      }
    });
  return captureChain;
}

function captureDevToolsAfterPopupCloses(state) {
  delay(DEVTOOLS_POPUP_CLOSE_GRACE_MS).then(() =>
    captureNow('devtools-panel', undefined, state, undefined, {
      tabId: state.tabId,
      windowId: state.windowId,
      actionAt: Date.now()
    })
  );
}

// "Failed to capture tab: image readback failed" is a transient compositor/GPU error - the frame
// simply was not readable at that instant (mid-paint, tab backgrounded, GPU process recycling).
// A short retry recovers it; without one, an otherwise valid screenshot is lost.
const CAPTURE_RETRY_DELAYS_MS = [150, 400, 900];

function isTabAccessDenied(error) {
  const message = String(error?.message || error || '');
  return (
    /activeTab['"]?\s+permission is not in effect/i.test(message) ||
    /must request permission to access this host/i.test(message) ||
    /cannot access contents of url/i.test(message)
  );
}

async function captureVisibleTabWithRetry(windowId) {
  let lastError = null;
  for (let attempt = 0; attempt <= CAPTURE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (error) {
      lastError = error;
      // Retrying cannot restore a revoked activeTab grant or a denied host permission.
      if (isTabAccessDenied(error)) break;
      const wait = CAPTURE_RETRY_DELAYS_MS[attempt];
      if (wait === undefined) break;
      await delay(wait);
    }
  }
  throw lastError;
}

async function grabPngDataUrl(captureRequest, tab) {
  if (captureRequest.bufferedScreenFrameId) {
    const buffered = await askScreen('SCREEN_TAKE_BUFFERED', {
      frameId: captureRequest.bufferedScreenFrameId
    });
    if (buffered?.dataUrl) return buffered.dataUrl;
    console.warn('Buffered screen frame unavailable, using the live capture:', buffered?.error);
  }
  if (captureRequest.settings.captureMode === 'screen' && captureRequest.streamActive) {
    const result = await askScreen('SCREEN_CAPTURE');
    if (result?.dataUrl) return result.dataUrl;
    console.warn('Screen capture unavailable, falling back to tab capture:', result?.error);
    await markScreenUnavailable(
      `Screen sharing stopped (${result?.error || 'the shared frame is unavailable'}). Select a screen or window again to resume DevTools capture.`
    );
  }
  return captureVisibleTabWithRetry(tab.windowId);
}

async function markScreenUnavailable(message) {
  const state = await getState();
  if (!state.recording || state.settings.captureMode !== 'screen') return state;
  const next = await setState({ streamActive: false, lastError: message });
  if (Number.isSafeInteger(state.screenWindowId)) {
    await chrome.windows.update(state.screenWindowId, { state: 'normal', focused: true }).catch(() => {});
  }
  return next;
}

async function grabSettledTransitionFrame(captureRequest, tab, firstDataUrl) {
  if (!PAGE_TRANSITION_REASONS.has(captureRequest.reason)) return firstDataUrl;
  await ensureOffscreen();
  const firstScore = await askOffscreen('OFFSCREEN_SCORE_CAPTURE', { dataUrl: firstDataUrl });
  await delay(800);
  if (!(await isCaptureRequestActive(captureRequest))) return firstDataUrl;
  const secondDataUrl = await grabPngDataUrl(captureRequest, tab);
  const secondScore = await askOffscreen('OFFSCREEN_SCORE_CAPTURE', { dataUrl: secondDataUrl });
  const firstRatio = Number(firstScore?.paintedRatio) || 0;
  const secondRatio = Number(secondScore?.paintedRatio) || 0;
  if (secondRatio + 0.01 < firstRatio * 0.7) {
    logLine(`TRANSITION_FRAME_RETAINED_FIRST reason=${captureRequest.reason} first=${firstRatio.toFixed(3)} second=${secondRatio.toFixed(3)}`);
    return firstDataUrl;
  }
  return secondDataUrl;
}

// Navigation and title events often arrive before a client-rendered application has painted its
// real content. Wait for a bounded period of page activity to go quiet before recording them.
const RENDER_SETTLE_REASONS = new Set([
  'start',
  'link',
  'modal-link',
  'navigation',
  'url-change',
  'title-change',
  'refresh',
  'history-navigation',
  'typed-navigation'
]);
const RENDER_SETTLE_MIN_WAIT_MS = 900;
const RENDER_SETTLE_TITLE_MIN_WAIT_MS = 1800;
const RENDER_SETTLE_QUIET_MS = 700;
const RENDER_SETTLE_MAX_WAIT_MS = 9000;
const RENDER_SETTLE_TITLE_MAX_WAIT_MS = 12000;
const RENDER_SETTLE_POLL_MS = 120;

function renderSettleOptions(reason) {
  if (!RENDER_SETTLE_REASONS.has(reason)) return null;
  const titleChange = reason === 'title-change';
  return {
    reason,
    minWaitMs: titleChange ? RENDER_SETTLE_TITLE_MIN_WAIT_MS : RENDER_SETTLE_MIN_WAIT_MS,
    quietMs: RENDER_SETTLE_QUIET_MS,
    maxWaitMs: titleChange ? RENDER_SETTLE_TITLE_MAX_WAIT_MS : RENDER_SETTLE_MAX_WAIT_MS,
    pollMs: RENDER_SETTLE_POLL_MS
  };
}

async function waitForRenderedPage(tabId, reason) {
  const options = renderSettleOptions(reason);
  if (!options) return null;

  const [injected] = await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [options],
      func: async ({ minWaitMs, quietMs, maxWaitMs, pollMs }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const startedAt = performance.now();
        let lastActivityAt = startedAt;
        let previousSignature = '';
        let previousResourceCount = performance.getEntriesByType('resource').length;
        let fontsReady = !document.fonts?.ready;
        const noteActivity = () => {
          lastActivityAt = performance.now();
        };
        const mutationObserver = new MutationObserver(noteActivity);
        mutationObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });

        let resourceObserver = null;
        try {
          if (typeof PerformanceObserver === 'function') {
            resourceObserver = new PerformanceObserver(noteActivity);
            resourceObserver.observe({ type: 'resource', buffered: false });
          }
        } catch {
          resourceObserver = null;
        }
        if (!fontsReady) {
          Promise.resolve(document.fonts.ready)
            .catch(() => {})
            .then(() => {
              fontsReady = true;
              noteActivity();
            });
        }

        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const hasBusyIndicator = () => {
          const selectors = [
            '[aria-busy="true"]',
            '[role="progressbar"]',
            '[class*="spinner" i]',
            '[class*="loading" i]',
            '[class*="loader" i]'
          ].join(',');
          return [...document.querySelectorAll(selectors)].some(isVisible);
        };
        const signature = () => {
          const root = document.documentElement;
          const body = document.body;
          const images = [...document.images];
          const incompleteImages = images.filter((image) => !image.complete).length;
          return {
            value: [
              document.readyState,
              root.scrollWidth,
              root.scrollHeight,
              root.clientWidth,
              root.clientHeight,
              body?.childElementCount || 0,
              body?.textContent?.length || 0,
              images.length,
              incompleteImages,
              hasBusyIndicator() ? 1 : 0
            ].join('|'),
            incompleteImages,
            busy: hasBusyIndicator()
          };
        };

        let current = signature();
        try {
          while (performance.now() - startedAt < maxWaitMs) {
            const resourceCount = performance.getEntriesByType('resource').length;
            if (resourceCount !== previousResourceCount) {
              previousResourceCount = resourceCount;
              noteActivity();
            }
            current = signature();
            if (previousSignature && current.value !== previousSignature) noteActivity();
            previousSignature = current.value;

            const elapsedMs = performance.now() - startedAt;
            const ready = document.readyState !== 'loading' && fontsReady && !current.incompleteImages && !current.busy;
            if (ready && elapsedMs >= minWaitMs && performance.now() - lastActivityAt >= quietMs) {
              return { settled: true, waitedMs: Math.round(elapsedMs) };
            }
            await sleep(pollMs);
          }
          return {
            settled: false,
            waitedMs: Math.round(performance.now() - startedAt),
            readyState: document.readyState,
            incompleteImages: current.incompleteImages,
            busy: current.busy
          };
        } finally {
          mutationObserver.disconnect();
          resourceObserver?.disconnect();
        }
      }
    })
    .catch(() => [null]);
  const result = injected?.result || null;
  if (result && !result.settled) {
    logLine(
      `RENDER_SETTLE_TIMEOUT ${reason} waited=${result.waitedMs}ms ready=${result.readyState || 'unknown'} ` +
        `images=${result.incompleteImages ?? 'unknown'} busy=${Boolean(result.busy)}`
    );
  }
  return result;
}

/* ----------------------------------------------------------- full page */

const HAS_DEBUGGER = typeof chrome.debugger !== 'undefined';
const FULL_PAGE_WATCHDOG_MS = 75000;
const FULL_PAGE_SCROLLER_WATCHDOG_MAX_MS = 300000;
const FULL_PAGE_SCROLLER_FRAME_ESTIMATE_MS = 1200;
const FULL_PAGE_SCROLLER_WATCHDOG_OVERHEAD_MS = 30000;
const SCROLLER_FRAME_OVERLAP = 150;
const FULL_PAGE_IMAGE_POLLS = 6;
const FULL_PAGE_IMAGE_POLL_MS = 250;
const FULL_PAGE_LAYOUT_ATTEMPTS = 2;
const FULL_PAGE_LAYOUT_POLL_MS = 250;
const FULL_PAGE_LAYOUT_STABLE_POLLS = 2;
const FULL_PAGE_SINGLE_IMAGE_MAX_PIXELS = 10000000;
const FULL_PAGE_RASTER_MAX_PIXELS = 24000000;
const FULL_PAGE_RASTER_MAX_DIMENSION = 30000;
const FULL_PAGE_PART_MAX_PIXELS = 8000000;
const FULL_PAGE_PART_MAX_DIMENSION = 8192;
const FULL_PAGE_BASE_TILE_HEIGHT = 3000;
const FULL_PAGE_PREFERRED_MAX_PARTS = 8;
const FULL_PAGE_MAX_READABLE_PART_ASPECT_RATIO = 1.15;
const FULL_PAGE_MAX_READABLE_PARTS = 24;
const FULL_PAGE_TILE_JPEG_QUALITY = 94;
const SCROLLER_SETTLE_MAX_MS = 600;
// Full-document work is deliberately limited to manual capture actions.
const FULL_PAGE_REASONS = new Set(['manual-hotkey', 'manual']);
let debuggerTabId = null;

async function canCaptureDevTools(state) {
  return Boolean(
    state.settings?.captureMode === 'screen' &&
      state.streamActive
  );
}

async function withDevToolsStatus(state) {
  return { ...state, devToolsOpen: await canCaptureDevTools(state) };
}

if (HAS_DEBUGGER) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === debuggerTabId) debuggerTabId = null;
  });
}

async function attachDebugger(tabId) {
  if (debuggerTabId === tabId) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerTabId = tabId;
    return true;
  } catch (error) {
    // Already-attached DevTools owns the session and there is no way to share it.
    console.warn('Background capture unavailable, using the visible frame:', error.message);
    debuggerTabId = null;
    return false;
  }
}

async function detachDebugger() {
  if (debuggerTabId === null) return;
  const tabId = debuggerTabId;
  debuggerTabId = null;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

function pageMetadataText(value, maxLength = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function samePageUrl(left, right) {
  if (!left || !right) return true;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function matchesExpectedPage(captureRequest, page) {
  return (
    (!captureRequest.expectedUrl || samePageUrl(captureRequest.expectedUrl, page.url)) &&
    (!captureRequest.expectedTitle || !page.documentTitle || captureRequest.expectedTitle === page.documentTitle)
  );
}

// Read title, URL, and the visible heading together. The heading is more useful than a generic
// site-wide browser title, while returning all three from one page execution keeps them coherent.
async function getPageContext(tabId, fallbackTab) {
  const [injected] = await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };

        // A dialog's own heading describes the current step better than the page behind it.
        const dialog = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
          .filter(visible)
          .pop();
        const scope = dialog || document;

        for (const selector of ['h1', '[role="heading"][aria-level="1"]', 'h2']) {
          for (const el of scope.querySelectorAll(selector)) {
            if (!visible(el)) continue;
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            if (text) {
              return {
                heading: text.slice(0, 120),
                title: document.title || '',
                url: location.href || ''
              };
            }
          }
        }
        return { heading: '', title: document.title || '', url: location.href || '' };
      }
    })
    .catch(() => [null]);
  const result = injected?.result && typeof injected.result === 'object' ? injected.result : {};
  const url = String(result.url || fallbackTab?.url || '');
  const documentTitle = pageMetadataText(result.title || fallbackTab?.title || '');
  const heading = pageMetadataText(result.heading);
  return {
    title: heading || documentTitle || url || 'Untitled page',
    url,
    documentTitle
  };
}

async function isVisibleCaptureTarget(tab) {
  const activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
  return !activeTabs.length || activeTabs.some((activeTab) => activeTab.id === tab.id);
}

// Plain document height only: does not look at inner scroll panes, so it never suggests forcing the
// viewport taller for a page whose real height lives inside a scrollable child instead.
async function measureDocument(tabId) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      const de = document.documentElement;
      const b = document.body;
      const docHeight = Math.max(de.scrollHeight, de.offsetHeight, b?.scrollHeight || 0, b?.offsetHeight || 0);
      const docWidth = Math.max(de.scrollWidth, de.offsetWidth, b?.scrollWidth || 0, b?.offsetWidth || 0, innerWidth);
      const meaningfulTags = /^(A|BUTTON|CANVAS|EMBED|HR|IFRAME|IMG|INPUT|OBJECT|PICTURE|SELECT|SVG|TABLE|TEXTAREA|VIDEO)$/;
      let meaningfulBottom = 0;
      const visibleBoxes = [];
      for (const el of b?.querySelectorAll('*') || []) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const top = rect.top + scrollY;
        const bottom = Math.min(docHeight, rect.bottom + scrollY);
        if (bottom <= 0 || top >= docHeight) continue;
        visibleBoxes.push({ top, bottom });
        const directText = [...el.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
        );
        const lazyMedia = el.hasAttribute('data-src') || el.hasAttribute('data-lazy-src');
        const painted =
          meaningfulTags.test(el.tagName) ||
          directText ||
          lazyMedia ||
          style.backgroundImage !== 'none' ||
          el.matches('footer,[role="contentinfo"]');
        if (painted && style.position !== 'fixed') meaningfulBottom = Math.max(meaningfulBottom, bottom);
      }

      // Preserve modest padding/background space around the final content, but do not let a giant
      // empty app wrapper extend the screenshot by several viewports.
      const paddingLimit = Math.min(320, Math.max(32, innerHeight / 3));
      for (const box of visibleBoxes) {
        if (box.top <= meaningfulBottom + 4 && box.bottom <= meaningfulBottom + paddingLimit) {
          meaningfulBottom = Math.max(meaningfulBottom, box.bottom);
        }
      }
      const contentHeight = meaningfulBottom > 0
        ? Math.min(docHeight, Math.max(innerHeight, Math.ceil(meaningfulBottom)))
        : docHeight;
      return {
        width: Math.ceil(docWidth),
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        docHeight: Math.ceil(docHeight),
        contentHeight
      };
    }
  });
  return injected?.result || null;
}

const SCROLLER_MARK_ATTR = 'data-jshotz-scroll-root';
const SCROLLER_EXPANDED_ATTR = 'data-jshotz-expanded-scroll-root';
const SCROLLER_ANCESTOR_ATTR = 'data-jshotz-expanded-scroll-ancestor';
const SCROLLER_EXPANSION_STYLE_ID = 'jshotz-expanded-scroll-style';

// App-shell layouts keep the document at viewport height and scroll a large child pane instead; find
// the biggest such pane so its own content can be scrolled and stitched without moving anything else.
async function findScroller(tabId) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [SCROLLER_MARK_ATTR],
    func: (markAttr) => {
      let best = null;
      for (const el of document.querySelectorAll('body *')) {
        if (el.scrollHeight <= el.clientHeight + 4) continue;
        if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
        const rect = el.getBoundingClientRect();
        if (el.clientHeight < innerHeight * 0.3 || rect.width < innerWidth * 0.4) continue;
        if (!best || el.clientHeight * rect.width > best.el.clientHeight * best.rect.width) {
          best = { el, rect };
        }
      }
      if (!best) return null;
      document.querySelectorAll(`[${markAttr}]`).forEach((el) => el.removeAttribute(markAttr));
      best.el.setAttribute(markAttr, '1');
      return {
        rectTop: Math.round(best.rect.top),
        rectLeft: Math.round(best.rect.left),
        rectWidth: Math.round(best.rect.width),
        rectHeight: best.el.clientHeight,
        scrollHeight: best.el.scrollHeight,
        clientHeight: best.el.clientHeight,
        scrollTop: best.el.scrollTop,
        dpr: window.devicePixelRatio || 1,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth
      };
    }
  });
  return injected?.result || null;
}

async function clearScrollerMark(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [SCROLLER_MARK_ATTR],
      func: (markAttr) => document.querySelectorAll(`[${markAttr}]`).forEach((el) => el.removeAttribute(markAttr))
    })
    .catch(() => {});
}

async function expandScrollerForHeadless(tabId, scrollHeight) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [SCROLLER_MARK_ATTR, SCROLLER_EXPANDED_ATTR, SCROLLER_ANCESTOR_ATTR, SCROLLER_EXPANSION_STYLE_ID, scrollHeight],
    func: async (markAttr, expandedAttr, ancestorAttr, styleId, targetHeight) => {
      const target = document.querySelector(`[${markAttr}]`);
      if (!target) return false;
      document.getElementById(styleId)?.remove();
      document.querySelectorAll(`[${expandedAttr}],[${ancestorAttr}]`).forEach((el) => {
        el.removeAttribute(expandedAttr);
        el.removeAttribute(ancestorAttr);
      });
      target.setAttribute(expandedAttr, '1');
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        ancestor.setAttribute(ancestorAttr, '1');
      }
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent =
        `[${expandedAttr}]{height:${Math.ceil(targetHeight)}px!important;max-height:none!important;overflow:visible!important;}` +
        `[${ancestorAttr}]{height:auto!important;max-height:none!important;overflow:visible!important;}`;
      document.documentElement.append(style);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    }
  });
  return injected?.result === true;
}

async function restoreExpandedScroller(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [SCROLLER_EXPANDED_ATTR, SCROLLER_ANCESTOR_ATTR, SCROLLER_EXPANSION_STYLE_ID],
      func: (expandedAttr, ancestorAttr, styleId) => {
        document.getElementById(styleId)?.remove();
        document.querySelectorAll(`[${expandedAttr}],[${ancestorAttr}]`).forEach((el) => {
          el.removeAttribute(expandedAttr);
          el.removeAttribute(ancestorAttr);
        });
      }
    })
    .catch(() => {});
  await clearScrollerMark(tabId);
}

const SCROLLBAR_STYLE_ID = 'jshotz-hide-scrollbars';

// The pane's own scrollbar sits at the same on-screen spot in every captured frame, so stacking
// several of them would repeat its track/thumb down the page the same way a fixed sidebar would.
async function hideScrollbars(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [SCROLLBAR_STYLE_ID],
      func: (styleId) => {
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent =
          '* { scrollbar-color: transparent transparent !important; }' +
          '*::-webkit-scrollbar { background: transparent !important; }' +
          '*::-webkit-scrollbar-thumb { background: transparent !important; border-color: transparent !important; }' +
          '*::-webkit-scrollbar-corner { background: transparent !important; }';
        document.documentElement.appendChild(style);
      }
    })
    .catch(() => {});
}

async function restoreScrollbars(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [SCROLLBAR_STYLE_ID],
      func: (styleId) => document.getElementById(styleId)?.remove()
    })
    .catch(() => {});
}

// Scrolls only the marked pane (never the window), and waits for it to actually settle there -
// smooth-scroll CSS can otherwise leave the read-back scrollTop stale for a few frames. Uses a wall
// clock deadline rather than counting animation frames, since rAF can be throttled to roughly once a
// second for a tab that is not the focused window, which would otherwise stall the whole capture.
async function scrollScrollerTo(tabId, markAttr, top) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [markAttr, top, SCROLLER_SETTLE_MAX_MS],
    func: async (attr, targetTop, maxWaitMs) => {
      const el = document.querySelector(`[${attr}]`);
      if (!el) return { ok: false, scrollTop: 0 };
      const previousBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTo({ top: targetTop, behavior: 'instant' });

      const deadline = Date.now() + maxWaitMs;
      while (Math.abs(el.scrollTop - targetTop) >= 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      el.style.scrollBehavior = previousBehavior;
      return { ok: true, scrollTop: el.scrollTop };
    }
  });
  return injected?.result || { ok: false, scrollTop: top };
}

// Let images already loading settle before rasterizing or stitching the document.
async function waitForImages(tabId) {
  for (let poll = 0; poll < FULL_PAGE_IMAGE_POLLS; poll += 1) {
    const [injected] = await chrome.scripting
      .executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: () => [...document.images].every((img) => !img.loading || img.complete)
      })
      .catch(() => [null]);
    if (injected?.result !== false) return;
    await delay(FULL_PAGE_IMAGE_POLL_MS);
  }
}

const BLANK_MARGIN_TOLERANCE = 10;
const BLANK_MARGIN_ROW_MATCH_RATIO = 0.97;
const BLANK_MARGIN_COLUMN_MATCH_RATIO = 0.995;
const BLANK_MARGIN_SCAN_CHUNK_ROWS = 256;
const BLANK_MARGIN_SCAN_CHUNK_COLUMNS = 64;
const BLANK_MARGIN_MIN_PADDING = 16;
const BLANK_MARGIN_MAX_PADDING = 48;
const BLANK_MARGIN_MIN_CONTENT_SIZE = 32;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function findPaintedBounds(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  if (!width || !height) return null;

  const rowSampleStep = Math.max(1, Math.floor(width / 300));
  const samplesPerRow = Math.ceil(width / rowSampleStep);
  const referenceSamples = ctx.getImageData(0, Math.max(0, height - Math.min(8, height)), width, Math.min(8, height)).data;
  const colorCounts = new Map();
  for (let i = 0; i < referenceSamples.length; i += rowSampleStep * 4) {
    const key = `${referenceSamples[i] >> 3},${referenceSamples[i + 1] >> 3},${referenceSamples[i + 2] >> 3}`;
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
  }
  const dominantLightColor = [...colorCounts.entries()]
    .filter(([key]) => key.split(',').every((value) => Number(value) >= 27))
    .sort((left, right) => right[1] - left[1])[0]?.[0];
  const reference = dominantLightColor
    ? dominantLightColor.split(',').map((value) => Number(value) << 3)
    : ctx.getImageData(width - 1, height - 1, 1, 1).data;
  const matchesReference = (data, i) =>
    Math.abs(data[i] - reference[0]) <= BLANK_MARGIN_TOLERANCE &&
    Math.abs(data[i + 1] - reference[1]) <= BLANK_MARGIN_TOLERANCE &&
    Math.abs(data[i + 2] - reference[2]) <= BLANK_MARGIN_TOLERANCE;

  let contentEnd = height;
  for (let bottom = height; bottom > 0; bottom -= BLANK_MARGIN_SCAN_CHUNK_ROWS) {
    const top = Math.max(0, bottom - BLANK_MARGIN_SCAN_CHUNK_ROWS);
    const { data } = ctx.getImageData(0, top, width, bottom - top);
    let stop = false;
    for (let row = bottom - top - 1; row >= 0; row -= 1) {
      const rowStart = row * width * 4;
      let mismatches = 0;
      for (let x = 0; x < width; x += rowSampleStep) {
        const i = rowStart + x * 4;
        if (!matchesReference(data, i)) mismatches += 1;
      }
      if (mismatches > samplesPerRow * (1 - BLANK_MARGIN_ROW_MATCH_RATIO)) {
        contentEnd = top + row + 1;
        stop = true;
        break;
      }
    }
    if (stop) break;
    contentEnd = top;
  }

  const scanHeight = Math.max(0, contentEnd);
  const columnSampleStep = Math.max(1, Math.floor(scanHeight / 600));
  const samplesPerColumn = Math.ceil(scanHeight / columnSampleStep);
  let contentRight = width;
  for (let right = width; right > 0 && scanHeight; right -= BLANK_MARGIN_SCAN_CHUNK_COLUMNS) {
    const left = Math.max(0, right - BLANK_MARGIN_SCAN_CHUNK_COLUMNS);
    const blockWidth = right - left;
    const { data } = ctx.getImageData(left, 0, blockWidth, scanHeight);
    let stop = false;
    for (let column = blockWidth - 1; column >= 0; column -= 1) {
      let mismatches = 0;
      for (let y = 0; y < scanHeight; y += columnSampleStep) {
        const i = (y * blockWidth + column) * 4;
        if (!matchesReference(data, i)) mismatches += 1;
      }
      if (mismatches > samplesPerColumn * (1 - BLANK_MARGIN_COLUMN_MATCH_RATIO)) {
        contentRight = left + column + 1;
        stop = true;
        break;
      }
      contentRight = left + column;
    }
    if (stop) break;
  }

  return { contentEnd, contentRight };
}

function cropBlankMargins(canvas) {
  const bounds = findPaintedBounds(canvas);
  if (!bounds) return null;
  const { width, height } = canvas;
  const { contentEnd, contentRight } = bounds;
  if (contentEnd < BLANK_MARGIN_MIN_CONTENT_SIZE || contentRight < BLANK_MARGIN_MIN_CONTENT_SIZE) return null;
  const padding = Math.max(
    BLANK_MARGIN_MIN_PADDING,
    Math.min(BLANK_MARGIN_MAX_PADDING, Math.round(Math.min(width, height) / 50))
  );
  const cropWidth = Math.min(width, contentRight + padding);
  const cropHeight = Math.min(height, contentEnd + padding);
  if (cropWidth === width && cropHeight === height) return null;

  const cropped = new OffscreenCanvas(cropWidth, cropHeight);
  cropped.getContext('2d').drawImage(canvas, 0, 0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return cropped;
}

async function inspectFullPagePart(dataUrl, trimBottom = false) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return { blank: false, dataUrl };
  }
  let bitmap;
  let canvas;
  let cropped;
  try {
    bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
    const bounds = findPaintedBounds(canvas);
    if (!bounds || bounds.contentEnd < BLANK_MARGIN_MIN_CONTENT_SIZE || bounds.contentRight < BLANK_MARGIN_MIN_CONTENT_SIZE) {
      return { blank: true, dataUrl };
    }
    if (!trimBottom || bounds.contentEnd >= canvas.height) return { blank: false, dataUrl };
    const padding = Math.max(
      BLANK_MARGIN_MIN_PADDING,
      Math.min(BLANK_MARGIN_MAX_PADDING, Math.round(Math.min(canvas.width, canvas.height) / 50))
    );
    const cropHeight = Math.min(canvas.height, bounds.contentEnd + padding);
    if (cropHeight >= canvas.height) return { blank: false, dataUrl };
    cropped = new OffscreenCanvas(canvas.width, cropHeight);
    cropped.getContext('2d').drawImage(canvas, 0, 0, canvas.width, cropHeight, 0, 0, canvas.width, cropHeight);
    return { blank: false, dataUrl: await canvasToDataUrl(cropped, 'image/jpeg', FULL_PAGE_TILE_JPEG_QUALITY / 100) };
  } catch (error) {
    console.warn('Could not inspect full-page part, keeping it:', error.message);
    return { blank: false, dataUrl };
  } finally {
    bitmap?.close();
    if (cropped) {
      cropped.width = 1;
      cropped.height = 1;
    }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

async function removeTrailingBlankFullPageParts(parts) {
  if (parts.length <= 1) return parts;
  let lastRetainedIndex = parts.length - 1;
  while (lastRetainedIndex > 0) {
    const inspected = await inspectFullPagePart(parts[lastRetainedIndex].rawDataUrl);
    if (!inspected.blank) break;
    parts[lastRetainedIndex].rawDataUrl = null;
    lastRetainedIndex -= 1;
  }
  const retained = parts.slice(0, lastRetainedIndex + 1);
  const finalPart = retained.at(-1);
  const inspectedFinalPart = await inspectFullPagePart(finalPart.rawDataUrl, true);
  if (!inspectedFinalPart.blank) finalPart.rawDataUrl = inspectedFinalPart.dataUrl;
  return retained;
}

async function canvasToDataUrl(canvas, type = 'image/png', quality) {
  const buffer = await (await canvas.convertToBlob({ type, quality })).arrayBuffer();
  return `data:${type};base64,${arrayBufferToBase64(buffer)}`;
}

async function trimBlankMargins(dataUrl) {
  let bitmap;
  let canvas;
  let cropped;
  try {
    bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
    cropped = cropBlankMargins(canvas);
    return cropped ? await canvasToDataUrl(cropped) : dataUrl;
  } catch (error) {
    console.warn('Could not trim blank space, using the capture as-is:', error.message);
    return dataUrl;
  } finally {
    bitmap?.close();
    if (cropped) {
      cropped.width = 1;
      cropped.height = 1;
    }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

function documentTiles(height, tileHeight) {
  const tiles = [];
  for (let top = 0; top < height; top += tileHeight) {
    tiles.push({ top, height: Math.min(tileHeight, height - top) });
  }
  return tiles;
}

function maximumDocumentPartScale(width, height, dpr) {
  const rasterWidth = Math.max(1, width * dpr);
  const rasterHeight = Math.max(1, height * dpr);
  return Math.min(
    1,
    FULL_PAGE_PART_MAX_DIMENSION / rasterWidth,
    FULL_PAGE_PART_MAX_DIMENSION / rasterHeight,
    Math.sqrt(FULL_PAGE_PART_MAX_PIXELS / (rasterWidth * rasterHeight))
  );
}

function readableDocumentPartCount(width, height) {
  const readableHeight = Math.max(1, Math.ceil(width * FULL_PAGE_MAX_READABLE_PART_ASPECT_RATIO));
  return Math.min(FULL_PAGE_MAX_READABLE_PARTS, Math.max(1, Math.ceil(height / readableHeight)));
}

function fullPageCapturePlan(width, height, dpr) {
  const safeWidth = Math.max(1, Math.ceil(Number(width) || 0));
  const safeHeight = Math.max(1, Math.ceil(Number(height) || 0));
  const safeDpr = Math.max(1, Number(dpr) || 1);
  const rasterWidth = safeWidth * safeDpr;
  const rasterHeight = safeHeight * safeDpr;
  const pagePixels = rasterWidth * rasterHeight;
  const readablePartCount = readableDocumentPartCount(safeWidth, safeHeight);
  const fitsSingleImage =
    readablePartCount === 1 &&
    pagePixels <= FULL_PAGE_SINGLE_IMAGE_MAX_PIXELS &&
    rasterWidth <= FULL_PAGE_PART_MAX_DIMENSION &&
    rasterHeight <= FULL_PAGE_PART_MAX_DIMENSION;

  if (fitsSingleImage) {
    return {
      captureScale: 1,
      format: 'png',
      tiles: [{ top: 0, height: safeHeight }]
    };
  }

  const capacityTileHeight = Math.min(
    safeHeight,
    Math.max(FULL_PAGE_BASE_TILE_HEIGHT, Math.ceil(safeHeight / FULL_PAGE_PREFERRED_MAX_PARTS))
  );
  const capacityPartCount = Math.ceil(safeHeight / capacityTileHeight);
  const partCount = Math.max(readablePartCount, capacityPartCount);
  const tileHeight = Math.ceil(safeHeight / partCount);
  const captureScale = maximumDocumentPartScale(safeWidth, tileHeight, safeDpr);
  if (!Number.isFinite(captureScale) || captureScale <= 0) {
    throw new Error('The page dimensions cannot be captured safely.');
  }

  return {
    captureScale,
    format: 'jpeg',
    tiles: documentTiles(safeHeight, tileHeight)
  };
}

function documentCapturePlan(documentInfo) {
  const viewportHeight = Math.max(1, Math.ceil(Number(documentInfo.viewportHeight) || 0));
  const documentHeight = Math.max(viewportHeight, Math.ceil(Number(documentInfo.docHeight) || 0));
  const measuredContentHeight = Math.ceil(Number(documentInfo.contentHeight) || 0);
  const captureHeight =
    measuredContentHeight >= viewportHeight && measuredContentHeight < documentHeight
      ? measuredContentHeight
      : documentHeight;
  return fullPageCapturePlan(documentInfo.width, captureHeight, documentInfo.dpr);
}

function screenshotDataUrl(data, format) {
  return `data:image/${format};base64,${data}`;
}

function createFullPagePart(tile, width, outputScale) {
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * outputScale)),
    Math.max(1, Math.round(tile.height * outputScale))
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { ...tile, canvas, ctx };
}

function drawBitmapIntoFullPagePart(part, bitmap, source, destination, outputScale) {
  const partBottom = part.top + part.height;
  const destinationBottom = destination.y + destination.height;
  const clippedTop = Math.max(part.top, destination.y);
  const clippedBottom = Math.min(partBottom, destinationBottom);
  if (
    clippedBottom <= clippedTop ||
    source.width <= 0 ||
    source.height <= 0 ||
    destination.width <= 0 ||
    destination.height <= 0
  ) {
    return;
  }

  const sourceTop = source.y + ((clippedTop - destination.y) / destination.height) * source.height;
  const sourceHeight = ((clippedBottom - clippedTop) / destination.height) * source.height;
  const destinationLeft = Math.round(destination.x * outputScale);
  const destinationRight = Math.round((destination.x + destination.width) * outputScale);
  const destinationTop = Math.round((clippedTop - part.top) * outputScale);
  const destinationBottomPixel = Math.round((clippedBottom - part.top) * outputScale);
  if (destinationRight <= destinationLeft || destinationBottomPixel <= destinationTop) return;

  part.ctx.drawImage(
    bitmap,
    source.x,
    sourceTop,
    source.width,
    sourceHeight,
    destinationLeft,
    destinationTop,
    destinationRight - destinationLeft,
    destinationBottomPixel - destinationTop
  );
}

function discardFullPagePart(part) {
  part.canvas.width = 1;
  part.canvas.height = 1;
}

async function reportFullPageProgress(tabId, label, completed, total) {
  const progress = {
    active: true,
    label,
    completed,
    total,
    percent: Math.max(0, Math.min(100, Math.round((completed / Math.max(total, 1)) * 100))),
    updatedAt: Date.now()
  };
  const state = await getState();
  if (state.recording) await setState({ fullPageProgress: progress });
  await chrome.action.setBadgeText({ text: `${progress.percent}%` }).catch(() => {});
  return progress;
}

async function setFullPageProgressVisibility(tabId, hidden) {
  if (!Number.isSafeInteger(tabId)) return;
  await chrome.tabs.sendMessage(tabId, { type: 'FULL_PAGE_PROGRESS_VISIBILITY', hidden }).catch(() => {});
}

async function clearFullPageProgress(tabId) {
  const state = await getState();
  if (state.fullPageProgress) await setState({ fullPageProgress: null });
  if (Number.isSafeInteger(tabId)) {
    await chrome.tabs.sendMessage(tabId, { type: 'FULL_PAGE_PROGRESS_CLEAR' }).catch(() => {});
  }
  await updateBadge(await getState());
}

function fullDocumentRasterScale(width, height, dpr) {
  const rasterWidth = Math.max(1, width * Math.max(1, dpr));
  const rasterHeight = Math.max(1, height * Math.max(1, dpr));
  return Math.min(
    1,
    FULL_PAGE_RASTER_MAX_DIMENSION / rasterWidth,
    FULL_PAGE_RASTER_MAX_DIMENSION / rasterHeight,
    Math.sqrt(FULL_PAGE_RASTER_MAX_PIXELS / (rasterWidth * rasterHeight))
  );
}

async function splitDocumentRaster(dataUrl, tiles, documentWidth, documentHeight, onPart) {
  if (tiles.length === 1 || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return [{ rawDataUrl: dataUrl }];
  }

  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scaleX = bitmap.width / documentWidth;
  const scaleY = bitmap.height / documentHeight;
  const parts = [];
  try {
    for (const tile of tiles) {
      const sourceTop = Math.max(0, Math.round(tile.top * scaleY));
      const sourceBottom = Math.min(bitmap.height, Math.round((tile.top + tile.height) * scaleY));
      const sourceHeight = Math.max(1, sourceBottom - sourceTop);
      const canvas = new OffscreenCanvas(bitmap.width, sourceHeight);
      try {
        canvas.getContext('2d').drawImage(
          bitmap,
          0,
          sourceTop,
          bitmap.width,
          sourceHeight,
          0,
          0,
          Math.max(1, Math.round(documentWidth * scaleX)),
          sourceHeight
        );
        parts.push({
          rawDataUrl: await canvasToDataUrl(canvas, 'image/jpeg', FULL_PAGE_TILE_JPEG_QUALITY / 100)
        });
        await onPart?.(parts.length, tiles.length);
      } finally {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    return parts;
  } finally {
    bitmap.close();
  }
}

async function captureDocumentParts(tabId, documentInfo) {
  const plan = documentCapturePlan(documentInfo);
  const documentHeight = plan.tiles.at(-1).top + plan.tiles.at(-1).height;
  const captureScale = fullDocumentRasterScale(documentInfo.width, documentHeight, documentInfo.dpr);
  const captureProgressTotal = plan.tiles.length * 2 + 1;
  await reportFullPageProgress(tabId, 'Preparing full-page screenshot', 0, captureProgressTotal);

  await setFullPageProgressVisibility(tabId, true);
  try {
    const options = {
      format: 'jpeg',
      quality: FULL_PAGE_TILE_JPEG_QUALITY,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: documentInfo.width, height: documentHeight, scale: captureScale }
    };
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', options);
    if (!result?.data) throw new Error('Chromium returned no full-page screenshot data.');
    await reportFullPageProgress(tabId, 'Captured full page', 1, captureProgressTotal);
    const parts = await splitDocumentRaster(
      screenshotDataUrl(result.data, 'jpeg'),
      plan.tiles,
      documentInfo.width,
      documentHeight,
      (completed, total) => reportFullPageProgress(
        tabId,
        `Preparing full page ${completed} of ${total}`,
        completed + 1,
        captureProgressTotal
      )
    );
    const retainedParts = await removeTrailingBlankFullPageParts(parts);
    const progressCompleted = plan.tiles.length + 1;
    const progressTotal = progressCompleted + retainedParts.length;
    await reportFullPageProgress(tabId, 'Preparing screenshots for saving', progressCompleted, progressTotal);
    return {
      parts: retainedParts,
      captureScale,
      progressTotal,
      progressCompleted,
      trimBlankMargins: false
    };
  } finally {
    await setFullPageProgressVisibility(tabId, false);
  }
}

async function waitForDocumentLayout(tabId, fallback) {
  let latest = fallback;
  let stablePolls = 0;
  for (let poll = 0; poll < FULL_PAGE_LAYOUT_STABLE_POLLS + 1; poll += 1) {
    await delay(FULL_PAGE_LAYOUT_POLL_MS);
    const next = await measureDocument(tabId).catch(() => null);
    if (!next) continue;
    const stable = Math.abs(next.docHeight - latest.docHeight) <= 4 && Math.abs(next.width - latest.width) <= 4;
    latest = next;
    stablePolls = stable ? stablePolls + 1 : 0;
    if (stablePolls >= FULL_PAGE_LAYOUT_STABLE_POLLS) break;
  }
  return latest;
}

async function restoreDocumentScroll(tabId, left, top) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [left, top],
      func: (x, y) => {
        const previous = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo({ left: x, top: y, behavior: 'instant' });
        document.documentElement.style.scrollBehavior = previous;
      }
    })
    .catch(() => {});
}

function documentCaptureStops(documentInfo) {
  const viewportHeight = Math.max(1, Math.ceil(Number(documentInfo.viewportHeight) || 0));
  const totalTravel = Math.max(0, Math.ceil(Number(documentInfo.docHeight) || 0) - viewportHeight);
  const overlap = Math.min(SCROLLER_FRAME_OVERLAP, Math.floor(viewportHeight / 3));
  const step = Math.max(viewportHeight - overlap, 80);
  const stops = [];
  for (let top = 0; top < totalTravel; top += step) stops.push(top);
  if (!stops.length || stops[stops.length - 1] !== totalTravel) stops.push(totalTravel);
  return stops;
}

function documentCaptureWatchdogMs(documentInfo) {
  const estimate =
    documentCaptureStops(documentInfo).length * FULL_PAGE_SCROLLER_FRAME_ESTIMATE_MS +
    FULL_PAGE_SCROLLER_WATCHDOG_OVERHEAD_MS;
  return Math.max(FULL_PAGE_WATCHDOG_MS, Math.min(FULL_PAGE_SCROLLER_WATCHDOG_MAX_MS, estimate));
}

async function scrollDocumentTo(tabId, left, top) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [left, top, SCROLLER_SETTLE_MAX_MS],
    func: async (targetLeft, targetTop, maxWaitMs) => {
      const root = document.documentElement;
      const body = document.body;
      const previousRootBehavior = root.style.scrollBehavior;
      const previousBodyBehavior = body?.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      if (body) body.style.scrollBehavior = 'auto';
      window.scrollTo({ left: targetLeft, top: targetTop, behavior: 'instant' });

      const deadline = Date.now() + maxWaitMs;
      while (
        (Math.abs(window.scrollX - targetLeft) >= 2 || Math.abs(window.scrollY - targetTop) >= 2) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      root.style.scrollBehavior = previousRootBehavior;
      if (body) body.style.scrollBehavior = previousBodyBehavior;
      return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
    }
  });
  return injected?.result || { ok: false, scrollX: left, scrollY: top };
}

async function captureDocumentStitch(tabId, windowId, documentInfo, captureRequest) {
  await waitForImages(tabId);
  if (captureRequest && !(await isCaptureRequestActive(captureRequest))) return null;
  const doc = await waitForDocumentLayout(tabId, documentInfo);
  if (captureRequest && !(await isCaptureRequestActive(captureRequest))) return null;
  const viewportWidth = Math.max(1, Math.ceil(Number(doc.viewportWidth || doc.width) || 0));
  const viewportHeight = Math.max(1, Math.ceil(Number(doc.viewportHeight) || 0));
  const docHeight = Math.max(viewportHeight, Math.ceil(Number(doc.docHeight) || 0));
  const stops = documentCaptureStops({ ...doc, viewportHeight, docHeight });
  const plan = fullPageCapturePlan(viewportWidth, docHeight, doc.dpr);
  const outputScale = Math.max(1, Number(doc.dpr) || 1) * plan.captureScale;
  const progressTotal = stops.length + plan.tiles.length * 2;
  const activeParts = new Map();
  const parts = [];
  let nextPartToCreate = 0;
  let nextPartToFinish = 0;
  let previousBottom = 0;

  const createPart = (index) => {
    activeParts.set(index, createFullPagePart(plan.tiles[index], viewportWidth, outputScale));
  };

  const ensurePartsThrough = (bottom) => {
    while (nextPartToCreate < plan.tiles.length && plan.tiles[nextPartToCreate].top < bottom) {
      createPart(nextPartToCreate);
      nextPartToCreate += 1;
    }
  };

  const finishPart = async (index) => {
    const part = activeParts.get(index);
    if (!part) return;
    const partNumber = parts.length + 1;
    await reportFullPageProgress(
      tabId,
      `Assembling full page ${partNumber} of ${plan.tiles.length}`,
      stops.length + parts.length,
      progressTotal
    );
    let rawDataUrl;
    try {
      rawDataUrl = await canvasToDataUrl(
        part.canvas,
        `image/${plan.format}`,
        plan.format === 'jpeg' ? FULL_PAGE_TILE_JPEG_QUALITY / 100 : undefined
      );
    } finally {
      discardFullPagePart(part);
      activeParts.delete(index);
    }
    parts.push({ rawDataUrl });
    await reportFullPageProgress(
      tabId,
      `Assembled full page ${partNumber} of ${plan.tiles.length}`,
      stops.length + parts.length,
      progressTotal
    );
  };

  const finishPartsBefore = async (top) => {
    while (nextPartToFinish < plan.tiles.length) {
      const part = activeParts.get(nextPartToFinish);
      if (!part || part.top + part.height > top) break;
      await finishPart(nextPartToFinish);
      nextPartToFinish += 1;
    }
  };

  try {
    await hideScrollbars(tabId);
    await reportFullPageProgress(tabId, 'Preparing scrollable page', 0, progressTotal);
    for (let index = 0; index < stops.length; index += 1) {
      if (captureRequest && !(await isCaptureRequestActive(captureRequest))) return null;
      const target = stops[index];
      await reportFullPageProgress(tabId, `Capturing full page ${index + 1} of ${stops.length}`, index, progressTotal);
      const { ok, scrollY } = await scrollDocumentTo(tabId, doc.scrollX, target);
      if (!ok || Math.abs(scrollY - target) > 2) throw new Error('Could not reach a document section.');
      await delay(450);
      if (captureRequest && !(await isCaptureRequestActive(captureRequest))) return null;

      let dataUrl;
      await setFullPageProgressVisibility(tabId, true);
      try {
        dataUrl = await captureVisibleTabWithRetry(windowId);
      } finally {
        await setFullPageProgressVisibility(tabId, false);
      }
      if (captureRequest && !(await isCaptureRequestActive(captureRequest))) return null;

      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      try {
        const sourceScaleX = bitmap.width / viewportWidth;
        const sourceScaleY = bitmap.height / viewportHeight;
        const contentBottom = Math.min(docHeight, scrollY + viewportHeight);
        const sourceTop = Math.max(0, Math.min(contentBottom - scrollY, previousBottom - scrollY));
        const destinationTop = scrollY + sourceTop;
        const destinationBottom = contentBottom;

        await finishPartsBefore(destinationTop);
        ensurePartsThrough(destinationBottom);
        for (const part of activeParts.values()) {
          drawBitmapIntoFullPagePart(
            part,
            bitmap,
            {
              x: 0,
              y: sourceTop * sourceScaleY,
              width: bitmap.width,
              height: (destinationBottom - destinationTop) * sourceScaleY
            },
            {
              x: 0,
              y: destinationTop,
              width: viewportWidth,
              height: destinationBottom - destinationTop
            },
            outputScale
          );
        }
        previousBottom = Math.max(previousBottom, destinationBottom);
      } finally {
        bitmap.close();
      }
      await reportFullPageProgress(tabId, `Captured full page ${index + 1} of ${stops.length}`, index + 1, progressTotal);
    }

    if (previousBottom < docHeight - 2) throw new Error('Could not capture the bottom of the document.');
    ensurePartsThrough(docHeight);
    await finishPartsBefore(Number.POSITIVE_INFINITY);
    return {
      parts,
      captureScale: plan.captureScale,
      progressTotal,
      progressCompleted: stops.length + plan.tiles.length,
      trimBlankMargins: false
    };
  } finally {
    for (const part of activeParts.values()) discardFullPagePart(part);
    await restoreDocumentScroll(tabId, doc.scrollX, doc.scrollY);
    await restoreScrollbars(tabId);
  }
}

// Chromium can rasterize a document outside the visible viewport directly. Do not use
// Emulation.setDeviceMetricsOverride here: enlarging the viewport visibly reflows responsive apps
// while the user-triggered capture is running.
async function captureDocumentHeadless(tabId, documentInfo) {
  if (!(await attachDebugger(tabId))) return null;

  try {
    await waitForImages(tabId);
    let stableDocumentInfo = await waitForDocumentLayout(tabId, documentInfo);
    let result = null;
    for (let attempt = 0; attempt < FULL_PAGE_LAYOUT_ATTEMPTS; attempt += 1) {
      result = await captureDocumentParts(tabId, stableDocumentInfo);

      const latest = await measureDocument(tabId).catch(() => null);
      if (
        !latest ||
        (latest.docHeight <= stableDocumentInfo.docHeight + 4 && latest.width <= stableDocumentInfo.width + 4)
      ) {
        return result;
      }
      result = null;
      stableDocumentInfo = await waitForDocumentLayout(tabId, latest);
    }
    return result;
  } catch (error) {
    console.warn('Full-page capture failed, using the visible frame:', error.message);
    return null;
  } finally {
    const currentDocumentInfo = await measureDocument(tabId).catch(() => null);
    if (
      currentDocumentInfo &&
      (Math.abs(currentDocumentInfo.scrollX - documentInfo.scrollX) >= 2 ||
        Math.abs(currentDocumentInfo.scrollY - documentInfo.scrollY) >= 2)
    ) {
      await restoreDocumentScroll(tabId, documentInfo.scrollX, documentInfo.scrollY);
    }
    // The debugger is only needed for the instant of the shot, so let go of it immediately - that
    // is what makes the "started debugging this browser" banner disappear right away.
    await detachDebugger();
  }
}

async function captureExpandedScrollerHeadless(tabId, scroller) {
  if (!(await attachDebugger(tabId))) return null;
  try {
    if (!(await expandScrollerForHeadless(tabId, scroller.scrollHeight))) return null;
    const expandedDocument = await waitForDocumentLayout(tabId, await measureDocument(tabId));
    return await captureDocumentHeadless(tabId, expandedDocument);
  } finally {
    await restoreExpandedScroller(tabId);
    await detachDebugger();
  }
}

function scrollerCaptureStops(scroller) {
  const totalTravel = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const overlap = Math.min(SCROLLER_FRAME_OVERLAP, Math.floor(Math.max(scroller.rectHeight, 1) / 3));
  const step = Math.max(scroller.rectHeight - overlap, 80);
  const stops = [];
  for (let top = 0; top < totalTravel; top += step) stops.push(top);
  if (!stops.length || stops[stops.length - 1] !== totalTravel) stops.push(totalTravel);
  return stops;
}

function scrollerCaptureWatchdogMs(scroller) {
  const estimate =
    scrollerCaptureStops(scroller).length * FULL_PAGE_SCROLLER_FRAME_ESTIMATE_MS +
    FULL_PAGE_SCROLLER_WATCHDOG_OVERHEAD_MS;
  return Math.max(FULL_PAGE_WATCHDOG_MS, Math.min(FULL_PAGE_SCROLLER_WATCHDOG_MAX_MS, estimate));
}

function drawScrollerChrome(part, firstBitmap, scroller, totalHeight, sourceScaleX, sourceScaleY, outputScale) {
  const { viewportWidth, viewportHeight, rectTop, rectLeft, rectWidth } = scroller;
  const topSourceHeight = Math.min(firstBitmap.height, rectTop * sourceScaleY);
  if (topSourceHeight > 0) {
    drawBitmapIntoFullPagePart(
      part,
      firstBitmap,
      { x: 0, y: 0, width: firstBitmap.width, height: topSourceHeight },
      { x: 0, y: 0, width: viewportWidth, height: rectTop },
      outputScale
    );
  }

  const railHeight = Math.max(0, viewportHeight - rectTop);
  const railSourceHeight = Math.min(firstBitmap.height - topSourceHeight, railHeight * sourceScaleY);
  const extendRail = (left, width) => {
    if (width <= 0 || railHeight <= 0 || railSourceHeight <= 0) return;
    const sourceLeft = left * sourceScaleX;
    drawBitmapIntoFullPagePart(
      part,
      firstBitmap,
      { x: sourceLeft, y: topSourceHeight, width: width * sourceScaleX, height: railSourceHeight },
      { x: left, y: rectTop, width, height: railHeight },
      outputScale
    );

    const extensionTop = rectTop + railHeight;
    if (extensionTop >= totalHeight) return;
    drawBitmapIntoFullPagePart(
      part,
      firstBitmap,
      { x: sourceLeft, y: topSourceHeight + railSourceHeight - 1, width: width * sourceScaleX, height: 1 },
      { x: left, y: extensionTop, width, height: totalHeight - extensionTop },
      outputScale
    );
  };

  extendRail(0, rectLeft);
  extendRail(rectLeft + rectWidth, Math.max(0, viewportWidth - (rectLeft + rectWidth)));
}

function drawScrollerBottom(part, lastBitmap, scroller, totalHeight, sourceScaleY, outputScale) {
  const sourceTop = Math.min(lastBitmap.height, (scroller.rectTop + scroller.rectHeight) * sourceScaleY);
  const sourceHeight = lastBitmap.height - sourceTop;
  if (sourceHeight <= 0) return;
  const height = sourceHeight / sourceScaleY;
  drawBitmapIntoFullPagePart(
    part,
    lastBitmap,
    { x: 0, y: sourceTop, width: lastBitmap.width, height: sourceHeight },
    { x: 0, y: totalHeight - height, width: scroller.viewportWidth, height },
    outputScale
  );
}

// App-shell content only exists while its pane is scrolled, so capture every overlapping viewport
// slice and encode bounded, adjacent output parts instead of building one unbounded canvas.
async function captureScrollerStitch(tabId, windowId, scroller) {
  const { viewportWidth, viewportHeight, rectTop, rectLeft, rectWidth, rectHeight, dpr } = scroller;
  const stops = scrollerCaptureStops(scroller);
  const belowHeight = Math.max(0, viewportHeight - (rectTop + rectHeight));
  const totalHeight = Math.ceil(rectTop + scroller.scrollHeight + belowHeight);
  const plan = fullPageCapturePlan(viewportWidth, totalHeight, dpr);
  const outputScale = Math.max(1, Number(dpr) || 1) * plan.captureScale;
  const progressTotal = stops.length + plan.tiles.length * 2;
  const activeParts = new Map();
  const parts = [];
  let firstBitmap = null;
  let lastBitmap = null;
  let sourceScaleX = 1;
  let sourceScaleY = 1;
  let nextPartToCreate = 0;
  let nextPartToFinish = 0;

  const createPart = (index) => {
    const part = createFullPagePart(plan.tiles[index], viewportWidth, outputScale);
    drawScrollerChrome(part, firstBitmap, scroller, totalHeight, sourceScaleX, sourceScaleY, outputScale);
    activeParts.set(index, part);
  };

  const ensurePartsThrough = (bottom) => {
    while (nextPartToCreate < plan.tiles.length && plan.tiles[nextPartToCreate].top < bottom) {
      createPart(nextPartToCreate);
      nextPartToCreate += 1;
    }
  };

  const finishPart = async (index) => {
    const part = activeParts.get(index);
    if (!part) return;
    const partNumber = parts.length + 1;
    await reportFullPageProgress(
      tabId,
      `Assembling full page ${partNumber} of ${plan.tiles.length}`,
      stops.length + parts.length,
      progressTotal
    );
    let rawDataUrl;
    try {
      rawDataUrl = await canvasToDataUrl(
        part.canvas,
        `image/${plan.format}`,
        plan.format === 'jpeg' ? FULL_PAGE_TILE_JPEG_QUALITY / 100 : undefined
      );
    } finally {
      discardFullPagePart(part);
      activeParts.delete(index);
    }
    parts.push({ rawDataUrl });
    await reportFullPageProgress(
      tabId,
      `Assembled full page ${partNumber} of ${plan.tiles.length}`,
      stops.length + parts.length,
      progressTotal
    );
  };

  const finishPartsBefore = async (top) => {
    while (nextPartToFinish < plan.tiles.length) {
      const part = activeParts.get(nextPartToFinish);
      if (!part || part.top + part.height > top) break;
      await finishPart(nextPartToFinish);
      nextPartToFinish += 1;
    }
  };

  try {
    await hideScrollbars(tabId);
    await reportFullPageProgress(tabId, 'Preparing scrollable page', 0, progressTotal);
    for (let index = 0; index < stops.length; index += 1) {
      const target = stops[index];
      await reportFullPageProgress(tabId, `Capturing full page ${index + 1} of ${stops.length}`, index, progressTotal);
      const { ok, scrollTop } = await scrollScrollerTo(tabId, SCROLLER_MARK_ATTR, target);
      if (!ok || Math.abs(scrollTop - target) > 2) throw new Error('Could not reach a scrollable page section.');
      await delay(450);

      let dataUrl;
      await setFullPageProgressVisibility(tabId, true);
      try {
        // Must target the recorded tab's own window explicitly - omitting it captures whatever
        // window the OS currently has focused, which can be a different one entirely.
        dataUrl = await captureVisibleTabWithRetry(windowId);
      } finally {
        await setFullPageProgressVisibility(tabId, false);
      }

      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const isFirst = firstBitmap === null;
      const isLast = index === stops.length - 1;
      try {
        if (isFirst) {
          firstBitmap = bitmap;
          sourceScaleX = bitmap.width / viewportWidth;
          sourceScaleY = bitmap.height / viewportHeight;
        }
        if (isLast) lastBitmap = bitmap;

        const destinationTop = rectTop + scrollTop;
        const destinationBottom = destinationTop + rectHeight;
        await finishPartsBefore(destinationTop);
        ensurePartsThrough(destinationBottom);
        for (const part of activeParts.values()) {
          drawBitmapIntoFullPagePart(
            part,
            bitmap,
            {
              x: rectLeft * sourceScaleX,
              y: rectTop * sourceScaleY,
              width: rectWidth * sourceScaleX,
              height: rectHeight * sourceScaleY
            },
            { x: rectLeft, y: destinationTop, width: rectWidth, height: rectHeight },
            outputScale
          );
        }
      } finally {
        if (!isFirst && !isLast) bitmap.close();
      }
      await reportFullPageProgress(tabId, `Captured full page ${index + 1} of ${stops.length}`, index + 1, progressTotal);
    }

    if (!firstBitmap || !lastBitmap) return null;
    ensurePartsThrough(totalHeight);
    for (const part of activeParts.values()) {
      drawScrollerBottom(part, lastBitmap, scroller, totalHeight, sourceScaleY, outputScale);
    }
    await finishPartsBefore(Number.POSITIVE_INFINITY);
    return {
      parts,
      captureScale: plan.captureScale,
      progressTotal,
      progressCompleted: stops.length + plan.tiles.length,
      trimBlankMargins: parts.length === 1
    };
  } finally {
    if (lastBitmap && lastBitmap !== firstBitmap) lastBitmap.close();
    firstBitmap?.close();
    for (const part of activeParts.values()) discardFullPagePart(part);
    await scrollScrollerTo(tabId, SCROLLER_MARK_ATTR, scroller.scrollTop);
    await clearScrollerMark(tabId);
    await restoreScrollbars(tabId);
  }
}

// Direct Chromium rasterization does not alter the live viewport or scroll position. If it is not
// available, retain the ordinary visible frame rather than scrolling the user's document or pane.
async function captureFullPagePassive(tabId, documentInfo) {
  const doc = documentInfo || (await measureDocument(tabId).catch(() => null));
  if (!doc?.viewportHeight || !HAS_DEBUGGER) return null;
  const scroller = await findScroller(tabId).catch(() => null);
  if (scroller?.scrollHeight > doc.docHeight + 4) {
    return captureExpandedScrollerHeadless(tabId, scroller);
  }
  await clearScrollerMark(tabId);
  if (!(doc.docHeight > doc.viewportHeight + 4)) return null;
  return captureDocumentHeadless(tabId, doc);
}

// A page that never settles (throttled background tab, an element that keeps growing, a stalled
// network wait) must never be allowed to stall the whole recording - past the watchdog, give up and
// fall back to the ordinary visible frame instead. The badge shows "..." for the same reason: a
// multi-second full-page capture must not look identical to the extension having stopped responding.
async function captureFullPageWithWatchdog(tabId, captureRequest) {
  const state = await getState();
  await chrome.action.setBadgeText({ text: state.recording && !state.paused ? '\u2026' : '' });
  try {
    const documentInfo = await measureDocument(tabId).catch(() => null);
    const watchdogMs = FULL_PAGE_WATCHDOG_MS;
    const FULL_PAGE_TIMEOUT_TOKEN = Symbol('full-page-timeout');
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(FULL_PAGE_TIMEOUT_TOKEN), watchdogMs);
    });
    try {
      const captureWork = captureFullPagePassive(tabId, documentInfo).catch(() => null);
      const result = await Promise.race([
        waitForCaptureOperation(captureRequest, captureWork),
        timeout
      ]);
      if (result === FULL_PAGE_TIMEOUT_TOKEN) {
        logLine(`FULL_PAGE_WATCHDOG exceeded ${watchdogMs}ms, using the visible frame instead`);
        return null;
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    await updateBadge(await getState());
  }
}

async function storeFrame(frame) {
  await chrome.storage.local.set({ [`${FRAME_PREFIX}${frame.sequence}`]: frame });
}

async function clearStoredFrames() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key === FRAMES_KEY || key.startsWith(FRAME_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

function completedEvidenceFor(state) {
  const evidence = state?.completedEvidence;
  return evidence && evidence.sessionId === state?.sessionId ? evidence : null;
}

function hasSelectedCaptureFolder(state) {
  return Boolean(state.outputFolder?.name);
}

function savesToSelectedFolder(state) {
  return hasSelectedCaptureFolder(state) && !state.folderAccessNeeded;
}

const FOLDER_PERMISSION_ERROR = 'JSHOTZ_FOLDER_PERMISSION_REQUIRED';

function folderPermissionError() {
  const error = new Error(
    'The selected capture folder needs permission again. Click "Reconnect capture folder" to continue.'
  );
  error.code = FOLDER_PERMISSION_ERROR;
  return error;
}

function needsFolderReconnect(error) {
  return error?.code === FOLDER_PERMISSION_ERROR;
}

function normalizeFolderAccessError(error) {
  if (needsFolderReconnect(error)) return error;
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return folderPermissionError();
  }
  return error;
}

async function writableCaptureFolder() {
  const directoryHandle = await getSavedCaptureFolder();
  if (!directoryHandle) throw folderPermissionError();
  return directoryHandle;
}

async function writableSelectedCaptureFolder(state) {
  const directoryHandle = await writableCaptureFolder();
  if (directoryHandle.name !== state.outputFolder?.name) throw folderPermissionError();
  return directoryHandle;
}

function interruptedCompletedEvidence(state) {
  if (!state.sessionId || !state.captures.length) return null;
  const savedToFolder = hasSelectedCaptureFolder(state);
  return {
    sessionId: state.sessionId,
    captureCount: state.captures.length,
    outputFolderName: savedToFolder ? state.outputFolder?.name || null : null,
    downloadDirectory: savedToFolder ? null : sessionDownloadDirectory(state),
    completedAt: new Date().toISOString(),
    interrupted: true
  };
}

async function writableCompletedEvidenceFolder(evidence) {
  const directoryHandle = await writableCaptureFolder();
  if (directoryHandle.name !== evidence?.outputFolderName) throw folderPermissionError();
  return directoryHandle;
}

async function writeSelectedCaptureFolderFile(name, contents) {
  try {
    await writeCaptureFolderFile(await writableCaptureFolder(), name, contents);
  } catch (error) {
    throw normalizeFolderAccessError(error);
  }
}

async function cleanupCaptureResources({ restoreDownloadUi = true, clearFrames = true, clearSessionControl = true } = {}) {
  await closeScreenWindow().catch(() => {});
  await closeOffscreen().catch(() => {});
  await detachDebugger().catch(() => {});
  if (clearFrames) await clearStoredFrames().catch(() => {});
  if (clearSessionControl) await chrome.storage.local.remove(SESSION_CONTROL_KEY).catch(() => {});
  await clearSessionTracking().catch(() => {});
  if (restoreDownloadUi) await setDownloadUi(true).catch(() => {});
  apiQueue = [];
  apiHeaderRecords = [];
  clearNewTabLinkTargets();
  pendingUserActionCaptures.clear();
  pendingNavigationTabIds.clear();
  lastRawCaptureHash = '';
  lastTabTitles.clear();
  sessionRecoveryPending = false;
  recoveredSessionId = null;
}

async function interruptRecordingAfterBrowserRestart() {
  const state = await getState();
  if (!state.recording) {
    sessionRecoveryPending = false;
    return state;
  }

  logLine(`SESSION_INTERRUPTED browser-restart captures=${state.captures.length}`);
  await configureApiHooks(state.trackedTabIds, false);
  await cleanupCaptureResources({ clearFrames: false });
  const interruptedAt = new Date().toISOString();
  const next = await setState({
    recording: false,
    paused: false,
    captureGeneration: 0,
    tabId: null,
    windowId: null,
    streamActive: false,
    fullPageProgress: null,
    downloadIds: [],
    outputFolder: null,
    pendingResumeFolder: null,
    completedEvidence: interruptedCompletedEvidence(state),
    interruptedRecording: {
      sessionId: state.sessionId,
      captureCount: state.captures.length,
      interruptedAt
    },
    folderWrittenFiles: [],
    folderAccessNeeded: false,
    lastError: null
  });
  await updateBadge(next);
  await flushLog();
  return next;
}

function isActiveCapture(state, sessionId, captureGeneration) {
  return (
    state.recording &&
    !state.paused &&
    state.sessionId === sessionId &&
    state.captureGeneration === captureGeneration
  );
}

function captureRequestKey(sessionId, captureGeneration) {
  return `${sessionId}:${captureGeneration}`;
}

function cancelCaptureRequest(sessionId, captureGeneration) {
  const signals = captureCancellationSignals.get(captureRequestKey(sessionId, captureGeneration));
  if (!signals) return;
  for (const signal of signals) signal();
}

function watchCaptureCancellation(captureRequest) {
  const key = captureRequestKey(captureRequest.sessionId, captureRequest.captureGeneration);
  let timer;
  let disposed = false;
  let resolveCancellation;
  const promise = new Promise((resolve) => {
    resolveCancellation = resolve;
  });
  const signals = captureCancellationSignals.get(key) || new Set();
  signals.add(resolveCancellation);
  captureCancellationSignals.set(key, signals);

  const checkState = async () => {
    if (disposed) return;
    if (!(await isCaptureRequestActive(captureRequest).catch(() => false))) {
      resolveCancellation();
      return;
    }
    timer = setTimeout(checkState, 250);
  };
  void checkState();

  return {
    promise,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      signals.delete(resolveCancellation);
      if (!signals.size) captureCancellationSignals.delete(key);
    }
  };
}

async function waitForCaptureOperation(captureRequest, operation) {
  if (!captureRequest) return operation;
  const cancellation = watchCaptureCancellation(captureRequest);
  try {
    return await Promise.race([operation, cancellation.promise.then(() => null)]);
  } finally {
    cancellation.dispose();
  }
}

async function isCaptureRequestActive(captureRequest) {
  const state = await getState();
  return isActiveCapture(state, captureRequest.sessionId, captureRequest.captureGeneration);
}

async function performCapture(captureRequest) {
  const startedAt = Date.now();
  const {
    reason,
    label,
    sessionId,
    captureGeneration,
    target,
    settings,
    modal
  } = captureRequest;
  const state = await getState();
  if (!isActiveCapture(state, sessionId, captureGeneration)) return;

  // Let the page settle (navigation paint, click-driven UI updates) before grabbing the frame.
  const settle =
    captureRequest.bufferedScreenFrameId || reason === 'toggle' || reason === 'modal-toggle'
      ? 0
      : reason === 'navigation'
        ? 600
        : reason === 'devtools-panel'
          ? 150
          : reason === 'dialog-opened'
            ? 550
            : 450;
  await delay(settings.captureApi ? settle + 500 : settle);

  await waitForNewTabLinkTarget(target);
  const tabId = target?.tabId;
  if (!Number.isSafeInteger(tabId)) return;
  await waitForRenderedPage(tabId, reason);
  const latest = await getState();
  if (!isActiveCapture(latest, sessionId, captureGeneration)) return;

  // Refresh the tab after waiting. Its old title and URL may describe the page before the action.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    sessionRecoveryPending = true;
    await setState({ lastError: 'Recording target is unavailable. Open the popup to resume on the active tab.' });
    return;
  }

  const wantsFullPage = settings.fullPage && FULL_PAGE_REASONS.has(reason);
  if (!wantsFullPage && settings.captureMode !== 'screen' && !(await isVisibleCaptureTarget(tab))) {
    logLine(`CAPTURE_SKIPPED ${reason}${label ? ` "${label}"` : ''}: the action tab is no longer visible.`);
    return;
  }

  const page = await getPageContext(tab.id, tab);
  if (!matchesExpectedPage(captureRequest, page)) {
    logLine(
      `CAPTURE_SKIPPED_STALE ${reason}${label ? ` "${label}"` : ''} ` +
        `expectedUrl=${shortUrl(captureRequest.expectedUrl)} actualUrl=${shortUrl(page.url)} ` +
        `expectedTitle=${captureRequest.expectedTitle || '(none)'} actualTitle=${page.documentTitle || '(none)'}`
    );
    return;
  }

  // Full-page capture renders the page itself, not whatever surface a mode normally captures - that
  // applies just as well in Screen/window and API mode as it does in Tab viewport mode. The queue
  // watchdog above is what actually guards against this hanging the rest of the recording, so this
  // no longer needs to be restricted to specific modes to stay safe.
  let fullPage = null;
  try {
    if (wantsFullPage) {
      await reportFullPageProgress(tab.id, 'Preparing full-page screenshot', 0, 1);
      fullPage = await captureFullPageWithWatchdog(tab.id, captureRequest);
    }
    if (!(await isActiveCapture(await getState(), sessionId, captureGeneration))) return;
    const fullPageInfo = wantsFullPage
      ? fullPage?.parts
        ? `parts=${fullPage.parts.length} scale=${Math.round(fullPage.captureScale * 100)}%`
        : fullPage
          ? 'ok'
          : 'fell back to visible frame'
      : 'n/a';
    const capture = {
      title: page.title,
      url: page.url,
      reason,
      label,
      startedAt,
      actionAt: captureRequest.actionAt,
      requestSequence: captureRequest.requestSequence,
      sessionId,
      captureGeneration,
      mode: settings.captureMode,
      fullPageInfo,
      // Screen/window and direct whole-page images do not share the page viewport coordinate system.
      modal: !wantsFullPage && (settings.captureMode === 'tab' || settings.captureMode === 'api') ? modal : null
    };

    if (fullPage?.parts?.length) {
      return await persistFullPageParts({
        ...capture,
        tabId: tab.id,
        parts: fullPage.parts,
        progressTotal: fullPage.progressTotal,
        progressCompleted: fullPage.progressCompleted,
        trimBlankMargins: fullPage.trimBlankMargins
      });
    }

    let rawDataUrl;
    if (typeof fullPage === 'string') {
      rawDataUrl = fullPage;
    } else {
      if (wantsFullPage) await setFullPageProgressVisibility(tab.id, true);
      try {
        rawDataUrl = await grabPngDataUrl(captureRequest, tab);
        rawDataUrl = await grabSettledTransitionFrame(captureRequest, tab, rawDataUrl);
      } finally {
        if (wantsFullPage) await setFullPageProgressVisibility(tab.id, false);
      }
    }
    return await persistCapture({ ...capture, rawDataUrl });
  } finally {
    if (wantsFullPage) await clearFullPageProgress(tab.id);
  }
}

function fullPagePartTitle(title, index, count) {
  return count > 1 ? `${title} (part ${index + 1} of ${count})` : title;
}

function fullPagePartLabel(label, index, count) {
  if (count === 1) return label;
  const part = `part ${index + 1} of ${count}`;
  return label ? `${label} - ${part}` : part;
}

async function persistFullPageParts({
  tabId,
  parts,
  progressTotal,
  progressCompleted = parts.length,
  trimBlankMargins: shouldTrimBlankMargins,
  ...capture
}) {
  const apiRows = apiQueue;
  apiQueue = [];
  const entries = [];

  try {
    for (let index = 0; index < parts.length; index += 1) {
      await reportFullPageProgress(
        tabId,
        `Saving full page ${index + 1} of ${parts.length}`,
        progressCompleted + index,
        progressTotal
      );
      let rawDataUrl = parts[index].rawDataUrl;
      parts[index].rawDataUrl = null;
      if (shouldTrimBlankMargins && parts.length === 1) {
        rawDataUrl = await trimBlankMargins(rawDataUrl);
      }

      const entry = await persistCapture({
        ...capture,
        rawDataUrl,
        title: fullPagePartTitle(capture.title, index, parts.length),
        label: fullPagePartLabel(capture.label, index, parts.length),
        apiRows: index === 0 ? apiRows : [],
        titleBar: index === 0,
        jpegQuality: parts.length > 1 ? 0.9 : undefined
      });
      if (entry) entries.push(entry);
      await reportFullPageProgress(
        tabId,
        `Saved full page ${index + 1} of ${parts.length}`,
        progressCompleted + index + 1,
        progressTotal
      );
    }
  } catch (error) {
    if (!entries.length && apiRows.length) apiQueue = [...apiRows, ...apiQueue].slice(-12);
    throw error;
  } finally {
    for (const part of parts) part.rawDataUrl = null;
  }

  return entries;
}

async function persistCapture({
  rawDataUrl,
  title,
  url,
  reason,
  label,
  startedAt,
  actionAt,
  requestSequence,
  sessionId,
  captureGeneration,
  mode,
  fullPageInfo,
  modal,
  apiRows: suppliedApiRows,
  titleBar = true,
  jpegQuality
}) {
  const state = await getState();
  if (!isActiveCapture(state, sessionId, captureGeneration)) return;

  const { settings } = state;
  await ensureOffscreen();
  if (!isActiveCapture(await getState(), sessionId, captureGeneration)) return;

  const capturedAt = new Date();
  const actionTime = new Date(actionAt);
  const actionOccurredAt = Number.isNaN(actionTime.getTime()) ? capturedAt : actionTime;
  const sequence = state.sequence + 1;
  const usesQueuedApiRows = suppliedApiRows === undefined;
  const apiRows = usesQueuedApiRows ? apiQueue : suppliedApiRows;
  if (usesQueuedApiRows) apiQueue = [];
  const restoreQueuedApiRows = () => {
    if (usesQueuedApiRows && apiRows.length) apiQueue = [...apiRows, ...apiQueue].slice(-12);
  };
  const processed = await askOffscreen('OFFSCREEN_PROCESS', {
    dataUrl: rawDataUrl,
    titleBar: titleBar ? { title, url } : null,
    wantPng: settings.savePng,
    wantJpeg: true,
    apiRows,
    jpegQuality,
    modal,
    trimBlankMargins: Boolean(fullPageInfo)
  });
  const rawHash = hashText(rawDataUrl);
  rawDataUrl = null;
  if (processed?.error) {
    restoreQueuedApiRows();
    throw new Error(processed.error);
  }
  if (!isActiveCapture(await getState(), sessionId, captureGeneration)) {
    restoreQueuedApiRows();
    return;
  }

  if (!shouldKeepDuplicate(reason, apiRows) && rawHash === lastRawCaptureHash) {
    restoreQueuedApiRows();
    logLine(`SKIP (duplicate) ${reason}${label ? ` "${label}"` : ''} mode=${mode} fullPage=${fullPageInfo}`);
    return null;
  }
  lastRawCaptureHash = rawHash;

  const pngDataUrl = processed.pngDataUrl || rawDataUrl;
  const jpeg = processed.jpeg;

  const slug = sanitize(label ? `${title}-${label}` : title);
  const imageFileName = `${String(sequence).padStart(3, '0')}_${fileTimestamp(capturedAt)}_${slug}.png`;
  const downloadsFilename = `${sessionDownloadDirectory(state)}/${imageFileName}`;
  let filename = savesToSelectedFolder(state)
    ? imageFileName
    : downloadsFilename;

  if (settings.savePng) {
    if (savesToSelectedFolder(state)) {
      const pngBlob = await (await fetch(pngDataUrl)).blob();
      try {
        await writeSelectedCaptureFolderFile(filename, pngBlob);
        logFileSave('completed', 'png', filename, 'selected-folder');
        const latest = await getState();
        await setState({ folderWrittenFiles: [...latest.folderWrittenFiles, filename] });
      } catch (error) {
        logFileSave('failed', 'png', filename, 'selected-folder');
        filename = downloadsFilename;
        logFileSave('requested', 'png', filename, 'downloads');
        const downloadId = await downloadWithHiddenUi({ url: pngDataUrl, filename, saveAs: false });
        const latest = await getState();
        await setState({
          downloadIds: [...latest.downloadIds, downloadId],
          folderAccessNeeded: true,
          lastError: null
        });
        logLine(`FOLDER_FALLBACK #${sequence} ${error.message}`);
      }
    } else {
      logFileSave('requested', 'png', filename, 'downloads');
      const downloadId = await downloadWithHiddenUi({ url: pngDataUrl, filename, saveAs: false });
      await setState({ downloadIds: [...(await getState()).downloadIds, downloadId] });
    }
  }

  if (jpeg) {
    await storeFrame({
      sequence,
      title,
      note: '',
      url,
      time: `${stampText(actionOccurredAt)}  |  ${reason}${label ? ` "${label}"` : ''}  |  ${mode} mode`,
      actionAt: actionOccurredAt.toISOString(),
      requestSequence,
      apiRows,
      base64: jpeg.base64,
      width: jpeg.width,
      height: jpeg.height
    });
  }

  const entry = {
    sequence,
    reason,
    label: label || null,
    url,
    title,
    note: '',
    mode,
    apiCalls: apiRows.length,
    actionAt: actionOccurredAt.toISOString(),
    requestSequence,
    capturedAt: capturedAt.toISOString(),
    filename: settings.savePng ? filename : null
  };

  const next = await setState({
    sequence,
    captures: [...state.captures, entry].slice(-300),
    lastError: null
  });
  await updateBadge(next);
  logLine(
    `#${sequence} ${reason}${label ? ` "${label}"` : ''} mode=${mode} fullPage=${fullPageInfo}` +
      `${apiRows.length ? ` apiCalls=${apiRows.length}` : ''} url=${shortUrl(url)} (${Date.now() - startedAt}ms)`
  );
  if (shouldQueueInterimOutput(sequence)) {
    queueInterimOutput(state.sessionId, sequence);
  }
  return entry;
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function headerValue(headers, name) {
  const match = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im').exec(String(headers || ''));
  return match ? match[1].trim() : '';
}

function matchingRequestHeaders({ tabId, url, method }) {
  pruneApiHeaderRecords();
  const wantedMethod = String(method || 'GET').toUpperCase();
  for (let index = apiHeaderRecords.length - 1; index >= 0; index -= 1) {
    const record = apiHeaderRecords[index];
    if (record.tabId === tabId && record.method === wantedMethod && record.url === url) return record;
  }
  return null;
}

// Browser-added Origin/Referer headers are often hidden from page JavaScript; use page metadata as fallback.
function originDetails({ tabId, url, method, pageUrl, pageOrigin, requestHeaders }) {
  const observed = matchingRequestHeaders({ tabId, url, method });
  const lines = [
    `Request URL: ${observed?.requestUrl || url || '(unknown)'}`,
    `Origin: ${observed?.origin || headerValue(requestHeaders, 'origin') || pageOrigin || '(unknown)'}`,
    `Referer: ${observed?.referer || headerValue(requestHeaders, 'referer') || pageUrl || '(none)'}`
  ];

  return lines.join('\n');
}

// Calls are buffered and attached to the next screenshot rather than becoming pages of their own.
async function queueApiCall({
  outcome,
  tabId,
  url,
  method,
  status,
  pageUrl,
  pageOrigin,
  pageReferrer,
  targetOrigin,
  targetHost,
  requestHeaders,
  responseHeaders,
  payload,
  body
}) {
  apiQueue.push({
    outcome,
    name: `${method} ${shortUrl(url)}\n[${status || 'failed'}]`,
    origin: originDetails({
      tabId,
      url,
      method,
      pageUrl,
      pageOrigin,
      requestHeaders
    }),
    payload: payload || '(no request body)',
    response: body || '(empty response)'
  });
  if (apiQueue.length > 12) apiQueue.shift();

  const state = await getState();
  await setState({ apiSeen: state.apiSeen + 1 });
}

/* ---------------------------------------------------------------- lifecycle */

// Neither the service worker (no blob URLs) nor an offscreen document (chrome.runtime only)
// can write browser downloads, so a short-lived extension page does it.
async function exportOutputsInWindow(outputFiles, excludedSequences) {
  const requestId = outputRequestId();
  const params = new URLSearchParams({
    filename: outputFiles[0]?.filename || '',
    outputs: JSON.stringify(outputFiles),
    requestId
  });
  if (Array.isArray(excludedSequences)) {
    params.set('excluded', normalizeSequenceList(excludedSequences).join(','));
  }

  let outputWindowId = null;
  let completeOutputRequest;
  const resultPromise = new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.windows.onRemoved.removeListener(onRemoved);
      resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type !== 'OUTPUT_DONE' || message.requestId !== requestId) return;
      const downloadIds = normalizeIdList(
        Array.isArray(message.downloadIds)
          ? message.downloadIds
          : typeof message.downloadId === 'number'
            ? [message.downloadId]
            : []
      );
      finish(message.error ? { error: message.error } : { ok: true, downloadIds });
    };
    const onRemoved = (windowId) => {
      if (windowId === outputWindowId) finish({ error: 'The output window was closed early.' });
    };
    const timer = setTimeout(() => finish({ error: 'Timed out while writing output files.' }), 120000);

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.windows.onRemoved.addListener(onRemoved);
    completeOutputRequest = finish;
  });

  try {
    const win = await chrome.windows.create({
      url: `exporter.html?${params}`,
      type: 'popup',
      width: 420,
      height: 200,
      focused: false
    });
    outputWindowId = win?.id;
    if (!Number.isSafeInteger(outputWindowId)) {
      completeOutputRequest({ error: 'The output window could not be opened.' });
    }
  } catch (error) {
    completeOutputRequest({ error: `Could not open the output window: ${error.message}` });
  }

  const result = await resultPromise;

  if (result.ok) {
    for (const output of outputFiles) {
      logFileSave('completed', output.format, output.filename, 'downloads');
    }
    if (Number.isSafeInteger(outputWindowId)) {
      await chrome.windows.remove(outputWindowId).catch(() => {});
    }
  } else {
    for (const output of outputFiles) {
      logFileSave('failed', output.format, output.filename, 'downloads');
    }
  }
  return result;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function storedFrames() {
  const stored = await chrome.storage.local.get(null);
  const frames = Object.entries(stored)
    .filter(([key]) => key.startsWith(FRAME_PREFIX))
    .map(([, frame]) => frame);
  if (!frames.length && Array.isArray(stored[FRAMES_KEY])) frames.push(...stored[FRAMES_KEY]);
  return frames.sort(compareCaptureFlow);
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

function captureNote(value) {
  if (typeof value !== 'string') return null;
  const note = value.trim();
  return note.length <= 50 ? note : null;
}

async function setCaptureNote(sessionId, sequence, value) {
  const state = await getState();
  if ((!state.recording && !completedEvidenceFor(state)) || sessionId !== state.sessionId) return state;

  const normalizedSequence = Number(sequence);
  const note = captureNote(value);
  if (!Number.isSafeInteger(normalizedSequence) || normalizedSequence < 1) {
    return setState({ lastError: 'That screenshot is not available for a note.' });
  }
  if (note === null) {
    return setState({ lastError: 'Screenshot notes must be 50 characters or fewer.' });
  }

  const index = state.captures.findIndex((capture) => capture.sequence === normalizedSequence);
  if (index < 0) return setState({ lastError: 'That screenshot is not available for a note.' });

  const captures = [...state.captures];
  captures[index] = { ...captures[index], note };
  const key = `${FRAME_PREFIX}${normalizedSequence}`;
  const stored = await chrome.storage.local.get(key);
  const frame = stored[key];
  if (frame) await chrome.storage.local.set({ [key]: { ...frame, note } });
  return setState({ captures, lastError: null });
}

function outputPages(frames) {
  return frames.map((frame) => ({
    title: frame.title,
    note: frame.note,
    url: frame.url || '(URL not recorded)',
    time: frame.time || '(time not recorded)',
    apiRows: frame.apiRows || [],
    width: frame.width,
    height: frame.height,
    jpeg: base64ToBytes(frame.base64)
  }));
}

function outputBytes(format, pages) {
  return format === 'docx' ? buildDocx(pages) : buildPdf(pages);
}

function interimDownloadFilename(state) {
  return `${sessionDownloadDirectory(state)}/${INTERIM_OUTPUT_FILENAME}`;
}

function shouldQueueInterimOutput(sequence) {
  const interval = sequence <= 25 ? INTERIM_OUTPUT_CAPTURE_INTERVAL : sequence <= 100 ? 10 : 25;
  return sequence % interval === 0;
}

async function recordInterimOutputError(sessionId, error) {
  logLine(`INTERIM_OUTPUT_FAILED session=${sessionId} error=${error.message}`);
  await flushLog();
  const state = await getState().catch(() => null);
  if (state?.recording && state.sessionId === sessionId) {
    await setState({ interimOutputError: `Could not update the interim PDF: ${error.message}` });
  }
}

function queueInterimOutput(sessionId, requestedSequence) {
  if (queuedInterimOutputRequest?.sessionId === sessionId) {
    queuedInterimOutputRequest.requestedSequence = Math.max(
      queuedInterimOutputRequest.requestedSequence,
      requestedSequence
    );
  } else {
    queuedInterimOutputRequest = { sessionId, requestedSequence };
  }
  if (interimOutputRunning) return interimOutputChain;

  interimOutputRunning = true;
  interimOutputChain = interimOutputChain
    .catch(() => {})
    .then(async () => {
      try {
        while (queuedInterimOutputRequest) {
          const request = queuedInterimOutputRequest;
          queuedInterimOutputRequest = null;
          try {
            await writeInterimOutput(request.sessionId, request.requestedSequence);
          } catch (error) {
            await recordInterimOutputError(request.sessionId, error).catch(() => {});
          }
        }
      } finally {
        interimOutputRunning = false;
      }
    });
  return interimOutputChain;
}

async function writeInterimOutput(sessionId, requestedSequence) {
  const state = await getState();
  if (!state.recording || state.sessionId !== sessionId || state.sequence < requestedSequence) return null;

  const frames = await storedFrames();
  if (!frames.length) return null;

  const latestFrameSequence = Math.max(...frames.map(captureSequence));
  const previousSequence = Number(state.interimOutput?.captureSequence) || 0;
  if (state.interimOutput?.sessionId === sessionId && previousSequence >= latestFrameSequence) {
    return state.interimOutput;
  }

  const selectedFolder = savesToSelectedFolder(state)
    ? await writableSelectedCaptureFolder(state)
    : null;
  const filename = selectedFolder ? INTERIM_OUTPUT_FILENAME : interimDownloadFilename(state);
  logFileSave('requested', 'interim-pdf', filename, selectedFolder ? 'selected-folder' : 'downloads');
  try {
    const result = selectedFolder
      ? await writeCaptureFolderFile(selectedFolder, filename, outputBytes('pdf', outputPages(frames)))
      : await exportOutputsInWindow([{ format: 'pdf', filename, overwrite: true }]);
    if (result?.error) throw new Error(result.error);

    const latest = await getState();
    if (!latest.recording || latest.sessionId !== sessionId) return null;
    const next = await setState({
      interimOutput: {
        sessionId,
        filename: INTERIM_OUTPUT_FILENAME,
        destination: selectedFolder ? 'selected-folder' : 'downloads',
        downloadFilename: selectedFolder ? null : filename,
        downloadId: selectedFolder ? null : result.downloadIds?.at(-1) ?? null,
        captureCount: frames.length,
        captureSequence: latestFrameSequence,
        updatedAt: new Date().toISOString()
      },
      interimOutputError: null
    });
    logFileSave('completed', 'interim-pdf', filename, selectedFolder ? 'selected-folder' : 'downloads');
    logLine(`INTERIM_OUTPUT captures=${frames.length} file=${filename}`);
    return next.interimOutput;
  } catch (error) {
    logFileSave('failed', 'interim-pdf', filename, selectedFolder ? 'selected-folder' : 'downloads');
    throw error;
  }
}

async function exportOutputsToSelectedFolder(directoryHandle, outputFiles, excludedSequences) {
  const excluded = new Set(normalizeSequenceList(excludedSequences));
  const frames = (await storedFrames()).filter((frame) => !excluded.has(Number(frame.sequence)));
  if (!frames.length) return { error: 'No selected screenshots are available for the selected output.' };

  const pages = outputPages(frames);
  let currentOutput = null;
  try {
    for (const output of outputFiles) {
      currentOutput = output;
      await writeCaptureFolderFile(directoryHandle, output.filename, outputBytes(output.format, pages));
      logFileSave('completed', output.format, output.filename, 'selected-folder');
    }
  } catch (error) {
    if (currentOutput) {
      logFileSave('failed', currentOutput.format, currentOutput.filename, 'selected-folder');
    }
    throw normalizeFolderAccessError(error);
  }
  return { ok: true };
}

// Switches capture source mid-recording without stopping. The mode itself is committed to storage
// immediately and never blocks on anything - a previous version awaited the screen-share picker
// (which only resolves once the user picks a source, sometimes tens of seconds later) before
// committing the switch, and since that same long-lived promise held a stale settings snapshot,
// finishing it later could silently overwrite settings changed in the meantime. Opening the share
// window happens afterwards, best-effort; until (or unless) it succeeds, captures already fall back
// to the visible tab automatically because streamActive stays false.
async function switchCaptureMode(newMode) {
  const state = await getState();
  const previousMode = state.settings.captureMode;
  logLine(`MODE_SWITCH ${previousMode} -> ${newMode}`);
  // Persist immediately so a mode switch followed by a crash still leaves diagnostics available.
  await flushLog();
  if (previousMode === 'screen' && newMode !== 'screen') {
    await closeScreenWindow();
  }

  const next = await setState({
    streamActive: newMode === 'screen' ? false : state.streamActive,
    settings: { ...state.settings, captureMode: newMode, captureApi: newMode === 'api' }
  });
  await configureApiHooks(next.trackedTabIds, next.settings.captureApi);

  if (newMode === 'screen') {
    // The switch may have been triggered from a different tab (one the recording opened, DevTools,
    // etc.) - bring the recorded tab and its window back into focus first, since the share picker
    // needs a real click and someone looking at the wrong tab could easily miss that it appeared.
    await chrome.windows.update(state.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(state.tabId, { active: true }).catch(() => {});

    ensureOffscreen()
      .then(() => openScreenWindow())
      .then(async (result) => {
        if (result.error) {
          logLine(`MODE_SWITCH ${previousMode} -> screen failed: ${result.error}`);
          await flushLog();
          await setState({ lastError: `Could not switch to Screen/window mode: ${result.error}` });
          return;
        }
        // Only flip this on if the mode wasn't switched away again while the picker was open.
        const latest = await getState();
        if (latest.settings.captureMode === 'screen') {
          logLine('MODE_SWITCH screen share ready');
          await flushLog();
          await setState({ streamActive: true });
        }
      })
      .catch(async (error) => {
        logLine(`MODE_SWITCH ${previousMode} -> screen failed: ${error.message}`);
        await flushLog();
        await setState({ lastError: `Could not switch to Screen/window mode: ${error.message}` });
      });
  }

  return next;
}

const RECORDING_SCRIPT_TARGETS = [
  { files: ['page-hook.js'], world: 'MAIN' },
  { files: ['content.js'], world: 'ISOLATED' }
];

async function configureApiHookForTab(tabId, enabled) {
  if (!Number.isSafeInteger(tabId)) return;
  await chrome.tabs
    .sendMessage(tabId, { type: 'API_HOOK_CONFIG', enabled: Boolean(enabled) })
    .catch(() => {});
}

async function configureApiHooks(tabIds, enabled) {
  await Promise.all(normalizeIdList(tabIds).map((tabId) => configureApiHookForTab(tabId, enabled)));
}

async function injectRecordingScripts(tabId, captureApi = false) {
  if (!Number.isSafeInteger(tabId)) return;
  for (const script of RECORDING_SCRIPT_TARGETS) {
    await chrome.scripting
      .executeScript({ target: { tabId }, ...script })
      .catch(() => {
        /* Restricted pages (chrome://, Web Store) cannot be instrumented. */
      });
  }
  await chrome.tabs
    .sendMessage(tabId, { type: 'RECORDING_SESSION_STARTED' })
    .catch(() => {});
  await configureApiHookForTab(tabId, captureApi);
}

async function findRecoveryTab(preferredTabId) {
  if (Number.isSafeInteger(preferredTabId)) {
    const preferred = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (preferred?.active) return preferred;
  }
  const [lastFocused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (lastFocused) return lastFocused;
  const [anyActive] = await chrome.tabs.query({ active: true }).catch(() => []);
  return anyActive || null;
}

async function refreshRecoveredFolderAccess(state) {
  if (!savesToSelectedFolder(state) || state.folderAccessNeeded) return state;

  try {
    const directoryHandle = await getSavedCaptureFolder();
    if (directoryHandle?.name === state.outputFolder.name) return state;
  } catch {
    // The reconnect action gives the user a fresh native folder grant.
  }

  const next = await setState({
    folderAccessNeeded: true,
    lastError: folderPermissionError().message
  });
  logLine(`FOLDER_ACCESS_NEEDED folder=${state.outputFolder.name}`);
  return next;
}

// Chrome preserves extension storage across a browser restart, but tab and window IDs belong to
// the old browser process. Rebind the active recording to a live tab before accepting new captures.
async function recoverRecordingSession(preferredTabId, force = false) {
  await browserRestartInterruptionChain;
  sessionRecoveryChain = sessionRecoveryChain
    .catch(() => {})
    .then(async () => {
      const state = await getState();
      if (!state.recording) {
        sessionRecoveryPending = false;
        recoveredSessionId = null;
        return state;
      }

      const shouldCheckTarget = force || sessionRecoveryPending || recoveredSessionId !== state.sessionId;
      if (!shouldCheckTarget) return state;

      const currentTab = sessionRecoveryPending
        ? null
        : await chrome.tabs.get(state.tabId).catch(() => null);
      if (currentTab) {
        recoveredSessionId = state.sessionId;
        return refreshRecoveredFolderAccess(state);
      }

      const tab = await findRecoveryTab(preferredTabId);
      if (!Number.isSafeInteger(tab?.id) || !state.sessionId) {
        sessionRecoveryPending = true;
        return state;
      }

      const captureGeneration = state.captureGeneration + 1;
      await chrome.storage.local.set({
        [SESSION_CONTROL_KEY]: {
          sessionId: state.sessionId,
          paused: state.paused,
          captureGeneration
        }
      });
      await replaceSessionTracking(state.sessionId, [tab.id], [tab.windowId]);
      await setState({
        tabId: tab.id,
        windowId: tab.windowId,
        apiHookReady: false,
        streamActive: false,
        screenWindowId: null,
        fullPageProgress: null,
        lastError: null
      });
      await injectRecordingScripts(tab.id, state.settings.captureApi);
      sessionRecoveryPending = false;
      recoveredSessionId = state.sessionId;
      logLine(`SESSION_RECOVERED tabId=${tab.id} url=${shortUrl(tab.url || '')}`);
      return refreshRecoveredFolderAccess(await getState());
    });
  return sessionRecoveryChain;
}

async function startRecording(tab, settings, outputFolderName = null, requestedSessionFolderName = null) {
  await interimOutputChain.catch(() => {});
  const startedAt = new Date();
  const sessionId = `session_${fileTimestamp(startedAt)}`;
  const sessionFolderName = sanitize(requestedSessionFolderName || defaultSessionFolderName(startedAt), 100);
  await chrome.storage.local.remove(LOG_KEY).catch(() => {});
  await chrome.storage.local.remove(PDF_EXCLUSIONS_KEY).catch(() => {});
  await chrome.storage.local.remove(SESSION_CONTROL_KEY).catch(() => {});
  await clearSessionTracking();
  await clearStoredFrames();
  captureRequestSequence = 0;
  await setState({
    lastError: null,
    pendingResumeFolder: null,
    completedEvidence: null,
    interruptedRecording: null,
    interimOutput: null,
    interimOutputError: null
  });
  await setDownloadUi(false);
  apiQueue = [];
  lastRawCaptureHash = '';
  lastTabTitles.clear();
  pendingUserActionCaptures.clear();
  pendingNavigationTabIds.clear();
  lastTabTitles.set(tab.id, tab.title || '');

  const merged = { ...defaultState.settings, ...(await getState()).settings, ...settings };
  merged.captureApi = merged.captureMode === 'api';
  let streamActive = false;

  try {
    await ensureOffscreen();

    if (merged.captureMode === 'screen') {
      const result = await openScreenWindow();
      if (result.error) throw new Error(result.error);
      streamActive = true;
    }
  } catch (error) {
    await closeScreenWindow();
    await closeOffscreen();
    await setDownloadUi(true);
    return await setState({ recording: false, streamActive: false, lastError: error.message });
  }

  await chrome.storage.local.set({
    [SESSION_CONTROL_KEY]: { sessionId, paused: false, captureGeneration: 0 }
  });
  await replaceSessionTracking(sessionId, [tab.id], [tab.windowId]);
  const state = await setState({
    recording: true,
    paused: false,
    captureGeneration: 0,
    tabId: tab.id,
    windowId: tab.windowId,
    sessionId,
    sessionFolderName,
    sequence: 0,
    captures: [],
    pdfExcludedSequences: [],
    trackedTabIds: [tab.id],
    trackedWindowIds: [tab.windowId],
    downloadIds: [],
    outputFolder: outputFolderName ? { name: outputFolderName } : null,
    folderWrittenFiles: [],
    folderAccessNeeded: false,
    apiSeen: 0,
    apiHookReady: false,
    streamActive,
    fullPageProgress: null,
    lastError: null,
    completedEvidence: null,
    interruptedRecording: null,
    interimOutput: null,
    interimOutputError: null,
    settings: merged
  });
  sessionRecoveryPending = false;
  recoveredSessionId = sessionId;

  // The declared content scripts only load on navigation, so seed the already-open page.
  await injectRecordingScripts(tab.id, merged.captureApi);

  await updateBadge(state);
  logLine(
    `SESSION_START mode=${merged.captureMode} folder=${outputFolderName || sessionFolderName} url=${shortUrl(tab.url || '')}`
  );
  await captureNow('start');
  return getState();
}

async function restoreFolderFrames(captures) {
  const restoredCaptures = [];
  const skippedFiles = [];
  for (const { fileHandle, entry } of captures) {
    let dataUrl;
    let processed;
    try {
      dataUrl = await imageFileToDataUrl(fileHandle);
      processed = await askOffscreen('OFFSCREEN_PROCESS', {
        dataUrl,
        titleBar: null,
        wantPng: false,
        wantJpeg: true,
        apiRows: []
      });
      if (processed?.error || !processed?.jpeg) {
        throw new Error(processed?.error || `Could not load ${fileHandle.name}.`);
      }
    } catch (error) {
      skippedFiles.push(fileHandle.name);
      logLine(`FOLDER_RESTORE_SKIPPED file=${fileHandle.name} error=${error?.message || 'unreadable image'}`);
      continue;
    } finally {
      dataUrl = null;
    }

    await storeFrame({
      sequence: entry.sequence,
      title: entry.title,
      note: entry.note || '',
      url: entry.url,
      time: `${entry.actionAt || entry.capturedAt}  |  ${entry.reason}  |  resumed folder`,
      actionAt: entry.actionAt || entry.capturedAt,
      requestSequence: entry.requestSequence || entry.sequence,
      apiRows: [],
      base64: processed.jpeg.base64,
      width: processed.jpeg.width,
      height: processed.jpeg.height
    });
    restoredCaptures.push({ fileHandle, entry });
  }
  return { captures: restoredCaptures, skippedFiles };
}

async function prepareResumeFromFolder() {
  const state = await recoverRecordingSession(undefined, true);
  if (state.recording) return setState({ lastError: 'Stop the current recording before selecting a resume folder.' });

  const folder = await writableCaptureFolder();
  return setState({
    pendingResumeFolder: { name: folder.name || 'selected folder' },
    lastError: null
  });
}

async function resumeRecordingFromFolder(tab, settings) {
  await interimOutputChain.catch(() => {});
  const folder = await writableCaptureFolder();
  const restored = await scanCaptureFolder(folder);
  if (!restored.captures.length) {
    const started = await startRecording(tab, { ...settings, savePng: true }, restored.folderName);
    return started.recording ? { ...started, notice: EMPTY_CAPTURE_FOLDER_NOTICE } : started;
  }

  const sessionId = String(restored.sessionId || '').trim() || `resumed_${fileTimestamp(new Date())}`;
  const merged = {
    ...defaultState.settings,
    ...(await getState()).settings,
    ...settings,
    captureMode: settings?.captureMode || 'tab',
    savePng: true,
    savePdf: true
  };
  merged.captureApi = merged.captureMode === 'api';
  let streamActive = false;
  let restoredFrames;

  await chrome.storage.local.remove(LOG_KEY).catch(() => {});
  await chrome.storage.local.remove(PDF_EXCLUSIONS_KEY).catch(() => {});
  await chrome.storage.local.remove(SESSION_CONTROL_KEY).catch(() => {});
  await clearSessionTracking();
  await clearStoredFrames();
  await setState({
    lastError: null,
    completedEvidence: null,
    interruptedRecording: null,
    interimOutput: null,
    interimOutputError: null
  });
  await setDownloadUi(false);
  apiQueue = [];
  lastRawCaptureHash = '';
  lastTabTitles.clear();
  lastTabTitles.set(tab.id, tab.title || '');

  try {
    await ensureOffscreen();
    if (merged.captureMode === 'screen') {
      const result = await openScreenWindow();
      if (result.error) throw new Error(result.error);
      streamActive = true;
    }
    restoredFrames = await restoreFolderFrames(restored.captures);
  } catch (error) {
    await closeScreenWindow();
    await closeOffscreen();
    await clearStoredFrames();
    await setDownloadUi(true);
    return setState({
      recording: false,
      streamActive: false,
      outputFolder: null,
      pendingResumeFolder: null,
      folderWrittenFiles: [],
      folderAccessNeeded: false,
      lastError: error.message
    });
  }

  if (!restoredFrames.captures.length) {
    await closeScreenWindow();
    await closeOffscreen();
    const started = await startRecording(tab, { ...settings, savePng: true }, restored.folderName);
    return started.recording ? { ...started, notice: NO_READABLE_CAPTURE_FOLDER_NOTICE } : started;
  }

  await chrome.storage.local.set({
    [SESSION_CONTROL_KEY]: { sessionId, paused: false, captureGeneration: 0 }
  });
  await replaceSessionTracking(sessionId, [tab.id], [tab.windowId]);
  captureRequestSequence = Math.max(
    captureRequestSequence,
    ...restoredFrames.captures.map(({ entry }) => Number(entry.requestSequence) || Number(entry.sequence) || 0)
  );
  const state = await setState({
    recording: true,
    paused: false,
    captureGeneration: 0,
    tabId: tab.id,
    windowId: tab.windowId,
    sessionId,
    sequence: restored.nextSequence - 1,
    captures: restoredFrames.captures.map(({ entry }) => entry).slice(-300),
    pdfExcludedSequences: [],
    trackedTabIds: [tab.id],
    trackedWindowIds: [tab.windowId],
    downloadIds: [],
    outputFolder: { name: restored.folderName },
    pendingResumeFolder: null,
    completedEvidence: null,
    interruptedRecording: null,
    interimOutput: null,
    interimOutputError: null,
    folderWrittenFiles: [],
    folderAccessNeeded: false,
    apiSeen: 0,
    apiHookReady: false,
    streamActive,
    fullPageProgress: null,
    lastError: null,
    settings: merged
  });
  sessionRecoveryPending = false;
  recoveredSessionId = sessionId;

  await injectRecordingScripts(tab.id, merged.captureApi);
  await updateBadge(state);
  logLine(`SESSION_RESUMED folder=${restored.folderName} captures=${restoredFrames.captures.length}`);
  await captureNow('start');
  const resumed = await getState();
  return restoredFrames.skippedFiles.length
    ? { ...resumed, notice: skippedUnreadableCaptureNotice(restoredFrames.skippedFiles.length) }
    : resumed;
}

async function reconnectCaptureFolder() {
  const state = await recoverRecordingSession();
  if (!state.recording || !hasSelectedCaptureFolder(state)) {
    return setState({ lastError: 'There is no folder-backed recording to reconnect.' });
  }

  const directoryHandle = await writableCaptureFolder();
  if (directoryHandle.name !== state.outputFolder.name) {
    return setState({
      folderAccessNeeded: true,
      lastError: `Choose the original "${state.outputFolder.name}" capture folder to continue.`
    });
  }

  const restored = await scanCaptureFolder(directoryHandle).catch(() => null);
  const next = await setState({ folderAccessNeeded: false, lastError: null });
  logLine(`FOLDER_RECONNECTED folder=${directoryHandle.name}`);
  return restored && !restored.captures.length
    ? { ...next, notice: EMPTY_CAPTURE_FOLDER_NOTICE }
    : next;
}

async function deleteSessionDownloads(ids) {
  for (const id of ids) {
    await chrome.downloads.removeFile(id).catch(() => {
      /* Already gone or never written. */
    });
    await chrome.downloads.erase({ id }).catch(() => {});
  }
}

async function removeInterimOutput(state, interimOutput, directoryHandle = null) {
  if (!interimOutput || interimOutput.sessionId !== state.sessionId) return false;
  if (interimOutput.destination === 'selected-folder') {
    await removeCaptureFolderFiles(
      directoryHandle || await writableSelectedCaptureFolder(state),
      [interimOutput.filename]
    );
  } else if (interimOutput.destination === 'downloads' && Number.isSafeInteger(interimOutput.downloadId)) {
    await deleteSessionDownloads([interimOutput.downloadId]);
  } else {
    return false;
  }
  logLine(`INTERIM_OUTPUT_REMOVED session=${state.sessionId}`);
  return true;
}

function normalizeOutputFormats(value, settings = {}) {
  if (Array.isArray(value)) {
    const formats = new Set(value.map((format) => String(format).toLowerCase()));
    return { pdf: formats.has('pdf'), docx: formats.has('docx') };
  }
  if (value && typeof value === 'object') {
    return { pdf: value.pdf === true, docx: value.docx === true };
  }
  return { pdf: settings.savePdf !== false, docx: false };
}

function hasOutputFormat(formats) {
  return formats.pdf || formats.docx;
}

function outputLabel(formats) {
  if (formats.pdf && formats.docx) return 'output files';
  return formats.docx ? 'Word document' : 'PDF';
}

function requestedOutputLabel(value) {
  const formats = normalizeOutputFormats(value, { savePdf: true });
  return hasOutputFormat(formats) ? outputLabel(formats) : 'output files';
}

function outputFilenameBase(value, fallback) {
  const base = String(value || fallback)
    .trim()
    .replace(/\.(?:pdf|docx)$/i, '');
  return sanitize(base, 120) || sanitize(fallback, 120);
}

function outputFilesFor(value, fallback, formats) {
  const base = outputFilenameBase(value, fallback);
  return [
    ...(formats.pdf ? [{ format: 'pdf', filename: `${base}.pdf` }] : []),
    ...(formats.docx ? [{ format: 'docx', filename: `${base}.docx` }] : [])
  ];
}

function missingFolderFile(error) {
  return error?.name === 'NotFoundError' || /(?:no file named|not found)/i.test(String(error?.message || ''));
}

async function folderOutputFileExists(directoryHandle, filename) {
  try {
    await directoryHandle.getFileHandle(filename);
    return true;
  } catch (error) {
    if (missingFolderFile(error)) return false;
    throw normalizeFolderAccessError(error);
  }
}

async function downloadedOutputFileExists(filename) {
  if (typeof chrome.downloads?.search !== 'function') return false;
  try {
    const relativeFilename = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativeFilename) return false;
    const downloads = await chrome.downloads.search({});
    return downloads.some((download) => {
      const downloadedName = String(download?.filename || '').replace(/\\/g, '/');
      return downloadedName === relativeFilename || downloadedName.endsWith(`/${relativeFilename}`);
    });
  } catch {
    return false;
  }
}

function versionedEvidenceBase(base, timestamp, index) {
  const suffix = `_${timestamp}${index ? `_${index + 1}` : ''}`;
  return `${base.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
}

function evidenceDownloadDirectory(evidence) {
  return evidence.downloadDirectory || sessionDownloadDirectory(evidence);
}

async function evidenceOutputFiles(requestedOutputFilename, evidence, formats, directoryHandle) {
  const fallback = `${evidence.sessionId}_evidence`;
  const base = outputFilenameBase(requestedOutputFilename, fallback);
  const downloadDirectory = evidenceDownloadDirectory(evidence);
  const hasNameConflict = async (outputFiles) => {
    const checks = outputFiles.map((output) => (
      directoryHandle
        ? folderOutputFileExists(directoryHandle, output.filename)
        : downloadedOutputFileExists(`${downloadDirectory}/${output.filename}`)
    ));
    return (await Promise.all(checks)).some(Boolean);
  };

  let outputFiles = outputFilesFor(base, fallback, formats);
  if (!(await hasNameConflict(outputFiles))) return outputFiles;

  const timestamp = fileTimestamp(new Date());
  for (let index = 0; index < 100; index += 1) {
    outputFiles = outputFilesFor(versionedEvidenceBase(base, timestamp, index), fallback, formats);
    if (!(await hasNameConflict(outputFiles))) return outputFiles;
  }
  throw new Error('Could not choose an unused evidence document name.');
}

function savedOutputFields(outputFiles) {
  const savedOutputFilenames = outputFiles.map((output) => output.filename);
  const savedPdfFilename = outputFiles.find((output) => output.format === 'pdf')?.filename;
  return {
    savedOutputFilenames,
    ...(savedPdfFilename ? { savedPdfFilename } : {})
  };
}

async function revealSavedFiles(downloadId) {
  let showError = null;
  try {
    if (Number.isSafeInteger(downloadId) && typeof chrome.downloads?.show === 'function') {
      await chrome.downloads.show(downloadId);
      return { opened: true, fallback: false };
    }
  } catch (error) {
    showError = error;
    console.warn('Could not open the downloaded file location:', error.message);
  }
  try {
    if (typeof chrome.downloads?.showDefaultFolder !== 'function') {
      throw showError || new Error('The browser cannot open the Downloads folder.');
    }
    await chrome.downloads.showDefaultFolder();
    return { opened: true, fallback: true };
  } catch (error) {
    console.warn('Could not open the download folder:', error.message);
    return { opened: false, fallback: Boolean(showError), error: error.message };
  }
}

async function waitForDownloadCompletion(downloadId) {
  if (
    !Number.isSafeInteger(downloadId) ||
    typeof chrome.downloads?.onChanged?.addListener !== 'function'
  ) {
    return null;
  }

  return new Promise((resolve) => {
    let finished = false;
    let timer = 0;
    const finish = (state = null) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(state);
    };
    const onChanged = (change) => {
      const downloadState = change?.state?.current;
      if (change?.id === downloadId && downloadState && downloadState !== 'in_progress') {
        finish(downloadState);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => finish('timed_out'), 120000);

    if (typeof chrome.downloads.search === 'function') {
      chrome.downloads.search({ id: downloadId }).then((items) => {
        if (items[0]?.state && items[0].state !== 'in_progress') finish(items[0].state);
      }).catch(() => {});
    }
  });
}

// Writes selected document formats from whatever has been captured so far without stopping the recording - a checkpoint
// the user can hand off or review while the same session keeps adding to the same numbered sequence.
// Unlike the final export, the folder is not opened here - only the final save should interrupt the
// user, since this can happen many times over the course of one recording.
async function exportOutputNow(requestedOutputFilename, outputFormats, excludedSequences) {
  if (apiQueue.length) await captureNow('final-api-calls');
  await captureChain.catch(() => {});

  const state = await getState();
  if (!state.recording) return setState({ lastError: 'Not currently recording.' });
  if (!state.captures.length) return setState({ lastError: 'Nothing captured yet.' });
  const excluded = Array.isArray(excludedSequences)
    ? normalizeSequenceList(excludedSequences)
    : normalizeSequenceList(state.pdfExcludedSequences);
  const formats = normalizeOutputFormats(outputFormats, state.settings);
  if (!hasOutputFormat(formats)) {
    return setState({ lastError: 'Choose PDF, Word, or both before saving.' });
  }
  logLine(`OUTPUT_EXPORT checkpoint formats=${Object.entries(formats).filter(([, enabled]) => enabled).map(([format]) => format).join(',')} excluded=${excluded.length} captures=${state.captures.length}`);

  const outputFiles = outputFilesFor(
    requestedOutputFilename,
    `${state.sessionId}_checkpoint`,
    formats
  );
  const selectedFolder = hasSelectedCaptureFolder(state)
    ? await writableSelectedCaptureFolder(state)
    : null;
  const result = selectedFolder
    ? await exportOutputsToSelectedFolder(selectedFolder, outputFiles, excluded)
    : await exportOutputsInWindow(
      outputFiles.map((output) => ({
        ...output,
        filename: `${sessionDownloadDirectory(state)}/${output.filename}`
      })),
      excluded
    );
  await flushLog();
  if (result.error) {
    return setState({ lastError: `${outputLabel(formats)} export failed: ${result.error}` });
  }
  return {
    ...(await setState({ lastError: null, ...(selectedFolder ? { folderAccessNeeded: false } : {}) })),
    ...savedOutputFields(outputFiles)
  };
}

function checkpointOutputFilename(sessionId) {
  return `${sessionId}_checkpoint_${fileTimestamp(new Date())}`;
}

async function saveFlow(requestedOutputFilename, excludedSequences, outputFormats) {
  const state = await recoverRecordingSession(undefined, true);
  if (!state.recording) return setState({ lastError: 'Not currently recording.' });
  return exportOutputNow(
    requestedOutputFilename || checkpointOutputFilename(state.sessionId),
    outputFormats,
    excludedSequences
  );
}

async function generateEvidence(requestedOutputFilename, excludedSequences, outputFormats) {
  const state = await getState();
  if (state.recording) {
    return setState({ lastError: 'Stop the recording before generating evidence documents.' });
  }
  const evidence = completedEvidenceFor(state);
  if (!evidence) {
    return setState({ lastError: 'There is no completed recording available for evidence generation.' });
  }
  if (!(await storedFrames()).length) {
    return setState({ lastError: 'The completed screenshots are no longer available for evidence generation.' });
  }

  const formats = normalizeOutputFormats(outputFormats, state.settings);
  if (!hasOutputFormat(formats)) {
    return setState({ lastError: 'Choose PDF, Word, or both before generating evidence.' });
  }
  const excluded = Array.isArray(excludedSequences)
    ? normalizeSequenceList(excludedSequences)
    : normalizeSequenceList(state.pdfExcludedSequences);
  const selectedFolder = evidence.outputFolderName
    ? await writableCompletedEvidenceFolder(evidence)
    : null;
  const outputFiles = await evidenceOutputFiles(
    requestedOutputFilename,
    evidence,
    formats,
    selectedFolder
  );
  logLine(`EVIDENCE_EXPORT formats=${Object.entries(formats).filter(([, enabled]) => enabled).map(([format]) => format).join(',')} excluded=${excluded.length}`);

  // Evidence is generated after the recording ended, when the normal recording-level download
  // suppression has already been restored. Keep Chrome's download UI hidden until the exporter
  // confirms every requested document is complete; the popup toast is the user-facing feedback.
  if (!selectedFolder) await setDownloadUi(false);
  try {
    const result = selectedFolder
      ? await exportOutputsToSelectedFolder(selectedFolder, outputFiles, excluded)
      : await exportOutputsInWindow(
        outputFiles.map((output) => ({
          ...output,
          filename: `${evidenceDownloadDirectory(evidence)}/${output.filename}`
        })),
        excluded
      );
    await flushLog();
    if (result.error) {
      return setState({ lastError: `${outputLabel(formats)} evidence generation failed: ${result.error}` });
    }
    let interimOutput = state.interimOutput;
    let interimOutputError = state.interimOutputError;
    try {
      if (await removeInterimOutput(state, interimOutput, selectedFolder)) {
        interimOutput = null;
        interimOutputError = null;
      }
    } catch (error) {
      interimOutputError = `Could not remove the interim PDF: ${error.message}`;
      logLine(`INTERIM_OUTPUT_REMOVE_FAILED error=${error.message}`);
    }
    return {
      ...(await setState({
        lastError: null,
        interimOutput,
        interimOutputError,
        ...(selectedFolder ? { folderAccessNeeded: false } : {})
      })),
      ...savedOutputFields(outputFiles)
    };
  } finally {
    if (!selectedFolder) await setDownloadUi(true);
  }
}

async function setRecordingPaused(paused) {
  const state = await recoverRecordingSession(undefined, true);
  if (!state.recording) return setState({ lastError: 'Not currently recording.' });
  if (state.paused === paused) return state;

  await chrome.storage.local.set({
    [SESSION_CONTROL_KEY]: {
      sessionId: state.sessionId,
      paused,
      captureGeneration: paused ? state.captureGeneration + 1 : state.captureGeneration
    }
  });
  if (paused) {
    logLine(`SESSION_PAUSED captures=${state.captures.length}`);
  } else {
    logLine(`SESSION_CONTINUED captures=${state.captures.length}`);
  }

  const next = await setState({ lastError: null });
  await updateBadge(next);
  await flushLog();
  return next;
}

async function stopRecording(
  keepFiles = true,
  requestedOutputFilename,
  excludedSequences,
  reveal = false,
  createPdf = true,
  outputFormats
) {
  const stateBeforeStop = await getState();
  const capturesWerePending = pendingCaptureCount > 0;
  if (capturesWerePending && stateBeforeStop.recording && stateBeforeStop.sessionId) {
    await chrome.storage.local.set({
      [SESSION_CONTROL_KEY]: {
        sessionId: stateBeforeStop.sessionId,
        paused: true,
        captureGeneration: stateBeforeStop.captureGeneration + 1
      }
    });
    cancelCaptureRequest(stateBeforeStop.sessionId, stateBeforeStop.captureGeneration);
    logLine(`CAPTURE_CANCELLED stop pending=${pendingCaptureCount}`);
    await clearFullPageProgress(stateBeforeStop.tabId);
  }

  // Anything still queued would be lost, so give it a final frame to sit under.
  if (keepFiles && apiQueue.length && !capturesWerePending) {
    await captureNow('final-api-calls');
  }
  if (capturesWerePending) {
    let drainTimer;
    try {
      const drained = await Promise.race([
        captureChain.then(() => true, () => true),
        new Promise((resolve) => {
          drainTimer = setTimeout(() => resolve(false), STOP_CAPTURE_DRAIN_MS);
        })
      ]);
      if (!drained) logLine(`CAPTURE_DRAIN_TIMEOUT stop after=${STOP_CAPTURE_DRAIN_MS}ms`);
    } finally {
      clearTimeout(drainTimer);
    }
  } else {
    await captureChain.catch(() => {});
  }
  await interimOutputChain.catch(() => {});
  const state = await getState();
  if (keepFiles) await setDownloadUi(false);
  logLine(`SESSION_END keepFiles=${keepFiles} createPdf=${createPdf} captures=${state.captures.length}`);
  await configureApiHooks(state.trackedTabIds, false);
  const excluded = Array.isArray(excludedSequences)
    ? normalizeSequenceList(excludedSequences)
    : normalizeSequenceList(state.pdfExcludedSequences);
  const savedToFolder = hasSelectedCaptureFolder(state);
  const completedEvidence = state.recording && keepFiles && state.captures.length
    ? {
        sessionId: state.sessionId,
        captureCount: state.captures.length,
        outputFolderName: savedToFolder ? state.outputFolder?.name || null : null,
        downloadDirectory: savedToFolder ? null : sessionDownloadDirectory(state),
        completedAt: new Date().toISOString()
      }
    : null;
  const deletedFileCount = savedToFolder ? state.folderWrittenFiles.length : state.downloadIds.length;
  let lastError = null;
  let revealId = state.downloadIds[state.downloadIds.length - 1];
  let outputFiles = [];
  let fileLocationResult = null;
  let interimOutput = state.interimOutput;
  let interimOutputError = state.interimOutputError;

  if (!keepFiles) {
    if (savedToFolder) {
      try {
        await removeCaptureFolderFiles(await writableSelectedCaptureFolder(state), state.folderWrittenFiles);
      } catch (error) {
        lastError = `Could not remove new screenshots: ${error.message}`;
      }
    } else {
      await deleteSessionDownloads(state.downloadIds);
    }
    try {
      if (await removeInterimOutput(state, interimOutput)) {
        interimOutput = null;
        interimOutputError = null;
      }
    } catch (error) {
      interimOutputError = `Could not remove the interim PDF: ${error.message}`;
      logLine(`INTERIM_OUTPUT_REMOVE_FAILED error=${error.message}`);
    }
  } else {
    const formats = normalizeOutputFormats(outputFormats, state.settings);
    if (createPdf && hasOutputFormat(formats) && state.captures.length) {
      logLine(`OUTPUT_EXPORT final formats=${Object.entries(formats).filter(([, enabled]) => enabled).map(([format]) => format).join(',')} excluded=${excluded.length} captures=${state.captures.length}`);
      outputFiles = outputFilesFor(requestedOutputFilename, state.sessionId, formats);
      const result = savedToFolder
        ? await exportOutputsToSelectedFolder(await writableSelectedCaptureFolder(state), outputFiles, excluded)
        : await exportOutputsInWindow(
          outputFiles.map((output) => ({
            ...output,
            filename: `${sessionDownloadDirectory(state)}/${output.filename}`
          })),
          excluded
        );
      if (result.error) {
        lastError = `${outputLabel(formats)} export failed: ${result.error}`;
        console.error(lastError);
        outputFiles = [];
      } else if (typeof result.downloadIds?.at(-1) === 'number') {
        revealId = result.downloadIds.at(-1);
      }
    }

    if (state.captures.length) {
      const manifestFilename = savedToFolder
        ? 'flow-manifest.json'
        : `${sessionDownloadDirectory(state)}/flow-manifest.json`;
      const manifestDestination = savedToFolder ? 'selected-folder' : 'downloads';
      logFileSave('requested', 'manifest', manifestFilename, manifestDestination);
      const manifestCaptures = [...state.captures].sort(compareCaptureFlow);
      const manifest = {
        sessionId: state.sessionId,
        startedAt: manifestCaptures[0]?.actionAt ?? manifestCaptures[0]?.capturedAt ?? null,
        endedAt: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        captureMode: state.settings.captureMode,
        screenshotCount: state.captures.length,
        screenshots: manifestCaptures,
        debugLog: await readDebugLog()
      };
      const manifestUrl =
        'data:application/json;base64,' +
        btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
      if (savedToFolder) {
        try {
          await writeCaptureFolderFile(
            await writableSelectedCaptureFolder(state),
            manifestFilename,
            JSON.stringify(manifest, null, 2)
          );
          logFileSave('completed', 'manifest', manifestFilename, manifestDestination);
        } catch (error) {
          logFileSave('failed', 'manifest', manifestFilename, manifestDestination);
          throw error;
        }
      } else {
        const manifestDownloadId = await downloadWithHiddenUi({
          url: manifestUrl,
          filename: manifestFilename,
          saveAs: false
        });
        const downloadState = await waitForDownloadCompletion(manifestDownloadId);
        logFileSave(
          downloadState === 'complete' ? 'completed' : downloadState || 'requested',
          'manifest',
          manifestFilename,
          manifestDestination
        );
        if (typeof revealId !== 'number') revealId = manifestDownloadId;
      }
    }
  }

  if (keepFiles && createPdf && outputFiles.length && !lastError) {
    try {
      if (await removeInterimOutput(state, interimOutput)) {
        interimOutput = null;
        interimOutputError = null;
      }
    } catch (error) {
      interimOutputError = `Could not remove the interim PDF: ${error.message}`;
      logLine(`INTERIM_OUTPUT_REMOVE_FAILED error=${error.message}`);
    }
  }

  // Keep the browser download UI hidden until the final document has been revealed.
  await cleanupCaptureResources({
    restoreDownloadUi: false,
    clearFrames: !completedEvidence,
    clearSessionControl: false
  });

  await flushLog();
  const shouldRevealSavedFiles = keepFiles && reveal && state.captures.length;

  const next = await setState({
    recording: false,
    paused: false,
    captureGeneration: 0,
    tabId: null,
    windowId: null,
    streamActive: false,
    fullPageProgress: null,
    downloadIds: [],
    outputFolder: null,
    pendingResumeFolder: null,
    completedEvidence,
    interruptedRecording: null,
    interimOutput,
    interimOutputError,
    folderWrittenFiles: [],
    folderAccessNeeded: false,
    lastError:
      lastError ?? (keepFiles ? null : `Deleted ${deletedFileCount} file(s) from this session.`)
  });
  await chrome.storage.local.remove(SESSION_CONTROL_KEY).catch(() => {});
  try {
    await updateBadge(next);
    // The output is complete before the recording is marked stopped, then its folder is revealed.
    // File System Access handles do not expose a native path. For a selected capture folder,
    // opening Downloads is the closest location browser extensions may reveal.
    if (shouldRevealSavedFiles) {
      fileLocationResult = await revealSavedFiles(savedToFolder ? undefined : revealId);
    }
    return {
      ...next,
      ...(outputFiles.length ? savedOutputFields(outputFiles) : {}),
      ...(fileLocationResult
        ? {
            fileLocationOpened: fileLocationResult.opened,
            fileLocationFallback: fileLocationResult.fallback,
            ...(fileLocationResult.error ? { fileLocationError: fileLocationResult.error } : {})
          }
        : {})
    };
  } finally {
    await setDownloadUi(true);
  }
}

async function openOutputDialog(mode) {
  const state = await recoverRecordingSession(undefined, true);
  if (!state.recording) return setState({ lastError: 'Not currently recording.' });
  if (!state.captures.length) return setState({ lastError: 'Nothing captured yet.' });

  const acceptedMode = ['checkpoint', 'final'].includes(mode)
    ? mode
    : 'checkpoint';
  const params = new URLSearchParams({ mode: acceptedMode });
  await chrome.windows.create({
    url: `output-dialog.html?${params}`,
    type: 'popup',
    width: 390,
    height: 370,
    focused: true
  });
  return state;
}

/* ---------------------------------------------------------------- listeners */

async function isRecordedTab(tabId) {
  const state = await recoverRecordingSession(tabId);
  return state.recording && state.trackedTabIds.includes(tabId);
}

// Whichever of the session's tabs the user is actually looking at is the one background-driven
// captures (navigation, title changes, the manual hotkey, "Capture now") should act on - this is
// what lets switching back and forth between a parent tab and a child tab it opened keep capturing
// from both, instead of staying stuck on whichever tab the recording happened to start on.
async function adoptActiveTab(tabId) {
  const state = await getState();
  if (!state.recording || tabId === state.tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  logLine(`ACTIVE_TAB now tabId=${tabId} url=${shortUrl(tab.url || '')}`);
  await trackSessionTab(state, tab);
  await setState({ tabId, windowId: tab.windowId });
}

async function trackAndFocusNewTab(state, tab) {
  await trackSessionTab(state, tab);
  logLine(`NEW_TAB opened from recorded tab (tabId=${tab.id}), bringing it into focus`);
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

async function captureRecordedPageEvent(details, reason, label, expectedTitle = '') {
  const state = await recoverRecordingSession(details.tabId);
  if (!state.recording || !state.trackedTabIds.includes(details.tabId)) return;
  const capture = captureNow(reason, label, state, undefined, {
    tabId: details.tabId,
    actionAt: Date.now(),
    expectedUrl: details.url || '',
    expectedTitle
  });
  await adoptActiveTab(details.tabId);
  await capture;
}

async function captureCommittedNavigation(details, reason = 'navigation') {
  if (hasPendingUserActionCapture(details.tabId)) {
    logLine(`NAVIGATION_FOLLOWUP tabId=${details.tabId} reason=${reason} url=${shortUrl(details.url || '')}`);
  }
  pendingNavigationTabIds.add(details.tabId);
  try {
    await captureRecordedPageEvent(details, reason);
  } finally {
    pendingNavigationTabIds.delete(details.tabId);
  }
}

// Queue a real document transition as soon as Chrome commits its URL. Waiting for onCompleted can
// miss the transition behind a long full-page capture, and can also report a late completion for
// the page that was already captured manually.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const qualifiers = Array.isArray(details.transitionQualifiers) ? details.transitionQualifiers : [];
  const reason = details.transitionType === 'reload'
    ? 'refresh'
    : qualifiers.includes('forward_back')
      ? 'history-navigation'
      : details.transitionType === 'typed' || details.transitionType === 'generated'
        ? 'typed-navigation'
        : 'navigation';
  await captureCommittedNavigation(details, reason);
});

// Single-page apps change routes without a full page load.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId === 0) await captureCommittedNavigation(details, 'url-change');
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details) => {
  if (details.frameId === 0) await captureCommittedNavigation(details, 'url-change');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.title || changeInfo.title === lastTabTitles.get(tabId)) return;
  lastTabTitles.set(tabId, changeInfo.title);
  if (pendingNavigationTabIds.has(tabId)) return;
  const state = await recoverRecordingSession(tabId);
  if (!state.recording || !state.trackedTabIds.includes(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const capture = captureNow('title-change', changeInfo.title, state, undefined, {
    tabId,
    actionAt: Date.now(),
    expectedUrl: tab?.url || '',
    expectedTitle: changeInfo.title
  });
  await adoptActiveTab(tabId);
  await capture;
});

// Manually switching back to a tab the recording already knows about (the original tab, or a child
// tab it opened) should resume capturing there too, not leave the recording pointed at whichever one
// last had activity.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (await isRecordedTab(tabId)) await adoptActiveTab(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  lastTabTitles.delete(tabId);
  const state = await recoverRecordingSession();
  if (!state.recording) return;
  await untrackSessionTab(state, tabId);
  const latest = await getState();
  if (tabId === latest.tabId) {
    // The active tab closed but the session has other known tabs - follow to whichever one is
    // currently on screen instead of ending the recording.
    const [fallback] = await chrome.tabs.query({ active: true }).catch(() => []);
    if (fallback && latest.trackedTabIds.includes(fallback.id)) {
      await adoptActiveTab(fallback.id);
      return;
    }
    await stopRecording();
  }
});

// A flow that opens a new tab from the recorded page (an OAuth/sign-in redirect, for instance) can
// easily leave the user unsure which tab to look at, and in Screen/window mode sharing the whole
// display it also determines what actually shows up in the capture. Bring the new tab forward, and
// treat it as part of the same recording so switching between it and its opener keeps capturing.
chrome.tabs.onCreated.addListener(async (tab) => {
  const linkTarget = claimNewTabLinkTarget(tab);
  try {
    const sourceTabId = linkTarget?.sourceTabId ?? tab.openerTabId;
    const state = await recoverRecordingSession(sourceTabId);
    if (!state.recording || !state.trackedTabIds.includes(sourceTabId)) return;
    await trackAndFocusNewTab(state, tab);
  } finally {
    completeNewTabLinkHandoff(linkTarget);
  }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const state = await recoverRecordingSession(tabId);
  if (!state.recording || !state.trackedTabIds.includes(tabId)) return;
  await trackSessionTab(state, { id: tabId, windowId: attachInfo.newWindowId });
});

// DevTools panel changes are not observable, so the user triggers those captures by hotkey.
chrome.commands.onCommand.addListener(async (command) => {
  const state = await recoverRecordingSession(undefined, true);
  if (!state.recording || state.paused) return;

  const target = { tabId: state.tabId, windowId: state.windowId };
  if (command === 'capture-panel') await captureNow('devtools-panel', undefined, state, undefined, target);
  if (command === 'capture-whole-page') {
    await chrome.action.openPopup?.().catch(() => {});
    await captureNow('manual-hotkey', undefined, state, undefined, target);
  }
  if (command === 'capture-later' && (await canCaptureDevTools(state))) {
    await captureNow('devtools-panel', undefined, state, undefined, target);
  }
});

// If the sharing window is closed mid-flow, keep recording via tab capture instead of failing.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  if (state.recording && state.screenWindowId === windowId) {
    await setState({
      screenWindowId: null,
      streamActive: false,
      lastError: 'Sharing window closed \u2014 continuing with tab capture.'
    });
  }
});

async function recoverAfterBrowserRestart() {
  sessionRecoveryPending = true;
  browserRestartInterruptionChain = browserRestartInterruptionChain
    .catch(() => {})
    .then(async () => {
      try {
        const state = await interruptRecordingAfterBrowserRestart();
        if (!state.recording && state.pendingResumeFolder?.name) {
          await setState({ pendingResumeFolder: null });
        }
      } catch (error) {
        console.error('Could not preserve the interrupted recording:', error);
      }
    });
  return browserRestartInterruptionChain;
}

chrome.runtime.onStartup.addListener(recoverAfterBrowserRestart);
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') recoverAfterBrowserRestart();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen' || message?.target === 'screen') return false;

  (async () => {
    switch (message.type) {
      case 'GET_STATE':
        sendResponse(await withDevToolsStatus(await recoverRecordingSession()));
        break;

      case 'SCREEN_READY': {
        const state = await getState();
        const accepted = Boolean(
          message.source === 'screen-window' &&
          state.recording &&
          state.settings.captureMode === 'screen'
        );
        if (accepted) {
          await setState({ streamActive: true, lastError: null });
          if (Number.isSafeInteger(state.screenWindowId)) {
            await chrome.windows.update(state.screenWindowId, { state: 'minimized' }).catch(() => {});
          }
        }
        sendResponse({ ok: true, accepted });
        break;
      }

      case 'SCREEN_ENDED': {
        const state = await getState();
        const accepted = Boolean(
          message.source === 'screen-window' &&
          state.recording &&
          state.settings.captureMode === 'screen'
        );
        if (accepted) {
          await markScreenUnavailable(
            'Screen sharing stopped. Select a screen or window again to resume DevTools capture.'
          );
        }
        sendResponse({ ok: true, accepted });
        break;
      }

      case 'SCREEN_FRAME_BUFFERED': {
        const state = await recoverRecordingSession(undefined, true);
        const accepted = Boolean(
          message.source === 'screen-window' &&
          state.recording &&
          !state.paused &&
          state.settings.captureMode === 'screen' &&
          state.streamActive &&
          message.frameId
        );
        if (accepted) {
          captureNow('devtools-update', message.label || 'DevTools panel updated', state, undefined, {
            tabId: state.tabId,
            windowId: state.windowId,
            actionAt: message.actionAt,
            bufferedScreenFrameId: message.frameId
          });
        }
        sendResponse({ ok: true, accepted });
        break;
      }

      case 'PAGE_VISUAL_ACTIVITY': {
        const state = await getState();
        if (state.recording && state.settings.captureMode === 'screen' && state.streamActive) {
          await askScreen('SCREEN_SUPPRESS_MONITOR', { durationMs: 1000 });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'PDF_DONE':
      case 'OUTPUT_DONE':
        sendResponse({ ok: true });
        break;

      case 'START': {
        const current = await getState();
        if (current.recording) {
          sendResponse(await recoverRecordingSession());
          return;
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
          sendResponse(await setState({ lastError: 'No active tab found.' }));
          return;
        }
        try {
          sendResponse(
            current.pendingResumeFolder?.name
              ? await resumeRecordingFromFolder(tab, message.settings)
              : await startRecording(tab, message.settings, null, message.sessionFolderName)
          );
        } catch (error) {
          sendResponse(await setState({
            recording: false,
            pendingResumeFolder: null,
            folderAccessNeeded: false,
            lastError: error.message
          }));
        }
        break;
      }

      case 'PREPARE_RESUME_FROM_FOLDER':
        try {
          sendResponse(await prepareResumeFromFolder());
        } catch (error) {
          sendResponse(await setState({ pendingResumeFolder: null, lastError: error.message }));
        }
        break;

      case 'RESUME_FROM_FOLDER': {
        const current = await getState();
        if (current.recording) {
          sendResponse(await recoverRecordingSession());
          return;
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
          sendResponse(await setState({ lastError: 'No active tab found.' }));
          return;
        }
        try {
          sendResponse(await resumeRecordingFromFolder(tab, message.settings));
        } catch (error) {
          sendResponse(await setState({
            recording: false,
            outputFolder: null,
            pendingResumeFolder: null,
            folderWrittenFiles: [],
            folderAccessNeeded: false,
            lastError: error.message
          }));
        }
        break;
      }

      case 'RECONNECT_CAPTURE_FOLDER':
        try {
          sendResponse(await reconnectCaptureFolder());
        } catch (error) {
          sendResponse(await setState({
            folderAccessNeeded: true,
            lastError: error.message
          }));
        }
        break;

      case 'SET_PAUSED':
        try {
          sendResponse(await setRecordingPaused(Boolean(message.paused)));
        } catch (error) {
          sendResponse(await setState({ lastError: error.message }));
        }
        break;

      case 'SET_PDF_EXCLUSIONS': {
        const state = await getState();
        if ((!state.recording && !completedEvidenceFor(state)) || message.sessionId !== state.sessionId) {
          sendResponse(state);
          break;
        }
        const excluded = normalizeSequenceList(message.excludedSequences);
        await chrome.storage.local.set({
          [PDF_EXCLUSIONS_KEY]: { sessionId: state.sessionId, sequences: excluded }
        });
        logLine(`PDF_SELECTION excluded=${excluded.length}`);
        sendResponse({ ...state, pdfExcludedSequences: excluded });
        break;
      }

      case 'GENERATE_EVIDENCE':
        try {
          sendResponse(
            await generateEvidence(
              message.outputFilename || message.pdfFilename,
              message.excludedSequences,
              message.outputFormats
            )
          );
        } catch (error) {
          sendResponse(await setState({
            lastError: `${requestedOutputLabel(message.outputFormats)} evidence generation failed: ${error.message}`
          }));
        }
        break;

      case 'SET_CAPTURE_NOTE':
        try {
          sendResponse(await setCaptureNote(message.sessionId, message.sequence, message.note));
        } catch (error) {
          sendResponse(await setState({ lastError: error.message }));
        }
        break;

      case 'OPEN_OUTPUT_DIALOG':
        try {
          sendResponse(await openOutputDialog(message.mode));
        } catch (error) {
          sendResponse(await setState({ lastError: error.message }));
        }
        break;

      case 'STOP':
        try {
          sendResponse(
            await stopRecording(
              message.keepFiles !== false,
              message.outputFilename || message.pdfFilename,
              message.excludedSequences,
              Boolean(message.reveal),
              message.createPdf !== false,
              message.outputFormats
            )
          );
        } catch (error) {
          await cleanupCaptureResources();
          sendResponse(await setState({
            recording: false,
            folderAccessNeeded: needsFolderReconnect(error),
            lastError: error.message
          }));
        }
        break;

      case 'SAVE_FLOW':
        try {
          sendResponse(
            await saveFlow(
              message.outputFilename || message.pdfFilename,
              message.excludedSequences,
              message.outputFormats
            )
          );
        } catch (error) {
          sendResponse(await setState({
            folderAccessNeeded: needsFolderReconnect(error),
            lastError: `${requestedOutputLabel(message.outputFormats)} export failed: ${error.message}`
          }));
        }
        break;

      case 'CAPTURE_NOW':
        await captureNow('manual', undefined, await recoverRecordingSession(undefined, true));
        sendResponse(await getState());
        break;

      case 'CAPTURE_LATER': {
        const state = await recoverRecordingSession(undefined, true);
        const devToolsOpen = await canCaptureDevTools(state);
        sendResponse({ ...state, devToolsOpen });
        if (!state.paused && devToolsOpen) captureDevToolsAfterPopupCloses(state);
        break;
      }

      case 'SET_SETTINGS': {
        const state = await recoverRecordingSession();
        const { captureMode, ...rest } = message.settings;
        const next =
          state.recording && captureMode && captureMode !== state.settings.captureMode
            ? await switchCaptureMode(captureMode)
            : state;
        sendResponse(await setState({ settings: { ...next.settings, ...(state.recording ? rest : message.settings) } }));
        break;
      }

      case 'CLICK_CAPTURE': {
        const state = await recoverRecordingSession(sender.tab?.id);
        const reason = message.reason || 'click';
        const allowed =
          reason === 'manual-hotkey' ||
          (reason === 'scrolled' || reason === 'modal-scrolled'
            ? state.settings.captureOnScroll
            : state.settings.captureOnClick);
        const tabId = sender.tab?.id;
        if (state.recording && allowed && tabId !== undefined && state.trackedTabIds.includes(tabId)) {
          const capture = !state.paused
            ? captureNow(reason, message.label, state, message.modal, {
              tabId,
              windowId: sender.tab?.windowId,
              actionAt: message.actionAt,
              opensNewTab: Boolean(message.opensNewTab)
            })
            : null;
          await adoptActiveTab(tabId);
          if (capture) await capture;
        }
        sendResponse({ ok: true });
        break;
      }

      case 'API_HOOK_READY': {
        const state = await recoverRecordingSession(sender.tab?.id);
        if (state.recording && (await isRecordedTab(sender.tab?.id)) && !state.apiHookReady) {
          await setState({ apiHookReady: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'API_HOOK_CONFIG_REQUEST': {
        const state = await recoverRecordingSession(sender.tab?.id);
        const enabled = Boolean(
          state.recording &&
            state.settings.captureApi &&
            Number.isSafeInteger(sender.tab?.id) &&
            state.trackedTabIds.includes(sender.tab.id)
        );
        await configureApiHookForTab(sender.tab?.id, enabled);
        sendResponse({ ok: true });
        break;
      }

      case 'API_CAPTURE': {
        const state = await recoverRecordingSession(sender.tab?.id);
        if (state.recording && state.settings.captureApi && (await isRecordedTab(sender.tab?.id))) {
          if (!state.apiHookReady) await setState({ apiHookReady: true });
          if (!state.paused) await queueApiCall({ ...message.detail, tabId: sender.tab.id });
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ error: `Unknown message type: ${message.type}` });
    }
  })();

  return true;
});

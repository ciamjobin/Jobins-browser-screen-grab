const STATE_KEY = 'flowRecorderState';
const PDF_EXCLUSIONS_KEY = 'flowRecorderPdfExcludedSequences';
const SESSION_CONTROL_KEY = 'flowRecorderSessionControl';
const SESSION_TRACKING_KEY = 'flowRecorderSessionTracking';
const FRAMES_KEY = 'flowRecorderFrames';
const FRAME_PREFIX = `${FRAMES_KEY}:`;
const OFFSCREEN_PATH = 'offscreen.html';
const WATERMARK = "Captured by Jobin's Screenshots";

// captureVisibleTab is rate limited; serialize captures and pace them.
let captureChain = Promise.resolve();
let lastRawCaptureHash = '';
let lastTabTitle = '';

// Held in memory rather than storage: concurrent API events would race a read-modify-write.
let apiQueue = [];
let apiHeaderRecords = [];

const API_HEADER_TTL_MS = 120000;
const CAPTURE_COUNTDOWN_MS = 5000;

// A per-session debug log, cleared at the start of each new recording, mirroring capture attempts,
// timings, errors and mode switches - so "screenshot #N at time T had a problem" can be answered
// from what actually happened, not guessed at. Storage is the only source of truth (not an in-memory
// array): the service worker can be evicted and restarted mid-recording (MV3 idles it after periods
// with no activity), which would silently reset a plain variable and lose everything logged before
// that point - exactly what produced a near-empty log despite 43 captures having happened. Written
// out as a file at natural checkpoints (a PDF export, stopping, mode switches), rather than after
// every single action - repeatedly re-downloading the same file was surfacing a Save As prompt.
const LOG_KEY = 'flowRecorderLog';
let logChain = Promise.resolve();

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  logChain = logChain
    .then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      log.push(line);
      await chrome.storage.local.set({ [LOG_KEY]: log });
    })
    .catch(() => {});
}

async function writeLogFile() {
  const state = await getState();
  if (!state.sessionId) return;
  const stored = await chrome.storage.local.get(LOG_KEY);
  const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  if (!log.length) return;
  const text = log.join('\n') + '\n';
  const url = 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(text)));
  await chrome.downloads
    .download({
      url,
      filename: `flow-captures/${state.sessionId}/debug-log.txt`,
      saveAs: false,
      conflictAction: 'overwrite'
    })
    .catch(() => {});
}


const defaultState = {
  recording: false,
  paused: false,
  captureGeneration: 0,
  tabId: null,
  windowId: null,
  sessionId: null,
  sequence: 0,
  captures: [],
  pdfExcludedSequences: [],
  trackedTabIds: [],
  trackedWindowIds: [],
  downloadIds: [],
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
    stampTimestamp: true,
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

function trackSessionTab(state, tab) {
  if (!state.sessionId || !Number.isSafeInteger(tab?.id)) return Promise.resolve();
  return updateSessionTracking(state.sessionId, (tracking) => ({
    tabIds: [...tracking.tabIds, tab.id],
    windowIds: [...tracking.windowIds, tab.windowId]
  }));
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

// Only page-driven captures are worth skipping; anything the user did must always be recorded.
// 'click-loaded' is the settled follow-up to a click - keep it only when the page actually changed.
const DEDUPE_REASONS = new Set(['navigation', 'url-change', 'click-loaded']);

function shouldKeepDuplicate(reason, apiRows) {
  return apiRows.length > 0 || !DEDUPE_REASONS.has(reason);
}

// The download bubble overlays the page and would otherwise land in screen captures.
async function setDownloadUi(enabled) {
  try {
    await chrome.downloads.setUiOptions({ enabled });
  } catch (error) {
    console.warn('Could not toggle the download UI:', error.message);
  }
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
let imageWorker = null;

async function localImageWorker() {
  imageWorker ??= await import('./image-worker.js');
  return imageWorker;
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

function askScreen(type) {
  return chrome.runtime.sendMessage({ target: 'screen', type }).catch((error) => ({ error: error.message }));
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
      if (message?.type === 'SCREEN_READY') finish({ ok: true });
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

// However a single capture fails or hangs, the queue must keep moving - otherwise every capture
// requested after it (including the popup's own "Capture now" / "Capture in 5s" buttons) would wait
// behind a promise that never settles, which looks exactly like the extension has stopped responding.
const QUEUE_WATCHDOG_TOKEN = Symbol('queue-watchdog-timeout');
async function captureNow(reason, label, requestedState) {
  const captureRequest = requestedState || (await getState());
  const captureWatchdogMs =
    captureRequest.settings?.fullPage && FULL_PAGE_REASONS.has(reason)
      ? FULL_PAGE_CAPTURE_QUEUE_WATCHDOG_MS
      : CAPTURE_QUEUE_WATCHDOG_MS;
  captureChain = captureChain
    .then(async () => {
      const result = await Promise.race([
        performCapture(reason, label, captureRequest.sessionId, captureRequest.captureGeneration),
        new Promise((resolve) => setTimeout(() => resolve(QUEUE_WATCHDOG_TOKEN), captureWatchdogMs))
      ]);
      if (result === QUEUE_WATCHDOG_TOKEN) {
        logLine(
          `QUEUE_WATCHDOG ${reason}${label ? ` "${label}"` : ''} exceeded ${captureWatchdogMs}ms, moving on`
        );
        await clearFullPageProgress(captureRequest.tabId);
      }
    })
    .catch(async (error) => {
      logLine(`ERROR ${reason}${label ? ` "${label}"` : ''}: ${error.message}`);
      await writeLogFile().catch(() => {});
      console.error('Capture failed:', error);
      const state = await getState();
      await clearFullPageProgress(state.tabId);
      await setState({ lastError: `Capture failed: ${error.message}` });
    });
  return captureChain;
}

// Shows an on-page countdown so the user can see exactly when the delayed shot will fire, then
// takes it. The badge lives in the page itself since the popup that requested this has closed.
async function scheduleDelayedCapture(tabId, requestedState) {
  const captureRequest = requestedState || (await getState());
  if (typeof tabId === 'number') {
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_COUNTDOWN', seconds: CAPTURE_COUNTDOWN_MS / 1000 }).catch(() => {
      /* No content script on this page (chrome://, Web Store); the capture still fires on time. */
    });
  }
  delay(CAPTURE_COUNTDOWN_MS).then(() => captureNow('devtools-panel', undefined, captureRequest));
}

// "Failed to capture tab: image readback failed" is a transient compositor/GPU error - the frame
// simply was not readable at that instant (mid-paint, tab backgrounded, GPU process recycling).
// A short retry recovers it; without one, a whole capture is lost or a stitch frame silently dropped.
const CAPTURE_RETRY_DELAYS_MS = [150, 400, 900];

async function captureVisibleTabWithRetry(windowId) {
  let lastError = null;
  for (let attempt = 0; attempt <= CAPTURE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (error) {
      lastError = error;
      const wait = CAPTURE_RETRY_DELAYS_MS[attempt];
      if (wait === undefined) break;
      await delay(wait);
    }
  }
  throw lastError;
}

async function grabPngDataUrl(state, tab) {
  if (state.settings.captureMode === 'screen' && state.streamActive) {
    const result = await askScreen('SCREEN_CAPTURE');
    if (result?.dataUrl) return result.dataUrl;
    console.warn('Screen capture unavailable, falling back to tab capture:', result?.error);
  }
  return captureVisibleTabWithRetry(tab.windowId);
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
const FULL_PAGE_PART_MAX_PIXELS = 8000000;
const FULL_PAGE_PART_MAX_DIMENSION = 8192;
const FULL_PAGE_BASE_TILE_HEIGHT = 3000;
const FULL_PAGE_PREFERRED_MAX_PARTS = 8;
const FULL_PAGE_TILE_JPEG_QUALITY = 94;
const SCROLLER_SETTLE_MAX_MS = 600;
// Full-document work is deliberately limited to manual capture actions.
const FULL_PAGE_REASONS = new Set(['manual-hotkey', 'manual']);
let debuggerTabId = null;

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

// The tab title is often a generic site-wide string ("John Hancock - My Retirement") that says
// little about the step being documented, so prefer the heading the page actually shows.
async function getPageHeading(tabId) {
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
        const dialog = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')]
          .filter(visible)
          .pop();
        const scope = dialog || document;

        for (const selector of ['h1', '[role="heading"][aria-level="1"]', 'h2']) {
          for (const el of scope.querySelectorAll(selector)) {
            if (!visible(el)) continue;
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            if (text) return text.slice(0, 120);
          }
        }
        return '';
      }
    })
    .catch(() => [null]);
  return injected?.result || '';
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
      return {
        width: Math.ceil(docWidth),
        viewportHeight: innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        docHeight: Math.ceil(docHeight)
      };
    }
  });
  return injected?.result || null;
}

const SCROLLER_MARK_ATTR = 'data-jshotz-scroll-root';

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

function cropBlankMargins(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  if (!width || !height) return null;

  const rowSampleStep = Math.max(1, Math.floor(width / 300));
  const samplesPerRow = Math.ceil(width / rowSampleStep);
  const reference = ctx.getImageData(width - 1, height - 1, 1, 1).data;
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

function fullPageCapturePlan(width, height, dpr) {
  const safeDpr = Math.max(1, Number(dpr) || 1);
  const rasterWidth = width * safeDpr;
  const rasterHeight = height * safeDpr;
  const pagePixels = rasterWidth * rasterHeight;
  const fitsSingleImage =
    pagePixels <= FULL_PAGE_SINGLE_IMAGE_MAX_PIXELS &&
    rasterWidth <= FULL_PAGE_PART_MAX_DIMENSION &&
    rasterHeight <= FULL_PAGE_PART_MAX_DIMENSION;

  if (fitsSingleImage) {
    return {
      captureScale: 1,
      format: 'png',
      tiles: [{ top: 0, height }]
    };
  }

  const tileHeight = Math.min(
    height,
    Math.max(FULL_PAGE_BASE_TILE_HEIGHT, Math.ceil(height / FULL_PAGE_PREFERRED_MAX_PARTS))
  );
  const captureScale = maximumDocumentPartScale(width, tileHeight, safeDpr);
  if (!Number.isFinite(captureScale) || captureScale <= 0) {
    throw new Error('The page dimensions cannot be captured safely.');
  }

  return {
    captureScale,
    format: 'jpeg',
    tiles: documentTiles(height, tileHeight)
  };
}

function documentCapturePlan(documentInfo) {
  return fullPageCapturePlan(documentInfo.width, documentInfo.docHeight, documentInfo.dpr);
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
  if (Number.isSafeInteger(tabId)) {
    await chrome.tabs.sendMessage(tabId, { type: 'FULL_PAGE_PROGRESS', progress }).catch(() => {});
  }
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
}

async function captureDocumentTile(tabId, width, tile, plan) {
  await setFullPageProgressVisibility(tabId, true);
  try {
    const options = {
      format: plan.format,
      captureBeyondViewport: true,
      clip: { x: 0, y: tile.top, width, height: tile.height, scale: plan.captureScale }
    };
    if (plan.format === 'jpeg') options.quality = FULL_PAGE_TILE_JPEG_QUALITY;
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', options);
    if (!result?.data) throw new Error('Chromium returned no full-page screenshot data.');
    return screenshotDataUrl(result.data, plan.format);
  } finally {
    await setFullPageProgressVisibility(tabId, false);
  }
}

async function captureDocumentParts(tabId, documentInfo) {
  const plan = documentCapturePlan(documentInfo);
  const progressTotal = plan.tiles.length * 2;
  const parts = [];
  await reportFullPageProgress(tabId, 'Preparing full-page screenshot', 0, progressTotal);

  for (let index = 0; index < plan.tiles.length; index += 1) {
    await reportFullPageProgress(
      tabId,
      `Capturing full page ${index + 1} of ${plan.tiles.length}`,
      index,
      progressTotal
    );
    const rawDataUrl = await captureDocumentTile(tabId, documentInfo.width, plan.tiles[index], plan);
    parts.push({ rawDataUrl });
    await reportFullPageProgress(
      tabId,
      `Captured full page ${index + 1} of ${plan.tiles.length}`,
      index + 1,
      progressTotal
    );
  }

  return {
    parts,
    captureScale: plan.captureScale,
    progressTotal,
    trimBlankMargins: parts.length === 1
  };
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
    // The debugger is only needed for the instant of the shot, so let go of it immediately - that
    // is what makes the "started debugging this browser" banner disappear right away.
    await detachDebugger();
    await restoreDocumentScroll(tabId, documentInfo.scrollX, documentInfo.scrollY);
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

// Captures the whole page without changing the tab's layout viewport. An app-shell pane is handled
// by scrolling only that pane; a plain document is rasterized beyond its existing viewport. Defer
// debugger attachment until the latter branch because stitch capture does not need CDP, and attach
// itself causes Chromium to show a transient browser notice.
// Returns null when neither applies, so the caller just takes the ordinary visible frame.
async function captureFullPagePassive(tabId, windowId, documentInfo, knownScroller) {
  const doc = documentInfo || (await measureDocument(tabId).catch(() => null));
  if (!doc?.viewportHeight) return null;

  if (doc.docHeight > doc.viewportHeight + 4) {
    if (!HAS_DEBUGGER) return null;
    return captureDocumentHeadless(tabId, doc);
  }

  const scroller = knownScroller || (await findScroller(tabId).catch(() => null));
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4) {
    await clearScrollerMark(tabId);
    return null;
  }
  try {
    return await captureScrollerStitch(tabId, windowId, scroller);
  } finally {
    await setFullPageProgressVisibility(tabId, false);
  }
}

// A page that never settles (throttled background tab, an element that keeps growing, a stalled
// network wait) must never be allowed to stall the whole recording - past the watchdog, give up and
// fall back to the ordinary visible frame instead. The badge shows "..." for the same reason: a
// multi-second full-page capture must not look identical to the extension having stopped responding.
async function captureFullPageWithWatchdog(tabId, windowId) {
  const state = await getState();
  await chrome.action.setBadgeText({ text: state.recording && !state.paused ? '\u2026' : '' });
  try {
    const documentInfo = await measureDocument(tabId).catch(() => null);
    const scroller =
      documentInfo?.viewportHeight && documentInfo.docHeight <= documentInfo.viewportHeight + 4
        ? await findScroller(tabId).catch(() => null)
        : null;
    const watchdogMs = scroller && scroller.scrollHeight > scroller.clientHeight + 4
      ? scrollerCaptureWatchdogMs(scroller)
      : FULL_PAGE_WATCHDOG_MS;
    const FULL_PAGE_TIMEOUT_TOKEN = Symbol('full-page-timeout');
    const timeout = new Promise((resolve) => setTimeout(() => resolve(FULL_PAGE_TIMEOUT_TOKEN), watchdogMs));
    const result = await Promise.race([
      captureFullPagePassive(tabId, windowId, documentInfo, scroller).catch(() => null),
      timeout
    ]);
    if (result === FULL_PAGE_TIMEOUT_TOKEN) {
      logLine(`FULL_PAGE_WATCHDOG exceeded ${watchdogMs}ms, using the visible frame instead`);
      return null;
    }
    return result;
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

async function cleanupCaptureResources() {
  await closeScreenWindow().catch(() => {});
  await closeOffscreen().catch(() => {});
  await detachDebugger().catch(() => {});
  await clearStoredFrames().catch(() => {});
  await chrome.storage.local.remove(SESSION_CONTROL_KEY).catch(() => {});
  await clearSessionTracking().catch(() => {});
  await setDownloadUi(true).catch(() => {});
  apiQueue = [];
  apiHeaderRecords = [];
  lastRawCaptureHash = '';
  lastTabTitle = '';
}

function isActiveCapture(state, sessionId, captureGeneration) {
  return (
    state.recording &&
    !state.paused &&
    state.sessionId === sessionId &&
    state.captureGeneration === captureGeneration
  );
}

async function performCapture(reason, label, requestedSessionId, requestedCaptureGeneration) {
  const startedAt = Date.now();
  const state = await getState();
  if (state.tabId === null || !isActiveCapture(state, requestedSessionId, requestedCaptureGeneration)) return;

  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab) {
    await stopRecording();
    return;
  }

  // Let the page settle (navigation paint, click-driven UI updates) before grabbing the frame.
  const settle =
    reason === 'navigation' ? 600 : reason === 'devtools-panel' ? 150 : reason === 'dialog-opened' ? 550 : 450;
  await delay(state.settings.captureApi ? settle + 500 : settle);

  const latest = await getState();
  if (!isActiveCapture(latest, state.sessionId, state.captureGeneration)) return;

  // Full-page capture renders the page itself, not whatever surface a mode normally captures - that
  // applies just as well in Screen/window and API mode as it does in Tab viewport mode. The queue
  // watchdog above is what actually guards against this hanging the rest of the recording, so this
  // no longer needs to be restricted to specific modes to stay safe.
  const wantsFullPage = state.settings.fullPage && FULL_PAGE_REASONS.has(reason);
  let fullPage = null;
  try {
    if (wantsFullPage) {
      await reportFullPageProgress(tab.id, 'Preparing full-page screenshot', 0, 1);
      fullPage = await captureFullPageWithWatchdog(tab.id, tab.windowId);
    }
    const fullPageInfo = wantsFullPage
      ? fullPage?.parts
        ? `parts=${fullPage.parts.length} scale=${Math.round(fullPage.captureScale * 100)}%`
        : fullPage
          ? 'ok'
          : 'fell back to visible frame'
      : 'n/a';
    const heading = await getPageHeading(tab.id).catch(() => '');
    const capture = {
      title: heading || tab.title || tab.url || 'Untitled page',
      url: tab.url || '',
      reason,
      label,
      startedAt,
      sessionId: state.sessionId,
      captureGeneration: state.captureGeneration,
      mode: state.settings.captureMode,
      fullPageInfo
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
        rawDataUrl = await grabPngDataUrl(state, tab);
      } finally {
        if (wantsFullPage) await setFullPageProgressVisibility(tab.id, false);
      }
    }
    if (wantsFullPage && !fullPage && state.settings.captureMode !== 'screen') {
      rawDataUrl = await trimBlankMargins(rawDataUrl);
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
        stampTimestamp: index === 0,
        watermarkText: index === parts.length - 1 ? WATERMARK : null,
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
  sessionId,
  captureGeneration,
  mode,
  fullPageInfo,
  apiRows: suppliedApiRows,
  titleBar = true,
  stampTimestamp = true,
  watermarkText = WATERMARK,
  jpegQuality
}) {
  const state = await getState();
  if (!isActiveCapture(state, sessionId, captureGeneration)) return;

  const { settings } = state;
  await ensureOffscreen();
  if (!isActiveCapture(await getState(), sessionId, captureGeneration)) return;

  const capturedAt = new Date();
  const sequence = state.sequence + 1;
  const usesQueuedApiRows = suppliedApiRows === undefined;
  const apiRows = usesQueuedApiRows ? apiQueue : suppliedApiRows;
  if (usesQueuedApiRows) apiQueue = [];
  const restoreQueuedApiRows = () => {
    if (usesQueuedApiRows && apiRows.length) apiQueue = [...apiRows, ...apiQueue].slice(-12);
  };
  const processed = await askOffscreen('OFFSCREEN_PROCESS', {
    dataUrl: rawDataUrl,
    stampText: stampTimestamp && settings.stampTimestamp ? stampText(capturedAt) : null,
    watermarkText,
    titleBar: titleBar ? { title, url } : null,
    wantPng: settings.savePng,
    wantJpeg: settings.savePdf,
    apiRows,
    jpegQuality
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
  const filename =
    `flow-captures/${state.sessionId}/` +
    `${String(sequence).padStart(3, '0')}_${fileTimestamp(capturedAt)}_${slug}.png`;

  if (settings.savePng) {
    const downloadId = await chrome.downloads.download({ url: pngDataUrl, filename, saveAs: false });
    await setState({ downloadIds: [...(await getState()).downloadIds, downloadId] });
  }

  if (settings.savePdf && jpeg) {
    await storeFrame({
      sequence,
      title,
      url,
      time: `${stampText(capturedAt)}  |  ${reason}${label ? ` "${label}"` : ''}  |  ${mode} mode`,
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
    mode,
    apiCalls: apiRows.length,
    capturedAt: capturedAt.toISOString(),
    filename: settings.savePng ? filename : null
  };

  const next = await setState({
    sequence,
    captures: [...state.captures, entry].slice(-300)
  });
  await updateBadge(next);
  logLine(
    `#${sequence} ${reason}${label ? ` "${label}"` : ''} mode=${mode} fullPage=${fullPageInfo}` +
      `${apiRows.length ? ` apiCalls=${apiRows.length}` : ''} url=${shortUrl(url)} (${Date.now() - startedAt}ms)`
  );
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
// can write the PDF, so a short-lived extension page does it.
async function exportPdfInWindow(filename, excludedSequences) {
  const params = new URLSearchParams({ filename });
  if (Array.isArray(excludedSequences)) {
    params.set('excluded', normalizeSequenceList(excludedSequences).join(','));
  }

  const win = await chrome.windows.create({
    url: `exporter.html?${params}`,
    type: 'popup',
    width: 420,
    height: 200,
    focused: false
  });

  const result = await new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.windows.onRemoved.removeListener(onRemoved);
      resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type === 'PDF_DONE') {
        finish(message.error ? { error: message.error } : { ok: true, downloadId: message.downloadId });
      }
    };
    const onRemoved = (windowId) => {
      if (windowId === win.id) finish({ error: 'The PDF window was closed early.' });
    };
    const timer = setTimeout(() => finish({ error: 'Timed out while writing the PDF.' }), 120000);

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.windows.onRemoved.addListener(onRemoved);
  });

  if (result.ok) await chrome.windows.remove(win.id).catch(() => {});
  return result;
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
  // Written immediately (not just at the usual checkpoints) so a mode switch that is followed by a
  // crash - the riskiest single moment in a recording - still leaves a log on disk up to this point.
  await writeLogFile().catch(() => {});
  if (previousMode === 'screen' && newMode !== 'screen') {
    await closeScreenWindow();
  }

  const next = await setState({
    streamActive: newMode === 'screen' ? false : state.streamActive,
    settings: { ...state.settings, captureMode: newMode, captureApi: newMode === 'api' }
  });

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
          await writeLogFile().catch(() => {});
          await setState({ lastError: `Could not switch to Screen/window mode: ${result.error}` });
          return;
        }
        // Only flip this on if the mode wasn't switched away again while the picker was open.
        const latest = await getState();
        if (latest.settings.captureMode === 'screen') {
          logLine('MODE_SWITCH screen share ready');
          await writeLogFile().catch(() => {});
          await setState({ streamActive: true });
        }
      })
      .catch(async (error) => {
        logLine(`MODE_SWITCH ${previousMode} -> screen failed: ${error.message}`);
        await writeLogFile().catch(() => {});
        await setState({ lastError: `Could not switch to Screen/window mode: ${error.message}` });
      });
  }

  return next;
}

async function startRecording(tab, settings) {
  const sessionId = `session_${fileTimestamp(new Date())}`;
  await chrome.storage.local.remove(LOG_KEY).catch(() => {});
  await chrome.storage.local.remove(PDF_EXCLUSIONS_KEY).catch(() => {});
  await chrome.storage.local.remove(SESSION_CONTROL_KEY).catch(() => {});
  await clearSessionTracking();
  await clearStoredFrames();
  await setState({ lastError: null });
  await setDownloadUi(false);
  apiQueue = [];
  lastRawCaptureHash = '';
  lastTabTitle = tab.title || '';

  const merged = { ...defaultState.settings, ...(await getState()).settings, ...settings };
  merged.captureApi = merged.captureMode === 'api';
  let streamActive = false;

  try {
    if (merged.captureMode === 'screen' || merged.savePdf) {
      await ensureOffscreen();
    }

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
    sequence: 0,
    captures: [],
    pdfExcludedSequences: [],
    trackedTabIds: [tab.id],
    trackedWindowIds: [tab.windowId],
    downloadIds: [],
    apiSeen: 0,
    apiHookReady: false,
    streamActive,
    fullPageProgress: null,
    lastError: null,
    settings: merged
  });

  // The declared content scripts only load on navigation, so seed the already-open page.
  for (const files of [['page-hook.js'], ['content.js']]) {
    await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files,
        world: files[0] === 'page-hook.js' ? 'MAIN' : 'ISOLATED'
      })
      .catch(() => {
        /* Restricted pages (chrome://, Web Store) cannot be instrumented. */
      });
  }

  await updateBadge(state);
  logLine(`SESSION_START mode=${merged.captureMode} url=${shortUrl(tab.url || '')}`);
  await captureNow('start');
  return getState();
}

async function deleteSessionDownloads(ids) {
  for (const id of ids) {
    await chrome.downloads.removeFile(id).catch(() => {
      /* Already gone or never written. */
    });
    await chrome.downloads.erase({ id }).catch(() => {});
  }
}

function pdfFilename(value, sessionId) {
  const base = String(value || `${sessionId}.pdf`).replace(/\.pdf$/i, '');
  return `${sanitize(base, 120)}.pdf`;
}

async function revealSavedFiles(downloadId) {
  try {
    if (typeof downloadId === 'number') {
      await chrome.downloads.show(downloadId);
      return;
    }
    await chrome.downloads.showDefaultFolder();
  } catch (error) {
    console.warn('Could not open the download folder:', error.message);
  }
}

// Writes a PDF from whatever has been captured so far without stopping the recording - a checkpoint
// the user can hand off or review while the same session keeps adding to the same numbered sequence.
// Unlike the final export, the folder is not opened here - only the final save should interrupt the
// user, since this can happen many times over the course of one recording.
async function exportPdfNow(requestedPdfFilename, excludedSequences) {
  if (apiQueue.length) await captureNow('final-api-calls');
  await captureChain.catch(() => {});

  const state = await getState();
  if (!state.recording) return setState({ lastError: 'Not currently recording.' });
  if (!state.captures.length) return setState({ lastError: 'Nothing captured yet.' });
  const excluded = Array.isArray(excludedSequences)
    ? normalizeSequenceList(excludedSequences)
    : normalizeSequenceList(state.pdfExcludedSequences);
  logLine(`PDF_EXPORT checkpoint excluded=${excluded.length} captures=${state.captures.length}`);

  const result = await exportPdfInWindow(
    `flow-captures/${state.sessionId}/${pdfFilename(requestedPdfFilename, `${state.sessionId}_checkpoint`)}`,
    excluded
  );
  await writeLogFile().catch(() => {});
  if (result.error) {
    return setState({ lastError: `PDF export failed: ${result.error}` });
  }
  return setState({ lastError: null });
}

async function setRecordingPaused(paused) {
  const state = await getState();
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
  await writeLogFile().catch(() => {});
  return next;
}

async function stopRecording(keepFiles = true, requestedPdfFilename, excludedSequences) {
  // Anything still queued would be lost, so give it a final frame to sit under.
  if (keepFiles && apiQueue.length) {
    await captureNow('final-api-calls');
  }
  await captureChain.catch(() => {});
  const state = await getState();
  logLine(`SESSION_END keepFiles=${keepFiles} captures=${state.captures.length}`);
  const excluded = Array.isArray(excludedSequences)
    ? normalizeSequenceList(excludedSequences)
    : normalizeSequenceList(state.pdfExcludedSequences);
  let lastError = null;
  let revealId = state.downloadIds[state.downloadIds.length - 1];

  if (!keepFiles) {
    await deleteSessionDownloads(state.downloadIds);
  } else {
    if (state.captures.length) {
      const manifest = {
        sessionId: state.sessionId,
        startedAt: state.captures[0]?.capturedAt ?? null,
        endedAt: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        captureMode: state.settings.captureMode,
        screenshotCount: state.captures.length,
        screenshots: state.captures
      };
      const manifestUrl =
        'data:application/json;base64,' +
        btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
      await chrome.downloads.download({
        url: manifestUrl,
        filename: `flow-captures/${state.sessionId}/flow-manifest.json`,
        saveAs: false
      }).then((id) => { revealId = id; });
    }

    if (state.settings.savePdf && state.captures.length) {
      logLine(`PDF_EXPORT final excluded=${excluded.length} captures=${state.captures.length}`);
      const result = await exportPdfInWindow(
        `flow-captures/${state.sessionId}/${pdfFilename(requestedPdfFilename, state.sessionId)}`,
        excluded
      );
      if (result.error) {
        lastError = `PDF export failed: ${result.error}`;
        console.error(lastError);
      } else if (typeof result.downloadId === 'number') {
        revealId = result.downloadId;
      }
    }
  }

  await cleanupCaptureResources();

  // The shelf is suppressed during recording, so opening the folder is the only cue that files landed.
  await writeLogFile().catch(() => {});
  if (keepFiles && state.captures.length) await revealSavedFiles(revealId);

  const next = await setState({
    recording: false,
    paused: false,
    captureGeneration: 0,
    tabId: null,
    windowId: null,
    streamActive: false,
    fullPageProgress: null,
    downloadIds: [],
    lastError:
      lastError ?? (keepFiles ? null : `Deleted ${state.downloadIds.length} file(s) from this session.`)
  });
  await updateBadge(next);
  return next;
}

/* ---------------------------------------------------------------- listeners */

async function isRecordedTab(tabId) {
  const state = await getState();
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

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId === 0 && (await isRecordedTab(details.tabId))) {
    await adoptActiveTab(details.tabId);
    await captureNow('navigation');
  }
});

// Single-page apps change routes without a full page load.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId === 0 && (await isRecordedTab(details.tabId))) {
    await adoptActiveTab(details.tabId);
    await captureNow('url-change');
  }
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details) => {
  if (details.frameId === 0 && (await isRecordedTab(details.tabId))) {
    await adoptActiveTab(details.tabId);
    await captureNow('url-change');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.title || !(await isRecordedTab(tabId))) return;
  if (changeInfo.title === lastTabTitle) return;
  lastTabTitle = changeInfo.title;
  await adoptActiveTab(tabId);
  await captureNow('title-change', changeInfo.title);
});

// Manually switching back to a tab the recording already knows about (the original tab, or a child
// tab it opened) should resume capturing there too, not leave the recording pointed at whichever one
// last had activity.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (await isRecordedTab(tabId)) await adoptActiveTab(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
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
  const state = await getState();
  if (!state.recording || !state.trackedTabIds.includes(tab.openerTabId)) return;
  await trackSessionTab(state, tab);
  logLine(`NEW_TAB opened from recorded tab (tabId=${tab.id}), bringing it into focus`);
  // Activating the tab below fires onActivated, which is what actually adopts it as the current
  // capture target - calling adoptActiveTab here too just raced that same update and logged twice.
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const state = await getState();
  if (!state.recording || !state.trackedTabIds.includes(tabId)) return;
  await trackSessionTab(state, { id: tabId, windowId: attachInfo.newWindowId });
});

// DevTools panel changes are not observable, so the user triggers those captures by hotkey.
chrome.commands.onCommand.addListener(async (command) => {
  const state = await getState();
  if (!state.recording || state.paused) return;

  if (command === 'capture-panel') await captureNow('devtools-panel');
  if (command === 'capture-manual') await captureNow('manual-hotkey');
  if (command === 'capture-later') scheduleDelayedCapture(state.tabId, state);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen' || message?.target === 'screen') return false;

  (async () => {
    switch (message.type) {
      case 'GET_STATE':
        sendResponse(await getState());
        break;

      case 'SCREEN_READY':
        sendResponse({ ok: true });
        break;

      case 'PDF_DONE':
        sendResponse({ ok: true });
        break;

      case 'START': {
        const current = await getState();
        if (current.recording) {
          sendResponse(current);
          return;
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
          sendResponse(await setState({ lastError: 'No active tab found.' }));
          return;
        }
        try {
          sendResponse(await startRecording(tab, message.settings));
        } catch (error) {
          sendResponse(await setState({ recording: false, lastError: error.message }));
        }
        break;
      }

      case 'SET_PAUSED':
        try {
          sendResponse(await setRecordingPaused(Boolean(message.paused)));
        } catch (error) {
          sendResponse(await setState({ lastError: error.message }));
        }
        break;

      case 'SET_PDF_EXCLUSIONS': {
        const state = await getState();
        if (!state.recording || message.sessionId !== state.sessionId) {
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

      case 'STOP':
        try {
          sendResponse(await stopRecording(message.keepFiles !== false, message.pdfFilename, message.excludedSequences));
        } catch (error) {
          await cleanupCaptureResources();
          sendResponse(await setState({ recording: false, lastError: error.message }));
        }
        break;

      case 'EXPORT_PDF_NOW':
        try {
          sendResponse(await exportPdfNow(message.pdfFilename, message.excludedSequences));
        } catch (error) {
          sendResponse(await setState({ lastError: `PDF export failed: ${error.message}` }));
        }
        break;

      case 'CAPTURE_NOW':
        await captureNow('manual');
        sendResponse(await getState());
        break;

      // Chrome does not deliver extension shortcuts while the DevTools window has focus, so this
      // gives the user time to click into DevTools before the shot is taken.
      case 'CAPTURE_LATER': {
        const state = await getState();
        sendResponse(state);
        if (!state.paused) scheduleDelayedCapture(state.tabId, state);
        break;
      }

      case 'SET_SETTINGS': {
        const state = await getState();
        const { captureMode, ...rest } = message.settings;
        const next =
          state.recording && captureMode && captureMode !== state.settings.captureMode
            ? await switchCaptureMode(captureMode)
            : state;
        sendResponse(await setState({ settings: { ...next.settings, ...(state.recording ? rest : message.settings) } }));
        break;
      }

      case 'CLICK_CAPTURE': {
        const state = await getState();
        const reason = message.reason || 'click';
        const allowed =
          reason === 'manual-hotkey' ||
          (reason === 'scrolled' ? state.settings.captureOnScroll : state.settings.captureOnClick);
        const tabId = sender.tab?.id;
        if (state.recording && allowed && tabId !== undefined && (await isRecordedTab(tabId))) {
          await adoptActiveTab(tabId);
          if (!state.paused) await captureNow(reason, message.label);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'API_HOOK_READY': {
        const state = await getState();
        if (state.recording && (await isRecordedTab(sender.tab?.id)) && !state.apiHookReady) {
          await setState({ apiHookReady: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'API_CAPTURE': {
        const state = await getState();
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

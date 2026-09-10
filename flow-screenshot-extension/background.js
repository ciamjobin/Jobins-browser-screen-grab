const STATE_KEY = 'flowRecorderState';
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
  tabId: null,
  windowId: null,
  sessionId: null,
  sequence: 0,
  captures: [],
  downloadIds: [],
  apiSeen: 0,
  apiHookReady: false,
  streamActive: false,
  screenWindowId: null,
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
  const stored = await chrome.storage.local.get(STATE_KEY);
  const state = stored[STATE_KEY] || {};
  return { ...defaultState, ...state, settings: { ...defaultState.settings, ...state.settings } };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch, settings: { ...current.settings, ...patch.settings } };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
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
  await chrome.action.setBadgeBackgroundColor({ color: state.recording ? '#c62828' : '#455a64' });
  await chrome.action.setBadgeText({ text: state.recording ? String(state.sequence) : '' });
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

// However a single capture fails or hangs, the queue must keep moving - otherwise every capture
// requested after it (including the popup's own "Capture now" / "Capture in 5s" buttons) would wait
// behind a promise that never settles, which looks exactly like the extension has stopped responding.
const QUEUE_WATCHDOG_TOKEN = Symbol('queue-watchdog-timeout');
async function captureNow(reason, label) {
  captureChain = captureChain
    .then(async () => {
      const result = await Promise.race([
        performCapture(reason, label),
        new Promise((resolve) => setTimeout(() => resolve(QUEUE_WATCHDOG_TOKEN), CAPTURE_QUEUE_WATCHDOG_MS))
      ]);
      if (result === QUEUE_WATCHDOG_TOKEN) {
        logLine(
          `QUEUE_WATCHDOG ${reason}${label ? ` "${label}"` : ''} exceeded ${CAPTURE_QUEUE_WATCHDOG_MS}ms, moving on`
        );
      }
    })
    .catch(async (error) => {
      logLine(`ERROR ${reason}${label ? ` "${label}"` : ''}: ${error.message}`);
      await writeLogFile().catch(() => {});
      console.error('Capture failed:', error);
      await setState({ lastError: `Capture failed: ${error.message}` });
    });
  return captureChain;
}

// Shows an on-page countdown so the user can see exactly when the delayed shot will fire, then
// takes it. The badge lives in the page itself since the popup that requested this has closed.
function scheduleDelayedCapture(tabId) {
  if (typeof tabId === 'number') {
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_COUNTDOWN', seconds: CAPTURE_COUNTDOWN_MS / 1000 }).catch(() => {
      /* No content script on this page (chrome://, Web Store); the capture still fires on time. */
    });
  }
  delay(CAPTURE_COUNTDOWN_MS).then(() => captureNow('devtools-panel'));
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
const FULL_PAGE_MAX_HEIGHT = 12000;
const FULL_PAGE_WATCHDOG_MS = 9000;
const SCROLLER_MAX_FRAMES = 10;
const FULL_PAGE_GROW_ROUNDS = 4;
const FULL_PAGE_RELAYOUT_MS = 450;
const FULL_PAGE_RELAYOUT_MAX_MS = 1400;
const FULL_PAGE_IMAGE_POLLS = 6;
const FULL_PAGE_IMAGE_POLL_MS = 250;
// Chromium refuses a single shot past its texture limit, so step down until one is accepted.
const FULL_PAGE_RETRY_HEIGHTS = [16384, 12000, 8192];
const SCROLLER_SETTLE_MAX_MS = 600;
// Growing the viewport visibly reflows the page, so it happens only when the user asks for it.
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
      return {
        width: innerWidth,
        viewportHeight: innerHeight,
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
          '* { scrollbar-width: none !important; -ms-overflow-style: none !important; }' +
          '*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }';
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

// Growing the viewport starts every lazy image at once; capturing before they land leaves holes.
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

const BLANK_TAIL_TOLERANCE = 10;
const BLANK_TAIL_ROW_MATCH_RATIO = 0.97;
const BLANK_TAIL_SCAN_CHUNK_ROWS = 256;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// A requested height is a DOM measurement and can overshoot what actually renders, leaving a flat
// trailing band of background colour under the very last real content. Only that trailing band is
// removed - collapsing blank-looking bands in the middle of the page was tried and reverted, because
// a sparse row (a single checkbox plus a short label, for instance) can look "blank enough" to a
// column-sampled colour check and get removed even though it is genuine content.
async function trimBlankTail(dataUrl) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);

    const { width, height } = canvas;
    const sampleStep = Math.max(2, Math.floor(width / 300)) * 4;
    const samplesPerRow = Math.ceil((width * 4) / sampleStep);
    const reference = ctx.getImageData(width - 1, height - 1, 1, 1).data;
    const matchesReference = (data, i) =>
      Math.abs(data[i] - reference[0]) <= BLANK_TAIL_TOLERANCE &&
      Math.abs(data[i + 1] - reference[1]) <= BLANK_TAIL_TOLERANCE &&
      Math.abs(data[i + 2] - reference[2]) <= BLANK_TAIL_TOLERANCE;

    // Accepting a small fraction of mismatched samples per row means a stray divider line or
    // anti-aliased edge cannot halt the scan one row too early.
    let contentEnd = height;
    for (let bottom = height; bottom > 0; bottom -= BLANK_TAIL_SCAN_CHUNK_ROWS) {
      const top = Math.max(0, bottom - BLANK_TAIL_SCAN_CHUNK_ROWS);
      const { data } = ctx.getImageData(0, top, width, bottom - top);
      let stop = false;
      for (let row = bottom - top - 1; row >= 0; row -= 1) {
        const rowStart = row * width * 4;
        let mismatches = 0;
        for (let i = rowStart; i < rowStart + width * 4; i += sampleStep) {
          if (!matchesReference(data, i)) mismatches += 1;
        }
        if (mismatches > samplesPerRow * (1 - BLANK_TAIL_ROW_MATCH_RATIO)) {
          contentEnd = top + row + 1;
          stop = true;
          break;
        }
      }
      if (stop) break;
      contentEnd = top;
    }

    // If the very last pixel happens to match the page's own content colour (a solid-colour footer
    // background, for instance) rather than genuine blank space, every row above can look "blank" by
    // comparison and the whole image would be wiped out. A real trailing gap is realistically a
    // modest fraction of the page, so refuse to trust a result that removes most of it.
    if (contentEnd >= height || contentEnd < height * 0.5) return dataUrl;

    const cropped = new OffscreenCanvas(width, contentEnd);
    cropped.getContext('2d').drawImage(canvas, 0, 0);
    const buffer = await (await cropped.convertToBlob({ type: 'image/png' })).arrayBuffer();
    return `data:image/png;base64,${arrayBufferToBase64(buffer)}`;
  } catch (error) {
    console.warn('Could not trim blank space, using the capture as-is:', error.message);
    return dataUrl;
  } finally {
    bitmap?.close();
  }
}

async function setViewportHeight(tabId, width, height) {
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false
  });
  // A tall page has proportionally more to lay out and more lazy content to trigger.
  await delay(Math.min(FULL_PAGE_RELAYOUT_MS + height / 20, FULL_PAGE_RELAYOUT_MAX_MS));
}

// A plain document is already laid out at its full scrollable height in the common case, but pages
// that lazy-load content as it enters the viewport only have real content up to where the user has
// actually scrolled - growing the viewport (not scrolling it) brings the rest into view so it loads,
// at the cost of a brief, momentary layout change while the shot is taken.
async function captureDocumentHeadless(tabId, scrollX, scrollY, width, height) {
  if (!(await attachDebugger(tabId))) return null;

  let applied = height;
  let previousOverflow = Infinity;
  try {
    for (let round = 0; round < FULL_PAGE_GROW_ROUNDS; round += 1) {
      await setViewportHeight(tabId, width, applied);

      const grown = await measureDocument(tabId).catch(() => null);
      if (!grown) break;

      const wanted = Math.min(grown.docHeight, FULL_PAGE_MAX_HEIGHT);
      const overflow = wanted - applied;
      // An overflow that stops shrinking means something is sized to the viewport and would grow
      // with it forever, so stop at the last height that made progress.
      if (overflow <= 4 || overflow >= previousOverflow - 4) break;
      previousOverflow = overflow;
      applied = wanted;
    }

    await waitForImages(tabId);

    for (const attempt of [applied, ...FULL_PAGE_RETRY_HEIGHTS.filter((h) => h < applied)]) {
      try {
        const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: attempt, scale: 1 }
        });
        if (result?.data) return await trimBlankTail(`data:image/png;base64,${result.data}`);
      } catch (error) {
        console.warn(`Full-page shot of ${attempt}px refused, trying shorter:`, error.message);
      }
    }
    return null;
  } catch (error) {
    console.warn('Full-page capture failed, using the visible frame:', error.message);
    return null;
  } finally {
    await chrome.debugger
      .sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride')
      .catch(() => {});
    // Resizing the layout viewport can leave the page resting somewhere else once it snaps back.
    await chrome.scripting
      .executeScript({
        target: { tabId },
        world: 'ISOLATED',
        args: [scrollX, scrollY],
        func: (x, y) => window.scrollTo({ left: x, top: y, behavior: 'instant' })
      })
      .catch(() => {});
    // The debugger is only needed for the instant of the shot, so let go of it immediately - that
    // is what makes the "started debugging this browser" banner disappear right away.
    await detachDebugger();
  }
}

// For an app-shell pane that only reveals its content while scrolled, scroll just that pane and
// stitch the results. This never touches the debugger and never resizes the window - only the pane
// itself visibly moves, exactly as it would if the user scrolled it by hand.
async function captureScrollerStitch(tabId, windowId, scroller) {
  const { viewportWidth, viewportHeight, rectTop, rectLeft, rectWidth, rectHeight, dpr } = scroller;
  const totalTravel = scroller.scrollHeight - scroller.clientHeight;
  // Bounds both the capture time and the number of full-resolution bitmaps held in memory at once.
  // A wider overlap between consecutive frames (rather than the bare minimum) gives some slack for
  // any lazily-rendered content near a scroll boundary to have actually painted by the time of the
  // next frame, instead of a thin seam where a row could be missed by both frames' visible slice.
  const step = Math.max(rectHeight - 150, Math.ceil(totalTravel / SCROLLER_MAX_FRAMES), 80);
  const stops = [];
  for (let top = 0; top < totalTravel; top += step) stops.push(top);
  stops.push(totalTravel);

  const frames = [];
  try {
    await hideScrollbars(tabId);
    for (const target of stops) {
      const { scrollTop } = await scrollScrollerTo(tabId, SCROLLER_MARK_ATTR, target);
      await delay(450);
      // Must target the recorded tab's own window explicitly - omitting it captures whatever
      // window the OS currently has focused, which can be a different one entirely.
      const dataUrl = await captureVisibleTabWithRetry(windowId).catch(() => null);
      if (!dataUrl) continue;
      frames.push({ scrollTop, dataUrl });
    }
    if (!frames.length) return null;

    const belowHeight = Math.max(0, viewportHeight - (rectTop + rectHeight));
    const finalScrollHeight = frames[frames.length - 1].scrollTop + rectHeight;
    const totalHeight = rectTop + finalScrollHeight + belowHeight;

    const canvas = new OffscreenCanvas(Math.round(viewportWidth * dpr), Math.round(totalHeight * dpr));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const bitmaps = [];
    try {
      for (const frame of frames) {
        bitmaps.push({
          scrollTop: frame.scrollTop,
          bitmap: await createImageBitmap(await (await fetch(frame.dataUrl)).blob())
        });
      }

      const topHeight = Math.round(rectTop * dpr);
      const sliceHeight = Math.round(rectHeight * dpr);
      const sliceLeft = Math.round(rectLeft * dpr);
      const sliceWidth = Math.round(rectWidth * dpr);

      const first = bitmaps[0].bitmap;
      if (topHeight > 0) ctx.drawImage(first, 0, 0, first.width, topHeight, 0, 0, first.width, topHeight);

      // A fixed sidebar or rail that sits beside the scroller (not above or below it) does not move
      // as the pane scrolls, so it must come from a single frame like the top/bottom chrome does -
      // stitching the full frame width here would draw that same sidebar again in every frame,
      // stacked down the page (this is what caused a "Home" icon to repeat several times).
      const hasLeftRail = sliceLeft > 0;
      const hasRightRail = sliceLeft + sliceWidth < first.width;
      const railHeight = first.height - topHeight;
      // A fixed rail has no real content past one viewport's height, but leaving the rest of its
      // column at the canvas's default white looks like a rendering defect (the panel's own
      // background colour appearing to just stop partway down) rather than "nothing more to show" -
      // stretching its own last row down the remaining height reads as one continuous panel instead.
      const extendRail = (x, w) => {
        if (w <= 0 || railHeight <= 0) return;
        const remaining = canvas.height - (topHeight + railHeight);
        if (remaining > 0) {
          ctx.drawImage(first, x, first.height - 1, w, 1, x, topHeight + railHeight, w, remaining);
        }
        ctx.drawImage(first, x, topHeight, w, railHeight, x, topHeight, w, railHeight);
      };
      if (hasLeftRail) extendRail(0, sliceLeft);
      if (hasRightRail) extendRail(sliceLeft + sliceWidth, first.width - (sliceLeft + sliceWidth));

      for (const { scrollTop, bitmap } of bitmaps) {
        const destY = Math.round((rectTop + scrollTop) * dpr);
        ctx.drawImage(bitmap, sliceLeft, topHeight, sliceWidth, sliceHeight, sliceLeft, destY, sliceWidth, sliceHeight);
      }

      const last = bitmaps[bitmaps.length - 1].bitmap;
      const belowSourceTop = Math.round((rectTop + rectHeight) * dpr);
      const belowSourceHeight = last.height - belowSourceTop;
      if (belowSourceHeight > 0) {
        ctx.drawImage(
          last,
          0,
          belowSourceTop,
          last.width,
          belowSourceHeight,
          0,
          canvas.height - belowSourceHeight,
          last.width,
          belowSourceHeight
        );
      }
    } finally {
      for (const { bitmap } of bitmaps) bitmap.close();
    }

    const buffer = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    return await trimBlankTail(`data:image/png;base64,${arrayBufferToBase64(buffer)}`);
  } finally {
    await scrollScrollerTo(tabId, SCROLLER_MARK_ATTR, scroller.scrollTop);
    await clearScrollerMark(tabId);
    await restoreScrollbars(tabId);
  }
}

// Captures the whole page without ever moving what the user sees where that is possible. An
// app-shell pane is handled by scrolling only that pane - no debugger, no reflow. A plain tall
// document instead needs a momentary viewport resize so lazy-loaded content actually renders (a
// resize-only capture leaves anything below the original viewport as unloaded placeholders).
// Returns null when neither applies, so the caller just takes the ordinary visible frame.
async function captureFullPagePassive(tabId, windowId) {
  if (!HAS_DEBUGGER) return null;

  // DevTools already open on this tab owns the one available debugger session, and a docked
  // DevTools panel also shrinks the real viewport out from under any scroll/stitch measurement
  // taken beforehand. Rather than produce a partial or misaligned result, fall straight back to a
  // single honest screenshot of what is actually on screen right now.
  if (!(await attachDebugger(tabId))) return null;

  const doc = await measureDocument(tabId).catch(() => null);
  if (!doc?.viewportHeight) {
    await detachDebugger();
    return null;
  }

  if (doc.docHeight > doc.viewportHeight + 4) {
    const height = Math.min(doc.docHeight, FULL_PAGE_MAX_HEIGHT);
    return captureDocumentHeadless(tabId, doc.scrollX, doc.scrollY, doc.width, height);
  }

  const scroller = await findScroller(tabId).catch(() => null);
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4) {
    await clearScrollerMark(tabId);
    await detachDebugger();
    return null;
  }
  const stitched = await captureScrollerStitch(tabId, windowId, scroller);
  await detachDebugger();
  return stitched;
}

// A page that never settles (throttled background tab, an element that keeps growing, a stalled
// network wait) must never be allowed to stall the whole recording - past the watchdog, give up and
// fall back to the ordinary visible frame instead. The badge shows "..." for the same reason: a
// multi-second full-page capture must not look identical to the extension having stopped responding.
async function captureFullPageWithWatchdog(tabId, windowId) {
  const state = await getState();
  await chrome.action.setBadgeText({ text: state.recording ? '\u2026' : '' });
  try {
    const FULL_PAGE_TIMEOUT_TOKEN = Symbol('full-page-timeout');
    const timeout = new Promise((resolve) => setTimeout(() => resolve(FULL_PAGE_TIMEOUT_TOKEN), FULL_PAGE_WATCHDOG_MS));
    const result = await Promise.race([captureFullPagePassive(tabId, windowId).catch(() => null), timeout]);
    if (result === FULL_PAGE_TIMEOUT_TOKEN) {
      logLine(`FULL_PAGE_WATCHDOG exceeded ${FULL_PAGE_WATCHDOG_MS}ms, using the visible frame instead`);
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
  await setDownloadUi(true).catch(() => {});
  apiQueue = [];
  apiHeaderRecords = [];
  lastRawCaptureHash = '';
  lastTabTitle = '';
  sessionTabIds = new Set();
}

async function performCapture(reason, label) {
  const startedAt = Date.now();
  const state = await getState();
  if (!state.recording || state.tabId === null) return;

  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab) {
    await stopRecording();
    return;
  }

  // Let the page settle (navigation paint, click-driven UI updates) before grabbing the frame.
  const settle =
    reason === 'navigation' ? 600 : reason === 'devtools-panel' ? 150 : reason === 'dialog-opened' ? 550 : 450;
  await delay(state.settings.captureApi ? settle + 500 : settle);

  // Full-page capture renders the page itself, not whatever surface a mode normally captures - that
  // applies just as well in Screen/window and API mode as it does in Tab viewport mode. The queue
  // watchdog above is what actually guards against this hanging the rest of the recording, so this
  // no longer needs to be restricted to specific modes to stay safe.
  const wantsFullPage = state.settings.fullPage && FULL_PAGE_REASONS.has(reason);
  const fullPage = wantsFullPage ? await captureFullPageWithWatchdog(tab.id, tab.windowId) : null;
  const fullPageInfo = wantsFullPage ? (fullPage ? 'ok' : 'fell back to visible frame') : 'n/a';
  const heading = await getPageHeading(tab.id).catch(() => '');

  return persistCapture({
    rawDataUrl: fullPage || (await grabPngDataUrl(state, tab)),
    title: heading || tab.title || tab.url || 'Untitled page',
    url: tab.url || '',
    reason,
    label,
    startedAt,
    mode: state.settings.captureMode,
    fullPageInfo
  });
}

async function persistCapture({ rawDataUrl, title, url, reason, label, startedAt, mode, fullPageInfo }) {
  const state = await getState();
  if (!state.recording) return;

  const { settings } = state;
  const capturedAt = new Date();
  const sequence = state.sequence + 1;
  const apiRows = apiQueue;
  apiQueue = [];

  const rawHash = hashText(rawDataUrl);
  if (!shouldKeepDuplicate(reason, apiRows) && rawHash === lastRawCaptureHash) {
    logLine(`SKIP (duplicate) ${reason}${label ? ` "${label}"` : ''} mode=${mode} fullPage=${fullPageInfo}`);
    return null;
  }
  lastRawCaptureHash = rawHash;

  await ensureOffscreen();
  const processed = await askOffscreen('OFFSCREEN_PROCESS', {
    dataUrl: rawDataUrl,
    stampText: settings.stampTimestamp ? stampText(capturedAt) : null,
    watermarkText: WATERMARK,
    titleBar: { title, url },
    wantPng: settings.savePng,
    wantJpeg: settings.savePdf,
    apiRows
  });
  rawDataUrl = null;
  if (processed?.error) throw new Error(processed.error);

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
async function exportPdfInWindow(filename, selectedSequences) {
  const params = new URLSearchParams({ filename });
  if (Array.isArray(selectedSequences)) {
    const selected = [...new Set(selectedSequences.filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0))];
    params.set('selected', selected.join(','));
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
  sessionTabIds = new Set([tab.id]);
  await chrome.storage.local.remove(LOG_KEY).catch(() => {});
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

  const state = await setState({
    recording: true,
    tabId: tab.id,
    windowId: tab.windowId,
    sessionId: `session_${fileTimestamp(new Date())}`,
    sequence: 0,
    captures: [],
    downloadIds: [],
    apiSeen: 0,
    apiHookReady: false,
    streamActive,
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
async function exportPdfNow(requestedPdfFilename, selectedSequences) {
  if (apiQueue.length) await captureNow('final-api-calls');
  await captureChain.catch(() => {});

  const state = await getState();
  if (!state.recording) return setState({ lastError: 'Not currently recording.' });
  if (!state.captures.length) return setState({ lastError: 'Nothing captured yet.' });

  const result = await exportPdfInWindow(
    `flow-captures/${state.sessionId}/${pdfFilename(requestedPdfFilename, `${state.sessionId}_checkpoint`)}`,
    selectedSequences
  );
  await writeLogFile().catch(() => {});
  if (result.error) {
    return setState({ lastError: `PDF export failed: ${result.error}` });
  }
  return setState({ lastError: null });
}

async function stopRecording(keepFiles = true, requestedPdfFilename, selectedSequences) {
  // Anything still queued would be lost, so give it a final frame to sit under.
  if (keepFiles && apiQueue.length) {
    await captureNow('final-api-calls');
  }
  await captureChain.catch(() => {});
  const state = await getState();
  logLine(`SESSION_END keepFiles=${keepFiles} captures=${state.captures.length}`);
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
      const result = await exportPdfInWindow(
        `flow-captures/${state.sessionId}/${pdfFilename(requestedPdfFilename, state.sessionId)}`,
        selectedSequences
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
    tabId: null,
    windowId: null,
    streamActive: false,
    downloadIds: [],
    lastError:
      lastError ?? (keepFiles ? null : `Deleted ${state.downloadIds.length} file(s) from this session.`)
  });
  await updateBadge(next);
  return next;
}

/* ---------------------------------------------------------------- listeners */

// The tab a recording started on, plus any tab opened from it (or from one of those, recursively) -
// an OAuth/sign-in redirect chain routinely hops across several. In-memory only: a service worker
// restart forgets any child tabs and falls back to just the original one, which storage still has.
let sessionTabIds = new Set();

async function isRecordedTab(tabId) {
  const state = await getState();
  return state.recording && (tabId === state.tabId || sessionTabIds.has(tabId));
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
  sessionTabIds.delete(tabId);
  const state = await getState();
  if (state.recording && tabId === state.tabId) {
    // The active tab closed but the session has other known tabs - follow to whichever one is
    // currently on screen instead of ending the recording.
    const [fallback] = await chrome.tabs.query({ active: true }).catch(() => []);
    if (fallback && sessionTabIds.has(fallback.id)) {
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
  if (!state.recording || !(tab.openerTabId === state.tabId || sessionTabIds.has(tab.openerTabId))) return;
  sessionTabIds.add(tab.id);
  logLine(`NEW_TAB opened from recorded tab (tabId=${tab.id}), bringing it into focus`);
  // Activating the tab below fires onActivated, which is what actually adopts it as the current
  // capture target - calling adoptActiveTab here too just raced that same update and logged twice.
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
});

// DevTools panel changes are not observable, so the user triggers those captures by hotkey.
chrome.commands.onCommand.addListener(async (command) => {
  const state = await getState();
  if (!state.recording) return;

  if (command === 'capture-panel') await captureNow('devtools-panel');
  if (command === 'capture-manual') await captureNow('manual-hotkey');
  if (command === 'capture-later') scheduleDelayedCapture(state.tabId);
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

      case 'STOP':
        try {
          sendResponse(await stopRecording(message.keepFiles !== false, message.pdfFilename, message.selectedSequences));
        } catch (error) {
          await cleanupCaptureResources();
          sendResponse(await setState({ recording: false, lastError: error.message }));
        }
        break;

      case 'EXPORT_PDF_NOW':
        try {
          sendResponse(await exportPdfNow(message.pdfFilename, message.selectedSequences));
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
        scheduleDelayedCapture(state.tabId);
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
        const allowed = reason === 'scrolled' ? state.settings.captureOnScroll : state.settings.captureOnClick;
        const tabId = sender.tab?.id;
        if (state.recording && allowed && tabId !== undefined && (await isRecordedTab(tabId))) {
          await adoptActiveTab(tabId);
          await captureNow(reason, message.label);
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
          await queueApiCall({ ...message.detail, tabId: sender.tab.id });
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

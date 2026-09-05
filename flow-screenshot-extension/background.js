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
    captureApi: false,
    stampTimestamp: true,
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
const DEDUPE_REASONS = new Set(['navigation', 'url-change']);

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

async function captureNow(reason, label) {
  captureChain = captureChain
    .then(() => performCapture(reason, label))
    .catch(async (error) => {
      console.error('Capture failed:', error);
      await setState({ lastError: `Capture failed: ${error.message}` });
    });
  return captureChain;
}

async function grabPngDataUrl(state, tab) {
  if (state.settings.captureMode === 'screen' && state.streamActive) {
    const result = await askScreen('SCREEN_CAPTURE');
    if (result?.dataUrl) return result.dataUrl;
    console.warn('Screen capture unavailable, falling back to tab capture:', result?.error);
  }
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

/* ------------------------------------------------------------- full page */

// captureVisibleTab (and a shared screen/tab frame) only ever shows one viewport's worth of a
// scrollable page, so a taller page has to be scrolled in slices and the slices stitched together.
const FULL_PAGE_MAX_SEGMENTS = 12;
const FULL_PAGE_SETTLE_MS = 220;
// Chrome throttles captureVisibleTab to a couple of calls per second; stay comfortably under that.
const FULL_PAGE_CAPTURE_GAP_MS = 550;

async function getPageMetrics(tabId) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        scrollHeight: Math.max(
          doc.scrollHeight,
          doc.offsetHeight,
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0
        ),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        dpr: window.devicePixelRatio || 1
      };
    }
  });
  return injected?.result || null;
}

// Waits for the scroll to actually land before returning, since a page's own CSS (e.g.
// `scroll-behavior: smooth`) can make scrollTo animate instead of jumping immediately -
// reading scrollY right away would then report the pre-scroll position.
async function scrollTabTo(tabId, x, y) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [x, y],
    func: async (targetX, targetY) => {
      const root = document.scrollingElement || document.documentElement;
      const previousBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      window.scrollTo({ left: targetX, top: targetY, behavior: 'instant' });

      const settled = (value, target) => Math.abs(value - target) < 2;
      for (let attempt = 0; attempt < 10 && !settled(window.scrollY, targetY); attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      root.style.scrollBehavior = previousBehavior;

      return { scrollX: window.scrollX, scrollY: window.scrollY };
    }
  });
  return injected?.result || { scrollX: x, scrollY: y };
}

// Chunked so a multi-megabyte screenshot doesn't blow the call-stack limit of String.fromCharCode.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// Runs in the service worker itself: OffscreenCanvas needs no DOM, so no offscreen document is needed.
async function stitchFullPagePng(frames, width, scrollHeight, dpr) {
  const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(scrollHeight * dpr));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const frame of frames) {
    const blob = await (await fetch(frame.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, Math.round(frame.y * dpr));
    bitmap.close();
  }

  const buffer = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  return `data:image/png;base64,${arrayBufferToBase64(buffer)}`;
}

// Scrolls the recorded tab in viewport-sized steps, capturing a frame at each stop, then stitches
// the frames into one tall image so the saved screenshot covers the whole scrollable page.
async function captureFullPageDataUrl(state, tab) {
  const single = () => grabPngDataUrl(state, tab);

  let metrics;
  try {
    metrics = await getPageMetrics(tab.id);
  } catch {
    metrics = null; // Restricted pages (chrome://, Web Store) cannot be instrumented.
  }
  if (!metrics || !metrics.viewportHeight) return single();

  const { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY, dpr } = metrics;
  if (scrollHeight <= viewportHeight + 4) return single();

  const positions = [];
  let y = 0;
  while (y < scrollHeight - viewportHeight && positions.length < FULL_PAGE_MAX_SEGMENTS - 1) {
    positions.push(y);
    y += viewportHeight;
  }
  positions.push(Math.max(0, scrollHeight - viewportHeight));

  const frames = [];
  try {
    for (let index = 0; index < positions.length; index += 1) {
      const actual = await scrollTabTo(tab.id, scrollX, positions[index]).catch(() => null);
      await delay(index === 0 ? FULL_PAGE_SETTLE_MS : FULL_PAGE_CAPTURE_GAP_MS);
      frames.push({ y: actual?.scrollY ?? positions[index], dataUrl: await single() });
    }
  } finally {
    await scrollTabTo(tab.id, scrollX, scrollY).catch(() => {});
  }

  if (frames.length <= 1) return frames[0]?.dataUrl ?? single();

  try {
    return await stitchFullPagePng(frames, viewportWidth, scrollHeight, dpr);
  } catch (error) {
    console.warn('Full-page stitch failed, keeping the last captured frame instead:', error.message);
    return frames[frames.length - 1].dataUrl;
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
  await clearStoredFrames().catch(() => {});
  await setDownloadUi(true).catch(() => {});
  apiQueue = [];
  apiHeaderRecords = [];
  lastRawCaptureHash = '';
  lastTabTitle = '';
}

async function performCapture(reason, label) {
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

  // 'devtools-panel' is an explicit "capture exactly what's on screen right now" hotkey, so it
  // must not scroll the page out from under whatever the user is inspecting.
  const rawDataUrl =
    reason === 'devtools-panel' ? await grabPngDataUrl(state, tab) : await captureFullPageDataUrl(state, tab);

  return persistCapture({
    rawDataUrl,
    title: tab.title || tab.url || 'Untitled page',
    url: tab.url || '',
    reason,
    label
  });
}

async function persistCapture({ rawDataUrl, title, url, reason, label }) {
  const state = await getState();
  if (!state.recording) return;

  const { settings } = state;
  const capturedAt = new Date();
  const sequence = state.sequence + 1;
  const apiRows = apiQueue;
  apiQueue = [];

  const rawHash = hashText(rawDataUrl);
  if (!shouldKeepDuplicate(reason, apiRows) && rawHash === lastRawCaptureHash) return null;
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
      time: `${stampText(capturedAt)}  |  ${reason}${label ? ` "${label}"` : ''}`,
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
    apiCalls: apiRows.length,
    capturedAt: capturedAt.toISOString(),
    filename: settings.savePng ? filename : null
  };

  const next = await setState({
    sequence,
    captures: [...state.captures, entry].slice(-300)
  });
  await updateBadge(next);
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
async function exportPdfInWindow(filename) {
  const win = await chrome.windows.create({
    url: `exporter.html?filename=${encodeURIComponent(filename)}`,
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
      if (message?.type === 'PDF_DONE') finish(message.error ? { error: message.error } : { ok: true });
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

async function startRecording(tab, settings) {
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

async function stopRecording(keepFiles = true, requestedPdfFilename) {
  // Anything still queued would be lost, so give it a final frame to sit under.
  if (keepFiles && apiQueue.length) {
    await captureNow('final-api-calls');
  }
  await captureChain.catch(() => {});
  const state = await getState();
  let lastError = null;

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
      });
    }

    if (state.settings.savePdf && state.captures.length) {
      const result = await exportPdfInWindow(
        `flow-captures/${state.sessionId}/${pdfFilename(requestedPdfFilename, state.sessionId)}`
      );
      if (result.error) {
        lastError = `PDF export failed: ${result.error}`;
        console.error(lastError);
      }
    }
  }

  await cleanupCaptureResources();

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

async function isRecordedTab(tabId) {
  const state = await getState();
  return state.recording && tabId === state.tabId;
}

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId === 0 && (await isRecordedTab(details.tabId))) {
    await captureNow('navigation');
  }
});

// Single-page apps change routes without a full page load.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId === 0 && (await isRecordedTab(details.tabId))) {
    await captureNow('url-change');
  }
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details) => {
  if (details.frameId === 0 && (await isRecordedTab(details.tabId))) {
    await captureNow('url-change');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.title || !(await isRecordedTab(tabId))) return;
  if (changeInfo.title === lastTabTitle) return;
  lastTabTitle = changeInfo.title;
  await captureNow('title-change', changeInfo.title);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (await isRecordedTab(tabId)) {
    await stopRecording();
  }
});

// DevTools panel changes are not observable, so the user triggers those captures by hotkey.
chrome.commands.onCommand.addListener(async (command) => {
  const state = await getState();
  if (!state.recording) return;

  if (command === 'capture-panel') await captureNow('devtools-panel');
  if (command === 'capture-manual') await captureNow('manual-hotkey');
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
          sendResponse(await stopRecording(message.keepFiles !== false, message.pdfFilename));
        } catch (error) {
          await cleanupCaptureResources();
          sendResponse(await setState({ recording: false, lastError: error.message }));
        }
        break;

      case 'CAPTURE_NOW':
        await captureNow('manual');
        sendResponse(await getState());
        break;

      case 'SET_SETTINGS':
        sendResponse(await setState({ settings: message.settings }));
        break;

      case 'CLICK_CAPTURE': {
        const state = await getState();
        if (state.recording && state.settings.captureOnClick && sender.tab?.id === state.tabId) {
          await captureNow(message.reason || 'click', message.label);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'API_HOOK_READY': {
        const state = await getState();
        if (state.recording && sender.tab?.id === state.tabId && !state.apiHookReady) {
          await setState({ apiHookReady: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'API_CAPTURE': {
        const state = await getState();
        if (state.recording && state.settings.captureApi && sender.tab?.id === state.tabId) {
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

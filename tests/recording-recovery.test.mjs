import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  requestReadWritePermissionFromUserGesture,
  saveCaptureFolder
} from '../flow-screenshot-extension/capture-folder.js';

let backgroundImportSequence = 0;

async function loadBackground() {
  backgroundImportSequence += 1;
  await import(`${pathToFileURL(resolve('flow-screenshot-extension/background.js')).href}?test=${backgroundImportSequence}`);
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

function createStorage(values) {
  const data = structuredClone(values);
  return {
    async get(keys) {
      if (keys === null) return structuredClone(data);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        names.filter((name) => Object.hasOwn(data, name)).map((name) => [name, structuredClone(data[name])])
      );
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    snapshot() {
      return structuredClone(data);
    }
  };
}

function createIndexedDb() {
  const stores = new Map();
  return {
    open() {
      const request = { error: null };
      queueMicrotask(() => {
        const database = {
          objectStoreNames: {
            contains(name) {
              return stores.has(name);
            }
          },
          createObjectStore(name) {
            if (!stores.has(name)) stores.set(name, new Map());
          },
          transaction(name, mode = 'readonly') {
            const values = stores.get(name);
            const transaction = {
              error: null,
              objectStore() {
                return {
                  get(key) {
                    const read = { error: null };
                    queueMicrotask(() => {
                      read.result = values.get(key);
                      read.onsuccess?.();
                    });
                    return read;
                  },
                  put(value, key) {
                    values.set(key, value);
                  }
                };
              }
            };
            if (mode === 'readwrite') queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
          },
          close() {}
        };
        request.result = database;
        if (!stores.has('folders')) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function createResumeFolder({ withPreviousCapture = true } = {}) {
  const imageName = '001_2026-09-12_10-00-00-000_Previous_step.png';
  const manifest = JSON.stringify({
    sessionId: 'session_before_crash',
    screenshots: [{
      sequence: 1,
      title: 'Previous step',
      note: 'Restored note',
      url: 'https://example.test/previous',
      reason: 'click',
      mode: 'tab',
      capturedAt: '2026-09-12T10:00:00.000Z',
      actionAt: '2026-09-12T09:59:59.000Z',
      requestSequence: 9,
      filename: `flow-captures/session_before_crash/${imageName}`
    }]
  });
  const files = new Map();
  if (withPreviousCapture) {
    files.set(imageName, { contents: Uint8Array.from([112, 114, 111, 98, 101]), type: 'image/png' });
    files.set('flow-manifest.json', { contents: manifest, type: 'application/json' });
  }
  const written = new Map();
  let permission = 'granted';
  let reportedPermission = null;

  const bytesFor = async (contents) => {
    if (typeof contents === 'string') return new TextEncoder().encode(contents);
    if (contents instanceof Uint8Array) return contents;
    if (contents instanceof ArrayBuffer) return new Uint8Array(contents);
    return new Uint8Array(await contents.arrayBuffer());
  };
  const fileHandle = (name) => ({
    kind: 'file',
    name,
    async getFile() {
      const stored = files.get(name);
      if (!stored) throw new Error(`No file named ${name}`);
      const bytes = await bytesFor(stored.contents);
      return {
        name,
        type: stored.type,
        lastModified: Date.parse('2026-09-12T10:00:00.000Z'),
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return new TextDecoder().decode(bytes);
        }
      };
    },
    async createWritable() {
      if (permission !== 'granted') {
        const error = new Error('Permission denied');
        error.name = 'NotAllowedError';
        throw error;
      }
      return {
        async write(contents) {
          written.set(name, contents);
        },
        async close() {},
        async abort() {}
      };
    }
  });
  return {
    written,
    addFile(name, contents, type = 'application/octet-stream') {
      files.set(name, { contents, type });
    },
    directoryHandle: {
      kind: 'directory',
      name: 'session_before_crash',
      async queryPermission() {
        return reportedPermission ?? permission;
      },
      async requestPermission() {
        permission = 'granted';
        reportedPermission = null;
        return permission;
      },
      async *values() {
        for (const name of files.keys()) yield fileHandle(name);
      },
      async getFileHandle(name, options = {}) {
        if (!files.has(name) && !options.create) throw new Error(`No file named ${name}`);
        if (!files.has(name)) files.set(name, { contents: new Uint8Array(), type: 'application/octet-stream' });
        return fileHandle(name);
      },
      async removeEntry(name) {
        files.delete(name);
        written.delete(name);
      }
    },
    setPermission(value) {
      permission = value;
    },
    setReportedPermission(value) {
      reportedPermission = value;
    }
  };
}

test('requests folder write permission immediately from a user gesture', async () => {
  let queryCalls = 0;
  let requestCalls = 0;
  const directoryHandle = {
    async queryPermission() {
      queryCalls += 1;
      return 'prompt';
    },
    requestPermission(options) {
      requestCalls += 1;
      assert.deepEqual(options, { mode: 'readwrite' });
      return Promise.resolve('granted');
    }
  };

  assert.equal(await requestReadWritePermissionFromUserGesture(directoryHandle), true);
  assert.equal(requestCalls, 1);
  assert.equal(queryCalls, 0);
});

function createChrome() {
  const sessionId = 'session_before_crash';
  const liveTab = {
    id: 7,
    windowId: 11,
    active: true,
    title: 'Recovered page',
    url: 'https://example.test/recovered'
  };
  const storage = createStorage({
    flowRecorderState: {
      recording: true,
      tabId: 99,
      windowId: 100,
      sessionId,
      sequence: 40,
      captures: Array.from({ length: 40 }, (_, index) => ({ sequence: index + 1 })),
      settings: {
        captureMode: 'tab',
        captureOnClick: true,
        captureOnScroll: true,
        captureApi: false,
        stampTimestamp: false,
        fullPage: false,
        savePng: false,
        savePdf: false
      }
    },
    flowRecorderSessionControl: { sessionId, paused: false, captureGeneration: 4 },
    flowRecorderSessionTracking: { sessionId, tabIds: [99], windowIds: [100] }
  });
  const injectedFiles = [];
  const downloadRequests = [];
  const offscreenMessages = [];
  const screenMessages = [];
  const exportRequests = [];
  const revealedDownloads = [];
  const revealRecordingStates = [];
  const downloadUiEvents = [];
  const downloadLifecycleEvents = [];
  const downloadActivity = [];
  const tabMessages = [];
  const windowUpdates = [];
  const removedDownloads = [];
  const erasedDownloads = [];
  const badgeTexts = [];
  const existingDownloadFilenames = new Set();
  const downloadSearchQueries = [];
  let captureError = null;
  let downloadShowError = null;
  let offscreenProcessFailure = null;
  let offscreenProcessGate = null;
  let releaseOffscreenProcess = null;
  let captureCount = 0;
  let nextExportWindowId = 1000;
  let completeOutputDuringWindowCreate = false;
  let sendUnrelatedOutputBeforeCompletion = false;
  const captureTimeline = [];
  let renderSettlePending = false;
  let resolveRenderSettle = null;
  let markRenderSettleStarted = null;
  let renderSettleStarted = new Promise((resolve) => {
    markRenderSettleStarted = resolve;
  });
  let executeScriptHandler = null;

  const chrome = {
    storage: { local: storage },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText({ text }) {
        badgeTexts.push(text);
      }
    },
    downloads: {
      async search(query = {}) {
        downloadSearchQueries.push(query);
        if (Number.isSafeInteger(query.id)) return [];
        return [...existingDownloadFilenames].map((filename, index) => ({
          id: 9000 + index,
          filename: `C:\\Users\\tester\\Downloads\\${filename.replace(/\//g, '\\')}`,
          state: 'complete'
        }));
      },
      async download(options) {
        downloadActivity.push({ type: 'download', filename: options.filename });
        downloadRequests.push(options);
        const downloadId = downloadRequests.length;
        setTimeout(() => {
          for (const listener of chrome.downloads.onChanged.listeners) {
            listener({ id: downloadId, bytesReceived: { current: 1 } });
          }
          downloadLifecycleEvents.push(`complete:${downloadId}`);
          for (const listener of chrome.downloads.onChanged.listeners) {
            listener({ id: downloadId, state: { current: 'complete' } });
          }
        }, 0);
        return downloadId;
      },
      async setUiOptions({ enabled }) {
        downloadActivity.push({ type: 'ui', enabled });
        downloadUiEvents.push(`ui:${enabled}`);
        downloadLifecycleEvents.push(`ui:${enabled}`);
      },
      async removeFile(downloadId) {
        removedDownloads.push(downloadId);
      },
      async erase(query) {
        erasedDownloads.push(query);
      },
      async show(downloadId) {
        if (downloadShowError) throw downloadShowError;
        revealedDownloads.push(downloadId);
        revealRecordingStates.push(storage.snapshot().flowRecorderState?.recording);
        downloadUiEvents.push(`show:${downloadId}`);
        downloadLifecycleEvents.push(`show:${downloadId}`);
      },
      async showDefaultFolder() {
        revealedDownloads.push('default-folder');
        revealRecordingStates.push(storage.snapshot().flowRecorderState?.recording);
        downloadUiEvents.push('show:default-folder');
        downloadLifecycleEvents.push('show:default-folder');
      },
      onChanged: createEvent()
    },
    offscreen: {
      async hasDocument() {
        return true;
      },
      async createDocument() {},
      async closeDocument() {}
    },
    runtime: {
      onMessage: createEvent(),
      onStartup: createEvent(),
      onInstalled: createEvent(),
      async sendMessage(message) {
        if (message.target === 'screen') {
          screenMessages.push(message);
          if (message.type === 'SCREEN_BUFFER_CAPTURE') return { frameId: `frame-${screenMessages.length}` };
          if (message.type === 'SCREEN_CAPTURE') {
            return { dataUrl: `data:image/png;base64,${Buffer.from(`live-${screenMessages.length}`).toString('base64')}` };
          }
          if (message.type === 'SCREEN_PING') return { ok: true };
          if (message.type === 'SCREEN_TAKE_BUFFERED') {
            return { dataUrl: `data:image/png;base64,${Buffer.from(message.frameId).toString('base64')}` };
          }
          if (message.type === 'SCREEN_SUPPRESS_MONITOR') return { ok: true };
          if (message.type === 'SCREEN_FRAME_PROCESSED') return { ok: true };
          if (message.type === 'SCREEN_STOP') return { ok: true };
          throw new Error(`Unexpected screen message: ${message.type}`);
        }
        if (message.target !== 'offscreen') throw new Error(`Unexpected runtime message: ${message.type}`);
        if (message.type === 'OFFSCREEN_PING') return { ok: true };
        if (message.type === 'OFFSCREEN_SCORE_CAPTURE') return { paintedRatio: 0.5 };
        if (message.type === 'OFFSCREEN_PROCESS') {
          offscreenMessages.push(message);
          if (offscreenProcessGate) await offscreenProcessGate;
          const processingFailure = offscreenProcessFailure?.(message);
          if (processingFailure) {
            return { error: processingFailure.message || String(processingFailure) };
          }
          return {
            pngDataUrl: message.wantPng ? message.dataUrl : null,
            jpeg: message.wantJpeg ? { base64: 'cHJvYmU=', width: 1, height: 1 } : null
          };
        }
        throw new Error(`Unexpected offscreen message: ${message.type}`);
      }
    },
    tabs: {
      onUpdated: createEvent(),
      onActivated: createEvent(),
      onRemoved: createEvent(),
      onCreated: createEvent(),
      onAttached: createEvent(),
      async get(tabId) {
        if (tabId !== liveTab.id) throw new Error(`No tab with id: ${tabId}`);
        return { ...liveTab };
      },
      async query() {
        return [{ ...liveTab }];
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        return {};
      },
      async captureVisibleTab(windowId) {
        assert.equal(windowId, liveTab.windowId);
        if (captureError) throw captureError;
        captureTimeline.push('capture-visible-tab');
        captureCount += 1;
        return 'data:image/png;base64,cHJvYmU=';
      }
    },
    windows: {
      onRemoved: createEvent(),
      async update(windowId, changes) {
        windowUpdates.push({ windowId, changes });
        return { id: windowId, ...changes };
      },
      async create(options) {
        const win = { id: nextExportWindowId++ };
        exportRequests.push(options);
        const requestId = new URL(options.url, 'https://extension.test').searchParams.get('requestId');
        const complete = () => {
          for (const listener of chrome.runtime.onMessage.listeners) {
            listener({
              type: 'OUTPUT_DONE',
              requestId,
              downloadId: 5000 + exportRequests.length
            }, {}, () => {});
          }
        };
        const completeUnrelated = () => {
          for (const listener of chrome.runtime.onMessage.listeners) {
            listener({
              type: 'OUTPUT_DONE',
              requestId: 'unrelated-output-request',
              error: 'An unrelated output window failed.'
            }, {}, () => {});
          }
        };
        const sendCompletion = () => {
          if (sendUnrelatedOutputBeforeCompletion) completeUnrelated();
          complete();
        };
        if (completeOutputDuringWindowCreate) sendCompletion();
        else setTimeout(sendCompletion, 0);
        return win;
      },
      async remove() {}
    },
    webNavigation: {
      onCommitted: createEvent(),
      onCompleted: createEvent(),
      onHistoryStateUpdated: createEvent(),
      onReferenceFragmentUpdated: createEvent()
    },
    commands: { onCommand: createEvent() },
    scripting: {
      async executeScript(details) {
        if (details.files) injectedFiles.push(details.files[0]);
        const handled = await executeScriptHandler?.(details);
        if (handled !== undefined) return handled;
        if (details.args?.[0]?.reason) {
          captureTimeline.push('render-settle-start');
          markRenderSettleStarted?.();
          if (renderSettlePending) {
            return new Promise((resolve) => {
              resolveRenderSettle = () => {
                captureTimeline.push('render-settle-complete');
                resolve([{ result: { settled: true, waitedMs: details.args[0].minWaitMs } }]);
              };
            });
          }
          captureTimeline.push('render-settle-complete');
          return [{ result: { settled: true, waitedMs: details.args[0].minWaitMs } }];
        }
        return [{ result: '' }];
      }
    }
  };

  return {
    chrome,
    captureTimeline: () => [...captureTimeline],
    captureCount: () => captureCount,
    downloadLifecycleEvents,
    downloadActivity,
    downloadRequests,
    downloadSearchQueries,
    downloadUiEvents,
    erasedDownloads,
    exportRequests,
    injectedFiles,
    liveTab,
    offscreenMessages,
    screenMessages,
    storage,
    revealRecordingStates,
    revealedDownloads,
    removedDownloads,
    sessionId,
    tabMessages,
    windowUpdates,
    badgeTexts,
    setCaptureError(error) {
      captureError = error;
    },
    setRenderSettlePending(value) {
      renderSettlePending = value;
      if (value) {
        renderSettleStarted = new Promise((resolve) => {
          markRenderSettleStarted = resolve;
        });
      }
    },
    async waitForRenderSettle() {
      await renderSettleStarted;
    },
    resolveRenderSettle() {
      resolveRenderSettle?.();
    },
    setDownloadShowError(error) {
      downloadShowError = error;
    },
    setCompleteOutputDuringWindowCreate(value) {
      completeOutputDuringWindowCreate = value;
    },
    setUnrelatedOutputBeforeCompletion(value) {
      sendUnrelatedOutputBeforeCompletion = value;
    },
    addExistingDownload(filename) {
      existingDownloadFilenames.add(filename);
    },
    setOffscreenProcessFailure(failure) {
      offscreenProcessFailure = failure;
    },
    blockOffscreenProcessing() {
      offscreenProcessGate = new Promise((resolve) => {
        releaseOffscreenProcess = resolve;
      });
    },
    releaseOffscreenProcessing() {
      releaseOffscreenProcess?.();
      offscreenProcessGate = null;
      releaseOffscreenProcess = null;
    },
    setExecuteScriptHandler(handler) {
      executeScriptHandler = handler;
    },
    setStorage(patch) {
      return storage.set(patch);
    },
    storageSnapshot: () => storage.snapshot()
  };
}

function sendMessage(listener, message, sender = {}) {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${message.type}`)), 3000);
    const keepChannelOpen = listener(message, sender, (response) => {
      clearTimeout(timeout);
      resolveMessage(response);
    });
    if (keepChannelOpen !== true) {
      clearTimeout(timeout);
      reject(new Error(`Message channel closed for ${message.type}`));
    }
  });
}

test('recovers a recording after stale tab IDs, then pauses, continues, and captures', async () => {
  const originalChrome = globalThis.chrome;
  const originalConsoleError = console.error;
  const fixture = createChrome();
  const consoleErrors = [];
  globalThis.chrome = fixture.chrome;
  console.error = (...args) => consoleErrors.push(args.join(' '));

  try {
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const recovered = await sendMessage(messageListener, { type: 'GET_STATE' });

    assert.equal(recovered.tabId, fixture.liveTab.id);
    assert.deepEqual(recovered.trackedTabIds, [fixture.liveTab.id]);
    assert.equal(recovered.captureGeneration, 5);
    assert.equal(recovered.captures.length, 40);
    assert.deepEqual(fixture.injectedFiles, ['page-hook.js', 'content.js']);
    assert.deepEqual(fixture.tabMessages.at(-1), {
      tabId: fixture.liveTab.id,
      message: { type: 'API_HOOK_CONFIG', enabled: false }
    });

    const apiMode = await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { captureMode: 'api' } });
    assert.equal(apiMode.settings.captureApi, true);
    assert.deepEqual(fixture.tabMessages.at(-1), {
      tabId: fixture.liveTab.id,
      message: { type: 'API_HOOK_CONFIG', enabled: true }
    });

    const tabMode = await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { captureMode: 'tab' } });
    assert.equal(tabMode.settings.captureApi, false);
    assert.deepEqual(fixture.tabMessages.at(-1), {
      tabId: fixture.liveTab.id,
      message: { type: 'API_HOOK_CONFIG', enabled: false }
    });

    const paused = await sendMessage(messageListener, { type: 'SET_PAUSED', paused: true });
    assert.equal(paused.paused, true);
    assert.equal(paused.lastError, null);
    const continued = await sendMessage(messageListener, { type: 'SET_PAUSED', paused: false });
    assert.equal(continued.paused, false);
    assert.equal(continued.lastError, null);
    assert.equal(fixture.downloadRequests.length, 0);
    const debugLog = fixture.storageSnapshot().flowRecorderLog;
    assert.ok(debugLog.some((line) => line.includes('SESSION_PAUSED')));
    assert.ok(debugLog.some((line) => line.includes('SESSION_CONTINUED')));

    fixture.setCaptureError(new Error("The 'activeTab' permission is not in effect because this extension has not been invoked."));
    const skipped = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    assert.equal(skipped.recording, true);
    assert.equal(skipped.sequence, 40);
    assert.match(skipped.lastError, /^Capture skipped: JShotz needs access to the current page\./);
    assert.equal(fixture.captureCount(), 0);
    assert.equal(fixture.downloadRequests.length, 0);
    assert.equal(consoleErrors.length, 0);
    assert.ok(fixture.storageSnapshot().flowRecorderLog.some((line) => line.includes('CAPTURE_SKIPPED manual')));

    fixture.setCaptureError(null);
    const captured = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    assert.equal(captured.sequence, 41);
    assert.equal(captured.captures.length, 41);
    assert.equal(captured.lastError, null);
    assert.equal(fixture.captureCount(), 1);

    const clickResult = await sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Continue' },
      { tab: fixture.liveTab }
    );
    assert.deepEqual(clickResult, { ok: true });
    const afterClick = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(afterClick.sequence, 42);
    assert.equal(afterClick.captures.length, 42);
    assert.equal(fixture.captureCount(), 2);

    const modal = {
      left: 120,
      top: 90,
      width: 760,
      height: 480,
      viewportWidth: 1280,
      viewportHeight: 720,
      compact: false
    };
    const modalScrollResult = await sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'modal-scrolled', label: 'Terms 50% down', modal },
      { tab: fixture.liveTab }
    );
    assert.deepEqual(modalScrollResult, { ok: true });
    assert.equal(fixture.captureCount(), 3);
    assert.deepEqual(fixture.offscreenMessages.at(-1).modal, modal);

    const stopped = await sendMessage(messageListener, { type: 'STOP', keepFiles: true });
    assert.equal(stopped.recording, false);
    assert.deepEqual(fixture.revealedDownloads, []);
    assert.equal(fixture.downloadRequests.length, 1);
    assert.equal(fixture.downloadRequests[0].filename.endsWith('/flow-manifest.json'), true);
    assert.equal(fixture.downloadRequests.some((request) => request.filename.endsWith('/debug-log.txt')), false);
    const manifest = JSON.parse(Buffer.from(fixture.downloadRequests[0].url.split(',')[1], 'base64').toString('utf8'));
    assert.ok(manifest.debugLog.some((line) => line.includes('SESSION_PAUSED')));
    assert.ok(manifest.debugLog.some((line) => line.includes('SESSION_CONTINUED')));
    assert.ok(manifest.debugLog.some((line) => line.includes('CAPTURE_SKIPPED manual')));
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
  }
});

test('stores a newly named session under Downloads Jshotz', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  const initialState = fixture.storageSnapshot().flowRecorderState;
  await fixture.setStorage({
    flowRecorderState: {
      ...initialState,
      recording: false,
      sequence: 0,
      captures: []
    }
  });
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const started = await sendMessage(messageListener, {
      type: 'START',
      sessionFolderName: 'Retirement Plan Evidence',
      settings: { captureMode: 'tab', fullPage: false, savePng: true, savePdf: true }
    });

    assert.equal(started.recording, true);
    assert.equal(started.sessionFolderName, 'Retirement_Plan_Evidence');
    assert.ok(
      fixture.downloadRequests.some(({ filename }) =>
        filename.startsWith('Jshotz/Retirement_Plan_Evidence/') && filename.endsWith('.png')
      )
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('checks existing session folders without opening or searching browser downloads', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await fixture.setStorage({ jshotzSessionFolders: ['Claims_Evidence'] });
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];

    const existing = await sendMessage(messageListener, {
      type: 'CHECK_SESSION_FOLDER',
      sessionFolderName: 'claims evidence'
    });
    const available = await sendMessage(messageListener, {
      type: 'CHECK_SESSION_FOLDER',
      sessionFolderName: 'New evidence'
    });

    assert.deepEqual(existing, { exists: true, folderName: 'claims_evidence' });
    assert.deepEqual(available, { exists: false, folderName: 'New_evidence' });
    assert.deepEqual(fixture.downloadSearchQueries, []);
    assert.deepEqual(fixture.downloadUiEvents, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('buffers screen frames before earlier screenshots finish processing', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;
  let first;
  let second;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.setStorage({
      flowRecorderState: {
        ...fixture.storageSnapshot().flowRecorderState,
        streamActive: true,
        settings: {
          ...fixture.storageSnapshot().flowRecorderState.settings,
          captureMode: 'screen',
          savePng: false
        }
      }
    });
    fixture.blockOffscreenProcessing();

    first = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Headers' },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));
    second = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Payload' },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fixture.screenMessages.filter(({ type }) => type === 'SCREEN_BUFFER_CAPTURE').length, 2);
    assert.equal(fixture.screenMessages.filter(({ type }) => type === 'SCREEN_TAKE_BUFFERED').length, 1);

    fixture.releaseOffscreenProcessing();
    await Promise.all([first, second]);
    assert.equal(fixture.screenMessages.filter(({ type }) => type === 'SCREEN_TAKE_BUFFERED').length, 2);
    assert.equal(fixture.offscreenMessages.length, 2);
    assert.notEqual(fixture.offscreenMessages[0].dataUrl, fixture.offscreenMessages[1].dataUrl);
  } finally {
    fixture.releaseOffscreenProcessing();
    await Promise.allSettled([first, second].filter(Boolean));
    globalThis.chrome = originalChrome;
  }
});

test('waits for queued screen captures before stopping and creating evidence', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;
  let first;
  let second;
  let stopping;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.setStorage({
      flowRecorderState: {
        ...fixture.storageSnapshot().flowRecorderState,
        streamActive: true,
        settings: {
          ...fixture.storageSnapshot().flowRecorderState.settings,
          captureMode: 'screen',
          savePng: false
        }
      }
    });
    fixture.blockOffscreenProcessing();

    first = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'First queued action' },
      { tab: fixture.liveTab }
    );
    second = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Second queued action' },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));

    let stopResolved = false;
    stopping = sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      createPdf: false
    }).then((state) => {
      stopResolved = true;
      return state;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(stopResolved, false);

    fixture.releaseOffscreenProcessing();
    const [stopped] = await Promise.all([stopping, first, second]);
    assert.equal(stopped.recording, false);
    assert.equal(stopped.captures.length, 42);
    assert.deepEqual(stopped.captures.slice(-2).map(({ label }) => label), [
      'First queued action',
      'Second queued action'
    ]);
  } finally {
    fixture.releaseOffscreenProcessing();
    await Promise.allSettled([first, second, stopping].filter(Boolean));
    globalThis.chrome = originalChrome;
  }
});

test('queues an automatically buffered DevTools visual update', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.setStorage({
      flowRecorderState: {
        ...fixture.storageSnapshot().flowRecorderState,
        streamActive: true,
        settings: {
          ...fixture.storageSnapshot().flowRecorderState.settings,
          captureMode: 'screen',
          savePng: false
        }
      }
    });

    const rejected = await sendMessage(messageListener, {
      type: 'SCREEN_FRAME_BUFFERED',
      frameId: 'untrusted-frame',
      actionAt: 1200
    });
    assert.deepEqual(rejected, { ok: true, accepted: false });

    const result = await sendMessage(messageListener, {
      type: 'SCREEN_FRAME_BUFFERED',
      source: 'screen-window',
      frameId: 'visual-frame-1',
      actionAt: 1234,
      label: 'DevTools panel updated'
    });
    assert.deepEqual(result, { ok: true, accepted: true });

    const pageActivity = await sendMessage(messageListener, { type: 'PAGE_VISUAL_ACTIVITY' });
    assert.deepEqual(pageActivity, { ok: true });
    assert.ok(fixture.screenMessages.some(
      ({ type, durationMs }) => type === 'SCREEN_SUPPRESS_MONITOR' && durationMs === 1000
    ));

    let state;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = await sendMessage(messageListener, { type: 'GET_STATE' });
      if (state.captures.at(-1)?.reason === 'devtools-update') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fixture.screenMessages.some(
      ({ type, frameId }) => type === 'SCREEN_TAKE_BUFFERED' && frameId === 'visual-frame-1'
    ));
    assert.ok(fixture.screenMessages.some(
      ({ type, frameId }) => type === 'SCREEN_FRAME_PROCESSED' && frameId === 'visual-frame-1'
    ));
    assert.equal(fixture.offscreenMessages.at(-1).dataUrl.includes('dmlzdWFsLWZyYW1lLTE='), true);
    assert.equal(state.captures.at(-1).reason, 'devtools-update');
    assert.equal(state.captures.at(-1).label, 'DevTools panel updated');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('ends an interrupted recording on browser startup without deleting its stored session', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    const initialState = fixture.storageSnapshot().flowRecorderState;
    await fixture.setStorage({
      flowRecorderState: {
        ...initialState,
        interimOutput: {
          sessionId: fixture.sessionId,
          filename: 'JShotz-interim.pdf',
          destination: 'downloads',
          downloadFilename: `flow-captures/${fixture.sessionId}/JShotz-interim.pdf`,
          downloadId: 44,
          captureCount: 40,
          captureSequence: 40,
          updatedAt: '2026-09-15T13:00:00.000Z'
        }
      }
    });
    await loadBackground();
    await fixture.chrome.runtime.onStartup.listeners[0]();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const interrupted = await sendMessage(messageListener, { type: 'GET_STATE' });

    assert.equal(interrupted.recording, false);
    assert.equal(interrupted.paused, false);
    assert.equal(interrupted.tabId, null);
    assert.deepEqual(interrupted.trackedTabIds, []);
    assert.equal(interrupted.captures.length, 40);
    assert.deepEqual(interrupted.completedEvidence && {
      sessionId: interrupted.completedEvidence.sessionId,
      captureCount: interrupted.completedEvidence.captureCount,
      interrupted: interrupted.completedEvidence.interrupted
    }, {
      sessionId: fixture.sessionId,
      captureCount: 40,
      interrupted: true
    });
    assert.deepEqual(interrupted.interruptedRecording && {
      sessionId: interrupted.interruptedRecording.sessionId,
      captureCount: interrupted.interruptedRecording.captureCount
    }, {
      sessionId: fixture.sessionId,
      captureCount: 40
    });
    assert.deepEqual(interrupted.interimOutput && {
      filename: interrupted.interimOutput.filename,
      destination: interrupted.interimOutput.destination,
      downloadId: interrupted.interimOutput.downloadId,
      captureSequence: interrupted.interimOutput.captureSequence
    }, {
      filename: 'JShotz-interim.pdf',
      destination: 'downloads',
      downloadId: 44,
      captureSequence: 40
    });
    assert.equal(interrupted.lastError, null);
    assert.equal(fixture.captureCount(), 0);
    assert.deepEqual(fixture.injectedFiles, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('reasserts hidden download UI immediately before each automatic screenshot download', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { savePng: true } });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const screenshotDownloadIndex = fixture.downloadActivity.findIndex(
      (event) => event.type === 'download' && event.filename.endsWith('.png')
    );
    assert.ok(screenshotDownloadIndex > 0);
    assert.deepEqual(fixture.downloadActivity[screenshotDownloadIndex - 1], {
      type: 'ui',
      enabled: false
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('keeps action time and recorder attribution outside captured image pixels', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { stampTimestamp: true } });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const processed = fixture.offscreenMessages.at(-1);
    assert.equal(Object.hasOwn(processed, 'stampText'), false);
    assert.equal(Object.hasOwn(processed, 'watermarkText'), false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('waits for the rendered page before capturing a title-driven SPA transition', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    fixture.liveTab.title = 'ArchRunway Dashboard';

    const titleChanged = fixture.chrome.tabs.onUpdated.listeners[0](fixture.liveTab.id, {
      title: 'ArchRunway Dashboard'
    });
    await fixture.waitForRenderSettle();

    assert.equal(fixture.captureCount(), 0);
    assert.deepEqual(fixture.captureTimeline(), ['render-settle-start']);

    fixture.resolveRenderSettle();
    await titleChanged;

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.recording, true);
    assert.equal(state.sequence, 41);
    assert.equal(fixture.captureCount(), 2);
    assert.deepEqual(fixture.captureTimeline(), [
      'render-settle-start',
      'render-settle-complete',
      'capture-visible-tab',
      'capture-visible-tab'
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('skips a stale title change instead of labeling a later page with it', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    fixture.liveTab.title = 'Account overview';
    const titleChanged = fixture.chrome.tabs.onUpdated.listeners[0](fixture.liveTab.id, {
      title: 'Account overview'
    });
    await fixture.waitForRenderSettle();

    fixture.liveTab.title = 'Security settings';
    fixture.liveTab.url = 'https://example.test/security';
    fixture.resolveRenderSettle();
    await titleChanged;

    let state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.sequence, 40);
    assert.equal(fixture.captureCount(), 0);

    fixture.setRenderSettlePending(false);
    await fixture.chrome.tabs.onUpdated.listeners[0](fixture.liveTab.id, {
      title: 'Security settings'
    });

    state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.sequence, 41);
    assert.equal(state.captures.at(-1).title, 'Security settings');
    assert.equal(state.captures.at(-1).url, 'https://example.test/security');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures a same-URL title change while an action screenshot is still processing', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;
  let actionCapture;
  let titleCapture;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    fixture.blockOffscreenProcessing();

    actionCapture = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Open account summary' },
      { tab: fixture.liveTab }
    );
    for (let attempt = 0; attempt < 100 && fixture.offscreenMessages.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fixture.offscreenMessages.length, 1);

    fixture.liveTab.title = 'Account summary';
    titleCapture = fixture.chrome.tabs.onUpdated.listeners[0](fixture.liveTab.id, {
      title: fixture.liveTab.title
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.offscreenMessages.length, 1);

    fixture.releaseOffscreenProcessing();
    await Promise.all([actionCapture, titleCapture]);

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.sequence, 42);
    assert.equal(state.captures.at(-1).reason, 'title-change');
    assert.equal(state.captures.at(-1).title, 'Account summary');
    assert.equal(state.captures.at(-1).url, fixture.liveTab.url);
  } finally {
    fixture.releaseOffscreenProcessing();
    await Promise.allSettled([actionCapture, titleCapture].filter(Boolean));
    globalThis.chrome = originalChrome;
  }
});

test('waits for the rendered page before capturing a navigation link', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    const actionAt = Date.UTC(2026, 8, 15, 13, 6, 10);

    const linkClicked = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'link', label: 'Privacy and security', actionAt },
      { tab: fixture.liveTab }
    );
    await fixture.waitForRenderSettle();

    assert.equal(fixture.captureCount(), 0);
    assert.deepEqual(fixture.captureTimeline(), ['render-settle-start']);

    fixture.liveTab.title = 'Privacy and security';
    fixture.liveTab.url = 'https://example.test/privacy';
    fixture.resolveRenderSettle();
    await linkClicked;

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.sequence, 41);
    assert.equal(fixture.captureCount(), 1);
    assert.equal(state.captures.at(-1).title, 'Privacy and security');
    assert.equal(state.captures.at(-1).url, 'https://example.test/privacy');
    assert.equal(state.captures.at(-1).actionAt, new Date(actionAt).toISOString());
    assert.deepEqual(fixture.offscreenMessages.at(-1).titleBar, {
      title: 'Privacy and security',
      url: 'https://example.test/privacy'
    });
    assert.deepEqual(fixture.captureTimeline(), [
      'render-settle-start',
      'render-settle-complete',
      'capture-visible-tab'
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures committed URL-bar navigation but ignores a late page completion', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    await fixture.chrome.webNavigation.onCompleted.listeners[0]?.({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url
    });
    assert.equal(fixture.captureCount(), 0);

    fixture.liveTab.title = 'Retirement news';
    fixture.liveTab.url = 'https://example.test/news';
    await fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url
    });

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(fixture.captureCount(), 2);
    assert.equal(state.captures.at(-1).reason, 'navigation');
    assert.equal(state.captures.at(-1).url, 'https://example.test/news');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('coalesces a navigation title update into its committed navigation capture', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    fixture.liveTab.title = 'Latest news';
    fixture.liveTab.url = 'https://example.test/latest-news';

    const navigation = fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url
    });
    await fixture.waitForRenderSettle();
    await fixture.chrome.tabs.onUpdated.listeners[0](fixture.liveTab.id, { title: fixture.liveTab.title });
    fixture.resolveRenderSettle();
    await navigation;

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(fixture.captureCount(), 2);
    assert.equal(state.sequence, 41);
    assert.equal(state.captures.at(-1).reason, 'navigation');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('queues a settled navigation follow-up for a pending regular click capture', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    const clickCapture = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Continue', actionAt: Date.now() },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    fixture.liveTab.title = 'Confirmation';
    fixture.liveTab.url = 'https://example.test/confirmation';
    const navigation = fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url
    });
    await Promise.all([clickCapture, navigation]);

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(fixture.captureCount(), 3);
    assert.equal(state.sequence, 41);
    assert.equal(state.captures.at(-1).reason, 'click');
    assert.equal(state.captures.at(-1).url, 'https://example.test/confirmation');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures a slow redirected landing page after the action frame is saved', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  let visibleCaptureCount = 0;
  fixture.chrome.tabs.captureVisibleTab = async () => {
    visibleCaptureCount += 1;
    return `data:image/png;base64,${Buffer.from(fixture.liveTab.url).toString('base64')}`;
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    await sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Sign in', actionAt: Date.now() },
      { tab: fixture.liveTab }
    );
    const afterAction = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(afterAction.sequence, 41);
    assert.equal(afterAction.captures.at(-1).url, 'https://example.test/recovered');

    fixture.liveTab.title = 'Landing page';
    fixture.liveTab.url = 'https://landing.example.test/home';
    await fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect']
    });

    const landed = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(landed.sequence, 42);
    assert.equal(landed.captures.at(-1).reason, 'navigation');
    assert.equal(landed.captures.at(-1).url, 'https://landing.example.test/home');
    assert.equal(visibleCaptureCount, 3);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('uses post-render live screen frames for redirected landing pages', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.setStorage({
      flowRecorderState: {
        ...fixture.storageSnapshot().flowRecorderState,
        streamActive: true,
        settings: {
          ...fixture.storageSnapshot().flowRecorderState.settings,
          captureMode: 'screen',
          savePng: false
        }
      }
    });

    await sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Continue', actionAt: Date.now() },
      { tab: fixture.liveTab }
    );
    fixture.liveTab.title = 'Redirected landing';
    fixture.liveTab.url = 'https://landing.example.test/redirected';
    await fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect']
    });

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.captures.at(-1).reason, 'navigation');
    assert.equal(state.captures.at(-1).url, fixture.liveTab.url);
    assert.equal(
      fixture.screenMessages.filter(({ type }) => type === 'SCREEN_BUFFER_CAPTURE').length,
      1
    );
    assert.equal(
      fixture.screenMessages.filter(({ type }) => type === 'SCREEN_CAPTURE').length,
      2
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures only the final landing page in an API-mode redirect chain', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.chrome.tabs.captureVisibleTab = async () =>
    `data:image/png;base64,${Buffer.from(fixture.liveTab.url).toString('base64')}`;
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.setStorage({
      flowRecorderState: {
        ...fixture.storageSnapshot().flowRecorderState,
        settings: {
          ...fixture.storageSnapshot().flowRecorderState.settings,
          captureMode: 'api',
          captureApi: true,
          savePng: false
        }
      }
    });

    fixture.liveTab.title = 'Authorizing';
    fixture.liveTab.url = 'https://example.test/authorize';
    const authorize = fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect']
    });
    fixture.liveTab.title = 'Plan home';
    fixture.liveTab.url = 'https://landing.example.test/plan-home';
    const landing = fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: fixture.liveTab.id,
      frameId: 0,
      url: fixture.liveTab.url,
      transitionType: 'link',
      transitionQualifiers: ['server_redirect']
    });
    await Promise.all([authorize, landing]);

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.sequence, 41);
    assert.equal(state.captures.at(-1).mode, 'api');
    assert.equal(state.captures.at(-1).reason, 'navigation');
    assert.equal(state.captures.at(-1).url, 'https://landing.example.test/plan-home');
    assert.ok(
      fixture.storageSnapshot().flowRecorderLog.some((line) =>
        line.includes('CAPTURE_SKIPPED_STALE navigation') && line.includes('/authorize')
      )
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('marks a lost screen stream unavailable and restores it after sharing resumes', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.setStorage({
      flowRecorderState: {
        ...fixture.storageSnapshot().flowRecorderState,
        streamActive: true,
        screenWindowId: 77,
        settings: {
          ...fixture.storageSnapshot().flowRecorderState.settings,
          captureMode: 'screen'
        }
      }
    });

    const ended = await sendMessage(messageListener, {
      type: 'SCREEN_ENDED',
      source: 'screen-window'
    });
    assert.deepEqual(ended, { ok: true, accepted: true });
    let state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.streamActive, false);
    assert.match(state.lastError, /Screen sharing stopped/);
    assert.deepEqual(fixture.windowUpdates.at(-1), {
      windowId: 77,
      changes: { state: 'normal', focused: true }
    });

    const ready = await sendMessage(messageListener, {
      type: 'SCREEN_READY',
      source: 'screen-window'
    });
    assert.deepEqual(ready, { ok: true, accepted: true });
    state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.streamActive, true);
    assert.equal(state.lastError, null);
    assert.deepEqual(fixture.windowUpdates.at(-1), {
      windowId: 77,
      changes: { state: 'minimized' }
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures refresh, browser history, and typed-address navigations with explicit reasons', async () => {
  const originalChrome = globalThis.chrome;
  const scenarios = [
    { transitionType: 'reload', transitionQualifiers: [], reason: 'refresh' },
    { transitionType: 'link', transitionQualifiers: ['forward_back'], reason: 'history-navigation' },
    { transitionType: 'typed', transitionQualifiers: ['from_address_bar'], reason: 'typed-navigation' }
  ];

  try {
    for (const [index, scenario] of scenarios.entries()) {
      const fixture = createChrome();
      globalThis.chrome = fixture.chrome;
      await loadBackground();
      const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
      await sendMessage(messageListener, { type: 'GET_STATE' });
      fixture.liveTab.title = `Destination ${index + 1}`;
      fixture.liveTab.url = `https://example.test/destination-${index + 1}`;

      await fixture.chrome.webNavigation.onCommitted.listeners[0]({
        tabId: fixture.liveTab.id,
        frameId: 0,
        url: fixture.liveTab.url,
        transitionType: scenario.transitionType,
        transitionQualifiers: scenario.transitionQualifiers
      });

      const state = await sendMessage(messageListener, { type: 'GET_STATE' });
      assert.equal(state.sequence, 41);
      assert.equal(state.captures.at(-1).reason, scenario.reason);
      assert.equal(state.captures.at(-1).url, fixture.liveTab.url);
    }
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('uses one visible frame when a manual responsive capture cannot use CDP', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  const responsiveDocument = {
    width: 700,
    viewportWidth: 329,
    viewportHeight: 600,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
    docHeight: 900
  };
  const debuggerAttachments = [];
  let directCaptureCount = 0;
  let scrollOperationCount = 0;

  fixture.setExecuteScriptHandler((details) => {
    const source = String(details.func);
    if (source.includes('const docHeight')) return [{ result: responsiveDocument }];
    if (source.includes('window.scrollTo(') || source.includes('el.scrollTo(')) scrollOperationCount += 1;
    return undefined;
  });
  fixture.chrome.debugger = {
    onDetach: createEvent(),
    async attach(source) {
      debuggerAttachments.push(source);
      throw new Error('Another debugger is already attached to this tab.');
    },
    async detach() {},
    async sendCommand() {
      directCaptureCount += 1;
    }
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { fullPage: true } });

    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    const captured = await sendMessage(messageListener, { type: 'GET_STATE' });

    assert.equal(captured.sequence, 41);
    assert.equal(fixture.captureCount(), 1);
    assert.deepEqual(debuggerAttachments, [{ tabId: fixture.liveTab.id }]);
    assert.equal(directCaptureCount, 0);
    assert.equal(scrollOperationCount, 0);
    assert.equal(captured.captures.at(-1).reason, 'manual');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('does not create headless full-page parts below the last meaningful content', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  const documentInfo = {
    width: 1200,
    viewportWidth: 1200,
    viewportHeight: 800,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
    docHeight: 5000,
    contentHeight: 2300
  };
  const clips = [];
  let scrollOperationCount = 0;

  fixture.setExecuteScriptHandler((details) => {
    const source = String(details.func);
    if (source.includes('const docHeight')) return [{ result: documentInfo }];
    if (source.includes('[...document.images]')) return [{ result: true }];
    if (source.includes('window.scrollTo(') || source.includes('el.scrollTo(')) scrollOperationCount += 1;
    return undefined;
  });
  fixture.chrome.debugger = {
    onDetach: createEvent(),
    async attach() {},
    async detach() {},
    async sendCommand(_source, method, options) {
      assert.equal(method, 'Page.captureScreenshot');
      clips.push(options.clip);
      return { data: 'cHJvYmU=' };
    }
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { fullPage: true } });

    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    assert.equal(clips.length, 1);
    assert.equal(clips[0].y, 0);
    assert.equal(clips[0].height, documentInfo.contentHeight);
    assert.equal(scrollOperationCount, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures a taller app scroller by expansion without scrolling the visible page', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  const documentInfo = {
    width: 1200,
    viewportWidth: 1200,
    viewportHeight: 800,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
    docHeight: 1807,
    contentHeight: 1807
  };
  const expandedDocumentInfo = {
    ...documentInfo,
    docHeight: 7139,
    contentHeight: 7139
  };
  const scrollerInfo = {
    rectTop: 0,
    rectLeft: 0,
    rectWidth: 1200,
    rectHeight: 800,
    scrollHeight: 7139,
    clientHeight: 800,
    scrollTop: 0,
    dpr: 1,
    viewportHeight: 800,
    viewportWidth: 1200
  };
  let documentMeasurementCount = 0;
  let expansionCount = 0;
  let scrollOperationCount = 0;
  const clips = [];

  fixture.setExecuteScriptHandler((details) => {
    const source = String(details.func);
    if (source.includes('const docHeight')) {
      documentMeasurementCount += 1;
      return [{ result: documentMeasurementCount === 1 ? documentInfo : expandedDocumentInfo }];
    }
    if (source.includes('let best = null')) return [{ result: scrollerInfo }];
    if (source.includes('target.setAttribute(expandedAttr')) {
      expansionCount += 1;
      return [{ result: true }];
    }
    if (source.includes('window.scrollTo(') || source.includes('el.scrollTo(')) scrollOperationCount += 1;
    return undefined;
  });
  fixture.chrome.debugger = {
    onDetach: createEvent(),
    async attach() {},
    async detach() {},
    async sendCommand(_source, method, options) {
      assert.equal(method, 'Page.captureScreenshot');
      clips.push(options.clip);
      return { data: 'cHJvYmU=' };
    }
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { fullPage: true } });

    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    assert.equal(expansionCount, 1);
    assert.equal(clips.length, 1);
    assert.equal(clips[0].height, scrollerInfo.scrollHeight);
    assert.equal(scrollOperationCount, 0);
    assert.equal(fixture.offscreenMessages.at(-1).trimBlankMargins, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('drops blank trailing CDP parts after the actual page content', async () => {
  const originalChrome = globalThis.chrome;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  const fixture = createChrome();
  const documentInfo = {
    width: 1600,
    viewportWidth: 1600,
    viewportHeight: 800,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
    docHeight: 9600
  };
  let screenshotIndex = 0;

  class PixelCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.kind = 'blank';
    }

    getContext() {
      return {
        drawImage: (source, _sourceX, sourceY = 0) => {
          this.kind = source.kind === 'mixed'
            ? sourceY < source.height / 2 ? 'content' : 'blank'
            : source.kind;
        },
        getImageData: (x, y, width, height) => {
          const data = new Uint8ClampedArray(width * height * 4);
          const referencePixel = width === 1 && height === 1;
          for (let index = 0; index < data.length; index += 4) {
            const pixelX = (index / 4) % width;
            const rightEdge = x + pixelX === this.width - 1;
            const value = rightEdge ? 192 : this.kind === 'content' && !referencePixel ? 0 : 255;
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
            data[index + 3] = 255;
          }
          return { data };
        }
      };
    }

    async convertToBlob() {
      return new Blob([this.kind]);
    }
  }

  globalThis.OffscreenCanvas = PixelCanvas;
  globalThis.createImageBitmap = async (blob) => ({
    width: 120,
    height: 120,
    kind: await blob.text(),
    close() {}
  });
  fixture.setExecuteScriptHandler((details) => {
    const source = String(details.func);
    if (source.includes('const docHeight')) return [{ result: documentInfo }];
    if (source.includes('[...document.images]')) return [{ result: true }];
    return undefined;
  });
  fixture.chrome.debugger = {
    onDetach: createEvent(),
    async attach() {},
    async detach() {},
    async sendCommand() {
      screenshotIndex += 1;
      return { data: Buffer.from('mixed').toString('base64') };
    }
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { fullPage: true } });

    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    const state = await sendMessage(messageListener, { type: 'GET_STATE' });

    assert.equal(screenshotIndex, 1);
    assert.equal(fixture.offscreenMessages.length, 3);
    assert.equal(state.sequence, 43);
    assert.match(state.captures.at(-1).title, /part 3 of 3\)$/);
    assert.equal(fixture.badgeTexts.at(-1), '43');
    assert.equal(
      fixture.tabMessages.some(({ message }) => message.type === 'FULL_PAGE_PROGRESS'),
      false
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  }
});

test('captures an automatic responsive click as one visible frame', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  let documentMeasurementCount = 0;
  fixture.setExecuteScriptHandler((details) => {
    if (String(details.func).includes('const docHeight')) documentMeasurementCount += 1;
    return undefined;
  });
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { fullPage: true } });

    const result = await sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'click', label: 'Continue' },
      { tab: fixture.liveTab }
    );
    const state = await sendMessage(messageListener, { type: 'GET_STATE' });

    assert.deepEqual(result, { ok: true });
    assert.equal(state.sequence, 41);
    assert.equal(fixture.captureCount(), 1);
    assert.equal(state.captures.at(-1).reason, 'click');
    assert.equal(fixture.offscreenMessages.at(-1).fullPageInfo, undefined);
    assert.equal(documentMeasurementCount, 0);
    assert.equal(fixture.tabMessages.some(({ message }) => message.type === 'FULL_PAGE_PROGRESS'), false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('stops promptly while an explicit direct full-page capture is still in progress', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  const documentInfo = {
    width: 1200,
    viewportWidth: 1200,
    viewportHeight: 800,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
    docHeight: 1600
  };
  let markDirectCaptureStarted;
  const directCaptureStarted = new Promise((resolve) => {
    markDirectCaptureStarted = resolve;
  });
  let resolveDirectCapture;
  const directCapture = new Promise((resolve) => {
    resolveDirectCapture = resolve;
  });

  fixture.setExecuteScriptHandler((details) => {
    const source = String(details.func);
    if (source.includes('const docHeight')) return [{ result: documentInfo }];
    if (source.includes('[...document.images]')) return [{ result: true }];
    return undefined;
  });
  fixture.chrome.debugger = {
    onDetach: createEvent(),
    async attach() {},
    async detach() {},
    async sendCommand(_source, method) {
      assert.equal(method, 'Page.captureScreenshot');
      markDirectCaptureStarted();
      return directCapture;
    }
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { fullPage: true } });

    const pendingCapture = sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    await directCaptureStarted;

    const stoppedAt = Date.now();
    const stopped = await sendMessage(messageListener, { type: 'STOP', keepFiles: false });

    assert.ok(Date.now() - stoppedAt < 1000);
    assert.equal(stopped.recording, false);
    assert.equal(stopped.sequence, 40);
    assert.ok(!fixture.storageSnapshot().flowRecorderLog.some((line) => line.includes('CAPTURE_DRAIN_TIMEOUT stop')));

    resolveDirectCapture({ data: 'cHJvYmU=' });
    await pendingCapture;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.storageSnapshot().flowRecorderState.sequence, 40);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures a new-tab link from the page it opens', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    const privacyTab = {
      id: 8,
      windowId: fixture.liveTab.windowId,
      active: false,
      openerTabId: fixture.liveTab.id,
      title: 'Privacy and security',
      url: 'https://example.test/privacy'
    };
    let activeTab = fixture.liveTab;
    let capturedTabId = null;
    const getTab = fixture.chrome.tabs.get;
    const captureVisibleTab = fixture.chrome.tabs.captureVisibleTab;
    fixture.chrome.tabs.get = async (tabId) =>
      tabId === privacyTab.id ? { ...privacyTab } : getTab(tabId);
    fixture.chrome.tabs.query = async (query = {}) => {
      if (query.active) return [{ ...activeTab }];
      return [{ ...fixture.liveTab }, { ...privacyTab }];
    };
    fixture.chrome.tabs.update = async (tabId, changes) => {
      const tab = tabId === privacyTab.id ? privacyTab : fixture.liveTab;
      Object.assign(tab, changes);
      if (changes.active) activeTab = tab;
      return { ...tab };
    };
    fixture.chrome.tabs.captureVisibleTab = async (windowId) => {
      capturedTabId = activeTab.id;
      return captureVisibleTab(windowId);
    };
    fixture.chrome.windows.update = async () => {};

    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    const linkClicked = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'link', label: 'Privacy and security', opensNewTab: true },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await fixture.chrome.tabs.onCreated.listeners[0](privacyTab);
    await fixture.waitForRenderSettle();

    fixture.resolveRenderSettle();
    await linkClicked;
    fixture.setRenderSettlePending(false);
    const navigation = fixture.chrome.webNavigation.onCommitted.listeners[0]({
      tabId: privacyTab.id,
      frameId: 0,
      url: privacyTab.url
    });
    await fixture.chrome.tabs.onUpdated.listeners[0](privacyTab.id, { title: privacyTab.title });
    await navigation;

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.captures.at(-1).title, 'Privacy and security');
    assert.equal(state.captures.at(-1).url, 'https://example.test/privacy');
    assert.equal(capturedTabId, privacyTab.id);
    assert.equal(fixture.captureCount(), 3);
    assert.deepEqual(fixture.offscreenMessages.at(-1).titleBar, {
      title: 'Privacy and security',
      url: 'https://example.test/privacy'
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures and tracks a new-tab link without an opener tab ID in either event order', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    const privacyTab = {
      id: 8,
      windowId: fixture.liveTab.windowId,
      active: false,
      title: 'Privacy and security',
      url: 'https://example.test/privacy'
    };
    const termsTab = {
      id: 9,
      windowId: fixture.liveTab.windowId,
      active: false,
      title: 'Terms of service',
      url: 'https://example.test/terms'
    };
    const childTabs = new Map([[privacyTab.id, privacyTab], [termsTab.id, termsTab]]);
    let activeTab = fixture.liveTab;
    let capturedTabId = null;
    const getTab = fixture.chrome.tabs.get;
    const captureVisibleTab = fixture.chrome.tabs.captureVisibleTab;
    fixture.chrome.tabs.get = async (tabId) =>
      childTabs.has(tabId) ? { ...childTabs.get(tabId) } : getTab(tabId);
    fixture.chrome.tabs.query = async (query = {}) => {
      if (query.active) return [{ ...activeTab }];
      return [{ ...fixture.liveTab }, ...[...childTabs.values()].map((tab) => ({ ...tab }))];
    };
    fixture.chrome.tabs.update = async (tabId, changes) => {
      const tab = childTabs.get(tabId) || fixture.liveTab;
      Object.assign(tab, changes);
      if (changes.active) activeTab = tab;
      return { ...tab };
    };
    fixture.chrome.tabs.captureVisibleTab = async (windowId) => {
      capturedTabId = activeTab.id;
      return captureVisibleTab(windowId);
    };
    fixture.chrome.windows.update = async () => {};

    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    const linkClicked = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'link', label: 'Privacy and security', opensNewTab: true },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await fixture.chrome.tabs.onCreated.listeners[0](privacyTab);
    await fixture.waitForRenderSettle();
    fixture.resolveRenderSettle();
    await linkClicked;

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.captures.at(-1).title, 'Privacy and security');
    assert.equal(state.captures.at(-1).url, 'https://example.test/privacy');
    assert.equal(capturedTabId, privacyTab.id);
    assert.ok(state.trackedTabIds.includes(privacyTab.id));

    activeTab = fixture.liveTab;
    await fixture.chrome.tabs.onActivated.listeners[0]({ tabId: fixture.liveTab.id });
    await fixture.chrome.tabs.onCreated.listeners[0](termsTab);
    fixture.setRenderSettlePending(true);
    const secondLinkClicked = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'link', label: 'Terms of service', opensNewTab: true },
      { tab: fixture.liveTab }
    );
    await fixture.waitForRenderSettle();
    fixture.resolveRenderSettle();
    await secondLinkClicked;

    const secondState = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(secondState.captures.at(-1).title, 'Terms of service');
    assert.equal(secondState.captures.at(-1).url, 'https://example.test/terms');
    assert.equal(capturedTabId, termsTab.id);
    assert.ok(secondState.trackedTabIds.includes(termsTab.id));
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures sequential new-tab links opened from the same parent page', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setRenderSettlePending(true);
  globalThis.chrome = fixture.chrome;

  try {
    const privacyTab = {
      id: 8,
      windowId: fixture.liveTab.windowId,
      active: false,
      openerTabId: fixture.liveTab.id,
      title: 'Privacy and security',
      url: 'https://example.test/privacy'
    };
    const termsTab = {
      id: 9,
      windowId: fixture.liveTab.windowId,
      active: false,
      openerTabId: fixture.liveTab.id,
      title: 'Terms of service',
      url: 'https://example.test/terms'
    };
    const childTabs = new Map([[privacyTab.id, privacyTab], [termsTab.id, termsTab]]);
    const capturedTabIds = [];
    let activeTab = fixture.liveTab;
    const getTab = fixture.chrome.tabs.get;
    const captureVisibleTab = fixture.chrome.tabs.captureVisibleTab;
    fixture.chrome.tabs.get = async (tabId) =>
      childTabs.has(tabId) ? { ...childTabs.get(tabId) } : getTab(tabId);
    fixture.chrome.tabs.query = async (query = {}) => {
      if (query.active) return [{ ...activeTab }];
      return [{ ...fixture.liveTab }, ...[...childTabs.values()].map((tab) => ({ ...tab }))];
    };
    fixture.chrome.tabs.update = async (tabId, changes) => {
      const tab = childTabs.get(tabId) || fixture.liveTab;
      Object.assign(tab, changes);
      if (changes.active) activeTab = tab;
      return { ...tab };
    };
    fixture.chrome.tabs.captureVisibleTab = async (windowId) => {
      capturedTabIds.push(activeTab.id);
      return captureVisibleTab(windowId);
    };
    fixture.chrome.windows.update = async () => {};

    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });

    const firstLink = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'link', label: 'Privacy and security', opensNewTab: true },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await fixture.chrome.tabs.onCreated.listeners[0](privacyTab);
    await fixture.waitForRenderSettle();
    fixture.resolveRenderSettle();
    await firstLink;

    activeTab = fixture.liveTab;
    await fixture.chrome.tabs.onActivated.listeners[0]({ tabId: fixture.liveTab.id });
    fixture.setRenderSettlePending(true);
    const secondLink = sendMessage(
      messageListener,
      { type: 'CLICK_CAPTURE', reason: 'link', label: 'Terms of service', opensNewTab: true },
      { tab: fixture.liveTab }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await fixture.chrome.tabs.onCreated.listeners[0](termsTab);
    await fixture.waitForRenderSettle();
    fixture.resolveRenderSettle();
    await secondLink;

    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.deepEqual(state.captures.slice(-2).map((capture) => capture.title), [
      'Privacy and security',
      'Terms of service'
    ]);
    assert.deepEqual(capturedTabIds, [privacyTab.id, termsTab.id]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('saves a checkpoint without stopping and continues the same recording', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { savePdf: true } });
    const captured = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    const previousSessionId = captured.sessionId;
    assert.equal(captured.recording, true);
    assert.equal(fixture.captureCount(), 1);

    const saved = await sendMessage(
      messageListener,
      { type: 'SAVE_FLOW' },
      { tab: fixture.liveTab }
    );
    assert.equal(saved.recording, true);
    assert.equal(saved.sessionId, previousSessionId);
    assert.match(saved.savedPdfFilename, new RegExp(`^${previousSessionId}_checkpoint_.*\\.pdf$`));
    assert.equal(fixture.exportRequests.length, 1);
    assert.match(
      new URL(fixture.exportRequests[0].url, 'https://extension.test').searchParams.get('filename'),
      new RegExp(`Jshotz/${previousSessionId}/`)
    );
    assert.equal(fixture.revealedDownloads.length, 0);
    assert.ok(
      fixture.storageSnapshot().flowRecorderLog.some((line) =>
        line.includes(`FILE_SAVE status=completed type=pdf destination=downloads filename=Jshotz/${previousSessionId}/`)
      )
    );

    const continued = await sendMessage(
      messageListener,
      { type: 'CAPTURE_NOW' },
      { tab: fixture.liveTab }
    );
    assert.equal(continued.recording, true);
    assert.equal(continued.sessionId, previousSessionId);
    assert.equal(continued.sequence, captured.sequence + 1);
    assert.equal(fixture.captureCount(), 2);
    assert.deepEqual(fixture.revealedDownloads, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('does not miss a checkpoint completion sent while the output window opens', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setCompleteOutputDuringWindowCreate(true);
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const saved = await sendMessage(messageListener, {
      type: 'SAVE_FLOW',
      outputFilename: 'fast-checkpoint',
      outputFormats: ['pdf']
    });

    assert.equal(saved.recording, true);
    assert.equal(saved.lastError, null);
    assert.equal(saved.savedPdfFilename, 'fast-checkpoint.pdf');
    assert.equal(fixture.exportRequests.length, 1);
    assert.match(
      new URL(fixture.exportRequests[0].url, 'https://extension.test').searchParams.get('requestId'),
      /^output_/
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('ignores another output window completion while saving a checkpoint', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  fixture.setUnrelatedOutputBeforeCompletion(true);
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const saved = await sendMessage(messageListener, {
      type: 'SAVE_FLOW',
      outputFilename: 'isolated-checkpoint',
      outputFormats: ['pdf']
    });

    assert.equal(saved.recording, true);
    assert.equal(saved.lastError, null);
    assert.equal(saved.savedPdfFilename, 'isolated-checkpoint.pdf');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('keeps the interim PDF when stopping without a final document', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    const initialState = fixture.storageSnapshot().flowRecorderState;
    await fixture.setStorage({
      flowRecorderState: {
        ...initialState,
        sequence: 4,
        captures: initialState.captures.slice(0, 4)
      }
    });
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { savePdf: true } });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      createPdf: false
    });

    assert.equal(stopped.recording, false);
    assert.deepEqual(stopped.interimOutput && {
      filename: stopped.interimOutput.filename,
      destination: stopped.interimOutput.destination,
      captureSequence: stopped.interimOutput.captureSequence
    }, {
      filename: 'JShotz-interim.pdf',
      destination: 'downloads',
      captureSequence: 5
    });
    assert.equal(fixture.exportRequests.length, 1);
    assert.deepEqual(
      JSON.parse(new URL(fixture.exportRequests[0].url, 'https://extension.test').searchParams.get('outputs')),
      [{
        format: 'pdf',
        filename: `Jshotz/${fixture.sessionId}/JShotz-interim.pdf`,
        overwrite: true
      }]
    );
    assert.deepEqual(fixture.removedDownloads, []);
    assert.ok(fixture.downloadRequests.some((request) => request.filename.endsWith('/flow-manifest.json')));
    assert.deepEqual(fixture.downloadLifecycleEvents, ['ui:false', 'ui:false', 'complete:1', 'ui:true']);
    const manifest = JSON.parse(Buffer.from(fixture.downloadRequests[0].url.split(',')[1], 'base64').toString('utf8'));
    assert.ok(manifest.debugLog.some((line) => line.includes('FILE_SAVE status=requested type=manifest')));
    assert.ok(
      fixture.storageSnapshot().flowRecorderLog.some((line) =>
        line.includes('FILE_SAVE status=completed type=manifest')
      )
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('removes the interim PDF after a successful final document save', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    const initialState = fixture.storageSnapshot().flowRecorderState;
    await fixture.setStorage({
      flowRecorderState: {
        ...initialState,
        sequence: 4,
        captures: initialState.captures.slice(0, 4)
      }
    });
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      outputFilename: 'completed-flow',
      outputFormats: ['pdf']
    });

    assert.equal(stopped.recording, false);
    assert.equal(stopped.savedPdfFilename, 'completed-flow.pdf');
    assert.equal(stopped.interimOutput, null);
    assert.equal(fixture.exportRequests.length, 2);
    assert.deepEqual(
      JSON.parse(new URL(fixture.exportRequests[0].url, 'https://extension.test').searchParams.get('outputs')),
      [{
        format: 'pdf',
        filename: `Jshotz/${fixture.sessionId}/JShotz-interim.pdf`,
        overwrite: true
      }]
    );
    assert.deepEqual(fixture.removedDownloads, [5001]);
    assert.deepEqual(fixture.erasedDownloads, [{ id: 5001 }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('deletes the interim PDF when the user discards the session', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    const initialState = fixture.storageSnapshot().flowRecorderState;
    await fixture.setStorage({
      flowRecorderState: {
        ...initialState,
        sequence: 4,
        captures: initialState.captures.slice(0, 4)
      }
    });
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'GET_STATE' });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const stopped = await sendMessage(messageListener, { type: 'STOP', keepFiles: false });

    assert.equal(stopped.recording, false);
    assert.equal(stopped.completedEvidence, null);
    assert.equal(stopped.interimOutput, null);
    assert.deepEqual(fixture.removedDownloads, [5001]);
    assert.deepEqual(fixture.erasedDownloads, [{ id: 5001 }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('reveals a final output location only after an explicit request and recording stop', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { savePdf: true } });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      reveal: true,
      outputFilename: 'completed-flow',
      outputFormats: ['pdf']
    });

    assert.equal(stopped.recording, false);
    assert.equal(stopped.savedPdfFilename, 'completed-flow.pdf');
    assert.equal(stopped.fileLocationOpened, true);
    assert.equal(stopped.fileLocationFallback, false);
    assert.deepEqual(fixture.revealedDownloads, [5001]);
    assert.deepEqual(fixture.revealRecordingStates, [false]);
    assert.deepEqual(fixture.downloadUiEvents, ['ui:false', 'ui:false', 'show:5001', 'ui:true']);
    assert.deepEqual(fixture.downloadLifecycleEvents, ['ui:false', 'ui:false', 'complete:1', 'show:5001', 'ui:true']);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('falls back to Downloads when the output file location cannot be revealed directly', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    fixture.setDownloadShowError(new Error('The file manager did not accept the output file.'));
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'SET_SETTINGS', settings: { savePdf: true } });
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      reveal: true,
      outputFilename: 'completed-flow',
      outputFormats: ['pdf']
    });

    assert.equal(stopped.recording, false);
    assert.equal(stopped.fileLocationOpened, true);
    assert.equal(stopped.fileLocationFallback, true);
    assert.deepEqual(fixture.revealedDownloads, ['default-folder']);
    assert.deepEqual(fixture.revealRecordingStates, [false]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('resumes a selected screenshot folder and writes the combined flow there', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const originalConsoleError = console.error;
  const fixture = createChrome();
  const folder = createResumeFolder();
  const consoleErrors = [];
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();
  console.error = (...args) => consoleErrors.push(args.join(' '));

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: false,
          savePdf: false
        }
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const resumed = await sendMessage(messageListener, {
      type: 'RESUME_FROM_FOLDER',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });

    assert.equal(resumed.recording, true);
    assert.equal(resumed.sequence, 2);
    assert.equal(resumed.captures.length, 2);
    assert.equal(resumed.captures[0].title, 'Previous step');
    assert.equal(resumed.captures[0].note, 'Restored note');
    assert.equal(resumed.captures[0].actionAt, '2026-09-12T09:59:59.000Z');
    assert.equal(resumed.captures[0].requestSequence, 9);
    assert.ok(resumed.captures[1].requestSequence > resumed.captures[0].requestSequence);
    assert.equal(
      fixture.storageSnapshot()['flowRecorderFrames:1'].actionAt,
      '2026-09-12T09:59:59.000Z'
    );
    assert.match(resumed.captures[1].filename, /^002_/);
    assert.equal(fixture.downloadRequests.length, 0);
    assert.ok([...folder.written.keys()].some((name) => /^002_.*\.png$/.test(name)));

    folder.setPermission('denied');
    await loadBackground();
    const restartedMessageListener = fixture.chrome.runtime.onMessage.listeners.at(-1);
    const unavailable = await sendMessage(restartedMessageListener, { type: 'GET_STATE' });
    assert.equal(unavailable.sequence, 2);
    assert.equal(unavailable.folderAccessNeeded, false);
    assert.equal(unavailable.lastError, null);
    assert.equal(consoleErrors.length, 0);

    const downloadedWhileDisconnected = await sendMessage(restartedMessageListener, { type: 'CAPTURE_NOW' });
    assert.equal(downloadedWhileDisconnected.recording, true);
    assert.equal(downloadedWhileDisconnected.sequence, 3);
    assert.equal(downloadedWhileDisconnected.folderAccessNeeded, true);
    assert.equal(downloadedWhileDisconnected.lastError, null);
    assert.equal(fixture.downloadRequests.length, 1);
    assert.match(fixture.downloadRequests[0].filename, /\/003_.*\.png$/);

    const secondDownloadedCapture = await sendMessage(restartedMessageListener, { type: 'CAPTURE_NOW' });
    assert.equal(secondDownloadedCapture.recording, true);
    assert.equal(secondDownloadedCapture.sequence, 4);
    assert.equal(secondDownloadedCapture.folderAccessNeeded, true);
    assert.equal(fixture.downloadRequests.length, 2);
    assert.match(fixture.downloadRequests[1].filename, /\/004_.*\.png$/);

    folder.setPermission('granted');
    const reconnected = await sendMessage(restartedMessageListener, { type: 'RECONNECT_CAPTURE_FOLDER' });
    assert.equal(reconnected.recording, true);
    assert.equal(reconnected.sequence, 4);
    assert.equal(reconnected.folderAccessNeeded, false);
    assert.equal(reconnected.lastError, null);

    const capturedAfterReconnect = await sendMessage(restartedMessageListener, { type: 'CAPTURE_NOW' });
    assert.equal(capturedAfterReconnect.sequence, 5);
    assert.equal(capturedAfterReconnect.folderAccessNeeded, false);

    const stopped = await sendMessage(restartedMessageListener, { type: 'STOP', keepFiles: true });
    assert.equal(stopped.recording, false);
    assert.equal(fixture.downloadRequests.length, 2);
    assert.ok([...folder.written.keys()].some((name) => name.endsWith('.pdf')));
    const manifest = JSON.parse(folder.written.get('flow-manifest.json'));
    assert.equal(manifest.screenshotCount, 5);
    assert.deepEqual(manifest.screenshots.map((capture) => capture.sequence), [1, 2, 3, 4, 5]);
    assert.equal(manifest.screenshots[0].actionAt, '2026-09-12T09:59:59.000Z');
    assert.equal(folder.written.has('JShotz-interim.pdf'), false);
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('uses an empty selected folder for a new folder-backed recording', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder({ withPreviousCapture: false });
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: false,
          savePdf: false
        }
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const started = await sendMessage(messageListener, {
      type: 'RESUME_FROM_FOLDER',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });

    assert.equal(started.recording, true);
    assert.equal(started.outputFolder.name, 'session_before_crash');
    assert.equal(started.folderAccessNeeded, false);
    assert.equal(started.lastError, null);
    assert.equal(started.captures.length, 1);
    assert.equal(
      started.notice,
      'No previous screenshots found in selected folder, JShotz is still capturing the current flows to the selected folder.'
    );
    assert.equal(started.sequence, 1);
    assert.ok([...folder.written.keys()].some((name) => /^001_.*\.png$/.test(name)));
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('skips unreadable previous images and continues recording in the selected folder', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder();
  folder.addFile(
    '002_2026-09-12_10-01-00-000_Unreadable_step.png',
    new TextEncoder().encode('corrupt'),
    'image/png'
  );
  fixture.setOffscreenProcessFailure((message) =>
    message.dataUrl.includes('Y29ycnVwdA==') ? new Error('The source image could not be decoded.') : null
  );
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: false,
          savePdf: false
        }
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const resumed = await sendMessage(messageListener, {
      type: 'RESUME_FROM_FOLDER',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });

    assert.equal(resumed.recording, true);
    assert.equal(resumed.lastError, null);
    assert.equal(resumed.outputFolder.name, 'session_before_crash');
    assert.equal(resumed.captures.length, 2);
    assert.equal(resumed.captures[0].sequence, 1);
    assert.equal(resumed.captures[1].sequence, 3);
    assert.equal(
      resumed.notice,
      'Skipped 1 unreadable image file while resuming the selected folder.'
    );
    assert.ok([...folder.written.keys()].some((name) => /^003_.*\.png$/.test(name)));
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('starts a new folder-backed recording when all previous images are unreadable', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder({ withPreviousCapture: false });
  folder.addFile(
    '001_2026-09-12_10-00-00-000_Unreadable_step.png',
    new TextEncoder().encode('corrupt'),
    'image/png'
  );
  fixture.setOffscreenProcessFailure((message) =>
    message.dataUrl.includes('Y29ycnVwdA==') ? new Error('The source image could not be decoded.') : null
  );
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: false,
          savePdf: false
        }
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const started = await sendMessage(messageListener, {
      type: 'RESUME_FROM_FOLDER',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });

    assert.equal(started.recording, true);
    assert.equal(started.lastError, null);
    assert.equal(started.outputFolder.name, 'session_before_crash');
    assert.equal(started.sequence, 1);
    assert.equal(started.captures.length, 1);
    assert.equal(
      started.notice,
      'No readable screenshots found in selected folder. JShotz is still capturing the current flow in that folder.'
    );
    assert.ok([...folder.written.keys()].some((name) => /^001_.*\.png$/.test(name)));
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('uses a prepared resume folder once, then starts fresh after stopping', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder({ withPreviousCapture: false });
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: false,
          savePdf: false
        }
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const prepared = await sendMessage(messageListener, { type: 'PREPARE_RESUME_FROM_FOLDER' });
    assert.equal(prepared.recording, false);
    assert.deepEqual(prepared.pendingResumeFolder, { name: folder.directoryHandle.name });

    const resumed = await sendMessage(messageListener, {
      type: 'START',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });
    assert.equal(resumed.recording, true);
    assert.equal(resumed.outputFolder.name, folder.directoryHandle.name);
    assert.equal(resumed.pendingResumeFolder, null);
    assert.ok([...folder.written.keys()].some((name) => /^001_.*\.png$/.test(name)));

    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      createPdf: false
    });
    assert.equal(stopped.recording, false);
    assert.equal(stopped.pendingResumeFolder, null);

    const fresh = await sendMessage(messageListener, {
      type: 'START',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });
    assert.equal(fresh.recording, true);
    assert.equal(fresh.outputFolder, null);
    assert.notEqual(fresh.sessionId, resumed.sessionId);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('accepts capture and checkpoint shortcuts in a second recording on the same tab', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const commandListener = fixture.chrome.commands.onCommand.listeners[0];

    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: false,
      createPdf: false
    });
    assert.equal(stopped.recording, false);

    const secondSession = await sendMessage(messageListener, {
      type: 'START',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });
    assert.equal(secondSession.recording, true);
    assert.deepEqual(secondSession.trackedTabIds, [fixture.liveTab.id]);
    assert.equal(secondSession.sequence, 1);

    await commandListener('capture-whole-page');
    const afterWholePageHotkey = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(afterWholePageHotkey.sequence, 2);

    await commandListener('capture-panel');
    const afterDevToolsHotkey = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(afterDevToolsHotkey.sequence, 3);

    const checkpoint = await sendMessage(messageListener, {
      type: 'OPEN_OUTPUT_DIALOG',
      mode: 'checkpoint'
    });
    assert.equal(checkpoint.recording, true);
    assert.match(
      new URL(fixture.exportRequests.at(-1).url, 'https://extension.test').pathname,
      /output-dialog\.html$/
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('captures Alt+Shift+D when DevTools was open before the screen recording started', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  let devToolsAttached = false;
  fixture.chrome.debugger = {
    onDetach: createEvent(),
    async getTargets() {
      return [{ tabId: fixture.liveTab.id, attached: devToolsAttached }];
    },
    async attach() {},
    async detach() {},
    async sendCommand() {
      throw new Error('CDP capture is not expected for screen mode.');
    }
  };
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const commandListener = fixture.chrome.commands.onCommand.listeners[0];
    const recovered = await sendMessage(messageListener, { type: 'GET_STATE' });
    await fixture.storage.set({
      flowRecorderState: {
        ...fixture.storage.snapshot().flowRecorderState,
        settings: { ...recovered.settings, captureMode: 'screen' },
        streamActive: true
      }
    });

    const available = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(available.devToolsOpen, true);
    await commandListener('capture-later');
    const captured = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(captured.sequence, recovered.sequence + 1);

    const popupResponse = await sendMessage(messageListener, { type: 'CAPTURE_LATER' });
    assert.equal(popupResponse.devToolsOpen, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const capturedFromPopup = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(capturedFromPopup.sequence, recovered.sequence + 2);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('starts fresh after browser startup when a resume folder was only selected', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        pendingResumeFolder: { name: 'Previously selected captures' },
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: false,
          savePdf: false
        }
      }
    });
    await loadBackground();
    await fixture.chrome.runtime.onStartup.listeners[0]();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const state = await sendMessage(messageListener, { type: 'GET_STATE' });
    assert.equal(state.pendingResumeFolder, null);

    const started = await sendMessage(messageListener, {
      type: 'START',
      settings: { captureMode: 'tab', fullPage: false, savePng: false, savePdf: false }
    });
    assert.equal(started.recording, true);
    assert.equal(started.outputFolder, null);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('reconnects an active recording to an empty selected capture folder', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder({ withPreviousCapture: false });
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: true,
        tabId: fixture.liveTab.id,
        windowId: fixture.liveTab.windowId,
        sessionId: fixture.sessionId,
        sequence: 0,
        captures: [],
        outputFolder: { name: folder.directoryHandle.name },
        folderAccessNeeded: true,
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: true,
          savePdf: true
        }
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const reconnected = await sendMessage(messageListener, { type: 'RECONNECT_CAPTURE_FOLDER' });

    assert.equal(reconnected.recording, true);
    assert.equal(reconnected.folderAccessNeeded, false);
    assert.equal(reconnected.lastError, null);
    assert.equal(
      reconnected.notice,
      'No previous screenshots found in selected folder, JShotz is still capturing the current flows to the selected folder.'
    );

    const captured = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    assert.equal(captured.sequence, 1);
    assert.ok([...folder.written.keys()].some((name) => /^001_.*\.png$/.test(name)));

    folder.setReportedPermission('prompt');
    const saved = await sendMessage(messageListener, { type: 'SAVE_FLOW' });
    assert.equal(saved.lastError, null);
    assert.equal(saved.folderAccessNeeded, false);
    assert.match(saved.savedPdfFilename, /^session_before_crash_checkpoint_.*\.pdf$/);
    assert.ok([...folder.written.keys()].some((name) => /_checkpoint_.*\.pdf$/.test(name)));
    assert.equal(fixture.exportRequests.length, 0);

    const continued = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    assert.equal(continued.recording, true);
    assert.equal(continued.outputFolder.name, folder.directoryHandle.name);
    assert.equal(continued.sequence, 2);
    assert.ok([...folder.written.keys()].some((name) => /^002_.*\.png$/.test(name)));

    folder.setPermission('denied');
    const denied = await sendMessage(messageListener, { type: 'SAVE_FLOW' });
    assert.equal(denied.folderAccessNeeded, true);
    assert.match(denied.lastError, /^PDF export failed: The selected capture folder needs permission again\./);

    assert.equal(await requestReadWritePermissionFromUserGesture(folder.directoryHandle), true);
    const savedAfterRenewal = await sendMessage(messageListener, { type: 'SAVE_FLOW' });
    assert.equal(savedAfterRenewal.lastError, null);
    assert.equal(savedAfterRenewal.folderAccessNeeded, false);
    assert.ok(folder.written.has(savedAfterRenewal.savedPdfFilename));
    assert.equal(fixture.exportRequests.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('stops and saves custom-named PDF and Word documents together in the selected folder', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder({ withPreviousCapture: false });
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: true,
        tabId: fixture.liveTab.id,
        windowId: fixture.liveTab.windowId,
        sessionId: fixture.sessionId,
        sequence: 1,
        captures: [{ sequence: 1, title: 'Recovered page', note: 'Check the confirmation' }],
        outputFolder: { name: folder.directoryHandle.name },
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: true,
          savePdf: true
        }
      },
      'flowRecorderFrames:1': {
        sequence: 1,
        title: 'Recovered page',
        note: 'Check the confirmation',
        url: 'https://example.test/recovered',
        time: '2026-09-13 10:00 UTC',
        base64: 'cHJvYmU=',
        width: 1,
        height: 1
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const saved = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      reveal: true,
      outputFilename: 'review-package',
      outputFormats: ['pdf', 'docx']
    });

    assert.equal(saved.recording, false);
    assert.equal(saved.fileLocationOpened, true);
    assert.equal(saved.fileLocationFallback, true);
    assert.deepEqual(saved.savedOutputFilenames, ['review-package.pdf', 'review-package.docx']);
    assert.equal(saved.savedPdfFilename, 'review-package.pdf');
    assert.ok(folder.written.has('review-package.pdf'));
    assert.ok(folder.written.has('review-package.docx'));
    assert.equal(fixture.exportRequests.length, 0);
    assert.deepEqual(fixture.revealedDownloads, ['default-folder']);
    const manifest = JSON.parse(folder.written.get('flow-manifest.json'));
    assert.ok(
      manifest.debugLog.some((line) =>
        line.includes('FILE_SAVE status=completed type=pdf destination=selected-folder filename=review-package.pdf')
      )
    );
    assert.ok(
      manifest.debugLog.some((line) =>
        line.includes('FILE_SAVE status=completed type=docx destination=selected-folder filename=review-package.docx')
      )
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('generates versioned evidence documents from a stopped selected-folder recording', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const fixture = createChrome();
  const folder = createResumeFolder({ withPreviousCapture: false });
  globalThis.chrome = fixture.chrome;
  globalThis.indexedDB = createIndexedDb();

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: true,
        tabId: fixture.liveTab.id,
        windowId: fixture.liveTab.windowId,
        sessionId: fixture.sessionId,
        sequence: 1,
        captures: [{ sequence: 1, title: 'Recovered page', note: 'Evidence note' }],
        outputFolder: { name: folder.directoryHandle.name },
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: true,
          savePdf: true
        }
      },
      'flowRecorderFrames:1': {
        sequence: 1,
        title: 'Recovered page',
        note: 'Evidence note',
        url: 'https://example.test/recovered',
        time: '2026-09-14 20:00 UTC',
        base64: 'cHJvYmU=',
        width: 1,
        height: 1
      }
    });
    await saveCaptureFolder(folder.directoryHandle);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const stopped = await sendMessage(messageListener, {
      type: 'STOP',
      keepFiles: true,
      outputFilename: 'review-package',
      outputFormats: ['pdf']
    });

    assert.equal(stopped.recording, false);
    assert.deepEqual(stopped.completedEvidence && {
      sessionId: stopped.completedEvidence.sessionId,
      captureCount: stopped.completedEvidence.captureCount,
      outputFolderName: stopped.completedEvidence.outputFolderName
    }, {
      sessionId: fixture.sessionId,
      captureCount: 1,
      outputFolderName: folder.directoryHandle.name
    });
    assert.ok(folder.written.has('review-package.pdf'));

    const evidence = await sendMessage(messageListener, {
      type: 'GENERATE_EVIDENCE',
      outputFilename: 'review-package',
      outputFormats: ['pdf', 'docx'],
      excludedSequences: []
    });

    assert.equal(evidence.recording, false);
    assert.equal(evidence.lastError, null);
    assert.equal(evidence.completedEvidence.sessionId, fixture.sessionId);
    assert.equal(evidence.savedOutputFilenames.length, 2);
    assert.match(evidence.savedOutputFilenames[0], /^review-package_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.pdf$/);
    assert.match(evidence.savedOutputFilenames[1], /^review-package_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.docx$/);
    assert.ok(folder.written.has(evidence.savedOutputFilenames[0]));
    assert.ok(folder.written.has(evidence.savedOutputFilenames[1]));
    assert.deepEqual(
      Array.from(folder.written.get(evidence.savedOutputFilenames[1]).subarray(0, 4)),
      [0x50, 0x4b, 0x03, 0x04]
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('versions evidence documents in the prior Downloads session directory', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await fixture.setStorage({
      flowRecorderState: {
        recording: false,
        sessionId: fixture.sessionId,
        sequence: 1,
        captures: [{ sequence: 1, title: 'Recovered page', note: '' }],
        completedEvidence: {
          sessionId: fixture.sessionId,
          captureCount: 1,
          outputFolderName: null,
          downloadDirectory: `flow-captures/${fixture.sessionId}`,
          completedAt: '2026-09-14T20:00:00.000Z'
        },
        settings: {
          captureMode: 'tab',
          captureOnClick: true,
          captureOnScroll: true,
          captureApi: false,
          stampTimestamp: false,
          fullPage: false,
          savePng: true,
          savePdf: true
        }
      },
      'flowRecorderFrames:1': {
        sequence: 1,
        title: 'Recovered page',
        note: '',
        url: 'https://example.test/recovered',
        time: '2026-09-14 20:00 UTC',
        base64: 'cHJvYmU=',
        width: 1,
        height: 1
      }
    });
    fixture.addExistingDownload(`flow-captures/${fixture.sessionId}/review-package.pdf`);
    await loadBackground();

    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const evidence = await sendMessage(messageListener, {
      type: 'GENERATE_EVIDENCE',
      outputFilename: 'review-package',
      outputFormats: ['pdf']
    });

    assert.equal(evidence.lastError, null);
    assert.match(evidence.savedPdfFilename, /^review-package_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.pdf$/);
    const outputRequest = fixture.exportRequests.at(-1);
    const output = JSON.parse(new URL(outputRequest.url, 'https://extension.test').searchParams.get('outputs'))[0];
    assert.equal(output.filename, `flow-captures/${fixture.sessionId}/${evidence.savedPdfFilename}`);
    assert.ok(fixture.downloadSearchQueries.some((query) => Object.keys(query).length === 0));
    assert.deepEqual(fixture.downloadUiEvents, ['ui:false', 'ui:true']);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('opens a non-revealing final-save output dialog without ending the recording', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    await sendMessage(messageListener, { type: 'CAPTURE_NOW' });

    const state = await sendMessage(messageListener, {
      type: 'OPEN_OUTPUT_DIALOG',
      mode: 'final',
      reveal: true
    });

    assert.equal(state.recording, true);
    assert.match(
      new URL(fixture.exportRequests.at(-1).url, 'https://extension.test').pathname,
      /output-dialog\.html$/
    );
    assert.equal(
      new URL(fixture.exportRequests.at(-1).url, 'https://extension.test').searchParams.get('mode'),
      'final'
    );
    assert.equal(
      new URL(fixture.exportRequests.at(-1).url, 'https://extension.test').searchParams.has('reveal'), false
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('persists a 50-character screenshot note with its capture frame', async () => {
  const originalChrome = globalThis.chrome;
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await loadBackground();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const captured = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    const sequence = captured.sequence;
    const note = 'Verify that the confirmation message is visible.';

    const noted = await sendMessage(messageListener, {
      type: 'SET_CAPTURE_NOTE',
      sessionId: captured.sessionId,
      sequence,
      note
    });

    assert.equal(noted.captures.find((capture) => capture.sequence === sequence)?.note, note);
    assert.equal(fixture.storageSnapshot()[`flowRecorderFrames:${sequence}`]?.note, note);

    const rejected = await sendMessage(messageListener, {
      type: 'SET_CAPTURE_NOTE',
      sessionId: captured.sessionId,
      sequence,
      note: 'x'.repeat(51)
    });
    assert.match(rejected.lastError, /50 characters or fewer/);
    assert.equal(
      fixture.storageSnapshot()[`flowRecorderFrames:${sequence}`]?.note,
      note
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

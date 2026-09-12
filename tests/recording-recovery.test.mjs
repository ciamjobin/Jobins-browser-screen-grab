import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { saveCaptureFolder } from '../flow-screenshot-extension/capture-folder.js';

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

function createResumeFolder() {
  const imageName = '001_2026-09-12_10-00-00-000_Previous_step.png';
  const manifest = JSON.stringify({
    sessionId: 'session_before_crash',
    screenshots: [{
      sequence: 1,
      title: 'Previous step',
      url: 'https://example.test/previous',
      reason: 'click',
      mode: 'tab',
      capturedAt: '2026-09-12T10:00:00.000Z',
      filename: `flow-captures/session_before_crash/${imageName}`
    }]
  });
  const files = new Map([
    [imageName, { contents: Uint8Array.from([112, 114, 111, 98, 101]), type: 'image/png' }],
    ['flow-manifest.json', { contents: manifest, type: 'application/json' }]
  ]);
  const written = new Map();
  let permission = 'granted';

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
    directoryHandle: {
      kind: 'directory',
      name: 'session_before_crash',
      async queryPermission() {
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
    }
  };
}

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
  const exportRequests = [];
  const revealedDownloads = [];
  const tabMessages = [];
  let captureError = null;
  let captureCount = 0;
  let nextExportWindowId = 1000;

  const chrome = {
    storage: { local: storage },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {}
    },
    downloads: {
      async download(options) {
        downloadRequests.push(options);
        return downloadRequests.length;
      },
      async setUiOptions() {},
      async show(downloadId) {
        revealedDownloads.push(downloadId);
      },
      async showDefaultFolder() {}
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
        if (message.target !== 'offscreen') throw new Error(`Unexpected runtime message: ${message.type}`);
        if (message.type === 'OFFSCREEN_PING') return { ok: true };
        if (message.type === 'OFFSCREEN_PROCESS') {
          offscreenMessages.push(message);
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
        captureCount += 1;
        return 'data:image/png;base64,cHJvYmU=';
      }
    },
    windows: {
      onRemoved: createEvent(),
      async create(options) {
        const win = { id: nextExportWindowId++ };
        exportRequests.push(options);
        setTimeout(() => {
          const listener = chrome.runtime.onMessage.listeners.at(-1);
          listener?.({ type: 'PDF_DONE', downloadId: 5000 + exportRequests.length }, {}, () => {});
        }, 0);
        return win;
      },
      async remove() {}
    },
    webNavigation: {
      onCompleted: createEvent(),
      onHistoryStateUpdated: createEvent(),
      onReferenceFragmentUpdated: createEvent()
    },
    commands: { onCommand: createEvent() },
    scripting: {
      async executeScript(details) {
        if (details.files) injectedFiles.push(details.files[0]);
        return [{ result: '' }];
      }
    }
  };

  return {
    chrome,
    captureCount: () => captureCount,
    downloadRequests,
    exportRequests,
    injectedFiles,
    liveTab,
    offscreenMessages,
    revealedDownloads,
    sessionId,
    tabMessages,
    setCaptureError(error) {
      captureError = error;
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

    fixture.chrome.runtime.onStartup.listeners[0]();
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

test('saves a flow without stopping and starts a separate recording without deleting the previous flow', async () => {
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
    assert.equal(fixture.exportRequests.length, 1);
    assert.match(
      new URL(fixture.exportRequests[0].url, 'https://extension.test').searchParams.get('filename'),
      new RegExp(`flow-captures/${previousSessionId}/`)
    );
    assert.equal(fixture.revealedDownloads.length, 0);

    await sendMessage(
      messageListener,
      { type: 'SAVE_FLOW', reveal: true },
      { tab: fixture.liveTab }
    );
    assert.equal(fixture.exportRequests.length, 2);
    assert.deepEqual(fixture.revealedDownloads, [5002]);

    const fresh = await sendMessage(
      messageListener,
      { type: 'START_NEW_RECORDING' },
      { tab: fixture.liveTab }
    );
    assert.equal(fresh.recording, true);
    assert.notEqual(fresh.sessionId, previousSessionId);
    assert.equal(fresh.sequence, 1);
    assert.equal(fresh.captures.length, 1);
    assert.equal(fixture.captureCount(), 2);
    assert.equal(fixture.exportRequests.length, 3);
    assert.ok(
      fixture.downloadRequests.some((request) =>
        request.filename === `flow-captures/${previousSessionId}/flow-manifest.json`
      )
    );
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
    assert.match(resumed.captures[1].filename, /^002_/);
    assert.equal(fixture.downloadRequests.length, 0);
    assert.ok([...folder.written.keys()].some((name) => /^002_.*\.png$/.test(name)));

    folder.setPermission('denied');
    await loadBackground();
    const restartedMessageListener = fixture.chrome.runtime.onMessage.listeners.at(-1);
    const unavailable = await sendMessage(restartedMessageListener, { type: 'GET_STATE' });
    assert.equal(unavailable.sequence, 2);
    assert.equal(unavailable.folderAccessNeeded, true);
    assert.match(unavailable.lastError, /Reconnect capture folder/);
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
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

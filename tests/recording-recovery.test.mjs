import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

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
  let captureCount = 0;

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
      async show() {},
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
        if (message.type === 'OFFSCREEN_PROCESS') return { pngDataUrl: message.dataUrl };
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
      async captureVisibleTab(windowId) {
        assert.equal(windowId, liveTab.windowId);
        captureCount += 1;
        return 'data:image/png;base64,cHJvYmU=';
      }
    },
    windows: { onRemoved: createEvent() },
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
    injectedFiles,
    liveTab,
    sessionId,
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
  const fixture = createChrome();
  globalThis.chrome = fixture.chrome;

  try {
    await import(`${pathToFileURL(resolve('flow-screenshot-extension/background.js')).href}?recovery-test=${Date.now()}`);

    fixture.chrome.runtime.onStartup.listeners[0]();
    const messageListener = fixture.chrome.runtime.onMessage.listeners[0];
    const recovered = await sendMessage(messageListener, { type: 'GET_STATE' });

    assert.equal(recovered.tabId, fixture.liveTab.id);
    assert.deepEqual(recovered.trackedTabIds, [fixture.liveTab.id]);
    assert.equal(recovered.captureGeneration, 5);
    assert.equal(recovered.captures.length, 40);
    assert.deepEqual(fixture.injectedFiles, ['page-hook.js', 'content.js']);

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

    const captured = await sendMessage(messageListener, { type: 'CAPTURE_NOW' });
    assert.equal(captured.sequence, 41);
    assert.equal(captured.captures.length, 41);
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

    const stopped = await sendMessage(messageListener, { type: 'STOP', keepFiles: true });
    assert.equal(stopped.recording, false);
    assert.equal(fixture.downloadRequests.length, 1);
    assert.equal(fixture.downloadRequests[0].filename.endsWith('/flow-manifest.json'), true);
    assert.equal(fixture.downloadRequests.some((request) => request.filename.endsWith('/debug-log.txt')), false);
    const manifest = JSON.parse(Buffer.from(fixture.downloadRequests[0].url.split(',')[1], 'base64').toString('utf8'));
    assert.ok(manifest.debugLog.some((line) => line.includes('SESSION_PAUSED')));
    assert.ok(manifest.debugLog.some((line) => line.includes('SESSION_CONTINUED')));
  } finally {
    globalThis.chrome = originalChrome;
  }
});
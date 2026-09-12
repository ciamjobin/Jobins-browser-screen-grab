import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const pageHookSource = await readFile(resolve('flow-screenshot-extension/page-hook.js'), 'utf8');

function createHookEnvironment() {
  const attributes = new Map();
  const listeners = new Map();
  const posted = [];
  const root = {
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener.call(this, event);
      return true;
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    }
  };
  const nativeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { forEach(callback) { callback('application/json', 'content-type'); } },
    clone() {
      return { text: async () => '{"ok":true}' };
    }
  });
  function FakeXmlHttpRequest() {}
  const nativeOpen = function () {};
  const nativeSend = function () {};
  const nativeSetRequestHeader = function () {};
  FakeXmlHttpRequest.prototype.open = nativeOpen;
  FakeXmlHttpRequest.prototype.send = nativeSend;
  FakeXmlHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;

  const window = {
    fetch: nativeFetch,
    postMessage(message) {
      posted.push(message);
    }
  };
  vm.runInNewContext(pageHookSource, {
    URL,
    XMLHttpRequest: FakeXmlHttpRequest,
    document: { documentElement: root, referrer: '' },
    location: { href: 'https://example.test/flow', origin: 'https://example.test' },
    window
  });

  return { nativeFetch, nativeOpen, nativeSend, nativeSetRequestHeader, posted, root, window, FakeXmlHttpRequest };
}

test('only hooks page networking while API capture is explicitly enabled', async () => {
  const environment = createHookEnvironment();
  const { FakeXmlHttpRequest, nativeFetch, nativeOpen, nativeSend, nativeSetRequestHeader, posted, root, window } =
    environment;

  assert.equal(window.fetch, nativeFetch);
  assert.equal(FakeXmlHttpRequest.prototype.open, nativeOpen);
  assert.equal(FakeXmlHttpRequest.prototype.send, nativeSend);
  assert.equal(FakeXmlHttpRequest.prototype.setRequestHeader, nativeSetRequestHeader);

  root.setAttribute('data-jshotz-api-capture', '1');
  root.dispatchEvent({ type: 'jshotz-api-capture-change' });
  assert.notEqual(window.fetch, nativeFetch);

  await window.fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"orderId":42}'
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].detail.url, 'https://example.test/api/orders');
  assert.equal(posted[0].detail.method, 'POST');

  root.setAttribute('data-jshotz-api-capture', '0');
  root.dispatchEvent({ type: 'jshotz-api-capture-change' });
  assert.equal(window.fetch, nativeFetch);
  assert.equal(FakeXmlHttpRequest.prototype.open, nativeOpen);
  assert.equal(FakeXmlHttpRequest.prototype.send, nativeSend);
  assert.equal(FakeXmlHttpRequest.prototype.setRequestHeader, nativeSetRequestHeader);
});
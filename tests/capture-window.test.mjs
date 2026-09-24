import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const captureWindowSource = await readFile(resolve('flow-screenshot-extension/capture-window.js'), 'utf8');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    listener(type) {
      return listeners.get(type);
    }
  };
}

test('buffers a screen frame after a meaningful visual change settles', async () => {
  const share = { ...eventTarget(), disabled: false, textContent: '' };
  const state = { textContent: '', className: '' };
  const video = {
    ...eventTarget(),
    videoWidth: 1920,
    videoHeight: 1080,
    srcObject: null,
    async play() {}
  };
  let sample = new Uint8ClampedArray(128 * 72 * 4);
  const fullFrame = 'data:image/jpeg;base64,YnVmZmVyZWQtZnJhbWU=';
  let canvasIndex = 0;
  const blobCanvasIds = [];
  const document = {
    getElementById(id) {
      return { share, state, preview: video }[id];
    },
    createElement() {
      const canvasId = canvasIndex++;
      const isFrameCanvas = canvasId === 0;
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            getImageData() {
              return { data: new Uint8ClampedArray(sample) };
            }
          };
        },
        toDataURL() {
          return isFrameCanvas ? fullFrame : '';
        },
        toBlob(callback, type) {
          blobCanvasIds.push(canvasId);
          callback(new Blob(['buffered-frame'], { type }));
        }
      };
    }
  };
  const runtimeMessages = [];
  const runtimeListeners = [];
  let intervalCallback = null;
  let settleCallback = null;
  let settleDelay = null;
  let now = 1000;
  let firstTrackStops = 0;
  const firstTrack = { ...eventTarget(), stop() { firstTrackStops += 1; } };
  const firstStream = {
    getTracks: () => [firstTrack],
    getVideoTracks: () => [firstTrack]
  };
  let selectedStream = firstStream;
  let getDisplayError = null;
  const context = {
    Blob,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    FileReader: class {
      readAsDataURL() {
        this.result = fullFrame;
        queueMicrotask(() => this.onload?.());
      }
    },
    Math,
    Uint8ClampedArray,
    clearInterval() {},
    clearTimeout() {},
    document,
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          if (getDisplayError) throw getDisplayError;
          return selectedStream;
        }
      }
    },
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    setTimeout(callback, delay) {
      settleCallback = callback;
      settleDelay = delay;
      return 2;
    },
    window: eventTarget(),
    chrome: {
      runtime: {
        sendMessage(message) {
          runtimeMessages.push(message);
          return Promise.resolve(
            message.type === 'SCREEN_FRAME_BUFFERED' ? { ok: true, accepted: true } : { ok: true }
          );
        },
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          }
        }
      }
    }
  };

  vm.runInNewContext(captureWindowSource, context);
  await share.listener('click')();
  assert.equal(runtimeMessages[0].type, 'SCREEN_READY');

  sample = new Uint8ClampedArray(sample);
  for (let index = 0; index < 100 * 4; index += 4) {
    sample[index] = 255;
    sample[index + 1] = 255;
    sample[index + 2] = 255;
  }
  intervalCallback();
  await settleCallback();

  const notification = runtimeMessages.at(-1);
  assert.equal(notification.type, 'SCREEN_FRAME_BUFFERED');
  const response = await new Promise((resolveResponse) => {
    runtimeListeners[0](
      { target: 'screen', type: 'SCREEN_TAKE_BUFFERED', frameId: notification.frameId },
      {},
      resolveResponse
    );
  });
  assert.equal(response.dataUrl, fullFrame);

  const queuedFrames = await Promise.all(Array.from({ length: 100 }, () =>
    new Promise((resolveResponse) => {
      runtimeListeners[0]({ target: 'screen', type: 'SCREEN_BUFFER_CAPTURE' }, {}, resolveResponse);
    })
  ));
  assert.equal(new Set(blobCanvasIds.slice(-100)).size, 100);
  for (const queuedFrame of queuedFrames) {
    const queuedResponse = await new Promise((resolveResponse) => {
      runtimeListeners[0](
        { target: 'screen', type: 'SCREEN_TAKE_BUFFERED', frameId: queuedFrame.frameId },
        {},
        resolveResponse
      );
    });
    assert.equal(queuedResponse.dataUrl, fullFrame);
  }

  for (let sampleNumber = 0; sampleNumber < 7; sampleNumber += 1) {
    now += 250;
    sample = new Uint8ClampedArray(sample);
    for (let index = 0; index < 100 * 4; index += 4) {
      sample[index] = sampleNumber % 2 ? 255 : 0;
      sample[index + 1] = sampleNumber % 2 ? 255 : 0;
      sample[index + 2] = sampleNumber % 2 ? 255 : 0;
    }
    intervalCallback();
  }
  let bufferedNotifications = runtimeMessages.filter(({ type }) => type === 'SCREEN_FRAME_BUFFERED');
  assert.equal(bufferedNotifications.length, 1);
  await new Promise((resolveResponse) => {
    runtimeListeners[0](
      { target: 'screen', type: 'SCREEN_FRAME_PROCESSED', frameId: notification.frameId },
      {},
      resolveResponse
    );
  });
  assert.equal(settleDelay, 350);
  await settleCallback();
  bufferedNotifications = runtimeMessages.filter(({ type }) => type === 'SCREEN_FRAME_BUFFERED');
  assert.equal(bufferedNotifications.length, 2);
  assert.notEqual(bufferedNotifications[0].frameId, bufferedNotifications[1].frameId);
  assert.equal(bufferedNotifications[1].actionAt, now);

  for (let expectedCount = 3; expectedCount <= 12; expectedCount += 1) {
    const pendingNotification = bufferedNotifications.at(-1);
    now += 250;
    sample = new Uint8ClampedArray(sample);
    for (let index = 0; index < 100 * 4; index += 4) {
      sample[index] = sample[index] ? 0 : 255;
      sample[index + 1] = sample[index];
      sample[index + 2] = sample[index];
    }
    intervalCallback();
    await new Promise((resolveResponse) => {
      runtimeListeners[0](
        { target: 'screen', type: 'SCREEN_TAKE_BUFFERED', frameId: pendingNotification.frameId },
        {},
        resolveResponse
      );
    });
    await new Promise((resolveResponse) => {
      runtimeListeners[0](
        { target: 'screen', type: 'SCREEN_FRAME_PROCESSED', frameId: pendingNotification.frameId },
        {},
        resolveResponse
      );
    });
    await settleCallback();
    bufferedNotifications = runtimeMessages.filter(({ type }) => type === 'SCREEN_FRAME_BUFFERED');
    assert.equal(bufferedNotifications.length, expectedCount);
  }

  let secondTrackStops = 0;
  const secondTrack = { ...eventTarget(), stop() { secondTrackStops += 1; } };
  const secondStream = {
    getTracks: () => [secondTrack],
    getVideoTracks: () => [secondTrack]
  };
  selectedStream = secondStream;
  await share.listener('click')();
  assert.equal(firstTrackStops, 1);
  assert.equal(secondTrackStops, 0);
  assert.equal(video.srcObject, secondStream);

  getDisplayError = new Error('Share selection canceled.');
  await share.listener('click')();
  assert.equal(secondTrackStops, 0);
  assert.equal(video.srcObject, secondStream);

  secondTrack.listener('ended')();
  assert.equal(runtimeMessages.at(-1).type, 'SCREEN_ENDED');
  assert.equal(runtimeMessages.at(-1).source, 'screen-window');
  assert.equal(secondTrackStops, 1);
  assert.equal(video.srcObject, null);
});
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { getMemoryStatus, readRuntimeMemory } from '../flow-screenshot-extension/memory-monitor.js';

const captureWindowSource = await readFile(resolve('flow-screenshot-extension/capture-window.js'), 'utf8');

test('adapts prebuffer depth to measured memory pressure', () => {
  const normal = getMemoryStatus({
    memorySamples: [{ jsHeapUsedBytes: 300, jsHeapLimitBytes: 1000 }],
    deviceMemoryGb: 8
  });
  const high = getMemoryStatus({
    memorySamples: [{ jsHeapUsedBytes: 920, jsHeapLimitBytes: 1000 }],
    deviceMemoryGb: 8
  });

  assert.equal(normal.level, 'normal');
  assert.equal(normal.maxPrebufferedCaptureFrames, 10);
  assert.equal(high.level, 'high');
  assert.equal(high.maxPrebufferedCaptureFrames, 1);
  assert.equal(high.estimatedHeapHeadroomBytes, 80);
});

test('keeps missing memory telemetry conservative while captures queue', () => {
  const unavailable = getMemoryStatus();
  const unavailableWithQueuedCaptures = getMemoryStatus({ pendingCaptureCount: 3 });
  const constrained = getMemoryStatus({ screenBufferedBytes: 80 * 1024 * 1024 });

  assert.equal(unavailable.level, 'unavailable');
  assert.equal(unavailable.maxPrebufferedCaptureFrames, 4);
  assert.equal(unavailableWithQueuedCaptures.level, 'unavailable');
  assert.equal(unavailableWithQueuedCaptures.maxPrebufferedCaptureFrames, 4);
  assert.equal(constrained.level, 'elevated');
  assert.equal(constrained.maxPrebufferedCaptureFrames, 3);
});

test('reads browser heap telemetry only when the runtime exposes it', () => {
  const snapshot = readRuntimeMemory({
    performance: { memory: { usedJSHeapSize: 400, jsHeapSizeLimit: 1000 } },
    navigator: { deviceMemory: 8 }
  });

  assert.deepEqual(snapshot, {
    jsHeapUsedBytes: 400,
    jsHeapLimitBytes: 1000,
    deviceMemoryGb: 8
  });
  assert.deepEqual(readRuntimeMemory({}), {
    jsHeapUsedBytes: null,
    jsHeapLimitBytes: null,
    deviceMemoryGb: null
  });
});

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
    async play() {},
    requestVideoFrameCallback(callback) {
      videoFrameCallback(callback);
    }
  };
  let sample = new Uint8ClampedArray(128 * 72 * 4);
  const fullFrame = 'data:image/jpeg;base64,YnVmZmVyZWQtZnJhbWU=';
  let canvasIndex = 0;
  const blobCanvasIds = [];
  let activeBlobEncodes = 0;
  let maxActiveBlobEncodes = 0;
  const document = {
    getElementById(id) {
      return { share, state, preview: video }[id];
    },
    createElement() {
      const canvasId = canvasIndex++;
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
          return fullFrame;
        },
        toBlob(callback, type) {
          blobCanvasIds.push(canvasId);
          activeBlobEncodes += 1;
          maxActiveBlobEncodes = Math.max(maxActiveBlobEncodes, activeBlobEncodes);
          queueMicrotask(() => {
            activeBlobEncodes -= 1;
            callback(new Blob(['buffered-frame'], { type }));
          });
        }
      };
    }
  };
  const runtimeMessages = [];
  const runtimeListeners = [];
  let intervalCallback = null;
  let memoryIntervalCallback = null;
  let settleCallback = null;
  let settleDelay = null;
  let videoFrameCallback = (callback) => queueMicrotask(callback);
  let now = 1000;
  let firstTrackStops = 0;
  const firstTrack = {
    ...eventTarget(),
    getSettings: () => ({ displaySurface: 'monitor' }),
    stop() { firstTrackStops += 1; }
  };
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
    performance: { memory: { usedJSHeapSize: 512, jsHeapSizeLimit: 1024 } },
    navigator: {
      deviceMemory: 8,
      mediaDevices: {
        async getDisplayMedia() {
          if (getDisplayError) throw getDisplayError;
          return selectedStream;
        }
      }
    },
    setInterval(callback, delay) {
      if (delay === 5000) {
        memoryIntervalCallback = callback;
        return 2;
      }
      intervalCallback = callback;
      return 1;
    },
    setTimeout(callback, delay) {
      if (delay === 250) {
        queueMicrotask(callback);
        return 3;
      }
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
  const readyMessage = runtimeMessages.find(({ type }) => type === 'SCREEN_READY');
  assert.equal(readyMessage.type, 'SCREEN_READY');
  assert.equal(readyMessage.displaySurface, 'monitor');
  assert.equal(typeof memoryIntervalCallback, 'function');
  memoryIntervalCallback();
  const periodicMemoryReport = runtimeMessages
    .filter(({ type }) => type === 'SCREEN_MEMORY_STATUS')
    .at(-1);
  assert.equal(periodicMemoryReport.jsHeapUsedBytes, 512);
  assert.equal(periodicMemoryReport.jsHeapLimitBytes, 1024);
  assert.equal(periodicMemoryReport.deviceMemoryGb, 8);

  sample = new Uint8ClampedArray(sample.length);
  for (let index = 0; index < sample.length; index += 4) {
    sample[index] = 214;
    sample[index + 1] = 226;
    sample[index + 2] = 247;
  }
  intervalCallback();
  await settleCallback?.();
  assert.equal(
    runtimeMessages.filter(({ type }) => type === 'SCREEN_FRAME_BUFFERED').length,
    0
  );
  const blankBufferedCapture = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_BUFFER_CAPTURE' }, {}, resolveResponse);
  });
  assert.match(blankBufferedCapture.error, /blank|unavailable/i);
  const blankDirectCapture = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_CAPTURE' }, {}, resolveResponse);
  });
  assert.match(blankDirectCapture.error, /blank|unavailable/i);

  sample = new Uint8ClampedArray(sample.length);
  for (let index = 0; index < sample.length; index += 4) {
    sample[index] = 214;
    sample[index + 1] = 226;
    sample[index + 2] = 247;
  }
  for (let pixel = 0; pixel < 6 * 128; pixel += 1) {
    const index = pixel * 4;
    sample[index] = pixel % 2 ? 255 : 32;
    sample[index + 1] = sample[index];
    sample[index + 2] = sample[index];
  }
  const headerOnlyCapture = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_CAPTURE' }, {}, resolveResponse);
  });
  assert.match(headerOnlyCapture.error, /blank|unavailable/i);
  for (let sampleNumber = 0; sampleNumber < 8; sampleNumber += 1) intervalCallback();
  assert.equal(runtimeMessages.at(-1).type, 'SCREEN_UNHEALTHY');
  assert.match(state.textContent, /blank or incomplete/i);

  let repaintAttempts = 0;
  videoFrameCallback = (callback) => queueMicrotask(() => {
    repaintAttempts += 1;
    if (repaintAttempts === 2) {
      sample = new Uint8ClampedArray(sample.length);
      for (let pixel = 500; pixel < 2000; pixel += 1) {
        const index = pixel * 4;
        sample[index] = 255;
        sample[index + 1] = 255;
        sample[index + 2] = 255;
      }
    }
    callback();
  });
  const healedDirectCapture = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_CAPTURE' }, {}, resolveResponse);
  });
  assert.equal(healedDirectCapture.dataUrl, fullFrame);
  assert.equal(repaintAttempts, 2);
  videoFrameCallback = (callback) => queueMicrotask(callback);
  now += 1000;

  sample = new Uint8ClampedArray(sample.length);
  for (let index = 0; index < 400 * 4; index += 4) {
    sample[index] = 255;
    sample[index + 1] = 255;
    sample[index + 2] = 255;
  }
  intervalCallback();
  await settleCallback?.();
  assert.equal(
    runtimeMessages.filter(({ type }) => type === 'SCREEN_FRAME_BUFFERED').length,
    0
  );

  sample = new Uint8ClampedArray(sample.length);
  for (let pixel = 0; pixel < sample.length / 4; pixel += 1) {
    const index = pixel * 4;
    const x = pixel % 128;
    const y = Math.floor(pixel / 128);
    sample[index] = (x * 7 + y * 3) % 256;
    sample[index + 1] = (x * 2 + y * 11) % 256;
    sample[index + 2] = (x * 13 + y * 5) % 256;
  }
  intervalCallback();
  await settleCallback();

  const notification = runtimeMessages.at(-1);
  assert.equal(notification.type, 'SCREEN_FRAME_BUFFERED');
  const memoryReport = runtimeMessages
    .filter(({ type }) => type === 'SCREEN_MEMORY_STATUS')
    .at(-1);
  assert.equal(memoryReport.screenBufferedFrames, 1);
  assert.equal(memoryReport.screenBufferedBytes, Buffer.byteLength('buffered-frame'));
  const response = await new Promise((resolveResponse) => {
    runtimeListeners[0](
      { target: 'screen', type: 'SCREEN_TAKE_BUFFERED', frameId: notification.frameId },
      {},
      resolveResponse
    );
  });
  assert.equal(response.dataUrl, fullFrame);

  const delayedFrame = new Promise((resolveResponse) => {
    runtimeListeners[0]({
      target: 'screen',
      type: 'SCREEN_BUFFER_CAPTURE_DELAYED',
      delayMs: 75
    }, {}, resolveResponse);
  });
  assert.equal(settleDelay, 75);
  settleCallback();
  const delayed = await delayedFrame;
  const delayedResponse = await new Promise((resolveResponse) => {
    runtimeListeners[0](
      { target: 'screen', type: 'SCREEN_TAKE_BUFFERED', frameId: delayed.frameId },
      {},
      resolveResponse
    );
  });
  assert.equal(delayedResponse.dataUrl, fullFrame);

  const queuedFrames = await Promise.all(Array.from({ length: 100 }, () =>
    new Promise((resolveResponse) => {
      runtimeListeners[0]({ target: 'screen', type: 'SCREEN_BUFFER_CAPTURE' }, {}, resolveResponse);
    })
  ));
  assert.equal(new Set(blobCanvasIds.slice(-100)).size, 100);
  assert.equal(maxActiveBlobEncodes, 1);
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
    for (let pixel = 500; pixel < 700; pixel += 1) {
      const index = pixel * 4;
      sample[index] = sampleNumber % 2 ? 0 : 255;
      sample[index + 1] = sample[index];
      sample[index + 2] = sample[index];
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
    for (let pixel = 500; pixel < 700; pixel += 1) {
      const index = pixel * 4;
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
  const secondTrack = {
    ...eventTarget(),
    getSettings: () => ({ displaySurface: 'monitor' }),
    stop() { secondTrackStops += 1; }
  };
  const secondStream = {
    getTracks: () => [secondTrack],
    getVideoTracks: () => [secondTrack]
  };
  selectedStream = secondStream;
  await share.listener('click')();
  assert.equal(firstTrackStops, 1);
  assert.equal(secondTrackStops, 0);
  assert.equal(video.srcObject, secondStream);

  video.videoWidth = 770;
  video.videoHeight = 713;
  intervalCallback();
  assert.equal(runtimeMessages.at(-1).type, 'SCREEN_UNHEALTHY');
  assert.match(state.textContent, /changed size.*Select Entire Screen/i);
  const resizedCapture = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_CAPTURE' }, {}, resolveResponse);
  });
  assert.match(resizedCapture.error, /blank|unavailable/i);
  video.videoWidth = 1920;
  video.videoHeight = 1080;

  getDisplayError = new Error('Share selection canceled.');
  await share.listener('click')();
  assert.equal(secondTrackStops, 0);
  assert.equal(video.srcObject, secondStream);

  secondTrack.listener('ended')();
  assert.equal(runtimeMessages.at(-1).type, 'SCREEN_ENDED');
  assert.equal(runtimeMessages.at(-1).source, 'screen-window');
  assert.equal(secondTrackStops, 1);
  assert.equal(video.srcObject, null);

  let windowTrackStops = 0;
  const windowTrack = {
    ...eventTarget(),
    getSettings: () => ({ displaySurface: 'window' }),
    stop() { windowTrackStops += 1; }
  };
  selectedStream = {
    getTracks: () => [windowTrack],
    getVideoTracks: () => [windowTrack]
  };
  getDisplayError = null;
  const readyCount = runtimeMessages.filter(({ type }) => type === 'SCREEN_READY').length;
  await share.listener('click')();
  assert.equal(windowTrackStops, 0);
  const readyMessages = runtimeMessages.filter(({ type }) => type === 'SCREEN_READY');
  assert.equal(readyMessages.length, readyCount + 1);
  assert.equal(readyMessages.at(-1).displaySurface, 'window');

  const messagesBeforeStandby = runtimeMessages.length;
  const standbyResponse = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_SET_ACTIVE', active: false }, {}, resolveResponse);
  });
  assert.equal(standbyResponse.active, false);
  video.videoWidth = 770;
  video.videoHeight = 713;
  intervalCallback();
  assert.equal(runtimeMessages.length, messagesBeforeStandby);
  assert.equal(windowTrackStops, 0);
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  const activeResponse = await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_SET_ACTIVE', active: true }, {}, resolveResponse);
  });
  assert.equal(activeResponse.active, true);

  let unknownTrackStops = 0;
  const unknownTrack = {
    ...eventTarget(),
    getSettings: () => ({}),
    stop() { unknownTrackStops += 1; }
  };
  selectedStream = {
    getTracks: () => [unknownTrack],
    getVideoTracks: () => [unknownTrack]
  };
  await share.listener('click')();
  assert.equal(windowTrackStops, 1);
  assert.equal(unknownTrackStops, 0);
  const allReadyMessages = runtimeMessages.filter(({ type }) => type === 'SCREEN_READY');
  assert.equal(allReadyMessages.length, readyCount + 2);
  assert.equal(allReadyMessages.at(-1).displaySurface, 'unknown');

  await new Promise((resolveResponse) => {
    runtimeListeners[0]({ target: 'screen', type: 'SCREEN_STOP' }, {}, resolveResponse);
  });
  assert.equal(unknownTrackStops, 1);
  assert.equal(video.srcObject, null);
});
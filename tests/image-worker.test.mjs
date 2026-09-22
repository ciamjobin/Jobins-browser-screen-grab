import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullPageCropRect, modalCropRect, paintedContentRatio } from '../flow-screenshot-extension/image-worker.js';

test('maps compact modal CSS bounds to screenshot pixels with a surrounding gutter', () => {
  const crop = modalCropRect(
    {
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      viewportWidth: 1000,
      viewportHeight: 600,
      compact: true
    },
    2000,
    1200
  );

  assert.deepEqual(crop, { x: 178, y: 78, width: 844, height: 644 });
});

test('clamps compact modal crop bounds and ignores malformed or non-compact descriptors', () => {
  assert.deepEqual(
    modalCropRect(
      {
        left: -30,
        top: -10,
        width: 100,
        height: 90,
        viewportWidth: 1000,
        viewportHeight: 600,
        compact: true
      },
      2000,
      1200
    ),
    { x: 0, y: 0, width: 156, height: 176 }
  );
  assert.equal(modalCropRect({ compact: false }, 2000, 1200), null);
  assert.equal(modalCropRect({ compact: true, width: 100 }, 2000, 1200), null);
});

test('crops blank right and bottom space from a full-page screenshot while ignoring an edge rail', () => {
  const width = 500;
  const height = 600;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 3] = 255;
  }
  for (let y = 20; y < 285; y += 1) {
    for (let x = 18; x < 270; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 30;
      data[index + 1] = 40;
      data[index + 2] = 50;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const index = (y * width + width - 1) * 4;
    data[index] = 180;
    data[index + 1] = 180;
    data[index + 2] = 180;
  }

  const crop = fullPageCropRect({ getImageData: () => ({ data }) }, width, height);

  assert.deepEqual(crop, { x: 0, y: 0, width: 286, height: 301 });
});

test('scores a painted frame higher than an empty frame', () => {
  const width = 100;
  const height = 100;
  const empty = new Uint8ClampedArray(width * height * 4).fill(255);
  const painted = empty.slice();
  for (let y = 20; y < 80; y += 1) {
    for (let x = 20; x < 80; x += 1) {
      const index = (y * width + x) * 4;
      painted[index] = 20;
      painted[index + 1] = 40;
      painted[index + 2] = 60;
    }
  }

  assert.equal(paintedContentRatio({ getImageData: () => ({ data: empty }) }, width, height), 0);
  assert.ok(paintedContentRatio({ getImageData: () => ({ data: painted }) }, width, height) > 0.3);
});
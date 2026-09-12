import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modalCropRect } from '../flow-screenshot-extension/image-worker.js';

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
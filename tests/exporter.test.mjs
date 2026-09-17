import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

async function runExporter(search, frames = [
  {
    sequence: 1,
    title: 'Step one',
    url: 'https://example.test/',
    time: 'now',
    base64: 'AA==',
    width: 1,
    height: 1
  }
]) {
  const sourcePath = new URL('../flow-screenshot-extension/exporter.js', import.meta.url);
  const source = await readFile(sourcePath, 'utf8');
  const executable = source
    .replace(
      /import \{ buildDocx \} from '\.\/docx\.js';\s*/,
      "const buildDocx = (pages) => { recordBuiltPages('docx', pages); return new Uint8Array([4, 5, 6, 7]); };\n"
    )
    .replace(
      /import \{ buildPdf \} from '\.\/pdf\.js';\s*/,
      "const buildPdf = (pages) => { recordBuiltPages('pdf', pages); return new Uint8Array([0, 1, 2, 3]); };\n"
    );
  const stateEl = { textContent: '', className: '' };
  const downloadOptions = [];
  const downloadUiOptions = [];
  const builtPages = [];
  let complete;
  const completed = new Promise((resolve) => {
    complete = resolve;
  });
  const sandbox = {
    URL: {
      createObjectURL() {
        throw new Error('Blob URLs are not available in a service worker.');
      }
    },
    URLSearchParams,
    atob,
    btoa,
    recordBuiltPages(format, pages) {
      builtPages.push({ format, pages });
    },
    document: { getElementById: () => stateEl },
    location: { search },
    queueMicrotask,
    chrome: {
      storage: {
        local: {
          async get() {
            return Object.fromEntries(frames.map((frame) => [`flowRecorderFrames:${frame.sequence}`, frame]));
          }
        }
      },
      downloads: {
        async setUiOptions(options) {
          downloadUiOptions.push(options);
        },
        async download(options) {
          downloadOptions.push(options);
          return downloadOptions.length;
        },
        onChanged: {
          addListener(listener) {
            const downloadId = downloadOptions.length;
            queueMicrotask(() => listener({ id: downloadId, state: { current: 'complete' } }));
          },
          removeListener() {}
        }
      },
      runtime: {
        sendMessage(message) {
          complete(message);
        }
      }
    }
  };

  runInNewContext(executable, sandbox);
  const result = await completed;
  return { result, downloadOptions, downloadUiOptions, builtPages };
}

test('exports fallback PDFs as data URLs without calling createObjectURL', async () => {
  const { result, downloadOptions } = await runExporter('?filename=flow.pdf&requestId=checkpoint-123');

  assert.equal(result.type, 'OUTPUT_DONE');
  assert.equal(result.requestId, 'checkpoint-123');
  assert.equal(result.pageCount, 1);
  assert.deepEqual(Array.from(result.downloadIds), [1]);
  assert.equal(downloadOptions[0].filename, 'flow.pdf');
  assert.equal(downloadOptions[0].url, 'data:application/pdf;base64,AAECAw==');
});

test('exports fallback PDF and Word files from one stored capture', async () => {
  const outputs = encodeURIComponent(
    JSON.stringify([
      { format: 'pdf', filename: 'review.pdf' },
      { format: 'docx', filename: 'review.docx' }
    ])
  );
  const { result, downloadOptions } = await runExporter(`?outputs=${outputs}`);

  assert.equal(result.type, 'OUTPUT_DONE');
  assert.deepEqual(Array.from(result.downloadIds), [1, 2]);
  assert.deepEqual(Array.from(result.savedOutputFilenames), ['review.pdf', 'review.docx']);
  assert.equal(downloadOptions[0].url, 'data:application/pdf;base64,AAECAw==');
  assert.equal(
    downloadOptions[1].url,
    'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,BAUGBw=='
  );
});

test('overwrites an explicitly designated interim output file', async () => {
  const outputs = encodeURIComponent(
    JSON.stringify([{ format: 'pdf', filename: 'flow-captures/session/JShotz-interim.pdf', overwrite: true }])
  );
  const { result, downloadOptions, downloadUiOptions } = await runExporter(`?outputs=${outputs}`);

  assert.equal(result.type, 'OUTPUT_DONE');
  assert.deepEqual(Array.from(result.downloadIds), [1]);
  assert.equal(downloadOptions[0].filename, 'flow-captures/session/JShotz-interim.pdf');
  assert.equal(downloadOptions[0].conflictAction, 'overwrite');
  assert.equal(downloadUiOptions.length, 1);
  assert.equal(downloadUiOptions[0].enabled, false);
});

test('exports frames in the order their actions occurred', async () => {
  const { builtPages } = await runExporter('?filename=flow.pdf&requestId=ordered-actions', [
    {
      sequence: 1,
      requestSequence: 3,
      actionAt: '2026-09-15T13:06:11.000Z',
      title: 'Second action',
      url: 'https://example.test/second',
      time: 'second',
      base64: 'AA==',
      width: 1,
      height: 1
    },
    {
      sequence: 2,
      requestSequence: 2,
      actionAt: '2026-09-15T13:06:10.000Z',
      title: 'First action loaded',
      url: 'https://example.test/first',
      time: 'first loaded',
      base64: 'AA==',
      width: 1,
      height: 1
    },
    {
      sequence: 3,
      requestSequence: 1,
      actionAt: '2026-09-15T13:06:10.000Z',
      title: 'First action',
      url: 'https://example.test/first',
      time: 'first',
      base64: 'AA==',
      width: 1,
      height: 1
    }
  ]);

  assert.deepEqual(
    Array.from(builtPages[0].pages, (page) => page.title),
    ['First action', 'First action loaded', 'Second action']
  );
});
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

async function runExporter(search) {
  const sourcePath = new URL('../flow-screenshot-extension/exporter.js', import.meta.url);
  const source = await readFile(sourcePath, 'utf8');
  const executable = source
    .replace(
      /import \{ buildDocx \} from '\.\/docx\.js';\s*/,
      'const buildDocx = () => new Uint8Array([4, 5, 6, 7]);\n'
    )
    .replace(
      /import \{ buildPdf \} from '\.\/pdf\.js';\s*/,
      'const buildPdf = () => new Uint8Array([0, 1, 2, 3]);\n'
    );
  const stateEl = { textContent: '', className: '' };
  const downloadOptions = [];
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
    document: { getElementById: () => stateEl },
    location: { search },
    queueMicrotask,
    chrome: {
      storage: {
        local: {
          async get() {
            return {
              'flowRecorderFrames:1': {
                sequence: 1,
                title: 'Step one',
                url: 'https://example.test/',
                time: 'now',
                base64: 'AA==',
                width: 1,
                height: 1
              }
            };
          }
        }
      },
      downloads: {
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
  return { result, downloadOptions };
}

test('exports fallback PDFs as data URLs without calling createObjectURL', async () => {
  const { result, downloadOptions } = await runExporter('?filename=flow.pdf');

  assert.equal(result.type, 'OUTPUT_DONE');
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
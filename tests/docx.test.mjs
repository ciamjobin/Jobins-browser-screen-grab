import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDocx } from '../flow-screenshot-extension/docx.js';
import { buildPdf } from '../flow-screenshot-extension/pdf.js';

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function zipEntries(bytes) {
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;

  while (readUint32(bytes, offset) === 0x04034b50) {
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const length = readUint32(bytes, offset + 22);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + length));
    offset = dataStart + length;
  }

  return entries;
}

test('builds a Word document with screenshot headings, bracketed notes, and embedded JPEGs', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
  const bytes = buildDocx([
    {
      title: 'Sign in',
      note: 'Use the shared account',
      url: 'https://example.test/login?team=QA',
      time: '2026-09-13 10:00 UTC',
      width: 1920,
      height: 1080,
      jpeg
    }
  ]);

  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const entries = zipEntries(bytes);
  assert.ok(entries.has('[Content_Types].xml'));
  assert.ok(entries.has('_rels/.rels'));
  assert.ok(entries.has('docProps/core.xml'));
  assert.ok(entries.has('docProps/app.xml'));
  assert.ok(entries.has('word/document.xml'));
  assert.ok(entries.has('word/footer1.xml'));
  assert.ok(entries.has('word/styles.xml'));
  assert.ok(entries.has('word/settings.xml'));
  assert.ok(entries.has('word/_rels/document.xml.rels'));
  assert.deepEqual(entries.get('word/media/image1.jpg'), jpeg);

  const documentXml = new TextDecoder().decode(entries.get('word/document.xml'));
  assert.match(documentXml, /Sign in \[Use the shared account\]/);
  assert.match(documentXml, /https:\/\/example\.test\/login\?team=QA/);
  assert.match(documentXml, /r:embed="rId3"/);
  assert.match(documentXml, /w:footerReference w:type="default" r:id="rId99"/);
  assert.match(documentXml, /Time of action: 2026-09-13 10:00 UTC/);
  assert.match(documentXml, /w:spacing w:after="20"/);
  const relationships = new TextDecoder().decode(entries.get('word/_rels/document.xml.rels'));
  assert.match(relationships, /styles\.xml/);
  assert.match(relationships, /settings\.xml/);
  assert.match(relationships, /rId99.*footer1\.xml/);
  assert.match(new TextDecoder().decode(entries.get('word/footer1.xml')), /Captured by Jobin&apos;s Screenshots/);
  assert.match(new TextDecoder().decode(entries.get('docProps/core.xml')), /JShotz evidence/);
});

test('removes characters that are illegal in Office Open XML text', () => {
  const bytes = buildDocx([{
    title: 'Page\u0000 title\ufffe',
    note: 'A\u0007 note\uffff',
    url: 'https://example.test/\u0001path',
    time: '2026-09-14\u0008',
    width: 1,
    height: 1,
    jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
  }]);
  const documentXml = new TextDecoder().decode(zipEntries(bytes).get('word/document.xml'));

  assert.doesNotMatch(documentXml, /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u);
  assert.match(documentXml, /Page title \[A note\]/);
});

test('renders screenshot notes in PDF headings', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = buildPdf([{
    title: 'Sign in',
    note: 'Use the shared account',
    url: 'https://example.test/login',
    time: '2026-09-13 10:00 UTC',
    width: 1,
    height: 1,
    jpeg,
    apiRows: []
  }]);

  const pdfText = Buffer.from(pdf).toString('latin1');
  assert.match(pdfText, /Sign in \[Use the shared account\]/);
  assert.match(pdfText, /Captured by Jobin's Screenshots/);
});

test('places a widescreen screenshot directly below its time metadata in PDF output', () => {
  const pdf = buildPdf([{
    title: 'Lookup',
    url: 'https://example.test/lookup',
    time: '2026-09-15 10:00 UTC',
    width: 1920,
    height: 1080,
    jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    apiRows: []
  }]);

  assert.match(
    Buffer.from(pdf).toString('latin1'),
    /q 736\.00 0 0 414\.00 28\.00 93\.00 cm \/Im0 Do Q/
  );
});

test('places a responsive capture part at a readable width in PDF output', () => {
  const pdf = buildPdf([{
    title: 'Unlock your account (part 1 of 3)',
    url: 'https://example.test/account-unlock',
    time: '2026-09-17 10:00 UTC',
    width: 329,
    height: 300,
    jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    apiRows: []
  }]);

  assert.match(
    Buffer.from(pdf).toString('latin1'),
    /q 525\.30 0 0 479\.00 133\.35 28\.00 cm \/Im0 Do Q/
  );
});
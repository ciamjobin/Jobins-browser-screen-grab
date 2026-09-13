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
  assert.ok(entries.has('word/document.xml'));
  assert.ok(entries.has('word/_rels/document.xml.rels'));
  assert.deepEqual(entries.get('word/media/image1.jpg'), jpeg);

  const documentXml = new TextDecoder().decode(entries.get('word/document.xml'));
  assert.match(documentXml, /Sign in \[Use the shared account\]/);
  assert.match(documentXml, /https:\/\/example\.test\/login\?team=QA/);
  assert.match(documentXml, /r:embed="rId1"/);
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

  assert.match(Buffer.from(pdf).toString('latin1'), /Sign in \[Use the shared account\]/);
});
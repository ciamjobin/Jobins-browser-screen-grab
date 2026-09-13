const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMU_PER_PIXEL = 9525;
const MAX_IMAGE_WIDTH = 6.7 * 914400;
const MAX_IMAGE_HEIGHT = 6.4 * 914400;

function bytesFor(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function concat(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function writeUint16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function zip(entries) {
  const timestamp = dosDateTime();
  const prepared = entries.map(([name, value]) => {
    const nameBytes = encoder.encode(name);
    const contents = bytesFor(value) || encoder.encode(String(value));
    return { nameBytes, contents, crc: crc32(contents), offset: 0 };
  });
  const localFiles = [];
  let offset = 0;

  for (const entry of prepared) {
    entry.offset = offset;
    const header = new Uint8Array(30 + entry.nameBytes.length);
    writeUint32(header, 0, 0x04034b50);
    writeUint16(header, 4, 20);
    writeUint16(header, 6, 0x0800);
    writeUint16(header, 8, 0);
    writeUint16(header, 10, timestamp.time);
    writeUint16(header, 12, timestamp.date);
    writeUint32(header, 14, entry.crc);
    writeUint32(header, 18, entry.contents.length);
    writeUint32(header, 22, entry.contents.length);
    writeUint16(header, 26, entry.nameBytes.length);
    writeUint16(header, 28, 0);
    header.set(entry.nameBytes, 30);
    localFiles.push(header, entry.contents);
    offset += header.length + entry.contents.length;
  }

  const centralDirectoryOffset = offset;
  const centralFiles = [];
  for (const entry of prepared) {
    const header = new Uint8Array(46 + entry.nameBytes.length);
    writeUint32(header, 0, 0x02014b50);
    writeUint16(header, 4, 20);
    writeUint16(header, 6, 20);
    writeUint16(header, 8, 0x0800);
    writeUint16(header, 10, 0);
    writeUint16(header, 12, timestamp.time);
    writeUint16(header, 14, timestamp.date);
    writeUint32(header, 16, entry.crc);
    writeUint32(header, 20, entry.contents.length);
    writeUint32(header, 24, entry.contents.length);
    writeUint16(header, 28, entry.nameBytes.length);
    writeUint16(header, 30, 0);
    writeUint16(header, 32, 0);
    writeUint16(header, 34, 0);
    writeUint16(header, 36, 0);
    writeUint32(header, 38, 0);
    writeUint32(header, 42, entry.offset);
    header.set(entry.nameBytes, 46);
    centralFiles.push(header);
    offset += header.length;
  }

  const end = new Uint8Array(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 4, 0);
  writeUint16(end, 6, 0);
  writeUint16(end, 8, prepared.length);
  writeUint16(end, 10, prepared.length);
  writeUint32(end, 12, offset - centralDirectoryOffset);
  writeUint32(end, 16, centralDirectoryOffset);
  writeUint16(end, 20, 0);
  return concat([...localFiles, ...centralFiles, end]);
}

function xml(value, maxLength = 4000) {
  return String(value ?? '')
    .slice(0, maxLength)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function heading(page) {
  const title = String(page.title || 'Untitled page').trim() || 'Untitled page';
  const note = String(page.note || '').trim().slice(0, 50);
  return note ? `${title} [${note}]` : title;
}

function textParagraph(value, { bold = false, size = 20 } = {}) {
  const text = xml(value);
  const properties = `${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/>`;
  return `<w:p><w:pPr><w:spacing w:after="100"/></w:pPr><w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function imageSize(width, height) {
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, MAX_IMAGE_WIDTH / (sourceWidth * EMU_PER_PIXEL), MAX_IMAGE_HEIGHT / (sourceHeight * EMU_PER_PIXEL));
  return {
    width: Math.max(1, Math.round(sourceWidth * EMU_PER_PIXEL * scale)),
    height: Math.max(1, Math.round(sourceHeight * EMU_PER_PIXEL * scale))
  };
}

function imageParagraph(page, image) {
  const size = imageSize(page.width, page.height);
  const description = xml(heading(page), 255);
  return [
    '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:drawing>',
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${size.width}" cy="${size.height}"/>`,
    `<wp:docPr id="${image.id}" name="Screenshot ${image.id}" descr="${description}"/>`,
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:nvPicPr>',
    `<pic:cNvPr id="${image.id}" name="Screenshot ${image.id}"/>`,
    '<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>',
    `<a:blip r:embed="rId${image.relationshipId}"/><a:stretch><a:fillRect/></a:stretch>`,
    '</pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/>',
    `<a:ext cx="${size.width}" cy="${size.height}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>',
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  ].join('');
}

function apiParagraphs(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const paragraphs = [textParagraph('API calls in this step', { bold: true, size: 18 })];
  for (const row of rows) {
    paragraphs.push(textParagraph(row?.name || 'API call', { bold: true, size: 18 }));
    paragraphs.push(textParagraph(`Origin: ${row?.origin || '(unknown)'}`, { size: 16 }));
    paragraphs.push(textParagraph(`Payload: ${row?.payload || '(none)'}`, { size: 16 }));
    paragraphs.push(textParagraph(`Response: ${row?.response || '(empty)'}`, { size: 16 }));
  }
  return paragraphs.join('');
}

function documentXml(pages) {
  const sections = pages.map(({ page, image }, index) => {
    const content = [
      textParagraph(heading(page), { bold: true, size: 30 }),
      textParagraph(`URL: ${page.url || '(URL not recorded)'}`, { size: 18 }),
      textParagraph(`Time of action: ${page.time || '(time not recorded)'}`, { size: 18 }),
      image ? imageParagraph(page, image) : '',
      apiParagraphs(page.apiRows),
      index < pages.length - 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''
    ];
    return content.join('');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<w:body>',
    sections.join(''),
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>',
    '</w:body></w:document>'
  ].join('');
}

function contentTypes() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="jpg" ContentType="image/jpeg"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>'
  ].join('');
}

function rootRelationships() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>'
  ].join('');
}

function documentRelationships(images) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...images.map((image) =>
      `<Relationship Id="rId${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${image.id}.jpg"/>`
    ),
    '</Relationships>'
  ].join('');
}

export function buildDocx(pages) {
  const records = Array.isArray(pages) ? pages : [];
  const images = [];
  const documentPages = records.map((page) => {
    const jpeg = bytesFor(page?.jpeg);
    const image = jpeg?.length
      ? { id: images.length + 1, relationshipId: images.length + 1, jpeg }
      : null;
    if (image) images.push(image);
    return { page: page || {}, image };
  });

  const entries = [
    ['[Content_Types].xml', contentTypes()],
    ['_rels/.rels', rootRelationships()],
    ['word/document.xml', documentXml(documentPages)],
    ['word/_rels/document.xml.rels', documentRelationships(images)]
  ];
  for (const image of images) entries.push([`word/media/image${image.id}.jpg`, image.jpeg]);
  return zip(entries);
}

export function docxText(bytes) {
  return decoder.decode(bytesFor(bytes) || new Uint8Array());
}
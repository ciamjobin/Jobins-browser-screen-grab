const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMU_PER_PIXEL = 9525;
const MAX_IMAGE_WIDTH = 10466 * 635;
const MAX_IMAGE_HEIGHT = 9.65 * 914400;

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
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
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

function textParagraph(value, { bold = false, size = 20, after = 100 } = {}) {
  const text = xml(value);
  const properties = `${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/>`;
  const spacingAfter = Math.max(0, Math.round(Number(after) || 0));
  return `<w:p><w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr><w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
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
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
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
      textParagraph(`Time of action: ${page.time || '(time not recorded)'}`, { size: 18, after: 20 }),
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
    '<w:sectPr><w:footerReference w:type="default" r:id="rId99"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:footer="360"/></w:sectPr>',
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
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '</Types>'
  ].join('');
}

function rootRelationships() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    '</Relationships>'
  ].join('');
}

function documentRelationships(images) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
    '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    ...images.map((image) =>
      `<Relationship Id="rId${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${image.id}.jpg"/>`
    ),
    '</Relationships>'
  ].join('');
}

function footerXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="6B7280"/><w:sz w:val="16"/></w:rPr>',
    '<w:t>Captured by Jobin&apos;s Screenshots</w:t></w:r></w:p></w:ftr>'
  ].join('');
}

function stylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>',
    '<w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
    '</w:styles>'
  ].join('');
}

function settingsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:zoom w:percent="100"/><w:proofState w:spelling="clean" w:grammar="clean"/>',
    '<w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" ',
    'w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>',
    '</w:settings>'
  ].join('');
}

function documentTitle(pages) {
  const firstTitle = String(pages[0]?.title || '').trim();
  return firstTitle ? `JShotz evidence - ${firstTitle}` : 'JShotz evidence';
}

function coreProperties(pages) {
  const created = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ',
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ',
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${xml(documentTitle(pages), 255)}</dc:title><dc:creator>JShotz</dc:creator>`,
    '<cp:lastModifiedBy>JShotz</cp:lastModifiedBy>',
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>`,
    '</cp:coreProperties>'
  ].join('');
}

function appProperties() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ',
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>JShotz</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>',
    '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>',
    '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>3.14</AppVersion>',
    '</Properties>'
  ].join('');
}

export function buildDocx(pages) {
  const records = Array.isArray(pages) ? pages : [];
  const images = [];
  const documentPages = records.map((page) => {
    const jpeg = bytesFor(page?.jpeg);
    const image = jpeg?.length
      ? { id: images.length + 1, relationshipId: images.length + 3, jpeg }
      : null;
    if (image) images.push(image);
    return { page: page || {}, image };
  });

  const entries = [
    ['[Content_Types].xml', contentTypes()],
    ['_rels/.rels', rootRelationships()],
    ['docProps/core.xml', coreProperties(documentPages.map(({ page }) => page))],
    ['docProps/app.xml', appProperties()],
    ['word/document.xml', documentXml(documentPages)],
    ['word/footer1.xml', footerXml()],
    ['word/styles.xml', stylesXml()],
    ['word/settings.xml', settingsXml()],
    ['word/_rels/document.xml.rels', documentRelationships(images)]
  ];
  for (const image of images) entries.push([`word/media/image${image.id}.jpg`, image.jpeg]);
  return zip(entries);
}

export function docxText(bytes) {
  return decoder.decode(bytesFor(bytes) || new Uint8Array());
}
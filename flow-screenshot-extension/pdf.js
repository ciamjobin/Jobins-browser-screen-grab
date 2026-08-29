// Minimal PDF writer: one page per screenshot, each with a title heading and an embedded JPEG.

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 28;
const TITLE_SIZE = 14;
const META_SIZE = 9;

function encodeLatin1(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pdfText(value, maxLength) {
  const ascii = String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, maxLength);
  return `(${ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

function layoutImage(width, height, top, bottom) {
  const availableWidth = PAGE_WIDTH - MARGIN * 2;
  const availableHeight = top - bottom;
  const scale = Math.min(availableWidth / width, availableHeight / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  return {
    width: drawWidth.toFixed(2),
    height: drawHeight.toFixed(2),
    x: (MARGIN + (availableWidth - drawWidth) / 2).toFixed(2),
    y: (bottom + (availableHeight - drawHeight) / 2).toFixed(2)
  };
}

const API_FONT = 7.5;
const API_LINE = 9.5;
const API_MAX_LINES = 5;
const API_MAX_ROWS = 4;
const API_COLUMNS = [
  { title: 'API Name', key: 'name', ratio: 0.24 },
  { title: 'Payload', key: 'payload', ratio: 0.36 },
  { title: 'Response', key: 'response', ratio: 0.4 }
];

// Helvetica averages about half the point size per glyph; good enough to wrap into fixed columns.
function wrapToWidth(text, width) {
  const perLine = Math.max(8, Math.floor(width / (API_FONT * 0.5)));
  const lines = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw) {
      lines.push('');
      continue;
    }
    for (let i = 0; i < raw.length; i += perLine) lines.push(raw.slice(i, i + perLine));
  }
  return lines.length ? lines : [''];
}

function layoutApiTable(rows) {
  const usable = PAGE_WIDTH - MARGIN * 2;
  let x = MARGIN;
  const columns = API_COLUMNS.map((column) => {
    const laid = { ...column, x, width: usable * column.ratio };
    x += laid.width;
    return laid;
  });

  const visible = rows.slice(0, API_MAX_ROWS);
  const laidRows = visible.map((row) => {
    const cells = columns.map((column) => {
      const lines = wrapToWidth(row[column.key], column.width - 8);
      return lines.length > API_MAX_LINES ? [...lines.slice(0, API_MAX_LINES - 1), '...'] : lines;
    });
    return { cells, lineCount: Math.max(...cells.map((lines) => lines.length)) };
  });

  const overflow = rows.length - visible.length;
  const height =
    16 + 12 + laidRows.reduce((total, row) => total + row.lineCount * API_LINE + 5, 0) + (overflow ? 11 : 0);

  return { columns, rows: laidRows, overflow, height };
}

function apiTableOps(table, bottom) {
  const ops = [];
  let y = bottom + table.height - 10;

  ops.push(`BT /F1 9 Tf 0 0 0 rg 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm ${pdfText('API calls in this step', 40)} Tj ET`);
  y -= 13;

  for (const column of table.columns) {
    ops.push(
      `BT /F1 ${API_FONT} Tf 1 0 0 1 ${column.x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfText(column.title, 20)} Tj ET`
    );
  }
  const rule = (y - 3).toFixed(2);
  ops.push(`0.4 w ${MARGIN} ${rule} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${rule} l S`);
  y -= 11;

  for (const row of table.rows) {
    row.cells.forEach((lines, index) => {
      const column = table.columns[index];
      lines.forEach((line, lineIndex) => {
        ops.push(
          `BT /F2 ${API_FONT} Tf 0.15 0.2 0.3 rg 1 0 0 1 ${column.x.toFixed(2)} ` +
            `${(y - lineIndex * API_LINE).toFixed(2)} Tm ${pdfText(line, 400)} Tj ET`
        );
      });
    });
    y -= row.lineCount * API_LINE + 5;
  }

  if (table.overflow) {
    ops.push(
      `BT /F2 ${API_FONT} Tf 0.4 0.4 0.4 rg 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm ` +
        `${pdfText(`+ ${table.overflow} more call(s) in this step`, 60)} Tj ET`
    );
  }

  ops.push('0 0 0 rg');
  return ops.join('\n');
}

const URL_HEADING = 'URL of the page';
const TIME_HEADING = 'Time of action';

// Helvetica metrics are unavailable here, so approximate the rule width from the glyph count.
function underline(text, y) {
  const width = text.length * META_SIZE * 0.55;
  return `0.5 w ${MARGIN} ${y.toFixed(2)} m ${(MARGIN + width).toFixed(2)} ${y.toFixed(2)} l S`;
}

function contentStream(page) {
  const titleY = PAGE_HEIGHT - MARGIN - TITLE_SIZE;
  const urlHeadingY = titleY - 18;
  const urlY = urlHeadingY - 11;
  const timeHeadingY = urlY - 15;
  const timeY = timeHeadingY - 11;

  const table = page.apiRows?.length ? layoutApiTable(page.apiRows) : null;
  const imageBottom = MARGIN + (table ? table.height + 10 : 0);
  const box = layoutImage(page.width, page.height, timeY - 12, imageBottom);

  return [
    `BT /F1 ${TITLE_SIZE} Tf 1 0 0 1 ${MARGIN} ${titleY} Tm ${pdfText(page.title || 'Untitled page', 95)} Tj ET`,

    `BT /F1 ${META_SIZE} Tf 1 0 0 1 ${MARGIN} ${urlHeadingY} Tm ${pdfText(URL_HEADING, 40)} Tj ET`,
    underline(URL_HEADING, urlHeadingY - 2.5),
    `BT /F2 ${META_SIZE} Tf 0.1 0.25 0.6 rg 1 0 0 1 ${MARGIN} ${urlY} Tm ${pdfText(page.url || '(URL not recorded)', 155)} Tj ET`,

    `0 0 0 rg`,
    `BT /F1 ${META_SIZE} Tf 1 0 0 1 ${MARGIN} ${timeHeadingY} Tm ${pdfText(TIME_HEADING, 40)} Tj ET`,
    underline(TIME_HEADING, timeHeadingY - 2.5),
    `BT /F2 ${META_SIZE} Tf 0.25 0.25 0.25 rg 1 0 0 1 ${MARGIN} ${timeY} Tm ${pdfText(page.time || '(time not recorded)', 155)} Tj ET`,

    '0 0 0 rg',
    `q ${box.width} 0 0 ${box.height} ${box.x} ${box.y} cm /Im0 Do Q`,
    table ? apiTableOps(table, MARGIN) : ''
  ].join('\n');
}

/**
 * @param {Array<{title: string, url: string, time: string, jpeg: Uint8Array, width: number, height: number}>} pages
 * @returns {Uint8Array} the complete PDF document
 */
export function buildPdf(pages) {
  const pageObj = (index) => 5 + index * 3;
  const contentObj = (index) => pageObj(index) + 1;
  const imageObj = (index) => pageObj(index) + 2;

  const objects = [
    encodeLatin1('<< /Type /Catalog /Pages 2 0 R >>'),
    encodeLatin1(
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`
    ),
    encodeLatin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    encodeLatin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  ];

  pages.forEach((page, index) => {
    const stream = encodeLatin1(contentStream(page));

    objects.push(
      encodeLatin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /XObject << /Im0 ${imageObj(index)} 0 R >> /Font << /F1 3 0 R /F2 4 0 R >> >> ` +
          `/Contents ${contentObj(index)} 0 R >>`
      )
    );

    objects.push(
      concat([
        encodeLatin1(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        encodeLatin1('\nendstream')
      ])
    );

    objects.push(
      concat([
        encodeLatin1(
          `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
        ),
        page.jpeg,
        encodeLatin1('\nendstream')
      ])
    );
  });

  const chunks = [encodeLatin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = chunks[0].length;
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(offset);
    const parts = [encodeLatin1(`${index + 1} 0 obj\n`), body, encodeLatin1('\nendobj\n')];
    for (const part of parts) {
      chunks.push(part);
      offset += part.length;
    }
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) {
    xref += `${String(entry).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(encodeLatin1(xref));

  return concat(chunks);
}

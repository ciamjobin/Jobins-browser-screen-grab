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
const API_GUTTER = 12;
const API_ROW_GAP = 5;
const API_HEADER_HEIGHT = 34;
const API_MIN_SPLIT_LINES = 4;
// Cap the table on the screenshot page so the image keeps a usable share; the rest spills over.
const API_FIRST_PAGE_HEIGHT = PAGE_HEIGHT * 0.4;
const API_COLUMNS = [
  { title: 'API Name', key: 'name', ratio: 0.2 },
  { title: 'Origin / Source', key: 'origin', ratio: 0.22 },
  { title: 'Payload', key: 'payload', ratio: 0.28 },
  { title: 'Response', key: 'response', ratio: 0.3 }
];

function apiColumns() {
  const usable = PAGE_WIDTH - MARGIN * 2;
  let x = MARGIN;
  return API_COLUMNS.map((column) => {
    const width = usable * column.ratio;
    const laid = { ...column, x, width, textWidth: width - API_GUTTER };
    x += width;
    return laid;
  });
}

// Helvetica alphanumerics run about 0.6 em wide; erring high keeps dense payloads inside their column.
function wrapToWidth(text, width) {
  const perLine = Math.max(8, Math.floor(width / (API_FONT * 0.6)));
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

function wrapApiRows(rows, columns) {
  return rows.map((row) => {
    const cells = columns.map((column) => wrapToWidth(row[column.key], column.textWidth));
    return { cells, lineCount: Math.max(...cells.map((lines) => lines.length)) };
  });
}

/** Fills one page with as many wrapped rows as fit, splitting a tall row across pages rather than dropping it. */
function takeApiRows(wrapped, maxHeight) {
  const taken = [];
  let used = API_HEADER_HEIGHT;
  let index = 0;

  while (index < wrapped.length) {
    const row = wrapped[index];
    const rowHeight = row.lineCount * API_LINE + API_ROW_GAP;
    if (used + rowHeight <= maxHeight) {
      taken.push(row);
      used += rowHeight;
      index += 1;
      continue;
    }

    const availableLines = Math.floor((maxHeight - used - API_ROW_GAP) / API_LINE);
    if (availableLines >= API_MIN_SPLIT_LINES) {
      taken.push({ cells: row.cells.map((lines) => lines.slice(0, availableLines)), lineCount: availableLines });
      used += availableLines * API_LINE + API_ROW_GAP;
      const rest = {
        cells: row.cells.map((lines) => lines.slice(availableLines)),
        lineCount: row.lineCount - availableLines
      };
      return { taken, remaining: [rest, ...wrapped.slice(index + 1)], height: used };
    }
    break;
  }

  return { taken, remaining: wrapped.slice(index), height: used };
}

function apiTableOps(table, bottom, heading) {
  const ops = [];
  const right = PAGE_WIDTH - MARGIN;
  const cellPad = 3;
  let y = bottom + table.height - 10;

  ops.push(`BT /F1 9 Tf 0 0 0 rg 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm ${pdfText(heading, 60)} Tj ET`);
  y -= 8;

  const gridTop = y;
  const headerBaseline = y - API_LINE + 2.5;
  for (const column of table.columns) {
    ops.push(
      `BT /F1 ${API_FONT} Tf 1 0 0 1 ${(column.x + cellPad).toFixed(2)} ${headerBaseline.toFixed(2)} Tm ` +
        `${pdfText(column.title, 24)} Tj ET`
    );
  }
  y -= API_LINE + 3;

  const rules = [y];
  for (const row of table.rows) {
    row.cells.forEach((lines, index) => {
      const column = table.columns[index];
      lines.forEach((line, lineIndex) => {
        const baseline = y - (lineIndex + 1) * API_LINE + 2.5;
        ops.push(
          `BT /F2 ${API_FONT} Tf 0.15 0.2 0.3 rg 1 0 0 1 ${(column.x + cellPad).toFixed(2)} ` +
            `${baseline.toFixed(2)} Tm ${pdfText(line, 400)} Tj ET`
        );
      });
    });
    y -= row.lineCount * API_LINE + API_ROW_GAP;
    rules.push(y);
  }

  ops.push('0.55 0.6 0.65 RG 0.4 w');
  ops.push(`${MARGIN} ${gridTop.toFixed(2)} m ${right.toFixed(2)} ${gridTop.toFixed(2)} l S`);
  for (const rule of rules) {
    ops.push(`${MARGIN} ${rule.toFixed(2)} m ${right.toFixed(2)} ${rule.toFixed(2)} l S`);
  }
  for (const column of table.columns) {
    ops.push(`${column.x.toFixed(2)} ${gridTop.toFixed(2)} m ${column.x.toFixed(2)} ${y.toFixed(2)} l S`);
  }
  ops.push(`${right.toFixed(2)} ${gridTop.toFixed(2)} m ${right.toFixed(2)} ${y.toFixed(2)} l S`);

  ops.push('0 0 0 RG 0 0 0 rg');
  return ops.join('\n');
}

const URL_HEADING = 'URL of the page';
const TIME_HEADING = 'Time of action';

// Helvetica metrics are unavailable here, so approximate the rule width from the glyph count.
function underline(text, y) {
  const width = text.length * META_SIZE * 0.55;
  return `0.5 w ${MARGIN} ${y.toFixed(2)} m ${(MARGIN + width).toFixed(2)} ${y.toFixed(2)} l S`;
}

function contentStream(page, table, drawImage) {
  const titleY = PAGE_HEIGHT - MARGIN - TITLE_SIZE;

  if (!drawImage) {
    const title = `${page.title || 'Untitled page'} | API calls (continued)`;
    return [
      `BT /F1 ${TITLE_SIZE} Tf 0 0 0 rg 1 0 0 1 ${MARGIN} ${titleY} Tm ${pdfText(title, 110)} Tj ET`,
      table ? apiTableOps(table, titleY - 10 - table.height, 'API calls (continued)') : ''
    ].join('\n');
  }

  const urlHeadingY = titleY - 18;
  const urlY = urlHeadingY - 11;
  const timeHeadingY = urlY - 15;
  const timeY = timeHeadingY - 11;

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
    table ? apiTableOps(table, MARGIN, 'API calls in this step') : ''
  ].join('\n');
}

/**
 * @param {Array<{title: string, url: string, time: string, jpeg: Uint8Array, width: number, height: number}>} pages
 * @returns {Uint8Array} the complete PDF document
 */
export function buildPdf(pages) {
  const columns = apiColumns();
  // Continuation sheets run from just under the title down to the bottom margin.
  const contPageHeight = PAGE_HEIGHT - MARGIN * 2 - TITLE_SIZE - 10;

  // Every screenshot yields one sheet plus however many continuation sheets its API rows need.
  const sheets = [];
  const imageNums = [];
  let next = 5;

  pages.forEach(() => imageNums.push(next++));

  pages.forEach((page, index) => {
    let remaining = page.apiRows?.length ? wrapApiRows(page.apiRows, columns) : [];
    let drawImage = true;

    do {
      const budget = drawImage ? API_FIRST_PAGE_HEIGHT : contPageHeight;
      const slice = remaining.length ? takeApiRows(remaining, budget) : { taken: [], remaining: [], height: 0 };
      const table = slice.taken.length ? { columns, rows: slice.taken, height: slice.height } : null;

      sheets.push({
        page,
        table,
        drawImage,
        imageNum: imageNums[index],
        pageNum: next++,
        contentNum: next++
      });

      // A continuation sheet that fits nothing would loop forever; drop the leftovers instead.
      remaining = table || drawImage ? slice.remaining : [];
      drawImage = false;
    } while (remaining.length);
  });

  const objects = new Array(next - 1);
  objects[0] = encodeLatin1('<< /Type /Catalog /Pages 2 0 R >>');
  objects[1] = encodeLatin1(
    `<< /Type /Pages /Kids [${sheets.map((sheet) => `${sheet.pageNum} 0 R`).join(' ')}] /Count ${sheets.length} >>`
  );
  objects[2] = encodeLatin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects[3] = encodeLatin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((page, index) => {
    objects[imageNums[index] - 1] = concat([
      encodeLatin1(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
      ),
      page.jpeg,
      encodeLatin1('\nendstream')
    ]);
  });

  for (const sheet of sheets) {
    const stream = encodeLatin1(contentStream(sheet.page, sheet.table, sheet.drawImage));
    const xobject = sheet.drawImage ? `/XObject << /Im0 ${sheet.imageNum} 0 R >> ` : '';

    objects[sheet.pageNum - 1] = encodeLatin1(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << ${xobject}/Font << /F1 3 0 R /F2 4 0 R >> >> ` +
        `/Contents ${sheet.contentNum} 0 R >>`
    );

    objects[sheet.contentNum - 1] = concat([
      encodeLatin1(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      encodeLatin1('\nendstream')
    ]);
  }

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

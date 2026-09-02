// Pure canvas work, shared by the Chromium offscreen document and the Firefox background page.
// Must not touch any extension API so both hosts can load it.

function drawTimestampBanner(canvas, text, offsetY = 0) {
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(13, Math.round(canvas.width / 95));
  const padX = Math.round(fontSize * 0.7);
  const padY = Math.round(fontSize * 0.45);

  ctx.font = `600 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = 'top';

  const textWidth = ctx.measureText(text).width;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = fontSize + padY * 2;
  const x = Math.round(fontSize * 0.6);
  const y = offsetY + Math.round(fontSize * 0.6);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, boxWidth - 1, boxHeight - 1);

  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + padX, y + padY);
}

function drawCapturedTitleBar(canvas, title, url) {
  const ctx = canvas.getContext('2d');
  const height = titleBarHeight(canvas.width);
  const pad = Math.max(14, Math.round(canvas.width / 95));
  const titleSize = Math.max(14, Math.round(canvas.width / 95));
  const urlSize = Math.max(10, Math.round(canvas.width / 135));

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvas.width, height);
  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(0, height - 1, canvas.width, 1);
  ctx.fillStyle = '#8b0000';
  ctx.fillRect(0, 0, canvas.width, 4);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = `700 ${titleSize}px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = '#111827';
  ctx.fillText(clipText(ctx, title || 'Untitled page', canvas.width - pad * 2), pad, 10);

  ctx.font = `${urlSize}px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = '#4b5563';
  ctx.fillText(clipText(ctx, url || '', canvas.width - pad * 2), pad, 12 + titleSize + 4);
}

function titleBarHeight(width) {
  return Math.max(48, Math.round(width / 24));
}

function clipText(ctx, text, maxWidth) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (ctx.measureText(value).width <= maxWidth) return value;

  let clipped = value;
  while (clipped.length > 1 && ctx.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}...`;
}

function drawWatermark(canvas, text) {
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(12, Math.round(canvas.width / 110));
  const marginX = Math.round(fontSize * 1.2);
  const marginY = Math.max(1, Math.round(fontSize * 0.12));

  ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';

  // White halo first so the dark red stays readable on dark backgrounds.
  ctx.lineWidth = Math.max(2, fontSize / 4);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.strokeText(text, canvas.width - marginX, canvas.height - marginY);
  ctx.fillStyle = '#8b0000';
  ctx.fillText(text, canvas.width - marginX, canvas.height - marginY);

  ctx.textAlign = 'left';
}

const TABLE_FONT = 14;
const TABLE_LINE = 19;
const TABLE_PAD = 10;
const TABLE_TITLE_HEIGHT = 34;
const TABLE_HEADER_HEIGHT = 30;

const TABLE_COLUMNS = [
  { title: 'API Name', key: 'name', ratio: 0.2 },
  { title: 'Origin and Referer', key: 'origin', ratio: 0.22 },
  { title: 'Payload', key: 'payload', ratio: 0.28 },
  { title: 'Response', key: 'response', ratio: 0.3 }
];

function layoutApiTable(rows, width) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${TABLE_FONT}px Consolas, "Courier New", monospace`;

  let x = TABLE_PAD;
  const columns = TABLE_COLUMNS.map((column) => {
    const columnWidth = (width - TABLE_PAD * 2) * column.ratio;
    const laid = { ...column, x, width: columnWidth };
    x += columnWidth;
    return laid;
  });

  const laidRows = rows.map((row) => {
    const cells = columns.map((column) => wrapLines(ctx, row[column.key], column.width - TABLE_PAD * 2));
    const lineCount = Math.max(...cells.map((lines) => lines.length));
    return { cells, outcome: row.outcome, height: lineCount * TABLE_LINE + TABLE_PAD * 2 };
  });

  const height =
    TABLE_TITLE_HEIGHT +
    TABLE_HEADER_HEIGHT +
    laidRows.reduce((total, row) => total + row.height, 0) +
    TABLE_PAD * 2;

  return { columns, rows: laidRows, height };
}

function drawApiTable(ctx, table, top, width) {
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.fillStyle = '#f5f7fa';
  ctx.fillRect(0, top, width, table.height);
  ctx.strokeStyle = '#cbd2d9';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, top + 0.5);
  ctx.lineTo(width, top + 0.5);
  ctx.stroke();

  ctx.fillStyle = '#1f2933';
  ctx.font = '700 16px "Segoe UI", Arial, sans-serif';
  ctx.fillText('API calls in this step', TABLE_PAD, top + TABLE_PAD);

  let y = top + TABLE_TITLE_HEIGHT;

  ctx.fillStyle = '#e4e7eb';
  ctx.fillRect(0, y, width, TABLE_HEADER_HEIGHT);
  ctx.fillStyle = '#243b53';
  ctx.font = '700 14px "Segoe UI", Arial, sans-serif';
  for (const column of table.columns) {
    ctx.fillText(column.title, column.x + TABLE_PAD, y + 7);
  }
  y += TABLE_HEADER_HEIGHT;

  ctx.font = `${TABLE_FONT}px Consolas, "Courier New", monospace`;
  const bodyTop = y;
  for (const row of table.rows) {
    if (row.outcome !== 'success') {
      ctx.fillStyle = '#fff59d';
      for (const index of [0, 3]) {
        const column = table.columns[index];
        ctx.fillRect(column.x, y, column.width, row.height);
      }
    }

    ctx.strokeStyle = '#cbd2d9';
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();

    // A red rail marks failed calls without needing an extra column.
    ctx.fillStyle = row.outcome === 'success' ? '#2e7d32' : '#c62828';
    ctx.fillRect(0, y, 4, row.height);

    row.cells.forEach((lines, index) => {
      const column = table.columns[index];
      ctx.fillStyle = index === 0 ? '#1f2933' : '#243b53';
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, column.x + TABLE_PAD, y + TABLE_PAD + lineIndex * TABLE_LINE);
      });
    });

    y += row.height;
  }

  ctx.strokeStyle = '#cbd2d9';
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(width, y + 0.5);
  for (const column of table.columns) {
    ctx.moveTo(Math.round(column.x) + 0.5, bodyTop - TABLE_HEADER_HEIGHT);
    ctx.lineTo(Math.round(column.x) + 0.5, y);
  }
  ctx.stroke();
}

async function processCapture({ dataUrl, stampText, watermarkText, wantPng, wantJpeg, apiRows, titleBar }) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const titleHeight = titleBar ? titleBarHeight(bitmap.width) : 0;

  const table = apiRows?.length ? layoutApiTable(apiRows, bitmap.width) : null;
  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = bitmap.width;
  imageCanvas.height = bitmap.height + titleHeight;

  const imageCtx = imageCanvas.getContext('2d');
  imageCtx.fillStyle = '#ffffff';
  imageCtx.fillRect(0, 0, imageCanvas.width, imageCanvas.height);
  if (titleBar) drawCapturedTitleBar(imageCanvas, titleBar.title, titleBar.url);
  imageCtx.drawImage(bitmap, 0, titleHeight);
  bitmap.close();

  if (stampText) drawTimestampBanner(imageCanvas, stampText, titleHeight);
  if (watermarkText) drawWatermark(imageCanvas, watermarkText);

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = imageCanvas.width;
  outputCanvas.height = imageCanvas.height + (table?.height ?? 0);

  const ctx = outputCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
  ctx.drawImage(imageCanvas, 0, 0);
  if (table) drawApiTable(ctx, table, imageCanvas.height, outputCanvas.width);

  return {
    pngDataUrl: wantPng ? outputCanvas.toDataURL('image/png') : null,
    jpeg: wantJpeg
      ? {
          base64: imageCanvas.toDataURL('image/jpeg', 0.82).split(',')[1],
          width: imageCanvas.width,
          height: imageCanvas.height
        }
      : null
  };
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  const pushMeasured = (value) => {
    let current = '';
    for (const char of value) {
      const candidate = current + char;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    return current;
  };

  for (const rawLine of String(text ?? '').split('\n')) {
    if (!rawLine) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of rawLine.split(/(\s+)/)) {
      const candidate = current + word;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current.trimEnd());
        current = pushMeasured(word.trimStart());
      } else {
        current = ctx.measureText(word).width > maxWidth ? pushMeasured(candidate) : candidate;
      }
    }
    if (current || !lines.length) lines.push(current);
  }
  return lines;
}

const handlers = {
  OFFSCREEN_PING: () => ({ ok: true }),
  OFFSCREEN_PROCESS: (message) => processCapture(message)
};

export { processCapture, handlers };

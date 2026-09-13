import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'flow-screenshot-extension', 'manifest.json'), 'utf8')
);
const version = manifest.version;

function escapePdf(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7e]/g, '-');
}

function plainText(value) {
  return String(value)
    .replace(/!?(\[[^\]]+\])\([^)]+\)/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[\*`_]/g, '')
    .replace(/\|/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrap(value, maximum) {
  const words = plainText(value).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maximum) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function createGuidePdf(inputName, outputName, title) {
  const markdown = fs.readFileSync(path.join(root, inputName), 'utf8');
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const helvetica = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const helveticaBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const courier = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const pages = add('');
  const pageIds = [];
  let operations = [];
  let y = 794;

  const closePage = () => {
    if (!operations.length) return;
    const stream = operations.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
    const page = add('');
    pageIds.push(page);
    objects[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${helvetica} 0 R /F2 ${helveticaBold} 0 R /F3 ${courier} 0 R >> >> /Contents ${content} 0 R >>`;
    operations = [];
    y = 794;
  };

  const addText = (line, { size = 10, font = 'F1', color = '0.1 0.1 0.16', gap = 0 } = {}) => {
    const leading = Math.max(12, Math.round(size * 1.42)) + gap;
    if (y - leading < 46) closePage();
    operations.push(`BT /${font} ${size} Tf ${color} rg 1 0 0 1 46 ${y} Tm (${escapePdf(line)}) Tj ET`);
    y -= leading;
  };

  let code = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith('```')) {
      code = !code;
      y -= 5;
      continue;
    }
    if (!line.trim() || /^---+$/.test(line.trim())) {
      y -= 7;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const size = level === 1 ? 21 : level === 2 ? 15 : 12;
      y -= level === 1 ? 6 : 4;
      for (const text of wrap(heading[2], level === 1 ? 56 : 76)) {
        addText(text, { size, font: 'F2', color: level === 1 ? '0.38 0 0' : '0.45 0 0' });
      }
      y -= 3;
      continue;
    }

    const list = /^(\s*)(?:-|\d+\.)\s+(.*)$/.exec(line);
    const prefix = list ? `${' '.repeat(Math.min(6, list[1].length))}- ` : '';
    const text = list ? list[2] : line;
    const table = /^\|/.test(line.trim());
    const size = code || table ? 8 : 10;
    const font = code || table ? 'F3' : 'F1';
    const maximum = code || table ? 88 : 92;
    for (const wrapped of wrap(`${prefix}${text}`, maximum)) {
      addText(wrapped, { size, font, color: code || table ? '0.12 0.16 0.22' : '0.1 0.1 0.16' });
    }
  }
  closePage();

  objects[pages - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  const info = add(`<< /Title (${escapePdf(title)}) /Author (JShotz) >>`);
  let output = '%PDF-1.4\n%0000\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\n`;
  for (let index = 1; index <= objects.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, '0')} 00000 n\n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(root, outputName), output, 'ascii');
}

createGuidePdf(
  `JShotz-Quick-Guide-v${version}.md`,
  `JShotz-Quick-Guide-v${version}.pdf`,
  `JShotz Quick Guide ${version}`
);
createGuidePdf(
  `JShotz-User-Guide-v${version}.md`,
  `JShotz-User-Guide-v${version}.pdf`,
  `JShotz User Guide ${version}`
);
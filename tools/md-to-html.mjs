// Minimal, self-contained Markdown -> styled HTML converter (no dependencies) for generating
// printable PDFs from the JShotz guides via headless Chrome's --print-to-pdf.
import fs from 'node:fs';

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function convert(md) {
  const lines = md.split(/\r?\n/);
  let html = '';
  let i = 0;
  let inList = false;
  let inTable = false;
  let inCode = false;

  const closeList = () => {
    if (inList) {
      html += '</ul>\n';
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      html += '</table>\n';
      inTable = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (!inCode) {
        closeList();
        closeTable();
        html += '<pre><code>';
        inCode = true;
      } else {
        html += '</code></pre>\n';
        inCode = false;
      }
      i += 1;
      continue;
    }
    if (inCode) {
      html += escapeHtml(line) + '\n';
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      closeTable();
      html += '<hr/>\n';
      i += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      closeTable();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>\n`;
      i += 1;
      continue;
    }

    if (/^\|/.test(line.trim())) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const isSeparator = cells.every((c) => /^:?-+:?$/.test(c));
      if (isSeparator) {
        i += 1;
        continue;
      }
      if (!inTable) {
        closeList();
        html += '<table>\n';
        inTable = true;
        html += '<tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>\n';
      } else {
        html += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>\n';
      }
      i += 1;
      continue;
    }
    closeTable();

    const listItem = /^\d+\.\s+(.*)$|^-\s+(.*)$/.exec(line);
    if (listItem) {
      if (!inList) {
        html += '<ul>\n';
        inList = true;
      }
      html += `<li>${inline(listItem[1] || listItem[2])}</li>\n`;
      i += 1;
      continue;
    }
    closeList();

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    html += `<p>${inline(line)}</p>\n`;
    i += 1;
  }
  closeList();
  closeTable();
  return html;
}

const [, , inputPath, outputPath, title] = process.argv;
const md = fs.readFileSync(inputPath, 'utf8');
const body = convert(md);

const page = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  @page { margin: 22mm 18mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a2e; font-size: 12px; line-height: 1.55; }
  h1 { font-size: 24px; border-bottom: 3px solid #8b0000; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 16px; color: #8b0000; margin-top: 26px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 13px; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; font-size: 11px; }
  th, td { border: 1px solid #ccc; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f3e9e9; }
  code { background: #f2f2f2; padding: 1px 5px; border-radius: 3px; font-family: Consolas, monospace; font-size: 11px; }
  pre { background: #f2f2f2; padding: 10px 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
  ul { margin: 6px 0 12px; padding-left: 22px; }
  li { margin-bottom: 3px; }
  a { color: #8b0000; }
  p { margin: 6px 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

fs.writeFileSync(outputPath, page, 'utf8');
console.log(`Wrote ${outputPath}`);

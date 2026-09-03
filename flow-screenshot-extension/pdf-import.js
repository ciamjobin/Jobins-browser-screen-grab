import { buildPdf } from './pdf.js';

const folderEl = document.getElementById('imageFolder');
const filenameEl = document.getElementById('pdfFilename');
const summaryEl = document.getElementById('fileSummary');
const generateEl = document.getElementById('generatePdf');

let selectedFiles = [];

function sortFiles(files) {
  return [...files].sort((left, right) =>
    (left.webkitRelativePath || left.name).localeCompare(right.webkitRelativePath || right.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
}

function safeFilename(value) {
  const base = String(value || 'JShotz-screenshots.pdf')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim();
  return `${base || 'JShotz-screenshots'}.pdf`;
}

async function imageToPage(file, index) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const relative = file.webkitRelativePath || file.name;
  const title = relative.split('/').pop().replace(/\.[^.]+$/, '') || `Screenshot ${index + 1}`;
  return {
    title,
    url: relative,
    time: file.lastModified ? new Date(file.lastModified).toISOString() : '(time not recorded)',
    width: canvas.width,
    height: canvas.height,
    jpeg: base64ToBytes(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]),
    apiRows: []
  };
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

folderEl.addEventListener('change', () => {
  selectedFiles = sortFiles([...folderEl.files].filter((file) => /^image\/(png|jpeg)$/.test(file.type)));
  summaryEl.textContent = selectedFiles.length
    ? `${selectedFiles.length} screenshot(s) selected.`
    : 'No PNG or JPEG screenshots selected.';
  summaryEl.className = selectedFiles.length ? 'status idle' : 'status error';
  generateEl.disabled = !selectedFiles.length;
});

generateEl.addEventListener('click', async () => {
  if (!selectedFiles.length) return;

  generateEl.disabled = true;
  summaryEl.className = 'status recording';
  summaryEl.textContent = `Preparing ${selectedFiles.length} screenshot(s)...`;

  try {
    const pages = [];
    for (let index = 0; index < selectedFiles.length; index += 1) {
      pages.push(await imageToPage(selectedFiles[index], index));
    }

    const bytes = buildPdf(pages);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeFilename(filenameEl.value),
      saveAs: true
    });

    chrome.downloads.onChanged.addListener(function onChanged(progress) {
      if (progress.id !== downloadId || !progress.state || progress.state.current === 'in_progress') return;
      chrome.downloads.onChanged.removeListener(onChanged);
      URL.revokeObjectURL(url);
    });

    summaryEl.className = 'status idle';
    summaryEl.textContent = `PDF generated from ${pages.length} screenshot(s).`;
  } catch (error) {
    summaryEl.className = 'status error';
    summaryEl.textContent = `PDF generation failed: ${error.message}`;
  } finally {
    generateEl.disabled = false;
  }
});

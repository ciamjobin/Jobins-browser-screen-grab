import { buildPdf } from './pdf.js';

const folderEl = document.getElementById('imageFolder');
const filenameEl = document.getElementById('pdfFilename');
const summaryEl = document.getElementById('fileSummary');
const generateEl = document.getElementById('generatePdf');
const fileSelectionEl = document.getElementById('fileSelection');
const fileListEl = document.getElementById('fileList');
const selectAllFilesEl = document.getElementById('selectAllFiles');

let imageFiles = [];
let selectedFileIndexes = new Set();

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

function selectedFiles() {
  return imageFiles.filter((_, index) => selectedFileIndexes.has(index));
}

function updateFileSelectionControls() {
  const selected = selectedFiles().length;
  const total = imageFiles.length;
  selectAllFilesEl.disabled = !total;
  selectAllFilesEl.checked = total > 0 && selected === total;
  selectAllFilesEl.indeterminate = false;
  summaryEl.textContent = total
    ? `${selected} of ${total} screenshot(s) selected.`
    : 'No PNG or JPEG screenshots selected.';
  summaryEl.className = total ? 'status idle' : 'status error';
  generateEl.disabled = selected === 0;
}

function renderFileList() {
  fileListEl.replaceChildren();
  fileSelectionEl.hidden = imageFiles.length === 0;

  for (const [index, file] of imageFiles.entries()) {
    const item = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedFileIndexes.has(index);
    checkbox.setAttribute('aria-label', `Include ${file.name} in PDF`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedFileIndexes.add(index);
      } else {
        selectedFileIndexes.delete(index);
      }
      updateFileSelectionControls();
    });

    const name = document.createElement('span');
    name.className = 'capture-title';
    name.textContent = file.webkitRelativePath || file.name;
    name.title = name.textContent;

    const selection = document.createElement('label');
    selection.className = 'file-select';
    selection.append(checkbox, name);
    item.append(selection);
    fileListEl.append(item);
  }

  updateFileSelectionControls();
}

async function imageToPage(file, index) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

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
  } finally {
    bitmap.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

folderEl.addEventListener('change', () => {
  imageFiles = sortFiles([...folderEl.files].filter((file) => /^image\/(png|jpeg)$/.test(file.type)));
  selectedFileIndexes = new Set(imageFiles.map((_, index) => index));
  renderFileList();
});

selectAllFilesEl.addEventListener('change', () => {
  selectedFileIndexes = selectAllFilesEl.checked
    ? new Set(imageFiles.map((_, index) => index))
    : new Set();
  renderFileList();
});

generateEl.addEventListener('click', async () => {
  const filesToConvert = selectedFiles();
  if (!filesToConvert.length) return;

  generateEl.disabled = true;
  summaryEl.className = 'status recording';
  summaryEl.textContent = `Preparing ${filesToConvert.length} screenshot(s)...`;

  try {
    const pages = [];
    for (let index = 0; index < filesToConvert.length; index += 1) {
      pages.push(await imageToPage(filesToConvert[index], index));
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
    generateEl.disabled = selectedFiles().length === 0;
  }
});

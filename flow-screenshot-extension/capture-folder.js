const DATABASE_NAME = 'jshotz-capture-folders';
const STORE_NAME = 'folders';
const ACTIVE_FOLDER_KEY = 'resume-capture';
const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g)$/i;

function openFolderDatabase() {
  if (!globalThis.indexedDB) {
    throw new Error('This browser cannot keep access to a selected capture folder.');
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open capture-folder storage.'));
  });
}

async function readFolderRecord() {
  const database = await openFolderDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(ACTIVE_FOLDER_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read the selected capture folder.'));
    });
  } finally {
    database.close();
  }
}

async function writeFolderRecord(value) {
  const database = await openFolderDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(value, ACTIVE_FOLDER_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the selected capture folder.'));
      transaction.onabort = () => reject(transaction.error || new Error('Could not save the selected capture folder.'));
    });
  } finally {
    database.close();
  }
}

export async function saveCaptureFolder(directoryHandle) {
  if (!directoryHandle || directoryHandle.kind !== 'directory') {
    throw new Error('Choose a screenshot folder before resuming a recording.');
  }
  await writeFolderRecord({ directoryHandle, name: directoryHandle.name || 'selected folder' });
}

export async function getSavedCaptureFolder() {
  return (await readFolderRecord())?.directoryHandle || null;
}

export async function requestReadWritePermission(directoryHandle) {
  if (!directoryHandle) return false;
  const options = { mode: 'readwrite' };
  if (typeof directoryHandle.queryPermission !== 'function') return true;
  if ((await directoryHandle.queryPermission(options)) === 'granted') return true;
  return typeof directoryHandle.requestPermission === 'function' &&
    (await directoryHandle.requestPermission(options)) === 'granted';
}

// Call this directly from a click handler. Awaiting queryPermission() first can lose the transient
// activation required for requestPermission() after a persisted folder handle becomes promptable.
export async function requestReadWritePermissionFromUserGesture(directoryHandle) {
  if (!directoryHandle) return false;
  if (typeof directoryHandle.requestPermission === 'function') {
    const permissionRequest = directoryHandle.requestPermission({ mode: 'readwrite' });
    return (await permissionRequest) === 'granted';
  }
  return hasReadWritePermission(directoryHandle);
}

export async function hasReadWritePermission(directoryHandle) {
  if (!directoryHandle) return false;
  if (typeof directoryHandle.queryPermission !== 'function') return true;
  return (await directoryHandle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function fileSequence(name) {
  const match = /^(\d+)[_-]/.exec(name);
  const sequence = Number(match?.[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function validSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function filenameTail(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

function titleFromFileName(name, sequence) {
  const withoutExtension = name.replace(/\.[^.]+$/, '');
  const withoutPrefix = withoutExtension.replace(/^\d+_[^_]+_/, '');
  return withoutPrefix.replace(/[_-]+/g, ' ').trim() || `Screenshot ${sequence}`;
}

function capturedAtFromFile(file) {
  const time = Number(file?.lastModified);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : new Date().toISOString();
}

async function readSessionManifest(directoryHandle) {
  try {
    const manifestHandle = await directoryHandle.getFileHandle('flow-manifest.json');
    const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
    return manifest && typeof manifest === 'object' ? manifest : null;
  } catch {
    return null;
  }
}

function manifestEntries(manifest) {
  if (!Array.isArray(manifest?.screenshots)) return new Map();
  return new Map(
    manifest.screenshots
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => [filenameTail(entry.filename), entry])
      .filter(([name]) => Boolean(name))
  );
}

export async function scanCaptureFolder(directoryHandle) {
  if (!directoryHandle || directoryHandle.kind !== 'directory' || typeof directoryHandle.values !== 'function') {
    throw new Error('The selected folder cannot be read by this browser.');
  }

  const manifest = await readSessionManifest(directoryHandle);
  const savedEntries = manifestEntries(manifest);
  const imageHandles = [];
  for await (const entry of directoryHandle.values()) {
    if (entry.kind === 'file' && IMAGE_FILE_PATTERN.test(entry.name)) imageHandles.push(entry);
  }
  imageHandles.sort((left, right) => naturalCompare(left.name, right.name));

  const usedSequences = new Set();
  let nextSequence = 1;
  const captures = [];
  for (const fileHandle of imageHandles) {
    const file = await fileHandle.getFile();
    const saved = savedEntries.get(fileHandle.name);
    let sequence = validSequence(saved?.sequence) || fileSequence(fileHandle.name) || nextSequence;
    while (usedSequences.has(sequence)) sequence += 1;
    usedSequences.add(sequence);
    nextSequence = Math.max(nextSequence, sequence + 1);

    captures.push({
      fileHandle,
      entry: {
        sequence,
        reason: saved?.reason || 'resumed',
        label: saved?.label || null,
        url: saved?.url || '',
        title: saved?.title || titleFromFileName(fileHandle.name, sequence),
        note: typeof saved?.note === 'string' ? saved.note.trim().slice(0, 50) : '',
        mode: saved?.mode || 'folder',
        apiCalls: Number.isSafeInteger(saved?.apiCalls) ? saved.apiCalls : 0,
        capturedAt: saved?.capturedAt || capturedAtFromFile(file),
        filename: fileHandle.name
      }
    });
  }
  captures.sort((left, right) => left.entry.sequence - right.entry.sequence);

  return {
    folderName: directoryHandle.name || 'selected folder',
    sessionId: typeof manifest?.sessionId === 'string' ? manifest.sessionId : null,
    captures,
    nextSequence
  };
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function imageMimeType(file) {
  if (/^image\/(png|jpeg)$/i.test(file.type)) return file.type;
  return /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : 'image/png';
}

export async function imageFileToDataUrl(fileHandle) {
  const file = await fileHandle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `data:${imageMimeType(file)};base64,${base64FromBytes(bytes)}`;
}

export async function writeCaptureFolderFile(directoryHandle, name, contents) {
  const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
}

export async function removeCaptureFolderFiles(directoryHandle, names) {
  for (const name of new Set(names)) {
    await directoryHandle.removeEntry(name).catch(() => {});
  }
}
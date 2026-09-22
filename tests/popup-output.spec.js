// @ts-check
import { readFile } from 'node:fs/promises';
import path, { extname, sep } from 'node:path';
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const extensionDirectory = path.resolve('flow-screenshot-extension');
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};
const popupOrigin = 'https://jshotz.test';
const popupUrl = `${popupOrigin}/popup.html`;

async function fulfillPopupAsset(route) {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const relativePath = pathname === '/' ? 'popup.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(extensionDirectory, relativePath);
  if (filePath !== extensionDirectory && !filePath.startsWith(`${extensionDirectory}${sep}`)) {
    await route.fulfill({ status: 403 });
    return;
  }
  try {
    const body = await readFile(filePath);
    await route.fulfill({
      status: 200,
      contentType: contentTypes[extname(filePath)] || 'application/octet-stream',
      body
    });
  } catch {
    await route.fulfill({ status: 404 });
  }
}

const reconnectedFolderState = {
  recording: true,
  paused: false,
  sessionId: 'session_reconnected',
  sequence: 1,
  apiSeen: 0,
  outputFolder: { name: 'Recovered captures' },
  folderAccessNeeded: false,
  captures: [{
    sequence: 1,
    title: 'Recovered page',
    note: '',
    url: 'https://example.test/recovered',
    reason: 'recovered',
    capturedAt: '2026-09-13T12:00:00.000Z'
  }],
  settings: {
    captureMode: 'tab',
    captureOnClick: true,
    captureOnScroll: true,
    captureApi: false,
    stampTimestamp: false,
    fullPage: false,
    savePng: true,
    savePdf: true
  },
  pdfExcludedSequences: []
};

const completedEvidenceState = {
  ...reconnectedFolderState,
  recording: false,
  outputFolder: null,
  completedEvidence: {
    sessionId: 'session_reconnected',
    captureCount: 1,
    outputFolderName: null,
    downloadDirectory: 'flow-captures/session_reconnected',
    completedAt: '2026-09-14T20:00:00.000Z'
  }
};

const interruptedEvidenceState = {
  ...completedEvidenceState,
  captures: [
    ...completedEvidenceState.captures,
    {
      sequence: 2,
      title: 'Account settings',
      note: '',
      url: 'https://example.test/settings',
      reason: 'click',
      capturedAt: '2026-09-14T20:01:00.000Z'
    }
  ],
  completedEvidence: {
    ...completedEvidenceState.completedEvidence,
    captureCount: 2,
    interrupted: true
  },
  interruptedRecording: {
    sessionId: 'session_reconnected',
    captureCount: 2,
    interruptedAt: '2026-09-14T20:02:00.000Z'
  },
  interimOutput: {
    sessionId: 'session_reconnected',
    filename: 'JShotz-interim.pdf',
    destination: 'downloads',
    downloadFilename: 'flow-captures/session_reconnected/JShotz-interim.pdf',
    captureCount: 2,
    captureSequence: 2,
    updatedAt: '2026-09-14T20:02:00.000Z'
  }
};

async function openPopup(page, state = reconnectedFolderState, activeTabId = null) {
  await page.addInitScript(({ state, activeTabId }) => {
    let currentState = JSON.parse(JSON.stringify(state));
    const copyState = () => JSON.parse(JSON.stringify(currentState));
    window.__popupMessages = [];
    window.chrome = {
      tabs: {
        query: async () => Number.isSafeInteger(activeTabId) ? [{ id: activeTabId }] : []
      },
      runtime: {
        id: 'jshotz-test-extension',
        getManifest: () => ({ version: '3.14.2' }),
        sendMessage: async (message) => {
          window.__popupMessages.push(message);
          if (message.type === 'STOP') {
            currentState = {
              ...currentState,
              recording: false,
              paused: false,
              ...(message.reveal ? { fileLocationOpened: true } : {}),
              savedOutputFilenames: message.outputFormats.map(
                (format) => `${message.outputFilename}.${format}`
              )
            };
            return copyState();
          }
          if (message.type === 'SET_PAUSED') {
            currentState = { ...currentState, paused: Boolean(message.paused) };
            return copyState();
          }
          if (message.type === 'SET_SETTINGS') {
            currentState = {
              ...currentState,
              settings: { ...currentState.settings, ...message.settings }
            };
            return copyState();
          }
          if (message.type === 'GENERATE_EVIDENCE') {
            currentState = {
              ...currentState,
              savedOutputFilenames: message.outputFormats.map(
                (format) => `${message.outputFilename}.${format}`
              )
            };
            return copyState();
          }
          return copyState();
        }
      }
    };
  }, { state, activeTabId });
  await page.route(`${popupOrigin}/**`, fulfillPopupAsset);
  await page.goto(popupUrl);
  const recordingElsewhere = Boolean(
    state.recording &&
      Number.isSafeInteger(activeTabId) &&
      Array.isArray(state.trackedTabIds) &&
      !state.trackedTabIds.includes(activeTabId)
  );
  const toggleLabel = recordingElsewhere
    ? 'Recording on another tab'
    : state.recording
      ? 'Stop recording'
      : 'Start recording';
  await expect(page.getByRole('button', { name: toggleLabel })).toBeVisible();
}

test('shows the current extension version in the popup header', async ({ page }) => {
  await openPopup(page);
  await expect(page.getByLabel('JShotz version')).toHaveText('v3.14.2');
});

test('does not expose recording controls on an unrelated tab', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, trackedTabIds: [7] }, 99);

  await expect(page.locator('#status')).toHaveText('This tab is not being recorded.');
  await expect(page.getByRole('button', { name: 'Recording on another tab' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(0);
  await expect(page.locator('#pauseResume')).toBeHidden();
  await expect(page.locator('#captureNow')).toBeDisabled();
});

test('keeps recording controls available on tracked flow tabs', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, trackedTabIds: [7, 8] }, 8);

  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
  await expect(page.locator('#pauseResume')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Capture whole page (Alt+Shift+J)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'DevTools capture in 5s (Alt+Shift+D)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save checkpoint (Ctrl+Shift+S)' })).toBeEnabled();
  await expect(page.locator('#shortcutSummary')).toContainText('Alt+Shift+K DevTools');
  await expect(page.locator('#shortcutSummary')).toContainText('Ctrl+S Save and stop');
});

test('shows separate final save actions and removes obsolete popup actions', async ({ page }) => {
  await openPopup(page);

  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByRole('button', { name: 'Yes, keep' }).click();

  await expect(page.locator('#mainActions')).toBeHidden();
  await expect(page.locator('#outputPromptTitle')).toHaveText('Save and stop recording');
  await expect(page.getByRole('button', { name: 'Save and stop (Ctrl+S)' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save, stop, and open file location (Ctrl+Alt+S)' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Start new recording/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Export document so far/ })).toHaveCount(0);
});

test('Ctrl+Shift+S opens only the checkpoint filename panel', async ({ page }) => {
  await openPopup(page);

  await page.keyboard.press('Control+Shift+S');

  await expect(page.locator('#mainActions')).toBeHidden();
  await expect(page.locator('#outputPromptTitle')).toHaveText('Save checkpoint (Ctrl+Shift+S)');
  await expect(page.getByRole('button', { name: 'Save checkpoint (Ctrl+Shift+S)' })).toBeVisible();
  await expect(page.locator('#saveWithNameAndOpen')).toBeHidden();
});

test('Ctrl+S saves and stops with a toast without opening the file location', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, outputFolder: null });

  await page.keyboard.press('Control+S');
  await expect(page.locator('#mainActions')).toBeHidden();
  await expect(page.locator('#outputPromptTitle')).toHaveText('Save and stop (Ctrl+S)');
  await expect(page.getByRole('button', { name: 'Save and stop (Ctrl+S)' })).toBeVisible();
  await expect(page.locator('#saveWithNameAndOpen')).toBeHidden();
  await page.keyboard.press('Control+S');

  await expect(page.locator('#toast')).toHaveText('Saved as session_reconnected.pdf');
  const stopMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'STOP')
  );
  expect(stopMessage.reveal).toBe(false);
});

test('Ctrl+Alt+S saves, stops, and requests the file location', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, outputFolder: null });

  await page.keyboard.press('Control+Alt+S');
  await expect(page.locator('#mainActions')).toBeHidden();
  await expect(page.locator('#outputPromptTitle')).toHaveText(
    'Save, stop, and open file location (Ctrl+Alt+S)'
  );
  await expect(
    page.getByRole('button', { name: 'Save, stop, and open file location (Ctrl+Alt+S)' })
  ).toBeVisible();
  await expect(page.locator('#saveWithNameAndOpen')).toBeHidden();
  await page.keyboard.press('Control+Alt+S');

  await expect(page.locator('#status')).toHaveText(
    'Saved as session_reconnected.pdf and opened the file location.'
  );
  await expect(page.locator('#toast')).toBeHidden();
  const stopMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'STOP')
  );
  expect(stopMessage.reveal).toBe(true);
});

test('generates selected evidence documents after a recording stops', async ({ page }) => {
  await openPopup(page, completedEvidenceState);

  await expect(page.getByRole('button', { name: 'Generate evidences' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate evidences' }).click();

  await expect(page.locator('#outputPromptTitle')).toHaveText('Generate evidences');
  await expect(page.getByRole('textbox', { name: 'File name' })).toHaveValue('session_reconnected_evidence');
  await page.getByLabel('Word (.docx)').check();
  await page.getByRole('button', { name: 'Generate evidences' }).click();

  await expect(page.locator('#toast')).toHaveText(
    'Saved as session_reconnected_evidence.pdf and session_reconnected_evidence.docx'
  );
  const evidenceMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'GENERATE_EVIDENCE')
  );
  expect(evidenceMessage.outputFormats).toEqual(['pdf', 'docx']);
  expect(evidenceMessage.excludedSequences).toEqual([]);
});

test('shows browser-restart interruption status with retained evidence', async ({ page }) => {
  await openPopup(page, interruptedEvidenceState);

  await expect(page.locator('#status')).toHaveText(
    'Recording ended after the browser restarted. Interim backup includes 2 screenshot(s).'
  );
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  await expect(page.locator('#pauseResume')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Generate evidences' })).toBeVisible();
});
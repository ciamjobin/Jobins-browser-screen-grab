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

async function openPopup(
  page,
  state = reconnectedFolderState,
  activeTabId = null,
  existingSessionFolders = [],
  attachedFolderName = null
) {
  await page.addInitScript(({ state, activeTabId, existingSessionFolders, attachedFolderName }) => {
    let currentState = JSON.parse(JSON.stringify(state));
    const copyState = () => JSON.parse(JSON.stringify(currentState));
    window.__updatePopupState = (patch) => {
      currentState = { ...currentState, ...patch };
    };
    const sanitizeFolderName = (value) => String(value || 'untitled')
      .replace(/[\\/:*?"<>|#]+/g, '-')
      .replace(/\s+/g, '_')
      .replace(/-+/g, '-')
      .slice(0, 100);
    if (attachedFolderName) {
      const directoryHandle = {
        kind: 'directory',
        name: attachedFolderName,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        async *values() {}
      };
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
        open() {
          const request = {};
          request.result = {
            objectStoreNames: { contains: () => true },
            transaction() {
              return {
                objectStore() {
                  return {
                    get() {
                      const read = {};
                      queueMicrotask(() => {
                        read.result = { directoryHandle, name: attachedFolderName };
                        read.onsuccess?.();
                      });
                      return read;
                    }
                  };
                }
              };
            },
            close() {}
          };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        }
      } });
    }
    window.__popupMessages = [];
    window.chrome = {
      tabs: {
        query: async () => Number.isSafeInteger(activeTabId) ? [{ id: activeTabId }] : []
      },
      runtime: {
        id: 'jshotz-test-extension',
        getManifest: () => ({ version: '3.14.3' }),
        sendMessage: async (message) => {
          window.__popupMessages.push(message);
          if (message.type === 'CHECK_SESSION_FOLDER') {
            const folderName = sanitizeFolderName(message.sessionFolderName);
            return {
              folderName,
              exists: existingSessionFolders.some(
                (name) => sanitizeFolderName(name).toLowerCase() === folderName.toLowerCase()
              )
            };
          }
          if (message.type === 'STOP') {
            const completeStop = () => {
              currentState = {
                ...currentState,
                recording: false,
                paused: false,
                ...(message.reveal ? { fileLocationOpened: true } : {}),
                savedOutputFilenames: (message.outputFormats || []).map(
                  (format) => `${message.outputFilename}.${format}`
                )
              };
              return copyState();
            };
            if (window.__deferStop) {
              return new Promise((resolve) => {
                window.__resolveStop = () => resolve(completeStop());
              });
            }
            return completeStop();
          }
          if (message.type === 'START') {
            currentState = {
              ...currentState,
              recording: true,
              paused: false,
              sessionId: 'session_fresh',
              sessionFolderName: message.sessionFolderName,
              sequence: 1,
              captures: [{ sequence: 1, title: 'Fresh page', url: 'https://example.test/fresh' }],
              outputFolder: null,
              pendingResumeFolder: null,
              completedEvidence: null
            };
            return copyState();
          }
          if (message.type === 'RESUME_FROM_FOLDER') {
            const folderName = attachedFolderName || currentState.pendingResumeFolder?.name;
            currentState = {
              ...currentState,
              recording: true,
              paused: false,
              outputFolder: folderName ? { name: folderName } : null,
              pendingResumeFolder: null,
              completedEvidence: null
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
          if (message.type === 'CAPTURE_WHOLE_PAGE') {
            currentState = {
              ...currentState,
              fullPageProgress: {
                active: true,
                label: 'Preparing full-page screenshot',
                percent: 0
              }
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
  }, { state, activeTabId, existingSessionFolders, attachedFolderName });
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
      : 'Start new recording';
  await expect(page.getByRole('button', { name: toggleLabel })).toBeVisible();
}

test('shows the current extension version in the popup header', async ({ page }) => {
  await openPopup(page);
  await expect(page.getByLabel('JShotz version')).toHaveText('v3.14.3');
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
  await openPopup(
    page,
    {
      ...reconnectedFolderState,
      trackedTabIds: [7, 8],
      streamActive: true,
      devToolsOpen: false,
      screenCaptureAvailable: true,
      settings: { ...reconnectedFolderState.settings, captureMode: 'screen' }
    },
    8
  );

  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
  await expect(page.locator('#pauseResume')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Instant screenshot (Alt+Shift+K)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Capture whole page (Alt+Shift+J)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Capture shared screen (Alt+Shift+D)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save checkpoint (Ctrl+Shift+S)' })).toBeEnabled();
  await expect(page.locator('#shortcutSummary')).toContainText('Alt+Shift+K Instant screenshot');
  await expect(page.locator('#shortcutSummary')).toContainText('Ctrl+S Save and stop');
});

test('captures instantly from the popup without requiring DevTools', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, trackedTabIds: [7] }, 7);

  await page.getByRole('button', { name: 'Instant screenshot (Alt+Shift+K)' }).click();

  const messages = await page.evaluate(() => window.__popupMessages);
  await expect.poll(() => messages.some((message) => message.type === 'CAPTURE_PANEL')).toBe(true);
});

test('disables shared-screen capture until screen sharing is available', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, trackedTabIds: [7] }, 7);

  await expect(page.getByRole('button', { name: 'Capture shared screen (Alt+Shift+D)' })).toBeDisabled();
  await expect(page.locator('#captureMode option[value="screen"]')).toHaveAttribute('disabled', '');
});

test('enables shared-screen capture when screen sharing is live even with DevTools closed', async ({ page }) => {
  await openPopup(page, {
    ...reconnectedFolderState,
    trackedTabIds: [7],
    devToolsOpen: false,
    streamActive: true,
    screenCaptureAvailable: true
  }, 7);

  await expect(page.locator('#captureMode option[value="screen"]')).toHaveAttribute('disabled', '');
  await expect(page.getByRole('button', { name: 'Capture shared screen (Alt+Shift+D)' })).toBeEnabled();
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

test('keeps the document creation wait message visible while pending captures drain', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, outputFolder: null });
  await page.evaluate(() => {
    const sendMessage = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'STOP') {
        await new Promise((resolve) => {
          window.__releaseStop = resolve;
        });
      }
      return sendMessage(message);
    };
  });

  await page.keyboard.press('Control+S');
  await page.keyboard.press('Control+S');
  await expect(page.locator('#status')).toHaveText('The document is being created. Please wait...');
  await page.waitForTimeout(1200);
  await expect(page.locator('#status')).toHaveText('The document is being created. Please wait...');

  await page.evaluate(() => window.__releaseStop());
  await expect(page.locator('#toast')).toHaveText('Saved as session_reconnected.pdf');
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
  await expect(page.getByRole('textbox', { name: 'Evidence folder' })).toHaveValue('session_reconnected');
  await page.getByLabel('Word (.docx)').check();
  await page.getByRole('button', { name: 'Generate evidences' }).click();

  await expect(page.locator('#toast')).toHaveText(
    'Saved as session_reconnected.pdf and session_reconnected.docx'
  );
  const evidenceMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'GENERATE_EVIDENCE')
  );
  expect(evidenceMessage.outputFormats).toEqual(['pdf', 'docx']);
  expect(evidenceMessage.excludedSequences).toEqual([]);
});

test('shows evidence generation for a populated folder reattached after a stop', async ({ page }) => {
  await openPopup(page, {
    ...completedEvidenceState,
    pendingResumeFolder: { name: 'session_reconnected' },
    completedEvidence: {
      ...completedEvidenceState.completedEvidence,
      outputFolderName: 'session_reconnected'
    }
  });

  await expect(page.getByRole('button', { name: 'Generate evidences' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate evidences' })).toBeEnabled();
});

test('shows browser-restart interruption status with retained evidence', async ({ page }) => {
  await openPopup(page, interruptedEvidenceState);

  await expect(page.locator('#status')).toHaveText(
    'Recording ended after the browser restarted. Interim backup includes 2 screenshot(s).'
  );
  await expect(page.getByRole('button', { name: 'Start new recording' })).toBeEnabled();
  await expect(page.locator('#pauseResume')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Generate evidences' })).toBeVisible();
});

test('requires an available mode when the saved Screen preference is unavailable', async ({ page }) => {
  await openPopup(page, {
    ...completedEvidenceState,
    devToolsOpen: false,
    settings: {
      ...completedEvidenceState.settings,
      captureMode: 'tab',
      devToolsCaptureRequested: true
    }
  });

  const captureMode = page.locator('#captureMode');
  const tabOption = captureMode.locator('option[value="tab"]');
  const apiOption = captureMode.locator('option[value="api"]');
  const screenOption = captureMode.locator('option[value="screen"]');
  await expect(captureMode).toHaveValue('');
  await expect(page.locator('#status')).toHaveText('Choose an available capture source before starting.');
  await expect(tabOption).toHaveCSS('color', 'rgb(13, 71, 161)');
  await expect(apiOption).toHaveCSS('color', 'rgb(13, 71, 161)');
  await expect(tabOption).toHaveCSS('font-weight', '700');
  await expect(apiOption).toHaveCSS('font-weight', '700');
  await expect(screenOption).toHaveAttribute('disabled', '');
  await expect(screenOption).toHaveCSS('color', 'rgb(138, 148, 163)');
  await expect(screenOption).toHaveCSS('font-weight', '700');

  await page.getByRole('button', { name: 'Start new recording' }).click();
  await expect(page.locator('#status')).toHaveText('Choose an available capture source before starting.');
  await expect(captureMode).toBeFocused();
  await expect(page.locator('#sessionFolderPrompt')).toBeHidden();

  await captureMode.selectOption('tab');
  await page.getByRole('button', { name: 'Start new recording' }).click();
  await expect(page.locator('#sessionFolderPrompt')).toBeVisible();
});

test('prompts for a timestamped Downloads evidence folder before a new recording', async ({ page }) => {
  await openPopup(page, {
    ...reconnectedFolderState,
    recording: false,
    captures: [],
    pendingResumeFolder: { name: 'Previously selected captures' }
  });

  await page.getByRole('button', { name: 'Start new recording' }).click();
  await expect(page.locator('#sessionFolderPrompt')).toBeVisible();
  await expect(page.locator('#sessionFolderName')).toHaveValue(
    /^JShotz_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/
  );

  await page.locator('#sessionFolderName').fill('Retirement plan evidence');
  await page.locator('#sessionFolderStart').click();
  const startMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'START')
  );
  expect(startMessage.sessionFolderName).toBe('Retirement_plan_evidence');
  expect(startMessage.type).toBe('START');
  await expect(page.locator('#captureList')).not.toContainText('Recovered page');
  await expect(page.locator('#captureList')).toContainText('Fresh page');
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
});

test('keeps continue enabled and asks for a folder when none is attached', async ({ page }) => {
  await openPopup(page, { ...completedEvidenceState, pendingResumeFolder: null });

  await expect(page.getByRole('button', { name: 'Start new recording' })).toBeEnabled();
  const continueButton = page.getByRole('button', { name: 'Continue recording' });
  await expect(continueButton).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Resume capture from folder' })).toBeVisible();

  await page.evaluate(() => {
    window.__folderPickerOpened = false;
    window.showDirectoryPicker = async () => {
      window.__folderPickerOpened = true;
      throw new DOMException('Folder selection cancelled.', 'AbortError');
    };
  });
  await continueButton.click();

  await expect.poll(() => page.evaluate(() => window.__folderPickerOpened)).toBe(true);
  await expect(page.locator('#status')).toHaveText('Folder selection cancelled.');
  await expect(continueButton).toBeEnabled();
});

test('shows and refreshes the buffered screenshot count', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, pendingCaptureCount: 12 });

  await expect(page.locator('#status')).toHaveText('Recording · 1 screenshot(s) · 12 buffered');
  await page.evaluate(() => window.__updatePopupState({ sequence: 2, pendingCaptureCount: 0 }));
  await expect(page.locator('#status')).toHaveText('Recording · 2 screenshot(s)');
});

test('shows live memory pressure and screen-buffer estimates', async ({ page }) => {
  await openPopup(page, {
    ...reconnectedFolderState,
    memoryStatus: {
      level: 'elevated',
      memoryApiAvailable: true,
      estimatedHeapHeadroomBytes: 128 * 1024 * 1024,
      screenBufferedBytes: 20 * 1024 * 1024,
      screenBufferedFrames: 2,
      maxPrebufferedCaptureFrames: 3
    }
  });

  await expect(page.locator('#memoryStatus')).toHaveText(
    'Memory estimate: Elevated · JS heap headroom ~128 MiB · free system RAM unavailable · screen buffer 2 frame(s) / 20 MiB · prebuffer cap 3'
  );
  await page.evaluate(() => window.__updatePopupState({
    memoryStatus: {
      level: 'high',
      memoryApiAvailable: false,
      screenBufferedBytes: 256 * 1024 * 1024,
      screenBufferedFrames: 12,
      maxPrebufferedCaptureFrames: 1
    }
  }));
  await expect(page.locator('#memoryStatus')).toContainText('Memory estimate: High');
  await expect(page.locator('#memoryStatus')).toContainText('free system RAM unavailable');
  await expect(page.locator('#memoryStatus')).toContainText('prebuffer cap 1');
});

test('refreshes the buffered screenshot count while stop drains pending captures', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, outputFolder: null, pendingCaptureCount: 3 });
  await page.evaluate(() => { window.__deferStop = true; });

  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByRole('button', { name: 'Stop without document' }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__resolveStop === 'function')).toBe(true);
  await expect(page.locator('#status')).toContainText('3 buffered');

  await page.evaluate(() => window.__updatePopupState({ pendingCaptureCount: 0 }));
  await expect(page.locator('#status')).toHaveText('The document is being created. Please wait...');
  await page.evaluate(() => window.__resolveStop());
  await expect(page.getByRole('button', { name: 'Start new recording' })).toBeVisible();
});

test('continues with an attached folder and restores the normal stop choices', async ({ page }) => {
  await openPopup(page, {
    ...completedEvidenceState,
    outputFolder: null,
    pendingResumeFolder: { name: 'Recovered captures' }
  }, null, [], 'Recovered captures');

  const continueButton = page.getByRole('button', { name: 'Continue recording' });
  await expect(continueButton).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Resume capture from folder' })).toBeHidden();
  await continueButton.click();

  const resumeMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'RESUME_FROM_FOLDER')
  );
  expect(resumeMessage).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue recording' })).toBeHidden();

  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('button', { name: 'Yes, keep' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop without document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'No, delete all' })).toBeVisible();
});

test('offers to reuse an existing evidence folder', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, recording: false, captures: [] }, null, ['Claims_Evidence']);

  await page.locator('#toggle').click();
  await page.locator('#sessionFolderName').fill('Claims Evidence');
  await page.locator('#sessionFolderStart').click();
  await expect(page.locator('#sessionFolderConflict')).toBeVisible();
  await expect(page.getByLabel('Reuse existing folder')).toBeChecked();

  await page.locator('#sessionFolderStart').click();
  const startMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'START')
  );
  expect(startMessage.sessionFolderName).toBe('Claims_Evidence');
});

test('can append a timestamp when an evidence folder already exists', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, recording: false, captures: [] }, null, ['Claims_Evidence']);

  await page.locator('#toggle').click();
  await page.locator('#sessionFolderName').fill('Claims Evidence');
  await page.locator('#sessionFolderStart').click();
  await page.getByLabel('Create a new folder with timestamp appended').check();
  await page.locator('#sessionFolderStart').click();

  const startMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'START')
  );
  expect(startMessage.sessionFolderName).toMatch(
    /^Claims_Evidence_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/
  );
});

test('requires a unique replacement when an evidence folder already exists', async ({ page }) => {
  await openPopup(
    page,
    { ...reconnectedFolderState, recording: false, captures: [] },
    null,
    ['Claims_Evidence', 'Claims_Evidence_New']
  );

  await page.locator('#toggle').click();
  await page.locator('#sessionFolderName').fill('Claims Evidence');
  await page.locator('#sessionFolderStart').click();
  await page.getByLabel('Provide a new unique folder name').check();
  await page.locator('#uniqueSessionFolderName').fill('Claims Evidence New');
  await page.locator('#sessionFolderStart').click();
  await expect(page.locator('#toast')).toHaveText('That folder already exists. Enter a unique folder name.');

  await page.locator('#uniqueSessionFolderName').fill('Claims Evidence September');
  await page.locator('#sessionFolderStart').click();
  const startMessage = await page.evaluate(() =>
    window.__popupMessages.find((message) => message.type === 'START')
  );
  expect(startMessage.sessionFolderName).toBe('Claims_Evidence_September');
});

test('shows capture checkboxes in a collapsed checkable listbox', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, recording: false });

  await expect(page.locator('#captureOptions')).not.toHaveAttribute('open', '');
  await expect(page.locator('#captureOptionsSummary')).toHaveText('4 selected');
  await page.locator('#captureOptions > summary').click();
  await page.locator('#captureOnScroll').uncheck();
  await expect(page.locator('#captureOptionsSummary')).toHaveText('3 selected');
  await expect(page.locator('#captureOnScroll').locator('xpath=..')).toHaveAttribute('aria-selected', 'false');
});

test('changes every capture-option combination during a running session', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, trackedTabIds: [7] }, 7);
  await page.locator('#captureOptions > summary').click();

  const optionIds = ['captureOnClick', 'captureOnScroll', 'fullPage', 'savePng', 'savePdf'];
  for (const optionId of optionIds) await expect(page.locator(`#${optionId}`)).toBeEnabled();

  for (let index = 0; index < 32; index += 1) {
    const mask = index ^ (index >> 1);
    for (const [bit, optionId] of optionIds.entries()) {
      const option = page.locator(`#${optionId}`);
      const selected = Boolean(mask & (1 << bit));
      if ((await option.isChecked()) !== selected) {
        await option.setChecked(selected);
      }
      await expect(option.locator('xpath=..')).toHaveAttribute('aria-selected', String(selected));
    }
    await expect(page.locator('#captureOptionsSummary')).toHaveText(`${mask.toString(2).replaceAll('0', '').length} selected`);
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
  }

  await expect.poll(() => page.evaluate(() =>
    window.__popupMessages.filter((message) => message.type === 'SET_SETTINGS').length
  )).toBeGreaterThanOrEqual(31);
  const settingsMessages = await page.evaluate(() =>
    window.__popupMessages.filter((message) => message.type === 'SET_SETTINGS')
  );
  for (const message of settingsMessages) {
    expect(Object.keys(message.settings)).toHaveLength(1);
    expect(optionIds).toContain(Object.keys(message.settings)[0]);
  }
});

test('queues whole-page capture from the popup button', async ({ page }) => {
  await openPopup(page, { ...reconnectedFolderState, trackedTabIds: [7] }, 7);

  await page.getByRole('button', { name: 'Capture whole page (Alt+Shift+J)' }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__popupMessages.filter(({ type }) => type === 'CAPTURE_WHOLE_PAGE').length
  )).toBe(1);
  await expect(page.locator('#fullPageProgress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Capture whole page (Alt+Shift+J)' })).toBeDisabled();
});
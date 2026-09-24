# JShotz Quick Guide

**Version 3.14.4**

JShotz records your browsing as a series of screenshots and turns them into a PDF or Word document - handy for
documenting a process, a support case, or a step-by-step walkthrough.

---

## Getting started

1. Load JShotz as a browser extension, then click the JShotz icon in your toolbar. Do not open
   `popup.html` directly from its folder; it needs the browser extension runtime to record.
2. Choose a **Capture source**:
   - **Tab viewport only** — screenshots of the page you're on.
   - **API + Screenshot** — same, plus a table of the page's network calls under each shot. JShotz
     observes page network calls only while this source is selected.
    - **Screen / window** — share your whole screen, a window, or a tab (the only option that
       can show DevTools or other apps). Visible DevTools changes are buffered immediately and
       processed in order after you open an API request, switch detail tabs, or pause scrolling.
3. Click **Start recording**. JShotz suggests a timestamped evidence folder name. Keep it or enter
   your own name, then click **Start recording** in the folder prompt. New sessions are stored under
   `Downloads/Jshotz/<folder name>/`. If that name was used before, choose **Reuse existing folder**,
   **Create a new folder with timestamp appended**, or **Provide a new unique folder name**. This
   check is silent and does not open the browser's Downloads notification.
4. Use the page normally — screenshots are taken automatically as you click and scroll. Each
   normal action produces one settled screenshot of the currently visible page area. JShotz keeps
   the resulting documents in the order you acted, even when a screen waits to render; each
   frame's title and URL come from the page being captured.
5. To take a break without ending the session, click **Pause recording**. It becomes
   **Continue recording**; continuing keeps the same screenshots, numbering, and session folder.
6. Need a checkpoint without stopping? Click **Save checkpoint (Shift+Ctrl+S)**. Enter a file name,
   choose PDF, Word, or both, and JShotz keeps the current recording active. A toast confirms
   whether the save succeeded or failed.
7. Need a final save without opening the file location? Press **Ctrl+S** or click **Stop recording**,
   then choose **Yes, keep** and **Save and stop (Ctrl+S)**. It saves the selected documents, ends
   the recording, and shows a saved-file toast.
8. Choose **Save, stop, and open file location (Ctrl+Alt+S)** to save the selected documents, end
   the recording, and reveal the browser-download location.
9. When you are done with the final flow, clear unwanted frames in the **Screenshots** list, then
   click **Stop recording**. The confirmation appears directly under that button: choose **Yes,
   keep** to choose a custom name and PDF, Word, or both, then select **Save and stop (Ctrl+S)** or
   **Save, stop, and open file location (Ctrl+Alt+S)**. Choose **Stop without document** to keep the
   captured files and manifest without a document, or **No, delete all** to discard the session and
   its interim backup.
10. After keeping a stopped session, use **Generate evidences** to create another PDF, Word document,
    or both from the checked screenshots. Enter a name, choose the formats, and JShotz writes them to
    the same selected folder or Downloads session folder. If an output document already has that name,
    JShotz appends its creation timestamp instead of replacing it.

You can change the capture source at any time without stopping the recording.

JShotz updates one `JShotz-interim.pdf` after screenshot 5 and every five screenshots after that.
It overwrites that same file in the selected capture folder or in the session's Downloads folder,
so it does not create a new backup file for every checkpoint. A successful final PDF or Word save
removes the interim PDF. **Stop without document**, a browser crash, or an accidental browser close
keeps the latest interim PDF available.

If the browser restarts during an active recording, JShotz ends that recording safely instead of
binding it to whichever tab is currently open. The popup reports the interruption, retains the
stored screenshots, and offers **Generate evidences**. Start a new recording for a new flow, or use
**Resume capture from folder** to continue a folder-backed flow.

To continue a folder-backed flow after a browser or extension crash, use **Resume capture from
folder**, choose that folder, then click **Start recording**. JShotz loads that folder's screenshots,
starts at the next number, and includes the old and new screenshots in its checkpoint and final
documents. If the selected folder has no previous PNG or JPEG screenshots, Start recording creates a
new recording there and writes the current flow to it.

If Chrome no longer grants write access to that selected folder, recording still continues and new
screenshots go to the normal Downloads session folder. Use **Reconnect capture folder** when you
want later screenshots and final documents to write directly to the original folder again.
Reconnecting an empty selected folder is supported and confirms that the current flow will be
captured there.

If Chrome says JShotz needs access after a redirect, open the JShotz popup on the current page and
continue recording. For flows that move between websites, set JShotz **Site access** to **On all
sites** in Chrome's extension details.

---

## Updating the extension

Unzip the new JShotz package, load the folder containing `manifest.json` from
`chrome://extensions` or `edge://extensions`, and make sure only one JShotz copy is enabled.
Then close and reopen any browser tab that was already open during the update before recording.
Chrome may retain an **Extension context invalidated** error for an old page script; delete that
error card after reopening the tab.

---

## Capturing a screenshot manually

| To do this | Do this |
|---|---|
| Capture right now | Click **Capture now** in the popup |
| Capture the whole page | Press **Alt+Shift+J**, or click **Capture now** |
| Capture a DevTools panel | Open the panel, press **Alt+Shift+K** |
| Capture DevTools immediately | In **Screen / window** mode with DevTools open, click **Capture DevTools**, or press **Alt+Shift+D** |

In **Screen / window** mode, JShotz also captures settled visual changes in DevTools automatically.
This covers opening each API request, switching among Headers, Payload, and Response, and scrolling
those panels. Up to 100 frames are buffered before document processing so quick follow-up actions
are retained. When stopping with documents, wait for **The document is being created. Please wait...**;
JShotz drains accepted frames into the final list before creating PDF or Word output.

---

## Getting the whole page in one shot

Turn on **"Whole-page shots for manual captures"** in settings. **Capture now** and
**Alt+Shift+J** and **Capture now** capture the entire scrollable document when direct Chromium capture is available.
Automatic clicks, scrolling, field edits, and navigation always save one normal screenshot of the
currently visible page area, including narrow responsive layouts and Chrome DevTools Device Mode.

Very long direct captures are saved as adjacent, numbered parts instead of one oversized image. The
parts remain in order when you export a document. A progress bar appears in the popup and on the page
while a direct whole-page capture is running, then disappears when it finishes.

If direct whole-page capture is unavailable, including in Chrome DevTools Device Mode, Firefox, or
when another debugger is attached, JShotz saves one visible screenshot instead. It does not scroll the
document or an inner page pane to build a capture. **Capture DevTools** and the DevTools-panel shortcut
also capture only the visible screen state.

For ordinary direct captures, Chrome may show a "started debugging this browser" banner for a moment.

---

## Saving documents while you continue

Click **Save checkpoint (Shift+Ctrl+S)** at any point to open a compact save dialog. Enter the custom
base name, select PDF, Word, or both, and save a checkpoint without stopping the recording. The
current screenshots, numbering, and output selection remain available for later work. A toast
reports the save result.

The checkpoint document is written alongside the active session's other output. The **Preselect
PDF in output dialogs** option controls the initial format choice; each dialog always lets you
choose PDF, Word, or both.

## Modal windows

JShotz captures a modal once when it opens. While a fixed modal is visible, scrolling the page
behind it does not create screenshots. A large modal with a real scrollable body is captured when
you scroll substantially inside it; small modal scroll areas are ignored. Modal buttons, edits,
and selected values create one settled screenshot each. Non-scrollable modals are exported as a
compact modal-only image instead of a full-page duplicate. Cookie-consent banners and other wide
in-page consent overlays stay in the full viewport capture with the page behind them.

---

## Choose output screenshots and add notes

Every captured screenshot starts selected for document output. Before a checkpoint, final export, or
post-stop evidence generation:

1. Clear the checkbox beside any screenshot you do not want in the document.
2. Use **Select all** to include every screenshot again.
3. Use **Show older screenshots** when the recording has more than 50 captures.
4. Enter an optional note of up to 50 characters under a screenshot. A saved note appears after
   that screenshot's heading in brackets in PDF and Word output.

Your selection remains with the active or most recently kept recording when the popup closes. Only
selected screenshots appear in checkpoint, final, and evidence documents. Evidence generation remains
available until you start a new recording.

---

## Resume an interrupted capture

1. Open the page where you want to continue the flow.
2. Click **Resume capture from folder** in the popup.
3. Choose the earlier session's screenshot folder in the native folder dialog and allow read/write
   access.
4. Click **Start recording**. JShotz refreshes the **Screenshots** list with the earlier files and
   captures the current page as the next screenshot.

When the selected folder has no previous PNG or JPEG screenshots, JShotz treats it as the current
flow's output folder instead. Start recording begins a new recording there and confirms that captures
are being written to the selected folder. Without selecting a resume folder, Start recording always
creates a fresh session and Downloads folder after a stop or browser restart.

New PNG files, checkpoint and final PDF/Word documents, and the refreshed `flow-manifest.json` are written
to that same selected folder. No browser tab is opened for this action. It is available in Chrome
and Edge; Firefox can record normally but cannot write directly into an arbitrary existing folder.
If Chrome or Edge asks for folder access again while an active folder-backed recording remains open,
the button becomes **Reconnect capture folder**. After a browser restart, choose **Resume capture
from folder** instead.

---

## Shortcuts and common fixes

- `Alt+Shift+J`: capture the whole page while the page has focus.
- `Alt+Shift+K`: capture the currently visible DevTools panel.
- `Alt+Shift+D`: start a five-second countdown, then capture. Use this when you need time to
   click into DevTools.
- `Shift+Ctrl+S`: open the checkpoint save dialog and keep recording after it is saved.
- `Ctrl+S`: open the final save dialog, save the chosen output, and stop recording without opening
   the file location.
- `Ctrl+Alt+S`: open the final save dialog, save the chosen output, stop recording, and open its
   browser-download location.

You can change extension shortcuts at `chrome://extensions/shortcuts` or the Firefox equivalent.
If a page was open while JShotz was installed, reloaded, or updated, refresh that page before
recording. Browser internal pages and the extension store cannot be recorded because browsers
protect them from extensions.

Every screenshot in the **Screenshots** list starts checked. Clear the checkbox beside any frame
you do not want in output. **Select all** is checked while every frame is included and clears
when any individual frame is removed. The choice remains for the current recording if the popup
closes and is reopened.

After resuming a folder, the same selection list contains the earlier and newly captured screenshots.
Only checked screenshots are included in checkpoint and final documents. Notes entered under a
screenshot are retained in the active recording and written as `[note]` after its heading.

---

## Where do my files go?

Everything is saved under your Downloads folder:

```
Downloads/Jshotz/JShotz_<date-time>/
```

JShotz prompts for this session-folder name before recording and pre-fills the timestamped standard.
You can replace it with an evidence name that suits the flow.

This includes your screenshots, selected PDF and/or Word documents, evidence documents, and a technical
`debugLog` inside `flow-manifest.json` for troubleshooting. The log is stored in the extension
background while you record, so it never interrupts a recording with a separate download prompt.

The custom base name you enter is used for `.pdf` and/or `.docx` files. Checkpoint defaults include
`_checkpoint_<date-time>` so repeated saves do not replace earlier checkpoints.

Evidence output uses the same folder as the stopped recording. If a selected evidence filename already
exists, JShotz creates a new version by appending `_<date-time>` before its extension.

When you resume from a folder, JShotz writes new files directly beside the earlier screenshots in
the folder you selected instead of creating a new Downloads session folder.

---

## Multiple tabs

If the page you're recording opens a new tab (like a sign-in redirect), JShotz follows it
automatically. Switching back and forth between tabs keeps capturing wherever you are. Pausing
does not remove those tracked tabs or child windows, so continuing follows the same browser flow.

---

## Need help?

If something doesn't look right, note roughly when it happened and what you were doing, and
share that along with the screenshot in question.

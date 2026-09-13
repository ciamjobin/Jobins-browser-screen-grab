# JShotz Quick Guide

**Version 3.14.0**

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
     can show DevTools or other apps).
3. Click **Start recording**.
4. Use the page normally — screenshots are taken automatically as you click and scroll.
5. To take a break without ending the session, click **Pause recording**. It becomes
   **Continue recording**; continuing keeps the same screenshots, numbering, and session folder.
6. Need a checkpoint without stopping? Click **Save checkpoint (Ctrl+S)**. Enter a file name,
   choose PDF, Word, or both, and JShotz keeps the current recording active.
7. Click **Save and stop (Ctrl+Alt+S)** to enter the same choices, save the selected documents,
   and end the recording. The download folder opens after a browser-download save completes.
8. Click **Start new recording (Ctrl+N)** to save the current flow with a custom name and selected
   formats, then begin a separate recording in a new session folder.
9. When you are done with the final flow, clear unwanted frames in the **Screenshots** list, then
   click **Stop recording**. The confirmation appears directly under that button: choose **Yes,
   keep** to choose a custom name and PDF, Word, or both, **Stop without document** to keep the
   captured files and manifest without a document, or **No, delete all** to discard the session.

You can change the capture source at any time without stopping the recording.

If Chrome restarts during an active recording, return to the restored page and open the JShotz
popup. The recording reconnects to that live tab and preserves the existing screenshots, numbering,
and session folder.

If a browser or extension crash leaves only an earlier screenshot folder, use **Resume capture from
folder**. JShotz loads that folder's screenshots, starts at the next number, and includes the old
and new screenshots in its checkpoint and final documents. If the selected folder has no previous PNG
or JPEG screenshots, JShotz starts a new recording there and writes the current flow to it.

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
| Capture with the keyboard | Press **Ctrl+Alt+Q** |
| Capture a DevTools panel | Open the panel, press **Alt+Shift+S** |
| Capture in 5 seconds (time to click into DevTools) | Click **Capture in 5s**, or press **Alt+Shift+D** |

---

## Getting the whole page in one shot

Turn on **"Whole-page shot for Ctrl+Alt+Q and Capture now"** in settings, then use one of those
two actions (or Capture in 5s) to capture the *entire* page — including everything below the
fold — without enlarging or reflowing the page. Everyday automatic captures (clicks, scrolling)
are left as normal single-screen shots so your view is never disturbed.

Very long pages are saved as adjacent, numbered parts instead of one oversized image; the parts
remain in order when you export a document. A progress bar appears in the popup and on the page while
the whole-page capture is running, then disappears when it finishes.

For ordinary documents, Chrome may show a "started debugging this browser" banner for a moment.
That browser notice clears on its own; JShotz does not resize the page to take the capture.

---

## Saving documents while you continue

Click **Save checkpoint (Ctrl+S)** at any point to open a compact save dialog. Enter the custom
base name, select PDF, Word, or both, and save a checkpoint without stopping the recording. The
current screenshots, numbering, and output selection remain available for later work.

Use **Export document so far** for the same named checkpoint output from the popup. The
**Preselect PDF in output dialogs** option controls the initial format choice; each dialog always
lets you choose PDF, Word, or both.

Choose **Start new recording (Ctrl+N)** when the next piece of work should be a separate flow.
JShotz keeps all files from the completed flow, saves the chosen documents using the current
selection, and starts the new flow at screenshot 1 in a new Downloads session folder.

## Modal windows

JShotz captures a modal once when it opens. While a fixed modal is visible, scrolling the page
behind it does not create screenshots. A large modal with a real scrollable body is captured when
you scroll substantially inside it; small modal scroll areas are ignored. Modal buttons, edits,
and selected values create one settled screenshot each. Non-scrollable modals are exported as a
compact modal-only image instead of a full-page duplicate.

---

## Choose output screenshots and add notes

Every captured screenshot starts selected for document output. Before a checkpoint or final export:

1. Clear the checkbox beside any screenshot you do not want in the document.
2. Use **Select all** to include every screenshot again.
3. Use **Show older screenshots** when the recording has more than 50 captures.
4. Enter an optional note of up to 50 characters under a screenshot. A saved note appears after
   that screenshot's heading in brackets in PDF and Word output.

Your selection remains with the active recording when the popup closes. Only selected screenshots
appear in checkpoint and final documents.

---

## Resume an interrupted capture

1. Open the page where you want to continue the flow.
2. Click **Resume capture from folder** in the popup.
3. Choose the earlier session's screenshot folder in the native folder dialog and allow read/write
   access.
4. JShotz refreshes the **Screenshots** list with the earlier files and immediately captures the
   current page as the next screenshot.

When the selected folder has no previous PNG or JPEG screenshots, JShotz treats it as the current
flow's output folder instead. It immediately starts a new recording and confirms that captures are
being written to the selected folder.

New PNG files, checkpoint and final PDF/Word documents, and the refreshed `flow-manifest.json` are written
to that same selected folder. No browser tab is opened for this action. It is available in Chrome
and Edge; Firefox can record normally but cannot write directly into an arbitrary existing folder.
If Chrome or Edge asks for folder access again after a restart, the button becomes **Reconnect
capture folder**. Choose the same folder to continue without resetting the current flow.

---

## Shortcuts and common fixes

- `Ctrl+Alt+Q`: capture manually while the page has focus.
- `Alt+Shift+S`: capture the currently visible DevTools panel.
- `Alt+Shift+D`: start a five-second countdown, then capture. Use this when you need time to
   click into DevTools.
- `Ctrl+S`: open the checkpoint save dialog and keep recording after it is saved.
- `Ctrl+Alt+S`: open the final save dialog, save the chosen output, and stop recording.
- `Ctrl+N`: save the current flow with the chosen output, then start a separate recording.

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
Downloads/flow-captures/session_<date-time>/
```

This includes your screenshots, selected PDF and/or Word documents, and a technical `debugLog` inside
`flow-manifest.json` for troubleshooting. The log is stored in the extension background while
you record, so it never interrupts a recording with a separate download prompt.

The custom base name you enter is used for `.pdf` and/or `.docx` files. Checkpoint defaults include
`_checkpoint_<date-time>` so repeated saves do not replace earlier checkpoints.

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

# JShotz Quick Guide

**Version 3.13.7**

JShotz records your browsing as a series of screenshots and turns them into a PDF — handy for
documenting a process, a support case, or a step-by-step walkthrough.

---

## Getting started

1. Load JShotz as a browser extension, then click the JShotz icon in your toolbar. Do not open
   `popup.html` directly from its folder; it needs the browser extension runtime to record.
2. Choose a **Capture source**:
   - **Tab viewport only** — screenshots of the page you're on.
   - **API + Screenshot** — same, plus a table of the page's network calls under each shot.
   - **Screen / window** — share your whole screen, a window, or a tab (the only option that
     can show DevTools or other apps).
3. Click **Start recording**.
4. Use the page normally — screenshots are taken automatically as you click and scroll.
5. To take a break without ending the session, click **Pause recording**. It becomes
   **Continue recording**; continuing keeps the same screenshots, numbering, and session folder.
6. Clear unwanted frames in the **Screenshots** list, then click **Stop recording**, choose
   **Yes, keep**, and pick a PDF name. The PDF includes only the screenshots still checked;
   your original PNGs are kept in the session folder.

You can change the capture source at any time without stopping the recording.

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
remain in order when you export the PDF. A progress bar appears in the popup and on the page while
the whole-page capture is running, then disappears when it finishes.

For ordinary documents, Chrome may show a "started debugging this browser" banner for a moment.
That browser notice clears on its own; JShotz does not resize the page to take the capture.

---

## Saving a PDF partway through

Click **Export PDF so far** at any point to save everything captured up to that moment as a PDF,
without stopping the recording. Keep going afterward — your final PDF at "Stop recording" uses
the screenshots selected at that time.

---

## Choose PDF screenshots

Every captured screenshot starts selected for PDF output. Before a checkpoint or final export:

1. Clear the checkbox beside any screenshot you do not want in the PDF.
2. Use **Select all** to include every screenshot again.
3. Use **Show older screenshots** when the recording has more than 50 captures.

Your selection remains with the active recording when the popup closes. Only selected screenshots
appear in **Export PDF so far** and the PDF created when you stop the recording.

---

## Make a PDF from saved screenshots

1. Click **Create PDF from saved screenshots** in the popup.
2. Select the folder containing your PNG or JPEG screenshots.
3. Clear any images you do not want. JShotz orders files naturally by their folder path and name.
4. Enter a PDF name and click **Generate PDF**.

This is independent of recording, so it can turn a previous JShotz session or another folder of
screenshots into a new PDF.

---

## Shortcuts and common fixes

- `Ctrl+Alt+Q`: capture manually while the page has focus.
- `Alt+Shift+S`: capture the currently visible DevTools panel.
- `Alt+Shift+D`: start a five-second countdown, then capture. Use this when you need time to
   click into DevTools.

You can change extension shortcuts at `chrome://extensions/shortcuts` or the Firefox equivalent.
If a page was open while JShotz was installed, reloaded, or updated, refresh that page before
recording. Browser internal pages and the extension store cannot be recorded because browsers
protect them from extensions.

Every screenshot in the **Screenshots** list starts checked. Clear the checkbox beside any frame
you do not want in the PDF. **Select all** is checked while every frame is included and clears
when any individual frame is removed. The choice remains for the current recording if the popup
closes and is reopened.

The same selection list appears after choosing a folder in **Create PDF from saved screenshots**.
Only the checked PNG or JPEG files are included in that PDF.

---

## Where do my files go?

Everything is saved under your Downloads folder:

```
Downloads/flow-captures/session_<date-time>/
```

This includes your screenshots, the PDF, and a short technical log used only for
troubleshooting if something needs a closer look.

---

## Multiple tabs

If the page you're recording opens a new tab (like a sign-in redirect), JShotz follows it
automatically. Switching back and forth between tabs keeps capturing wherever you are. Pausing
does not remove those tracked tabs or child windows, so continuing follows the same browser flow.

---

## Need help?

If something doesn't look right, note roughly when it happened and what you were doing, and
share that along with the screenshot in question.

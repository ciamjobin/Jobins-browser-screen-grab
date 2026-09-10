# JShotz Quick Guide

**Version 3.12.0**

JShotz records your browsing as a series of screenshots and turns them into a PDF — handy for
documenting a process, a support case, or a step-by-step walkthrough.

---

## Getting started

1. Click the JShotz icon in your toolbar.
2. Choose a **Capture source**:
   - **Tab viewport only** — screenshots of the page you're on.
   - **API + Screenshot** — same, plus a table of the page's network calls under each shot.
   - **Screen / window** — share your whole screen, a window, or a tab (the only option that
     can show DevTools or other apps).
3. Click **Start recording**.
4. Use the page normally — screenshots are taken automatically as you click and scroll.
5. Clear unwanted frames in the **Screenshots** list, then click **Stop recording**, choose
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
fold — without scrolling your screen. Everyday automatic captures (clicks, scrolling) are left
as normal single-screen shots so your view is never disturbed.

You may see a brief flicker, and Chrome may show a "started debugging this browser" banner for
a moment — both are expected and clear on their own.

---

## Saving a PDF partway through

Click **Export PDF so far** at any point to save everything captured up to that moment as a PDF,
without stopping the recording. Keep going afterward — your final PDF at "Stop recording" uses
the screenshots selected at that time.

---

## Choose PDF screenshots

Every screenshot in the **Screenshots** list starts checked. Clear the checkbox beside any frame
you do not want in the PDF. **Select all** is checked while every frame is included and clears
when any individual frame is removed.

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
automatically. Switching back and forth between tabs keeps capturing wherever you are.

---

## Need help?

If something doesn't look right, note roughly when it happened and what you were doing, and
share that along with the screenshot in question.

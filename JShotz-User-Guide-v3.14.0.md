# JShotz User Guide

**Version 3.14.0**

JShotz is a browser extension for Chrome, Edge, and Firefox that records a browsing flow as a
sequence of timestamped, watermarked screenshots and exports them as a PDF, with an optional
table of API calls captured under each step. It's built for documenting test flows, support
tickets, and step-by-step evidence of what happened in a browser session.

---

## Before you begin

- Record ordinary web pages. Browsers protect internal pages such as `chrome://` and extension
  store pages, so JShotz cannot inject its click and scroll capture helpers there.
- JShotz observes page fetch/XHR calls only during an **API + Screenshot** recording. Tab viewport
  and Screen/window modes leave site networking untouched.
- Keep the browser tab focused when using the manual `Ctrl+Alt+Q` shortcut.
- Treat **API + Screenshot** recordings as sensitive evidence. Request URLs, payloads, and
  responses can contain credentials, personal data, or other information that should not be
  shared outside the intended audience.

---

## 1. Installing the extension

**Chrome / Edge**
1. Unzip `JShotz-3.14.0-chrome-edge.zip`.
2. Go to `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder that contains `manifest.json`.
5. If updating, remove or disable the old version first so only one JShotz copy is loaded.

**Firefox**
1. Unzip `JShotz-3.14.0-firefox.zip`.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the `manifest.json` inside the unzipped folder.
4. Firefox 128+ is required.

Once loaded, pin the JShotz icon to your toolbar for easy access.

### Updating JShotz

After reloading or updating the extension, refresh every tab that was already open before you
record with it. Closing and reopening the target tab is the most reliable option. Chrome keeps
the old page script alive until the tab reloads and may show **Extension context invalidated** in
the extension's error list. Delete that old error card after refreshing the tab; it does not
indicate a problem with a newly opened or refreshed recording page.

---

## 2. The popup

Click the JShotz icon to open the popup. It has three parts:

- **Status line** — shows *Idle*, *Recording · N screenshot(s)*, *Paused · N screenshot(s)*,
  or an error message.
- **Settings** — capture source and behavior options (locked once recording starts, except the
  capture source, which can be changed mid-recording).
- **Actions** — Start/Stop, Pause/Continue, Capture now, Capture in 5s, Save checkpoint, Save and
  stop, Start new recording, Export document so far, and Resume capture from folder.
- **Screenshots list** — a live list of what's been captured so far in the current session and
  checkboxes that choose the screenshots included in output, plus an optional 50-character note
  for each screenshot.

### Folder access fallback

If a resumed capture folder no longer allows writes, JShotz keeps recording instead of dropping
screenshots. New PNG files are saved in the normal Downloads session folder while the restored and
new frames remain available for final documents. The popup changes its folder button to **Reconnect
capture folder**; select the original folder to write subsequent PNGs and final documents there
again. An empty selected folder is also valid: JShotz reconnects to it and confirms that the
current flow is being captured there.

Open this popup from the browser toolbar after loading JShotz as an extension. Opening
`popup.html` directly from its source folder cannot start a recording because browser extension
APIs are unavailable there.

---

## 3. Capture source (modes)

| Mode | What it captures | Notes |
|---|---|---|
| **Tab viewport only** | The visible area of the recorded tab | Default mode, works everywhere |
| **API + Screenshot** | Same as Tab, plus a table of intercepted `fetch`/XHR calls under each screenshot | Shows request URL, origin/referer, payload, and response; failed calls are highlighted |
| **Screen / window (DevTools + taskbar)** | A shared screen, window, or tab surface via the browser's own share picker | The only mode that can show DevTools, the taskbar, or other applications |

**You can switch modes without stopping the recording.** Pick a different option from the
dropdown at any time. Switching *to* Screen/window mode opens a small picker window — click
**Share** in it and choose what to share. The tab being recorded is automatically brought to
the front first, since the picker needs a real click.

If Screen/window mode's share source ends (you click "Stop sharing", or close the shared
window), the recording automatically falls back to Tab-viewport captures rather than failing.

API mode begins collecting newly observed `fetch` and XHR calls while it is selected. It does
not add network details retroactively to screenshots that were captured in another mode.

---

## 4. Settings

- **Capture on every button click** — automatically screenshot after clicks on buttons, links,
  checkboxes, and similar controls.
- **Capture every 60% of a screen scrolled, and at the end** — automatically screenshot as you
  scroll, roughly every 60% of a screenful (so consecutive shots overlap), plus one at the very
  bottom of the page.
- **Stamp clock + time zone on each shot** — adds a small timestamp banner to each screenshot.
- **Whole-page shot for Ctrl+Alt+Q and "Capture now" only** — see [Section 6](#6-full-page-whole-page-capture).
- **Save individual PNG files** — save each screenshot as its own PNG in the session folder.
- **Preselect PDF in output dialogs** — starts each output dialog with PDF selected; you can
  choose PDF, Word, or both for every export.

During a recording, the behavior checkboxes are locked so the session stays consistent. The
**Capture source** menu remains available, allowing you to switch modes without ending the
session.

---

## 5. Starting, capturing, and stopping

1. Open the tab you want to record, then click **Start recording** in the popup.
2. Use the page normally. Screenshots are taken automatically per your settings, and you can
   also trigger one manually at any time (see below).
3. When a page you're recording opens a **new tab** (e.g. a sign-in redirect), JShotz follows
   it automatically — that tab is brought to the front and becomes part of the recording.
   Switching back to the original tab (or to any other tab that flow has opened) resumes
   capturing from wherever you actually are.
4. To temporarily suspend screenshots without ending the session, click **Pause recording**.
  The button changes to **Continue recording**. While paused, JShotz keeps the screenshot list,
  output selections, capture numbering, session folder, and tracked tabs or child windows. Click
  **Continue recording** to add subsequent screenshots to that same session.
   If Chrome restarts during a recording, return to the restored page and open the JShotz popup.
   JShotz reconnects to that live tab, restores automatic and manual captures, and keeps the same
   screenshots, numbering, and session folder. Screen/window sharing cannot survive a browser
   restart, so that recording continues with tab-viewport capture until sharing is started again.
5. When you're done, click **Stop recording**. Use the **Screenshots** list to clear any frames
  you do not want in output. **Select all** starts checked and automatically clears when any
  individual screenshot is unchecked. This choice remains for the current recording if the popup
  closes and is reopened. You'll then be asked whether to keep the files:
   - **Yes, keep** — prompts for a custom file name and PDF, Word, or both. It then saves all PNGs,
     the manifest, and selected documents. Each document contains only the checked screenshots,
     and the Downloads folder opens after final browser-download output completes.
   - **Stop without document** — keeps the captured PNGs and session manifest, but ends the
     recording without creating a document.
   - **No, delete all** — asks you to confirm, then removes everything from that session.

### Manual capture options

| Action | How | Notes |
|---|---|---|
| Capture now | Click **Capture now** in the popup | Immediate, uses whichever mode is active |
| Manual hotkey | Press **Ctrl+Alt+Q** while the page has focus | Works anywhere the page can receive keystrokes |
| DevTools panel capture | Press **Alt+Shift+S** while a DevTools panel is open | Captures exactly what's on screen, including the DevTools panel |
| Capture in 5s | Click **Capture in 5s**, or press **Alt+Shift+D** | Waits 5 seconds (with an on-page countdown badge) before capturing — use this when you need time to click into DevTools first, since Chrome blocks other shortcuts while DevTools has focus |

Manual captures are available only while recording is active and not paused.

### Saving while continuing

Use **Save checkpoint (Ctrl+S)** to open a checkpoint save dialog without stopping the active
recording. Enter a custom base name and select PDF, Word, or both. The screenshot list, numbering,
output selection, and current session folder remain unchanged.

Use **Save and stop (Ctrl+Alt+S)** to open the final save dialog. Once its selected documents are
saved, JShotz ends the recording using the same keep-files behavior as **Stop recording**.

Use **Start new recording (Ctrl+N)** when the next activity belongs in a separate flow. JShotz
prompts for a custom name and output formats, freezes and finalizes the current flow without
deleting its screenshots or manifest, then starts the new recording at screenshot 1 in its own
Downloads session folder.

The recorded JPEG frames are retained for output, regardless of the initial PDF preference, so a
later dialog can create PDF, Word, or both.

### Export document so far

Click **Export document so far** at any point during a recording to open a named checkpoint dialog
for the screenshots currently checked in the **Screenshots** list, without stopping. Select PDF,
Word, or both. The recording keeps going afterward, and final output uses the screenshots selected
at that time.

### Resume capture from folder

Use this action when a browser or extension crash leaves a prior set of screenshots but the active
recording cannot be recovered automatically:

1. Open the page where the flow should continue.
2. In the idle popup, click **Resume capture from folder**.
3. Choose the exact earlier screenshot folder in the native folder dialog and grant read/write
  access.

JShotz immediately reloads the **Screenshots** list from that folder and captures the current page
with the next sequence number. The earlier and new screenshots are selected for **Export document
so far** and final **Stop recording** output. New PNGs, PDF/Word documents, and `flow-manifest.json` are written
directly into the selected folder, and JShotz does not open a browser tab for this action.

If the selected folder has no previous PNG or JPEG screenshots, JShotz starts a new recording in
that folder instead. It displays: **No previous screenshots found in selected folder, JShotz is
still capturing the current flows to the selected folder.**

This workflow needs Chrome or Edge's native File System Access API. Firefox can record normally,
but cannot resume into an arbitrary existing folder.

After a browser restart, Chrome or Edge can require the folder permission again. JShotz changes
the action to **Reconnect capture folder**; choose the same folder and the existing recording,
screenshots, and sequence number continue unchanged.

### Modal capture behavior

JShotz takes one screenshot when a modal opens. A fixed modal suppresses page scrolling captures
behind it. Only a large modal with a genuinely scrollable body produces a `modal-scrolled` capture
after substantial movement. Buttons, input edits, and committed dropdown selections inside a modal
each create one settled screenshot. For a modal with no scrollbar, JShotz exports a compact image
of the modal rather than duplicating the entire page.

---

## 6. Full-page (whole-page) capture

When **"Whole-page shot"** is enabled, the following triggers capture the *entire* scrollable
page instead of just the visible area — **without visibly scrolling your screen**:

- **Ctrl+Alt+Q**
- **Capture now**
- **Capture in 5s**

Everything else (clicks, scrolling, field edits, navigation) stays as ordinary viewport shots,
so your view is never disturbed by the automatic captures.

**How it works, and what to expect:**
- For a page whose content naturally extends below the viewport, Chromium rasterizes the document
  beyond its existing viewport. JShotz does not enlarge or reflow the page to render the shot.
- For an "app-shell" style page (a fixed header/sidebar with an inner scrolling panel), JShotz
  scrolls just that inner panel, then returns the panel to its original position. The surrounding
  page layout stays in place.
- Long captures are split into sequential, bounded **part N of M** screenshots at one shared
  scale. Adjacent parts preserve the full page without a giant image, and are exported as
  consecutive PDF pages. Compact captures crop unneeded blank canvas conservatively.
- A progress bar appears in the popup and on the page while the capture runs. It is hidden before
  each screenshot and removed when capture completes.
- If DevTools is already open on the tab, whole-page capture is skipped for that shot (DevTools
  and the extension can't share the same debugging connection) and a normal single-frame
  screenshot is taken instead.
- Chrome may show a **"started debugging this browser"** banner for an ordinary-document capture.
  This is a hard Chrome platform notice with no way to hide it; it disappears immediately after
  the shot. App-shell stitch capture does not attach the debugger.

---

## 7. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+Q` | Manual capture (page must have focus) |
| `Alt+Shift+S` | Capture the current DevTools panel |
| `Alt+Shift+D` | Capture in 5 seconds |
| `Ctrl+S` | Open a named checkpoint save dialog and continue recording after saving |
| `Ctrl+Alt+S` | Open the final save dialog, save the chosen output, and stop recording |
| `Ctrl+N` | Save the current flow with the chosen output, then begin a separate recording |

The extension-command shortcuts can be assigned at `chrome://extensions/shortcuts` (or the
Firefox equivalent). The Ctrl+S, Ctrl+Alt+S, and Ctrl+N flow controls are page shortcuts while a
recording is active.

---

## 8. Output selection, notes, and saved files

Every capture starts selected for document output. Clear the checkbox beside an unwanted screenshot,
or use **Select all** to restore the full set. For large sessions, the popup initially shows the
50 newest screenshots; use **Show older screenshots** to reveal earlier ones. The current
selection is preserved while the session is active, even when the popup closes.

The same selection controls **Save checkpoint**, **Save and stop**, **Export document so far**,
and final output created through **Stop recording**. Every output dialog accepts a custom base
name and lets you choose PDF, Word, or both:

- With **Save individual PNG files** enabled, JShotz saves each captured screenshot separately.
- **Stop without document** always retains the captured files and session manifest but skips
  PDF and Word creation for that stop operation.
- The **Preselect PDF in output dialogs** preference changes only the initial dialog choice;
  output frames are retained so Word remains available later.

When resuming a selected folder, JShotz keeps PNG and document output available so the older and new
screenshots stay together in that folder.

The generated PDF and Word document use the page title as the heading for each captured step. Add
an optional note of up to 50 characters under a screenshot; it appears after that heading as
`[note]` in both document formats. Timestamp banners
appear only when **Stamp clock + time zone on each shot** was enabled. API tables appear only on
screenshots captured in **API + Screenshot** mode.

---

## 9. Troubleshooting

- After installing, reloading, or updating JShotz, refresh any target tab that was already open.
  This removes old injected page scripts and avoids an **Extension context invalidated** error.
- If the popup says JShotz is unavailable, reload the extension in the browser's extension page,
  then close and reopen the popup.
- If the Screen/window share picker is cancelled or the shared source closes, recording continues
  with Tab viewport captures. Select Screen/window again when you are ready to share a surface.
- During a whole-page capture, wait for the progress bar to complete before capturing again.
  **Capture now** is temporarily disabled while that work is in progress.
- If a page does not record clicks or scrolling, confirm that it is an ordinary website rather
  than a browser-protected page, then refresh the tab and start a new recording.
- If JShotz says **Capture skipped: JShotz needs access to the current page**, Chrome has revoked
  its temporary tab access, commonly after a cross-site redirect. Open the JShotz popup in the
  current tab, then continue recording. For automatic capture across websites, open JShotz's
  extension details and set **Site access** to **On all sites**. The skipped-capture detail stays
  in the final manifest's `debugLog`; it does not create a separate download.

---

## 8. Where your files go

Each recording creates a folder in your browser's default download location:

```
Downloads/
  flow-captures/
    session_<timestamp>/
      001_<timestamp>_<label>.png
      002_<timestamp>_<label>.png
      ...
      flow-manifest.json        (list of every capture plus diagnostic debugLog)
      <custom-name>.pdf         (when PDF is selected)
      <custom-name>.docx        (when Word is selected)
      <custom-name>_checkpoint.pdf / .docx   (for checkpoint saves)
```

    Pausing does not create another folder. When you click **Continue recording**, new screenshots
    keep the next number and are written beside the screenshots already shown in the list.

  When you use **Resume capture from folder**, the selected existing folder becomes the working
  folder. JShotz writes the new PNGs, checkpoint and final PDF/Word documents, and updated `flow-manifest.json`
  there instead of creating a new Downloads session folder.

---

## 9. The debug log

JShotz keeps the newest 1,000 diagnostic lines in background extension storage while recording.
This prevents a separate diagnostic-file download or save prompt from interrupting pause,
continue, capture, mode-switch, checkpoint-export, or error handling. When you keep a session,
the same entries are included as `debugLog` in `flow-manifest.json` beside the screenshots.

The log lists capture triggers, mode, success/failure, timing, mode switches, recovery events,
and errors. If you ever need help diagnosing an issue, share the relevant `debugLog` lines from
the final manifest.

If you choose "delete all," no diagnostic file is downloaded. The in-progress log remains in
extension storage until you start a new recording.

---

## 10. Known limitations

- The "started debugging this browser" banner during whole-page captures cannot be hidden —
  this is a Chrome security notice, not a bug.
- Whole-page capture is skipped while DevTools is open on the recorded tab.
- Multi-tab and child-window following remains active while a session is paused and when the
  background service worker restarts.
- A horizontally-scrolling element on a page (e.g. a carousel) is captured exactly as it
  appears at the time — whole-page capture only extends vertically.
- Reloading or updating JShotz requires refreshing any already-open recording tabs before use.
- Resume capture from folder requires Chrome or Edge; Firefox does not provide writable native
  folder handles to extensions.

---

## 11. Getting help

If something isn't working as expected:
1. Note the approximate time and what you were doing (which button, which page).
2. Open `flow-manifest.json` from that session's folder and find the matching `debugLog` lines.
3. Share the page URL (or a general description if it's private), the log excerpt, and — if
   relevant — the screenshot in question.

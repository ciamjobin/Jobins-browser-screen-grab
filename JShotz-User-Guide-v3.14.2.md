# JShotz User Guide

**Version 3.14.2**

JShotz is a browser extension for Chrome, Edge, and Firefox that records a browsing flow as clean
screenshots and exports PDF or Word documents. Each document shows the action time above its image
and recorder attribution in the footer, with an optional table of API calls captured under each
step. It's built for documenting test flows, support tickets, and step-by-step evidence of what
happened in a browser session.

---

## Before you begin

- Record ordinary web pages. Browsers protect internal pages such as `chrome://` and extension
  store pages, so JShotz cannot inject its click and scroll capture helpers there.
- JShotz observes page fetch/XHR calls only during an **API + Screenshot** recording. Tab viewport
  and Screen/window modes leave site networking untouched.
- Keep the browser tab focused when using the whole-page `Alt+Shift+J` shortcut.
- Treat **API + Screenshot** recordings as sensitive evidence. Request URLs, payloads, and
  responses can contain credentials, personal data, or other information that should not be
  shared outside the intended audience.

---

## 1. Installing the extension

**Chrome / Edge**
1. Unzip `JShotz-3.14.2-chrome-edge.zip`.
2. Go to `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder that contains `manifest.json`.
5. If updating, remove or disable the old version first so only one JShotz copy is loaded.

**Firefox**
1. Unzip `JShotz-3.14.2-firefox.zip`.
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
  an interrupted-recording backup notice, or an error message.
- **Settings** — capture source and behavior options (locked once recording starts, except the
  capture source, which can be changed mid-recording).
- **Actions** — Start/Stop, Pause/Continue, Capture now, Capture in 5s, Save checkpoint, and
  Resume capture from folder.
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
  checkboxes, and similar controls. Link destinations wait for their rendered page state before
  JShotz takes the screenshot. Its title and URL are read from that rendered page, and stale
  browser events are skipped rather than being attached to a later screen.
- **Capture every 60% of a screen scrolled, and at the end** — automatically screenshot as you
  scroll, roughly every 60% of a screenful (so consecutive shots overlap), plus one at the very
  bottom of the page.
- **Whole-page shots for manual captures** — see [Section 6](#6-full-page-whole-page-capture).
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
  JShotz retains the time each action occurred even when it waits for the page to render. The
  screenshot list, PDF/Word output, and session manifest keep steps in action order, with one
  settled frame for each normal automatic action.
3. When a page you're recording opens a **new tab** (e.g. a sign-in redirect), JShotz follows
   it automatically — that tab is brought to the front and becomes part of the recording.
   Switching back to the original tab (or to any other tab that flow has opened) resumes
  capturing from wherever you actually are. This also covers external or `target="_blank"`
  links whose browser tab does not expose an opener relationship.
4. To temporarily suspend screenshots without ending the session, click **Pause recording**.
  The button changes to **Continue recording**. While paused, JShotz keeps the screenshot list,
  output selections, capture numbering, session folder, and tracked tabs or child windows. Click
  **Continue recording** to add subsequent screenshots to that same session.
  If the browser restarts or crashes during a recording, JShotz ends that session safely rather
  than attaching it to an arbitrary open tab. The popup reports the interruption, retains the
  stored screenshots, and offers **Generate evidences**. Start a new recording for a new flow, or
  use **Resume capture from folder** to continue a folder-backed flow.
5. When you're done, click **Stop recording**. Use the **Screenshots** list to clear any frames
  you do not want in output. **Select all** starts checked and automatically clears when any
  individual screenshot is unchecked. This choice remains for the current recording if the popup
  closes and is reopened. You'll then be asked whether to keep the files:
   - **Yes, keep** — prompts for a custom file name and PDF, Word, or both. It then saves all PNGs,
     the manifest, and selected documents. Each document contains only the checked screenshots.
     Choose **Save and stop (Ctrl+S)** to finish without opening the file location and receive a
     saved-file toast, or **Save, stop, and open file location (Ctrl+Alt+S)** to reveal the
     browser-download folder after final output completes.
   - **Stop without document** — keeps the captured PNGs, session manifest, and current interim
     PDF, but ends the recording without creating a final document.
   - **No, delete all** — asks you to confirm, then removes everything from that session, including
     its interim PDF.

After a keep-files stop, the completed screenshot list stays available in the popup. Click **Generate
evidences** to choose a custom base name, select PDF, Word, or both, and create another document from
the checked screenshots. JShotz writes evidence documents into the same selected folder or Downloads
session directory used by that recording. If an output document with the requested name already exists,
JShotz appends the creation timestamp to make a new version instead of replacing it. Evidence remains
available until you start a new recording.

### Manual capture options

| Action | How | Notes |
|---|---|---|
| Capture now | Click **Capture now** in the popup | Whole-page when enabled and direct capture is available; otherwise one visible frame |
| Whole-page hotkey | Press **Alt+Shift+J** while the page has focus | Same whole-page function as **Capture now**; otherwise one visible frame when direct capture is unavailable |
| DevTools panel capture | Press **Alt+Shift+K** while a DevTools panel is open | Captures exactly what's on screen, including the DevTools panel |
| Capture in 5s | Click **Capture in 5s**, or press **Alt+Shift+D** | Waits 5 seconds (with an on-page countdown badge) before capturing — use this when you need time to click into DevTools first, since Chrome blocks other shortcuts while DevTools has focus |

Manual captures are available only while recording is active and not paused.

### Saving while continuing

Use **Save checkpoint (Shift+Ctrl+S)** to open a checkpoint save dialog without stopping the active
recording. Enter a custom base name and select PDF, Word, or both. The screenshot list, numbering,
output selection, and current session folder remain unchanged. A toast confirms whether the
checkpoint save succeeded or failed.

Use **Save and stop (Ctrl+S)** to open the final save dialog. Once its selected documents are saved,
JShotz ends the recording using the same keep-files behavior as **Stop recording**. A toast confirms
the saved file name without opening its location.

Use **Save, stop, and open file location (Ctrl+Alt+S)** to open the same final save dialog. Once its
selected documents are saved, JShotz ends the recording and opens the browser-download location.
For a directly selected capture folder, browser security does not expose the folder's native path;
JShotz opens Downloads instead.

The recorded JPEG frames are retained for output, regardless of the initial PDF preference, so a
later dialog can create PDF, Word, or both. After a keep-files stop, **Generate evidences** uses those
retained frames and the current checked screenshots to create additional documents.

### Automatic interim backup

After screenshot 5 and every five screenshots after that, JShotz updates one
`JShotz-interim.pdf`. It overwrites the existing file in the selected capture folder or the
session's Downloads folder, so repeated backups do not create a growing set of files. The latest
interim PDF remains available if the browser crashes, closes accidentally, or the recording stops
without a document. A successful final PDF/Word save, or a successful post-stop **Generate
evidences** save, removes the interim PDF.

### Resume capture from folder

Use this action when a browser or extension crash leaves a prior set of screenshots but the active
recording cannot be recovered automatically:

1. Open the page where the flow should continue.
2. In the idle popup, click **Resume capture from folder**.
3. Choose the exact earlier screenshot folder in the native folder dialog and grant read/write
  access.
4. Click **Start recording**.

JShotz reloads the **Screenshots** list from that folder and captures the current page with the next
sequence number. The earlier and new screenshots are selected for checkpoint and final **Stop
recording** output. New PNGs, PDF/Word documents, and `flow-manifest.json` are written directly
into the selected folder, and JShotz does not open a browser tab for this action.

If the selected folder has no previous PNG or JPEG screenshots, Start recording starts a new recording
in that folder instead. It displays: **No previous screenshots found in selected folder, JShotz is
still capturing the current flows to the selected folder.** Without selecting a resume folder, Start
recording always creates a fresh session and Downloads folder after a stop or browser restart.

This workflow needs Chrome or Edge's native File System Access API. Firefox can record normally,
but cannot resume into an arbitrary existing folder.

After a browser restart, the active recording has already ended safely. To continue a folder-backed
flow, use **Resume capture from folder** and choose the same folder. **Reconnect capture folder**
is for an active recording whose folder permission changes while the browser remains open.

### Modal capture behavior

JShotz takes one screenshot when a modal opens. A fixed modal suppresses page scrolling captures
behind it. Only a large modal with a genuinely scrollable body produces a `modal-scrolled` capture
after substantial movement. Buttons, input edits, and committed dropdown selections inside a modal
each create one settled screenshot. For a modal with no scrollbar, JShotz exports a compact image
of the modal rather than duplicating the entire page. Cookie-consent banners and similar wide
in-page consent overlays remain in the full viewport image, so the affected page and its banner
appear together as one screenshot.

---

## 6. Full-page (whole-page) capture

When **"Whole-page shots for manual captures"** is enabled, the following explicit page controls
capture the *entire* scrollable page instead of just the visible area when direct capture is available:

- **Alt+Shift+J**
- **Capture now**

Automatic captures (clicks, scrolling, field edits, and navigation) always remain one ordinary
viewport shot, including narrow responsive layouts and DevTools Device Mode.

**How it works, and what to expect:**
- For a page whose content naturally extends below the viewport, Chromium rasterizes the document
  beyond its existing viewport. JShotz does not enlarge or reflow the page to render the shot.
- Long captures are split into sequential, bounded **part N of M** screenshots at one shared
  scale. Adjacent parts preserve the full page without a giant image and are exported as consecutive
  PDF pages.
- A progress bar appears in the popup and on the page while the capture runs. It is hidden before
  each screenshot and removed when capture completes.
- If direct capture is unavailable, including in Firefox, DevTools Device Mode, a page already
  attached to DevTools, or an app-shell page with an inner scroller, JShotz captures the current
  visible viewport once. It never scrolls the document or an inner pane to construct the image.
- Stopping a recording cancels an in-progress whole-page capture promptly. Its unfinished frame is
  discarded and cannot be added after the session stops.
- Chrome may show a **"started debugging this browser"** banner for an ordinary-document capture.
  This is a hard Chrome platform notice with no way to hide it; it disappears immediately after
  the shot.

---

## 7. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+J` | Whole-page capture (page must have focus) |
| `Alt+Shift+K` | Capture the current DevTools panel |
| `Alt+Shift+D` | Capture in 5 seconds |
| `Shift+Ctrl+S` | Open a named checkpoint save dialog and continue recording after saving |
| `Ctrl+S` | Open the final save dialog, save the chosen output, and stop recording without opening the file location |
| `Ctrl+Alt+S` | Open the final save dialog, save the chosen output, stop recording, and open its browser-download location |

The extension-command shortcuts can be assigned at `chrome://extensions/shortcuts` (or the
Firefox equivalent). The Shift+Ctrl+S, Ctrl+S, and Ctrl+Alt+S flow controls are page shortcuts
while a recording is active.

---

## 8. Output selection, notes, and saved files

Every capture starts selected for document output. Clear the checkbox beside an unwanted screenshot,
or use **Select all** to restore the full set. For large sessions, the popup initially shows the
50 newest screenshots; use **Show older screenshots** to reveal earlier ones. The current
selection is preserved while the session is active, even when the popup closes.

The same selection controls **Save checkpoint**, **Save and stop**, **Save, stop, and open file
location**, **Generate evidences**, and final output created through **Stop recording**. Every output
dialog accepts a custom base name and lets you choose PDF, Word, or both:

- With **Save individual PNG files** enabled, JShotz saves each captured screenshot separately.
- **Stop without document** always retains the captured files and session manifest but skips
  PDF and Word creation for that stop operation.
- The **Preselect PDF in output dialogs** preference changes only the initial dialog choice;
  output frames are retained so Word remains available later.
- **Save, stop, and open file location (Ctrl+Alt+S)** reveals the final browser-download output.
  A directly selected capture folder has no native path available to a browser extension, so JShotz
  opens Downloads instead.
- **Generate evidences** is available after a keep-files stop. It uses the same output folder as that
  stopped recording and appends a timestamp when the requested evidence filename already exists.

When resuming a selected folder, JShotz keeps PNG and document output available so the older and new
screenshots stay together in that folder.

The generated PDF and Word document use the page title as the heading for each captured step. Add
an optional note of up to 50 characters under a screenshot; it appears after that heading as
`[note]` in both document formats. The action time appears immediately above the image and
**Captured by Jobin's Screenshots** appears in the document footer; neither is overlaid on the
captured page. API tables appear only on screenshots captured in **API + Screenshot** mode.

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
      JShotz-interim.pdf        (updated after every fifth screenshot until final save)
      flow-manifest.json        (list of every capture plus diagnostic debugLog)
      <custom-name>.pdf         (when PDF is selected)
      <custom-name>.docx        (when Word is selected)
      <custom-name>_checkpoint.pdf / .docx   (for checkpoint saves)
      <custom-name>_<timestamp>.pdf / .docx  (when a same-named evidence document already exists)
```

    Pausing does not create another folder. When you click **Continue recording**, new screenshots
    keep the next number and are written beside the screenshots already shown in the list.

  When you use **Resume capture from folder** and then click **Start recording**, the selected existing
  folder becomes the working folder. JShotz writes the new PNGs, checkpoint and final PDF/Word
  documents, post-stop evidence documents, interim PDF, and updated `flow-manifest.json` there
  instead of creating a new Downloads session folder.

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
- When DevTools is open on the recorded tab, a manual whole-page request saves one visible frame
  rather than scrolling the page to assemble a long capture.
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

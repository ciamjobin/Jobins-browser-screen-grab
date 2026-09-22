# JShotz Test Cases

Updated: 2026-09-17

This catalog preserves the current automated regression cases for future releases. The named tests
in the linked source files remain the executable source of truth.

## Run The Suites

| Command | Coverage |
| --- | --- |
| `npm test` | All Node-based JShotz regression tests |
| `npm run test:popup` | Popup browser regression tests |

`npm run test:popup` requires Node.js 20 or later because of the installed Playwright version.

## Capture Behavior

Automated source: `tests/content-capture.test.mjs`

| ID | Test case |
| --- | --- |
| CAP-01 | Captures a selected dropdown value but ignores dropdown opening and scrolling |
| CAP-02 | Captures a fixed modal once and only records intentional modal actions |
| CAP-03 | Treats an aria-modal window as a modal capture surface |
| CAP-04 | Detects an existing element when aria-modal is enabled |
| CAP-05 | Does not capture the underlying click while an asynchronously opened modal appears |
| CAP-06 | Does not recapture a re-rendered modal but captures a distinct modal |
| CAP-07 | Captures scrolling only inside a large scrollable modal |
| CAP-08 | Does not capture scrolls from an ordinary modal with a scrollbar |
| CAP-09 | Drops a pending page-scroll capture when a modal opens |
| CAP-10 | Opens the appropriate output dialog for recorder hotkeys |
| CAP-11 | Captures a cookie consent banner with its underlying page instead of cropping it |
| CAP-12 | Captures nested, ARIA-expanded, and accessible link controls before navigation |
| CAP-13 | Preserves original action time and emits one settled click frame through delayed capture paths |

## Document Output

Automated source: `tests/docx.test.mjs` and `tests/exporter.test.mjs`

| ID | Test case |
| --- | --- |
| DOC-01 | Builds a Word document with screenshot headings, bracketed notes, and embedded JPEGs |
| DOC-02 | Renders screenshot notes in PDF headings |
| DOC-03 | Removes characters that are illegal in Office Open XML text |
| DOC-04 | Places a widescreen screenshot directly below its time metadata in PDF output |
| DOC-05 | Places a tall whole-page capture part at a readable width in PDF output |
| EXP-01 | Exports fallback PDFs as data URLs without calling createObjectURL |
| EXP-02 | Exports fallback PDF and Word files from one stored capture |
| EXP-03 | Includes the checkpoint request ID in exporter completion messages |
| EXP-04 | Orders exported frames by action time, then request order for frames from the same action |
| EXP-05 | Uses a deliberate overwrite action for an interim PDF download |
| EXP-06 | Suppresses Chrome's download UI immediately before exporter output |

## Image And API Processing

Automated source: `tests/image-worker.test.mjs` and `tests/page-hook.test.mjs`

| ID | Test case |
| --- | --- |
| IMG-01 | Maps compact modal CSS bounds to screenshot pixels with a surrounding gutter |
| IMG-02 | Clamps compact modal crop bounds and ignores malformed or non-compact descriptors |
| API-01 | Only hooks page networking while API capture is explicitly enabled |

## Popup Output

Automated source: `tests/popup-output.spec.js`

| ID | Test case |
| --- | --- |
| POP-01 | Shows separate final save actions and removes obsolete popup actions |
| POP-02 | Ctrl+Shift+S opens only the checkpoint filename panel |
| POP-03 | Ctrl+S opens its matching final-save filename panel, then saves and stops with a toast without opening the file location |
| POP-04 | Ctrl+Alt+S opens its matching location-save filename panel, then saves, stops, and requests the file location |
| POP-05 | Generates selected PDF and Word evidence documents after a recording stops |
| POP-06 | Shows an interrupted-session backup notice while retaining evidence generation |

## Recording And Folder Recovery

Automated source: `tests/recording-recovery.test.mjs`

| ID | Test case |
| --- | --- |
| REC-01 | Requests folder write permission immediately from a user gesture |
| REC-02 | Recovers a recording after stale tab IDs, then pauses, continues, and captures |
| REC-03 | Saves a checkpoint without stopping and continues the same recording |
| REC-04 | Keeps the automatic interim PDF when stopping without a final document |
| REC-05 | Reveals a final output location only after an explicit request and recording stop |
| REC-06 | Falls back to Downloads when the output file location cannot be revealed directly |
| REC-07 | Resumes a selected screenshot folder and writes the combined flow there |
| REC-08 | Uses an empty selected folder for a new folder-backed recording |
| REC-09 | Skips unreadable previous images and continues recording in the selected folder |
| REC-10 | Starts a new folder-backed recording when all previous images are unreadable |
| REC-11 | Uses a prepared resume folder once, then starts fresh after stopping |
| REC-12 | Starts fresh after browser startup when a resume folder was only selected |
| REC-13 | Reconnects an active recording to an empty selected capture folder |
| REC-14 | Stops and saves custom-named PDF and Word documents together in the selected folder |
| REC-15 | Opens a non-revealing final-save output dialog without ending the recording |
| REC-16 | Persists a 50-character screenshot note with its capture frame |
| REC-17 | Generates timestamp-versioned evidence documents from a stopped selected-folder recording |
| REC-18 | Generates timestamp-versioned evidence documents in the prior Downloads session directory |
| REC-19 | Keeps a checkpoint completion that arrives while its exporter window is opening |
| REC-20 | Ignores another output window completion while saving a checkpoint |
| REC-21 | Waits for the rendered page before capturing a title-driven SPA transition |
| REC-22 | Keeps action time and recorder attribution outside captured image pixels |
| REC-23 | Suppresses the browser download UI while generating evidence in Downloads |
| REC-24 | Waits for a navigation link destination to render before taking its screenshot with matching title, URL, and action time |
| REC-25 | Skips a stale title-change event rather than labeling a later screen with it |
| REC-26 | Captures a new-tab link from the rendered page it opens |
| REC-27 | Captures sequential new-tab links opened from the same parent page |
| REC-28 | Captures and tracks a no-opener new-tab link regardless of browser event order |
| REC-29 | Ends an active recording on browser startup without deleting retained screenshots |
| REC-30 | Removes the Downloads interim PDF after a successful final document save |
| REC-31 | Removes the interim PDF when the user discards the session |
| REC-32 | Reasserts hidden download UI immediately before an automatic PNG download |
| REC-33 | Uses one visible frame when a manual responsive capture cannot use CDP |
| REC-34 | Captures an automatic responsive click as one visible frame |
| REC-35 | Stops promptly while a direct whole-page capture is still in progress |

## Playwright Starter Cases

Automated source: `tests/example.spec.js`

| ID | Test case |
| --- | --- |
| EX-01 | Has title |
| EX-02 | Get started link |
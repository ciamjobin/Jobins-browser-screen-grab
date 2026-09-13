// Declared in the manifest AND injected programmatically when a recording starts (to seed a page
// that was already open). Both can land in the same isolated world, so without this guard the
// top-level declarations below re-run and throw "Identifier ... has already been declared", which
// kills the whole script and silently stops click/scroll capture on that page.
(() => {
if (window.__jshotzContentReady) return;
window.__jshotzContentReady = true;

const API_CAPTURE_ATTRIBUTE = 'data-jshotz-api-capture';
const API_CAPTURE_EVENT = 'jshotz-api-capture-change';

function setApiCaptureEnabled(enabled) {
  document.documentElement.setAttribute(API_CAPTURE_ATTRIBUTE, enabled ? '1' : '0');
  document.documentElement.dispatchEvent(new Event(API_CAPTURE_EVENT));
}

const INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  'summary',
  '[type="submit"]'
].join(',');

const OPTION_SELECTOR = [
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="treeitem"]',
  'option'
].join(',');

const LIST_SELECTOR = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="combobox"]',
  'datalist'
].join(',');

const DIALOG_SELECTOR = ['dialog', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]'].join(',');
const MODAL_SCROLL_MIN_VIEWPORT = 320;
const MODAL_SCROLL_MIN_DIALOG_RATIO = 0.65;
const MODAL_SCROLL_MIN_SCROLLER_RATIO = 0.55;
const MODAL_SCROLL_MIN_OVERFLOW = 240;

let lastSent = { key: '', at: 0 };
let editTimer = 0;
let selectionTimer = 0;
let dialogTimer = 0;
let scrollTimer = 0;
let suppressScrollUntil = 0;
let fullPageCaptureActive = false;
let countdownTimer = 0;
let activeDialogFingerprint = null;
const scrollAnchors = new WeakMap();
const capturedDialogs = new WeakSet();

function describe(element) {
  const candidates = [
    element.getAttribute?.('aria-label'),
    element.innerText,
    element.value,
    element.getAttribute?.('title'),
    element.name,
    element.id
  ];

  for (const candidate of candidates) {
    const text = (candidate || '').trim().replace(/\s+/g, ' ');
    if (text) return text.slice(0, 80);
  }
  return element.tagName ? element.tagName.toLowerCase() : 'element';
}

function sendRuntimeMessage(message) {
  try {
    Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
  } catch {}
}

function isScrollCapture(reason) {
  return reason === 'scrolled' || reason === 'modal-scrolled';
}

function requestCapture(reason, label, options = {}) {
  const key = `${reason}:${label}`;
  const now = Date.now();
  if (key === lastSent.key && now - lastSent.at < 800) return;
  lastSent = { key, at: now };

  // Chromium can briefly resize the visible viewport while it displays a debugger notice during
  // ordinary full-page capture; that must not read as a user scroll.
  if (!isScrollCapture(reason)) suppressScrollUntil = now + 2500;

  sendRuntimeMessage({ type: 'CLICK_CAPTURE', reason, label, ...options });
}

const SETTLE_QUIET_MS = 400;
const SETTLE_MAX_WAIT_MS = 8000;
const MODAL_OPEN_GRACE_MS = 500;
const BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[class*="spinner" i]',
  '[class*="loading" i]',
  '[class*="loader" i]'
].join(',');
const BUSY_TEXT_PATTERN = /please\s+wait|loading|retrieving/i;

// A button click on a client-rendered page often swaps in a loading spinner before the real next
// screen appears; capturing right away would just record the spinner. Waits until the DOM stops
// actively changing (or a hard cap is reached, in case something keeps animating indefinitely).
function waitForQuiet(quietMs, maxWaitMs) {
  return new Promise((resolve) => {
    let settleTimer = 0;
    const finish = () => {
      observer.disconnect();
      clearTimeout(settleTimer);
      clearTimeout(hardStop);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, quietMs);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    settleTimer = setTimeout(finish, quietMs);
    const hardStop = setTimeout(finish, maxWaitMs);
  });
}

// A pure CSS spinner (no DOM mutations while it spins) looks "quiet" to the observer above
// immediately, even though the page is still loading. This catches that case by name: if a visible
// busy indicator or "please wait" style message is still on screen, keep polling briefly instead of
// capturing it, up to the same overall cap.
function looksBusy() {
  if (document.querySelector(BUSY_SELECTOR)) return true;
  const text = document.body?.innerText || '';
  return BUSY_TEXT_PATTERN.test(text.slice(0, 500));
}

// A button click on a client-rendered page often swaps in a loading spinner before the real next
// screen appears. Both are worth keeping: the interim frame shows the action was taken, the settled
// one shows the result. Fires immediately, then again once the DOM stops changing.
async function requestCaptureAfterSettle(reason, label) {
  // Dialogs often mount after their click handler's async state update or entrance animation.
  // Give that small window to appear so its opening frame replaces the underlying page-click frame.
  await new Promise((resolve) => setTimeout(resolve, MODAL_OPEN_GRACE_MS));
  if (activeModal()) return;
  requestCapture(reason, label);

  const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
  await waitForQuiet(SETTLE_QUIET_MS, SETTLE_MAX_WAIT_MS);
  while (looksBusy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // A distinct reason so the settled shot is not deduped against the interim one by label alone;
  // the background still drops it if the page turned out not to have changed at all.
  if (activeModal()) return;
  requestCapture(`${reason}-loaded`, label);
}

function describeEditedField(element) {
  if (element instanceof HTMLInputElement && element.type === 'password') {
    return `${describe(element)} edited`;
  }
  return `${describe(element)} edited`;
}

function requestEditCapture(element) {
  const dialog = modalForElement(element);
  if (activeModal() && !dialog) return;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    const currentDialog = activeModal();
    if (currentDialog && currentDialog !== dialog) return;
    const activeDialog = dialog && isVisible(dialog) ? dialog : null;
    requestCapture(
      activeDialog ? 'modal-edited' : 'field-edited',
      describeEditedField(element),
      activeDialog ? modalCaptureOptions(activeDialog) : undefined
    );
  }, 700);
}

function selectedTextFromActiveElement() {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return end > start ? active.value.slice(start, end) : '';
  }
  return window.getSelection()?.toString() || '';
}

function requestSelectionCapture() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    if (activeModal()) return;
    const text = selectedTextFromActiveElement().trim().replace(/\s+/g, ' ');
    if (text) requestCapture('text-selected', text.slice(0, 80));
  }, 500);
}

function isVisible(element) {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function visibleDialogs() {
  return [...document.querySelectorAll(DIALOG_SELECTOR)].filter(isVisible);
}

function activeModal() {
  const dialogs = visibleDialogs();
  return dialogs[dialogs.length - 1] || null;
}

function modalForElement(element) {
  const dialog = element?.closest?.(DIALOG_SELECTOR);
  return dialog && isVisible(dialog) ? dialog : null;
}

function dialogFingerprint(dialog) {
  const rect = dialog.getBoundingClientRect();
  const identity = [
    dialog.tagName,
    dialog.getAttribute('role'),
    dialog.getAttribute('aria-modal'),
    dialog.getAttribute('aria-label'),
    dialog.getAttribute('aria-labelledby'),
    dialog.id,
    dialog.getAttribute('data-modal'),
    dialog.getAttribute('data-dialog')
  ].join('\u001f');
  return [
    identity,
    Math.round((Number(rect.left) || 0) / 16),
    Math.round((Number(rect.top) || 0) / 16),
    Math.round((Number(rect.width) || 0) / 16),
    Math.round((Number(rect.height) || 0) / 16)
  ].join('\u001f');
}

function isModalScrollableElement(element, dialog) {
  if (!element || modalForElement(element) !== dialog) return false;
  const overflow = Math.max(0, Number(element.scrollHeight) - Number(element.clientHeight));
  if (overflow < 4) return false;
  const overflowY = typeof getComputedStyle === 'function' ? getComputedStyle(element).overflowY : '';
  return !overflowY || /auto|scroll|overlay/i.test(overflowY);
}

function isLargeModalScroller(element, dialog) {
  if (!isModalScrollableElement(element, dialog)) return false;
  const dialogRect = dialog.getBoundingClientRect();
  const dialogHeight = Number(dialogRect.height) || 0;
  const viewportHeight = Math.max(MODAL_SCROLL_MIN_VIEWPORT, Number(window.innerHeight) || 0);
  if (
    dialogHeight < viewportHeight * MODAL_SCROLL_MIN_DIALOG_RATIO ||
    element.clientHeight < viewportHeight * MODAL_SCROLL_MIN_SCROLLER_RATIO
  ) {
    return false;
  }
  const overflow = Math.max(0, Number(element.scrollHeight) - Number(element.clientHeight));
  return (
    overflow >= Math.max(MODAL_SCROLL_MIN_OVERFLOW, element.clientHeight * 0.35)
  );
}

function modalElements(dialog) {
  const descendants = typeof dialog?.querySelectorAll === 'function' ? dialog.querySelectorAll('*') : [];
  return [dialog, ...descendants];
}

function modalScrollContainer(dialog) {
  return modalElements(dialog).find((element) => isLargeModalScroller(element, dialog)) || null;
}

function hasModalScrollbar(dialog) {
  return modalElements(dialog).some((element) => isModalScrollableElement(element, dialog));
}

function modalCaptureOptions(dialog) {
  if (!dialog || !isVisible(dialog)) return undefined;
  const rect = dialog.getBoundingClientRect();
  const viewportWidth = Math.round(Number(window.innerWidth) || 0);
  const viewportHeight = Math.round(Number(window.innerHeight) || 0);
  const width = Math.round(Number(rect.width) || 0);
  const height = Math.round(Number(rect.height) || 0);
  if (viewportWidth < 2 || viewportHeight < 2 || width < 2 || height < 2) return undefined;
  return {
    modal: {
      left: Math.round(Number(rect.left) || 0),
      top: Math.round(Number(rect.top) || 0),
      width,
      height,
      viewportWidth,
      viewportHeight,
      compact: !hasModalScrollbar(dialog)
    }
  };
}

async function requestModalActionAfterSettle(reason, label, sourceDialog) {
  const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
  await waitForQuiet(SETTLE_QUIET_MS, SETTLE_MAX_WAIT_MS);
  while (looksBusy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const dialog = activeModal();
  // Opening a different modal is already captured by scanForDialogs().
  if (dialog && dialog !== sourceDialog) return;
  requestCapture(reason, label, dialog ? modalCaptureOptions(dialog) : undefined);
}

// A modal can be opened by a control we do not recognise, so watch for the dialog itself appearing.
function scanForDialogs() {
  clearTimeout(dialogTimer);
  dialogTimer = setTimeout(() => {
    const dialogs = [...document.querySelectorAll(DIALOG_SELECTOR)];
    for (const dialog of dialogs) {
      if (!isVisible(dialog)) capturedDialogs.delete(dialog);
    }
    const dialog = dialogs.filter(isVisible).at(-1);
    if (!dialog) {
      activeDialogFingerprint = null;
      return;
    }
    const fingerprint = dialogFingerprint(dialog);
    if (capturedDialogs.has(dialog)) {
      activeDialogFingerprint = fingerprint;
      return;
    }
    if (activeDialogFingerprint === fingerprint) {
      capturedDialogs.add(dialog);
      return;
    }
    capturedDialogs.add(dialog);
    activeDialogFingerprint = fingerprint;
    requestCapture('dialog-opened', describe(dialog), modalCaptureOptions(dialog));
  }, 350);
}

new MutationObserver(scanForDialogs).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['open', 'hidden', 'aria-hidden', 'aria-modal', 'role', 'class', 'style']
});
scanForDialogs();

function isManualShortcut(event) {
  return event.ctrlKey && event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'q';
}

function isControlShortcut(event, key) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === key
  );
}

function isFinalSaveShortcut(event) {
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function preventShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
}

function requestOutputDialog(mode) {
  sendRuntimeMessage({ type: 'OPEN_OUTPUT_DIALOG', mode });
}

window.addEventListener(
  'keydown',
  (event) => {
    if (isManualShortcut(event)) {
      preventShortcut(event);
      requestCapture('manual-hotkey', 'Ctrl+Alt+Q');
      return;
    }
    if (isFinalSaveShortcut(event)) {
      preventShortcut(event);
      if (!event.repeat) requestOutputDialog('final');
      return;
    }
    if (isControlShortcut(event, 's')) {
      preventShortcut(event);
      if (!event.repeat) requestOutputDialog('checkpoint');
      return;
    }
    if (isControlShortcut(event, 'n')) {
      preventShortcut(event);
      if (!event.repeat) requestOutputDialog('new-recording');
    }
  },
  true
);

// Capture phase so we still see the click even if the handler stops propagation.
window.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const openDialog = activeModal();

    // A picker may be explored with many clicks and scrolls. Keep only the committed value.
    const option = target.closest(OPTION_SELECTOR);
    if (option) {
      const dialog = modalForElement(option) || openDialog;
      if (dialog) {
        requestModalActionAfterSettle('modal-selection', describe(option), dialog);
      } else {
        requestCapture('selection', describe(option));
      }
      return;
    }

    const list = target.closest(LIST_SELECTOR);
    if (list) {
      return;
    }

    const dialog = modalForElement(target);
    // A visible modal owns interaction. Background controls and its underlying page should not
    // create captures until the modal closes or the user acts inside it.
    if (openDialog && !dialog) return;

    const trigger = target.closest(INTERACTIVE_SELECTOR) || target.closest('a[href]');
    if (!trigger) return;

    if (trigger instanceof HTMLInputElement && (trigger.type === 'checkbox' || trigger.type === 'radio')) return;

    const opensList = trigger.hasAttribute('aria-haspopup') || trigger.hasAttribute('aria-expanded');
    if (opensList) return;

    if (dialog) {
      requestModalActionAfterSettle('modal-click', describe(trigger), dialog);
      return;
    }

    // A button click on a client-rendered page often swaps in a loading spinner before the real
    // next screen appears; capturing immediately would just record the spinner. Waiting for the
    // page to stop actively changing catches the settled result instead.
    requestCaptureAfterSettle('click', describe(trigger));
  },
  true
);

// Most of a screenful of scrolling is one new thing to see, so capture whenever the user has
// travelled that far and paused, and again when they land at the end. Capture phase because scroll
// events from inner panes do not bubble.
const SCROLL_STEP_RATIO = 0.6;
const SCROLL_END_SLACK = 4;
const SCROLL_MIN_TRAVEL = 40;

document.addEventListener(
  'scroll',
  (event) => {
    const target = event.target;
    const isDocument = target === document || target === document.documentElement || target === document.body;
    const scroller = isDocument ? document.documentElement : target;
    if (!isDocument && !(scroller instanceof Element)) return;

    // Listbox/menu scrolling is browsing choices, not a recordable page transition. Some controls
    // virtualize long lists, so this must be checked against the scroller and its ancestors.
    if (!isDocument && scroller.closest(LIST_SELECTOR)) {
      clearTimeout(scrollTimer);
      scrollAnchors.set(scroller, scroller.scrollTop);
      return;
    }

    const openDialog = activeModal();
    const dialog = isDocument ? null : modalForElement(scroller);
    const modalScroller = dialog && dialog === openDialog && isLargeModalScroller(scroller, dialog);
    if (openDialog && !modalScroller) {
      clearTimeout(scrollTimer);
      if (!isDocument) scrollAnchors.set(scroller, scroller.scrollTop);
      return;
    }

    const position = isDocument ? window.scrollY : scroller.scrollTop;
    const screenful = isDocument ? window.innerHeight : scroller.clientHeight;
    if (screenful < 200) return;

    const key = isDocument ? document.documentElement : scroller;
    if (!scrollAnchors.has(key)) scrollAnchors.set(key, position);
    if (fullPageCaptureActive || (!modalScroller && Date.now() < suppressScrollUntil)) {
      scrollAnchors.set(key, position);
      return;
    }

    const travelled = Math.abs(position - scrollAnchors.get(key));
    const limit = isDocument
      ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
      : Math.max(scroller.scrollHeight - scroller.clientHeight, 1);
    const atEnd = position >= limit - SCROLL_END_SLACK;

    if (travelled < screenful * SCROLL_STEP_RATIO && !(atEnd && travelled >= SCROLL_MIN_TRAVEL)) return;

    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const currentModal = activeModal();
      if (modalScroller ? currentModal !== dialog : currentModal) return;
      const settled = isDocument ? window.scrollY : scroller.scrollTop;
      scrollAnchors.set(key, settled);
      const label =
        settled >= limit - SCROLL_END_SLACK
          ? 'end of page'
          : `${Math.round((settled / limit) * 100)}% down`;
      requestCapture(
        modalScroller ? 'modal-scrolled' : 'scrolled',
        modalScroller ? `${describe(dialog)} ${label}` : label,
        modalScroller ? modalCaptureOptions(dialog) : undefined
      );
    }, 450);
  },
  true
);

// Native <select> options never fire click events, so the selection arrives as a change.
window.addEventListener(
  'change',
  (event) => {
    const element = event.target;
    const openDialog = activeModal();
    const dialog = modalForElement(element);
    if (openDialog && !dialog) return;
    if (element instanceof HTMLSelectElement) {
      const chosen = element.options[element.selectedIndex]?.text ?? element.value;
      requestCapture(
        dialog ? 'modal-selection' : 'selection',
        `${describe(element)} = ${chosen}`.slice(0, 80),
        dialog ? modalCaptureOptions(dialog) : undefined
      );
      return;
    }

    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      const state = element.checked ? 'checked' : 'unchecked';
      requestCapture(
        dialog ? 'modal-edited' : 'toggle',
        `${describe(element)} = ${state}`.slice(0, 80),
        dialog ? modalCaptureOptions(dialog) : undefined
      );
    }
  },
  true
);

window.addEventListener(
  'input',
  (event) => {
    const element = event.target;
    if (
      (element instanceof HTMLInputElement && element.type !== 'checkbox' && element.type !== 'radio') ||
      element instanceof HTMLTextAreaElement ||
      element?.isContentEditable
    ) {
      requestEditCapture(element);
    }
  },
  true
);

document.addEventListener('selectionchange', requestSelectionCapture, true);
window.addEventListener('select', requestSelectionCapture, true);

// page-hook.js runs in the MAIN world and can only reach the extension through postMessage.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'flow-recorder-api') return;
  sendRuntimeMessage({ type: 'API_CAPTURE', detail: event.data.detail });
});

if (document.documentElement.hasAttribute('data-flow-recorder-hook')) {
  sendRuntimeMessage({ type: 'API_HOOK_READY' });
}

// Shows a shrinking countdown so the user knows exactly when "Capture in 5s" will fire, even after
// the popup has closed and focus has moved to DevTools.
const COUNTDOWN_ID = 'jshotz-countdown';
const FULL_PAGE_PROGRESS_ID = 'jshotz-full-page-progress';
const FULL_PAGE_PROGRESS_STYLE_ID = 'jshotz-full-page-progress-style';

function fullPageProgressElement() {
  let panel = document.getElementById(FULL_PAGE_PROGRESS_ID);
  if (panel) {
    panel.progressLabel ||= panel.querySelector('.jshotz-progress-label');
    panel.progressPercent ||= panel.querySelector('.jshotz-progress-percent');
    panel.progressBar ||= panel.querySelector('.jshotz-progress-bar');
    return panel;
  }

  if (!document.getElementById(FULL_PAGE_PROGRESS_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = FULL_PAGE_PROGRESS_STYLE_ID;
    style.textContent = `
      #${FULL_PAGE_PROGRESS_ID}{position:fixed;top:16px;right:16px;z-index:2147483647;width:260px;padding:10px 12px;border:1px solid rgba(255,255,255,.26);border-radius:6px;background:rgba(17,24,39,.94);box-shadow:0 5px 18px rgba(0,0,0,.35);color:#fff;font:600 13px/1.35 "Segoe UI",sans-serif;pointer-events:none}
      #${FULL_PAGE_PROGRESS_ID} .jshotz-progress-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
      #${FULL_PAGE_PROGRESS_ID} .jshotz-progress-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${FULL_PAGE_PROGRESS_ID} .jshotz-progress-percent{color:#fecaca;font-variant-numeric:tabular-nums}
      #${FULL_PAGE_PROGRESS_ID} .jshotz-progress-track{height:5px;margin-top:8px;overflow:hidden;border-radius:3px;background:rgba(255,255,255,.2)}
      #${FULL_PAGE_PROGRESS_ID} .jshotz-progress-bar{width:0;height:100%;border-radius:inherit;background:#dc2626;transition:width .28s ease;animation:jshotz-progress-pulse 1.1s ease-in-out infinite}
      @keyframes jshotz-progress-pulse{50%{opacity:.62}}
    `;
    document.documentElement.append(style);
  }

  panel = document.createElement('div');
  panel.id = FULL_PAGE_PROGRESS_ID;
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.innerHTML = '<div class="jshotz-progress-head"><span class="jshotz-progress-label"></span><span class="jshotz-progress-percent"></span></div><div class="jshotz-progress-track"><div class="jshotz-progress-bar"></div></div>';
  panel.progressLabel = panel.querySelector('.jshotz-progress-label');
  panel.progressPercent = panel.querySelector('.jshotz-progress-percent');
  panel.progressBar = panel.querySelector('.jshotz-progress-bar');
  document.documentElement.append(panel);
  return panel;
}

function showFullPageProgress(progress) {
  fullPageCaptureActive = true;
  const panel = fullPageProgressElement();
  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
  panel.progressLabel.textContent = progress?.label || 'Capturing full page';
  panel.progressPercent.textContent = `${percent}%`;
  panel.progressBar.style.width = `${percent}%`;
  panel.style.visibility = 'visible';
}

async function setFullPageProgressVisibility(hidden) {
  const panel = document.getElementById(FULL_PAGE_PROGRESS_ID);
  if (!panel) return;
  panel.style.visibility = hidden ? 'hidden' : 'visible';
  panel.style.display = hidden ? 'none' : '';
  if (hidden) {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
}

function clearFullPageProgress() {
  fullPageCaptureActive = false;
  suppressScrollUntil = Date.now() + 1200;
  document.getElementById(FULL_PAGE_PROGRESS_ID)?.remove();
  document.getElementById(FULL_PAGE_PROGRESS_STYLE_ID)?.remove();
}

function showCountdown(seconds) {
  document.getElementById(COUNTDOWN_ID)?.remove();
  clearTimeout(countdownTimer);

  const badge = document.createElement('div');
  badge.id = COUNTDOWN_ID;
  badge.style.cssText = [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
    'background:#1a1a2e', 'color:#fff', 'font:600 14px/1.4 system-ui,sans-serif',
    'padding:8px 14px', 'border-radius:999px', 'box-shadow:0 2px 10px rgba(0,0,0,.35)',
    'pointer-events:none', 'display:flex', 'align-items:center', 'gap:8px'
  ].join(';');

  const dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#ff5555;flex:none;';
  const label = document.createElement('span');
  badge.append(dot, label);
  document.documentElement.append(badge);

  let remaining = seconds;
  const tick = () => {
    label.textContent = remaining > 0 ? `Capturing in ${remaining}s\u2026` : 'Capturing\u2026';
    if (remaining <= 0) {
      countdownTimer = setTimeout(() => badge.remove(), 400);
      return;
    }
    remaining -= 1;
    countdownTimer = setTimeout(tick, 1000);
  };
  tick();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'API_HOOK_CONFIG') {
    setApiCaptureEnabled(Boolean(message.enabled));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'SHOW_COUNTDOWN') showCountdown(message.seconds);
  if (message?.type === 'FULL_PAGE_PROGRESS') showFullPageProgress(message.progress);
  if (message?.type === 'FULL_PAGE_PROGRESS_VISIBILITY') {
    setFullPageProgressVisibility(Boolean(message.hidden)).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'FULL_PAGE_PROGRESS_CLEAR') clearFullPageProgress();
  return false;
});

sendRuntimeMessage({ type: 'API_HOOK_CONFIG_REQUEST' });
})();

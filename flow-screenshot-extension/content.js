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
  '[role="link"]',
  'a[href]',
  'area[href]',
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
const LINK_SELECTOR = ['a[href]', 'area[href]', '[role="link"]'].join(',');
const COOKIE_CONSENT_IDENTITY_PATTERN =
  /\b(?:cookie[-_:\s]*(?:banner|consent|notice|popup|modal|law|preference|settings)|cookiebot|cookieyes|cookielaw|onetrust|trustarc|didomi|quantcast|usercentrics|osano|termly|consent[-_:\s]*(?:banner|notice|modal|manager|preferences?|popup)|privacy[-_:\s]*(?:manager|preferences?|choices?))\b/i;
const COOKIE_CONSENT_TEXT_PATTERN =
  /(?=[\s\S]*\bcookies?\b)(?=[\s\S]*\b(?:accept|reject|manage|allow|decline|optional|preferences|settings)\b)/i;
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
let activeDialogFingerprint = null;
let cookieConsentSurfaces = [];
let scrollAnchors = new WeakMap();
let capturedDialogs = new WeakSet();
let lastPageVisualActivityAt = 0;

function resetRecordingSession() {
  clearTimeout(editTimer);
  clearTimeout(selectionTimer);
  clearTimeout(dialogTimer);
  clearTimeout(scrollTimer);
  editTimer = 0;
  selectionTimer = 0;
  dialogTimer = 0;
  scrollTimer = 0;
  lastSent = { key: '', at: 0 };
  suppressScrollUntil = 0;
  fullPageCaptureActive = false;
  activeDialogFingerprint = null;
  cookieConsentSurfaces = [];
  scrollAnchors = new WeakMap();
  capturedDialogs = new WeakSet();
  document.getElementById('jshotz-full-page-progress')?.remove();
  document.getElementById('jshotz-full-page-progress-style')?.remove();
}

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

function reportPageVisualActivity() {
  const now = Date.now();
  if (now - lastPageVisualActivityAt < 150) return;
  lastPageVisualActivityAt = now;
  sendRuntimeMessage({ type: 'PAGE_VISUAL_ACTIVITY' });
}

function isScrollCapture(reason) {
  return reason === 'scrolled' || reason === 'modal-scrolled';
}

function actionTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function requestCapture(reason, label, options = {}, actionAt) {
  const key = `${reason}:${label}`;
  const requestedAt = Date.now();
  const sourceActionAt = actionTimestamp(actionAt, requestedAt);
  if (key === lastSent.key && requestedAt - lastSent.at < 800) return;
  lastSent = { key, at: requestedAt };

  // Chromium can briefly resize the visible viewport while it displays a debugger notice during
  // ordinary full-page capture; that must not read as a user scroll.
  if (!isScrollCapture(reason)) suppressScrollUntil = requestedAt + 2500;

  sendRuntimeMessage({ type: 'CLICK_CAPTURE', reason, label, ...options, actionAt: sourceActionAt });
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
// screen appears. Wait for the settled page and capture it once, rather than recording the spinner
// and the result as separate steps.
async function requestCaptureAfterSettle(reason, label, actionAt) {
  // Dialogs often mount after their click handler's async state update or entrance animation.
  // Give that small window to appear so its opening frame replaces the underlying page-click frame.
  await new Promise((resolve) => setTimeout(resolve, MODAL_OPEN_GRACE_MS));
  if (activeModal()) return;

  const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
  await waitForQuiet(SETTLE_QUIET_MS, SETTLE_MAX_WAIT_MS);
  while (looksBusy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (activeModal()) return;
  requestCapture(reason, label, undefined, actionAt);
}

function describeEditedField(element) {
  if (element instanceof HTMLInputElement && element.type === 'password') {
    return `${describe(element)} edited`;
  }
  return `${describe(element)} edited`;
}

function requestEditCapture(element, actionAt) {
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
      activeDialog ? modalCaptureOptions(activeDialog) : undefined,
      actionAt
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
  const actionAt = Date.now();
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    if (activeModal()) return;
    const text = selectedTextFromActiveElement().trim().replace(/\s+/g, ' ');
    if (text) requestCapture('text-selected', text.slice(0, 80), undefined, actionAt);
  }, 500);
}

function isVisible(element) {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function matchesSelector(element, selector) {
  try {
    return Boolean(element?.matches?.(selector));
  } catch {
    return false;
  }
}

function isDialogSurface(element) {
  return matchesSelector(element, DIALOG_SELECTOR);
}

function isCookieConsentSurface(element) {
  if (!(element instanceof Element) || !isVisible(element)) return false;
  if (element === document.documentElement || element === document.body) return false;

  const identity = [
    element.id,
    element.getAttribute('id'),
    element.getAttribute('class'),
    element.getAttribute('data-testid'),
    element.getAttribute('data-test'),
    element.getAttribute('data-cookieconsent')
  ].filter(Boolean).join(' ');
  const text = [element.getAttribute('aria-label'), element.innerText, element.textContent]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1200);
  const isConsent = COOKIE_CONSENT_IDENTITY_PATTERN.test(identity) || COOKIE_CONSENT_TEXT_PATTERN.test(text);
  if (!isConsent) return false;

  const rect = element.getBoundingClientRect();
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  if (width < 160 || height < 32) return false;

  const viewportWidth = Math.max(1, Number(window.innerWidth) || 0);
  const viewportHeight = Math.max(1, Number(window.innerHeight) || 0);
  const top = Number(rect.top) || 0;
  const bottom = top + height;
  const position = typeof getComputedStyle === 'function'
    ? getComputedStyle(element).position || ''
    : element.style?.position || '';
  const positionedOverlay = /fixed|sticky|absolute/i.test(position);
  const nearViewportEdge = top <= viewportHeight * 0.2 || bottom >= viewportHeight * 0.8;
  const edgeBanner = nearViewportEdge && width >= viewportWidth * 0.35 && height <= viewportHeight * 0.45;

  return isDialogSurface(element) || positionedOverlay || edgeBanner;
}

function isDescendantOf(element, ancestor) {
  for (let current = element?.parentElement; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

function collectCookieConsentSurfaces() {
  const candidates = [...document.querySelectorAll('*')].filter(isCookieConsentSurface);
  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && isDescendantOf(candidate, other)));
}

function visibleDialogs() {
  return [...new Set([
    ...document.querySelectorAll(DIALOG_SELECTOR),
    ...cookieConsentSurfaces
  ])].filter(isVisible);
}

function activeModal() {
  const dialogs = visibleDialogs();
  return dialogs[dialogs.length - 1] || null;
}

function modalForElement(element) {
  for (let current = element; current instanceof Element; current = current.parentElement) {
    if ((isDialogSurface(current) || isCookieConsentSurface(current)) && isVisible(current)) return current;
  }
  return null;
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
      // A consent banner is part of the page state, not a stand-alone dialog. Preserve the full
      // viewport so the banner and the page it affects appear together in one evidence image.
      compact: !isCookieConsentSurface(dialog) && !hasModalScrollbar(dialog)
    }
  };
}

async function requestModalActionAfterSettle(reason, label, sourceDialog, actionAt) {
  const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
  await waitForQuiet(SETTLE_QUIET_MS, SETTLE_MAX_WAIT_MS);
  while (looksBusy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const dialog = activeModal();
  // Opening a different modal is already captured by scanForDialogs().
  if (dialog && dialog !== sourceDialog) return;
  requestCapture(reason, label, dialog ? modalCaptureOptions(dialog) : undefined, actionAt);
}

// A modal can be opened by a control we do not recognise, so watch for the dialog itself appearing.
function scanForDialogs() {
  const actionAt = Date.now();
  clearTimeout(dialogTimer);
  dialogTimer = setTimeout(() => {
    dialogTimer = 0;
    const previousCookieConsentSurfaces = cookieConsentSurfaces;
    cookieConsentSurfaces = collectCookieConsentSurfaces();
    const dialogs = visibleDialogs();
    for (const dialog of [...new Set([
      ...document.querySelectorAll(DIALOG_SELECTOR),
      ...previousCookieConsentSurfaces,
      ...cookieConsentSurfaces
    ])]) {
      if (!isVisible(dialog)) capturedDialogs.delete(dialog);
    }
    const dialog = dialogs.at(-1);
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
    requestCapture('dialog-opened', describe(dialog), modalCaptureOptions(dialog), actionAt);
  }, 350);
}

new MutationObserver(scanForDialogs).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['open', 'hidden', 'aria-hidden', 'aria-modal', 'role', 'class', 'id', 'aria-label', 'style']
});
scanForDialogs();

function clickPathElements(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const elements = [];
  for (const candidate of [event.target, ...path]) {
    const element = candidate instanceof Element
      ? candidate
      : candidate?.parentElement instanceof Element
        ? candidate.parentElement
        : null;
    if (element && !elements.includes(element)) elements.push(element);
  }
  return elements;
}

function closestClickTarget(event, selector) {
  for (const element of clickPathElements(event)) {
    const match = element.closest?.(selector);
    if (match) return match;
  }
  return null;
}

function linkCaptureOptions(link, dialog, event) {
  const options = dialog ? modalCaptureOptions(dialog) || {} : {};
  const target = String(link.getAttribute?.('target') || '').trim().toLowerCase();
  const opensNewTab =
    !link.hasAttribute?.('download') &&
    (target && target !== '_self' || event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey);
  if (opensNewTab) options.opensNewTab = true;
  return options;
}

function isNavigationalLink(link) {
  const href = String(link.getAttribute?.('href') || '').trim();
  if (!href && link.getAttribute?.('role') === 'link') return true;
  if (!href || href === '#' || /^javascript:/i.test(href)) return false;
  const currentUrl = String(window.location?.href || '');
  const destination = String(link.href || href);
  return !currentUrl || (destination !== currentUrl && destination !== `${currentUrl}#`);
}

function isSaveAndOpenLocationShortcut(event) {
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function isSaveAndStopShortcut(event) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    event.key?.toLowerCase() === 's'
  );
}

function isCheckpointSaveShortcut(event) {
  return (
    event.ctrlKey &&
    !event.altKey &&
    event.shiftKey &&
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
    if (isSaveAndOpenLocationShortcut(event)) {
      preventShortcut(event);
      if (!event.repeat) requestOutputDialog('final');
      return;
    }
    if (isCheckpointSaveShortcut(event)) {
      preventShortcut(event);
      if (!event.repeat) requestOutputDialog('checkpoint');
      return;
    }
    if (isSaveAndStopShortcut(event)) {
      preventShortcut(event);
      if (!event.repeat) requestOutputDialog('final');
    }
  },
  true
);

// Capture phase so we still see the click even if the handler stops propagation.
window.addEventListener(
  'click',
  (event) => {
    reportPageVisualActivity();
    const target = clickPathElements(event)[0];
    if (!target) return;
    const actionAt = Date.now();
    const openDialog = activeModal();

    // Links can start unloading the document before a delayed settled-click capture gets sent.
    // Record their intent immediately; the normal navigation listener still records the result.
    const link = closestClickTarget(event, LINK_SELECTOR);
    if (link) {
      const dialog = modalForElement(link);
      if (openDialog && !dialog) return;
      const options = linkCaptureOptions(link, dialog, event);
      if (options.opensNewTab || isNavigationalLink(link)) {
        requestCapture(dialog ? 'modal-link' : 'link', describe(link), options, actionAt);
      } else if (dialog) {
        requestModalActionAfterSettle('modal-link-action', describe(link), dialog, actionAt);
      } else {
        requestCaptureAfterSettle('link-action', describe(link), actionAt);
      }
      return;
    }

    // A picker may be explored with many clicks and scrolls. Keep only the committed value.
    const option = closestClickTarget(event, OPTION_SELECTOR);
    if (option) {
      const dialog = modalForElement(option) || openDialog;
      if (dialog) {
        requestModalActionAfterSettle('modal-selection', describe(option), dialog, actionAt);
      } else {
        requestCapture('selection', describe(option), undefined, actionAt);
      }
      return;
    }

    const list = closestClickTarget(event, LIST_SELECTOR);
    if (list) {
      return;
    }

    const dialog = modalForElement(target);
    // A visible modal owns interaction. Background controls and its underlying page should not
    // create captures until the modal closes or the user acts inside it.
    if (openDialog && !dialog) return;

    const trigger = closestClickTarget(event, INTERACTIVE_SELECTOR);
    if (!trigger) return;

    if (trigger instanceof HTMLInputElement && (trigger.type === 'checkbox' || trigger.type === 'radio')) return;

    const toggleRole = trigger.getAttribute?.('role');
    if (toggleRole === 'checkbox' || toggleRole === 'radio' || toggleRole === 'switch') {
      setTimeout(() => {
        const state = trigger.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked';
        requestCapture(
          dialog ? 'modal-toggle' : 'toggle',
          `${describe(trigger)} = ${state}`.slice(0, 80),
          dialog ? modalCaptureOptions(dialog) : undefined,
          actionAt
        );
      }, 0);
      return;
    }

    const opensList = trigger.hasAttribute('aria-haspopup') || trigger.hasAttribute('aria-expanded');
    if (opensList) return;

    if (dialog) {
      requestModalActionAfterSettle('modal-click', describe(trigger), dialog, actionAt);
      return;
    }

    // A button click on a client-rendered page often swaps in a loading spinner before the real
    // next screen appears; capturing immediately would just record the spinner. Waiting for the
    // page to stop actively changing catches the settled result instead.
    requestCaptureAfterSettle('click', describe(trigger), actionAt);
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
    reportPageVisualActivity();
    const actionAt = Date.now();
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
        modalScroller ? modalCaptureOptions(dialog) : undefined,
        actionAt
      );
    }, 450);
  },
  true
);

// Native <select> options never fire click events, so the selection arrives as a change.
window.addEventListener(
  'change',
  (event) => {
    reportPageVisualActivity();
    const actionAt = Date.now();
    const element = event.target;
    const openDialog = activeModal();
    const dialog = modalForElement(element);
    if (openDialog && !dialog) return;
    if (element instanceof HTMLSelectElement) {
      const chosen = element.options[element.selectedIndex]?.text ?? element.value;
      requestCapture(
        dialog ? 'modal-selection' : 'selection',
        `${describe(element)} = ${chosen}`.slice(0, 80),
        dialog ? modalCaptureOptions(dialog) : undefined,
        actionAt
      );
      return;
    }

    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      const state = element.checked ? 'checked' : 'unchecked';
      requestCapture(
        dialog ? 'modal-toggle' : 'toggle',
        `${describe(element)} = ${state}`.slice(0, 80),
        dialog ? modalCaptureOptions(dialog) : undefined,
        actionAt
      );
    }
  },
  true
);

window.addEventListener(
  'input',
  (event) => {
    reportPageVisualActivity();
    const element = event.target;
    if (
      (element instanceof HTMLInputElement && element.type !== 'checkbox' && element.type !== 'radio') ||
      element instanceof HTMLTextAreaElement ||
      element?.isContentEditable
    ) {
      requestEditCapture(element, Date.now());
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'RECORDING_SESSION_STARTED') {
    resetRecordingSession();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'API_HOOK_CONFIG') {
    setApiCaptureEnabled(Boolean(message.enabled));
    sendResponse({ ok: true });
    return false;
  }
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

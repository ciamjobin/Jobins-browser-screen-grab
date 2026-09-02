const INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="reset"]',
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

// The list whose opened state was already captured; further poking or scrolling inside adds nothing.
let capturedList = null;
let lastSent = { key: '', at: 0 };
let editTimer = 0;
let selectionTimer = 0;

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

function requestCapture(reason, label) {
  const key = `${reason}:${label}`;
  const now = Date.now();
  if (key === lastSent.key && now - lastSent.at < 800) return;
  lastSent = { key, at: now };

  chrome.runtime.sendMessage({ type: 'CLICK_CAPTURE', reason, label }).catch(() => {
    /* Background may be asleep or recording stopped; nothing to do. */
  });
}

function describeEditedField(element) {
  if (element instanceof HTMLInputElement && element.type === 'password') {
    return `${describe(element)} edited`;
  }
  return `${describe(element)} edited`;
}

function requestEditCapture(element) {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => requestCapture('field-edited', describeEditedField(element)), 700);
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
    const text = selectedTextFromActiveElement().trim().replace(/\s+/g, ' ');
    if (text) requestCapture('text-selected', text.slice(0, 80));
  }, 500);
}

function isManualShortcut(event) {
  return event.ctrlKey && event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'q';
}

window.addEventListener(
  'keydown',
  (event) => {
    if (!isManualShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    requestCapture('manual-hotkey', 'Ctrl+Alt+Q');
  },
  true
);

// Capture phase so we still see the click even if the handler stops propagation.
window.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Choosing an entry closes the list, so this is the selection worth keeping.
    const option = target.closest(OPTION_SELECTOR);
    if (option) {
      capturedList = null;
      requestCapture('selection', describe(option));
      return;
    }

    const list = target.closest(LIST_SELECTOR);
    if (list) {
      if (capturedList === list) return;
      capturedList = list;
      requestCapture('list-opened', describe(list));
      return;
    }

    const trigger = target.closest(INTERACTIVE_SELECTOR) || target.closest('a[href]');
    if (!trigger) return;

    const opensList = trigger.hasAttribute('aria-haspopup') || trigger.hasAttribute('aria-expanded');
    if (opensList) capturedList = null;

    requestCapture(opensList ? 'list-opened' : 'click', describe(trigger));
  },
  true
);

// Native <select> options never fire click events, so the selection arrives as a change.
window.addEventListener(
  'change',
  (event) => {
    const element = event.target;
    if (element instanceof HTMLSelectElement) {
      const chosen = element.options[element.selectedIndex]?.text ?? element.value;
      requestCapture('selection', `${describe(element)} = ${chosen}`.slice(0, 80));
    }
  },
  true
);

window.addEventListener(
  'input',
  (event) => {
    const element = event.target;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
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
  chrome.runtime.sendMessage({ type: 'API_CAPTURE', detail: event.data.detail }).catch(() => {});
});

if (document.documentElement.hasAttribute('data-flow-recorder-hook')) {
  chrome.runtime.sendMessage({ type: 'API_HOOK_READY' }).catch(() => {});
}

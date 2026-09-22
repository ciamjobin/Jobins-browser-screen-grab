import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const contentSource = await readFile(resolve('flow-screenshot-extension/content.js'), 'utf8');

class FakeElement {
  constructor(tagName, { attributes = {}, parent = null, text = '', value = '', rect } = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.parentElement = parent;
    this.children = [];
    this.innerText = text;
    this.value = value;
    this.name = '';
    this.id = '';
    this.isContentEditable = false;
    this.style = {};
    this.rect = rect || { left: 0, top: 0, width: 100, height: 30 };
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    if (parent) parent.children.push(this);
  }

  addEventListener() {}

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selector)) return current;
    }
    return null;
  }

  matches(selector) {
    return selector.split(',').some((rawSelector) => {
      const part = rawSelector.trim();
      const role = /^\[role="([^"]+)"\]$/.exec(part);
      const type = /^(?:input)?\[type="([^"]+)"\]$/.exec(part);
      const attribute = /^\[([^=\]]+)="([^"]+)"\]$/.exec(part);
      if (part === '*') return true;
      if (role) return this.getAttribute('role') === role[1];
      if (type) return this.tagName === 'INPUT' && this.getAttribute('type') === type[1];
      if (attribute) return this.getAttribute(attribute[1]) === attribute[2];
      if (part === '[type="submit"]') return this.getAttribute('type') === 'submit';
      if (part === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
      return this.tagName === part.toUpperCase();
    });
  }
}

class FakeInputElement extends FakeElement {}
class FakeTextAreaElement extends FakeElement {}

class FakeSelectElement extends FakeElement {
  constructor(options) {
    super('select', options);
    this.options = options.options || [];
    this.selectedIndex = options.selectedIndex ?? -1;
  }
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function createContentEnvironment({ sendMessageResult = { ok: true }, now = 0 } = {}) {
  const documentEvents = createEventTarget();
  const windowEvents = createEventTarget();
  const rootEvents = createEventTarget();
  const root = new FakeElement('html');
  root.addEventListener = rootEvents.addEventListener;
  root.dispatchEvent = (event) => rootEvents.dispatch(event.type, event);
  root.scrollHeight = 3000;
  const body = new FakeElement('body', { parent: root });
  const allElements = () => [root, ...root.querySelectorAll('*')];
  const document = {
    ...documentEvents,
    documentElement: root,
    body,
    activeElement: null,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => allElements().find((element) => element.id === id) || null,
    querySelector: (selector) => allElements().find((element) => element.matches(selector)) || null,
    querySelectorAll: (selector) => allElements().filter((element) => element.matches(selector))
  };
  const sent = [];
  const timers = new Map();
  const mutationObservers = [];
  const runtimeMessageListeners = [];
  let nextTimer = 1;
  let currentTime = now;
  const window = {
    ...windowEvents,
    innerHeight: 800,
    innerWidth: 1280,
    location: { href: 'https://example.test/account' },
    scrollY: 0,
    getSelection: () => ({ toString: () => '' })
  };
  const context = {
    Date: { now: () => currentTime },
    Element: FakeElement,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    HTMLInputElement: FakeInputElement,
    HTMLSelectElement: FakeSelectElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        mutationObservers.push(this);
      }
      observe(_target, options) {
        this.options = options;
      }
      disconnect() {
        this.disconnected = true;
      }
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve(sendMessageResult);
        },
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          }
        }
      }
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    getComputedStyle(element) {
      return { overflowY: element.style.overflowY || '' };
    },
    document,
    setTimeout(callback, delay) {
      const timer = nextTimer++;
      timers.set(timer, { callback, delay });
      return timer;
    },
    window
  };
  vm.runInNewContext(contentSource, context);

  return {
    body,
    document,
    root,
    sent,
    window,
    dispatchRuntimeMessage(message) {
      let response;
      for (const listener of runtimeMessageListeners) {
        listener(message, {}, (value) => {
          response = value;
        });
      }
      return response;
    },
    notifyMutations() {
      for (const observer of mutationObservers) {
        if (!observer.disconnected) observer.callback([]);
      }
    },
    notifyAttributeMutation(attributeName) {
      for (const observer of mutationObservers) {
        if (!observer.disconnected && observer.options?.attributeFilter?.includes(attributeName)) {
          observer.callback([{ type: 'attributes', attributeName }]);
        }
      }
    },
    setNow(value) {
      currentTime = value;
    },
    runTimers() {
      while (timers.size) {
        const [timer, pending] = timers.entries().next().value;
        timers.delete(timer);
        pending.callback();
      }
    },
    captures() {
      return sent.filter((message) => message.type === 'CLICK_CAPTURE');
    },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test('captures a selected dropdown value but ignores dropdown opening and scrolling', () => {
  const environment = createContentEnvironment();
  const { body, document, root, window } = environment;

  document.dispatch('scroll', { target: document });
  window.scrollY = 900;
  document.dispatch('scroll', { target: document });
  environment.runTimers();
  assert.equal(environment.captures().length, 1);
  assert.equal(environment.captures()[0].reason, 'scrolled');

  const trigger = new FakeElement('button', {
    attributes: { 'aria-expanded': 'false', 'aria-haspopup': 'listbox' },
    parent: body,
    text: 'Select plan'
  });
  const list = new FakeElement('div', { attributes: { role: 'listbox' }, parent: root });
  list.clientHeight = 400;
  list.scrollHeight = 2400;
  list.scrollTop = 1200;
  const option = new FakeElement('div', {
    attributes: { role: 'option' },
    parent: list,
    text: 'Retirement plan'
  });

  window.dispatch('click', { target: trigger });
  document.dispatch('scroll', { target: list });
  environment.runTimers();
  assert.equal(environment.captures().length, 1);

  window.dispatch('click', { target: option });
  assert.equal(environment.captures().at(-1).type, 'CLICK_CAPTURE');
  assert.equal(environment.captures().at(-1).reason, 'selection');
  assert.equal(environment.captures().at(-1).label, 'Retirement plan');

  const select = new FakeSelectElement({
    attributes: { 'aria-label': 'Contribution rate' },
    parent: body,
    options: [{ text: 'Choose a value', value: '' }, { text: '6%', value: '6' }],
    selectedIndex: 1
  });
  window.dispatch('input', { target: select });
  window.dispatch('change', { target: select });
  environment.runTimers();
  assert.equal(environment.captures().at(-1).type, 'CLICK_CAPTURE');
  assert.equal(environment.captures().at(-1).reason, 'selection');
  assert.equal(environment.captures().at(-1).label, 'Contribution rate = 6%');
  assert.equal(environment.captures().filter((capture) => capture.reason === 'field-edited').length, 0);
});

test('captures a fixed modal once and only records intentional modal actions', async () => {
  const environment = createContentEnvironment();
  const { body, document, window } = environment;
  const dialog = new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Terms and Conditions',
    rect: { left: 240, top: 120, width: 800, height: 460 }
  });
  const action = new FakeElement('button', { parent: dialog, text: 'Accept' });
  const input = new FakeInputElement('input', {
    attributes: { 'aria-label': 'Comments' },
    parent: dialog,
    value: 'Approved'
  });

  environment.notifyMutations();
  environment.runTimers();
  const opening = environment.captures().at(-1);
  assert.equal(opening.reason, 'dialog-opened');
  assert.equal(opening.modal.compact, true);
  assert.equal(opening.modal.left, 240);
  assert.equal(opening.modal.width, 800);

  window.scrollY = 900;
  document.dispatch('scroll', { target: document });
  dialog.scrollTop = 200;
  document.dispatch('scroll', { target: dialog });
  environment.runTimers();
  assert.equal(environment.captures().length, 1);

  window.dispatch('click', { target: action });
  environment.runTimers();
  await environment.flush();
  assert.equal(environment.captures().length, 2);
  assert.equal(environment.captures().at(-1).reason, 'modal-click');
  assert.equal(environment.captures().some((capture) => capture.reason === 'click'), false);
  assert.equal(environment.captures().some((capture) => capture.reason === 'click-loaded'), false);

  window.dispatch('input', { target: input });
  environment.runTimers();
  assert.equal(environment.captures().at(-1).reason, 'modal-edited');
  assert.equal(environment.captures().at(-1).label, 'Comments edited');
});

test('treats an aria-modal window as a modal capture surface', async () => {
  const environment = createContentEnvironment();
  const { body, document, window } = environment;
  const dialog = new FakeElement('section', {
    attributes: { 'aria-modal': 'true' },
    parent: body,
    text: 'Confirm payment',
    rect: { left: 260, top: 160, width: 760, height: 400 }
  });
  const action = new FakeElement('button', { parent: dialog, text: 'Confirm' });

  environment.notifyMutations();
  environment.runTimers();
  assert.equal(environment.captures().at(-1).reason, 'dialog-opened');
  assert.equal(environment.captures().at(-1).label, 'Confirm payment');

  window.scrollY = 900;
  document.dispatch('scroll', { target: document });
  environment.runTimers();
  assert.equal(environment.captures().length, 1);

  window.dispatch('click', { target: action });
  environment.runTimers();
  await environment.flush();
  assert.equal(environment.captures().length, 2);
  assert.equal(environment.captures().at(-1).reason, 'modal-click');
});

test('detects an existing element when aria-modal is enabled', () => {
  const environment = createContentEnvironment();
  const { body } = environment;
  const dialog = new FakeElement('section', {
    parent: body,
    text: 'Review submission',
    rect: { left: 260, top: 160, width: 760, height: 400 }
  });

  dialog.setAttribute('aria-modal', 'true');
  environment.notifyAttributeMutation('aria-modal');
  environment.runTimers();

  assert.equal(environment.captures().length, 1);
  assert.equal(environment.captures()[0].reason, 'dialog-opened');
});

test('captures a cookie consent banner with the page instead of cropping it as a modal', () => {
  const environment = createContentEnvironment();
  const { body } = environment;
  new FakeElement('section', {
    parent: body,
    text: 'In addition to cookies that are strictly necessary, reject optional cookies or manage cookies.',
    rect: { left: 0, top: 635, width: 1280, height: 165 }
  });

  environment.notifyMutations();
  environment.runTimers();

  const capture = environment.captures().at(-1);
  assert.equal(capture.reason, 'dialog-opened');
  assert.equal(capture.modal.compact, false);
  assert.equal(capture.modal.width, 1280);
  assert.equal(capture.modal.height, 165);
});

test('does not capture the underlying click while an asynchronously opened modal appears', async () => {
  const environment = createContentEnvironment();
  const { body, window } = environment;
  const trigger = new FakeElement('button', { parent: body, text: 'Review terms' });

  window.dispatch('click', { target: trigger });
  new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Terms of service',
    rect: { left: 220, top: 120, width: 840, height: 460 }
  });
  environment.notifyMutations();
  environment.runTimers();
  await environment.flush();

  assert.deepEqual(environment.captures().map((capture) => capture.reason), ['dialog-opened']);
});

test('captures nested and aria-expanded links immediately before navigation', () => {
  const environment = createContentEnvironment();
  const { body, window } = environment;
  const link = new FakeElement('a', {
    attributes: { href: '/registration', 'aria-expanded': 'false' },
    parent: body,
    text: 'Open registration'
  });
  const icon = new FakeElement('span', { parent: link });

  window.dispatch('click', {
    target: icon,
    composedPath: () => [icon, link, body]
  });

  assert.equal(environment.captures().length, 1);
  assert.equal(environment.captures()[0].reason, 'link');
  assert.equal(environment.captures()[0].label, 'Open registration');

  const accessibleLink = new FakeElement('div', {
    attributes: { role: 'link' },
    parent: body,
    text: 'Review account details'
  });
  window.dispatch('click', { target: accessibleLink });
  assert.equal(environment.captures().at(-1).reason, 'link');
  assert.equal(environment.captures().at(-1).label, 'Review account details');

  const newTabLink = new FakeElement('a', {
    attributes: { href: '/privacy', target: '_blank' },
    parent: body,
    text: 'Privacy and security'
  });
  window.dispatch('click', { target: newTabLink });
  assert.equal(environment.captures().at(-1).opensNewTab, true);
});

test('preserves action time through delayed capture paths', async () => {
  const clickEnvironment = createContentEnvironment({ now: 1000 });
  const clickTrigger = new FakeElement('button', { parent: clickEnvironment.body, text: 'Continue' });
  clickEnvironment.window.dispatch('click', { target: clickTrigger });
  clickEnvironment.setNow(2000);
  clickEnvironment.runTimers();
  await clickEnvironment.flush();
  clickEnvironment.runTimers();
  await clickEnvironment.flush();
  assert.equal(clickEnvironment.captures().filter((capture) => capture.reason === 'click').length, 1);
  assert.equal(clickEnvironment.captures().some((capture) => capture.reason === 'click-loaded'), false);
  assert.equal(clickEnvironment.captures().find((capture) => capture.reason === 'click').actionAt, 1000);

  const editEnvironment = createContentEnvironment({ now: 3000 });
  editEnvironment.runTimers();
  const field = new FakeInputElement('input', {
    attributes: { 'aria-label': 'Member name', type: 'text' },
    parent: editEnvironment.body,
    value: 'Jobin'
  });
  editEnvironment.window.dispatch('input', { target: field });
  editEnvironment.setNow(4000);
  editEnvironment.runTimers();
  assert.equal(editEnvironment.captures().at(-1).actionAt, 3000);

  const selectionEnvironment = createContentEnvironment({ now: 5000 });
  selectionEnvironment.runTimers();
  selectionEnvironment.window.getSelection = () => ({ toString: () => 'Selected agreement text' });
  selectionEnvironment.document.dispatch('selectionchange', {});
  selectionEnvironment.setNow(6000);
  selectionEnvironment.runTimers();
  assert.equal(selectionEnvironment.captures().at(-1).actionAt, 5000);

  const scrollEnvironment = createContentEnvironment({ now: 7000 });
  scrollEnvironment.runTimers();
  scrollEnvironment.document.dispatch('scroll', { target: scrollEnvironment.document });
  scrollEnvironment.setNow(8000);
  scrollEnvironment.window.scrollY = 900;
  scrollEnvironment.document.dispatch('scroll', { target: scrollEnvironment.document });
  scrollEnvironment.setNow(9000);
  scrollEnvironment.runTimers();
  assert.equal(scrollEnvironment.captures().at(-1).actionAt, 8000);

  const dialogEnvironment = createContentEnvironment({ now: 10000 });
  dialogEnvironment.runTimers();
  dialogEnvironment.setNow(11000);
  new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: dialogEnvironment.body,
    text: 'Confirm submission',
    rect: { left: 220, top: 120, width: 840, height: 460 }
  });
  dialogEnvironment.notifyMutations();
  dialogEnvironment.setNow(12000);
  dialogEnvironment.runTimers();
  assert.equal(dialogEnvironment.captures().at(-1).actionAt, 11000);
});

test('does not recapture a re-rendered modal but captures a distinct modal', () => {
  const environment = createContentEnvironment();
  const { body } = environment;
  const original = new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Edit profile',
    rect: { left: 240, top: 150, width: 800, height: 440 }
  });

  environment.notifyMutations();
  environment.runTimers();
  assert.equal(environment.captures().length, 1);

  original.setAttribute('hidden', '');
  const replacement = new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Edit profile',
    rect: { left: 240, top: 150, width: 800, height: 440 }
  });
  environment.notifyMutations();
  environment.runTimers();
  assert.equal(environment.captures().length, 1);

  replacement.setAttribute('hidden', '');
  new FakeElement('div', {
    attributes: { role: 'dialog', 'aria-label': 'Confirm discard' },
    parent: body,
    text: 'Discard changes?',
    rect: { left: 240, top: 150, width: 800, height: 440 }
  });
  environment.notifyMutations();
  environment.runTimers();
  assert.equal(environment.captures().length, 2);
  assert.equal(environment.captures().at(-1).label, 'Confirm discard');
});

test('captures scrolling only inside a large scrollable modal', () => {
  const environment = createContentEnvironment();
  const { body, document, window } = environment;
  const dialog = new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Privacy policy',
    rect: { left: 180, top: 80, width: 920, height: 640 }
  });
  dialog.clientHeight = 600;
  dialog.scrollHeight = 1600;
  dialog.style.overflowY = 'auto';

  environment.notifyMutations();
  environment.runTimers();
  assert.equal(environment.captures().at(-1).reason, 'dialog-opened');
  assert.equal(environment.captures().at(-1).modal.compact, false);

  window.scrollY = 900;
  document.dispatch('scroll', { target: document });
  document.dispatch('scroll', { target: dialog });
  dialog.scrollTop = 500;
  document.dispatch('scroll', { target: dialog });
  environment.runTimers();

  assert.equal(environment.captures().length, 2);
  const capture = environment.captures().at(-1);
  assert.equal(capture.reason, 'modal-scrolled');
  assert.equal(capture.label, 'Privacy policy 50% down');
  assert.equal(capture.modal.compact, false);
});

test('does not capture scrolls from an ordinary modal with a scrollbar', () => {
  const environment = createContentEnvironment();
  const { body, document } = environment;
  const dialog = new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Standard terms',
    rect: { left: 280, top: 160, width: 720, height: 480 }
  });
  dialog.clientHeight = 440;
  dialog.scrollHeight = 1600;
  dialog.scrollTop = 700;
  dialog.style.overflowY = 'auto';

  environment.notifyMutations();
  environment.runTimers();
  assert.equal(environment.captures().at(-1).modal.compact, false);

  document.dispatch('scroll', { target: dialog });
  environment.runTimers();
  assert.equal(environment.captures().length, 1);
});

test('drops a pending page-scroll capture when a modal opens', () => {
  const environment = createContentEnvironment();
  const { body, document, window } = environment;

  document.dispatch('scroll', { target: document });
  window.scrollY = 900;
  document.dispatch('scroll', { target: document });

  new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Confirm changes',
    rect: { left: 260, top: 150, width: 700, height: 360 }
  });
  environment.notifyMutations();
  environment.runTimers();

  assert.deepEqual(environment.captures().map((capture) => capture.reason), ['dialog-opened']);
});

test('handles recorder output hotkeys', () => {
  const environment = createContentEnvironment();
  const keyboardEvent = (key, { altKey = false, ctrlKey = true, shiftKey = false } = {}) => ({
    key,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey: false,
    repeat: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    }
  });

  const save = keyboardEvent('s', { ctrlKey: true, shiftKey: true });
  environment.window.dispatch('keydown', save);
  assert.equal(save.prevented, true);
  assert.equal(save.stopped, true);
  assert.equal(environment.sent.at(-1).type, 'OPEN_OUTPUT_DIALOG');
  assert.equal(environment.sent.at(-1).mode, 'checkpoint');

  const finalSave = keyboardEvent('s');
  environment.window.dispatch('keydown', finalSave);
  assert.equal(finalSave.prevented, true);
  assert.equal(finalSave.stopped, true);
  assert.equal(environment.sent.at(-1).type, 'OPEN_OUTPUT_DIALOG');
  assert.equal(environment.sent.at(-1).mode, 'final');
  assert.equal(environment.sent.at(-1).reveal, undefined);

  const locationSave = keyboardEvent('s', { altKey: true });
  environment.window.dispatch('keydown', locationSave);
  assert.equal(locationSave.prevented, true);
  assert.equal(locationSave.stopped, true);
  assert.equal(environment.sent.at(-1).type, 'OPEN_OUTPUT_DIALOG');
  assert.equal(environment.sent.at(-1).mode, 'final');

  const oldFinalSave = keyboardEvent('s', { altKey: true, ctrlKey: false });
  const messagesBeforeOldShortcut = environment.sent.length;
  environment.window.dispatch('keydown', oldFinalSave);
  assert.equal(oldFinalSave.prevented, false);
  assert.equal(oldFinalSave.stopped, false);
  assert.equal(environment.sent.length, messagesBeforeOldShortcut);
});

test('waits for static text changes after an in-page action link', async () => {
  const environment = createContentEnvironment({ now: 1000 });
  const resend = new FakeElement('a', {
    attributes: { href: '#' },
    parent: environment.body,
    text: 'Resend security code'
  });

  environment.window.dispatch('click', { target: resend });
  assert.equal(environment.captures().length, 0);

  new FakeElement('div', {
    parent: environment.body,
    text: 'A new security code was sent. Please use the most recent code.'
  });
  environment.notifyMutations();
  environment.runTimers();
  await environment.flush();
  environment.runTimers();
  await environment.flush();

  assert.equal(environment.captures().length, 1);
  assert.equal(environment.captures()[0].reason, 'link-action');
  assert.equal(environment.captures()[0].label, 'Resend security code');
  assert.equal(environment.captures()[0].actionAt, 1000);
});

test('labels each native and ARIA toggle with its current state', () => {
  const environment = createContentEnvironment({ now: 1000 });
  const firstChoice = new FakeInputElement('input', {
    attributes: { 'aria-label': 'Email verification', type: 'radio' },
    parent: environment.body
  });
  const secondChoice = new FakeInputElement('input', {
    attributes: { 'aria-label': 'Text verification', type: 'radio' },
    parent: environment.body
  });
  firstChoice.type = 'radio';
  secondChoice.type = 'radio';

  firstChoice.checked = true;
  environment.window.dispatch('change', { target: firstChoice });
  environment.setNow(1100);
  firstChoice.checked = false;
  secondChoice.checked = true;
  environment.window.dispatch('change', { target: secondChoice });

  const paperless = new FakeElement('div', {
    attributes: { 'aria-checked': 'false', 'aria-label': 'Paperless delivery', role: 'checkbox' },
    parent: environment.body
  });
  environment.setNow(1200);
  environment.window.dispatch('click', { target: paperless });
  paperless.setAttribute('aria-checked', 'true');
  environment.runTimers();

  assert.deepEqual(
    environment.captures().map(({ reason, label }) => ({ reason, label })),
    [
      { reason: 'toggle', label: 'Email verification = checked' },
      { reason: 'toggle', label: 'Text verification = checked' },
      { reason: 'toggle', label: 'Paperless delivery = checked' }
    ]
  );
});
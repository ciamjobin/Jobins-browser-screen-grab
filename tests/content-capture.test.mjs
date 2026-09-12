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
      if (part === '*') return true;
      if (role) return this.getAttribute('role') === role[1];
      if (type) return this.tagName === 'INPUT' && this.getAttribute('type') === type[1];
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

function createContentEnvironment() {
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
    getElementById: () => null,
    querySelector: (selector) => allElements().find((element) => element.matches(selector)) || null,
    querySelectorAll: (selector) => allElements().filter((element) => element.matches(selector))
  };
  const sent = [];
  const timers = new Map();
  const mutationObservers = [];
  let nextTimer = 1;
  const window = {
    ...windowEvents,
    innerHeight: 800,
    innerWidth: 1280,
    scrollY: 0,
    getSelection: () => ({ toString: () => '' })
  };
  const context = {
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
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve({ ok: true });
        },
        onMessage: { addListener() {} }
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
    notifyMutations() {
      for (const observer of mutationObservers) {
        if (!observer.disconnected) observer.callback([]);
      }
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

test('does not zoom a short modal with a scrollbar or capture its scroll', () => {
  const environment = createContentEnvironment();
  const { body, document } = environment;
  const dialog = new FakeElement('div', {
    attributes: { role: 'dialog' },
    parent: body,
    text: 'Short terms',
    rect: { left: 360, top: 240, width: 560, height: 220 }
  });
  dialog.clientHeight = 180;
  dialog.scrollHeight = 900;
  dialog.scrollTop = 480;
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

test('sends save and new-recording requests for recorder hotkeys', () => {
  const environment = createContentEnvironment();
  const keyboardEvent = (key) => ({
    key,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
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

  const save = keyboardEvent('s');
  environment.window.dispatch('keydown', save);
  environment.runTimers();
  assert.equal(save.prevented, true);
  assert.equal(save.stopped, true);
  assert.equal(environment.sent.at(-1).type, 'SAVE_FLOW');
  assert.equal(environment.sent.at(-1).reveal, undefined);

  const saveChord = keyboardEvent('s');
  const open = keyboardEvent('o');
  environment.window.dispatch('keydown', saveChord);
  environment.window.dispatch('keydown', open);
  environment.runTimers();
  assert.equal(open.prevented, true);
  assert.equal(environment.sent.at(-1).type, 'SAVE_FLOW');
  assert.equal(environment.sent.at(-1).reveal, true);
  assert.equal(environment.sent.filter((message) => message.type === 'SAVE_FLOW').length, 2);

  const startNew = keyboardEvent('n');
  environment.window.dispatch('keydown', startNew);
  assert.equal(startNew.prevented, true);
  assert.equal(environment.sent.at(-1).type, 'START_NEW_RECORDING');
});
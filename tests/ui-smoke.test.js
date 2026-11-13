import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A tiny DOM/Storage/SillyTavern stub. This is not a browser test; it only
 * proves that the extension module wires events, settings, fetch, replacement
 * and undo together without syntax or reference errors.
 */

function makeStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  };
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) {
      this.values.add(name);
    }
  }

  remove(...names) {
    for (const name of names) {
      this.values.delete(name);
    }
  }

  toggle(name) {
    if (this.values.has(name)) {
      this.values.delete(name);
      return false;
    }
    this.values.add(name);
    return true;
  }

  contains(name) {
    return this.values.has(name);
  }
}

const elements = new Map();

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.options = [];
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.textContent = '';
    this._innerHTML = '';
    this.title = '';
  }

  showModal() { this.open = true; }
  close() { this.open = false; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }

  click() {
    this.dispatch('click');
  }

  add(option) {
    this.options.push(option);
  }

  append(child) {
    if (child?.id) elements.set(child.id, child);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') {
      this.options = [];
    }
    registerIds(value);
  }
}

function registerIds(html) {
  for (const match of String(html).matchAll(/id="([^"]+)"/g)) {
    if (!elements.has(match[1])) {
      elements.set(match[1], new FakeElement(match[1]));
    }
  }
}

const documentStub = {
  readyState: 'complete',
  body: {
    append(child) {
      if (child?.id) elements.set(child.id, child);
    },
  },
  createElement() {
    return new FakeElement();
  },
  getElementById(id) {
    return elements.get(id) || null;
  },
  addEventListener() {
    // No-op.
  },
};

globalThis.document = documentStub;
globalThis.localStorage = makeStorage();
globalThis.sessionStorage = makeStorage();
globalThis.Option = class Option {
  constructor(text, value) {
    this.text = text;
    this.value = value;
  }
};

const handlers = new Map();
let saveCount = 0;
let fetchCalls = [];
let fetchImpl = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ text: 'polished', model: 'gemini-test', usage: { totalTokenCount: 1 } }),
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
};

const context = {
  eventTypes: {
    APP_READY: 'APP_READY',
    CHAT_CHANGED: 'CHAT_CHANGED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    GENERATION_STARTED: 'GENERATION_STARTED',
  },
  eventSource: {
    on(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, []);
      }
      handlers.get(type).push(handler);
    },
    async emit(type, ...args) {
      for (const handler of handlers.get(type) || []) {
        await handler(...args);
      }
    },
  },
  extensionSettings: {},
  saveSettingsDebounced() {},
  chatCompletionSettings: {
    preset_settings_openai: 'P1',
    presets: {
      P1: {
        prompts: [
          { identifier: 'main', content: 'Write as {{char}}.', role: 'system' },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [{
          character_id: 100000,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'chatHistory', enabled: true },
          ],
        }],
      },
    },
  },
  chat: [{ mes: 'hello', is_user: false, name: 'Alice', send_date: '1' }],
  chatId: 'chat-1',
  characterId: 0,
  groupId: null,
  substituteParams: text => String(text).replaceAll('{{char}}', 'Alice'),
  saveChat: async () => {
    saveCount += 1;
  },
  updateMessageBlock() {},
  getRequestHeaders() {
    return { 'Content-Type': 'application/json' };
  },
};

context.getPresetManager = api => {
  assert.equal(api, 'openai');
  return {
    getPresetList: () => ({ presets: [context.chatCompletionSettings.presets.P1], preset_names: { P1: 0 }, settings: {} }),
    getSelectedPresetName: () => 'P1',
  };
};

globalThis.SillyTavern = {
  getContext: () => context,
};

const tick = () => new Promise(resolve => setTimeout(resolve, 50));

test('extension UI wiring: init, polish, replace, undo and stale-result protection', async t => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.confirm = () => true;
  elements.set('extensionsMenu', new FakeElement('extensionsMenu'));
  await import('../index.js');
  const ready = handlers.get('APP_READY') || [];
  assert.equal(ready.length, 1);
  await ready[0]();
  await tick();

  assert.equal(document.getElementById('stvp-root').dataset.theme, 'dark');
  document.getElementById('stvp-theme').click();
  assert.equal(document.getElementById('stvp-root').dataset.theme, 'light');

  const panel = document.getElementById('stvp-panel');
  document.getElementById('stvp-menu-entry').click();
  assert.equal(panel.open, true);
  document.getElementById('stvp-close').click();
  assert.equal(panel.open, false);
  document.getElementById('stvp-menu-entry').click();
  assert.equal(panel.open, true);

  const preset = document.getElementById('stvp-preset');
  assert.equal(preset.options.length, 2);
  assert.equal(preset.value, 'P1');
  assert.equal(document.getElementById('stvp-target').textContent.includes('第 1 条'), true);
  assert.equal(document.getElementById('stvp-entry-editor').classList.contains('stvp-hidden'), false);
  assert.match(document.getElementById('stvp-entry-count').textContent, /启用/);

  const model = document.getElementById('stvp-model');
  assert.equal(model.options.length, 4);
  assert.equal(document.getElementById('stvp-fab'), null);
  assert.equal(document.getElementById('stvp-settings-entry'), null);
  model.value = '__custom__';
  model.dispatch('change');
  document.getElementById('stvp-model-custom').value = 'gemini-4-flash';
  document.getElementById('stvp-model-add').click();
  assert.equal(model.value, 'gemini-4-flash');
  assert.ok(context.extensionSettings.st_vertex_polish.customModels.includes('gemini-4-flash'));
  document.getElementById('stvp-model-remove').click();
  assert.equal(context.extensionSettings.st_vertex_polish.customModels.includes('gemini-4-flash'), false);
  model.value = 'gemini-3.8-flash';
  model.dispatch('change');

  context.extensionSettings.st_vertex_polish.backendUrl = 'https://backend.test';
  sessionStorage.setItem('stvp.token.session', 'token-1234567890');

  document.getElementById('stvp-run').click();
  await tick();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://backend.test/api/polish');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer token-1234567890');
  assert.equal(fetchCalls[0].init.redirect, 'error');
  assert.equal(fetchCalls[0].init.credentials, 'omit');
  assert.equal(fetchCalls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(document.getElementById('stvp-token').value, '');
  assert.ok(document.getElementById('stvp-menu-entry'));
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.match(body.systemInstruction, /Write as Alice/);
  assert.match(body.prompt, /hello/);

  assert.equal(document.getElementById('stvp-polished').textContent, 'polished');
  assert.equal(document.getElementById('stvp-apply').disabled, false);

  document.getElementById('stvp-followup').value = '更简洁';
  document.getElementById('stvp-refine').click();
  await tick();
  assert.match(JSON.parse(fetchCalls.at(-1).init.body).prompt, /polished/);
  assert.match(JSON.parse(fetchCalls.at(-1).init.body).systemInstruction, /更简洁/);
  assert.equal(document.getElementById('stvp-versions').options.length, 2);
  document.getElementById('stvp-apply').click();
  await tick();
  assert.equal(context.chat[0].mes, 'polished');
  assert.equal(saveCount, 1);
  assert.equal(document.getElementById('stvp-undo').disabled, false);

  document.getElementById('stvp-undo').click();
  await tick();
  assert.equal(context.chat[0].mes, 'hello');
  assert.equal(saveCount, 2);

  // A stale response must not offer replacement after the message was edited.
  context.chat[0].mes = 'edited elsewhere';
  fetchImpl = async () => new Promise(resolve => setTimeout(() => resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ text: 'late result' }),
  }), 80));
  document.getElementById('stvp-run').click();
  await tick();
  context.chat[0].mes = 'edited again';
  await context.eventSource.emit('MESSAGE_EDITED', 0);
  await new Promise(resolve => setTimeout(resolve, 120));

  assert.equal(context.chat[0].mes, 'edited again');
  assert.equal(document.getElementById('stvp-apply').disabled, true);

  // Swipe-aware replacement: only the current swipe may change.
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ text: 'swipe polished', model: 'gemini-test' }),
  });
  context.chatId = 'chat-2';
  context.chat = [{ mes: 'b', is_user: false, name: 'Alice', send_date: '2', swipes: ['a', 'b'], swipe_id: 1 }];
  await context.eventSource.emit('CHAT_CHANGED', 'chat-2');
  await tick();

  document.getElementById('stvp-run').click();
  await tick();
  assert.equal(document.getElementById('stvp-polished').textContent, 'swipe polished');
  document.getElementById('stvp-apply').click();
  await tick();
  assert.equal(context.chat[0].mes, 'swipe polished');
  assert.deepEqual(context.chat[0].swipes, ['a', 'swipe polished']);

  document.getElementById('stvp-undo').click();
  await tick();
  assert.equal(context.chat[0].mes, 'b');
  assert.deepEqual(context.chat[0].swipes, ['a', 'b']);
  document.getElementById('stvp-lock').click();
  assert.equal(localStorage.getItem('stvp.token.local'), null);
  assert.equal(sessionStorage.getItem('stvp.token.session'), null);
  assert.equal(document.getElementById('stvp-token').value, '');

  // Real input flow: no automatic loss on blur; saving and verification use the exact value.
  const tokenInput = document.getElementById('stvp-token');
  document.getElementById('stvp-url').value = 'https://backend.test';
  tokenInput.value = 'new-private-token-123456';
  tokenInput.dispatch('input');
  tokenInput.dispatch('change');
  document.getElementById('stvp-save-connection').click();
  assert.equal(tokenInput.value, 'new-private-token-123456');
  fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer new-private-token-123456');
    return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
  };
  document.getElementById('stvp-check').click();
  assert.equal(document.getElementById('stvp-check').disabled, true);
  await tick();
  assert.match(document.getElementById('stvp-error').textContent, /401/);
  assert.equal(document.getElementById('stvp-check').disabled, false);
  fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ models: ['gemini-3.8-flash'], defaultModel: 'gemini-3.8-flash', location: 'global' }) });
  document.getElementById('stvp-check').click();
  await tick();
  assert.match(document.getElementById('stvp-connection-status').textContent, /连接成功/);
  assert.equal(document.getElementById('stvp-model').value, 'gemini-3.8-flash');
});

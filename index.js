import {
  buildPresetInstruction,
  composeRequest,
  getMessageText,
  pickTargetMessage,
  readSampling,
  snapshotMatches,
} from './src/core.js';

const MODULE_NAME = 'st_vertex_polish';
const TOKEN_SESSION_KEY = 'stvp.token.session';
const TOKEN_LOCAL_KEY = 'stvp.token.local';
const MAX_INPUT_CHARS = 20000;
const CLIENT_TIMEOUT_MS = 90000;

const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: '',
  presetName: '',
  customPrompt: '',
  rememberToken: false,
});

const state = {
  requestId: 0,
  controller: null,
  busy: false,
  pending: null,
  undo: null,
};

let initialized = false;
let ui = null;

function getContextOrThrow() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) {
    throw new Error('无法获取 SillyTavern 上下文，请确认扩展已启用。');
  }
  return context;
}

function getSettings() {
  const { extensionSettings } = getContextOrThrow();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  const settings = extensionSettings[MODULE_NAME];
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(settings, key)) {
      settings[key] = DEFAULT_SETTINGS[key];
    }
  }
  return settings;
}

function persistSettings() {
  try {
    getContextOrThrow().saveSettingsDebounced?.();
  } catch {
    // Settings persistence is best-effort; the panel keeps working.
  }
}

function readToken() {
  try {
    const session = sessionStorage.getItem(TOKEN_SESSION_KEY);
    if (session) {
      return session;
    }
  } catch {
    // Storage can be unavailable in hardened WebViews.
  }
  try {
    return getSettings().rememberToken ? (localStorage.getItem(TOKEN_LOCAL_KEY) || '') : '';
  } catch {
    return '';
  }
}

function writeToken(value) {
  const token = String(value ?? '');
  try {
    sessionStorage.setItem(TOKEN_SESSION_KEY, token);
  } catch {
    // Ignore storage failures.
  }
  try {
    if (getSettings().rememberToken) {
      localStorage.setItem(TOKEN_LOCAL_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_LOCAL_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function normalizeBaseUrl(value) {
  let url = String(value ?? '').trim();
  if (!url) {
    return '';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '').replace(/\/api\/polish$/i, '');
}

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, kind = '') {
  if (!ui) {
    return;
  }
  ui.status.textContent = text || '';
  ui.status.dataset.kind = kind;
}

function showError(message) {
  if (!ui) {
    return;
  }
  ui.error.textContent = String(message || '未知错误');
  ui.error.classList.remove('stvp-hidden');
  setStatus('失败', 'error');
}

function clearError() {
  if (!ui) {
    return;
  }
  ui.error.textContent = '';
  ui.error.classList.add('stvp-hidden');
}

function setBusy(busy) {
  if (!ui) {
    return;
  }
  ui.run.disabled = Boolean(busy);
  ui.run.textContent = busy ? '润色中…' : '开始润色';
}

function hideResult() {
  if (!ui) {
    return;
  }
  ui.result.classList.add('stvp-hidden');
  ui.original.textContent = '';
  ui.polished.textContent = '';
  ui.apply.disabled = true;
}

function updateUndoButton() {
  if (!ui) {
    return;
  }
  ui.undo.disabled = !state.undo;
}

function refreshTargetLabel() {
  if (!ui) {
    return;
  }
  const context = getContextOrThrow();
  const target = pickTargetMessage(context.chat);
  if (!target) {
    ui.target.textContent = '没有可润色的 AI 回复';
    ui.run.disabled = true;
    return;
  }
  ui.run.disabled = state.busy;
  const name = target.name ? ` · ${target.name}` : '';
  const swipe = target.swipeId !== null ? ` · 版本 ${target.swipeId + 1}/${target.swipeCount}` : '';
  ui.target.textContent = `第 ${target.index + 1} 条${name}${swipe}`;
}

async function loadSettingsObject() {
  const context = getContextOrThrow();
  if (context.chatCompletionSettings?.presets) {
    return context.chatCompletionSettings;
  }
  try {
    const response = await fetch('/api/settings/get', {
      method: 'POST',
      headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data?.oai_settings ?? data?.settings?.oai_settings ?? null;
  } catch {
    return null;
  }
}

async function refreshPresets() {
  if (!ui) {
    return;
  }
  const select = ui.preset;
  const settingsObject = await loadSettingsObject();
  const presets = settingsObject?.presets;
  const names = presets && typeof presets === 'object'
    ? Object.keys(presets).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    : [];

  select.innerHTML = '';
  select.add(new Option('不使用预设（仅自定义要求）', '__none__'));
  for (const name of names) {
    select.add(new Option(name, name));
  }

  const saved = getSettings().presetName;
  const active = settingsObject?.preset_settings_openai;
  let chosen = '__none__';
  if (saved === '__none__') {
    chosen = '__none__';
  } else if (saved && names.includes(saved)) {
    chosen = saved;
  } else if (active && names.includes(active)) {
    chosen = active;
  } else if (names.length > 0) {
    chosen = names[0];
  }
  select.value = chosen;
  getSettings().presetName = chosen;
  persistSettings();

  if (!names.length) {
    setStatus('未读取到酒馆预设', 'warn');
  } else {
    setStatus(`已读取 ${names.length} 个预设`, '');
  }
}

async function getPresetByName(name) {
  if (!name || name === '__none__') {
    return null;
  }
  const settingsObject = await loadSettingsObject();
  return settingsObject?.presets?.[name] ?? null;
}

async function buildRequest() {
  const context = getContextOrThrow();
  const target = pickTargetMessage(context.chat);
  if (!target) {
    throw new Error('当前聊天没有可润色的 AI 回复。');
  }
  if (!target.text.trim()) {
    throw new Error('最新一条 AI 回复是空的，无法润色。');
  }

  const presetName = ui.preset.value;
  const preset = await getPresetByName(presetName);
  if (presetName !== '__none__' && !preset) {
    throw new Error(`找不到预设「${presetName}」，请点刷新后重试。`);
  }

  const presetInfo = buildPresetInstruction(preset, {
    substitute: text => {
      // The target is appended separately; avoid duplicating it through a
      // {{lastMessage}} macro in a preset.
      const sanitized = String(text).replace(/\{\{lastMessage\}\}/gi, '');
      return typeof context.substituteParams === 'function' ? context.substituteParams(sanitized) : sanitized;
    },
    characterId: context.characterId,
    isGroup: Boolean(context.groupId),
  });

  const composed = composeRequest({
    presetText: presetInfo.text,
    customPrompt: getSettings().customPrompt,
    targetText: target.text,
    maxInputChars: MAX_INPUT_CHARS,
  });
  if (composed.error) {
    throw new Error(composed.error);
  }

  return {
    target,
    presetName,
    presetInfo,
    composed,
    sampling: readSampling(preset, target.text.length),
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function formatHttpError(response, data) {
  const map = {
    unauthorized: '访问口令错误',
    origin_not_allowed: '后端拒绝了当前页面来源',
    too_large: '发送内容过长',
    invalid_request: '请求参数无效',
    rate_limited: '请求太频繁',
    daily_limit: '已达到今日次数上限',
    blocked: '内容被 Google 安全策略拦截',
    output_truncated: '模型输出被截断',
    timeout: '后端等待 Vertex 超时',
    upstream_error: 'Vertex 返回错误',
    backend_auth_failed: '后端无法获取 Google 访问令牌',
  };
  const base = map[data?.error] || `请求失败（HTTP ${response.status}）`;
  const detail = typeof data?.message === 'string' && data.message ? `：${data.message}` : '';
  const requestId = typeof data?.requestId === 'string' ? `（请求 ${data.requestId.slice(0, 8)}）` : '';
  return `${base}${detail}${requestId}`;
}

function pendingStillValid(snapshot) {
  const context = getContextOrThrow();
  if (context.chatId !== snapshot.chatId) {
    return false;
  }
  const latest = pickTargetMessage(context.chat);
  return Boolean(latest) && latest.index === snapshot.index && snapshotMatches(context.chat, snapshot);
}

function invalidatePending(message) {
  state.requestId += 1;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  state.busy = false;
  state.pending = null;
  setBusy(false);
  hideResult();
  updateUndoButton();
  setStatus(message, 'warn');
}

async function runPolish() {
  if (state.busy) {
    return;
  }
  clearError();

  const settings = getSettings();
  const rawUrl = ui.url.value.trim() || settings.backendUrl;
  const baseUrl = normalizeBaseUrl(rawUrl);
  const token = ui.token.value || readToken();
  settings.backendUrl = rawUrl;
  settings.customPrompt = ui.custom.value;
  persistSettings();
  ui.meta.textContent = '';
  if (!baseUrl) {
    showError('请先在“连接设置”里填写后端地址。');
    ui.settings.open = true;
    return;
  }
  if (!token) {
    showError('请先填写访问口令。');
    ui.settings.open = true;
    return;
  }

  state.pending = null;
  hideResult();
  state.busy = true;
  setBusy(true);
  setStatus('准备请求…');

  let built;
  try {
    built = await buildRequest();
  } catch (error) {
    state.busy = false;
    setBusy(false);
    setStatus('');
    showError(error?.message || String(error));
    return;
  }

  const context = getContextOrThrow();
  const snapshot = {
    chatId: context.chatId,
    index: built.target.index,
    swipeId: built.target.swipeId,
    text: built.target.text,
    sendDate: built.target.message?.send_date,
    name: built.target.name,
  };
  const requestId = state.requestId + 1;
  state.requestId = requestId;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CLIENT_TIMEOUT_MS);

  const presetLabel = built.presetName === '__none__' ? '无预设' : built.presetName;
  setStatus(`请求中 · ${presetLabel} · ${built.presetInfo.used} 条预设指令 · ${built.composed.chars} 字符`);
  ui.meta.textContent = `预设条目 ${built.presetInfo.used} 条，跳过 ${built.presetInfo.skipped} 条；发送 ${built.composed.chars} 字符。`;

  try {
    const response = await fetch(`${baseUrl}/api/polish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        systemInstruction: built.composed.systemInstruction,
        prompt: built.composed.prompt,
        ...built.sampling,
      }),
      signal: controller.signal,
    });
    const data = await readJson(response);

    if (requestId !== state.requestId) {
      return;
    }
    if (!response.ok) {
      throw new Error(formatHttpError(response, data));
    }

    const polished = String(data?.text ?? '').trim();
    if (!polished) {
      throw new Error('后端返回了空结果。');
    }
    if (!pendingStillValid(snapshot)) {
      setStatus('聊天已变化，结果已丢弃', 'warn');
      return;
    }

    state.pending = {
      snapshot,
      text: polished,
      model: typeof data?.model === 'string' ? data.model : '',
      truncated: Boolean(data?.truncated),
    };
    ui.original.textContent = snapshot.text;
    ui.polished.textContent = polished;
    ui.apply.disabled = false;
    ui.result.classList.remove('stvp-hidden');
    ui.undo.disabled = !state.undo;

    if (state.pending.truncated) {
      setStatus('完成，但输出可能被截断', 'warn');
    } else {
      setStatus(
        `完成${state.pending.model ? ` · ${state.pending.model}` : ''}${data?.usage?.totalTokenCount ? ` · ${data.usage.totalTokenCount} tokens` : ''}`,
        'ok',
      );
    }
  } catch (error) {
    if (requestId !== state.requestId) {
      return;
    }
    if (error?.name === 'AbortError') {
      setStatus(timedOut ? '请求超时，已取消' : '已取消', 'warn');
      return;
    }
    showError(error?.message || String(error));
  } finally {
    clearTimeout(timeoutId);
    if (requestId === state.requestId) {
      state.busy = false;
      state.controller = null;
      setBusy(false);
    }
  }
}

async function applyPolish() {
  const pending = state.pending;
  if (!pending) {
    return;
  }
  const context = getContextOrThrow();
  if (context.chatId !== pending.snapshot.chatId || !pendingStillValid(pending.snapshot)) {
    invalidatePending('消息已变化，不能替换');
    return;
  }

  const message = context.chat[pending.snapshot.index];
  const originalText = pending.snapshot.text;
  const appliedText = pending.text;

  message.mes = appliedText;
  if (pending.snapshot.swipeId !== null && Array.isArray(message.swipes)) {
    message.swipes[pending.snapshot.swipeId] = appliedText;
    if (!Number.isInteger(message.swipe_id)) {
      message.swipe_id = pending.snapshot.swipeId;
    }
  }

  try {
    if (typeof context.saveChat !== 'function') {
      throw new Error('当前酒馆版本缺少 saveChat');
    }
    await context.saveChat();
  } catch (error) {
    message.mes = originalText;
    if (pending.snapshot.swipeId !== null && Array.isArray(message.swipes)) {
      message.swipes[pending.snapshot.swipeId] = originalText;
    }
    showError(`保存失败：${error?.message || String(error)}`);
    return;
  }

  try {
    context.updateMessageBlock?.(pending.snapshot.index, message);
  } catch {
    // DOM refresh is cosmetic; the saved chat is authoritative.
  }
  try {
    await context.eventSource?.emit?.(context.eventTypes.MESSAGE_EDITED, pending.snapshot.index);
  } catch {
    // Event listeners must not block replacement.
  }

  state.undo = {
    chatId: pending.snapshot.chatId,
    index: pending.snapshot.index,
    swipeId: pending.snapshot.swipeId,
    original: originalText,
    applied: appliedText,
  };
  state.pending = null;
  ui.apply.disabled = true;
  ui.result.classList.add('stvp-hidden');
  updateUndoButton();
  setStatus('已替换，可撤销', 'ok');
  refreshTargetLabel();
}

async function undoPolish() {
  const undo = state.undo;
  if (!undo) {
    return;
  }
  const context = getContextOrThrow();
  if (context.chatId !== undo.chatId) {
    state.undo = null;
    updateUndoButton();
    showError('聊天已切换，无法撤销。');
    return;
  }
  const message = context.chat[undo.index];
  const currentSwipe = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
  const sameSwipe = undo.swipeId === null || (Array.isArray(message?.swipes) && currentSwipe === undo.swipeId);
  if (!message || getMessageText(message) !== undo.applied || !sameSwipe) {
    state.undo = null;
    updateUndoButton();
    showError('消息已被再次修改，无法安全撤销。');
    return;
  }

  message.mes = undo.original;
  if (undo.swipeId !== null && Array.isArray(message.swipes)) {
    message.swipes[undo.swipeId] = undo.original;
    if (!Number.isInteger(message.swipe_id)) {
      message.swipe_id = undo.swipeId;
    }
  }

  try {
    await context.saveChat();
  } catch (error) {
    message.mes = undo.applied;
    if (undo.swipeId !== null && Array.isArray(message.swipes)) {
      message.swipes[undo.swipeId] = undo.applied;
    }
    showError(`撤销保存失败：${error?.message || String(error)}`);
    return;
  }

  try {
    context.updateMessageBlock?.(undo.index, message);
  } catch {
    // Cosmetic.
  }
  try {
    await context.eventSource?.emit?.(context.eventTypes.MESSAGE_EDITED, undo.index);
  } catch {
    // Ignore listener failures.
  }

  state.undo = null;
  updateUndoButton();
  setStatus('已撤销', 'ok');
  refreshTargetLabel();
}

function onChatChanged() {
  state.requestId += 1;
  state.controller?.abort();
  state.controller = null;
  state.busy = false;
  state.pending = null;
  state.undo = null;
  setBusy(false);
  hideResult();
  updateUndoButton();
  clearError();
  setStatus('');
  ui.meta.textContent = '';
  refreshTargetLabel();
}

function onMessageMaybeChanged() {
  refreshTargetLabel();
  if (state.pending && !pendingStillValid(state.pending.snapshot)) {
    invalidatePending('消息已变化，结果已失效');
  }
}

function onGenerationStarted() {
  if (state.busy || state.pending) {
    invalidatePending('正在生成回复，已取消润色');
  }
}

function openPanel() {
  ui.panel.classList.remove('stvp-hidden');
  ui.panel.classList.remove('stvp-minimized');
  refreshTargetLabel();
  if (ui.preset.options.length === 0) {
    refreshPresets();
  }
}

function closePanel() {
  if (state.busy) {
    invalidatePending('已取消');
  }
  ui.panel.classList.add('stvp-hidden');
}

function mountUi() {
  if (document.getElementById('stvp-fab')) {
    return;
  }
  const root = document.createElement('div');
  root.id = 'stvp-root';
  root.innerHTML = `
    <button id="stvp-fab" type="button" title="Vertex 润色">润色</button>
    <section id="stvp-panel" class="stvp-hidden" aria-label="Vertex 润色">
      <header class="stvp-header">
        <div class="stvp-heading">
          <span class="stvp-title">Vertex 润色</span>
          <span id="stvp-target" class="stvp-target">正在读取聊天…</span>
        </div>
        <div class="stvp-head-actions">
          <button id="stvp-min" type="button" title="收起" aria-label="收起">—</button>
          <button id="stvp-close" type="button" title="关闭" aria-label="关闭">×</button>
        </div>
      </header>
      <div id="stvp-body" class="stvp-body">
        <details id="stvp-settings" class="stvp-settings">
          <summary>连接设置</summary>
          <label class="stvp-field">
            <span>后端地址</span>
            <input id="stvp-url" type="url" inputmode="url" placeholder="https://your-service.run.app" autocomplete="off" spellcheck="false">
          </label>
          <label class="stvp-field">
            <span>访问口令</span>
            <input id="stvp-token" type="password" placeholder="POLISH_ACCESS_TOKEN" autocomplete="current-password">
          </label>
          <label class="stvp-check">
            <input id="stvp-remember" type="checkbox">
            <span>在本设备记住口令</span>
          </label>
          <p class="stvp-hint">口令只保存在浏览器；后端地址、预设和自定义要求会写入酒馆扩展设置。不要把口令提交到公开仓库。</p>
        </details>

        <div class="stvp-row">
          <label class="stvp-field stvp-grow">
            <span>酒馆预设</span>
            <select id="stvp-preset"></select>
          </label>
          <button id="stvp-refresh" type="button" class="stvp-secondary">刷新</button>
        </div>

        <label class="stvp-field">
          <span>自定义润色要求</span>
          <textarea id="stvp-custom" rows="3" maxlength="4000" placeholder="例如：更口语化；保留第二人称；不要减少细节。"></textarea>
        </label>

        <div class="stvp-actions">
          <button id="stvp-run" type="button" class="stvp-primary">开始润色</button>
          <span id="stvp-status" class="stvp-status" role="status"></span>
        </div>

        <div id="stvp-meta" class="stvp-hint"></div>
        <div id="stvp-error" class="stvp-error stvp-hidden" role="alert"></div>

        <div id="stvp-result" class="stvp-result stvp-hidden">
          <div class="stvp-label">原文</div>
          <div id="stvp-original" class="stvp-text"></div>
          <div class="stvp-label">润色结果</div>
          <div id="stvp-polished" class="stvp-text"></div>
          <div class="stvp-actions">
            <button id="stvp-apply" type="button" class="stvp-primary" disabled>替换当前回复</button>
            <button id="stvp-undo" type="button" class="stvp-secondary" disabled>撤销上次替换</button>
          </div>
        </div>
      </div>
    </section>
  `;
  document.body.append(root);

  ui = {
    panel: $('stvp-panel'),
    body: $('stvp-body'),
    target: $('stvp-target'),
    settings: $('stvp-settings'),
    url: $('stvp-url'),
    token: $('stvp-token'),
    remember: $('stvp-remember'),
    preset: $('stvp-preset'),
    refresh: $('stvp-refresh'),
    custom: $('stvp-custom'),
    run: $('stvp-run'),
    status: $('stvp-status'),
    meta: $('stvp-meta'),
    error: $('stvp-error'),
    result: $('stvp-result'),
    original: $('stvp-original'),
    polished: $('stvp-polished'),
    apply: $('stvp-apply'),
    undo: $('stvp-undo'),
  };

  $('stvp-fab').addEventListener('click', () => {
    if (ui.panel.classList.contains('stvp-hidden')) {
      openPanel();
    } else {
      closePanel();
    }
  });
  $('stvp-min').addEventListener('click', () => {
    ui.panel.classList.toggle('stvp-minimized');
  });
  $('stvp-close').addEventListener('click', closePanel);
  ui.refresh.addEventListener('click', () => {
    refreshPresets();
  });
  ui.run.addEventListener('click', () => {
    runPolish();
  });
  ui.apply.addEventListener('click', () => {
    applyPolish();
  });
  ui.undo.addEventListener('click', () => {
    undoPolish();
  });

  ui.url.addEventListener('change', () => {
    getSettings().backendUrl = ui.url.value.trim();
    persistSettings();
  });
  ui.token.addEventListener('input', () => {
    writeToken(ui.token.value);
  });
  ui.remember.addEventListener('change', () => {
    getSettings().rememberToken = ui.remember.checked;
    writeToken(ui.token.value);
    persistSettings();
  });
  ui.custom.addEventListener('input', () => {
    getSettings().customPrompt = ui.custom.value;
    persistSettings();
  });
  ui.preset.addEventListener('change', () => {
    getSettings().presetName = ui.preset.value;
    persistSettings();
  });

  // Keep the panel usable when an Android keyboard shrinks the visual viewport.
  const viewport = globalThis.visualViewport;
  if (viewport) {
    viewport.addEventListener('resize', () => {
      const max = Math.max(240, viewport.height - 24);
      ui.panel.style.maxHeight = `${max}px`;
    });
  }
}

async function init() {
  if (initialized) {
    return;
  }
  initialized = true;
  mountUi();

  const settings = getSettings();
  ui.url.value = settings.backendUrl;
  ui.token.value = readToken();
  ui.remember.checked = Boolean(settings.rememberToken);
  ui.custom.value = settings.customPrompt;

  await refreshPresets();
  refreshTargetLabel();
  updateUndoButton();

  const context = getContextOrThrow();
  const events = context.eventTypes ?? {};
  context.eventSource?.on?.(events.CHAT_CHANGED, onChatChanged);
  context.eventSource?.on?.(events.MESSAGE_SWIPED, onMessageMaybeChanged);
  context.eventSource?.on?.(events.MESSAGE_DELETED, onMessageMaybeChanged);
  context.eventSource?.on?.(events.MESSAGE_EDITED, onMessageMaybeChanged);
  context.eventSource?.on?.(events.MESSAGE_RECEIVED, onMessageMaybeChanged);
  context.eventSource?.on?.(events.CHARACTER_MESSAGE_RENDERED, onMessageMaybeChanged);
  context.eventSource?.on?.(events.GENERATION_STARTED, onGenerationStarted);
}

function boot(attempt = 0) {
  const context = globalThis.SillyTavern?.getContext?.();
  if (context?.eventSource?.on && context?.eventTypes?.APP_READY) {
    context.eventSource.on(context.eventTypes.APP_READY, init);
    return;
  }
  if (attempt < 300) {
    setTimeout(() => boot(attempt + 1), 100);
    return;
  }
  // Extremely old versions or a delayed global: fall back to DOM ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

boot();

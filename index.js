import {
  buildPresetInstruction,
  composeRequest,
  getMessageText,
  getPresetEntries,
  pickTargetMessage,
  readSampling,
  snapshotMatches,
} from './src/core.js';

import { validateBackendUrl } from './src/connection.js';
import { diffText } from './src/diff.js';
import { readPresetCatalog } from './src/presets.js';

const MODULE_NAME = 'st_vertex_polish';
let sessionToken = '';
const TOKEN_SESSION_KEY = 'stvp.token.session';
const TOKEN_LOCAL_KEY = 'stvp.token.local';
const MAX_INPUT_CHARS = 100000;
const CLIENT_TIMEOUT_MS = 240000;

import { DEFAULT_MODELS, buildModelList, validModelId, isLegacyGemini } from './src/models.js';

const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: '',
  presetName: '',
  model: '',
  customModel: '',
  customModels: [],
  customPrompt: '',
  rememberToken: false,
  theme: 'auto',
  presetEntryOverrides: {},
});

const state = {
  requestId: 0,
  controller: null,
  busy: false,
  pending: null,
  undo: null,
  presetCatalog: null,
  drafts: [],
  draftIndex: -1,
  originSnapshot: null,
  lastPayload: null,
  lastDiagnostic: null,
  remoteModels: [],
  defaultModel: '',
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

function cleanToken(value) {
  return String(value ?? '')
    .replace(/^\s*Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function tokenShapeError(token) {
  if (!token) return '请粘贴后端私人访问口令。';
  if (/^ghp_|^github_pat_/i.test(token)) return '这是 GitHub token，不是后端访问口令。';
  if (token.startsWith('{')) return '这是 Google JSON 内容，不是后端访问口令；JSON 只应放在后端 Secret Manager。';
  if (token.length < 16) return '口令太短，请从 Secret Manager 复制完整值。';
  return '';
}

function readToken() {
  if (sessionToken) return sessionToken;
  try {
    // Migrate a prior session token into memory, then remove stored copies.
    sessionToken = cleanToken(sessionStorage.getItem(TOKEN_SESSION_KEY) || '');
    sessionStorage.removeItem(TOKEN_SESSION_KEY);
    if (!sessionToken && getSettings().rememberToken) sessionToken = cleanToken(localStorage.getItem(TOKEN_LOCAL_KEY) || '');
  } catch { /* Storage may be disabled. */ }
  return sessionToken;
}

function writeToken(value) {
  sessionToken = cleanToken(value);
  try {
    sessionStorage.removeItem(TOKEN_SESSION_KEY);
    if (getSettings().rememberToken) localStorage.setItem(TOKEN_LOCAL_KEY, sessionToken);
    else localStorage.removeItem(TOKEN_LOCAL_KEY);
  } catch { /* Memory-only mode still works. */ }
}

function setConnectionStatus(message) {
  const status = $('stvp-connection-status');
  if (status) status.textContent = message;
}

function saveConnectionCredentials() {
  try {
    const baseUrl = normalizeBaseUrl(ui.url.value);
    if (!baseUrl) throw new Error('请先填写你的 Cloud Run 后端地址。');
    const token = cleanToken(ui.token.value) || readToken();
    const tokenError = tokenShapeError(token);
    if (tokenError) throw new Error(tokenError);
    getSettings().backendUrl = baseUrl;
    getSettings().rememberToken = ui.remember.checked;
    ui.url.value = baseUrl;
    writeToken(token);
    persistSettings();
    clearError();
    setConnectionStatus('连接配置已保存；口令已暂存，尚未验证。请点击“验证连接”。');
  } catch (error) {
    setConnectionStatus(error.message);
    showError(error.message);
  }
}

let modelRequestController = null;

function normalizeBaseUrl(value) {
  return validateBackendUrl(value);
}

async function privateFetch(base, path, token, options = {}) {
  // Destination changes require confirmation before any secret leaves the page.
  if (getSettings().trustedBackend !== base) {
    if (!globalThis.confirm(`是否向此后端发送私人访问口令？\n${base}\n\n请核对这是你自己的 Cloud Run 地址。`)) {
      throw new Error('已取消连接，未发送访问口令。');
    }
    getSettings().trustedBackend = base;
    persistSettings();
  }
  return fetch(`${base}${path}`, {
    ...options,
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
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
  if ($('stvp-refine')) $('stvp-refine').disabled = Boolean(busy);
  if ($('stvp-apply') && busy) $('stvp-apply').disabled = true;
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

async function refreshPresets() {
  if (!ui) return;
  const button = ui.refresh;
  button.disabled = true;
  button.textContent = '读取中…';
  setStatus('正在读取酒馆聊天补全预设…');
  try {
    const { catalog, active } = readPresetCatalog(getContextOrThrow());
    state.presetCatalog = catalog;
    const names = [...catalog.keys()].sort((a, b) => a.localeCompare(b));
    const saved = getSettings().presetName;
    ui.preset.innerHTML = '';
    ui.preset.add(new Option('不使用预设（仅自定义要求）', '__none__'));
    for (const name of names) ui.preset.add(new Option(name, name));
    ui.preset.value = saved === '__none__' ? saved : names.includes(saved) ? saved : names.includes(active) ? active : names[0] || '__none__';
    getSettings().presetName = ui.preset.value;
    persistSettings();
    renderPresetEntries();
    setStatus(names.length ? `已读取 ${names.length} 个酒馆预设` : '没有保存的聊天补全预设，可先使用自定义要求', names.length ? 'ok' : 'warn');
  } catch (error) {
    if (!ui.preset.options.length) {
      ui.preset.add(new Option('不使用预设（仅自定义要求）', '__none__'));
      ui.preset.value = '__none__';
    }
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '刷新';
  }
}

function presetOverrides(name) {
  const settings = getSettings();
  if (!settings.presetEntryOverrides || typeof settings.presetEntryOverrides !== 'object') {
    settings.presetEntryOverrides = {};
  }
  if (!settings.presetEntryOverrides[name] || typeof settings.presetEntryOverrides[name] !== 'object') {
    settings.presetEntryOverrides[name] = {};
  }
  return settings.presetEntryOverrides[name];
}

function updateEntrySummary(entries, overrides) {
  if (!ui?.entryCount) return;
  const enabled = entries.filter(entry => {
    if (entry.marker || entry.empty) return false;
    return Object.hasOwn(overrides, entry.identifier) ? Boolean(overrides[entry.identifier]) : entry.baseEnabled;
  }).length;
  ui.entryCount.textContent = `${enabled}/${entries.filter(entry => !entry.marker && !entry.empty).length} 启用`;
}

function renderPresetEntries() {
  if (!ui?.entryEditor || !ui.entryList) return;
  const name = ui.preset.value;
  const preset = name === '__none__' ? null : state.presetCatalog?.get(name) || null;
  if (!preset) {
    ui.entryEditor.classList.add('stvp-hidden');
    ui.entryList.replaceChildren?.();
    return;
  }

  const context = getContextOrThrow();
  const { entries } = getPresetEntries(preset, {
    characterId: context.characterId,
    isGroup: Boolean(context.groupId),
  });
  const overrides = presetOverrides(name);

  ui.entryEditor.classList.remove('stvp-hidden');
  ui.entryList.replaceChildren?.();
  for (const entry of entries) {
    const row = document.createElement('label');
    row.className = 'stvp-entry-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Object.hasOwn(overrides, entry.identifier)
      ? Boolean(overrides[entry.identifier])
      : entry.baseEnabled;
    checkbox.disabled = entry.marker || entry.empty;
    checkbox.addEventListener('change', () => {
      overrides[entry.identifier] = checkbox.checked;
      getSettings().presetEntryOverrides[name] = overrides;
      persistSettings();
      updateEntrySummary(entries, overrides);
    });

    const text = document.createElement('span');
    text.className = 'stvp-entry-name';
    text.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'stvp-entry-meta';
    meta.textContent = entry.marker ? '占位·跳过' : entry.empty ? '空·跳过' : entry.role;
    row.append(checkbox, text, meta);
    ui.entryList.append(row);
  }
  updateEntrySummary(entries, overrides);
}

function applyTheme() {
  if (!ui?.panel) return;
  const root = document.getElementById('stvp-root');
  if (!root) return;
  const theme = getSettings().theme;
  const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? true;
  const dark = theme === 'dark' || (theme === 'auto' && prefersDark);
  root.dataset.theme = dark ? 'dark' : 'light';
  const button = $('stvp-theme');
  if (button) {
    button.textContent = dark ? '☀' : '☾';
    button.title = dark ? '切换到日间' : '切换到夜间';
  }
}

function toggleTheme() {
  const root = document.getElementById('stvp-root');
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  getSettings().theme = next;
  persistSettings();
  applyTheme();
}

function toggleCustomModel() {
  if (!ui) return;
  const isCustom = ui.model.value === '__custom__';
  ui.modelCustomWrap.classList.toggle('stvp-hidden', !isCustom);
  const remove = $('stvp-model-remove');
  if (remove) remove.disabled = !(getSettings().customModels || []).includes(ui.model.value);
}

function addCustomModel() {
  const id = ui.modelCustom.value.trim();
  if (!validModelId(id)) return showError('模型名只能包含字母、数字、点、下划线和短横线。');
  if (isLegacyGemini(id)) return showError('按你的设置，已移除 Gemini 3.7 之前的模型，请填写 3.7 或更新的模型。');
  const settings = getSettings();
  settings.customModels = [...new Set([...(Array.isArray(settings.customModels) ? settings.customModels : []), id])];
  settings.customModel = id;
  settings.model = id;
  populateModelSelect(state.remoteModels, state.defaultModel, id);
  clearError();
  setStatus(`已添加并选中 ${id}`, 'ok');
}

function removeCustomModel() {
  const id = ui.model.value;
  getSettings().customModels = (getSettings().customModels || []).filter(value => value !== id);
  const remote = state.remoteModels.filter(value => value !== id);
  populateModelSelect(remote, state.defaultModel, '__default__');
  setStatus(`已取消收藏 ${id}；若后端目录仍提供它，再拉取时仍会出现。`, 'ok');
}

function populateModelSelect(models, defaultModel, saved) {
  const select = ui.model;
  state.remoteModels = Array.isArray(models) ? models : [];
  state.defaultModel = defaultModel || '';
  const custom = Array.isArray(getSettings().customModels) ? getSettings().customModels : [];
  const list = buildModelList(state.remoteModels, custom);
  const savedModel = saved === '__default__' ? '' : saved;
  if (validModelId(savedModel) && !isLegacyGemini(savedModel) && !list.includes(savedModel)) {
    list.unshift(savedModel);
  }

  select.innerHTML = '';
  select.add(new Option(defaultModel ? `后端默认（${defaultModel}）` : '后端默认', '__default__'));
  for (const model of list) {
    select.add(new Option(model, model));
  }
  select.add(new Option('自定义模型名…', '__custom__'));

  if (savedModel === '__custom__') {
    select.value = '__custom__';
  } else if (savedModel && list.includes(savedModel)) {
    select.value = savedModel;
  } else if (defaultModel && list.includes(defaultModel)) {
    select.value = defaultModel;
  } else {
    select.value = '__default__';
  }

  getSettings().model = select.value;
  ui.modelCustom.value = getSettings().customModel || '';
  toggleCustomModel();
  persistSettings();
}

async function refreshModels({ silent = false } = {}) {
  if (!ui || modelRequestController) return;
  // Initial load must not send a stored secret or open a confirmation prompt.
  if (silent) {
    populateModelSelect(DEFAULT_MODELS, '', getSettings().model);
    setConnectionStatus(readToken() ? '已有暂存口令，请点击“验证连接”。' : '请填写后端地址和私人访问口令，再保存并验证。');
    return;
  }
  const controller = new AbortController();
  modelRequestController = controller;
  const check = $('stvp-check');
  const save = $('stvp-save-connection');
  const controls = [check, save, ui.modelRefresh, ui.url, ui.token, ui.remember];
  controls.forEach(control => { if (control) control.disabled = true; });
  if (check) check.textContent = '正在验证…';
  ui.modelRefresh.textContent = '拉取中…';
  clearError();
  setConnectionStatus('正在验证连接并拉取模型列表…');
  setStatus('正在连接后端…');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const baseUrl = normalizeBaseUrl(ui.url.value);
    const token = cleanToken(ui.token.value) || readToken();
    if (!baseUrl) throw new Error('请先填写 Cloud Run 后端地址。');
    const tokenError = tokenShapeError(token);
    if (tokenError) throw new Error(tokenError);
    const response = await privateFetch(baseUrl, '/api/models', token, { signal: controller.signal });
    const data = await readJson(response);
    if (controller.signal.aborted) throw new Error('已取消连接验证。');
    if (response.status === 401) {
      const requestId = typeof data?.requestId === 'string' ? `（请求 ${data.requestId.slice(0, 8)}）` : '';
      throw new Error(`认证失败（401）${requestId}：口令与当前 Cloud Run revision 不一致。请重新从 Secret Manager 复制 polish-access-token；若刚更新过 Secret，需重新部署后端以加载最新版本。`);
    }
    if (!response.ok) throw new Error(formatHttpError(response, data));
    if (!Array.isArray(data?.models)) throw new Error('后端返回的模型列表格式不正确，请确认后端已更新。');
    const models = data.models.filter(model => typeof model === 'string');
    populateModelSelect(models, typeof data.defaultModel === 'string' ? data.defaultModel : '', getSettings().model);
    getSettings().backendUrl = baseUrl;
    writeToken(token);
    persistSettings();
    setConnectionStatus(`连接成功 · ${data.location || 'Vertex'} · ${models.length} 个预置模型（非实时 Google 目录）`);
    setStatus(`已拉取 ${models.length} 个模型`, 'ok');
  } catch (error) {
    const message = timedOut ? '连接超时（15 秒），请检查后端地址和网络后重试。'
      : controller.signal.aborted ? '已取消连接验证。'
      : error instanceof TypeError ? '连接失败：请检查后端地址、网络或后端来源设置。'
      : error?.message || '连接失败，请稍后重试。';
    // Do not echo raw fetch responses, request headers, or credential values.
    setConnectionStatus(message);
    showError(message);
  } finally {
    clearTimeout(timer);
    modelRequestController = null;
    controls.forEach(control => { if (control) control.disabled = false; });
    if (check) check.textContent = '验证连接 / 拉取列表';
    ui.modelRefresh.textContent = '拉取';
  }
}

function selectedModel() {
  if (!ui) {
    return '';
  }
  if (ui.model.value === '__custom__') {
    return ui.modelCustom.value.trim();
  }
  if (ui.model.value === '__default__') {
    return '';
  }
  return ui.model.value;
}

async function getPresetByName(name) {
  if (!name || name === '__none__') return null;
  return readPresetCatalog(getContextOrThrow()).catalog.get(name) || null;
}

async function buildRequest(targetOverride = null) {
  const context = getContextOrThrow();
  const target = targetOverride || pickTargetMessage(context.chat);
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

  const model = selectedModel();
  if (ui.model.value === '__custom__' && !model) {
    throw new Error('请填写自定义模型名。');
  }
  if (model && !/^[a-z0-9._-]{2,100}$/i.test(model)) {
    throw new Error('模型名只能包含字母、数字、点、下划线和短横线。');
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
    enabledOverrides: presetName === '__none__' ? {} : presetOverrides(presetName),
  });

  const composed = composeRequest({
    presetText: presetInfo.text,
    customPrompt: getSettings().customPrompt + '\n' + ($('stvp-once')?.value || ''),
    targetText: target.text,
    maxInputChars: MAX_INPUT_CHARS,
  });
  if (composed.error) {
    throw new Error(composed.error);
  }

  return {
    target,
    presetName,
    model,
    presetInfo,
    composed,
    sampling: { ...readSampling(preset, target.text.length), maxOutputTokens: Math.max(256, Math.min(32768, Number($('stvp-output-budget')?.value) || 8192)) },
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
  const diagnostics = data?.diagnostics || {};
  state.lastDiagnostic = { httpStatus: response.status, error: data?.error, requestId: data?.requestId, model: diagnostics.model, location: diagnostics.location, upstreamHttpStatus: diagnostics.upstreamHttpStatus, googleStatus: diagnostics.googleStatus };
  const facts = [diagnostics.upstreamHttpStatus ? `Google HTTP ${diagnostics.upstreamHttpStatus}` : `HTTP ${response.status}`, diagnostics.googleStatus, diagnostics.model ? `模型 ${diagnostics.model}` : '', diagnostics.location ? `区域 ${diagnostics.location}` : '', diagnostics.action || ''].filter(Boolean);
  return `${base}${detail}${requestId}\n${facts.join(' · ')}`;
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
  setBusy(false);
  if (state.pending) ui.apply.disabled = true;
  updateUndoButton();
  setStatus(message, 'warn');
}

function switchPage(page) {
  for (const name of ['connection', 'preset', 'prompt', 'text']) {
    $('stvp-page-' + name).classList.toggle('stvp-hidden', name !== page);
    $('stvp-tab-' + name).classList.toggle('stvp-active', name === page);
    $('stvp-tab-' + name).setAttribute?.('aria-selected', String(name === page));
  }
}

function renderDraft() {
  const draft = state.drafts[state.draftIndex];
  if (!draft) return;
  state.pending = { ...draft, snapshot: state.originSnapshot };
  ui.original.textContent = state.originSnapshot.text;
  ui.polished.textContent = draft.text;
  ui.result.classList.remove('stvp-hidden');
  ui.apply.disabled = !pendingStillValid(state.originSnapshot) || draft.truncated;
  const versions = $('stvp-versions');
  versions.innerHTML = '';
  state.drafts.forEach((item, index) => versions.add(new Option(`版本 ${index + 1}${item.truncated ? ' · 截断' : ''}`, String(index))));
  versions.value = String(state.draftIndex);
  renderDiff();
}

function renderDiff() {
  if (!state.pending) return;
  const previous = $('stvp-compare').value === 'previous' && state.draftIndex > 0;
  const base = previous ? state.drafts[state.draftIndex - 1].text : state.originSnapshot.text;
  const container = $('stvp-diff');
  container.replaceChildren?.();
  for (const op of diffText(base, state.pending.text)) {
    const span = document.createElement(op.type === 'remove' ? 'del' : op.type === 'add' ? 'ins' : 'span');
    span.className = 'stvp-diff-' + op.type;
    span.textContent = op.text;
    container.append(span);
  }
}

function loadSource() {
  const target = pickTargetMessage(getContextOrThrow().chat);
  $('stvp-source').textContent = target?.text || '没有可润色回复';
  $('stvp-source-count').textContent = target ? `${target.text.length.toLocaleString()} 字符` : '';
  refreshTargetLabel();
}

async function runPolish(refine = false) {
  if (state.busy) {
    return;
  }
  clearError();

  const settings = getSettings();
  const rawUrl = ui.url.value.trim() || settings.backendUrl;
  const baseUrl = normalizeBaseUrl(rawUrl);
  const token = cleanToken(ui.token.value) || readToken();
  settings.backendUrl = rawUrl;
  settings.customPrompt = ui.custom.value;
  persistSettings();
  ui.meta.textContent = '';
  if (!baseUrl) {
    showError('请先在“连接设置”里填写后端地址。');
    switchPage('connection');
    ui.settings.open = true;
    return;
  }
  const tokenError = tokenShapeError(token);
  if (tokenError) {
    showError(tokenError);
    ui.settings.open = true;
    return;
  }

  const previousDraft = refine ? state.pending : null;
  if (refine && (!previousDraft || !$('stvp-followup').value.trim())) {
    showError('请先生成草稿，并填写继续修改要求。');
    return;
  }
  state.busy = true;
  setBusy(true);
  setStatus('准备请求…');

  let built;
  try {
    built = await buildRequest(refine ? { index: state.originSnapshot.index, text: state.originSnapshot.text, swipeId: state.originSnapshot.swipeId, name: state.originSnapshot.name, message: { send_date: state.originSnapshot.sendDate } } : null);
    if (refine) {
      built.composed = composeRequest({
        presetText: built.presetInfo.text,
        customPrompt: getSettings().customPrompt + '\n' + $('stvp-once').value + '\n继续修改要求：' + $('stvp-followup').value,
        targetText: previousDraft.text,
        maxInputChars: MAX_INPUT_CHARS,
      });
      if (built.composed.error) throw new Error(built.composed.error);
      built.composed.prompt += '\n\n【最初原文，仅用于核对事实，不需重复输出】\n' + state.originSnapshot.text;
      built.composed.chars = built.composed.prompt.length + built.composed.systemInstruction.length;
      if (built.composed.error || built.composed.chars > MAX_INPUT_CHARS) throw new Error(built.composed.error || '继续修改请求超过 100,000 字符，请缩短要求或正文。');
    }
    state.lastPayload = { model: built.model, systemInstruction: built.composed.systemInstruction, prompt: built.composed.prompt, ...built.sampling };
    $('stvp-payload').textContent = JSON.stringify(state.lastPayload, null, 2);
  } catch (error) {
    state.busy = false;
    setBusy(false);
    setStatus('');
    showError(error?.message || String(error));
    return;
  }

  const context = getContextOrThrow();
  const snapshot = refine ? state.originSnapshot : {
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
    const response = await privateFetch(baseUrl, '/api/polish', token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...(built.model ? { model: built.model } : {}),
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
    if (!refine) { state.originSnapshot = snapshot; state.drafts = []; }
    const draft = { text: polished, model: typeof data?.model === 'string' ? data.model : '', truncated: Boolean(data?.truncated) };
    state.drafts.push(draft);
    if (state.drafts.length > 10) state.drafts.shift();
    state.draftIndex = state.drafts.length - 1;
    renderDraft();
    switchPage('text');
    ui.undo.disabled = !state.undo;
    if (!pendingStillValid(snapshot)) setStatus('结果已保留为草稿，原消息变化，不能替换', 'warn');

    if (!pendingStillValid(snapshot)) {
      setStatus('草稿已保留；目标消息已变化，禁止替换', 'warn');
    } else if (state.pending.truncated) {
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
  ui.apply.disabled = true;
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
  state.undo = null;
  setBusy(false);
  if (state.pending) ui.apply.disabled = true;
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
  try {
    if (!ui?.panel) throw new Error('窗口尚未初始化，请重新加载酒馆。');
    ui.panel.classList.remove('stvp-hidden', 'stvp-minimized');
    // Native dialog enters the browser top layer, above host drawers and menus.
    if (typeof ui.panel.showModal === 'function' && !ui.panel.open) {
      ui.panel.showModal();
    } else if (typeof ui.panel.showModal !== 'function') {
      ui.panel.setAttribute('open', '');
    }
    refreshTargetLabel();
    if (ui.preset.options.length === 0) {
      refreshPresets().catch(error => showError(error.message));
    }
  } catch (error) {
    globalThis.alert?.(`Vertex 润色 0.3.1：无法打开窗口\n${error.message}`);
  }
}

function closePanel() {
  if (state.busy) {
    invalidatePending('已取消');
  }
  ui.panel.close?.();
  ui.panel.removeAttribute?.('open');
  ui.panel.classList.add('stvp-hidden');
}

function mountUi() {
  if (document.getElementById('stvp-root')) {
    return;
  }
  const root = document.createElement('div');
  root.id = 'stvp-root';
  root.innerHTML = `
    <dialog id="stvp-panel" class="stvp-hidden" aria-label="Vertex 润色">
      <header class="stvp-header">
        <div class="stvp-heading">
          <span class="stvp-title">Vertex 润色</span>
          <span id="stvp-target" class="stvp-target">正在读取聊天…</span>
        </div>
        <div class="stvp-head-actions">
          <button id="stvp-theme" type="button" title="切换日间/夜间" aria-label="切换日间/夜间">☾</button>
          <button id="stvp-min" type="button" title="收起" aria-label="收起">—</button>
          <button id="stvp-close" type="button" title="关闭" aria-label="关闭">×</button>
        </div>
      </header>
      <nav class="stvp-tabs" aria-label="工作台页面">
        <button id="stvp-tab-connection" type="button">连接设置</button><button id="stvp-tab-preset" type="button">预设设置</button><button id="stvp-tab-prompt" type="button">提示词设置</button><button id="stvp-tab-text" type="button">正文设置</button>
      </nav>
      <div id="stvp-body" class="stvp-body">
        <section id="stvp-page-connection" class="stvp-page">
        <p class="stvp-eyebrow">CONNECTION · 私人 Vertex 通道</p>
        <details id="stvp-settings" class="stvp-settings">
          <summary>连接设置</summary>
          <label class="stvp-field">
            <span>后端地址</span>
            <input id="stvp-url" type="url" inputmode="url" placeholder="https://your-service.run.app" autocomplete="off" spellcheck="false">
          </label>
          <label class="stvp-field">
            <span>访问口令</span>
            <input id="stvp-token" type="password" placeholder="粘贴后端口令（不是 Google JSON）" autocomplete="off" spellcheck="false" autocapitalize="off">
            <span class="stvp-hint">输入后点击“保存连接配置”；口令保持遮蔽，不会因失焦消失。默认仅本页暂存，刷新后重填。</span>
          </label>
          <label class="stvp-check">
            <input id="stvp-remember" type="checkbox">
            <span>在本设备记住口令</span>
          </label>
          <p class="stvp-hint">记住口令会明文写入本设备存储，不推荐在共享设备开启。Google JSON 只放后端，切勿粘贴到这里。</p>
          <div class="stvp-actions"><button id="stvp-save-connection" type="button">保存连接配置</button><button id="stvp-check" type="button">验证连接 / 拉取列表</button><button id="stvp-lock" type="button">清除口令</button></div>
          <p id="stvp-connection-status" class="stvp-hint" role="status">尚未验证连接</p>
        </details>

        <div class="stvp-row">
          <label class="stvp-field stvp-grow">
            <span>模型</span>
            <select id="stvp-model"></select>
          </label>
          <button id="stvp-model-refresh" type="button" class="stvp-secondary">拉取</button>
        </div>

        <div class="stvp-actions"><button id="stvp-model-remove" type="button" disabled>移除自定义收藏</button></div>
        <div id="stvp-model-custom-wrap" class="stvp-field stvp-hidden">
          <label for="stvp-model-custom">自定义模型名</label>
          <input id="stvp-model-custom" type="text" placeholder="例如 gemini-3.8-flash" autocomplete="off" spellcheck="false">
          <button id="stvp-model-add" type="button">添加并选中</button>
        </div>

        <label class="stvp-field"><span>输出预算（含模型思考）</span><input id="stvp-output-budget" type="number" min="256" max="32768" value="8192"></label>
        <p class="stvp-hint">验证连接不生成文字；润色与继续修改会计费。输出预算仍受后端和模型能力限制。</p>
        </section>
        <section id="stvp-page-preset" class="stvp-page stvp-hidden">
        <p class="stvp-eyebrow">PRESET · 独立请求规则</p>
        <div class="stvp-row">
          <label class="stvp-field stvp-grow">
            <span>酒馆预设</span>
            <select id="stvp-preset"></select>
          </label>
          <button id="stvp-refresh" type="button" class="stvp-secondary">刷新</button>
        </div>

        <details id="stvp-entry-editor" class="stvp-entry-editor stvp-hidden">
          <summary><span>预设条目开关</span><span id="stvp-entry-count" class="stvp-entry-count"></span></summary>
          <div class="stvp-entry-toolbar">
            <span class="stvp-hint">只影响本扩展的润色请求，不会修改酒馆预设。</span>
            <button id="stvp-entry-all" type="button">全开</button><button id="stvp-entry-none" type="button">全关</button>
            <button id="stvp-entry-reset" type="button">恢复默认</button>
          </div>
          <div id="stvp-entry-list" class="stvp-entry-list"></div>
        </details>

        </section>
        <section id="stvp-page-prompt" class="stvp-page stvp-hidden">
        <p class="stvp-eyebrow">PROMPTS · 保留事实，调整表达</p>
        <label class="stvp-field">
          <span>自定义润色要求</span>
          <textarea id="stvp-custom" rows="3" maxlength="4000" placeholder="例如：更口语化；保留第二人称；不要减少细节。"></textarea>
        </label>

        <label class="stvp-field"><span>本次补充要求（不持久保存）</span><textarea id="stvp-once" rows="3" placeholder="例如：这次不要缩短对白"></textarea></label>
        <button id="stvp-inspect" type="button">组装并查看发送内容（不调用 AI）</button>
        <details><summary>本次发送内容（不含凭据）</summary><pre id="stvp-payload" class="stvp-text"></pre></details>
        </section>
        <section id="stvp-page-text" class="stvp-page stvp-hidden">
        <p class="stvp-eyebrow">MANUSCRIPT · 每次修改都可回看</p>
        <div class="stvp-actions"><button id="stvp-load-source" type="button">读取最新回复</button><span id="stvp-source-count" class="stvp-hint"></span></div>
        <details><summary>当前酒馆原文</summary><pre id="stvp-source" class="stvp-text"></pre></details>
        <div class="stvp-actions">
          <button id="stvp-run" type="button" class="stvp-primary">开始润色</button>
          <button id="stvp-cancel" type="button">取消请求</button>
        </div>



        <div id="stvp-result" class="stvp-result stvp-hidden">
          <div class="stvp-row"><label class="stvp-field stvp-grow"><span>草稿版本（最近 10 版）</span><select id="stvp-versions"></select></label><button id="stvp-copy-result" type="button">复制结果</button></div>
          <label class="stvp-field"><span>比较基准</span><select id="stvp-compare"><option value="original">最初原文</option><option value="previous">上一版</option></select></label>
          <div class="stvp-diff-legend"><span>黄色：新增</span><span>红色＋删除线：删除</span></div><div id="stvp-diff" class="stvp-text stvp-diff"></div>
          <div class="stvp-label">原文</div>
          <div id="stvp-original" class="stvp-text"></div>
          <div class="stvp-label">润色结果</div>
          <div id="stvp-polished" class="stvp-text" contenteditable="true" role="textbox" aria-label="可编辑润色结果"></div>
          <div class="stvp-actions">
            <button id="stvp-apply" type="button" class="stvp-primary" disabled>替换当前回复</button>
            <button id="stvp-undo" type="button" class="stvp-secondary" disabled>撤销上次替换</button>
          </div>
        </div>
        <label class="stvp-field"><span>继续修改要求</span><textarea id="stvp-followup" rows="2" placeholder="保留这一版，把第二段改得更自然…"></textarea></label>
        <button id="stvp-refine" type="button">继续修改（产生新版本）</button>
        </section>
      </div>
      <footer class="stvp-footer"><span id="stvp-status" class="stvp-status" role="status">就绪</span><div id="stvp-meta" class="stvp-hint"></div><div id="stvp-error" class="stvp-error stvp-hidden" role="alert"></div><button id="stvp-copy-diagnostic" type="button">复制脱敏诊断</button></footer>
    </dialog>
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
    model: $('stvp-model'),
    modelRefresh: $('stvp-model-refresh'),
    modelCustom: $('stvp-model-custom'),
    modelCustomWrap: $('stvp-model-custom-wrap'),
    entryEditor: $('stvp-entry-editor'),
    entryList: $('stvp-entry-list'),
    entryCount: $('stvp-entry-count'),
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

  for (const name of ['connection', 'preset', 'prompt', 'text']) $('stvp-tab-' + name).addEventListener('click', () => switchPage(name));
  $('stvp-load-source').addEventListener('click', loadSource);
  $('stvp-refine').addEventListener('click', () => runPolish(true).catch(error => showError(error.message)));
  $('stvp-cancel').addEventListener('click', () => { state.controller?.abort(); setStatus('正在取消…', 'warn'); });
  $('stvp-versions').addEventListener('change', () => { state.draftIndex = Number($('stvp-versions').value); renderDraft(); });
  $('stvp-compare').addEventListener('change', renderDiff);
  ui.polished.addEventListener('input', () => {
    if (!state.pending) return;
    state.pending.text = ui.polished.textContent;
    state.drafts[state.draftIndex].text = state.pending.text;
    renderDiff();
  });
  $('stvp-copy-diagnostic').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(state.lastDiagnostic || { status: '没有服务器诊断记录' }, null, 2)); setStatus('已复制状态码、模型、区域与请求标识，不含正文和口令', 'ok'); }
    catch { showError('剪贴板不可用，请复制界面错误提示；不要分享口令。'); }
  });
  $('stvp-copy-result').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.pending?.text || ''); setStatus('结果已复制', 'ok'); }
    catch { showError('剪贴板不可用，请长按结果文字复制。'); }
  });
  $('stvp-inspect').addEventListener('click', async () => {
    try { const built = await buildRequest(); $('stvp-payload').textContent = JSON.stringify({ model: built.model, ...built.composed, ...built.sampling }, null, 2); setStatus('已组装，不调用 AI', 'ok'); }
    catch (error) { showError(error.message); }
  });
  $('stvp-theme').addEventListener('click', toggleTheme);
  $('stvp-min').addEventListener('click', () => {
    ui.panel.classList.toggle('stvp-minimized');
  });
  $('stvp-close').addEventListener('click', closePanel);
  ui.panel.addEventListener('cancel', event => {
    event.preventDefault();
    closePanel();
  });
  ui.refresh.addEventListener('click', () => {
    refreshPresets();
  });
  ui.run.addEventListener('click', () => {
    runPolish().catch(error => showError(error.message));
  });
  ui.apply.addEventListener('click', () => {
    applyPolish().catch(error => showError(`替换失败：${error.message}`));
  });
  ui.undo.addEventListener('click', () => {
    undoPolish().catch(error => showError(`撤销失败：${error.message}`));
  });

  ui.url.addEventListener('change', () => {
    getSettings().backendUrl = ui.url.value.trim();
    persistSettings();
  });
  ui.token.addEventListener('input', () => {
    setConnectionStatus('口令已输入，点击“保存连接”或“验证连接”。');
  });
  $('stvp-save-connection').addEventListener('click', saveConnectionCredentials);
  $('stvp-lock').addEventListener('click', () => {
    invalidatePending('已锁定连接');
    getSettings().rememberToken = false;
    ui.remember.checked = false;
    writeToken('');
    persistSettings();
    $('stvp-connection-status').textContent = '口令已清除，请重新填写';
  });
  $('stvp-check').addEventListener('click', () => {
    refreshModels().catch(error => showError(error.message));
  });
  ui.remember.addEventListener('change', () => {
    getSettings().rememberToken = ui.remember.checked;
    writeToken(readToken());
    persistSettings();
  });
  ui.custom.addEventListener('input', () => {
    getSettings().customPrompt = ui.custom.value;
    persistSettings();
  });
  ui.preset.addEventListener('change', () => {
    getSettings().presetName = ui.preset.value;
    persistSettings();
    renderPresetEntries();
  });
  $('stvp-entry-reset').addEventListener('click', () => {
    const name = ui.preset.value;
    if (name === '__none__') return;
    delete getSettings().presetEntryOverrides?.[name];
    persistSettings();
    renderPresetEntries();
  });
  ui.modelRefresh.addEventListener('click', () => {
    refreshModels().catch(error => showError(error.message));
  });
  ui.model.addEventListener('change', () => {
    getSettings().model = ui.model.value;
    toggleCustomModel();
    persistSettings();
  });
  $('stvp-model-add').addEventListener('click', addCustomModel);
  $('stvp-model-remove').addEventListener('click', removeCustomModel);
  ui.modelCustom.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addCustomModel(); }
  });
  for (const [id, enabled] of [['stvp-entry-all', true], ['stvp-entry-none', false]]) {
    $(id).addEventListener('click', () => {
      const name = ui.preset.value;
      const preset = state.presetCatalog?.get(name);
      if (!preset) return;
      const context = getContextOrThrow();
      const { entries } = getPresetEntries(preset, { characterId: context.characterId, isGroup: Boolean(context.groupId) });
      const overrides = presetOverrides(name);
      for (const entry of entries) if (!entry.marker && !entry.empty) overrides[entry.identifier] = enabled;
      persistSettings();
      renderPresetEntries();
      setStatus(enabled ? '已启用所有文本条目' : '已停用所有文本条目', 'ok');
    });
  }
  ui.modelCustom.addEventListener('input', () => {
    getSettings().model = '__custom__';
    getSettings().customModel = ui.modelCustom.value;
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

function mountMenuEntry() {
  // Add an item to the menu opened by #extensionsMenuButton; do not replace
  // the host button or intercept its existing handlers.
  const menu = document.getElementById('extensionsMenu');
  if (menu && !document.getElementById('stvp-menu-entry')) {
    const entry = document.createElement('div');
    entry.id = 'stvp-menu-entry';
    entry.className = 'list-group-item flex-container flexGap5';
    entry.setAttribute?.('role', 'button');
    entry.setAttribute?.('tabindex', '0');
    entry.innerHTML = '<span class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span><span>Vertex 润色</span>';
    entry.addEventListener('click', openPanel);
    entry.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(); }
    });
    menu.append(entry);
  }
}

async function init() {
  if (initialized) return;
  mountUi();
  initialized = true;
  mountMenuEntry();
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(mountMenuEntry);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const settings = getSettings();
  ui.url.value = settings.backendUrl;
  readToken();
  ui.token.value = '';
  ui.remember.checked = Boolean(settings.rememberToken);
  ui.custom.value = settings.customPrompt;
  applyTheme();
  switchPage('text');
  loadSource();
  globalThis.addEventListener?.('beforeunload', event => {
    if (state.drafts.length) { event.preventDefault(); event.returnValue = ''; }
  });

  await refreshPresets();
  await refreshModels({ silent: true });
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
  if (context && document.body && context.extensionSettings) {
    // Some clients do not replay APP_READY for late-loaded extensions.
    // Mount immediately and also accept the lifecycle notification, idempotently.
    const start = () => init().catch(error => {
      initialized = Boolean(ui);
      if (ui) showError(`初始化失败：${error.message}`);
    });
    start();
    if (context.eventSource?.on && context.eventTypes?.APP_READY) context.eventSource.on(context.eventTypes.APP_READY, start);
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

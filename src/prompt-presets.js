export function normalizePromptPresets(settings) {
  if (!Array.isArray(settings.promptPresets)) settings.promptPresets = [];
  settings.promptPresets = settings.promptPresets.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.text === 'string');
  if (!settings.promptPresets.length && settings.customPrompt?.trim()) {
    settings.promptPresets.push({ id: 'migrated', name: '原有润色要求', text: settings.customPrompt });
    settings.activePromptId = 'migrated';
  }
  return settings.promptPresets;
}
export function savePromptPreset(settings, id, name, text) {
  const list = normalizePromptPresets(settings);
  const clean = String(name || '').trim();
  if (!clean) throw new Error('请给提示词预设起个名字。');
  if (list.some(p => p.name === clean && p.id !== id)) throw new Error('已有同名预设，请换个名字。');
  const record = { id: id || 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), name: clean.slice(0,80), text: String(text || '') };
  const index = list.findIndex(p => p.id === record.id);
  if (index < 0) list.push(record); else list[index] = record;
  settings.activePromptId = record.id;
  settings.customPrompt = record.text;
  return record;
}

// Read-only adapter for SillyTavern 1.19 PresetManager. Never select/apply a preset.
export function readPresetCatalog(context) {
  const manager = context.getPresetManager?.('openai');
  if (!manager?.getPresetList) throw new Error('酒馆聊天补全预设管理器尚未就绪，请打开一次聊天补全设置后重试。');
  const { presets, preset_names } = manager.getPresetList();
  const entries = Array.isArray(preset_names)
    ? preset_names.map((name, index) => [name, index])
    : Object.entries(preset_names || {});
  const catalog = new Map();
  for (const [name, index] of entries) {
    let value = presets?.[index];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { throw new Error(`预设「${name}」不是有效 JSON。`); }
    }
    if (value && typeof value === 'object') catalog.set(name, structuredClone(value));
  }
  return { catalog, active: manager.getSelectedPresetName?.() || '' };
}

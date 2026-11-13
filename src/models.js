export const DEFAULT_MODELS = Object.freeze(['gemini-3.8-flash', 'gemini-3.7-flash']);
export function validModelId(value) {
  return typeof value === 'string' && /^[a-z0-9._-]{2,100}$/i.test(value);
}
export function isLegacyGemini(value) {
  const match = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(value || '');
  return Boolean(match) && (Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2] || 0) < 7));
}
export function buildModelList(remote = [], custom = []) {
  return [...new Set([...DEFAULT_MODELS, ...remote, ...custom].filter(validModelId))].filter(id => !isLegacyGemini(id));
}

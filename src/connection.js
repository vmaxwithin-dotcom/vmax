// Validate before attaching the private bearer token. Never follow redirects.
export function validateBackendUrl(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('后端地址不能包含用户名、密码、查询参数或 #。');
  }
  if (url.protocol !== 'https:') throw new Error('为保护访问口令，后端地址必须使用 HTTPS。');
  return url.href.replace(/\/+$/, '').replace(/\/api\/polish$/i, '');
}

import { VertexError } from './vertex.js';
export function validateOpenAIBase(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || host === 'localhost' || host.endsWith('.localhost') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new Error('OPENAI_BASE_URL must be a public HTTPS hostname without credentials or parameters');
  return url.href.replace(/\/+$/, '');
}
export function createOpenAIClient({ config, fetchImpl = globalThis.fetch }) {
  const base = config.openaiBaseUrl ? validateOpenAIBase(config.openaiBaseUrl) : '';
  return async ({ model, systemInstruction, prompt, generationConfig }) => {
    if (!base || !config.openaiApiKey) throw new VertexError('auth', 'OpenAI is not configured');
    let response, data;
    try {
      response = await fetchImpl(base + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.requestTimeoutMs),
        headers: { Authorization: 'Bearer ' + config.openaiApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [...(systemInstruction ? [{ role:'system', content:systemInstruction }] : []), { role:'user', content:prompt }], stream:false, temperature:generationConfig.temperature, top_p:generationConfig.topP, max_tokens:generationConfig.maxOutputTokens }),
      });
      data = await response.json();
    } catch (error) { throw new VertexError(error.name === 'TimeoutError' ? 'timeout' : 'upstream', 'OpenAI request failed'); }
    if (!response.ok) throw new VertexError('upstream', 'OpenAI rejected request', { status:response.status });
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new VertexError('blocked', 'content_filter');
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new VertexError('empty', 'No text');
    return { text:text.trim(), finishReason:choice.finish_reason, truncated:choice.finish_reason==='length', usage:data.usage ? { totalTokenCount:data.usage.total_tokens } : null };
  };
}

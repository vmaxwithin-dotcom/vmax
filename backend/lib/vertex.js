export class VertexError extends Error {
  constructor(kind, message, meta = {}) {
    super(message);
    this.name = 'VertexError';
    this.kind = kind;
    Object.assign(this, meta);
  }
}

export function buildVertexUrl({ project, location, model, apiVersion = 'v1' }) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/${apiVersion}/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

const BLOCKING_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

/**
 * Convert a Vertex generateContent response into a small, explicit result.
 * Never throws; the caller decides which HTTP status to use.
 */
export function normalizeVertexResponse(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, kind: 'empty', reason: 'invalid_response' };
  }

  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) {
    return { ok: false, kind: 'blocked', reason: String(blockReason) };
  }

  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  if (!candidate) {
    return { ok: false, kind: 'empty', reason: 'no_candidates' };
  }

  const finishReason = candidate.finishReason ? String(candidate.finishReason) : '';
  if (BLOCKING_FINISH_REASONS.has(finishReason)) {
    return { ok: false, kind: 'blocked', reason: finishReason };
  }

  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .filter(part => part && part.thought !== true)
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  if (!text) {
    return {
      ok: false,
      kind: finishReason === 'MAX_TOKENS' ? 'truncated_empty' : 'empty',
      reason: finishReason || 'empty_content',
    };
  }

  return {
    ok: true,
    text,
    finishReason,
    truncated: finishReason === 'MAX_TOKENS',
    usage: data.usageMetadata ?? null,
  };
}

export function createVertexClient({ config, getAccessToken, fetchImpl = globalThis.fetch }) {
  if (typeof getAccessToken !== 'function') {
    throw new Error('createVertexClient requires getAccessToken');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createVertexClient requires fetch');
  }
  const url = buildVertexUrl(config);

  return async function generate({ systemInstruction, prompt, generationConfig }) {
    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (error) {
      throw new VertexError('auth', 'failed to obtain Google access token', { cause: error });
    }

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };
    if (systemInstruction) {
      payload.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? 60000);
    let response;
    let raw = '';
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VertexError('timeout', 'Vertex request timed out', { cause: error });
      }
      throw new VertexError('upstream', 'Vertex request failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new VertexError('upstream', `Vertex HTTP ${response.status}`, {
        status: response.status,
        detail: typeof data?.error?.message === 'string' ? data.error.message.slice(0, 500) : '',
      });
    }

    const normalized = normalizeVertexResponse(data);
    if (!normalized.ok) {
      const kind = normalized.kind === 'blocked'
        ? 'blocked'
        : normalized.kind === 'truncated_empty'
          ? 'truncated'
          : 'empty';
      throw new VertexError(kind, normalized.reason, { finishReason: normalized.reason });
    }
    return normalized;
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVertexUrl,
  createVertexClient,
  normalizeVertexResponse,
  VertexError,
} from '../lib/vertex.js';

test('buildVertexUrl handles regional and global endpoints', () => {
  assert.equal(
    buildVertexUrl({ project: 'demo', location: 'us-central1', model: 'gemini-2.5-flash' }),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    buildVertexUrl({ project: 'demo', location: 'global', model: 'gemini-3.5-flash' }),
    'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-3.5-flash:generateContent',
  );
  assert.equal(
    buildVertexUrl({ project: 'demo', location: 'us-central1', model: 'gemini-3.5-flash', apiVersion: 'v1beta1' }),
    'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/publishers/google/models/gemini-3.5-flash:generateContent',
  );
});

test('normalizeVertexResponse maps prompt and candidate safety blocks', () => {
  assert.deepEqual(
    normalizeVertexResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    { ok: false, kind: 'blocked', reason: 'SAFETY' },
  );
  assert.equal(
    normalizeVertexResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }).kind,
    'blocked',
  );
});

test('normalizeVertexResponse returns text, truncation and usage', () => {
  const result = normalizeVertexResponse({
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ text: 'thinking...', thought: true }, { text: 'hello ' }, { text: 'world' }] },
    }],
    usageMetadata: { totalTokenCount: 12 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello world');
  assert.equal(result.truncated, false);
  assert.equal(result.usage.totalTokenCount, 12);

  const truncated = normalizeVertexResponse({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }],
  });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.truncated, true);

  const empty = normalizeVertexResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] });
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, 'truncated_empty');
});

test('normalizeVertexResponse handles missing candidates and invalid data', () => {
  assert.equal(normalizeVertexResponse({}).kind, 'empty');
  assert.equal(normalizeVertexResponse(null).kind, 'empty');
});

test('createVertexClient sends the official generateContent shape', async () => {
  let captured = null;
  const client = createVertexClient({
    config: { project: 'demo', location: 'us-central1', model: 'gemini-2.5-flash', requestTimeoutMs: 1000 },
    getAccessToken: async () => 'token-123',
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const result = await client({
    systemInstruction: 'system text',
    prompt: 'user text',
    generationConfig: { temperature: 0.5, topP: 0.9, maxOutputTokens: 300 },
  });

  assert.equal(result.text, 'ok');
  assert.equal(captured.url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent');
  assert.equal(captured.init.headers.Authorization, 'Bearer token-123');
  assert.deepEqual(captured.body.systemInstruction, { parts: [{ text: 'system text' }] });
  assert.deepEqual(captured.body.contents, [{ role: 'user', parts: [{ text: 'user text' }] }]);
  assert.deepEqual(captured.body.generationConfig, { temperature: 0.5, topP: 0.9, maxOutputTokens: 300 });
});

test('createVertexClient maps upstream HTTP errors', async () => {
  const client = createVertexClient({
    config: { project: 'demo', location: 'us-central1', model: 'gemini-2.5-flash', requestTimeoutMs: 1000 },
    getAccessToken: async () => 'token',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }),
  });

  await assert.rejects(
    () => client({ prompt: 'x', generationConfig: {} }),
    error => error instanceof VertexError && error.kind === 'upstream' && error.status === 429,
  );
});

test('createVertexClient maps timeouts', async () => {
  const client = createVertexClient({
    config: { project: 'demo', location: 'us-central1', model: 'gemini-2.5-flash', requestTimeoutMs: 20 },
    getAccessToken: async () => 'token',
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });

  await assert.rejects(
    () => client({ prompt: 'x', generationConfig: {} }),
    error => error instanceof VertexError && error.kind === 'timeout',
  );
});

test('createVertexClient maps token failures to auth errors', async () => {
  const client = createVertexClient({
    config: { project: 'demo', location: 'us-central1', model: 'gemini-2.5-flash', requestTimeoutMs: 1000 },
    getAccessToken: async () => {
      throw new Error('no token');
    },
    fetchImpl: async () => new Response('{}'),
  });

  await assert.rejects(
    () => client({ prompt: 'x', generationConfig: {} }),
    error => error instanceof VertexError && error.kind === 'auth',
  );
});

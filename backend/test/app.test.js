import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../lib/app.js';
import { VertexError } from '../lib/vertex.js';

const TOKEN = 'test-token-1234567890';
const FIXED_NOW = 1_700_000_000_000;
const silentLogger = { info() {}, error() {} };

function baseConfig(overrides = {}) {
  return {
    accessToken: TOKEN,
    project: 'demo-project',
    location: 'us-central1',
    model: 'gemini-2.5-flash',
    availableModels: ['gemini-2.5-flash', 'gemini-3.8-flash'],
    allowedOrigins: ['*'],
    maxInputChars: 20000,
    maxOutputTokens: 4096,
    dailyLimit: 100,
    minIntervalMs: 0,
    requestTimeoutMs: 1000,
    maxBodyBytes: 262144,
    ...overrides,
  };
}

function okVertex(captured = {}) {
  return async request => {
    Object.assign(captured, request);
    return {
      text: 'polished text',
      finishReason: 'STOP',
      truncated: false,
      usage: { totalTokenCount: 5 },
    };
  };
}

async function withServer({ config = baseConfig(), vertex = okVertex(), logger = silentLogger } = {}, fn) {
  const app = createApp({ config, vertex, now: () => FIXED_NOW, logger });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(base, body, { token = TOKEN, origin, rawBody, headers = {} } = {}) {
  const response = await fetch(`${base}/api/polish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { response, json };
}

test('health endpoint responds without authentication', async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });
});

test('model list is authenticated and returns configured models', async () => {
  await withServer({}, async base => {
    const unauthorized = await fetch(`${base}/api/models`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}/api/models`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.models, ['gemini-2.5-flash', 'gemini-3.8-flash']);
    assert.equal(body.defaultModel, 'gemini-2.5-flash');
    assert.equal(body.location, 'us-central1');
  });
});

test('authentication rejects missing and wrong bearer tokens', async () => {
  await withServer({}, async base => {
    const missing = await post(base, { prompt: 'x' }, { token: '' });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.json.error, 'unauthorized');

    const wrong = await post(base, { prompt: 'x' }, { token: 'wrong-token-000000' });
    assert.equal(wrong.response.status, 401);

    const malformed = await post(base, { prompt: 'x' }, { token: '' , headers: { Authorization: 'Basic abc' } });
    assert.equal(malformed.response.status, 401);
  });
});

test('CORS allowlist rejects unknown origins and accepts configured ones', async () => {
  const config = baseConfig({ allowedOrigins: ['https://ok.example'] });
  await withServer({ config }, async base => {
    const denied = await post(base, { prompt: 'x' }, { origin: 'https://bad.example' });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.json.error, 'origin_not_allowed');
    assert.equal(denied.response.headers.get('access-control-allow-origin'), null);

    const allowed = await post(base, { prompt: 'x' }, { origin: 'https://ok.example' });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'https://ok.example');

    const preflight = await fetch(`${base}/api/polish`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ok.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://ok.example');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  });
});

test('CORS allowlist accepts the null origin used by file:// WebViews', async () => {
  const config = baseConfig({ allowedOrigins: ['null'] });
  await withServer({ config }, async base => {
    const result = await post(base, { prompt: 'x' }, { origin: 'null' });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('access-control-allow-origin'), 'null');
  });
});

test('wildcard CORS returns a wildcard header', async () => {
  await withServer({}, async base => {
    const result = await post(base, { prompt: 'x' }, { origin: 'https://anything.example' });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('access-control-allow-origin'), '*');
  });
});

test('invalid JSON and missing prompt are rejected', async () => {
  await withServer({}, async base => {
    const badJson = await post(base, null, { rawBody: '{not json' });
    assert.equal(badJson.response.status, 400);
    assert.equal(badJson.json.error, 'invalid_request');

    const noPrompt = await post(base, { systemInstruction: 'x' });
    assert.equal(noPrompt.response.status, 400);
    assert.equal(noPrompt.json.error, 'invalid_request');

    const badSystem = await post(base, { prompt: 'x', systemInstruction: 42 });
    assert.equal(badSystem.response.status, 400);

    const badModel = await post(base, { prompt: 'x', model: 'bad model/name' });
    assert.equal(badModel.response.status, 400);
    assert.equal(badModel.json.error, 'invalid_request');
  });
});

test('input character limit returns 413 without calling Vertex', async () => {
  let called = false;
  const vertex = async () => {
    called = true;
    return { text: 'x' };
  };
  const config = baseConfig({ maxInputChars: 100 });
  await withServer({ config, vertex }, async base => {
    const result = await post(base, { prompt: 'x'.repeat(200) });
    assert.equal(result.response.status, 413);
    assert.equal(result.json.error, 'too_large');
    assert.equal(called, false);
  });
});

test('request body byte limit returns 413', async () => {
  const config = baseConfig({ maxBodyBytes: 1024, maxInputChars: 100000 });
  await withServer({ config }, async base => {
    const result = await post(base, { prompt: 'x'.repeat(4000) });
    assert.equal(result.response.status, 413);
    assert.equal(result.json.error, 'too_large');
  });
});

test('daily limit and minimum interval both return 429', async () => {
  const dailyConfig = baseConfig({ dailyLimit: 1, minIntervalMs: 0 });
  await withServer({ config: dailyConfig }, async base => {
    assert.equal((await post(base, { prompt: 'x' })).response.status, 200);
    const second = await post(base, { prompt: 'x' });
    assert.equal(second.response.status, 429);
    assert.equal(second.json.error, 'daily_limit');
  });

  const intervalConfig = baseConfig({ dailyLimit: 10, minIntervalMs: 60000 });
  await withServer({ config: intervalConfig }, async base => {
    assert.equal((await post(base, { prompt: 'x' })).response.status, 200);
    const second = await post(base, { prompt: 'x' });
    assert.equal(second.response.status, 429);
    assert.equal(second.json.error, 'rate_limited');
    assert.ok(Number(second.response.headers.get('retry-after')) > 0);
  });
});

test('concurrent requests cannot overshoot the daily quota', async () => {
  const config = baseConfig({ dailyLimit: 1, minIntervalMs: 0 });
  await withServer({ config }, async base => {
    const [first, second] = await Promise.all([
      post(base, { prompt: 'x' }),
      post(base, { prompt: 'y' }),
    ]);
    const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 429]);
  });
});

test('successful requests clamp generation parameters and return metadata', async () => {
  const captured = {};
  await withServer({ vertex: okVertex(captured) }, async base => {
    const result = await post(base, {
      model: 'gemini-3.8-flash',
      systemInstruction: 'sys',
      prompt: 'target',
      temperature: 5,
      topP: -2,
      maxOutputTokens: 999999,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.text, 'polished text');
    assert.equal(result.json.model, 'gemini-3.8-flash');
    assert.equal(result.json.truncated, false);
    assert.equal(result.json.usage.totalTokenCount, 5);
    assert.equal(typeof result.json.requestId, 'string');
    assert.deepEqual(captured.generationConfig, { temperature: 2, topP: 0, maxOutputTokens: 4096 });
    assert.equal(captured.model, 'gemini-3.8-flash');
    assert.equal(captured.systemInstruction, 'sys');
    assert.equal(captured.prompt, 'target');
  });
});

test('Vertex safety blocks become 422 without exposing internals', async () => {
  const vertex = async () => {
    throw new VertexError('blocked', 'SAFETY');
  };
  await withServer({ vertex }, async base => {
    const result = await post(base, { prompt: 'x' });
    assert.equal(result.response.status, 422);
    assert.equal(result.json.error, 'blocked');
    assert.equal(result.json.reason, undefined);
  });
});

test('truncated empty output, timeout and upstream errors map to distinct statuses', async () => {
  const cases = [
    { error: new VertexError('truncated', 'MAX_TOKENS'), status: 422, code: 'output_truncated' },
    { error: new VertexError('timeout', 'Vertex request timed out'), status: 504, code: 'timeout' },
    { error: new VertexError('upstream', 'Vertex HTTP 500', { status: 500 }), status: 502, code: 'upstream_error' },
    { error: new VertexError('auth', 'no token'), status: 500, code: 'backend_auth_failed' },
  ];

  for (const item of cases) {
    const vertex = async () => {
      throw item.error;
    };
    await withServer({ vertex }, async base => {
      const result = await post(base, { prompt: 'x' });
      assert.equal(result.response.status, item.status, item.code);
      assert.equal(result.json.error, item.code);
    });
  }
});

test('unexpected errors become a generic 500', async () => {
  const vertex = async () => {
    throw new Error('boom with private detail');
  };
  await withServer({ vertex }, async base => {
    const result = await post(base, { prompt: 'x' });
    assert.equal(result.response.status, 500);
    assert.equal(result.json.error, 'internal_error');
    assert.doesNotMatch(JSON.stringify(result.json), /private detail/);
  });
});

test('non-POST methods on the polish route are rejected', async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/api/polish`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 405);
  });
});

test('logs include request ids and never include the access token or prompt body', async () => {
  const lines = [];
  const logger = { info: line => lines.push(line) };
  await withServer({ logger }, async base => {
    const result = await post(base, { prompt: 'SECRET_CHAT_TEXT' });
    assert.equal(result.response.status, 200);
  });
  assert.ok(lines.length >= 1);
  const joined = lines.join('\n');
  assert.ok(joined.includes('requestId'));
  assert.doesNotMatch(joined, new RegExp(TOKEN));
  assert.doesNotMatch(joined, /SECRET_CHAT_TEXT/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.js';

const TOKEN = 'x'.repeat(32);

test('loadConfig applies defaults and parses origins', () => {
  const config = loadConfig({ POLISH_ACCESS_TOKEN: TOKEN });
  assert.equal(config.port, 8080);
  assert.equal(config.location, 'us-central1');
  assert.equal(config.model, 'gemini-3.5-flash');
  assert.deepEqual(config.allowedOrigins, ['*']);
  assert.equal(config.dailyLimit, 100);
  assert.equal(config.minIntervalMs, 3000);
  assert.equal(config.maxInputChars, 20000);
  assert.equal(config.maxOutputTokens, 8192);
  assert.equal(config.apiVersion, 'v1');

  const origins = loadConfig({
    POLISH_ACCESS_TOKEN: TOKEN,
    ALLOWED_ORIGINS: 'https://a.example, null ,https://b.example',
  });
  assert.deepEqual(origins.allowedOrigins, ['https://a.example', 'null', 'https://b.example']);
});

test('loadConfig requires a strong access token', () => {
  assert.throws(() => loadConfig({}), /POLISH_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ POLISH_ACCESS_TOKEN: 'short' }), /at least 16/);
});

test('loadConfig rejects invalid numeric values and identifiers', () => {
  assert.throws(
    () => loadConfig({ POLISH_ACCESS_TOKEN: TOKEN, DAILY_LIMIT: '0' }),
    /DAILY_LIMIT/,
  );
  assert.throws(
    () => loadConfig({ POLISH_ACCESS_TOKEN: TOKEN, MIN_INTERVAL_MS: 'abc' }),
    /MIN_INTERVAL_MS/,
  );
  assert.throws(
    () => loadConfig({ POLISH_ACCESS_TOKEN: TOKEN, VERTEX_MODEL: 'bad model/name' }),
    /VERTEX_MODEL/,
  );
  assert.throws(
    () => loadConfig({ POLISH_ACCESS_TOKEN: TOKEN, GOOGLE_CLOUD_LOCATION: 'us central' }),
    /GOOGLE_CLOUD_LOCATION/,
  );
});

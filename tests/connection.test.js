import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackendUrl } from '../src/connection.js';

test('backend URL uses HTTPS and rejects embedded secrets or parameters', () => {
  assert.equal(validateBackendUrl('demo.run.app/'), 'https://demo.run.app');
  assert.equal(validateBackendUrl('https://demo.run.app/api/polish'), 'https://demo.run.app');
  for (const url of ['http://demo.run.app', 'https://user:secret@demo.run.app', 'https://demo.run.app?token=secret', 'https://demo.run.app/#secret', 'javascript:alert(1)']) {
    assert.throws(() => validateBackendUrl(url));
  }
});

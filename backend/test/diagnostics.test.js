import test from 'node:test';
import assert from 'node:assert/strict';
import { safeGoogleStatus, upstreamDiagnostic } from '../lib/diagnostics.js';

test('diagnostics whitelist status values and use fixed safe guidance', () => {
  assert.equal(safeGoogleStatus('SECRET_BODY', 404), 'NOT_FOUND');
  assert.equal(safeGoogleStatus('PERMISSION_DENIED', 403), 'PERMISSION_DENIED');
  const result = upstreamDiagnostic(400, 'INVALID_ARGUMENT');
  assert.equal(result.upstreamHttpStatus, 400);
  assert.match(result.action, /32768/);
  assert.equal(upstreamDiagnostic('SECRET', 'SECRET').upstreamHttpStatus, null);
  assert.doesNotMatch(JSON.stringify(upstreamDiagnostic(500, 'SECRET_PROMPT')), /SECRET/);
});

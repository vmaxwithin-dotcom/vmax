import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelList, isLegacyGemini } from '../src/models.js';
test('models merge custom ids, deduplicate and hide Gemini before 3.7', () => {
  assert.deepEqual(buildModelList(['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash'], ['gemini-4-flash', 'gemini-4-flash']), ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-4-flash']);
  assert.equal(isLegacyGemini('gemini-3.6-flash'), true);
  assert.equal(isLegacyGemini('gemini-3.10-flash'), false);
});

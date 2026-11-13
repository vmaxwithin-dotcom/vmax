import test from 'node:test';
import assert from 'node:assert/strict';
import { readPresetCatalog } from '../src/presets.js';

test('real ST name-index map and JSON strings are read without selecting host preset', () => {
  const original = { prompts: [{ identifier: 'main', content: 'saved' }] };
  const context = { getPresetManager(api) {
    assert.equal(api, 'openai');
    return { getPresetList: () => ({ presets: [original, JSON.stringify(original)], preset_names: { First: 0, Second: 1 } }), getSelectedPresetName: () => 'Second' };
  } };
  const { catalog, active } = readPresetCatalog(context);
  assert.deepEqual([...catalog.keys()], ['First', 'Second']);
  assert.equal(active, 'Second');
  catalog.get('First').prompts[0].content = 'changed';
  assert.equal(original.prompts[0].content, 'saved');
});

test('name arrays and unavailable preset managers are handled explicitly', () => {
  const result = readPresetCatalog({ getPresetManager: () => ({ getPresetList: () => ({ presets: [{ prompts: [] }], preset_names: ['Default'] }) }) });
  assert.ok(result.catalog.has('Default'));
  assert.throws(() => readPresetCatalog({}), /尚未就绪/);
});

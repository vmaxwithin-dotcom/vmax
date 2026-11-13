import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPresetInstruction,
  composeRequest,
  getMessageText,
  getPresetEntries,
  pickTargetMessage,
  readSampling,
  resolvePromptOrder,
  snapshotMatches,
} from '../src/core.js';

const preset = {
  temperature: 0.8,
  top_p: 0.9,
  openai_max_tokens: 300,
  prompts: [
    { identifier: 'main', content: 'Write as {{char}}.', role: 'system', system_prompt: true },
    { identifier: 'nsfw', content: '', role: 'system' },
    { identifier: 'chatHistory', marker: true, name: 'Chat History' },
    { identifier: 'jailbreak', content: 'Stay in character.', role: 'system' },
    { identifier: 'charDescription', marker: true, name: 'Char Description' },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: 'charDescription', enabled: true },
        { identifier: 'main', enabled: true },
        { identifier: 'jailbreak', enabled: false },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'nsfw', enabled: true },
      ],
    },
    {
      character_id: 100001,
      order: [{ identifier: 'main', enabled: true }],
    },
    {
      character_id: 5,
      order: [{ identifier: 'main', enabled: false }],
    },
  ],
};

test('getMessageText prefers the current swipe', () => {
  assert.equal(getMessageText({ mes: 'base', swipes: ['one', 'two'], swipe_id: 1 }), 'two');
  assert.equal(getMessageText({ mes: 'base', swipes: ['one'], swipe_id: 9 }), 'one');
  assert.equal(getMessageText({ mes: 'base' }), 'base');
  assert.equal(getMessageText(null), '');
});

test('pickTargetMessage returns the newest AI message and skips system/user messages', () => {
  const chat = [
    { mes: 'greeting', is_user: false },
    { mes: 'hello', is_user: true },
    { mes: 'reply', is_user: false, name: 'Alice', swipes: ['a', 'b'], swipe_id: 1 },
    { mes: 'system note', is_system: true },
  ];
  const target = pickTargetMessage(chat);
  assert.equal(target.index, 2);
  assert.equal(target.text, 'b');
  assert.equal(target.swipeId, 1);
  assert.equal(target.swipeCount, 2);
  assert.equal(target.name, 'Alice');
});

test('pickTargetMessage returns null when there is no AI message', () => {
  assert.equal(pickTargetMessage([]), null);
  assert.equal(pickTargetMessage([{ mes: 'hi', is_user: true }]), null);
  assert.equal(pickTargetMessage(undefined), null);
});

test('resolvePromptOrder prefers group, then character, then default order', () => {
  assert.equal(resolvePromptOrder(preset, { isGroup: true }).character_id, 100001);
  assert.equal(resolvePromptOrder(preset, { characterId: 5 }).character_id, 5);
  assert.equal(resolvePromptOrder(preset, {}).character_id, 100000);
  assert.equal(resolvePromptOrder({ prompts: [] }, {}), null);
});

test('buildPresetInstruction follows prompt_order, enabled flags, markers and macros', () => {
  const result = buildPresetInstruction(preset, {
    characterId: 0,
    substitute: text => text.replace('{{char}}', 'Alice'),
  });
  assert.equal(result.orderFound, true);
  assert.equal(result.text, 'Write as Alice.');
  assert.equal(result.used, 1);
  assert.equal(result.skipped, 4);
});

test('buildPresetInstruction uses the character-specific order when present', () => {
  const result = buildPresetInstruction(preset, {
    characterId: 5,
    substitute: text => text,
  });
  assert.equal(result.text, '');
  assert.equal(result.used, 0);
});

test('preset entry editor exposes markers and empty entries without changing the source', () => {
  const result = getPresetEntries(preset, { characterId: 0 });
  assert.equal(result.orderFound, true);
  assert.deepEqual(result.entries.map(entry => entry.identifier), ['charDescription', 'main', 'jailbreak', 'chatHistory', 'nsfw']);
  assert.equal(result.entries[0].marker, true);
  assert.equal(result.entries[2].baseEnabled, false);
  assert.equal(result.entries[4].empty, true);
});

test('enabledOverrides can disable and re-enable text entries for one request', () => {
  const disabled = buildPresetInstruction(preset, { characterId: 0, enabledOverrides: { main: false } });
  assert.equal(disabled.text, '');
  const enabled = buildPresetInstruction(preset, { characterId: 0, enabledOverrides: { main: true, jailbreak: true } });
  assert.match(enabled.text, /Write as \{\{char\}\}/);
  assert.match(enabled.text, /Stay in character/);
});

test('buildPresetInstruction falls back to the prompts array when no order exists', () => {
  const result = buildPresetInstruction({
    prompts: [
      { identifier: 'main', content: 'one' },
      { identifier: 'extra', content: 'two', enabled: false },
      { identifier: 'third', content: 'three' },
    ],
  });
  assert.equal(result.orderFound, false);
  assert.equal(result.text, 'one\n\nthree');
  assert.equal(result.used, 2);
});

test('composeRequest includes preset, custom requirements and the delimited target', () => {
  const result = composeRequest({
    presetText: 'PRESET',
    customPrompt: 'CUSTOM',
    targetText: 'TARGET',
    maxInputChars: 5000,
  });
  assert.ok(result.systemInstruction.includes('PRESET'));
  assert.ok(result.systemInstruction.includes('CUSTOM'));
  assert.ok(result.systemInstruction.includes('以本段为准'));
  assert.ok(result.prompt.includes('<TEXT>\nTARGET\n</TEXT>'));
  assert.equal(result.chars, result.systemInstruction.length + result.prompt.length);
});

test('composeRequest rejects oversized input and empty targets', () => {
  const oversized = composeRequest({ presetText: 'x'.repeat(200), targetText: 'y', maxInputChars: 100 });
  assert.match(oversized.error, /超过上限/);

  const empty = composeRequest({ targetText: '   ' });
  assert.match(empty.error, /没有可润色的正文/);
});

test('readSampling clamps values and keeps enough output budget for long replies', () => {
  const clamped = readSampling({ temperature: 3, top_p: -1, openai_max_tokens: 99999 }, 0);
  assert.equal(clamped.temperature, 2);
  assert.equal(clamped.topP, 0);
  assert.equal(clamped.maxOutputTokens, 8192);

  const longReply = readSampling({ temperature: 0.7, top_p: 0.8, openai_max_tokens: 300 }, 6000);
  assert.equal(longReply.maxOutputTokens, 4256);

  const defaults = readSampling(null, 100);
  assert.equal(defaults.temperature, 1);
  assert.equal(defaults.topP, 1);
  assert.ok(defaults.maxOutputTokens >= 256);
});

test('snapshotMatches detects text, swipe, date and name changes', () => {
  const chat = [{ mes: 'y', is_user: false, swipes: ['x', 'y'], swipe_id: 1, send_date: '2026-01-01', name: 'Alice' }];
  const snapshot = { index: 0, swipeId: 1, text: 'y', sendDate: '2026-01-01', name: 'Alice' };
  assert.equal(snapshotMatches(chat, snapshot), true);

  const switched = [{ mes: 'x', is_user: false, swipes: ['x', 'y'], swipe_id: 0, send_date: '2026-01-01', name: 'Alice' }];
  assert.equal(snapshotMatches(switched, snapshot), false);

  const edited = [{ mes: 'y edited', is_user: false, swipes: ['x', 'y edited'], swipe_id: 1, send_date: '2026-01-01', name: 'Alice' }];
  assert.equal(snapshotMatches(edited, snapshot), false);

  const replaced = [{ mes: 'y', is_user: false, swipes: ['x', 'y'], swipe_id: 1, send_date: '2026-01-02', name: 'Alice' }];
  assert.equal(snapshotMatches(replaced, snapshot), false);

  const renamed = [{ mes: 'y', is_user: false, swipes: ['x', 'y'], swipe_id: 1, send_date: '2026-01-01', name: 'Bob' }];
  assert.equal(snapshotMatches(renamed, snapshot), false);
});

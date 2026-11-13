import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePromptPresets,savePromptPreset} from '../src/prompt-presets.js';
test('prompt presets migrate, save, rename and preserve independent contents',()=>{
 const settings={customPrompt:'old'}; const list=normalizePromptPresets(settings); assert.equal(list[0].text,'old');
 const a=savePromptPreset(settings,'','文学','A'), b=savePromptPreset(settings,'','简洁','B');
 assert.notEqual(a.id,b.id); assert.equal(settings.customPrompt,'B');
 savePromptPreset(settings,a.id,'叙事','new'); assert.equal(settings.promptPresets.find(p=>p.id===a.id).text,'new');
 assert.throws(()=>savePromptPreset(settings,'','简洁','C'),/同名/);
});

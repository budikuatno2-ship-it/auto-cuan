'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCacheKey } = require('../lib/ai-narration-cache');
const { buildNotePrompt } = require('../lib/ai-narration-prompts');

test('BUG-NAC-01: buildCacheKey crashes with TypeError when called with null or undefined', () => {
  let key;
  try {
    key = buildCacheKey(null);
  } catch (err) {
    assert.fail(`BUG-NAC-01 reproduced: crashed with ${err.message}`);
  }
  assert.ok(typeof key === 'string');
});

test('BUG-NAC-02: buildCacheKey drops all properties of nested objects due to JSON.stringify array replacer', () => {
  // When params.data contains nested objects, Object.keys(params.data).sort() acts as a whitelist
  // that filters out all keys inside nested objects during recursive serialization
  const data1 = { ticker: 'BBRI', nested: { val: 100 } };
  const data2 = { ticker: 'BBRI', nested: { val: 200 } };

  const key1 = buildCacheKey({ type: 'signal', ticker: 'BBRI', data: data1 });
  const key2 = buildCacheKey({ type: 'signal', ticker: 'BBRI', data: data2 });

  // If nested values are dropped, key1 and key2 collide even though data is different!
  assert.notStrictEqual(key1, key2, 'Cache keys must differ when nested properties differ');
});

test('BUG-NAP-01: buildNotePrompt crashes with TypeError when data argument is null or undefined', () => {
  let prompt;
  try {
    prompt = buildNotePrompt('new_signal', null);
  } catch (err) {
    assert.fail(`BUG-NAP-01 reproduced: crashed on null data with ${err.message}`);
  }
  assert.ok(typeof prompt === 'string');
});

test('BUG-NAP-02: buildNotePrompt fails to match uppercase notification types, degrading to generic prompt', () => {
  // Statuses like TP1_HIT, SL_HIT, ENTRY_HIT are often passed in uppercase
  const prompt = buildNotePrompt('TP1_HIT', { category: 'Swing' });

  // Case-sensitive switch fails to match 'tp1_hit', falling through to generic prompt
  assert.ok(
    prompt.includes('Target profit pertama') || prompt.includes('TP1'),
    'Should return TP1 specific prompt, not generic prompt'
  );
});

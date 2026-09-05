'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const narrationCache = require('../lib/ai-narration-cache');
const narrationValidator = require('../lib/ai-narration-validator');
const narrationPrompts = require('../lib/ai-narration-prompts');
const aiNarration = require('../lib/ai-narration');

const SAMPLE_DATA = {
  ticker: 'EXCL', status: 'TP1_HIT', category: 'Day Trade',
  entry1: 2900, entry2: 2870, sl: 2750, stop_loss: 2750,
  tp1: 3010, tp2: 3150, last_price: 3020, current_price: 3020,
  risk_reward: 2.1, profit_pct: 3.79
};

// === NOTE-ONLY VALIDATOR ===

test('validateNote: valid short note passes', function() {
  var result = narrationValidator.validateNote('Tunggu konfirmasi volume sebelum entry. Jangan chase.', SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('validateNote: empty is rejected', function() {
  assert.equal(narrationValidator.validateNote('', SAMPLE_DATA).valid, false);
  assert.equal(narrationValidator.validateNote('', SAMPLE_DATA).reason, 'empty_output');
});

test('validateNote: null is rejected', function() {
  assert.equal(narrationValidator.validateNote(null, SAMPLE_DATA).valid, false);
});

test('validateNote: note >500 chars rejected', function() {
  var result = narrationValidator.validateNote('A'.repeat(501), SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'note_too_long');
});

test('validateNote: fabricated large number rejected', function() {
  var result = narrationValidator.validateNote('Target bisa ke Rp4.500 jika momentum lanjut.', SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
});

test('validateNote: source number is OK', function() {
  var result = narrationValidator.validateNote('Area 2900 tetap menjadi support kunci.', SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('validateNote: small ordinal numbers OK', function() {
  var result = narrationValidator.validateNote('Target 1 tercapai. Lanjut pantau target 2 sesuai plan.', SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('validateNote: hype "beli sekarang" rejected', function() {
  var result = narrationValidator.validateNote('Momentum bagus, beli sekarang!', SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'contains_hype');
});

test('validateNote: hype "pasti naik" rejected', function() {
  var result = narrationValidator.validateNote('Saham ini pasti naik besok.', SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'contains_hype');
});

test('validateNote: hype "auto cuan" rejected', function() {
  var result = narrationValidator.validateNote('Setup bagus, auto cuan tinggal confirm.', SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'contains_hype');
});

test('validateNote: missing numeric fields is OK (key design test)', function() {
  var result = narrationValidator.validateNote('Pantau konfirmasi volume dan close candle. Jangan entry tanpa sinyal kuat.', SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('validateNote: TP hit note without numbers valid', function() {
  var result = narrationValidator.validateNote('Target pertama tercapai. Amankan sebagian profit, trailing sesuai plan.', SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('validateNote: SL hit note valid', function() {
  var result = narrationValidator.validateNote('Stop loss tercapai. Disiplin cut loss, evaluasi setup berikutnya.', SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('validateNote: without sourceData still validates basics', function() {
  var result = narrationValidator.validateNote('Tunggu konfirmasi breakout.', null);
  assert.equal(result.valid, true);
});

// === generateNote ===

test('disabled returns fallback note:null', async function() {
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  var result = await aiNarration.generateNote('tp1_hit', SAMPLE_DATA);
  assert.equal(result.note, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'disabled');
});

test('missing primary key returns fallback', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  delete process.env.GEMINI_API_KEY_PRIMARY;
  var result = await aiNarration.generateNote('new_signal', SAMPLE_DATA);
  assert.equal(result.note, null);
  assert.equal(result.error, 'missing_primary_key');
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
});

test('primary key success returns AI note', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';
  narrationCache.clear();
  var note = 'Tunggu konfirmasi volume sebelum entry.';
  global.fetch = async function() { return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: note }] } }] }) }; };
  var result = await aiNarration.generateNote('new_signal', SAMPLE_DATA);
  assert.equal(result.source, 'ai');
  assert.equal(result.note, note);
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

test('429 triggers backup key', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  process.env.GEMINI_API_KEY_BACKUP = 'bk';
  narrationCache.clear();
  var note = 'Target tercapai.';
  var calls = 0;
  global.fetch = async function(url) { calls++; if (url.indexOf('pk') > 0) return { ok: false, status: 429, text: async () => '' }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: note }] } }] }) }; };
  var result = await aiNarration.generateNote('tp1_hit', SAMPLE_DATA);
  assert.equal(calls, 2);
  assert.equal(result.source, 'ai');
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  delete process.env.GEMINI_API_KEY_BACKUP;
  narrationCache.clear();
});

test('both keys fail returns fallback', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  process.env.GEMINI_API_KEY_BACKUP = 'bk';
  narrationCache.clear();
  global.fetch = async function() { return { ok: false, status: 500, text: async () => '' }; };
  var result = await aiNarration.generateNote('tp1_hit', SAMPLE_DATA);
  assert.equal(result.note, null);
  assert.equal(result.source, 'fallback');
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  delete process.env.GEMINI_API_KEY_BACKUP;
  narrationCache.clear();
});

test('fabricated number in AI note → fallback', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  narrationCache.clear();
  global.fetch = async function() { return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Target Rp4.500 sangat menjanjikan.' }] } }] }) }; };
  var result = await aiNarration.generateNote('new_signal', SAMPLE_DATA);
  assert.equal(result.note, null);
  assert.equal(result.source, 'fallback');
  assert.ok(result.error.indexOf('fabricated_numbers') >= 0);
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

test('hype in AI note → fallback', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  narrationCache.clear();
  global.fetch = async function() { return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Pasti naik besok!' }] } }] }) }; };
  var result = await aiNarration.generateNote('new_signal', SAMPLE_DATA);
  assert.equal(result.note, null);
  assert.ok(result.error.indexOf('contains_hype') >= 0);
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

test('cache reuse works', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  narrationCache.clear();
  var calls = 0;
  global.fetch = async function() { calls++; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Pantau konfirmasi.' }] } }] }) }; };
  await aiNarration.generateNote('new_signal', SAMPLE_DATA);
  var r2 = await aiNarration.generateNote('new_signal', SAMPLE_DATA);
  assert.equal(r2.source, 'cache');
  assert.equal(calls, 1);
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

// === narrateNewSignal / narrateMonitorUpdate ===

test('narrateNewSignal skips stale', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  var result = await aiNarration.narrateNewSignal({ ticker: 'X', is_stale: true, entry1: 100, sl: 90, tp1: 120, tp2: 140, lastn: 105 }, 'swing');
  assert.equal(result.note, null);
  assert.equal(result.error, 'stale_or_expired');
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
});

test('narrateMonitorUpdate skips EXPIRED', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  var result = await aiNarration.narrateMonitorUpdate({ ticker: 'X', entry1: 100, sl: 90, tp1: 120, tp2: 140, raw_payload: {} }, { status: 'EXPIRED' }, { last: 95 });
  assert.equal(result.note, null);
  assert.equal(result.error, 'stale_or_expired');
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
});

// === Legacy generateNarration backward compat ===

test('generateNarration returns text field', async function() {
  var origFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'pk';
  narrationCache.clear();
  global.fetch = async function() { return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Disiplin plan.' }] } }] }) }; };
  var result = await aiNarration.generateNarration('new_signal', SAMPLE_DATA);
  assert.equal(result.text, 'Disiplin plan.');
  assert.equal(result.source, 'ai');
  global.fetch = origFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

// === MODEL DEFAULT ===

test('default model is gemini-3-flash', function() {
  delete process.env.GEMINI_MODEL;
  assert.equal(aiNarration.getModel(), 'gemini-3-flash');
});

test('GEMINI_MODEL env override works', function() {
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
  assert.equal(aiNarration.getModel(), 'gemini-3.1-flash-lite');
  delete process.env.GEMINI_MODEL;
});

// === PROMPTS ===

test('buildNotePrompt non-empty, no raw numbers/ticker', function() {
  var types = ['new_signal', 'tp1_hit', 'sl_hit', 'running', 'monitor_update'];
  types.forEach(function(t) {
    var p = narrationPrompts.buildNotePrompt(t, SAMPLE_DATA);
    assert.ok(p.length > 20);
    assert.ok(p.indexOf('2900') < 0, t + ' should not have raw number');
    assert.ok(p.indexOf('EXCL') < 0, t + ' should not have ticker');
  });
});

test('system instruction has note-only rules', function() {
  var sys = narrationPrompts.getSystemInstruction();
  assert.ok(sys.indexOf('catatan singkat') >= 0);
  assert.ok(sys.indexOf('JANGAN menulis ulang') >= 0);
  assert.ok(sys.indexOf('1-3 kalimat') >= 0);
});

// === isStaleOrExpired ===

test('isStaleOrExpired basics', function() {
  assert.equal(aiNarration.isStaleOrExpired(null), true);
  assert.equal(aiNarration.isStaleOrExpired({ status: 'RUNNING' }), false);
  assert.equal(aiNarration.isStaleOrExpired({ is_stale: true }), true);
  assert.equal(aiNarration.isStaleOrExpired({}, { status: 'EXPIRED' }), true);
});

// === Config ===

test('getNarrationConfigStatus reports note_only mode', function() {
  var c = aiNarration.getNarrationConfigStatus();
  assert.equal(c.mode, 'note_only');
});

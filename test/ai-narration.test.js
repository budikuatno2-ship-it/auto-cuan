'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Modules under test
const narrationCache = require('../lib/ai-narration-cache');
const narrationValidator = require('../lib/ai-narration-validator');
const narrationPrompts = require('../lib/ai-narration-prompts');
const aiNarration = require('../lib/ai-narration');

// === Test Data ===
const SAMPLE_DATA = {
  ticker: 'EXCL',
  status: 'TP1_HIT',
  category: 'Day Trade',
  entry1: 2900,
  entry2: 2870,
  sl: 2750,
  stop_loss: 2750,
  tp1: 3010,
  tp2: 3150,
  last_price: 3020,
  current_price: 3020,
  risk_reward: 2.1,
  profit_pct: 3.79
};


// === Test 1: Disabled flag → existing template used, no Gemini call ===
test('disabled flag returns fallback, no Gemini call', async function() {
  // Ensure disabled
  const origEnabled = process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;

  const result = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'disabled');

  // Restore
  if (origEnabled) process.env.TELEGRAM_AI_NARRATION_ENABLED = origEnabled;
});

test('disabled flag with value "false" returns fallback', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'false';

  const result = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'disabled');

  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
});


// === Test 2: Primary key success → AI narration used ===
test('primary key success returns AI narration', async function() {
  // Mock fetch for this test
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-primary-key';
  narrationCache.clear();

  const validAiOutput = [
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp3.020',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    '',
    'Catatan:',
    'Target pertama tercapai. Pantau TP2 atau amankan profit.'
  ].join('\n');

  global.fetch = async function(url, opts) {
    // Verify it uses primary key
    assert.ok(url.indexOf('test-primary-key') > 0);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: validAiOutput }] } }]
      })
    };
  };

  const result = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);

  assert.equal(result.source, 'ai');
  assert.equal(result.text, validAiOutput);

  // Cleanup
  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});


// === Test 3: Primary key 429/timeout → backup key used ===
test('primary key 429 triggers backup key', async function() {
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-primary-key';
  process.env.GEMINI_API_KEY_BACKUP = 'test-backup-key';
  narrationCache.clear();

  const validAiOutput = [
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp3.020',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    '',
    'Catatan:',
    'Target pertama tercapai.'
  ].join('\n');

  let callCount = 0;
  global.fetch = async function(url, opts) {
    callCount++;
    if (url.indexOf('test-primary-key') > 0) {
      // Simulate 429 rate limit
      return {
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded'
      };
    }
    if (url.indexOf('test-backup-key') > 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: validAiOutput }] } }]
        })
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const result = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);

  assert.equal(callCount, 2, 'Should call primary then backup');
  assert.equal(result.source, 'ai');
  assert.equal(result.text, validAiOutput);

  // Cleanup
  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  delete process.env.GEMINI_API_KEY_BACKUP;
  narrationCache.clear();
});


// === Test 4: Both keys fail → fallback template ===
test('both keys fail returns fallback', async function() {
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-primary-key';
  process.env.GEMINI_API_KEY_BACKUP = 'test-backup-key';
  narrationCache.clear();

  global.fetch = async function(url, opts) {
    return {
      ok: false,
      status: 500,
      text: async () => 'Internal server error'
    };
  };

  const result = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.ok(result.error, 'Should have error message');

  // Cleanup
  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  delete process.env.GEMINI_API_KEY_BACKUP;
  narrationCache.clear();
});


// === Test 5: AI output changes number → rejected/fallback ===
test('AI output that changes a number is rejected', function() {
  // AI output has wrong TP1 value (3050 instead of 3010)
  const badOutput = [
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900',
    'TP1: Rp3.050',
    'Harga sekarang: Rp3.020',
    'Estimasi profit: +3,79%'
  ].join('\n');

  const result = narrationValidator.validate(badOutput, SAMPLE_DATA);

  assert.equal(result.valid, false);
  assert.ok(
    result.reason === 'missing_required_data' || result.reason === 'fabricated_numbers',
    'Should fail due to missing/changed number'
  );
});

test('AI output that adds a fabricated large number is rejected', function() {
  const badOutput = [
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'SL: Rp2.750',
    'Harga sekarang: Rp3.020',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    'Target berikutnya: Rp4.500'
  ].join('\n');

  const result = narrationValidator.validate(badOutput, SAMPLE_DATA);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
});


// === Test 6: AI output removes required ticker/status/levels → rejected ===
test('AI output missing ticker is rejected', function() {
  const badOutput = [
    'Status: TP1 HIT',
    'Entry: Rp2.900',
    'TP1: Rp3.010',
    'Harga sekarang: Rp3.020',
    'Estimasi profit: +3,79%'
  ].join('\n');

  const result = narrationValidator.validate(badOutput, SAMPLE_DATA);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_required_data');
  assert.ok(result.missingFields.indexOf('ticker') >= 0);
});

test('AI output missing status is rejected', function() {
  const badOutput = [
    'Saham: EXCL',
    'Entry: Rp2.900',
    'TP1: Rp3.010',
    'Harga sekarang: Rp3.020',
    'Estimasi profit: +3,79%'
  ].join('\n');

  const result = narrationValidator.validate(badOutput, SAMPLE_DATA);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_required_data');
  assert.ok(result.missingFields.indexOf('status') >= 0);
});

test('AI output missing entry price is rejected', function() {
  const badOutput = [
    'Saham: EXCL',
    'Status: TP1 HIT',
    'TP1: Rp3.010',
    'Harga sekarang: Rp3.020',
    'Estimasi profit: +3,79%'
  ].join('\n');

  const result = narrationValidator.validate(badOutput, SAMPLE_DATA);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_required_data');
  assert.ok(result.missingFields.indexOf('entry1') >= 0);
});


// === Test 7: Same event/data → cache reused, no second Gemini call ===
test('same event data uses cache, no second Gemini call', async function() {
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-primary-key';
  narrationCache.clear();

  const validAiOutput = [
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp3.020',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    '',
    'Catatan:',
    'Target pertama tercapai.'
  ].join('\n');

  let fetchCallCount = 0;
  global.fetch = async function(url, opts) {
    fetchCallCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: validAiOutput }] } }]
      })
    };
  };

  // First call - should hit Gemini
  const result1 = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);
  assert.equal(result1.source, 'ai');
  assert.equal(fetchCallCount, 1);

  // Second call with same data - should use cache
  const result2 = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);
  assert.equal(result2.source, 'cache');
  assert.equal(result2.text, validAiOutput);
  assert.equal(fetchCallCount, 1, 'No additional fetch call');

  // Cleanup
  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});


// === Test 8: Changed data hash → regenerate ===
test('changed data hash triggers new Gemini call', async function() {
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-primary-key';
  narrationCache.clear();

  const validAiOutput1 = [
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp3.020',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    '',
    'Catatan: Target pertama tercapai.'
  ].join('\n');

  const validAiOutput2 = [
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp3.050',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    '',
    'Catatan: Target pertama tercapai, harga terus naik.'
  ].join('\n');

  let fetchCallCount = 0;
  global.fetch = async function(url, opts) {
    fetchCallCount++;
    const output = fetchCallCount === 1 ? validAiOutput1 : validAiOutput2;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: output }] } }]
      })
    };
  };

  // First call
  const result1 = await aiNarration.generateNarration('tp1_hit', SAMPLE_DATA);
  assert.equal(result1.source, 'ai');
  assert.equal(fetchCallCount, 1);

  // Second call with CHANGED price data
  const changedData = Object.assign({}, SAMPLE_DATA, {
    last_price: 3050,
    current_price: 3050
  });
  const result2 = await aiNarration.generateNarration('tp1_hit', changedData);
  assert.equal(result2.source, 'ai');
  assert.equal(fetchCallCount, 2, 'Should make new fetch call');

  // Cleanup
  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});


// === Additional validation tests ===
test('valid AI output passes validation', function() {
  const goodOutput = [
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900 / Rp2.870',
    'TP1: Rp3.010',
    'TP2: Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp3.020',
    'RR: 2.1',
    'Estimasi profit: +3,79%',
    '',
    'Catatan:',
    'Target pertama tercapai. Pantau TP2.'
  ].join('\n');

  const result = narrationValidator.validate(goodOutput, SAMPLE_DATA);
  assert.equal(result.valid, true);
});

test('empty AI output is rejected', function() {
  const result = narrationValidator.validate('', SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'empty_output');
});

test('null AI output is rejected', function() {
  const result = narrationValidator.validate(null, SAMPLE_DATA);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'empty_output');
});

// === Cache unit tests ===
test('cache set/get works within TTL', function() {
  narrationCache.clear();
  narrationCache.set('test-key', 'cached text');
  assert.equal(narrationCache.get('test-key'), 'cached text');
  narrationCache.clear();
});

test('cache buildCacheKey is deterministic', function() {
  const params = { type: 'tp1_hit', ticker: 'EXCL', category: 'Day Trade',
    data: { entry1: 2900, tp1: 3010, last_price: 3020 } };
  const key1 = narrationCache.buildCacheKey(params);
  const key2 = narrationCache.buildCacheKey(params);
  assert.equal(key1, key2);
});

test('cache buildCacheKey differs on data change', function() {
  const params1 = { type: 'tp1_hit', ticker: 'EXCL', category: 'Day Trade',
    data: { entry1: 2900, tp1: 3010, last_price: 3020 } };
  const params2 = { type: 'tp1_hit', ticker: 'EXCL', category: 'Day Trade',
    data: { entry1: 2900, tp1: 3010, last_price: 3050 } };
  const key1 = narrationCache.buildCacheKey(params1);
  const key2 = narrationCache.buildCacheKey(params2);
  assert.notEqual(key1, key2);
});

// === Prompts unit tests ===
test('prompt builder returns non-empty string for all types', function() {
  const types = ['new_signal', 'watchlist', 'entry_hit', 'in_entry_zone',
    'tp1_hit', 'tp2_hit', 'sl_hit', 'running', 'monitor_update'];
  for (const type of types) {
    const prompt = narrationPrompts.buildUserPrompt(type, SAMPLE_DATA);
    assert.ok(prompt.length > 50, 'Prompt for ' + type + ' should be substantial');
    assert.ok(prompt.indexOf('EXCL') >= 0, 'Prompt should include ticker');
  }
});

test('system instruction contains critical rules', function() {
  const sys = narrationPrompts.getSystemInstruction();
  assert.ok(sys.indexOf('JANGAN mengubah') >= 0);
  assert.ok(sys.indexOf('angka') >= 0);
  assert.ok(sys.indexOf('ticker') >= 0);
});

// === isNarrationEnabled tests ===
test('isNarrationEnabled returns false when not set', function() {
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  assert.equal(aiNarration.isNarrationEnabled(), false);
});

test('isNarrationEnabled returns true only for exact "true"', function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  assert.equal(aiNarration.isNarrationEnabled(), true);
  process.env.TELEGRAM_AI_NARRATION_ENABLED = '1';
  assert.equal(aiNarration.isNarrationEnabled(), false);
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'TRUE';
  assert.equal(aiNarration.isNarrationEnabled(), false);
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
});


// === Test: Default model is gemini-2.5-flash ===
test('default model is gemini-2.5-flash', function() {
  delete process.env.GEMINI_MODEL;
  assert.equal(aiNarration.getModel(), 'gemini-2.5-flash');
});

test('GEMINI_MODEL env override works', function() {
  process.env.GEMINI_MODEL = 'gemini-2.0-flash';
  assert.equal(aiNarration.getModel(), 'gemini-2.0-flash');
  delete process.env.GEMINI_MODEL;
});

// === Test: Validator accepts status synonyms (Indonesian translations) ===
test('validator accepts Watchlist synonym Pantauan', function() {
  const output = 'BBRI\nStatus: Pantauan\nEntry: Rp5.000\nSL: Rp4.800\nTP: Rp5.500 / Rp5.800\nHarga: Rp5.100\nRR: 2,19';
  const data = { ticker: 'BBRI', status: 'Watchlist', entry1: 5000, sl: 4800, stop_loss: 4800, tp1: 5500, tp2: 5800, last_price: 5100, current_price: 5100, risk_reward: 2.19 };
  const result = narrationValidator.validate(output, data);
  assert.equal(result.valid, true, 'Pantauan should be accepted as Watchlist synonym');
});

test('validator accepts Swing Ready synonym Watchlist from AI', function() {
  const output = 'BBRI\nStatus: Watchlist\nEntry: Rp5.000\nSL: Rp4.800\nTP: Rp5.500 / Rp5.800\nHarga: Rp5.100\nRR: 2,19';
  const data = { ticker: 'BBRI', status: 'Swing Ready', entry1: 5000, sl: 4800, stop_loss: 4800, tp1: 5500, tp2: 5800, last_price: 5100, current_price: 5100, risk_reward: 2.19 };
  const result = narrationValidator.validate(output, data);
  assert.equal(result.valid, true, 'Watchlist should be accepted as Swing Ready synonym');
});

test('validator accepts TP1_HIT synonym Target 1 Tercapai', function() {
  const output = 'BBRI\nTarget 1 Tercapai\nEntry: Rp5.000\nSL: Rp4.800\nTP: Rp5.500 / Rp5.800\nHarga: Rp5.100\nRR: 2,19';
  const data = { ticker: 'BBRI', status: 'TP1_HIT', entry1: 5000, sl: 4800, stop_loss: 4800, tp1: 5500, tp2: 5800, last_price: 5100, current_price: 5100, risk_reward: 2.19 };
  const result = narrationValidator.validate(output, data);
  assert.equal(result.valid, true, 'Target 1 Tercapai should be accepted as TP1_HIT synonym');
});

test('validator still rejects when no status synonym present at all', function() {
  const output = 'BBRI\nHarga bagus\nEntry: Rp5.000\nSL: Rp4.800\nTP: Rp5.500 / Rp5.800\nHarga: Rp5.100\nRR: 2,19';
  const data = { ticker: 'BBRI', status: 'Swing Ready', entry1: 5000, sl: 4800, stop_loss: 4800, tp1: 5500, tp2: 5800, last_price: 5100, current_price: 5100, risk_reward: 2.19 };
  const result = narrationValidator.validate(output, data);
  assert.equal(result.valid, false, 'Should reject when no status synonym is found');
  assert.ok(result.missingFields.indexOf('status') >= 0, 'Missing field should include status');
});

// === Test: Stale/expired data does not call Gemini ===
test('stale monitor pick (evaluation EXPIRED) returns fallback without Gemini call', async function() {
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';
  narrationCache.clear();

  let fetchCalled = false;
  global.fetch = async function() { fetchCalled = true; throw new Error('should not be called'); };

  const pick = { ticker: 'BBRI', entry1: 5000, entry2: 5050, sl: 4800, tp1: 5500, tp2: 5800, raw_payload: {} };
  const evaluation = { status: 'EXPIRED', label: 'Expired', isFinal: false, note: 'Setup expired' };
  const px = { last: 5100, high: 5100, low: 5000 };

  const result = await aiNarration.narrateMonitorUpdate(pick, evaluation, px);

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'stale_or_expired');
  assert.equal(fetchCalled, false, 'Gemini should not be called');

  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

test('stale monitor pick (evaluation NEEDS_REVALIDATION) returns fallback', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';
  narrationCache.clear();

  const pick = { ticker: 'EXCL', entry1: 2900, entry2: 2870, sl: 2750, tp1: 3010, tp2: 3150, raw_payload: {} };
  const evaluation = { status: 'NEEDS_REVALIDATION', label: 'Needs Revalidation', isFinal: false, note: 'Data belum tersedia' };
  const px = { last: null };

  const result = await aiNarration.narrateMonitorUpdate(pick, evaluation, px);

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'stale_or_expired');

  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

test('stale monitor pick (INVALID evaluation) returns fallback', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';

  const pick = { ticker: 'BBCA', entry1: 9000, entry2: 8900, sl: 8500, tp1: 9500, tp2: 10000, raw_payload: {} };
  const evaluation = { status: 'INVALID', label: 'Invalid', isFinal: true, note: 'Harga menyentuh invalidation sebelum entry' };

  const result = await aiNarration.narrateMonitorUpdate(pick, evaluation, { last: 8400 });

  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'stale_or_expired');

  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
});

test('stale candidate (is_stale flag) skips AI narration', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';

  const candidate = {
    ticker: 'BMRI', status: 'READY_BREAKOUT', is_stale: true,
    entry1: 6000, entry2: 5900, sl: 5700, tp1: 6500, tp2: 6800,
    lastn: 6050, risk_reward: 2.0
  };

  const result = await aiNarration.narrateNewSignal(candidate, 'swing');

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'stale_or_expired');

  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
});

test('stale candidate (setup_freshness_status EXPIRED) skips AI narration', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';

  const candidate = {
    ticker: 'TLKM', status: 'READY_BREAKOUT',
    setup_freshness_status: 'EXPIRED',
    entry1: 3800, entry2: 3750, sl: 3600, tp1: 4100, tp2: 4300,
    lastn: 3820, risk_reward: 1.8
  };

  const result = await aiNarration.narrateNewSignal(candidate, 'daytrade');

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'stale_or_expired');

  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
});

test('candidate with status containing EXPIRED skips AI narration', async function() {
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';

  const candidate = {
    ticker: 'ASII', status: 'SETUP_EXPIRED',
    entry1: 5500, entry2: 5400, sl: 5200, tp1: 6000, tp2: 6300,
    lastn: 5450, risk_reward: 2.0
  };

  const result = await aiNarration.narrateNewSignal(candidate, 'swing');

  assert.equal(result.text, null);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'stale_or_expired');

  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
});

test('fresh candidate (no stale flags) proceeds to AI narration', async function() {
  const originalFetch = global.fetch;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-key';
  narrationCache.clear();

  const validOutput = [
    '\uD83D\uDCCC DAY TRADE WATCHLIST',
    '',
    'Saham: BBRI',
    'Status: READY BREAKOUT',
    'Area Entry: Rp5.000 / Rp5.050',
    'Target: Rp5.500 / Rp5.800',
    'Stop Loss: Rp4.800',
    'Harga sekarang: Rp5.025',
    'RR: 2.5',
    '',
    'Catatan: Tunggu konfirmasi.'
  ].join('\n');

  let fetchCalled = false;
  global.fetch = async function() {
    fetchCalled = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: validOutput }] } }]
      })
    };
  };

  const candidate = {
    ticker: 'BBRI', status: 'READY_BREAKOUT',
    entry1: 5000, entry2: 5050, sl: 4800, stop_loss: 4800,
    tp1: 5500, tp2: 5800, lastn: 5025, risk_reward: 2.5
  };

  const result = await aiNarration.narrateNewSignal(candidate, 'daytrade');

  assert.equal(fetchCalled, true, 'Gemini should be called for fresh data');
  assert.equal(result.source, 'ai');
  assert.ok(result.text);

  global.fetch = originalFetch;
  delete process.env.TELEGRAM_AI_NARRATION_ENABLED;
  delete process.env.GEMINI_API_KEY_PRIMARY;
  narrationCache.clear();
});

// === isStaleOrExpired unit tests ===
test('isStaleOrExpired returns true for expired evaluation', function() {
  assert.equal(aiNarration.isStaleOrExpired({}, { status: 'EXPIRED' }), true);
  assert.equal(aiNarration.isStaleOrExpired({}, { status: 'NEEDS_REVALIDATION' }), true);
  assert.equal(aiNarration.isStaleOrExpired({}, { status: 'INVALID' }), true);
});

test('isStaleOrExpired returns true for stale flags', function() {
  assert.equal(aiNarration.isStaleOrExpired({ is_stale: true }), true);
  assert.equal(aiNarration.isStaleOrExpired({ data_stale: true }), true);
  assert.equal(aiNarration.isStaleOrExpired({ freshness_is_stale: true }), true);
});

test('isStaleOrExpired returns true for expired status string', function() {
  assert.equal(aiNarration.isStaleOrExpired({ status: 'EXPIRED' }), true);
  assert.equal(aiNarration.isStaleOrExpired({ status: 'SETUP_EXPIRED' }), true);
  assert.equal(aiNarration.isStaleOrExpired({ status: 'NEEDS_REVALIDATION' }), true);
  assert.equal(aiNarration.isStaleOrExpired({ final_status: 'DATA_STALE' }), true);
});

test('isStaleOrExpired returns true for expired setup_freshness_status', function() {
  assert.equal(aiNarration.isStaleOrExpired({ raw_payload: { setup_freshness_status: 'EXPIRED' } }), true);
  assert.equal(aiNarration.isStaleOrExpired({ setup_freshness_status: 'NEEDS_REVALIDATION' }), true);
});

test('isStaleOrExpired returns false for fresh data', function() {
  assert.equal(aiNarration.isStaleOrExpired({ status: 'RUNNING', is_stale: false }), false);
  assert.equal(aiNarration.isStaleOrExpired({ status: 'TP1_HIT' }), false);
  assert.equal(aiNarration.isStaleOrExpired({ status: 'READY_BREAKOUT', setup_freshness_status: 'FRESH' }), false);
});

test('isStaleOrExpired returns true for null/undefined input', function() {
  assert.equal(aiNarration.isStaleOrExpired(null), true);
  assert.equal(aiNarration.isStaleOrExpired(undefined), true);
});

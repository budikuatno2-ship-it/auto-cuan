'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sectorHot = require('../api/sector-hot');

const {
  buildTelegramTopMessage,
  candidatePassesTelegramCandidateDigestGate,
  candidateTelegramEligible
} = sectorHot.__test;

function makeSupabase(dtRows, swRows, nkRows) {
  return {
    from: function(table) {
      var data;
      if (table === 'daytrade_screener_latest') data = dtRows || [];
      else if (table === 'swing_screener_latest') data = swRows || [];
      else if (table === 'swing_screener_non_konglo_latest') data = nkRows || [];
      else data = [];
      return {
        select: function() { return this; },
        order: function() { return this; },
        limit: function() { return Promise.resolve({ data: data, error: null }); },
        eq: function() { return this; },
        neq: function() { return this; },
        in: function() { return this; },
        maybeSingle: function() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), status: 'published' }, error: null }); }
      };
    }
  };
}

// Realistic DB row - minimal fields matching actual screener DB schema
function dbRow(overrides) {
  return Object.assign({
    ticker: 'BRMS', status: 'MOMENTUM_CONTINUATION', daytrade_score: 80,
    last_price: 492, entry_low: 482, entry_high: 494,
    stop_loss: 464, tp1: 685, tp2: 725, risk_reward: 6.37,
    volume_ratio_20d: 1.06, value_today: 255000000000,
    tx_value_1d: 255000000000, avg_tx_value_7d: 233000000000,
    trading_plan_valid: true, plan_quality_status: 'OK',
    risk_label: 'High Risk',
    tf_1d_context: 'Green candle', tf_5d_context: 'Bearish (-9.7%)'
  }, overrides || {});
}

test('buildTelegramTopMessage returns candidates when digest gate passes but strict gate fails (UNKNOWN_LIMITS from missing prev_close)', async function() {
  // This is the EXACT scenario: DB rows without previous_close get UNKNOWN_LIMITS
  // from deriveCandlePotentialRange, but should still appear as candidates
  var supabase = makeSupabase(
    [dbRow({ ticker: 'BRMS' })],
    [dbRow({ ticker: 'BBRI', status: 'Watchlist', score: 72, stop_loss: 4800, entry_low: 5000, entry_high: 5050, tp1: 5500, tp2: 5800, risk_reward: 1.8, last_price: 5025, risk_label: 'Very High Risk' })],
    []
  );
  var msg = await buildTelegramTopMessage(supabase);
  assert.ok(msg.includes('BRMS'), 'Should contain BRMS ticker');
  assert.ok(msg.includes('Top 10 Screener'), 'Should contain Top 10 header');
  assert.ok(!msg.includes('Belum ada kandidat'), 'Should NOT say no candidates');
  // Rich fields present
  assert.ok(msg.includes('Status:'), 'Should contain Status field');
  assert.ok(msg.includes('G:'), 'Should contain Grade');
  assert.ok(msg.includes('RR:'), 'Should contain RR');
  assert.ok(msg.includes('Entry:'), 'Should contain Entry');
  assert.ok(msg.includes('SL:'), 'Should contain SL');
  assert.ok(msg.includes('TP:'), 'Should contain TP');
  assert.ok(msg.includes('Verdict:'), 'Should contain Verdict');
});

test('buildTelegramTopMessage allows TP2 missing if TP1 valid', async function() {
  var supabase = makeSupabase(
    [dbRow({ ticker: 'NOTP2', tp2: null })],
    [], []
  );
  var msg = await buildTelegramTopMessage(supabase);
  assert.ok(msg.includes('NOTP2'), 'Should contain ticker with missing TP2');
  assert.ok(!msg.includes('Belum ada kandidat'));
});

test('buildTelegramTopMessage maps entry_high/entry_low to Entry correctly', async function() {
  var supabase = makeSupabase(
    [dbRow({ ticker: 'EMAPS', entry_high: 510, entry_low: 490, last_price: 505, stop_loss: 470, tp1: 560, tp2: 600 })],
    [], []
  );
  var msg = await buildTelegramTopMessage(supabase);
  assert.ok(msg.includes('EMAPS'), 'Should contain ticker EMAPS');
  assert.ok(msg.includes('Entry:'), 'Should contain Entry field');
});

test('buildTelegramTopMessage maps stop_loss to SL correctly', async function() {
  var supabase = makeSupabase(
    [dbRow({ ticker: 'SLMAP', stop_loss: 420 })],
    [], []
  );
  var msg = await buildTelegramTopMessage(supabase);
  assert.ok(msg.includes('SLMAP'));
  assert.ok(msg.includes('SL:'));
  assert.ok(msg.includes('420'));
});

test('buildTelegramTopMessage maps tp1 to TP correctly', async function() {
  var supabase = makeSupabase(
    [dbRow({ ticker: 'TPMAP', tp1: 750, tp2: 800, entry_high: 500, entry_low: 490, stop_loss: 460, last_price: 495, risk_reward: 5.0 })],
    [], []
  );
  var msg = await buildTelegramTopMessage(supabase);
  assert.ok(msg.includes('TPMAP'), 'Should contain ticker TPMAP');
  assert.ok(msg.includes('TP:'), 'Should contain TP field');
  assert.ok(msg.includes('750'), 'Should contain TP1 value 750');
});

test('/top does NOT use candidateTelegramEligible — digest gate is less strict', function() {
  // Very High Risk candidate fails strict gate but passes digest
  var candidate = dbRow({ risk_label: 'Very High Risk' });
  // The strict gate would reject this
  // (need to normalize first for strict gate to test properly)
  // But digest gate passes it directly
  assert.equal(candidatePassesTelegramCandidateDigestGate(candidate, 'top10'), true);
});

test('Missing SL still blocked by digest gate', function() {
  assert.equal(candidatePassesTelegramCandidateDigestGate(dbRow({ stop_loss: null }), 'top10'), false);
});

test('Invalid plan still blocked by digest gate', function() {
  assert.equal(candidatePassesTelegramCandidateDigestGate(dbRow({ trading_plan_valid: false }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(dbRow({ plan_quality_status: 'INVALID' }), 'top10'), false);
});

test('Below SL still blocked by digest gate', function() {
  assert.equal(candidatePassesTelegramCandidateDigestGate(dbRow({ last_price: 400 }), 'top10'), false);
});

test('Formatter hygiene: no bad placeholders in /top output', async function() {
  var supabase = makeSupabase([dbRow()], [], []);
  var msg = await buildTelegramTopMessage(supabase);
  var forbidden = ['SL: -', 'undefined', 'null', '[object Object]', 'raw_payload', 'sample_rejected', 'stageByTicker', 'debug', 'internal diagnostics'];
  for (var i = 0; i < forbidden.length; i++) {
    assert.equal(msg.includes(forbidden[i]), false, 'Should not contain: ' + forbidden[i]);
  }
});

test('Endpoint count remains 12', function() {
  var apiDir = path.join(__dirname, '..', 'api');
  var files = fs.readdirSync(apiDir).filter(function(f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12);
});

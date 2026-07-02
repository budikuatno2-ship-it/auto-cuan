'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

const {
  candidatePassesTelegramCandidateDigestGate,
  formatCandidateDigestWarnings,
  candidateTelegramEligible,
  formatCandidateBlock,
  sendDailyTop5Telegram,
  selectDailyTop5,
  buildTelegramTopMessage,
  buildTelegramScreenerMessage,
  formatDayTradeRadarTelegramMessage
} = sectorHot.__test;

// Valid base candidate with all required plan fields
function validCandidate(overrides) {
  return Object.assign({
    ticker: 'BBRI', category: 'Swing Konglo', status: 'Watchlist', final_status: 'Watchlist',
    score: 72, daily_score: 72, daytrade_score: 72, risk_reward: 1.8,
    entry1: 5000, entry_low: 5000, entry2: 5050, entry_high: 5050,
    stop_loss: 4800, sl: 4800, tp1: 5500, tp1n: 5500, tp2: 5800, tp2n: 5800,
    last_price: 5025, lastn: 5025, volume_ratio_20d: 1.1,
    value_today: 5000000000, avg_tx_value_7d: 5000000000,
    trading_plan_valid: true, plan_quality_status: 'VALID',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk'
  }, overrides || {});
}

function makeSupabase(tableRows) {
  return {
    from(table) {
      var rows = tableRows[table] || [];
      var builder = {
        select() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
        eq() { return this; },
        neq() { return this; },
        in() { return this; },
        maybeSingle() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), run_id: 'r1', status: 'published' }, error: null }); },
        delete() { return { eq: function() { return Promise.resolve({ error: null }); }, neq: function() { return Promise.resolve({ error: null }); } }; }
      };
      return builder;
    }
  };
}

async function withSendSpy(fn) {
  var original = notifier.sendTelegramMessage;
  var calls = [];
  notifier.sendTelegramMessage = async function(text) { calls.push(text); return { sent: true, message: text }; };
  try { return await fn(calls); } finally { notifier.sendTelegramMessage = original; }
}

// ============================================================
// TEST 1: Very High Risk + valid Entry/SL/TP/RR passes digest gate with warning
// ============================================================
test('Test 1: Top 10 — Very High Risk + valid plan passes digest gate with warning', function() {
  var c = validCandidate({ risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), true);
  var warnings = formatCandidateDigestWarnings(c, 'swing');
  assert.ok(warnings.indexOf('Very High Risk') >= 0, 'Should have Very High Risk warning');
});

// ============================================================
// TEST 2: Weak Volume + valid plan passes digest gate with warning
// ============================================================
test('Test 2: Top 10 — Weak Volume + valid plan passes digest gate with warning', function() {
  var c = validCandidate({ volume_label: 'Weak Volume', volume_confirmation_label: 'Weak Volume' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), true);
  var warnings = formatCandidateDigestWarnings(c, 'swing');
  assert.ok(warnings.indexOf('Weak Volume') >= 0, 'Should have Weak Volume warning');
});

// ============================================================
// TEST 3: Hindari + Tunggu Pullback + valid plan passes digest gate with warning
// ============================================================
test('Test 3: Top 10 — Hindari + Tunggu Pullback valid + valid plan passes digest gate with warning', function() {
  var c = validCandidate({ action_label: 'Hindari', entry_timing: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), true);
  var warnings = formatCandidateDigestWarnings(c, 'swing');
  assert.ok(warnings.indexOf('Hindari / caution only') >= 0, 'Should have Hindari warning');
  assert.ok(warnings.indexOf('Tunggu pullback / jangan chase') >= 0, 'Should have pullback warning');
});

// ============================================================
// TEST 4: Missing SL does NOT pass digest gate
// ============================================================
test('Test 4: Top 10 — missing SL does not pass digest gate', function() {
  var c = validCandidate({ sl: null, stop_loss: null });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), false);
});

// ============================================================
// TEST 5: Invalid plan does NOT pass digest gate
// ============================================================
test('Test 5: Top 10 — invalid plan does not pass digest gate', function() {
  var c = validCandidate({ trading_plan_valid: false });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), false);
  var c2 = validCandidate({ plan_quality_status: 'INVALID' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c2, 'top10'), false);
});

// ============================================================
// TEST 6: Below SL / SL hit does NOT pass digest gate
// ============================================================
test('Test 6: Top 10 — below SL does not pass digest gate', function() {
  var c = validCandidate({ last_price: 4700, lastn: 4700 }); // below SL of 4800
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), false);
  var c2 = validCandidate({ entry_status: 'INVALID_BELOW_SL' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c2, 'top10'), false);
});

// ============================================================
// TEST 7: Impossible ARA/ARB / UNKNOWN_LIMITS does NOT pass digest gate
// ============================================================
test('Test 7: Top 10 — impossible ARA/ARB / UNKNOWN_LIMITS does not pass digest gate', function() {
  assert.equal(candidatePassesTelegramCandidateDigestGate(validCandidate({ execution_reality_status: 'UNKNOWN_LIMITS' }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(validCandidate({ execution_reality_status: 'ARA_HIT' }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(validCandidate({ execution_reality_status: 'ARB_HIT' }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(validCandidate({ buy_execution_realistic: false }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(validCandidate({ sell_risk_near_arb: true }), 'top10'), false);
});

// ============================================================
// TEST 8: /screener day trade — WAIT_PULLBACK valid passes digest gate
// ============================================================
test('Test 8: /screener day trade — WAIT_PULLBACK valid passes digest gate', function() {
  var c = validCandidate({ category: 'Day Trade', status: 'WAIT_PULLBACK', entry_status: 'WAIT_PULLBACK', entry_timing: 'wait pullback' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'screener_day_trade'), true);
  var warnings = formatCandidateDigestWarnings(c, 'daytrade');
  assert.ok(warnings.indexOf('Tunggu pullback / jangan chase') >= 0);
});

// ============================================================
// TEST 9: /screener swing konglo — Watchlist/High Risk valid passes digest gate
// ============================================================
test('Test 9: /screener swing konglo — Watchlist + High Risk valid passes digest gate', function() {
  var c = validCandidate({ status: 'Watchlist', risk_label: 'High Risk', risk_label_v2: 'High Risk' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'screener_swing_konglo'), true);
  var warnings = formatCandidateDigestWarnings(c, 'swing');
  assert.ok(warnings.indexOf('High Risk') >= 0);
});

// ============================================================
// TEST 10: /screener swing non konglo — valid plan passes even without strict final signal
// ============================================================
test('Test 10: /screener swing non konglo — valid plan passes even without strict final signal', function() {
  var c = validCandidate({ category: 'Swing Non-Konglo', status: 'Speculative', final_quality_pass: false });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'screener_swing_non_konglo'), true);
});

// ============================================================
// TEST 11: selectDailyTop5 not empty if digest candidates valid
// ============================================================
test('Test 11: candidatePassesTelegramCandidateDigestGate allows candidate that fails strict candidateTelegramEligible', function() {
  // A candidate with Very High Risk fails strict candidateTelegramEligible but passes digest gate
  var c = validCandidate({ risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk', volume_confirmation_label: 'Weak Volume' });
  // Fails strict gate
  assert.equal(candidateTelegramEligible(c), false, 'Should fail strict candidateTelegramEligible');
  // Passes digest gate
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'daily_top5'), true, 'Should pass digest gate');
  // This means selectDailyTop5 (which uses digest gate) would NOT be empty
  // when the strict gate would have been empty.
});

// ============================================================
// TEST 12: sendDailyTop5Telegram sends Top 5 when strict gate empty but digest has candidates
// ============================================================
test('Test 12: sendDailyTop5Telegram sends Top 5 candidate when strict gate empty but digest has candidates', async function() {
  await withSendSpy(async function(calls) {
    // Candidate with Very High Risk — fails strict gate but passes digest gate
    var digestCandidate = validCandidate({ ticker: 'VHRC', category: 'Swing Konglo', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' });
    var result = await sendDailyTop5Telegram(makeSupabase({}), [digestCandidate], '2026-07-02', {});
    // Should send (digest gate passes)
    assert.equal(result.header.sent, true, 'Header should be sent');
    assert.ok(calls.length >= 1, 'Should have sent at least header');
    assert.match(calls[0], /AUTO-CUAN SAHAM PILIHAN/);
  });
});

// ============================================================
// TEST 13: Formatter never outputs bad fields
// ============================================================
test('Test 13: Formatter does not output SL: -, EntryQ: -, PlanQ: -, undefined, null, [object Object], raw_payload, sample_rejected, stageByTicker, debug, internal diagnostics', async function() {
  var c = validCandidate({
    entry_quality_label: null, plan_quality_label: null,
    entry_status_label: undefined, plan_label: undefined,
    rr_quality_label: null, sl_quality_label: null, tp_quality_label: null,
    entry_window_label: null,
    raw_payload: { secret: true }, sample_rejected: [{ ticker: 'X' }],
    stageByTicker: { BBRI: {} }, debug: 'internal notes'
  });
  var supabase = makeSupabase({ foreign_watchlist_daily: [] });
  var text = await formatCandidateBlock(supabase, c, 1, true);
  // Check forbidden patterns
  var forbidden = ['SL: -', 'EntryQ: -', 'PlanQ: -', 'undefined', 'null', '[object Object]', 'raw_payload', 'sample_rejected', 'stageByTicker', 'debug', 'internal diagnostics'];
  for (var i = 0; i < forbidden.length; i++) {
    assert.equal(text.includes(forbidden[i]), false, 'Should not contain: ' + forbidden[i]);
  }
  // SL value should be present as a number (4.800)
  assert.match(text, /SL\s+[\d.,]+/);
});

// ============================================================
// TEST 14: Day Trade PR #127 behavior — sends "Day Trade Signal Candidate", not "[RADAR — BUKAN SINYAL ENTRY]"
// ============================================================
test('Test 14: Day Trade sends "Day Trade Signal Candidate" not default "[RADAR — BUKAN SINYAL ENTRY]"', function() {
  var candidates = [
    validCandidate({ ticker: 'DTRC', category: 'Day Trade', status: 'WAIT_PULLBACK', entry_status: 'WAIT_PULLBACK', breakout_confirmation_status: 'BREAKOUT_WATCH' })
  ];
  var msg = formatDayTradeRadarTelegramMessage(candidates);
  assert.match(msg, /Day Trade Signal Candidate/);
  assert.doesNotMatch(msg, /\[RADAR — BUKAN SINYAL ENTRY\]/);
  assert.match(msg, /Bukan rekomendasi beli otomatis\. Konfirmasi manual wajib\./);
});

// ============================================================
// TEST 15: Endpoint count remains 12
// ============================================================
test('Test 15: Endpoint count remains 12', function() {
  var fs = require('node:fs');
  var path = require('node:path');
  var apiDir = path.join(__dirname, '..', 'api');
  var files = fs.readdirSync(apiDir).filter(function(f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'API endpoint count should be 12, got: ' + files.length + ' (' + files.join(', ') + ')');
});

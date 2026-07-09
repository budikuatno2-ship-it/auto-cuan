'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

const {
  formatDayTradeRadarTelegramMessage,
  formatRichTelegramCandidateBlock,
  sortDayTradeRadarCandidates,
  candidatePassesTelegramCandidateDigestGate,
  candidateTelegramEligible,
  formatCandidateBlock,
  sendDailyTop5Telegram,
  selectDailyTop5,
  buildTelegramTopMessage,
  buildTelegramScreenerMessage
} = sectorHot.__test;

function base(overrides) {
  return Object.assign({
    ticker: 'BBRI', category: 'Day Trade', status: 'READY_BREAKOUT', final_status: 'READY_BREAKOUT',
    score: 82, daytrade_score: 82, risk_reward: 2.5,
    entry1: 5000, entry2: 5050, entry_low: 5000, entry_high: 5050,
    sl: 4800, stop_loss: 4800, tp1: 5500, tp1n: 5500, tp2: 5800, tp2n: 5800,
    last_price: 5025, lastn: 5025, volume_ratio_20d: 1.3, volume_ratio_avg20: 1.3,
    value_today: 10000000000, tx_value_1d: 10000000000, avg_tx_value_7d: 8000000000,
    trading_plan_valid: true, plan_quality_status: 'VALID',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid', entry_status: 'IN_ENTRY_AREA',
    entry_quality_label: 'Masuk area entry', entry_status_label: 'Masuk area entry',
    entry_status_note: 'harga berada di area entry rencana.',
    plan_quality_label: 'Plan realistis',
    breakout_confirmation_label: 'Needs Close Confirmation',
    setup_freshness_label: 'Fresh',
    entry_window_label: '09:15-10:30 / 13:45-14:30',
    telegram_verdict: 'Pantau, tunggu konfirmasi.',
    tf_1d_context: 'Green candle',
    tf_5d_context: 'Bullish (5D Approx)',
    tf_20d_context: 'Bearish (-16.6%) (20D Approx)'
  }, overrides || {});
}

function makeSupabase(tableRows) {
  return {
    from: function(table) {
      var rows = (tableRows && tableRows[table]) || [];
      return {
        select: function() { return this; },
        order: function() { return this; },
        limit: function() { return Promise.resolve({ data: rows, error: null }); },
        eq: function() { return this; },
        neq: function() { return this; },
        in: function() { return this; },
        maybeSingle: function() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), status: 'published' }, error: null }); },
        delete: function() { return { eq: function() { return Promise.resolve({ error: null }); }, neq: function() { return Promise.resolve({ error: null }); } }; }
      };
    }
  };
}

function withSendSpy(fn) {
  var original = notifier.sendTelegramMessage;
  var calls = [];
  notifier.sendTelegramMessage = async function(text) { calls.push(text); return { sent: true, message: text }; };
  return fn(calls).finally(function() { notifier.sendTelegramMessage = original; });
}

// ============================================================
// TEST 1: Day Trade formatter uses old rich format with all fields
// ============================================================
test('T1: Day Trade formatter uses premium card format with Signal, Trading Plan, Entry, Take Profit, Stop Loss, Risk/Reward, Technical Context, Price, Volume, Value, Trend, Breakout, Liquidity, Risk', function() {
  var msg = formatDayTradeRadarTelegramMessage([base()]);
  assert.match(msg, /DAY TRADE SIGNAL/i);
  assert.match(msg, /Signal:/);
  assert.match(msg, /Trading Plan/);
  assert.match(msg, /Entry:/);
  assert.match(msg, /Take Profit:/);
  assert.match(msg, /Stop Loss:/);
  assert.match(msg, /Risk\/Reward:/);
  assert.match(msg, /Technical Context/);
  assert.match(msg, /Price:/);
  assert.match(msg, /Volume:/);
  assert.match(msg, /Value:/);
  assert.match(msg, /Trend:/);
  assert.match(msg, /Breakout:/);
  assert.match(msg, /Liquidity:/);
  assert.match(msg, /Risk:/);
});

// ============================================================
// TEST 2: Day Trade does not output [RADAR — BUKAN SINYAL ENTRY] as default
// ============================================================
test('T2: Day Trade does not output [RADAR — BUKAN SINYAL ENTRY] as default main output', function() {
  var msg = formatDayTradeRadarTelegramMessage([base()]);
  assert.doesNotMatch(msg, /\[RADAR.*BUKAN SINYAL ENTRY\]/);
  assert.match(msg, /DAY TRADE SIGNAL/i);
});

// ============================================================
// TEST 3: Day Trade selects higher RR candidates before RR < 1 candidates
// ============================================================
test('T3: Day Trade selects higher RR candidates before RR < 1', function() {
  var lowRR = base({ ticker: 'LOW', risk_reward: 0.86 });
  var highRR = base({ ticker: 'HIGH', risk_reward: 3.5 });
  var sorted = [lowRR, highRR].sort(sortDayTradeRadarCandidates);
  assert.equal(sorted[0].ticker, 'HIGH', 'Higher RR should come first');
});

// ============================================================
// TEST 4: Day Trade RR < 1 candidate not selected if RR >= 1.5 exist
// ============================================================
test('T4: Day Trade RR < 1 candidate is not selected first if RR >= 1.5 candidates exist', function() {
  var candidates = [
    base({ ticker: 'BAD', risk_reward: 0.86 }),
    base({ ticker: 'OKAY', risk_reward: 1.2 }),
    base({ ticker: 'GOOD', risk_reward: 2.5 }),
    base({ ticker: 'GREAT', risk_reward: 4.0 })
  ];
  var sorted = candidates.sort(sortDayTradeRadarCandidates);
  assert.equal(sorted[0].ticker, 'GREAT');
  assert.equal(sorted[1].ticker, 'GOOD');
  // RR < 1 must be last
  assert.equal(sorted[sorted.length - 1].ticker, 'BAD');
});

// ============================================================
// TEST 5: Swing Konglo rich format restored (uses fmtTelegramSignalBlock via formatSwingTelegramMessage)
// ============================================================
test('T5: Swing Konglo rich format contains Status, G, RR, EntryQ, Breakout, Window, Value, TF, Verdict', function() {
  var r = base({ category: 'Swing Konglo', status: 'Swing Ready' });
  var block = formatRichTelegramCandidateBlock(r, 1, 'swing');
  assert.match(block, /Status:/);
  assert.match(block, /G:/);
  assert.match(block, /RR:/);
  assert.match(block, /EntryQ:/);
  assert.match(block, /Breakout:/);
  assert.match(block, /Window:/);
  assert.match(block, /Value:/);
  assert.match(block, /TF:/);
  assert.match(block, /Verdict:/);
});

// ============================================================
// TEST 6: Swing Non-Konglo rich format restored
// ============================================================
test('T6: Swing Non-Konglo rich format contains Status, G, RR, Value, TF, Verdict', function() {
  var r = base({ category: 'Swing Non-Konglo', status: 'Wait Pullback' });
  var block = formatRichTelegramCandidateBlock(r, 1, 'swing_non_konglo');
  assert.match(block, /Status:/);
  assert.match(block, /G:/);
  assert.match(block, /RR:/);
  assert.match(block, /Value:/);
  assert.match(block, /Verdict:/);
});

// ============================================================
// TEST 7: /top returns candidates when strict candidateTelegramEligible fails but digest gate passes
// ============================================================
test('T7: /top returns candidates when strict gate fails but digest gate passes', function() {
  var c = base({ risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' });
  assert.equal(candidateTelegramEligible(c), false, 'strict gate should fail');
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), true, 'digest gate should pass');
});

// ============================================================
// TEST 8: /top with Very High Risk valid plan returns candidate + warning/verdict
// ============================================================
test('T8: /top Very High Risk valid plan produces candidate block with warning in output', function() {
  var r = base({ risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' });
  var block = formatRichTelegramCandidateBlock(r, 1, 'daytrade');
  assert.match(block, /Very High Risk/);
  assert.match(block, /Verdict:/);
});

// ============================================================
// TEST 9: /top with Weak Volume valid plan returns candidate + warning
// ============================================================
test('T9: /top Weak Volume valid plan produces candidate block with warning', function() {
  var r = base({ volume_confirmation_label: 'Weak Volume', volume_label: 'Weak Volume' });
  var block = formatRichTelegramCandidateBlock(r, 1, 'daytrade');
  assert.match(block, /Weak Volume/);
});

// ============================================================
// TEST 10: /top with Hindari + Wait Pullback valid plan returns candidate + warning/verdict
// ============================================================
test('T10: /top Hindari + Wait Pullback valid plan produces candidate block with warning', function() {
  var r = base({ action_label: 'Hindari', entry_status: 'WAIT_PULLBACK', status: 'WAIT_PULLBACK', telegram_action_label: 'Hindari' });
  var block = formatRichTelegramCandidateBlock(r, 1, 'daytrade');
  assert.match(block, /Hindari/);
  assert.match(block, /Verdict:/);
});

// ============================================================
// TEST 11: /top missing SL blocked by digest gate
// ============================================================
test('T11: /top missing SL blocked by digest gate', function() {
  var c = base({ sl: null, stop_loss: null });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'top10'), false);
});

// ============================================================
// TEST 12: /top invalid plan blocked
// ============================================================
test('T12: /top invalid plan blocked by digest gate', function() {
  assert.equal(candidatePassesTelegramCandidateDigestGate(base({ trading_plan_valid: false }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(base({ plan_quality_status: 'INVALID' }), 'top10'), false);
});

// ============================================================
// TEST 13: /top below SL blocked
// ============================================================
test('T13: /top below SL blocked by digest gate', function() {
  assert.equal(candidatePassesTelegramCandidateDigestGate(base({ last_price: 4700, lastn: 4700 }), 'top10'), false);
  assert.equal(candidatePassesTelegramCandidateDigestGate(base({ entry_status: 'INVALID_BELOW_SL' }), 'top10'), false);
});

// ============================================================
// TEST 14: /screener day trade returns WAIT_PULLBACK valid candidate
// ============================================================
test('T14: /screener day trade — WAIT_PULLBACK valid passes digest gate', function() {
  var c = base({ status: 'WAIT_PULLBACK', entry_status: 'WAIT_PULLBACK' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'screener_day_trade'), true);
});

// ============================================================
// TEST 15: /screener swing konglo returns Watchlist/High Risk valid candidate
// ============================================================
test('T15: /screener swing konglo — Watchlist + High Risk valid passes digest gate', function() {
  var c = base({ category: 'Swing Konglo', status: 'Watchlist', risk_label: 'High Risk', risk_label_v2: 'High Risk' });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'screener_swing_konglo'), true);
});

// ============================================================
// TEST 16: /screener swing non konglo returns valid plan candidate
// ============================================================
test('T16: /screener swing non konglo — valid plan passes even without strict final signal', function() {
  var c = base({ category: 'Swing Non-Konglo', status: 'Speculative', final_quality_pass: false });
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'screener_swing_non_konglo'), true);
});

// ============================================================
// TEST 17: selectDailyTop5 returns non-empty when digest candidates exist (unit gate test)
// ============================================================
test('T17: candidatePassesTelegramCandidateDigestGate allows candidate that fails strict candidateTelegramEligible', function() {
  var c = base({ risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk', volume_confirmation_label: 'Weak Volume' });
  assert.equal(candidateTelegramEligible(c), false, 'strict gate should fail');
  assert.equal(candidatePassesTelegramCandidateDigestGate(c, 'daily_top5'), true, 'digest gate should pass');
});

// ============================================================
// TEST 18: sendDailyTop5Telegram sends Top 5 candidate when strict gate would be empty
// ============================================================
test('T18: sendDailyTop5Telegram sends Top 5 candidate when strict gate fails but digest passes', async function() {
  await withSendSpy(async function(calls) {
    var digestCandidate = base({ ticker: 'VHRC', category: 'Swing Konglo', risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk' });
    var result = await sendDailyTop5Telegram(makeSupabase({}), [digestCandidate], '2026-07-02', {});
    assert.equal(result.header.sent, true);
    assert.ok(calls.length >= 1);
    assert.match(calls[0], /AUTO-CUAN SAHAM PILIHAN/);
  });
});

// ============================================================
// TEST 19: Existing locked/already_sent logic (sendDailyTop5Telegram with empty picks stays silent)
// ============================================================
test('T19: sendDailyTop5Telegram with truly empty picks (all fatal) stays silent or sends radar', async function() {
  await withSendSpy(async function(calls) {
    // Pass candidates with missing SL (fatal) — should not send header
    var fatalCandidate = base({ ticker: 'FATAL', sl: null, stop_loss: null });
    var result = await sendDailyTop5Telegram(makeSupabase({}), [fatalCandidate], '2026-07-02', {});
    // Digest gate fails for missing SL, so safePicks=[], radar also needs radar_candidates option
    assert.equal(result.header.skipped || result.header.sent === false || result.public_picks.length === 0, true);
  });
});

// ============================================================
// TEST 20: Formatter hygiene — no bad placeholders
// ============================================================
test('T20: Formatter does not output SL: -, EntryQ: -, PlanQ: -, undefined, null, [object Object], raw_payload, sample_rejected, stageByTicker, debug, internal diagnostics', async function() {
  var c = base({
    entry_quality_label: null, plan_quality_label: null,
    entry_status_label: undefined, plan_label: undefined,
    rr_quality_label: null, sl_quality_label: null, tp_quality_label: null,
    entry_window_label: null, breakout_confirmation_label: null,
    setup_freshness_label: null, entry_status_note: null,
    raw_payload: { secret: true }, sample_rejected: [{ ticker: 'X' }],
    stageByTicker: { BBRI: {} }, debug: 'internal notes'
  });
  var supabase = makeSupabase({ foreign_watchlist_daily: [] });
  var text = await formatCandidateBlock(supabase, c, 1, true);
  var forbidden = ['SL: -', 'EntryQ: -', 'PlanQ: -', 'undefined', 'null', '[object Object]', 'raw_payload', 'sample_rejected', 'stageByTicker', 'debug', 'internal diagnostics'];
  for (var i = 0; i < forbidden.length; i++) {
    assert.equal(text.includes(forbidden[i]), false, 'Should not contain: ' + forbidden[i]);
  }
  // SL value should be present
  assert.match(text, /SL:\s*[\d.,]+/);
});

// ============================================================
// TEST 21: Endpoint count remains 12
// ============================================================
test('T21: Endpoint count remains 12', function() {
  var apiDir = path.join(__dirname, '..', 'api');
  var files = fs.readdirSync(apiDir).filter(function(f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'API endpoint count should be 12, got: ' + files.length + ' (' + files.join(', ') + ')');
});

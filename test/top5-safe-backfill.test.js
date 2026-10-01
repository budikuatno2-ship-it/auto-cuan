'use strict';

// Focused tests for Issue A: Top 5 safe-candidate selection with backfill.
// Verifies selectSafeTop5WithBackfill (pure) and its integration with the real
// hard-safety gate so that AVOID / SELL / LOW_TP / Very High Risk candidates
// never enter the actionable list and safe lower-ranked candidates backfill.

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  selectSafeTop5WithBackfill,
  candidatePassesPublicTelegramSafetyGate,
  candidatePassesMinUpside
} = sectorHot.__test;

const JAKARTA_TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function safeCandidate(overrides) {
  return Object.assign({
    ticker: 'SAFE', category: 'Swing Konglo', price_date: JAKARTA_TODAY,
    status: 'TRADE_CANDIDATE', final_status: 'TRADE_CANDIDATE',
    score: 88, daily_score: 88, daytrade_score: 88, combined_score: 88, risk_reward: 2.5,
    entry1: 100, entry_low: 100, entry2: 101, entry_high: 101, sl: 95, stop_loss: 95,
    tp1: 115, tp1n: 115, tp2: 130, tp2n: 130, last_price: 100, lastn: 100,
    tp1_upside: 15, tp2_upside: 30, volume_ratio_20d: 1.3, value_today: 8e9, traded_value: 8e9,
    trading_plan_valid: true, plan_quality_status: 'VALID',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk', liquidity_label: 'Liquid',
    final_quality_pass: true, final_quality_status: 'passed',
    telegram_verdict: 'Final quality gate passed.'
  }, overrides || {});
}

function avoidCandidate(overrides) {
  return safeCandidate(Object.assign({
    ticker: 'AVOID', action_label: 'Hindari', signal_action: 'AVOID',
    risk_label: 'Very High Risk', risk_label_v2: 'Very High Risk',
    final_quality_pass: false, final_quality_status: 'failed',
    telegram_verdict: 'Hindari — setup tidak valid'
  }, overrides || {}));
}

// ---- Pure algorithm tests (isSafeFn as a simple predicate) ----

test('backfill: first five candidates excluded, next safe candidates are used', () => {
  var pool = [];
  for (var i = 0; i < 5; i++) pool.push({ ticker: 'BAD' + i, safe: false });
  for (var j = 0; j < 5; j++) pool.push({ ticker: 'OK' + j, safe: true });
  var result = selectSafeTop5WithBackfill(pool, function(c) { return c.safe; }, 5);
  assert.equal(result.selected.length, 5);
  assert.deepEqual(result.selected.map(function(c) { return c.ticker; }), ['OK0', 'OK1', 'OK2', 'OK3', 'OK4']);
  // The excluded (unsafe) candidates are reported and never actionable.
  assert.equal(result.excluded.length, 5);
  assert.ok(result.selected.every(function(c) { return c.safe === true; }));
});

test('backfill: excluded candidates never become actionable', () => {
  var pool = [
    { ticker: 'A', safe: true }, { ticker: 'B', safe: false },
    { ticker: 'C', safe: true }, { ticker: 'D', safe: false },
    { ticker: 'E', safe: true }, { ticker: 'F', safe: false },
    { ticker: 'G', safe: true }, { ticker: 'H', safe: true }
  ];
  var result = selectSafeTop5WithBackfill(pool, function(c) { return c.safe; }, 5);
  assert.deepEqual(result.selected.map(function(c) { return c.ticker; }), ['A', 'C', 'E', 'G', 'H']);
  assert.ok(result.selected.every(function(c) { return c.safe === true; }));
  assert.ok(result.excluded.every(function(c) { return c.safe === false; }));
});

test('backfill: fewer than five safe candidates are reported accurately', () => {
  var pool = [
    { ticker: 'A', safe: true }, { ticker: 'B', safe: false },
    { ticker: 'C', safe: true }, { ticker: 'D', safe: false },
    { ticker: 'E', safe: true }
  ];
  var result = selectSafeTop5WithBackfill(pool, function(c) { return c.safe; }, 5);
  assert.equal(result.selected.length, 3);
  assert.deepEqual(result.selected.map(function(c) { return c.ticker; }), ['A', 'C', 'E']);
});

test('backfill: zero safe candidates remains a valid empty result', () => {
  var pool = [{ ticker: 'A', safe: false }, { ticker: 'B', safe: false }];
  var result = selectSafeTop5WithBackfill(pool, function(c) { return c.safe; }, 5);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded.length, 2);
});

test('backfill: caps selected at the limit and preserves rank order', () => {
  var pool = [];
  for (var i = 0; i < 8; i++) pool.push({ ticker: 'T' + i, safe: true });
  var result = selectSafeTop5WithBackfill(pool, function() { return true; }, 5);
  assert.equal(result.selected.length, 5);
  assert.deepEqual(result.selected.map(function(c) { return c.ticker; }), ['T0', 'T1', 'T2', 'T3', 'T4']);
});

test('backfill: de-duplicates by ticker', () => {
  var pool = [
    { ticker: 'A', safe: true }, { ticker: 'A', safe: true },
    { ticker: 'B', safe: true }
  ];
  var result = selectSafeTop5WithBackfill(pool, function(c) { return c.safe; }, 5);
  assert.deepEqual(result.selected.map(function(c) { return c.ticker; }), ['A', 'B']);
});

test('backfill: empty / invalid pool yields empty result', () => {
  assert.deepEqual(selectSafeTop5WithBackfill([], function() { return true; }, 5), { selected: [], excluded: [] });
  assert.deepEqual(selectSafeTop5WithBackfill(null, function() { return true; }, 5), { selected: [], excluded: [] });
});

// ---- Integration with the real hard-safety gate ----

test('backfill (real gate): AVOID/Very High Risk never actionable, safe lower-ranked backfill', () => {
  // Top-ranked candidates are all AVOID/Very High Risk; safe candidates are lower-ranked.
  var pool = [
    avoidCandidate({ ticker: 'AVO1' }),
    avoidCandidate({ ticker: 'AVO2' }),
    avoidCandidate({ ticker: 'AVO3' }),
    avoidCandidate({ ticker: 'AVO4' }),
    avoidCandidate({ ticker: 'AVO5' }),
    safeCandidate({ ticker: 'SAFE1' }),
    safeCandidate({ ticker: 'SAFE2' })
  ];
  var result = selectSafeTop5WithBackfill(pool, function(c) {
    return candidatePassesPublicTelegramSafetyGate(c, 'daily_top5') && candidatePassesMinUpside(c);
  }, 5);
  var tickers = result.selected.map(function(c) { return c.ticker; });
  assert.deepEqual(tickers, ['SAFE1', 'SAFE2']);
  assert.ok(!tickers.some(function(t) { return t.indexOf('AVO') === 0; }), 'no AVOID candidate is actionable');
  // Auto Monitor / persistence receives only these actionable (safe) candidates.
  assert.ok(result.selected.every(function(c) {
    return candidatePassesPublicTelegramSafetyGate(c, 'daily_top5') && candidatePassesMinUpside(c);
  }));
});

test('backfill (real gate): all-unsafe pool yields zero actionable candidates', () => {
  var pool = [avoidCandidate({ ticker: 'AVO1' }), avoidCandidate({ ticker: 'AVO2' })];
  var result = selectSafeTop5WithBackfill(pool, function(c) {
    return candidatePassesPublicTelegramSafetyGate(c, 'daily_top5') && candidatePassesMinUpside(c);
  }, 5);
  assert.equal(result.selected.length, 0);
});

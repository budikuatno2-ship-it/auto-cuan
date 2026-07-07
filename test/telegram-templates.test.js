'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const templates = require('../lib/telegram-templates');

function baseDayTrade(overrides) {
  return Object.assign({
    ticker: 'EXCL', status: 'READY_BREAKOUT', final_status: 'READY_BREAKOUT',
    daytrade_score: 78, risk_reward: 2.1,
    entry_low: 2870, entry_high: 2900,
    stop_loss: 2750, tp1: 3010, tp2: 3150,
    last_price: 2880, volume_ratio_20d: 1.6,
    value_today: 20100000000, tx_value_1d: 20100000000,
    avg_value_7d: 18000000000,
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    tf_1d_context: 'Green candle',
    tf_5d_context: 'Bullish',
    breakout_confirmation_label: 'Needs Close Confirmation',
    resistance: 3010,
    telegram_verdict: 'Pantau, tunggu konfirmasi.'
  }, overrides || {});
}

function baseSwing(overrides) {
  return Object.assign({
    ticker: 'BBRI', status: 'Swing Ready', final_status: 'Swing Ready',
    score: 82, risk_reward: 2.5,
    entry_low: 5000, entry_high: 5050,
    stop_loss: 4800, tp1: 5500, tp2: 5800,
    last_price: 5025, volume_ratio_20d: 1.3, volume_ratio_avg20: 1.3,
    value_today: 10000000000, tx_value_1d: 10000000000,
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    tf_1d_context: 'Bullish candle',
    tf_5d_context: 'Bullish (5D Approx)',
    telegram_verdict: 'Pantau, konfirmasi entry valid.'
  }, overrides || {});
}

// ============================================================
// TEST: Signal Card formatting
// ============================================================

test('T-TPL-01: formatSignalCard produces structured premium card', function() {
  var card = templates.formatSignalCard(baseDayTrade(), 1, 'daytrade');
  assert.match(card, /EXCL/);
  assert.match(card, /Signal: READY/);
  assert.match(card, /Trading Plan/);
  assert.match(card, /Entry:/);
  assert.match(card, /Take Profit:/);
  assert.match(card, /Stop Loss:/);
  assert.match(card, /Risk\/Reward:/);
  assert.match(card, /Technical Context/);
  assert.match(card, /Price:/);
  assert.match(card, /Volume:/);
  assert.match(card, /Value:/);
  assert.match(card, /Trend:/);
  assert.match(card, /Liquidity:/);
  assert.match(card, /Risk:/);
  assert.match(card, /Pattern \/ Setup/);
  assert.match(card, /Plan:/);
});

test('T-TPL-02: formatSignalCard does not contain undefined, null, [object Object]', function() {
  var card = templates.formatSignalCard(baseDayTrade({
    entry_quality_label: null, plan_quality_label: null,
    pattern_label: undefined, candle_pattern: null
  }), 1, 'daytrade');
  assert.doesNotMatch(card, /undefined/);
  assert.doesNotMatch(card, /\bnull\b/);
  assert.doesNotMatch(card, /\[object Object\]/);
});

test('T-TPL-03: formatSignalCard uses IDX flag emoji', function() {
  var card = templates.formatSignalCard(baseDayTrade(), 1, 'daytrade');
  assert.match(card, /\uD83C\uDDEE\uD83C\uDDE9/); // Indonesia flag emoji
});

test('T-TPL-03b: formatSignalCard shows TUNGGU PULLBACK warning when price above entry', function() {
  var card = templates.formatSignalCard(baseDayTrade({
    status: 'WAIT_PULLBACK',
    entry_distance_pct: 4.5
  }), 1, 'daytrade');
  assert.match(card, /Signal: TUNGGU PULLBACK/);
  assert.match(card, /Harga sudah di atas area entry/);
  assert.match(card, /Hindari chase/);
  assert.match(card, /tunggu pullback/);
});

test('T-TPL-03c: formatSignalCard shows ENTRY ZONE when price in entry area', function() {
  var card = templates.formatSignalCard(baseDayTrade({
    status: 'READY_BREAKOUT',
    entry_status: 'IN_ENTRY_AREA',
    entry_distance_pct: 0.5
  }), 1, 'daytrade');
  assert.match(card, /Signal: ENTRY ZONE/);
  assert.doesNotMatch(card, /Hindari chase/);
});

test('T-TPL-03d: formatSignalCard shows distance from entry in Indonesian', function() {
  var card = templates.formatSignalCard(baseDayTrade({
    entry_distance_pct: 2.3,
    last_price: 2950
  }), 1, 'daytrade');
  assert.match(card, /Jarak dari entry:/);
  assert.match(card, /\+2\.3%/);
});

// ============================================================
// TEST: Full message formatters
// ============================================================

test('T-TPL-04: formatDayTradeSignalMessage produces clean header + cards + disclaimer', function() {
  var msg = templates.formatDayTradeSignalMessage([baseDayTrade(), baseDayTrade({ ticker: 'TLKM' })]);
  assert.match(msg, /AUTO-CUAN IDX DAY TRADE SIGNAL/);
  assert.match(msg, /Update:/);
  assert.match(msg, /EXCL/);
  assert.match(msg, /TLKM/);
  assert.match(msg, /Bukan rekomendasi beli\/jual/);
  // Does not depend on AI
  assert.doesNotMatch(msg, /Gemini/i);
  assert.doesNotMatch(msg, /AI narration/i);
});

test('T-TPL-05: formatSwingKongloSignalMessage has correct header', function() {
  var msg = templates.formatSwingKongloSignalMessage([baseSwing()]);
  assert.match(msg, /AUTO-CUAN IDX SWING KONGLO SIGNAL/);
  assert.match(msg, /BBRI/);
  assert.match(msg, /Bukan rekomendasi beli\/jual/);
});

test('T-TPL-06: formatSwingNonKongloSignalMessage has correct header', function() {
  var msg = templates.formatSwingNonKongloSignalMessage([baseSwing({ ticker: 'ACES', status: 'Swing Ready' })]);
  assert.match(msg, /AUTO-CUAN IDX SWING NON-KONGLO SIGNAL/);
  assert.match(msg, /ACES/);
});

test('T-TPL-07: formatDailyTop5Message works in normal and watchlist mode', function() {
  var msg = templates.formatDailyTop5Message([baseSwing()], '2026-07-06');
  assert.match(msg, /AUTO-CUAN SAHAM PILIHAN/);
  assert.match(msg, /2026-07-06/);
  assert.doesNotMatch(msg, /WATCHLIST/);

  var watchMsg = templates.formatDailyTop5Message([baseSwing()], '2026-07-06', { watchlistMode: true });
  assert.match(watchMsg, /WATCHLIST/);
  assert.match(watchMsg, /Bukan sinyal entry langsung/);
});

// ============================================================
// TEST: Monitor Hit message
// ============================================================

test('T-TPL-08: formatMonitorHitMessage TP1 HIT produces short premium format', function() {
  var pick = { ticker: 'KOBX', entry1: 176, tp1: 192, tp2: 210, sl: 160 };
  var ev = { status: 'TP1_HIT', label: 'TP1 Hit', note: 'TP1 tersentuh' };
  var px = { last: 198 };
  var msg = templates.formatMonitorHitMessage(pick, ev, px);
  assert.match(msg, /TARGET HIT/);
  assert.match(msg, /KOBX/);
  assert.match(msg, /TP1 HIT/);
  assert.match(msg, /Entry:/);
  assert.match(msg, /Harga sekarang:/);
  assert.match(msg, /Profit:/);
  assert.match(msg, /Catatan:/);
  // Short format — should be under 500 chars
  assert.ok(msg.length < 500, 'Monitor hit should be short, got ' + msg.length + ' chars');
});

test('T-TPL-09: formatMonitorHitMessage SL HIT shows loss', function() {
  var pick = { ticker: 'EXCL', entry1: 2900, tp1: 3010, tp2: 3150, sl: 2750 };
  var ev = { status: 'SL_HIT', label: 'SL kena', note: 'SL tersentuh' };
  var px = { last: 2740 };
  var msg = templates.formatMonitorHitMessage(pick, ev, px);
  assert.match(msg, /SL HIT/);
  assert.match(msg, /Loss:/);
  assert.match(msg, /Stop loss tersentuh/);
});

test('T-TPL-10: formatMonitorHitMessage ENTRY ZONE', function() {
  var pick = { ticker: 'BBRI', entry1: 5000, tp1: 5500, tp2: 5800, sl: 4800 };
  var ev = { status: 'IN_ENTRY_ZONE', label: 'In Entry Zone', note: 'Harga memasuki area entry' };
  var px = { last: 5010 };
  var msg = templates.formatMonitorHitMessage(pick, ev, px);
  assert.match(msg, /ENTRY ZONE/);
  assert.match(msg, /area entry/);
});

// ============================================================
// TEST: Radar Digest
// ============================================================

test('T-TPL-11: formatRadarDigestMessage produces radar format', function() {
  var msg = templates.formatRadarDigestMessage([baseDayTrade()], 'Day Trade Radar');
  assert.match(msg, /RADAR.*BUKAN SINYAL ENTRY/);
  assert.match(msg, /EXCL/);
  assert.match(msg, /Pantauan, bukan sinyal entry/);
});

// ============================================================
// TEST: Helpers
// ============================================================

test('T-TPL-12: fmtPrice formats Indonesian Rupiah', function() {
  assert.equal(templates.fmtPrice(2900), 'Rp2.900');
  assert.equal(templates.fmtPrice(null), '-');
  assert.equal(templates.fmtPrice(0), '-');
});

test('T-TPL-13: fmtValue formats large values', function() {
  assert.match(templates.fmtValue(20100000000), /Rp20,1 M/);
  assert.match(templates.fmtValue(1500000000000), /T/);
  assert.equal(templates.fmtValue(0), '-');
});

test('T-TPL-14: classifySignalLabel returns correct labels based on status AND entry position', function() {
  // High conviction setups
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT' }), 'READY');
  assert.equal(templates.classifySignalLabel({ status: 'A_PLUS_SETUP' }), 'READY');
  assert.equal(templates.classifySignalLabel({ status: 'TRADE_CANDIDATE' }), 'READY');
  assert.equal(templates.classifySignalLabel({ status: 'Swing Ready' }), 'READY');

  // Early detection
  assert.equal(templates.classifySignalLabel({ status: 'EARLY_RADAR' }), 'EARLY RADAR');
  assert.equal(templates.classifySignalLabel({ status: 'PRE_SPIKE_WATCH' }), 'EARLY RADAR');

  // Wait pullback - should NOT be collapsed to WATCHLIST
  assert.equal(templates.classifySignalLabel({ status: 'WAIT_PULLBACK' }), 'TUNGGU PULLBACK');

  // Entry zone detection via entry_status
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'IN_ENTRY_AREA' }), 'ENTRY ZONE');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'In Entry Area' }), 'ENTRY ZONE');

  // Chase risk detection via entry_status
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'CHASE_RISK' }), 'TUNGGU PULLBACK');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'EXTENDED' }), 'TUNGGU PULLBACK');

  // Chase risk detection via entry_distance_pct (> 3%)
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_distance_pct: 3.5 }), 'TUNGGU PULLBACK');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_distance_pct: 5.2 }), 'TUNGGU PULLBACK');

  // Mild chase risk (> 2%) for READY status should show pullback
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_distance_pct: 2.5 }), 'TUNGGU PULLBACK');

  // No chase risk when entry_distance_pct is low
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_distance_pct: 1.0 }), 'READY');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_distance_pct: -0.5 }), 'READY');

  // TP/SL hit detection
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'TP1_HIT' }), 'TP1 HIT');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'TP2_HIT' }), 'TP2 HIT');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'INVALID_BELOW_SL' }), 'SL HIT / INVALIDATED');

  // Avoid / skip
  assert.equal(templates.classifySignalLabel({ status: 'AVOID' }), 'AVOID / SKIP');

  // Watchlist / needs confirmation
  assert.equal(templates.classifySignalLabel({ status: 'WATCHLIST' }), 'WATCHLIST');
  assert.equal(templates.classifySignalLabel({ status: 'SPECULATIVE' }), 'WATCHLIST');
  assert.equal(templates.classifySignalLabel({ status: 'REBOUND_CANDIDATE' }), 'WATCHLIST');
});

// ============================================================
// TEST: Status Precedence Rules
// ============================================================

test('T-TPL-17: Terminal statuses are never overridden by entry_distance_pct', function() {
  // TP1_HIT with entry_distance_pct > 3 still returns TP1 HIT
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'TP1_HIT', entry_distance_pct: 5.0 }), 'TP1 HIT');
  assert.equal(templates.classifySignalLabel({ status: 'TP1_HIT', entry_distance_pct: 7.5 }), 'TP1 HIT');

  // TP2_HIT with entry_distance_pct > 3 still returns TP2 HIT
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'TP2_HIT', entry_distance_pct: 8.0 }), 'TP2 HIT');
  assert.equal(templates.classifySignalLabel({ status: 'TP2_HIT', entry_distance_pct: 10.0 }), 'TP2 HIT');

  // SL HIT / INVALIDATED never overridden
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'INVALID_BELOW_SL', entry_distance_pct: 6.0 }), 'SL HIT / INVALIDATED');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'SL_HIT', entry_distance_pct: 15.0 }), 'SL HIT / INVALIDATED');
});

test('T-TPL-18: Monitor active statuses are never overridden by TUNGGU PULLBACK', function() {
  // ENTRY_HIT with entry_distance_pct > 3 still returns ENTRY HIT
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'ENTRY_HIT', entry_distance_pct: 4.5 }), 'ENTRY HIT');
  assert.equal(templates.classifySignalLabel({ status: 'ENTRY_HIT', entry_distance_pct: 6.0 }), 'ENTRY HIT');

  // RUNNING with entry_distance_pct > 3 still returns RUNNING
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'RUNNING', entry_distance_pct: 5.0 }), 'RUNNING');
  assert.equal(templates.classifySignalLabel({ status: 'RUNNING', entry_distance_pct: 7.5 }), 'RUNNING');
});

test('T-TPL-19: TUNGGU PULLBACK only applies BEFORE entry', function() {
  // IN_ENTRY_AREA is ENTRY ZONE, not TUNGGU PULLBACK
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'IN_ENTRY_AREA', entry_distance_pct: 0.5 }), 'ENTRY ZONE');

  // WAIT_PULLBACK/EXTENDED before entry returns TUNGGU PULLBACK
  assert.equal(templates.classifySignalLabel({ status: 'WAIT_PULLBACK', entry_distance_pct: 4.0 }), 'TUNGGU PULLBACK');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'EXTENDED', entry_distance_pct: 5.5 }), 'TUNGGU PULLBACK');
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_status: 'CHASE_RISK', entry_distance_pct: 6.0 }), 'TUNGGU PULLBACK');

  // entry_distance_pct > 3 before entry returns TUNGGU PULLBACK
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT', entry_distance_pct: 4.5 }), 'TUNGGU PULLBACK');
  assert.equal(templates.classifySignalLabel({ status: 'A_PLUS_SETUP', entry_distance_pct: 5.0 }), 'TUNGGU PULLBACK');
});

test('T-TPL-20: formatSignalCard uses Indonesian label for distance', function() {
  var card = templates.formatSignalCard(baseDayTrade({
    entry_distance_pct: 2.3,
    last_price: 2950
  }), 1, 'daytrade');
  assert.match(card, /Jarak dari entry:/);
  assert.match(card, /\+2\.3%/);
});

test('T-TPL-15: getRiskShort normalizes risk labels', function() {
  assert.equal(templates.getRiskShort({ risk_label_v2: 'Very High Risk' }), 'Very High');
  assert.equal(templates.getRiskShort({ risk_label_v2: 'Medium Risk' }), 'Medium');
  assert.equal(templates.getRiskShort({ risk_label_v2: 'Low Risk' }), 'Low');
  assert.equal(templates.getRiskShort({}), 'Medium');
});

test('T-TPL-16: Template does not depend on AI — no AI-related text in output', function() {
  var msg = templates.formatDayTradeSignalMessage([baseDayTrade()]);
  assert.doesNotMatch(msg, /AI/i);
  assert.doesNotMatch(msg, /Gemini/i);
  assert.doesNotMatch(msg, /narration/i);
});

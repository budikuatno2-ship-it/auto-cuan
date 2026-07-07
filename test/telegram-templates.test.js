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
  assert.match(msg, /lolos gate: 1\/5/);
  assert.doesNotMatch(msg, /WATCHLIST/);

  var watchMsg = templates.formatDailyTop5Message([baseSwing()], '2026-07-06', { watchlistMode: true });
  assert.match(watchMsg, /Top 5 Watchlist/);
  assert.match(watchMsg, /lolos gate: 1\/5/);
  assert.match(watchMsg, /Bukan sinyal entry langsung/);
});

test('T-TPL-07b: formatDailyTop5Message shows correct lolos gate count', function() {
  // Test with 3 picks
  var msg3 = templates.formatDailyTop5Message([baseSwing(), baseSwing(), baseSwing()], '2026-07-06', { pickedCount: 3 });
  assert.match(msg3, /lolos gate: 3\/5/);

  // Test with 5 picks
  var msg5 = templates.formatDailyTop5Message([baseSwing(), baseSwing(), baseSwing(), baseSwing(), baseSwing()], '2026-07-06', { pickedCount: 5 });
  assert.match(msg5, /lolos gate: 5\/5/);

  // Test with 1 pick (the edge case from the requirement)
  var msg1 = templates.formatDailyTop5Message([baseSwing()], '2026-07-06', { pickedCount: 1 });
  assert.match(msg1, /lolos gate: 1\/5/);

  // Watchlist mode with explicit pickedCount
  var watchMsg3 = templates.formatDailyTop5Message([baseSwing()], '2026-07-06', { watchlistMode: true, pickedCount: 3 });
  assert.match(watchMsg3, /Top 5 Watchlist — lolos gate: 3\/5/);
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

test('T-TPL-14: classifySignalLabel returns correct labels', function() {
  assert.equal(templates.classifySignalLabel({ status: 'READY_BREAKOUT' }), 'READY');
  assert.equal(templates.classifySignalLabel({ status: 'A_PLUS_SETUP' }), 'READY');
  assert.equal(templates.classifySignalLabel({ status: 'EARLY_RADAR' }), 'EARLY RADAR');
  assert.equal(templates.classifySignalLabel({ status: 'WAIT_PULLBACK' }), 'WATCHLIST');
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

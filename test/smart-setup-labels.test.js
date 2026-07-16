'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const smart = require('../lib/smart-setup-labels');

function candles(count, overrides) {
  return Array.from({ length: count }, function(_, i) {
    var close = 100 + i * 0.2;
    return Object.assign({ open: close - 0.4, high: close + 1.5, low: close - 1.5, close: close, volume: 1000 }, overrides && overrides(i, close));
  });
}
function types(result) { return result.smart_setup_labels.map(function(item) { return item.setup_type; }); }

test('detects VCP Setup for a tight consolidation in an uptrend', function() {
  var cs = candles(20, function(i, close) { return i < 10 ? { high: close + 4, low: close - 4, volume: 1200 } : { high: close + 0.7, low: close - 0.7, volume: 700 }; });
  var result = smart.detectSmartSetupLabels({ last_price: 104, ma20: 103, ma60: 98, rsi14: 55, avg_tx_value_7d: 500000000 }, cs);
  assert.ok(types(result).includes('VCP'));
});

test('detects Trend Template for positive long MA alignment', function() {
  var result = smart.detectSmartSetupLabels({ last_price: 130, ma50: 120, ma150: 110, ma200: 100, rsi14: 60 }, []);
  assert.ok(types(result).includes('STAGE_2_TREND'));
});

test('detects Smart Money before Rally from a strong-volume MA reclaim', function() {
  var cs = candles(20, function(i, close) { return i === 19 ? { open: 103, close: 105, high: 106, low: 102, volume: 2500 } : {}; });
  var result = smart.detectSmartSetupLabels({ last_price: 105, ma20: 103, rsi14: 58, avg_volume_20d: 1000 }, cs);
  assert.ok(types(result).includes('SMART_MONEY'));
});

test('detects an Uptrend Pullback with valid risk reward', function() {
  var result = smart.detectSmartSetupLabels({ last_price: 101, ma20: 100, ma50: 95, rsi14: 50, risk_reward: 1.8, avg_tx_value_7d: 500000000 }, []);
  assert.ok(types(result).includes('UPTREND_PULLBACK'));
});

test('detects Bullish Harami+ candle reversal', function() {
  var cs = candles(20, function(i) { return i === 18 ? { open: 108, close: 100, high: 109, low: 99, volume: 1000 } : (i === 19 ? { open: 101, close: 105, high: 106, low: 100, volume: 1000 } : {}); });
  var result = smart.detectSmartSetupLabels({ last_price: 105, rsi14: 52, avg_volume_20d: 1000 }, cs);
  assert.ok(types(result).includes('BULLISH_HARAMI_PLUS'));
});

test('price 50 remains radar context with adequate liquidity', function() {
  var row = smart.applySmartSetupLabels({ last_price: 50, ma20: 50, ma50: 45, risk_reward: 2, rsi14: 50, avg_tx_value_7d: 500000000 });
  assert.equal(row.smart_setup_score_bonus > 0, true);
  assert.ok(row.smart_setup_diagnostics.includes('price_near_50_requires_stronger_liquidity_confirmation'));
});

test('price under 50 is downgraded and FCA or special-watch rows are not setup-actionable', function() {
  var cheap = smart.applySmartSetupLabels({ last_price: 49, ma20: 49, ma50: 45, risk_reward: 2, rsi14: 50 });
  var fca = smart.applySmartSetupLabels({ last_price: 100, board_status: 'FCA special watch', ma20: 100, ma50: 95, risk_reward: 2, rsi14: 50 });
  assert.equal(cheap.smart_setup_score_bonus, 0);
  assert.ok(cheap.smart_setup_diagnostics.includes('price_below_50_downgraded'));
  assert.equal(fca.smart_setup_score_bonus, 0);
  assert.match(fca.smart_setup_diagnostics.join(' '), /board_or_status_blocked/);
});

test('setup bonus cannot bypass safety gates', function() {
  ['AVOID', 'Hindari', 'Very High Risk', 'STALE_LEVEL', 'NEEDS_REVALIDATION', 'HISTORY_INSUFFICIENT', 'NEW_LISTING'].forEach(function(status) {
    var row = smart.applySmartSetupLabels({ status: status, last_price: 100, ma20: 100, ma50: 95, risk_reward: 2, rsi14: 50, corporate_action_guard: status === 'AVOID' ? 'BLOCKED' : 'PASSED' });
    assert.equal(row.smart_setup_score_bonus, 0, status);
  });
});

test('foreign net sell commentary remains analytical context, while structured SELL is fatal', function() {
  var valid = smart.applySmartSetupLabels({
    last_price: 100, ma20: 100, ma50: 95, risk_reward: 2, rsi14: 50,
    foreign_notes: 'foreign net sell remains a contextual flow observation'
  });
  var sellAction = smart.applySmartSetupLabels({
    last_price: 100, ma20: 100, ma50: 95, risk_reward: 2, rsi14: 50,
    foreign_notes: 'foreign net sell', action_label: 'SELL'
  });
  var sellStatus = smart.applySmartSetupLabels({ last_price: 100, ma20: 100, ma50: 95, risk_reward: 2, rsi14: 50, status: 'SELL' });
  assert.equal(valid.setup_type, 'UPTREND_PULLBACK');
  assert.equal(valid.smart_setup_score_bonus > 0, true);
  assert.equal(sellAction.smart_setup_score_bonus, 0);
  assert.equal(sellStatus.smart_setup_score_bonus, 0);
});

test('missing candle and indicator fields do not crash', function() {
  assert.doesNotThrow(function() { smart.applySmartSetupLabels({ ticker: 'SAFE' }); });
  assert.equal(smart.MAX_SETUP_SCORE_BONUS, 3);
});

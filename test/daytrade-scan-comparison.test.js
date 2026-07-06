'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scanComp = require('../lib/daytrade-scan-comparison');

function makeScan(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    last_price: 5000,
    volume_ratio_20d: 1.2,
    value_today: 10000000000,
    avg_value_7d: 8000000000,
    entry_low: 4900,
    entry_high: 5000,
    tp1: 5500,
    tp2: 5800,
    stop_loss: 4700,
    resistance: 5500,
    status: 'READY_BREAKOUT',
    daytrade_score: 75,
    change_pct: 1.5,
    distance_to_breakout_pct: 3.0,
    risk_reward: 2.0
  }, overrides || {});
}

test('T-SC-01: First scan returns is_first_scan=true with score 0', function() {
  scanComp.clearBaselines();
  var result = scanComp.compareScan(makeScan(), null);
  assert.equal(result.is_first_scan, true);
  assert.equal(result.acceleration_score, 0);
  assert.equal(result.acceleration_label, 'First scan');
});

test('T-SC-02: compareAndStore stores baseline and returns result', function() {
  scanComp.clearBaselines();
  var first = scanComp.compareAndStore(makeScan());
  assert.equal(first.is_first_scan, true);
  assert.equal(scanComp.getBaselineCount(), 1);

  // Second scan with improved price toward entry
  var second = scanComp.compareAndStore(makeScan({ last_price: 4950 }));
  assert.equal(second.is_first_scan, false);
  assert.ok(second.acceleration_score >= 0, 'Should not be negative when price moves toward entry');
});

test('T-SC-03: Price improving toward entry gives positive score', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ last_price: 5200 }); // far above entry
  var current = makeScan({ last_price: 5020 }); // closer to entry
  scanComp.storeBaseline('BBRI', baseline);
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_score >= 1, 'Score should be positive: ' + result.acceleration_score);
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('entry') >= 0; }));
});

test('T-SC-04: Volume increasing meaningfully gives positive score', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ volume_ratio_20d: 0.8 });
  var current = makeScan({ volume_ratio_20d: 1.5 });
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_score >= 1, 'Volume increase should give positive score: ' + result.acceleration_score);
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('volume') >= 0; }));
});

test('T-SC-05: Volume spike but value tiny gives negative signal', function() {
  scanComp.clearBaselines();
  // prevVol = 2.3, curVol = 2.5 → increase is only 0.2 (< 0.3 threshold)
  // But curVol >= 2.0 and value < 500M → triggers tiny warning
  var baseline = makeScan({ volume_ratio_20d: 2.3, value_today: 300000000 });
  var current = makeScan({ volume_ratio_20d: 2.5, value_today: 300000000 });
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('tiny') >= 0; }), 'Expected tiny value warning, got: ' + result.acceleration_factors.join(', '));
});

test('T-SC-06: Approaching breakout gives positive score', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ distance_to_breakout_pct: 5.0 });
  var current = makeScan({ distance_to_breakout_pct: 1.5 });
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_score >= 1, 'Approaching breakout should be positive');
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('breakout') >= 0; }));
});

test('T-SC-07: Too far above entry gives negative score', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ last_price: 5000 });
  var current = makeScan({ last_price: 5400, entry_high: 5000 }); // 8% above entry
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('chase') >= 0 || f.indexOf('far above') >= 0; }));
});

test('T-SC-08: Near TP with poor remaining RR gives negative', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ last_price: 5000 });
  var current = makeScan({ last_price: 5450, tp1: 5500, stop_loss: 4700 }); // close to TP, far from SL
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('TP') >= 0 || f.indexOf('poor') >= 0; }));
});

test('T-SC-09: Score is clamped between -10 and +15', function() {
  scanComp.clearBaselines();
  // Create a scenario with all positive signals
  var baseline = makeScan({
    last_price: 5200,
    volume_ratio_20d: 0.7,
    distance_to_breakout_pct: 6.0,
    daytrade_score: 60
  });
  var current = makeScan({
    last_price: 4950,
    volume_ratio_20d: 1.8,
    value_today: 15000000000,
    distance_to_breakout_pct: 1.0,
    daytrade_score: 85
  });
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_score <= 15, 'Max score should be 15, got: ' + result.acceleration_score);
  assert.ok(result.acceleration_score >= -10, 'Min score should be -10, got: ' + result.acceleration_score);
});

test('T-SC-10: Stale baseline reduces score reliability', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ last_price: 5200, volume_ratio_20d: 0.7 });
  baseline.timestamp = Date.now() - (2 * 60 * 60 * 1000); // 2 hours ago
  scanComp.storeBaseline('BBRI', baseline);
  // Override the stored timestamp to simulate staleness
  scanComp.getBaseline('BBRI').timestamp = baseline.timestamp;

  var current = makeScan({ last_price: 4950, volume_ratio_20d: 1.5 });
  var result = scanComp.compareScan(current, scanComp.getBaseline('BBRI'));
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('stale') >= 0; }));
});

test('T-SC-11: clearBaselines resets store', function() {
  scanComp.storeBaseline('TEST', makeScan({ ticker: 'TEST' }));
  assert.ok(scanComp.getBaselineCount() >= 1);
  scanComp.clearBaselines();
  assert.equal(scanComp.getBaselineCount(), 0);
  assert.equal(scanComp.getBaseline('TEST'), null);
});

test('T-SC-12: exportBaselines and importBaselines round-trip', function() {
  scanComp.clearBaselines();
  scanComp.storeBaseline('BBCA', makeScan({ ticker: 'BBCA', last_price: 9000 }));
  scanComp.storeBaseline('TLKM', makeScan({ ticker: 'TLKM', last_price: 3500 }));
  var exported = scanComp.exportBaselines();
  assert.ok(exported.BBCA);
  assert.ok(exported.TLKM);
  assert.equal(exported.BBCA.last_price, 9000);

  scanComp.clearBaselines();
  scanComp.importBaselines(exported);
  assert.equal(scanComp.getBaselineCount(), 2);
  assert.equal(scanComp.getBaseline('BBCA').last_price, 9000);
});

test('T-SC-13: Comparison is positive signal not hard blocker (score range allows neutral)', function() {
  scanComp.clearBaselines();
  // Even worst case doesn't block — just gives negative advisory
  var baseline = makeScan({ last_price: 5000 });
  var current = makeScan({ last_price: 5500, volume_ratio_20d: 2.5, value_today: 300000000, distance_to_breakout_pct: 0.5 });
  var result = scanComp.compareScan(current, baseline);
  // Score is bounded, not a gate
  assert.ok(result.acceleration_score >= -10, 'Minimum should be -10');
  assert.ok(typeof result.acceleration_label === 'string');
});

test('T-SC-14: Entry zone touched gives positive signal', function() {
  scanComp.clearBaselines();
  var baseline = makeScan({ last_price: 5200 });
  var current = makeScan({ last_price: 4950, entry_low: 4900, entry_high: 5000 }); // in entry zone
  var result = scanComp.compareScan(current, baseline);
  assert.ok(result.acceleration_factors.some(function(f) { return f.indexOf('entry zone') >= 0; }));
});

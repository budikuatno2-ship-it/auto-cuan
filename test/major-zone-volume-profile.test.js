'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/daytrade-screener-engine');

function makeCandles(count, overridesByIndex) {
  overridesByIndex = overridesByIndex || {};
  var candles = [];
  for (var i = 0; i < count; i++) {
    var base = 100 + Math.sin(i / 4) * 2;
    var c = {
      open: base,
      high: base + 4,
      low: base - 1,
      close: base + 1,
      volume: 1000000
    };
    if (overridesByIndex[i]) Object.assign(c, overridesByIndex[i]);
    candles.push(c);
  }
  return candles;
}

test('90D major demand respected by lower wick + close recovery', () => {
  var o = {};
  [8, 40, 84].forEach(function(i) {
    o[i] = { open: 101, high: 106, low: 95, close: 103, volume: 1400000 };
  });
  var candles = makeCandles(90, o);
  var ctx = engine.detectMajorRespectZoneContext(candles, 103);
  assert.equal(ctx.major_demand_level, 95);
  assert.equal(ctx.major_demand.window, '90D');
  assert.equal(ctx.major_demand.touches >= 3, true);
  assert.equal(ctx.major_demand.recoveries >= 1, true);
  assert.equal(ctx.major_demand.valid_context, true);
  assert.match(ctx.major_respect_zone_notes, /Major demand 90D/);
});

test('90D major supply rejected by upper wick + weak close', () => {
  var o = {};
  [10, 50, 86].forEach(function(i) {
    o[i] = { open: 111, high: 120, low: 108, close: 112, volume: 1300000 };
  });
  var candles = makeCandles(90, o);
  var ctx = engine.detectMajorRespectZoneContext(candles, 112);
  assert.equal(ctx.major_supply_level, 120);
  assert.equal(ctx.major_supply.window, '90D');
  assert.equal(ctx.major_supply.failed_closes >= 3, true);
  assert.equal(ctx.major_supply.upper_rejections >= 1, true);
  assert.equal(ctx.major_supply.active_warning, true);
  assert.match(ctx.major_respect_zone_notes, /Major supply 90D/);
});

test('old 90D zone without fresh retest does not boost demand context', () => {
  var o = {};
  [5, 20, 35].forEach(function(i) {
    o[i] = { open: 101, high: 106, low: 95, close: 103, volume: 1300000 };
  });
  var candles = makeCandles(90, o);
  var ctx = engine.detectMajorRespectZoneContext(candles, 103);
  assert.equal(ctx.major_demand_level, 95);
  assert.equal(ctx.major_demand.fresh_retest, false);
  assert.equal(ctx.major_demand.valid_context, false);
  assert.match(ctx.major_demand.note, /old\/no fresh retest/);
});

test('weak volume keeps major respect weak/invalid', () => {
  var o = {};
  [8, 42, 85].forEach(function(i) {
    o[i] = { open: 101, high: 106, low: 95, close: 103, volume: 100000 };
  });
  var candles = makeCandles(90, o);
  var ctx = engine.detectMajorRespectZoneContext(candles, 103);
  assert.equal(ctx.major_demand_level, 95);
  assert.equal(ctx.major_demand.weak_volume_touches >= 3, true);
  assert.equal(ctx.major_demand.valid_context, false);
  assert.match(ctx.major_demand.note, /weak volume reduces quality/);
});

test('volume profile PoC is context only and not a standalone buy signal', () => {
  var candles = makeCandles(90, {});
  for (var i = 20; i < 40; i++) {
    candles[i] = { open: 109, high: 112, low: 108, close: 110, volume: 8000000 };
  }
  var poc = engine.detectVolumeProfilePoc(candles, 110);
  assert.ok(poc.volume_profile_poc >= 108 && poc.volume_profile_poc <= 112);
  assert.match(poc.note, /Context only, bukan sinyal beli/);
  var data = engine.analyzeDayTrade(candles, 'TEST');
  var scored = engine.scoreDayTrade(data, 'MORNING_SCOUT', 'UTAMA', null);
  assert.notEqual(scored.status, 'A_PLUS_SETUP');
  assert.ok(!Object.prototype.hasOwnProperty.call(scored, 'volume_profile_poc'), 'scoreDayTrade alone does not use PoC as a buy signal');
  assert.equal(Object.prototype.hasOwnProperty.call(scored, 'daytrade_evaluation_initial'), false);
  var captured = engine.scoreDayTrade(data, 'MORNING_SCOUT', 'UTAMA', null, { captureEvaluationInitial: true });
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'daytrade_evaluation_initial'), true);
  assert.equal(captured.status, scored.status);
  assert.equal(captured.daytrade_score, scored.daytrade_score);
});

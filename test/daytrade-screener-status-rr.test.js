'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const engine = require('../lib/daytrade-screener-engine');
const { MIN_RR_RATIO } = require('../lib/screener-config');

// Priority/entry statuses that must NEVER be reachable when R/R < MIN_RR_RATIO.
const PRIORITY_STATUSES = new Set([
  'A_PLUS_SETUP',
  'TRADE_CANDIDATE',
  'READY_BREAKOUT',
  'PRE_SPIKE_WATCH',
  'EARLY_RADAR',
  'MOMENTUM_CONTINUATION',
  'RECLAIM_CANDIDATE'
]);

function makeData(overrides) {
  return Object.assign({
    change_pct: 2.0,
    volume_ratio_20d: 2.0,
    _priceAboveOpen: true,
    _priceNearHigh: true,
    range_position: 75,
    distance_to_breakout_pct: 1.0,
    rsi14: 60,
    ma20: 1000,
    last_price: 1010
  }, overrides || {});
}

function makeLevels(rr, overrides) {
  return Object.assign({
    entry_low: 1000,
    entry_high: 1010,
    stop_loss: 980,
    tp1: 1050,
    tp2: 1080,
    risk_reward: rr,
    _riskDistPct: 2.0
  }, overrides || {});
}

const liqPass = { pass: true, score: 20 };
const penaltyNone = { penalty: 0, reasons: [] };

test('classifyStatus: SSMS incident case (R/R 1.0x) is rejected from priority/entry statuses', () => {
  // High score + strong volume would previously leak into MOMENTUM_CONTINUATION.
  const result = engine.classifyStatus(
    90, makeData(), makeLevels(1.0), liqPass, penaltyNone, 'UTAMA', 'MORNING_SCOUT', false
  );
  assert.equal(PRIORITY_STATUSES.has(result.status), false,
    'R/R 1.0x must not reach a priority/entry status, got: ' + result.status);
  assert.equal(result.status, 'WAIT_PULLBACK');
  assert.match(result.notes, /Risk:Reward/);
});

test('classifyStatus: sub-threshold R/R (1.2x, 1.49x) blocked from priority/entry statuses', () => {
  for (const rr of [1.2, 1.49]) {
    const result = engine.classifyStatus(
      90, makeData(), makeLevels(rr), liqPass, penaltyNone, 'UTAMA', 'MORNING_SCOUT', false
    );
    assert.equal(PRIORITY_STATUSES.has(result.status), false,
      'R/R ' + rr + 'x must not reach a priority/entry status, got: ' + result.status);
    assert.equal(result.status, 'WAIT_PULLBACK');
  }
});

test('classifyStatus: R/R >= MIN_RR_RATIO (1.5x) still passes when technical criteria met', () => {
  const result = engine.classifyStatus(
    90, makeData(), makeLevels(MIN_RR_RATIO), liqPass, penaltyNone, 'UTAMA', 'MORNING_SCOUT', false
  );
  assert.equal(PRIORITY_STATUSES.has(result.status), true,
    'R/R 1.5x with strong technicals must reach a priority/entry status, got: ' + result.status);
});

test('classifyStatus: ideal R/R (2.5x) reaches A_PLUS_SETUP', () => {
  const result = engine.classifyStatus(
    92, makeData({ range_position: 80 }), makeLevels(2.5), liqPass, penaltyNone, 'UTAMA', 'MORNING_SCOUT', false
  );
  assert.equal(result.status, 'A_PLUS_SETUP');
});

test('classifyStatus: missing/invalid R/R is treated as failing the gate', () => {
  for (const rr of [undefined, null, 0, -1, NaN]) {
    const result = engine.classifyStatus(
      90, makeData(), makeLevels(rr), liqPass, penaltyNone, 'UTAMA', 'MORNING_SCOUT', false
    );
    assert.equal(PRIORITY_STATUSES.has(result.status), false,
      'invalid R/R (' + String(rr) + ') must not reach a priority/entry status, got: ' + result.status);
  }
});
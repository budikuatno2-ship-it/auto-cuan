'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/daytrade-screener-engine');

function baseParams(compositeScore, dataOverrides) {
  const data = Object.assign({
    ticker: 'AUTO',
    change_pct: 2.0,
    volume_ratio_20d: 1.5,
    distance_to_breakout_pct: 2.0,
    _priceAboveOpen: true,
    _overextendedMA20: false,
    rsi14: 55
  }, dataOverrides || {});

  const levels = {
    risk_reward: 2.0,
    _riskDistPct: 2.5
  };
  const liqResult = { pass: true };
  const penaltyResult = { penalty: 0 };
  const board = 'REGULER';
  const runMode = 'NORMAL';
  const candleDowngrade = false;

  return { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade };
}

test('BUG-026: compositeScore 70-74 with volume >= 1.2 qualifies for PRE_SPIKE_WATCH, not downgraded to EARLY_RADAR', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseParams(72);
  const result = engine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);

  // Before fix: EARLY_RADAR branch (score >= 62) was checked before PRE_SPIKE_WATCH (score >= 70),
  // causing score 70-74 candidates with distance <= 5% to be prematurely captured as EARLY_RADAR.
  // After fix: PRE_SPIKE_WATCH is checked first, correctly granting the higher-tier status.
  assert.equal(result.status, 'PRE_SPIKE_WATCH');
});

test('BUG-026: compositeScore 63-69 still qualifies for EARLY_RADAR', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseParams(64);
  const result = engine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);

  assert.equal(result.status, 'EARLY_RADAR');
});

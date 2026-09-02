'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tp = require('../lib/trade-plan-v2');
const adapters = require('../lib/trade-plan-v2-source-adapters');
const integration = require('../lib/trade-plan-v2-integration');

test('1. Day Trade selects today low_price as LOCAL_SUPPORT anchor when below entryLow', () => {
  // A typical Day Trade momentum breakout candidate:
  // Stock rallied from low 970 to high 1040, current price 1025.
  // 5-day swing low (swingLow5) is 900 (12.2% below entry).
  // Today's low (low_price) is 970 (5.37% below entry).
  const candidate = {
    ticker: 'MOMM',
    entry_low: 1010,
    entry_high: 1025,
    current_price: 1025,
    low_price: 970,
    open_price: 980,
    high_price: 1040,
    support: 900,
    swingLow5: 900,
    resistance: 1120,
    atr14: 25
  };

  const plan = tp.buildTradePlanV2(candidate, { screener_type: 'DAY_TRADE' });

  // Must select LOCAL_SUPPORT (970) instead of CONFIRMED_SWING_LOW (900)
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT);
  assert.equal(plan.stop_anchor_price, 970);
  assert.ok(plan.stop_loss !== null && plan.stop_loss < 970);
  // With anchor 970 and ATR 25 (0.5 ATR = 12.5 -> floor 14 -> SL = 955), risk = 1025 - 955 = 70 (6.83% <= 7.0%)
  assert.ok(plan.stop_distance_pct <= 7.0, 'stop_distance_pct ' + plan.stop_distance_pct + '% must be controlled (<= 7%)');
  assert.notEqual(plan.status, tp.STATUS.REJECTED, 'Must not be rejected with RISK_CANNOT_BE_CONTROLLED');
  assert.ok(plan.rr_to_tp1 >= 1.00);
});

test('2. Day Trade adapter hydrates low_price from real analyzer output into local_support', () => {
  const analysis = {
    ticker: 'INTR',
    last_price: 1020,
    low_price: 990,
    open_price: 1000,
    high_price: 1040,
    support: 900,
    swingLow5: 900,
    resistance: 1150,
    atr14: 20
  };
  const scored = {
    ticker: 'INTR',
    entry_low: 1010,
    entry_high: 1025,
    last_price: 1020,
    low_price: 990,
    support: 900,
    resistance: 1150
  };

  const adapted = adapters.adaptDayTrade({ analysis, scored });
  assert.equal(adapted.input.local_support, 990);
  assert.equal(adapted.input.low_price, 990);

  const built = integration.buildPlanFromSource('DAY_TRADE', { analysis, scored });
  assert.equal(built.plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT);
  assert.equal(built.plan.stop_anchor_price, 990);
  assert.notEqual(built.plan.status, tp.STATUS.REJECTED);
});

test('3. Day Trade gracefully falls back to swing_low when low_price is above entry_low', () => {
  // If entry zone was calculated below today's low (e.g. entry_low = 950, but low_price = 960)
  const candidate = {
    ticker: 'PULL',
    entry_low: 950,
    entry_high: 970,
    current_price: 965,
    low_price: 960, // Above entry_low -> not a usable support anchor below entry
    swing_low: 940,
    support: 920,
    resistance: 1050,
    atr14: 15
  };

  const plan = tp.buildTradePlanV2(candidate, { screener_type: 'DAY_TRADE' });
  // Falls back to swing_low (940) because low_price (960) > entry_low (950)
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(plan.stop_anchor_price, 940);
  assert.notEqual(plan.status, tp.STATUS.REJECTED);
});

test('4. Swing Konglo and Swing Non-Konglo remain unaffected by Day Trade intraday anchor logic', () => {
  const swingCandidate = {
    ticker: 'SWNG',
    entry_low: 2000,
    entry_high: 2040,
    current_price: 2030,
    low_price: 2010, // Not used by swing
    swing_low: 1950,
    support: 1900,
    resistance: 2300,
    atr14: 40
  };

  const kongloPlan = tp.buildTradePlanV2(swingCandidate, { screener_type: 'SWING_KONGLO' });
  assert.equal(kongloPlan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(kongloPlan.stop_anchor_price, 1950);

  const nkPlan = tp.buildTradePlanV2(swingCandidate, { screener_type: 'SWING_NON_KONGLO' });
  assert.equal(nkPlan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(nkPlan.stop_anchor_price, 1950);
});

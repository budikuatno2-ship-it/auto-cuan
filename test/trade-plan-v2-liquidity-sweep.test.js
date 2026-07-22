'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tp = require('../lib/trade-plan-v2');
const sweep = require('../lib/trade-plan-v2-liquidity-sweep');
const candle = require('../lib/trade-plan-v2-candle-structure');
const gaps = require('../lib/trade-plan-v2-gap-areas');
const flags = require('../lib/trade-plan-v2-flags');

// ===================================================================
// Trailing-stop sweep states
// ===================================================================

test('1. a wick below the trailing reference followed by a reclaim is NOT an immediate confirmed breakdown', () => {
  const r = sweep.deriveTrailingSweepState({
    trailingReference: 1000,
    emergencyStop: 950,
    structuralSupport: 985,
    tolerance: 5,
    observations: [{ open: 1005, high: 1010, low: 970, close: 1004 }] // swept low, closed back above
  });
  assert.equal(r.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.SWEEP_RECLAIMED);
  assert.notEqual(r.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED);
});

test('2. a single close below the buffered trailing reference is only SWEEP_PENDING (not confirmed)', () => {
  const r = sweep.deriveTrailingSweepState({
    trailingReference: 1000, emergencyStop: 950, structuralSupport: 900, tolerance: 5,
    observations: [{ open: 1005, high: 1006, low: 985, close: 990 }] // one close below buffered (995)
  });
  assert.equal(r.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.SWEEP_PENDING);
});

test('3. a body close below buffered trailing reference with structural support broken confirms breakdown', () => {
  const r = sweep.deriveTrailingSweepState({
    trailingReference: 1000, emergencyStop: 950, structuralSupport: 992, tolerance: 5,
    observations: [{ open: 1005, high: 1006, low: 985, close: 988 }] // close 988 < buffered 995 AND < support 992
  });
  assert.equal(r.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED);
});

test('4. two consecutive closes below the buffered trailing reference confirm breakdown', () => {
  const r = sweep.deriveTrailingSweepState({
    trailingReference: 1000, emergencyStop: 950, structuralSupport: 900, tolerance: 5,
    observations: [
      { open: 1000, high: 1002, low: 985, close: 990 },
      { open: 990, high: 992, low: 980, close: 985 }
    ]
  });
  assert.equal(r.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED);
  assert.equal(r.consecutive_closes_below, 2);
});

test('5. a close below the emergency hard stop always confirms breakdown (hard stop exits)', () => {
  const r = sweep.deriveTrailingSweepState({
    trailingReference: 1000, emergencyStop: 950, structuralSupport: 985, tolerance: 5,
    observations: [{ open: 1000, high: 1001, low: 940, close: 945 }] // below emergency 950
  });
  assert.equal(r.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED);
  const sh = sweep.resolveSoftHardExit({ sweepState: r.trailing_sweep_state, emergencyStop: 950, lastClose: 945 });
  assert.equal(sh.hard_exit_state, sweep.HARD_EXIT_STATE.HIT);
  assert.equal(sh.emergency_stop_active, true); // never disabled
});

test('6. resolveSoftHardExit delays a soft exit on a reclaimed sweep but keeps the hard stop active', () => {
  const sh = sweep.resolveSoftHardExit({ sweepState: sweep.TRAILING_SWEEP_STATE.SWEEP_RECLAIMED, emergencyStop: 950, lastClose: 1004 });
  assert.equal(sh.soft_exit_state, sweep.SOFT_EXIT_STATE.DELAYED);
  assert.equal(sh.hard_exit_state, sweep.HARD_EXIT_STATE.ACTIVE);
  assert.equal(sh.structure_confirmation_required, true);
  assert.equal(sh.emergency_stop_active, true);
});

test('7. the trailing stop never moves downward (ratchet preserved)', () => {
  const held = tp.computeTrailingStop({
    entry: 1000, riskAmount: 40, tp1: 1080, currentPrice: 1100,
    highestClose: 1090, atr: 20, atrMultiplier: 1, priorTrailingStop: 1075
  });
  assert.equal(held.trailing_stop, 1075);
  assert.equal(held.basis, 'ratchet_hold_prior');
});

// ===================================================================
// Common trailing zones — diagnostics ONLY
// ===================================================================

test('8. the 3/4/5 percent trailing zones are DIAGNOSTIC only, not production stops', () => {
  const z = sweep.buildCommonTrailingZones({ referencePrice: 1000, atr: 20, atrMultiplier: 1 });
  assert.equal(z.diagnostic_only, true);
  const pcts = z.zones.filter((x) => x.type === 'PCT').map((x) => x.pct);
  assert.deepEqual(pcts, [3, 4, 5]);
  for (const zone of z.zones) assert.equal(zone.diagnostic_only, true);
  assert.match(z.disclaimer, /never used as a fixed production/i);
  // An ATR-based reference zone is included when ATR is available.
  assert.ok(z.zones.some((x) => x.type === 'ATR'));
});

test('9. trailing-zone events report pierce / reclaim / close-below observably', () => {
  const zones = sweep.buildCommonTrailingZones({ referencePrice: 1000, atr: 20, atrMultiplier: 1 }).zones;
  const events = sweep.detectTrailingZoneEvents({
    zones,
    observations: [{ open: 1000, high: 1005, low: 955, close: 995 }] // pierces 3%/4% zones, closes above them
  });
  const z3 = events.find((e) => e.zone_pct === 3);
  assert.ok(z3.pierced);
  assert.ok(z3.reclaimed);
  assert.equal(z3.diagnostic_only, true);
});

// ===================================================================
// Candle body / wick structure
// ===================================================================

test('10. lower-wick reclaim classification', () => {
  const c = candle.classifyCandle({ open: 1000, high: 1010, low: 960, close: 1005 });
  assert.equal(c.pattern, candle.CANDLE_PATTERN.LOWER_WICK_RECLAIM);
  assert.ok(c.lower_wick_to_body_ratio >= 1);
  assert.ok(c.close_location >= 0.5);
});

test('11. upper-wick rejection classification', () => {
  const c = candle.classifyCandle({ open: 1000, high: 1050, low: 995, close: 1002 });
  assert.equal(c.pattern, candle.CANDLE_PATTERN.UPPER_WICK_REJECTION);
});

test('12. full-body breakout classification', () => {
  const c = candle.classifyCandle({ open: 1000, high: 1052, low: 999, close: 1050 }, { resistance: 1040 });
  assert.equal(c.pattern, candle.CANDLE_PATTERN.FULL_BODY_BREAKOUT);
});

test('13. failed-breakout and failed-breakdown wick classifications', () => {
  const fbo = candle.classifyCandle({ open: 1010, high: 1060, low: 1005, close: 1015 }, { resistance: 1040 });
  assert.equal(fbo.pattern, candle.CANDLE_PATTERN.FAILED_BREAKOUT_WICK);
  const fbd = candle.classifyCandle({ open: 1005, high: 1010, low: 960, close: 1004 }, { referenceLevel: 990 });
  assert.equal(fbd.pattern, candle.CANDLE_PATTERN.FAILED_BREAKDOWN_WICK);
});

test('14. candle structure NEVER invents OHLC when it is unavailable', () => {
  assert.equal(candle.analyzeCandleStructure({ close: 1000 }).available, false);
  assert.equal(candle.analyzeCandleStructure(1000).available, false);
  assert.equal(candle.classifyCandle({ close: 1000 }).pattern, candle.CANDLE_PATTERN.NO_OHLC);
});

// ===================================================================
// Gap / imbalance areas
// ===================================================================

test('15. an active demand gap supports a bullish reclaim (active + weighted)', () => {
  const g = gaps.classifyGap({ gap_type: 'FVG', gap_low: 960, gap_high: 980, gap_direction: 'demand' },
    { currentPrice: 1000, observations: [{ high: 1010, low: 970, close: 1005 }] });
  assert.equal(g.gap_direction, 'DEMAND');
  assert.ok(g.active, 'active demand gap should carry weight');
  assert.ok([gaps.GAP_STATE.DEMAND_GAP_ACTIVE, gaps.GAP_STATE.GAP_PARTIALLY_FILLED, gaps.GAP_STATE.GAP_RECLAIMED].includes(g.gap_status));
});

test('16. a fully filled gap no longer receives active-zone weight', () => {
  const g = gaps.classifyGap({ gap_low: 960, gap_high: 980, gap_direction: 'demand' },
    { currentPrice: 1000, observations: [{ high: 1000, low: 955, close: 958 }] }); // closed below gap_low => failed
  assert.equal(g.active, false);
  assert.ok([gaps.GAP_STATE.GAP_FAILED, gaps.GAP_STATE.GAP_FULLY_FILLED].includes(g.gap_status));

  const filled = gaps.classifyGap({ gap_low: 960, gap_high: 980, gap_direction: 'demand', gap_fill_pct: 1 }, { currentPrice: 1000 });
  assert.equal(filled.gap_status, gaps.GAP_STATE.GAP_FULLY_FILLED);
  assert.equal(filled.active, false);
});

test('17. gaps are NEVER invented when required prices are unavailable', () => {
  const g = gaps.classifyGap({ gap_direction: 'demand' }, { currentPrice: 1000 });
  assert.equal(g.gap_status, gaps.GAP_STATE.GAP_UNAVAILABLE);
  assert.equal(g.active, false);
  assert.equal(g.gap_low, null);
  assert.equal(g.gap_high, null);
});

// ===================================================================
// Engine integration (additive)
// ===================================================================

function baseCandidate(overrides) {
  return Object.assign({
    ticker: 'SWEEP', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 985,
    resistance: 1080, atr14: 20, current_price: 1008
  }, overrides || {});
}

test('18. buildTradePlanV2 exposes the full additive canonical schema', () => {
  const plan = tp.buildTradePlanV2(baseCandidate(), { screener_type: 'DAY_TRADE' });
  for (const f of ['trailing_sweep_state', 'trailing_reference', 'common_trailing_zones', 'trailing_zone_events',
    'candle_structure', 'active_gap_areas', 'nearest_demand_gap', 'nearest_supply_gap',
    'liquidity_sweep_evidence', 'structure_confirmation_required', 'soft_exit_state', 'hard_exit_state']) {
    assert.ok(f in plan, 'missing additive field ' + f);
  }
  // Common trailing zones are always available (diagnostic), even without observations.
  assert.equal(plan.common_trailing_zones.diagnostic_only, true);
  assert.equal(plan.hard_exit_state, sweep.HARD_EXIT_STATE.ACTIVE); // emergency always active
});

test('19. an active demand gap below structure deepens the SL below the demand-gap invalidation', () => {
  const withoutGap = tp.buildTradePlanV2(baseCandidate(), { screener_type: 'DAY_TRADE' });
  const withGap = tp.buildTradePlanV2(baseCandidate({
    gaps: [{ gap_type: 'FVG', gap_low: 960, gap_high: 980, gap_direction: 'demand' }]
  }), { screener_type: 'DAY_TRADE', observations: [{ open: 1005, high: 1012, low: 1002, close: 1008 }] });
  assert.ok(withGap.stop_loss < withoutGap.stop_loss, 'SL deepened below the active demand gap');
  assert.ok(withGap.stop_loss < 960, 'SL sits below the demand-gap invalidation (gap_low)');
  assert.match(withGap.stop_loss_reason, /demand-gap-adjusted/);
});

test('20. an active supply gap constrains TP1 below the gap', () => {
  const plan = tp.buildTradePlanV2(baseCandidate({
    resistance: 1080,
    gaps: [{ gap_type: 'FVG', gap_low: 1040, gap_high: 1060, gap_direction: 'supply' }]
  }), { screener_type: 'DAY_TRADE' });
  assert.ok(plan.tp1 < 1040, 'TP1 capped below the active supply gap');
  assert.match(plan.tp1_reason, /supply gap/i);
});

test('21. supply/demand gaps are inert when no gap data is supplied (backward compatible)', () => {
  const plan = tp.buildTradePlanV2(baseCandidate(), { screener_type: 'DAY_TRADE' });
  assert.deepEqual(plan.active_gap_areas, []);
  assert.equal(plan.nearest_demand_gap, null);
  assert.equal(plan.nearest_supply_gap, null);
});

test('22. an engine-level reclaimed sweep yields SWEEP_RECLAIMED + delayed soft exit + confirmation required', () => {
  const plan = tp.buildTradePlanV2(baseCandidate(), {
    screener_type: 'DAY_TRADE',
    trailing_reference: 995,
    observations: [
      { open: 1005, high: 1015, low: 1000, close: 1012 },
      { open: 1012, high: 1016, low: 965, close: 1008 } // swept below 995, closed back above
    ]
  });
  assert.equal(plan.trailing_sweep_state, sweep.TRAILING_SWEEP_STATE.SWEEP_RECLAIMED);
  assert.equal(plan.soft_exit_state, sweep.SOFT_EXIT_STATE.DELAYED);
  assert.equal(plan.hard_exit_state, sweep.HARD_EXIT_STATE.ACTIVE);
  assert.equal(plan.structure_confirmation_required, true);
});

// ===================================================================
// Feature flag (additive)
// ===================================================================

test('23. the new liquidity-sweep shadow flag defaults to false and does not alter getFlags()', () => {
  assert.equal(flags.isLiquiditySweepShadowEnabled({}), false);
  assert.equal(flags.isLiquiditySweepShadowEnabled({ TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED: 'true' }), true);
  // getFlags() contract is unchanged (backward compatible).
  const f = flags.getFlags({});
  assert.deepEqual(f.defaults, { TRADE_PLAN_V2_SHADOW_ENABLED: false, TRADE_PLAN_V2_PUBLIC_ENABLED: false });
  assert.ok(!('TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED' in f.defaults));
  // getAllFlags() is the additive extended snapshot.
  const all = flags.getAllFlags({});
  assert.equal(all.TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED, false);
  assert.equal(all.defaults.TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED, false);
});

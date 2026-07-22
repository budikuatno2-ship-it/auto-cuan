'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tp = require('../lib/trade-plan-v2');
const idx = require('../lib/idx-tick-normalization');

// A clean DAY_TRADE long candidate used as a happy-path base.
function cleanCandidate(overrides) {
  return Object.assign({
    ticker: 'TEST',
    entry_low: 1000,
    entry_high: 1010,
    support: 990,
    swing_low: 990,
    resistance: 1080,
    atr14: 20,
    current_price: 1008
  }, overrides || {});
}

// ===================================================================
// Structural stop loss
// ===================================================================

test('1. SL sits below the structural level by the required ATR/tick buffer', () => {
  // atr=40 so the ATR buffer (0.5*40=20) exceeds the 2-tick floor (2*5=10).
  const plan = tp.buildTradePlanV2(cleanCandidate({ atr14: 40 }), { screener_type: 'DAY_TRADE' });
  const structural = 990; // min(support 990, swing_low 990)
  assert.equal(plan._detail.structural_level, structural);
  assert.equal(plan.structural_invalidation, 990);
  // buffer = 0.5 * 40 = 20 ticks-aligned floor.
  assert.equal(plan.stop_loss, idx.roundToIdxTick(structural - 20, 'floor'));
  assert.ok(plan.stop_loss <= structural - 2 * idx.getIdxTickSize(1010), 'SL at least 2 ticks below structural');
  assert.ok(plan.stop_loss < plan.entry_zone_high, 'SL below entry');
  // emergency hard-stop is always retained and below the SL.
  assert.ok(plan.emergency_stop < plan.stop_loss);
  assert.ok(idx.isValidIdxPriceLevel(plan.stop_loss));
  assert.ok(idx.isValidIdxPriceLevel(plan.emergency_stop));
});

test('2. confirmed swing low is selected as the normal anchor rather than the distant major support', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ support: 990, swing_low: 975, atr14: 40 }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan._detail.structural_level, 975);
  assert.equal(plan.support_source, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(plan.stop_loss, idx.roundToIdxTick(975 - 20, 'floor'));
});

test('3. volatility buffer is at least two valid price ticks when ATR is tiny', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ atr14: 1 }), { screener_type: 'DAY_TRADE' });
  const tick = idx.getIdxTickSize(1010); // 5
  // 0.5*1 = 0.5 < 2 ticks (10) => floor to 2 ticks.
  assert.equal(plan.stop_loss, idx.roundToIdxTick(990 - 2 * tick, 'floor'));
});

// ===================================================================
// Volatility profiles differ by screener
// ===================================================================

test('4. volatility + trailing profiles differ across the three screeners', () => {
  const base = cleanCandidate({ atr14: 40 }); // ATR-driven, above tick floor
  const day = tp.buildTradePlanV2(base, { screener_type: 'DAY_TRADE' });
  const non = tp.buildTradePlanV2(base, { screener_type: 'SWING_NON_KONGLO' });
  const kon = tp.buildTradePlanV2(base, { screener_type: 'SWING_KONGLO' });
  // SL buffers: 0.5 / 0.75 / 1.0 ATR => deeper stops for swing.
  assert.ok(day.stop_loss > non.stop_loss, 'day SL tighter than non-konglo');
  assert.ok(non.stop_loss > kon.stop_loss, 'non-konglo SL tighter than konglo');
  // Trailing ATR multipliers strictly increase.
  assert.equal(day.trailing_atr_multiplier, 1.0);
  assert.equal(non.trailing_atr_multiplier, 1.5);
  assert.equal(kon.trailing_atr_multiplier, 2.0);
});

test('9. nearest local support is preferred over a distant major support', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 162, entry_high: 165, support: 146, major_support: 146,
    local_support: 160, swing_low: null, resistance: 190, atr14: 2
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT);
  assert.equal(plan.stop_anchor_price, 160);
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 146);
  assert.ok(plan.stop_loss > plan.emergency_stop);
});

test('10. a nearer confirmed swing low becomes the normal stop anchor', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 162, entry_high: 165, support: 146, swing_low: 161,
    resistance: 190, atr14: 2
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(plan.stop_anchor_price, 161);
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 146);
});

test('11. an active nearby demand-gap invalidation can become the normal anchor', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010, support: 950, swing_low: 970,
    resistance: 1100, atr14: 20,
    gaps: [{ gap_type: 'demand', gap_low: 990, gap_high: 1000, gap_direction: 'demand' }]
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION);
  assert.equal(plan.stop_anchor_price, 990);
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 950);
});

test('12. stale, failed, and unconfirmed anchors are rejected but entry-boundary support is valid', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010,
    local_support: [{ price: 995, stale: true }, { price: 1000 }, { price: 990, failed: true }, { price: 985, confirmed: false }],
    support: 960, swing_low: null, resistance: 1100, atr14: 10
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT);
  assert.equal(plan.stop_anchor_price, 1000);
  assert.ok(plan.stop_loss < 1000);
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 960);
});

// ===================================================================
// Resistance hierarchy and realistic targets
// ===================================================================

test('13. resistance at or below entry is ignored and the nearest valid overhead level wins', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010, support: 980, swing_low: 985,
    resistance: 1005, local_resistance: 1050, major_resistance: 1300, atr14: 20
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.resistance, 1050);
  assert.equal(plan.nearest_local_resistance, 1050);
  assert.equal(plan.resistance_source, 'local_resistance');
  assert.equal(plan.major_resistance, 1300);
});

test('14. TP1 uses a realistic R target and distant major resistance becomes conditional TP2', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010, support: 980, swing_low: 985,
    local_resistance: 1060, resistance: 1300, major_resistance: 1300, atr14: 20
  }), { screener_type: 'DAY_TRADE', breakout_confirmed: true });
  assert.ok(plan.tp1_target_r >= 1.0 && plan.tp1_target_r <= 1.3);
  assert.ok(plan.tp1 < 1060);
  assert.equal(plan.tp1_anchor_type, 'R_TARGET');
  assert.equal(plan.tp2, 1300);
  assert.equal(plan.tp2_anchor_type, tp.RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE);
  assert.equal(plan.major_resistance, 1300);
});


test('15. an active supply gap overlapping entry blocks TP1 instead of being bypassed', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010, support: 980, swing_low: 985,
    resistance: 1150, atr14: 20,
    gaps: [{ gap_type: 'supply', gap_low: 990, gap_high: 1020, gap_direction: 'supply' }]
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.tp1, null);
  assert.match(plan.tp1_reason, /supply gap.*entry/i);
  assert.ok(plan.warnings.includes(tp.WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE));
});

test('16. typed hierarchy arrays normalize lowercase anchor types', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({
    support: null, swing_low: null, structural_levels: [{ type: 'local_support', price: 990 }],
    resistance: null, resistance_levels: [{ type: 'local_resistance', price: 1080 }], atr14: 20
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT);
  assert.equal(plan.resistance, 1080);
  assert.equal(plan.nearest_local_resistance, 1080);
});

test('5. a support wick + reclaim is NOT treated as a confirmed breakdown', () => {
  const res = tp.deriveSupportTestState({
    support: 1000,
    tolerance: 5,
    observations: [{ high: 1010, low: 985, close: 1002 }] // low pierced, close reclaimed
  });
  assert.equal(res.support_test_state, tp.SUPPORT_STATE.TEST_RECLAIMED);
  assert.notEqual(res.support_test_state, tp.SUPPORT_STATE.BREAKDOWN_CONFIRMED);
});

test('6. confirmed breakdown requires two closes below buffered support (or explicit confirm)', () => {
  const two = tp.deriveSupportTestState({
    support: 1000, tolerance: 5,
    observations: [{ high: 1000, low: 980, close: 985 }, { high: 990, low: 975, close: 980 }]
  });
  assert.equal(two.support_test_state, tp.SUPPORT_STATE.BREAKDOWN_CONFIRMED);
  assert.equal(two.consecutive_closes_below, 2);

  const oneOnly = tp.deriveSupportTestState({
    support: 1000, tolerance: 5,
    observations: [{ high: 1005, low: 990, close: 1001 }, { high: 1000, low: 980, close: 985 }]
  });
  assert.equal(oneOnly.support_test_state, tp.SUPPORT_STATE.BREAKDOWN_PENDING);

  const explicit = tp.deriveSupportTestState({
    support: 1000, tolerance: 5, breakdown_confirmed: true,
    observations: [{ high: 1000, low: 980, close: 985 }]
  });
  assert.equal(explicit.support_test_state, tp.SUPPORT_STATE.BREAKDOWN_CONFIRMED);
});

test('7. repeated tests with price sitting on support => SUPPORT_WEAKENING; else HOLDING', () => {
  const weak = tp.deriveSupportTestState({
    support: 1000, tolerance: 5,
    observations: [{ high: 1010, low: 1000, close: 1004 }, { high: 1008, low: 1001, close: 1003 }]
  });
  assert.equal(weak.support_test_state, tp.SUPPORT_STATE.WEAKENING);

  const holding = tp.deriveSupportTestState({
    support: 1000, tolerance: 5,
    observations: [{ high: 1030, low: 1020, close: 1025 }]
  });
  assert.equal(holding.support_test_state, tp.SUPPORT_STATE.HOLDING);
});

test('8. an emergency hard-stop level is always retained', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ atr14: 40 }), { screener_type: 'DAY_TRADE' });
  assert.ok(Number.isFinite(plan.emergency_stop));
  assert.ok(plan.emergency_stop < plan.structural_invalidation);
});

// ===================================================================
// Take-profit logic
// ===================================================================

test('9. TP1 uses the configured realistic R target and remains before resistance', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ resistance: 1080, atr14: 20 }), { screener_type: 'DAY_TRADE' });
  assert.ok(plan.tp1 < plan.resistance, 'TP1 below resistance');
  assert.equal(plan.tp1_anchor_type, 'R_TARGET');
  assert.equal(plan.tp1_target_r, tp.SCREENER_PROFILES.DAY_TRADE.tp1_target_r);
  const expected = idx.roundToIdxTick(plan.entry_zone_high + plan.tp1_target_r * plan.risk_amount, 'floor');
  assert.equal(plan.tp1, expected);
  assert.ok(plan.tp1 > plan.entry_zone_high, 'TP1 above entry');
});

test('10. NO TP is invented when resistance is unavailable', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ resistance: null }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.tp1, null);
  assert.equal(plan.tp2, null);
  assert.ok(plan.warnings.includes(tp.WARN.NO_RESISTANCE_TP1_UNAVAILABLE));
  assert.match(plan.tp1_reason, /not invented/i);
});

test('11. TP2 is allowed ONLY on a confirmed breakout or held breakout retest', () => {
  // No breakout => TP2 withheld.
  const noBreak = tp.buildTradePlanV2(cleanCandidate({ resistance: 1080, next_resistance: 1150, atr14: 20 }),
    { screener_type: 'DAY_TRADE' });
  assert.equal(noBreak.tp2, null);
  assert.ok(noBreak.warnings.includes(tp.WARN.TP2_REQUIRES_BREAKOUT_CONFIRMATION));

  // Confirmed breakout => TP2 allowed at next resistance.
  const confirmed = tp.buildTradePlanV2(cleanCandidate({ resistance: 1080, atr14: 20 }), {
    screener_type: 'DAY_TRADE',
    next_resistance: 1150,
    breakout_confirmed: true
  });
  assert.equal(confirmed.tp2, idx.roundToIdxTick(1150, 'floor'));
  assert.ok(confirmed.tp2 > confirmed.tp1);
});

test('12. TP2 falls back to a documented R-multiple only after a confirmed breakout', () => {
  // Larger structural risk so the 2R target clears TP1.
  const plan = tp.buildTradePlanV2(cleanCandidate({ support: 955, swing_low: 955, resistance: 1080, atr14: 20 }), {
    screener_type: 'DAY_TRADE',
    breakout_confirmed: true // no next_resistance provided
  });
  assert.ok(plan.tp2 !== null);
  assert.match(plan.tp2_reason, /R target/);
  // 2R above entry.
  const expected = idx.roundToIdxTick(plan.entry_zone_high + 2 * plan.risk_amount, 'floor');
  assert.equal(plan.tp2, expected);
});

// ===================================================================
// Resistance-test progression + breakout / failed-breakout states
// ===================================================================

test('13. resistance-test progression: TEST_1 -> TEST_2 -> TEST_3_PLUS', () => {
  const bar = { high: 1000, low: 985, close: 992 }; // touches band, closes below
  assert.equal(tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [bar] }).resistance_test_state, tp.RESISTANCE_STATE.TEST_1);
  assert.equal(tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [bar, bar] }).resistance_test_state, tp.RESISTANCE_STATE.TEST_2);
  assert.equal(tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [bar, bar, bar] }).resistance_test_state, tp.RESISTANCE_STATE.TEST_3_PLUS);
});

test('14. breakout, pending, retest-held and failed-breakout states are detected', () => {
  const confirmed = tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [{ high: 1008, low: 1000, close: 1005 }, { high: 1015, low: 1005, close: 1010 }] });
  assert.equal(confirmed.resistance_test_state, tp.RESISTANCE_STATE.BREAKOUT_CONFIRMED);

  const pending = tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [{ high: 995, low: 985, close: 990 }, { high: 1008, low: 998, close: 1005 }] });
  assert.equal(pending.resistance_test_state, tp.RESISTANCE_STATE.BREAKOUT_PENDING);

  const retest = tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [{ high: 1010, low: 1000, close: 1006 }, { high: 1002, low: 996, close: 998 }] });
  assert.equal(retest.resistance_test_state, tp.RESISTANCE_STATE.BREAKOUT_RETEST_HELD);

  const failed = tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [{ high: 1010, low: 1000, close: 1005 }, { high: 998, low: 985, close: 990 }] });
  assert.equal(failed.resistance_test_state, tp.RESISTANCE_STATE.BREAKOUT_FAILED);
});

test('15. an upper-wick rejection at resistance is flagged RESISTANCE_REJECTION', () => {
  const rej = tp.deriveResistanceTestState({ resistance: 1000, tolerance: 5, observations: [{ high: 1012, low: 985, close: 990 }] });
  assert.equal(rej.resistance_test_state, tp.RESISTANCE_STATE.REJECTION);
});

// ===================================================================
// Trailing-stop logic
// ===================================================================

test('16. trailing activates ONLY after +1R or TP1 is reached', () => {
  const before = tp.computeTrailingStop({ entry: 1000, riskAmount: 40, tp1: 1080, currentPrice: 1030, highestClose: 1030, atr: 20, atrMultiplier: 1 });
  assert.equal(before.active, false); // 1030 < activation (min(1040,1080)=1040)
  const after = tp.computeTrailingStop({ entry: 1000, riskAmount: 40, tp1: 1080, currentPrice: 1045, highestClose: 1045, atr: 20, atrMultiplier: 1 });
  assert.equal(after.active, true);
});

test('17. the trailing stop never moves downward (ratchets)', () => {
  const held = tp.computeTrailingStop({
    entry: 1000, riskAmount: 40, tp1: 1080, currentPrice: 1100,
    highestClose: 1090, atr: 20, atrMultiplier: 1, priorTrailingStop: 1075
  });
  // candidate = 1090 - 20 = 1070 < prior 1075 => keep prior.
  assert.equal(held.trailing_stop, 1075);
  assert.equal(held.basis, 'ratchet_hold_prior');
});

test('18. trailing uses highest close minus ATR and the swing-low buffer (highest wins)', () => {
  const r = tp.computeTrailingStop({
    entry: 1000, riskAmount: 40, tp1: 1080, currentPrice: 1120,
    highestClose: 1120, atr: 20, atrMultiplier: 1,
    latestSwingLow: 1090, swingBuffer: 5
  });
  // close-based = 1100, swing-based = 1085 => highest = 1100.
  assert.equal(r.active, true);
  assert.equal(r.trailing_stop, idx.roundToIdxTick(1100, 'floor'));
  assert.equal(r.basis, 'highest_close_minus_atr');
});

// ===================================================================
// Risk-budget: reject / reduce-size
// ===================================================================

test('19. excessive stop distance above the risk budget => REDUCE_POSITION_SIZE', () => {
  // structural far below entry so stop distance ~5.9% (between 4% budget and 7% reject).
  const plan = tp.buildTradePlanV2(cleanCandidate({ support: 960, swing_low: 960, resistance: 1200, atr14: 12 }),
    { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REDUCE_POSITION_SIZE);
  assert.ok(plan.warnings.includes(tp.WARN.REDUCE_POSITION_SIZE));
  assert.ok(plan.warnings.includes(tp.WARN.STOP_DISTANCE_EXCEEDS_RISK_BUDGET));
  assert.ok(plan.stop_distance_pct > 4 && plan.stop_distance_pct <= 7);
});

test('20. stop distance beyond the reject threshold => REJECTED (risk cannot be controlled)', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ support: 920, swing_low: 920, resistance: 1300, atr14: 10 }),
    { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.RISK_CANNOT_BE_CONTROLLED);
  assert.ok(plan.stop_distance_pct > 7);
});

test('21. position size is never actually mutated — REDUCE is advisory metadata only', () => {
  const candidate = cleanCandidate({ support: 960, swing_low: 960, resistance: 1200, atr14: 12, position_size: 1000 });
  const plan = tp.buildTradePlanV2(candidate, { screener_type: 'DAY_TRADE' });
  assert.equal(candidate.position_size, 1000, 'source candidate size unchanged');
  assert.equal(plan.status, tp.STATUS.REDUCE_POSITION_SIZE);
});

// ===================================================================
// Insufficient RR
// ===================================================================

test('22. RR below the profile minimum (but >= 1.0) warns without rejecting', () => {
  // For DAY_TRADE the minimum is now 1.00, so we need an RR slightly below 1.0
  // but the HARD_MIN_RR is also 1.0. An RR between 0 and 1.0 is outright rejected.
  // Instead, use SWING_NON_KONGLO (min 1.20) to show the warning band:
  // entry=1010, swing_low=990, buffer=0.75*20=15, SL=975, risk=35
  // resistance=1050, obstacleBuffer=5, cappedTp1=1045, baseTp1=1010+1.35*35=1057.25=1057
  // tp1 = min(1057, 1045) = 1045. reward = 35, rr = 35/35 = 1.0 (>= 1.0, < 1.20)
  const plan = tp.buildTradePlanV2(cleanCandidate({ support: 990, swing_low: 990, resistance: 1050, atr14: 20 }),
    { screener_type: 'SWING_NON_KONGLO' });
  assert.ok(plan.rr_to_tp1 < 1.20 && plan.rr_to_tp1 >= 1.0, 'rr_to_tp1=' + plan.rr_to_tp1 + ' should be between 1.0 and 1.20');
  assert.equal(plan.status, tp.STATUS.WARNING);
  assert.ok(plan.warnings.includes(tp.WARN.INSUFFICIENT_RR_TO_TP1));
});

test('23. RR below 1.0 (reward < risk) is REJECTED', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ support: 990, swing_low: 990, resistance: 1035, atr14: 20 }),
    { screener_type: 'DAY_TRADE' });
  // risk 30, tp1 1030, reward 20 => rr 0.67 < 1.0.
  assert.ok(plan.rr_to_tp1 < 1.0);
  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.INSUFFICIENT_RR_TO_TP1);
});

// ===================================================================
// Entry validation warnings + rejects
// ===================================================================

test('24. an unavailable valid entry price is rejected (never fabricated)', () => {
  const plan = tp.buildTradePlanV2({ ticker: 'X', support: 900, resistance: 1000, atr14: 10 }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.NO_VALID_ENTRY_PRICE);
});

test('25. stale data downgrades an OK plan to WARNING and is flagged', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ data_stale: true }), { screener_type: 'DAY_TRADE' });
  assert.ok(plan.warnings.includes(tp.WARN.STALE_DATA));
  assert.equal(plan.data_freshness.is_stale, true);
  assert.notEqual(plan.status, tp.STATUS.OK);
});

test('26. entry too close to resistance is warned', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ resistance: 1012, atr14: 20 }), { screener_type: 'DAY_TRADE' });
  assert.ok(plan.warnings.includes(tp.WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE));
});

test('27. realistic TP1 target returns a complete canonical plan with tick-aligned prices', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate({ resistance: 1080, atr14: 20 }), { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.OK, 'realistic TP1 at ' + plan.rr_to_tp1 + 'R passes the DAY_TRADE minimum of 1.00');
  assert.equal(plan.plan_version, 'trade-plan-v2');
  for (const f of ['entry_zone_low', 'entry_zone_high', 'stop_loss', 'tp1', 'support', 'resistance', 'trailing_activation']) {
    assert.ok(idx.isValidIdxPriceLevel(plan[f]), f + ' tick-aligned');
  }
  assert.ok(plan.rr_to_tp1 >= 1.0 && plan.rr_to_tp1 <= 1.3);
});

// ===================================================================
// Day-Trade experimental candidate rule (preserved)
// ===================================================================

test('28. Day Trade retains the rank-1 / score-16 / next-snapshot / one-per-day rule', () => {
  const ok = tp.evaluateDayTradeCandidateRule({ confirmation_state: 'CONFIRMED', confirmed_rank: 1, shadow_score: 20 });
  assert.equal(ok.eligible, true);
  assert.equal(ok.executable_only_next_snapshot, true);
  assert.equal(ok.max_one_per_day, true);

  assert.equal(tp.evaluateDayTradeCandidateRule({ confirmation_state: 'CONFIRMED', confirmed_rank: 2, shadow_score: 99 }).eligible, false);
  assert.equal(tp.evaluateDayTradeCandidateRule({ confirmation_state: 'CONFIRMED', confirmed_rank: 1, shadow_score: 12 }).eligible, false);
  assert.equal(tp.evaluateDayTradeCandidateRule({ confirmation_state: 'PROVISIONAL', confirmed_rank: 1, shadow_score: 40 }).eligible, false);
  // Rule constants are exactly the preserved values.
  assert.deepEqual(tp.DAY_TRADE_CANDIDATE_RULE, { confirmation_state: 'CONFIRMED', confirmed_rank: 1, min_shadow_score: 16 });
});

// ===================================================================
// Canonical schema completeness
// ===================================================================

test('29. the canonical object always exposes the full documented schema', () => {
  const plan = tp.buildTradePlanV2(cleanCandidate(), { screener_type: 'DAY_TRADE', generated_at: '2026-07-22T09:00:00Z' });
  const required = [
    'plan_version', 'screener_type', 'ticker', 'generated_at', 'entry_zone_low', 'entry_zone_high',
    'entry_trigger', 'entry_reason', 'support', 'support_source', 'resistance', 'resistance_source',
    'stop_loss', 'stop_loss_reason', 'stop_anchor_type', 'stop_anchor_price', 'structural_invalidation',
    'emergency_stop', 'emergency_anchor_type', 'emergency_anchor_price', 'stop_distance_pct',
    'tp1', 'tp1_anchor_type', 'tp1_target_r', 'tp1_reason', 'nearest_local_resistance',
    'tp2', 'tp2_anchor_type', 'major_resistance', 'tp2_reason', 'trailing_activation', 'trailing_method',
    'trailing_atr_multiplier', 'risk_amount', 'reward_to_tp1', 'reward_to_tp2', 'rr_to_tp1', 'rr_to_tp2',
    'support_test_state', 'resistance_test_state', 'warnings', 'data_freshness'
  ];
  for (const f of required) assert.ok(f in plan, 'missing canonical field ' + f);
  assert.equal(plan.generated_at, '2026-07-22T09:00:00Z');
  assert.equal(plan.screener_type, 'DAY_TRADE');
});



test('30. support at entry_zone_low is valid but support above the zone is not', () => {
  const boundary = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010, support: null, swing_low: null,
    local_support: 1000, resistance: 1100, atr14: 10
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(boundary.stop_anchor_price, 1000);
  assert.ok(boundary.stop_loss < 1000);

  const above = tp.buildTradePlanV2(cleanCandidate({
    entry_low: 1000, entry_high: 1010, support: null, swing_low: null,
    local_support: 1005, resistance: 1100, atr14: 10
  }), { screener_type: 'DAY_TRADE' });
  assert.equal(above.status, tp.STATUS.REJECTED);
  assert.equal(above.reject_reason, tp.WARN.NO_STRUCTURAL_LEVEL);
});



// ===================================================================
// Real-shaped regression tests (ADHI, BLTZ, BSWD, AHAP, BEEF, BNBR)
// ===================================================================

test('31. ADHI: rr_to_tp1 meets DAY_TRADE minimum 1.00, status REDUCE_POSITION_SIZE, usable', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'ADHI', entry_low: 162, entry_high: 165, support: 146, major_support: 146,
    swing_low: 161, resistance: 190, atr14: 6.3571, current_price: 164
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(plan.stop_anchor_price, 161);
  assert.equal(plan.stop_loss, 157);
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 146);
  assert.equal(plan.tp1, 174);
  assert.ok(plan.rr_to_tp1 >= 1.00, 'ADHI rr_to_tp1=' + plan.rr_to_tp1 + ' must be >= 1.00');
  assert.equal(plan.tp1_target_r, 1.15);
  assert.equal(plan.minimum_rr_to_tp1, 1.00);
  assert.equal(plan.status, tp.STATUS.REDUCE_POSITION_SIZE);
});

test('32. BLTZ: support at entry-zone boundary, SL=2520, TP1=2580, usable', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'BLTZ', entry_low: 2540, entry_high: 2550, support: 2540,
    resistance: 2870, atr14: 23.5714, current_price: 2545
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_price, 2540);
  assert.equal(plan.stop_loss, 2520);
  assert.equal(plan.tp1, 2580);
  assert.equal(plan.rr_to_tp1, 1);
  assert.equal(plan.tp1_target_r, 1.15);
  assert.equal(plan.minimum_rr_to_tp1, 1.00);
  assert.equal(plan.status, tp.STATUS.OK);
});

test('33. BSWD: support at entry-zone boundary, SL=1240, TP1=1270, usable', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'BSWD', entry_low: 1250, entry_high: 1255, support: 1250,
    resistance: 1375, atr14: 9.2857, current_price: 1252
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.stop_anchor_price, 1250);
  assert.equal(plan.stop_loss, 1240);
  assert.equal(plan.tp1, 1270);
  assert.equal(plan.rr_to_tp1, 1);
  assert.equal(plan.tp1_target_r, 1.15);
  assert.equal(plan.minimum_rr_to_tp1, 1.00);
  assert.equal(plan.status, tp.STATUS.OK);
});

test('34. AHAP: mandatory risk rejection (stop_dist > 7%) still falls back even when RR passes', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'AHAP', entry_low: 96, entry_high: 98, support: 80, major_support: 80,
    swing_low: 92, resistance: 120, atr14: 6.5714, current_price: 97
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.RISK_CANNOT_BE_CONTROLLED);
  assert.ok(plan.stop_distance_pct > 7, 'stop distance ' + plan.stop_distance_pct + '% must exceed reject threshold');
  assert.ok(plan.rr_to_tp1 >= 1.00, 'RR passes but risk rejection takes precedence');
});

test('35. BEEF: no normal structural anchor, REJECTED, emergency major support visible', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'BEEF', entry_low: 310, entry_high: 318, major_support: 122,
    resistance: 400, atr14: 10, current_price: 315
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.NO_STRUCTURAL_LEVEL);
  assert.equal(plan.stop_anchor_price, null);
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 122);
  assert.ok(plan.emergency_stop < 122);
});

test('36. BNBR: no normal structural anchor and no valid TP1, REJECTED, emergency visible', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'BNBR', entry_low: 113, entry_high: 116, major_support: 70,
    resistance: 116, atr14: 8, current_price: 114
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.equal(plan.reject_reason, tp.WARN.NO_STRUCTURAL_LEVEL);
  assert.equal(plan.resistance, null, 'resistance at entry zone must be ignored');
  assert.equal(plan.tp1, null, 'no valid TP1 when resistance inside entry zone');
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 70);
  assert.ok(plan.emergency_stop < 70);
});

// ===================================================================
// Boundary RR tests
// ===================================================================

test('37. Day Trade RR 0.99 is unusable (below minimum 1.00)', () => {
  // Craft a plan where rr_to_tp1 < 1.0 => REJECTED (HARD_MIN_RR).
  const plan = tp.buildTradePlanV2({
    ticker: 'RR099', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: 1035, atr14: 20, current_price: 1008
  }, { screener_type: 'DAY_TRADE' });
  // resistance=1035, obstacleBuffer = max(5, 0.20*20)=5, cappedTp1=1030
  // baseTp1=1010+1.15*30=1044.5=1044. tp1=min(1044,1030)=1030. reward=20. rr=20/30=0.67
  assert.ok(plan.rr_to_tp1 < 1.0, 'rr_to_tp1=' + plan.rr_to_tp1 + ' must be below 1.0');
  assert.equal(plan.status, tp.STATUS.REJECTED);
});

test('38. Day Trade RR exactly 1.00 passes the RR rule', () => {
  // entry=1010, SL=980, risk=30. resistance=1080, tp1 from R_TARGET.
  // baseTp1=1010+1.15*30=1044.5 → floor → 1040. reward=30. rr=30/30=1.0.
  const plan = tp.buildTradePlanV2({
    ticker: 'RR100', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: 1080, atr14: 20, current_price: 1008
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.rr_to_tp1, 1.0);
  assert.equal(plan.status, tp.STATUS.OK);
  assert.equal(plan.minimum_rr_to_tp1, 1.00);
});

test('39. Swing RR 1.19 is unusable (below SWING_NON_KONGLO minimum 1.20)', () => {
  // Use SWING_NON_KONGLO with a tight resistance to produce RR between 1.0 and 1.2.
  // entry=1010, buffer=0.75*20=15, SL=975, risk=35.
  // resistance=1050, obstacleBuffer=max(5,4)=5, cappedTp1=1045
  // baseTp1=1010+1.35*35=1057.25=1055. tp1=min(1055,1045)=1045. reward=35. rr=1.0.
  const plan = tp.buildTradePlanV2({
    ticker: 'RR119', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: 1050, atr14: 20, current_price: 1008
  }, { screener_type: 'SWING_NON_KONGLO' });
  assert.ok(plan.rr_to_tp1 < 1.20, 'rr_to_tp1=' + plan.rr_to_tp1 + ' must be below 1.20');
  assert.ok(plan.rr_to_tp1 >= 1.0, 'rr_to_tp1 must be at least 1.0');
  assert.equal(plan.minimum_rr_to_tp1, 1.20);
  assert.ok(plan.warnings.includes(tp.WARN.INSUFFICIENT_RR_TO_TP1));
});

test('40. Swing RR 1.20 passes the RR rule', () => {
  // entry=1010, buffer=0.75*20=15, SL=975, risk=35. tp1_target_r=1.35.
  // baseTp1=1010+1.35*35=1057.25→1055. resistance=1080, obstacle=5, cap=1075.
  // tp1=min(1055,1075)=1055. reward=45. rr=45/35=1.2857 >= 1.20.
  const plan = tp.buildTradePlanV2({
    ticker: 'RR120', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: 1080, atr14: 20, current_price: 1008
  }, { screener_type: 'SWING_NON_KONGLO' });
  assert.ok(plan.rr_to_tp1 >= 1.20, 'rr_to_tp1=' + plan.rr_to_tp1 + ' must be >= 1.20');
  assert.equal(plan.minimum_rr_to_tp1, 1.20);
  assert.notEqual(plan.status, tp.STATUS.REJECTED);
});

// ===================================================================
// Status usability tests
// ===================================================================

test('41. REJECTED status never becomes usable regardless of RR', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'REJX', entry_low: 310, entry_high: 318, major_support: 122,
    resistance: 400, atr14: 10, current_price: 315
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.status, tp.STATUS.REJECTED);
  const integration = require('../lib/trade-plan-v2-integration');
  assert.equal(integration.isPlanV2Usable(plan), false);
});

test('42. stale data never becomes usable', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'STALE', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: 1080, atr14: 20, current_price: 1008, data_stale: true
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.data_freshness.is_stale, true);
  const integration = require('../lib/trade-plan-v2-integration');
  assert.equal(integration.isPlanV2Usable(plan), false);
});

test('43. missing TP1 never becomes usable', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'NOTP', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: null, atr14: 20, current_price: 1008
  }, { screener_type: 'DAY_TRADE' });
  assert.equal(plan.tp1, null);
  const integration = require('../lib/trade-plan-v2-integration');
  assert.equal(integration.isPlanV2Usable(plan), false);
});

// ===================================================================
// Per-screener TP1 contract fields exposed
// ===================================================================

test('44. canonical output exposes tp1_target_r and minimum_rr_to_tp1 for all screeners', () => {
  for (const st of ['DAY_TRADE', 'SWING_NON_KONGLO', 'SWING_KONGLO']) {
    const plan = tp.buildTradePlanV2({
      ticker: 'TST', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
      resistance: 1200, atr14: 20, current_price: 1008
    }, { screener_type: st });
    assert.equal(plan.tp1_target_r, tp.SCREENER_PROFILES[st].tp1_target_r);
    assert.equal(plan.minimum_rr_to_tp1, tp.SCREENER_PROFILES[st].min_rr_to_tp1);
  }
});

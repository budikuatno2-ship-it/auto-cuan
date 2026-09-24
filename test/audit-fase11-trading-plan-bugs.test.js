'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const idx = require('../lib/idx-tick-normalization');
const sc = require('../lib/screener-config');
const tp = require('../lib/trade-plan-v2');
const PositionSizing = require('../public/position-sizing-calculator');

// ---------------------------------------------------------------------------
// F11-01: trade-plan-v2 board-agnostic tick helper (FCA Rp1 tick ignored)
// The internal `tick(price, mode)` in lib/trade-plan-v2.js calls
// idx.roundToIdxTick without board/isFca/ticker, so FCA/Akselerasi stocks
// (tick Rp1) are snapped with the regular-board tick table (tick Rp2/5/...)
// producing off-tick SL/TP levels and wrong riskAmount.
// ---------------------------------------------------------------------------
test('F11-01: trade-plan-v2 must respect FCA Rp1 tick for SL/TP (board passthrough)', () => {
  // LUCK is in KNOWN_FCA_TICKERS -> tick must be Rp1 even at price 250.
  // Regular board: price 250 -> tick 2, so 251 snaps to 252.
  // FCA board: 251 stays 251.
  const fcaSL = idx.roundToIdxTick(251, 'nearest', 'AKSELERASI', true, 'LUCK');
  const regularSL = idx.roundToIdxTick(251, 'nearest', null, null, 'BBCA');
  assert.equal(fcaSL, 251, 'FCA 251 must stay 251 (tick 1)');
  assert.equal(regularSL, 252, 'Regular 251 must snap to 252 (tick 2)');
  // But the V2 engine's internal `tick()` helper currently ignores FCA, so the plan's
  // SL uses the regular tick table. We build a plan and check SL is FCA-correct.
  const planFCA = tp.buildTradePlanV2(
    { ticker: 'LUCK', board: 'AKSELERASI', is_fca: true, entry_low: 255, entry_high: 258, support: 245, swing_low: 245, resistance: 275, atr14: 2, current_price: 257 },
    { screener_type: 'DAY_TRADE' }
  );
  // With atr=2, DAY_TRADE buffer = 0.5*2=1, tickFloor=2*tickSize.
  // FCA tickSize=1 -> buffer 2 -> SL = 245-2=243 floor 243.
  // Regular tickSize=2 -> buffer 4 -> SL = 245-4=241 (wrong).
  // Also tick-normalize other levels: FCA keeps 251-like levels valid, regular rejects them.
  assert.equal(planFCA._detail.tick_size, 1, 'FCA tick_size must be 1, not regular-board 2');
  assert.equal(planFCA.stop_loss, 243, 'FCA SL must be 243 (regular would be 241)');
  assert.ok(idx.isValidIdxPriceLevel(planFCA.stop_loss, 'AKSELERASI', true, 'LUCK'), 'FCA SL must be valid under FCA tick rules');
});

// ---------------------------------------------------------------------------
// F11-02: position-sizing isValidIdxTick / calculate ignores FCA (rejects valid FCA prices)
// `isValidIdxTick` and `calculate` use a board-blind idxTickSize, so FCA prices
// like 201, 251, 502 (valid under tick Rp1) are incorrectly rejected.
// ---------------------------------------------------------------------------
test('F11-02: PositionSizing must accept FCA-valid ticks (Rp1)', () => {
  // 251 is invalid on regular board (tick 2), valid on FCA (tick 1)
  assert.equal(idx.isValidIdxPriceLevel(251), false, 'regular 251 must be invalid');
  assert.equal(idx.isValidIdxPriceLevel(251, 'AKSELERASI', true, 'LUCK'), true, 'FCA 251 must be valid');
  // PositionSizing currently rejects FCA-valid entry even when ticker is FCA
  const resRegular = PositionSizing.calculate({ capital: 10000000, riskPct: 1, entry: 251, sl: 240, tp1: 260, tp2: 270 });
  assert.equal(resRegular.isValid, false, 'regular-board 251 must be rejected (tick Rp2)');
  const res = PositionSizing.calculate({ capital: 10000000, riskPct: 1, entry: 251, sl: 240, tp1: 260, tp2: 270, board: 'AKSELERASI', is_fca: true, ticker: 'LUCK' });
  assert.equal(res.isValid, true, 'FCA entry 251 should be accepted (tick Rp1 valid)');
  assert.equal(PositionSizing.isValidIdxTick(251, 'AKSELERASI', true, 'LUCK'), true, 'FCA isValidIdxTick(251) must be true');
});

// ---------------------------------------------------------------------------
// F11-03: sanitizeNumber strips leading non-digit prefix before dot-group analysis, breaking "Rp 10.000"
// "Rp 10.000" is Rp ten thousand and should parse as 10000, not 10.
// The dot-count heuristic runs BEFORE non-numeric stripping, so "Rp 10.000" has groups
// ["Rp 10","000"] and the leading group fails /^\d{1,3}$/, leaving the dot.
// After stripping, "10.000" -> comma->dot is still "10.000" -> Number(10.000)=10.
// This causes the position calculator to treat Rp 10M capital written as "Rp 10.000.000"
// as 10 in some widget paths? For the assignment we test the lower-level helper.
// ---------------------------------------------------------------------------
test('F11-03: sanitizeNumber must parse Rp-prefixed thousand separators correctly', () => {
  assert.equal(PositionSizing.sanitizeNumber('Rp 10.000', -1), 10000, 'Rp 10.000 must be 10000');
  assert.equal(PositionSizing.sanitizeNumber('Rp 1.000.000', -1), 1000000, 'Rp 1.000.000 must be 1000000');
  assert.equal(PositionSizing.sanitizeNumber('Rp 10.000.000', -1), 10000000, 'Rp 10.000.000 must be 10000000');
  // Also check decimal mode still handles commas
  assert.equal(PositionSizing.sanitizeNumber('1,5', -1, { decimal: true }), 1.5, '1,5 decimal must be 1.5');
});

// ---------------------------------------------------------------------------
// F11-04: R-multiple gate without epsilon rejects 1.4999999999999998 as < 1.5
// IEEE-754 rounding of 1.5 computation can produce 1.4999999999999998. A strict
// `value >= 1.5` gate then flips a valid plan to poor-RR / not-executable.
// ---------------------------------------------------------------------------
test('F11-04: RR gate must handle float epsilon near threshold 1.5', () => {
  assert.equal(sc.passesRiskRewardFilter({ risk_reward: 1.4999999999999998 }, 1.5), true, '1.4999999999999998 should pass with epsilon tolerance');
  assert.equal(sc.passesRiskRewardFilter({ risk_reward: 1.499999999 }, 1.5), false, '1.499999999 should still fail (clearly below)');
  assert.equal(sc.passesRiskRewardFilter({ risk_reward: 1.5 }, 1.5), true, 'exact 1.5 must pass');
});

// ---------------------------------------------------------------------------
// F11-05: SL < entry_low check uses entry_high (allows SL == entry_low)
// validateTradingPlanSanity computes `entry = entryHigh || entryLow` and checks sl < entry,
// so a stop exactly on entry_low but below entry_high passes as "valid" even though the
// ranged entry starts at entry_low and SL must be strictly below that lower bound.
// The sibling normalizeTradingPlanLevels correctly flags sl >= entry_low as invalid.
// The two checks must agree.
// ---------------------------------------------------------------------------
test('F11-05: validateTradingPlanSanity must require SL < entry_low (not just < entry_high)', () => {
  const sanity = idx.validateTradingPlanSanity({ entry_low: 200, entry_high: 202, stop_loss: 200, tp1: 210, tp2: 220, risk_reward: 1.5 });
  assert.equal(sanity.trading_plan_valid, false, 'SL == entry_low must be invalid even when < entry_high');
  assert.match(sanity.trading_plan_note, /SL harus di bawah Entry/);
});

// ---------------------------------------------------------------------------
// F11-06: normalizeTradingPlanLevels RR can become Infinity/NaN when risk is 0 or negative after tick snap
// If SL snaps to >= entryHigh, riskAmount=entryHigh-SL <=0. The engine currently does
// `(tp1 - entryRef)/(entryRef - sl)` without guarding the denominator, producing
// Infinity or -Infinity (or NaN when also 0/0). This must be flagged invalid, not
// exposed as a finite-looking RR.
// ---------------------------------------------------------------------------
test('F11-06: R-multiple must be null/invalid when risk is 0 or negative (no Infinity)', () => {
  // Build a V2 plan where SL is forced to sit on entry due to a tiny buffer vs tick size
  // Use a 1-tick scenario: entry 201 (regular tick2 rounds to 202), support 200, ATR tiny so buffer 2 ticks -> SL=200-4=196 correct. Harder to make SL==entry.
  // Instead test the normalization helper's RR computation directly with levels that snap to 0 risk.
  // Choose entry 200, SL raw 199.9 floor regular? 199.9 *? Actually tick for 199.9 is 1 so floor 199, but we force SL exactly 200 via board trick? Another path: entry 50 (tick1), SL 50
  const norm = idx.normalizeTradingPlanLevels({ entry1: 200, entry2: 202, stop_loss: 202, tp1: 210, tp2: 220, board: null });
  assert.ok(!Number.isNaN(norm.risk_reward) || norm.trading_plan_valid === false, 'NaN RR must not survive as valid');
  // More directly, a V2 plan with no usable structural level below entry should REJECT, not emit RR Infinity
  const rejected = tp.buildTradePlanV2(
    { ticker: 'TEST', entry_low: 1000, entry_high: 1010, support: 1005, swing_low: 1005, resistance: 1080, atr14: 1, current_price: 1008 },
    { screener_type: 'DAY_TRADE' }
  );
  // support 1005 above entry 1000 -> no usable level -> REJECTED with NO_STRUCTURAL_LEVEL
  assert.equal(rejected.status, tp.STATUS.REJECTED, 'plan with no support below entry must be rejected');
  // And even when a support exists, a hand-constructed zero-risk must not leak Infinity via screener-config path
  const bad = sc.passesRiskRewardFilter({ risk_reward: Infinity }, 1.5);
  assert.equal(bad, false, 'Infinity RR must not pass the filter');
  const bad2 = sc.passesRiskRewardFilter({ risk_reward: NaN }, 1.5);
  assert.equal(bad2, false, 'NaN RR must not pass the filter');
});

// ---------------------------------------------------------------------------
// F11-07: daytrade-screener-engine calculateLevels must keep levels tick-valid and ordered
// The daytrade engine computes entry_low/high, SL, TP1/TP2 with round0(nearest int) before
// the final tick normalization. At transition boundaries (e.g. 200, 500, 2000, 5000)
// a round0 result can be off-tick, but the V6 final normalization step must repair it.
// Additionally, the refinement path must never leave TP1 <= entry_high or SL >= entry_low.
// This test verifies the post-refinement finalTickResult preserves ordering.
// ---------------------------------------------------------------------------
test('F11-07: daytrade derived levels after tick normalization must satisfy ordering', () => {
  // Craft a boundary case: entry around 200 where SL/TP rounding straddles the tick boundary
  const cand = idx.normalizeTradingPlanLevels({ entry1: 199, entry2: 201, stop_loss: 195, tp1: 205, tp2: 210, board: null });
  if (cand.tick_normalized) {
    assert.ok(cand.stop_loss < cand.entry_low, 'SL must be < entry_low after tick snap');
    assert.ok(cand.tp1 > cand.entry_high, 'TP1 must be > entry_high after tick snap');
    assert.ok(cand.tp2 >= cand.tp1, 'TP2 must be >= TP1');
    assert.ok(idx.isValidIdxPriceLevel(cand.tp1), 'TP1 must be on-tick');
    assert.ok(idx.isValidIdxPriceLevel(cand.stop_loss), 'SL must be on-tick');
  }
  // FCA boundary: entry 500 (tick5 regular) straddling but FCA tick1 must keep SL distinct
  const candFCA = idx.normalizeTradingPlanLevels({ entry1: 500, entry2: 505, stop_loss: 498, tp1: 520, tp2: 540, board: 'AKSELERASI', is_fca: true, ticker: 'LUCK' });
  if (candFCA.tick_normalized) {
    assert.ok(candFCA.stop_loss < candFCA.entry_low, 'FCA SL must still be < entry_low');
  }
});

// ---------------------------------------------------------------------------
// F11-08: position-sizing must floor to lot (100 shares), not ceil
// Verify lots are floored so actual risk never exceeds maxRiskBudget.
// ---------------------------------------------------------------------------
test('F11-08: PositionSizing lots must be floor() (never exceed maxRiskBudget)', () => {
  const res = PositionSizing.calculate({ capital: 10000000, riskPct: 1, entry: 1000, sl: 950, tp1: 1100, tp2: 1200 });
  // maxRiskBudget = 100000, riskPerLot=5000, lots=floor(100k/5000)=20 -> actualRisk 100k exact
  // A ceil would also be 20 here; force a case where ceil would overshoot:
  const res2 = PositionSizing.calculate({ capital: 10000000, riskPct: 1, entry: 1003, sl: 953, tp1: 1100, tp2: 1200 });
  // 1003 not on tick regular (tick5? 1003%5=3) -> isValid fails -> isValid false, so pick valid ticks
  const res3 = PositionSizing.calculate({ capital: 10000000, riskPct: 1, entry: 1000, sl: 955, tp1: 1100, tp2: 1200 });
  // delta 45 -> riskPerLot 4500, lots floor(100000/4500)=22 -> actualRisk 99000 <=100000, ceil would be 23 -> 103500 > budget
  assert.equal(res3.lots, 22, 'floor must give 22 not ceil 23');
  assert.ok(res3.actualRiskIdr <= 100000, 'actual risk must not exceed budget');
  assert.equal(PositionSizing.calculate({ capital: 500000, riskPct: 1, entry: 5000, sl: 4800 }).lots, 0, 'insufficient risk budget -> 0 lot');
});

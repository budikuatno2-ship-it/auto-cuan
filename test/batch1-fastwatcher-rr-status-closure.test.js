'use strict';

/**
 * PR #862 FINAL REVIEW — P0 closure tests.
 *
 * P0-1: FastWatcher internal status must be consistent with entry eligibility.
 *   - entry_eligible already enforced execution minimum R/R >= 1.5, but
 *     `passes` could still be true and `status` could be READY_PASS while the
 *     actual R/R was below the execution minimum. The pool builds the
 *     confirmation window from `result.passes`, so such payloads reached
 *     READY_CONFIRMED and became publishable. These tests drive the REAL
 *     pool.process() path across DISTINCT minutes (not just momentum.evaluate).
 *   - A payload setting minimum_risk_reward=1.0 must never lower the 1.5 floor.
 *   - Stale R/R metadata (claim 3.0 while final levels give 1.0) must be
 *     superseded by recalculation from final levels, without premature
 *     rounding (1.496 must NOT be treated as 1.5).
 *
 * P0-2: extractCandidateLevels must be fail-closed:
 *   1. entry_high=NaN with entry_low=950/sl=900/tp1=1100 must NOT fall back
 *      to the lower entry boundary.
 *   2. Root entry_low=950 + candidate.levels.entry_high=1000 must use the
 *      conservative upper boundary 1000 (R/R 1.0), not 950 (fake R/R 3.0).
 *   3. Levels from different setups/stale snapshots must not be combined to
 *      manufacture a fake valid R/R.
 *   4. Valid legacy aliases (entry1/entry2/sl/tp1n) must keep working.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const screenerConfig = require('../lib/screener-config');
const { passesRiskRewardFilter, recalculateRiskReward, MIN_RR_RATIO } = screenerConfig;
const momentum = require('../lib/intraday-fast-watcher-momentum');
const pool = require('../lib/intraday-fast-watcher-pool');

function shortlist(ticker) {
  return [{ ticker, source_rank: 1, source_status: 'READY_BREAKOUT', source_origin: 'current_radar' }];
}

function observation(ticker, time, overrides = {}) {
  return Object.assign({
    ticker,
    scheduled_time: time,
    current_status: 'READY_BREAKOUT',
    current_price: 100,
    entry_low: 98,
    entry_high: 100,
    tp1: 112,
    stop_loss: 90,
    high: 101,
    low: 97,
    open: 97,
    volume: 5000000,
    average_volume: 2000000,
    relative_volume: 2.0,
    momentum_component: 18,
    liquidity_component: 18,
    minimum_risk_reward: 1.0,
    freshness: { is_stale: false }
  }, overrides);
}

/**
 * Drives the real pool.process() across multiple DISTINCT observation minutes,
 * exactly like the guarded-live pipeline (one process() call per scheduled
 * snapshot, priorState threaded through).
 */
function runPoolMinutes(ticker, minutes, overridesFor, sampleDate = '2026-10-12') {
  let state = null;
  let last = null;
  for (let i = 0; i < minutes.length; i += 1) {
    const time = minutes[i];
    const res = pool.process({
      sampleDate,
      scheduledTime: time,
      shortlistRows: shortlist(ticker),
      observations: [observation(ticker, time, overridesFor ? overridesFor(i, time) : {})],
      priorState: state,
      now: `${sampleDate}T02:${String(59 - i).padStart(2, '0')}:00Z`
    });
    state = res.state;
    last = res;
  }
  return { state, result: last };
}

// ===========================================================================
// P0-1 — pool.process() integration across distinct minutes
// ===========================================================================
test('P0-1a: pool never reaches READY_CONFIRMED for actual R/R 1.2 even with minimum_risk_reward=1.0', () => {
  const minutes = ['09:40', '09:41', '09:42', '09:43', '09:44'];
  const { state, result } = runPoolMinutes('LOWRR', minutes, (i) => ({
    current_price: 100 + i * 0.2,
    volume: 5000000 + i * 100000,
    // actual R/R from final levels: (112-100)/(100-90) = 1.2
    risk_reward: 1.2,
    minimum_risk_reward: 1.0
  }));

  const item = state.tickers.LOWRR;
  assert.notEqual(item.status, 'READY_CONFIRMED', 'R/R 1.2 must never reach READY_CONFIRMED');
  assert.notEqual(item.status, 'READY_PENDING', 'R/R 1.2 must not even build a positive confirmation window');
  assert.equal(item.ready_streak, 0, 'ready_streak must stay 0 for sub-minimum R/R');
  assert.deepEqual(item.confirmation_window, [false, false, false, false, false], 'window must only contain false entries');
  assert.equal(result.confirmed.length, 0, 'confirmed list must be empty');
  assert.equal(result.publishable.length, 0, 'publishable list must be empty');
  assert.ok(
    item.last_reasons.includes('risk_reward_below_execution_minimum'),
    'reason must record the sub-execution-minimum R/R (1.2 >= minimum_risk_reward 1.0 but < 1.5)'
  );
});

test('P0-1b: pool publishes a legitimate R/R 1.6 setup after 3 distinct minutes (no over-blocking)', () => {
  // actual R/R: (116-100)/(100-90) = 1.6
  const minutes = ['09:40', '09:41', '09:42'];
  const { state, result } = runPoolMinutes('OKRR', minutes, (i) => ({
    current_price: 100 + i * 0.2,
    tp1: 116,
    volume: 5000000 + i * 100000,
    risk_reward: 1.6
  }));

  const item = state.tickers.OKRR;
  assert.equal(item.status, 'READY_CONFIRMED', 'R/R 1.6 setup must confirm after 3 distinct minutes');
  assert.equal(item.ready_streak, 3);
  assert.deepEqual(item.confirmation_window, [true, true, true]);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.publishable.length, 1);
  assert.equal(result.publishable[0].ticker, 'OKRR');
});

test('P0-1c: stale R/R metadata (claim 3.0, actual 1.0) cannot confirm via pool.process', () => {
  const minutes = ['09:40', '09:41', '09:42'];
  const { state, result } = runPoolMinutes('STAKE', minutes, (i) => ({
    current_price: 100,
    entry_low: 98,
    entry_high: 100,
    stop_loss: 90,
    tp1: 110, // actual R/R: (110-100)/(100-90) = 1.0
    risk_reward: 3.0, // stale metadata claim
    minimum_risk_reward: 1.0,
    volume: 5000000 + i * 100000
  }));

  const item = state.tickers.STAKE;
  assert.notEqual(item.status, 'READY_CONFIRMED');
  assert.equal(result.publishable.length, 0, 'stale metadata must not manufacture publishable status');
  assert.equal(item.locked_risk_reward, 1, 'locked R/R must be the value derived from final levels');
  assert.ok(
    item.last_reasons.includes('risk_reward_below_execution_minimum'),
    'reason must reflect the ACTUAL R/R (1.0 < execution floor 1.5), not the stale claim'
  );
  // The stale 3.0 claim must never surface as an effective R/R anywhere.
  assert.notEqual(item.last_metrics.risk_reward, 3.0);
  assert.notEqual(item.last_metrics.reported_risk_reward, 3.0);
});

test('P0-1d: R/R 1.496 from final levels is not rounded to 1.5 anywhere in the pool pipeline', () => {
  // entry 2000, SL 1000, TP1 3496 => raw R/R = 1.496
  const minutes = ['09:40', '09:41', '09:42'];
  const { state, result } = runPoolMinutes('ROUND', minutes, (i) => ({
    current_price: 2000,
    entry_low: 1990,
    entry_high: 2000,
    stop_loss: 1000,
    tp1: 3496,
    risk_reward: 1.496,
    minimum_risk_reward: 1.0,
    volume: 5000000 + i * 100000
  }));

  const item = state.tickers.ROUND;
  assert.equal(item.locked_risk_reward, 1.496, 'locked R/R must be the raw 1.496, never 1.5');
  assert.equal(item.last_metrics.risk_reward, 1.496, 'metrics must keep the raw value');
  assert.notEqual(item.status, 'READY_CONFIRMED', '1.496 < 1.5 must never confirm');
  assert.equal(result.publishable.length, 0);
});

test('P0-1e: momentum.evaluate keeps passes/status/entry_eligible consistent below execution minimum', () => {
  const evaluated = momentum.evaluate(observation('CONSIS', '09:45', {
    risk_reward: 1.2,
    minimum_risk_reward: 1.0
  }), {});

  assert.equal(evaluated.entry_eligible, false);
  assert.equal(evaluated.passes, false, 'passes must agree with entry_eligible');
  assert.notEqual(evaluated.status, 'READY_PASS', 'READY_PASS requires execution-minimum R/R');
  assert.equal(evaluated.status, 'WATCHING', 'sub-minimum R/R remains an informational watch only');
  assert.ok(
    evaluated.reasons.includes('risk_reward_below_execution_minimum'),
    'execution-minimum reason must fire when metadata minimum (1.0) is below the execution floor (1.5)'
  );
});

test('P0-1f: momentum.metricsFrom supersedes stale metadata with derived final-level R/R (no premature rounding)', () => {
  const metrics = momentum.metricsFrom({
    entry_high: 100,
    stop_loss: 90,
    tp1: 110,
    risk_reward: 3.0 // stale claim
  });
  assert.equal(metrics.risk_reward, 1, 'derived R/R from final levels must win over stale metadata');
  assert.equal(metrics.reported_risk_reward, 3.0, 'stale metadata stays observable for diagnostics');
  assert.equal(metrics.risk_reward_source, 'derived_final_levels');

  const raw = momentum.metricsFrom({
    entry_high: 2000,
    stop_loss: 1000,
    tp1: 3496,
    risk_reward: 1.5
  });
  assert.equal(raw.risk_reward, 1.496, 'derived R/R must not be rounded to 2 decimals before the gate');
});

// ===========================================================================
// P0-2 — extractCandidateLevels fail-closed
// ===========================================================================
test('P0-2a: explicit invalid entry_high=NaN fails closed instead of falling back to entry_low', () => {
  const candidate = { entry_high: NaN, entry_low: 950, stop_loss: 900, tp1: 1100 };
  assert.equal(recalculateRiskReward(candidate), null, 'NaN upper boundary must not produce an R/R');
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO), false);
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true }), false);

  // A stale metadata claim must not rescue the invalid explicit level either.
  const withStaleClaim = Object.assign({ risk_reward: 3.0 }, candidate);
  assert.equal(passesRiskRewardFilter(withStaleClaim, MIN_RR_RATIO), false);
  assert.equal(passesRiskRewardFilter(withStaleClaim, MIN_RR_RATIO, { recalculate: true }), false);
});

test('P0-2b: conservative upper boundary wins over a lower root entry (no fake 3.0 R/R)', () => {
  const candidate = {
    entry_low: 950,
    stop_loss: 900,
    tp1: 1100,
    levels: { entry_high: 1000 }
  };
  // Using entry 950 would fake R/R 3.0; the conservative boundary 1000 yields 1.0.
  assert.equal(recalculateRiskReward(candidate), 1, 'upper boundary 1000 must be used, giving R/R 1.0');
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO), false, 'R/R 1.0 must fail the 1.5 gate');
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true }), false);
});

test('P0-2c: levels from different setups/stale snapshots cannot be combined into a fake valid R/R', () => {
  // Root carries entry_high + SL (setup A), nested levels carry only TP1 (setup B).
  const mixed = { entry_high: 1000, stop_loss: 900, levels: { tp1: 1600 } };
  assert.equal(recalculateRiskReward(mixed), null, 'entry/SL from setup A + TP1 from setup B must fail closed');
  assert.equal(passesRiskRewardFilter(mixed, MIN_RR_RATIO, { recalculate: true }), false);

  // Root carries entry_high + TP1 (setup A), nested levels carry only SL (setup B).
  const mixedInverse = { entry_high: 1000, tp1: 1600, levels: { stop_loss: 900 } };
  assert.equal(recalculateRiskReward(mixedInverse), null, 'entry/TP1 from setup A + SL from setup B must fail closed');

  // Partial levels (only an entry boundary) with stale metadata must fail closed.
  const partial = { entry_high: 1000, risk_reward: 3.0 };
  assert.equal(passesRiskRewardFilter(partial, MIN_RR_RATIO), false, 'partial levels cannot lean on stale metadata');
});

test('P0-2d: valid legacy aliases keep working (entry1/entry2/sl/tp1n and nested metrics)', () => {
  const legacyValid = {
    entry1: 9000,
    entry2: 9100, // conservative upper boundary
    sl: 8800,     // risk 300
    tp1n: 9600,   // reward 500 => R/R 1.666...
    risk_reward: 1.67
  };
  assert.ok(recalculateRiskReward(legacyValid) >= 1.66);
  assert.equal(passesRiskRewardFilter(legacyValid, MIN_RR_RATIO, { recalculate: true }), true);

  const legacyInvalid = Object.assign({}, legacyValid, { tp1n: 9450, risk_reward: 1.17 }); // R/R 1.166...
  assert.equal(passesRiskRewardFilter(legacyInvalid, MIN_RR_RATIO, { recalculate: true }), false);

  const nestedValid = {
    ticker: 'BBRI',
    observation: {
      metrics: {
        entry_high: 4000,
        stop_loss: 3800,
        tp1: 4350, // R/R 1.75
        risk_reward: 1.75
      }
    }
  };
  assert.equal(passesRiskRewardFilter(nestedValid, MIN_RR_RATIO, { recalculate: true }), true);

  const aliasComplete = { entry_high: 1000, sl: 900, tp1n: 1150 };
  assert.equal(recalculateRiskReward(aliasComplete), 1.5, 'entry_high/sl/tp1n cross-alias in ONE source stays supported');
  assert.equal(passesRiskRewardFilter(aliasComplete, MIN_RR_RATIO, { recalculate: true }), true);
});

test('P0-2e: explicit invalid stop_loss/tp1 values fail closed instead of silent fallback', () => {
  const badStop = { entry_high: 1000, stop_loss: NaN, tp1: 1200, risk_reward: 5.0 };
  assert.equal(recalculateRiskReward(badStop), null);
  assert.equal(passesRiskRewardFilter(badStop, MIN_RR_RATIO), false);

  const badTarget = { entry_high: 1000, stop_loss: 900, tp1: Infinity, risk_reward: 5.0 };
  assert.equal(recalculateRiskReward(badTarget), null);
  assert.equal(passesRiskRewardFilter(badTarget, MIN_RR_RATIO), false);

  const negative = { entry_high: 1000, stop_loss: -100, tp1: 1200, risk_reward: 5.0 };
  assert.equal(recalculateRiskReward(negative), null);
  assert.equal(passesRiskRewardFilter(negative, MIN_RR_RATIO), false);
});

// ===========================================================================
// P0-2f..i — FINAL REVIEW: root explicit invalid SL/TP1 must not be rescued
// by a complete nested pair. Root final levels take precedence; the SL/TP1
// pair must be complete in ONE source AND match the entry source provenance.
// ===========================================================================
test('P0-2f: root stop_loss=1100 (invalid) is NOT rescued by nested valid pair => fail-closed', () => {
  const candidate = {
    entry_high: 1000,
    stop_loss: 1100, // explicit invalid: SL above entry
    levels: { entry_high: 1000, stop_loss: 900, tp1: 1200 } // complete nested pair
  };
  assert.equal(recalculateRiskReward(candidate), null, 'nested pair must not rescue invalid root SL');
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO), false);
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true }), false);

  // The public Telegram safety gate must also reject it.
  const sectorHot = require('../api/sector-hot');
  const gate = sectorHot.__test && sectorHot.__test.candidatePassesPublicTelegramSafetyGate;
  assert.ok(typeof gate === 'function', 'public safety gate must be exposed');
  assert.equal(gate({ ticker: 'BBCA', category: 'daytrade', last_price: 1000, status: 'READY_BREAKOUT', ...candidate }, 'daytrade'), false);
});

test('P0-2g: root tp1=900 (invalid) is NOT rescued by nested pair => fail-closed', () => {
  const candidate = {
    entry_high: 1000,
    tp1: 900, // explicit invalid: TP1 below entry
    levels: { stop_loss: 900, tp1: 1200 }
  };
  assert.equal(recalculateRiskReward(candidate), null, 'nested pair must not rescue invalid root TP1');
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO), false);
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true }), false);
});

test('P0-2h: entry from root + SL/TP1 pair from nested is mixed provenance => fail-closed', () => {
  const candidate = {
    entry_high: 1000,
    levels: { stop_loss: 900, tp1: 1600 } // nested pair, no nested entry
  };
  assert.equal(
    recalculateRiskReward(candidate),
    null,
    'root entry + nested pair cannot be proven same-setup; fake R/R 6.0 must not materialize'
  );
  assert.equal(passesRiskRewardFilter(candidate, MIN_RR_RATIO, { recalculate: true }), false);

  // Partial pair in the nested source (only SL) must also fail closed, even
  // when a lower nested source carries the TP1.
  const partialNested = {
    entry_high: 1000,
    levels: { stop_loss: 900 },
    trade_plan_v2: { tp1: 1600 }
  };
  assert.equal(recalculateRiskReward(partialNested), null, 'partial pair must not be completed from another source');
  assert.equal(passesRiskRewardFilter(partialNested, MIN_RR_RATIO, { recalculate: true }), false);
});

test('P0-2i: structurally invalid pair (SL >= entry or TP1 <= entry) fails closed without substitution', () => {
  // Root pair invalid, nested pair valid => root final wins => fail-closed.
  const invalidRootPair = {
    entry_high: 1000,
    stop_loss: 1000, // SL == entry
    tp1: 1200,
    levels: { stop_loss: 900, tp1: 1400 }
  };
  assert.equal(recalculateRiskReward(invalidRootPair), null);
  assert.equal(passesRiskRewardFilter(invalidRootPair, MIN_RR_RATIO, { recalculate: true }), false);

  const tpBelowEntry = {
    entry_high: 1000,
    stop_loss: 900,
    tp1: 1000, // TP1 == entry
    levels: { stop_loss: 800, tp1: 1300 }
  };
  assert.equal(recalculateRiskReward(tpBelowEntry), null);
  assert.equal(passesRiskRewardFilter(tpBelowEntry, MIN_RR_RATIO, { recalculate: true }), false);
});

test('P0-2j: legitimate payloads keep passing (nested-only, aliases, complete setup, production nested metrics)', () => {
  // Nested-only valid setup: single source provides entry + pair.
  const nestedOnly = { levels: { entry_high: 1000, stop_loss: 900, tp1: 1200 } };
  assert.equal(recalculateRiskReward(nestedOnly), 2);
  assert.equal(passesRiskRewardFilter(nestedOnly, MIN_RR_RATIO, { recalculate: true }), true);

  // Legacy aliases inside ONE source stay supported.
  const aliasLegacy = { entry_high: 1000, sl: 900, tp1n: 1200 };
  assert.equal(recalculateRiskReward(aliasLegacy), 2);
  assert.equal(passesRiskRewardFilter(aliasLegacy, MIN_RR_RATIO, { recalculate: true }), true);

  // Complete root setup with R/R >= 1.5 stays executable.
  const complete = { entry_low: 98, entry_high: 100, stop_loss: 90, tp1: 116 };
  assert.equal(recalculateRiskReward(complete), 1.6);
  assert.equal(passesRiskRewardFilter(complete, MIN_RR_RATIO, { recalculate: true }), true);

  // Production nested metrics shape (FastWatcher publisher observation).
  const production = {
    ticker: 'BBRI',
    observation: { metrics: { entry_high: 4000, stop_loss: 3800, tp1: 4350 } }
  };
  assert.equal(recalculateRiskReward(production), 1.75);
  assert.equal(passesRiskRewardFilter(production, MIN_RR_RATIO, { recalculate: true }), true);

  // Root-level entry + pair in the SAME source (production root rows) stays valid.
  const rootComplete = { entry_high: 4000, stop_loss: 3800, tp1: 4350 };
  assert.equal(recalculateRiskReward(rootComplete), 1.75);
  assert.equal(passesRiskRewardFilter(rootComplete, MIN_RR_RATIO, { recalculate: true }), true);
});

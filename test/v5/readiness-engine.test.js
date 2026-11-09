'use strict';

/**
 * test/v5/readiness-engine.test.js
 * ============================================================================
 * UNIT TESTS — lib/readiness-engine.js (BUG-V5-P0-003 / BUG-V5-P0-005)
 * ============================================================================
 *
 * These tests are the *proof* that the readiness verdict can no longer be
 * contradicted by the candidate's own numbers. They are deliberately written to
 * be falsifiable:
 *
 *   - `rr = 1.39` MUST be REJECTED (the documented PANI case).
 *   - `rr = 1.5` MUST be allowed to proceed (the policy boundary, inclusive).
 *   - `rr = null` MUST be INSUFFICIENT_DATA, never READY.
 *   - Stale data older than the policy window MUST be EXPIRED.
 *   - Structurally invalid OHLCV MUST be REJECTED.
 *   - Zero / unknown volume MUST NOT yield READY.
 *   - A claimed waiver MUST grant nothing.
 *   - PROPERTY: across a large synthetic cross-product, READY is IMPOSSIBLE
 *     whenever any required numeric is null.
 *
 * Run:
 *   node test/v5/readiness-engine.test.js
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 * ============================================================================
 */

const path = require('node:path');
const assert = require('node:assert');

const R = require(path.resolve(__dirname, '..', '..', 'lib', 'readiness-engine.js'));
const cfg = require(path.resolve(__dirname, '..', '..', 'lib', 'screener-config.js'));

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write('PASS  ' + name + '\n');
  } catch (err) {
    results.push({ name, ok: false, error: String((err && err.message) || err) });
    process.stdout.write('FAIL  ' + name + '\n      ' + String((err && err.message) || err) + '\n');
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Fixed clock: 2026-11-05 10:00 WIB. The engine never reads the real clock. */
const NOW = Date.parse('2026-11-05T10:00:00+07:00');

const POLICY = Object.freeze({
  minRiskReward: cfg.MIN_RR_RATIO,
  maxStalenessMinutes: 1440,
  minVolume: 1,
  minLiquidityValue: 0,
  now: NOW
});

/**
 * A fully valid, fresh, actionable candidate.
 * entry 1420 / sl 1349 / tp1 1519  =>  rr = (1519-1420)/(1420-1349) = 99/71 = 1.394
 */
function baseCandidate(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    last_price: 1425,
    entry_high: 1420,
    entry_low: 1399,
    stop_loss: 1349,
    tp1: 1560,          // (1560-1420)/(1420-1349) = 140/71 = 1.97
    tp2: 1650,
    volume: 25000000,
    liquidity_idr: 12000000000,
    trade_date: '2026-11-05',
    data_status: 'AVAILABLE',
    source_status: 'MOMENTUM',
    stale: false
  }, overrides || {});
}

/* -------------------------------------------------------------------------- */
/* 1. Status vocabulary                                                       */
/* -------------------------------------------------------------------------- */

test('STATUS exposes exactly the six mandated states', () => {
  assert.deepStrictEqual(Object.keys(R.STATUS), [
    'READY', 'WATCH', 'WAITING_CONFIRMATION', 'INSUFFICIENT_DATA', 'EXPIRED', 'REJECTED'
  ]);
  assert.strictEqual(Object.isFrozen(R.STATUS), true);
  assert.strictEqual(R.STATUS_VALUES.length, 6);
  // The legacy literal vocabulary must NOT be reachable from the engine.
  for (const legacy of ['A+', 'SIAP ENTRY', 'BUY', 'READY BREAKOUT']) {
    assert.strictEqual(R.STATUS_VALUES.indexOf(legacy), -1, legacy + ' must not be a status');
  }
});

test('default policy minimum is the repository R/R policy (1.5)', () => {
  assert.strictEqual(R.DEFAULT_POLICY.minRiskReward, 1.5);
  assert.strictEqual(cfg.MIN_RR_RATIO, 1.5);
});

/* -------------------------------------------------------------------------- */
/* 2. The documented PANI case: rr = 1.39                                     */
/* -------------------------------------------------------------------------- */

test('rr=1.39 => REJECTED with reason RR_BELOW_MIN (the PANI case)', () => {
  // Exactly the documented contradiction: a plan whose own levels give 1.39.
  const pani = {
    ticker: 'PANI',
    last_price: 1420,
    entry_low: 1399,
    entry_high: 1420,
    stop_loss: 1349,
    tp1: 1519,
    // The producer's stale metadata claimed a passing ratio.
    rr: 1.39,
    risk_reward: 1.39,
    volume: 34100000,
    trade_date: '2026-11-05',
    data_status: 'AVAILABLE',
    status: 'READY',
    action: 'BUY',
    quality_grade: 'A+',
    risk_label: 'Low Risk',
    safe: true,
    trading_plan_valid: true
  };

  const res = R.evaluate(pani, POLICY);

  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.RR_BELOW_MIN), JSON.stringify(res.reasons));
  assert.strictEqual(res.rr, 1.39);
  assert.strictEqual(res.gateResults.riskReward.pass, false);
  assert.strictEqual(res.gateResults.riskReward.minRiskReward, 1.5);
  // The engine must not echo the caller's optimistic fields as a verdict.
  assert.strictEqual(R.actionForStatus(res.status), null);
  assert.strictEqual(R.isReady(res), false);
});

test('the R/R veto outranks every other otherwise-passing gate', () => {
  const otherwisePerfect = baseCandidate({ entry_high: 1420, stop_loss: 1349, tp1: 1519, rr: 1.39 });
  const res = R.evaluate(otherwisePerfect, POLICY);
  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.RR_BELOW_MIN));
  // Gate results prove the other gates were never consulted to soften it.
  assert.strictEqual(res.gateResults.ohlcv.pass, true);
  assert.strictEqual(res.gateResults.riskReward.outcome, 'BELOW_MINIMUM');
});

test('a stale metadata rr cannot rescue a plan whose levels yield 1.39', () => {
  const res = R.evaluate(baseCandidate({
    entry_high: 1420, stop_loss: 1349, tp1: 1519,
    rr: 2.4,                 // optimistic metadata
    risk_reward: 2.4
  }), POLICY);
  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.RR_BELOW_MIN));
  assert.ok(res.reasons.includes(R.REASON.RR_CONTRADICTS_REPORTED), JSON.stringify(res.reasons));
  assert.strictEqual(res.gateResults.riskReward.effective, 1.39);
});

/* -------------------------------------------------------------------------- */
/* 3. The policy boundary: rr = 1.5                                           */
/* -------------------------------------------------------------------------- */

test('rr=1.5 is allowed to proceed (inclusive boundary, not rejected)', () => {
  // entry 1420, sl 1340, tp1 1540 => (1540-1420)/(1420-1340) = 120/80 = 1.5 exactly
  const res = R.evaluate(baseCandidate({
    entry_high: 1420, stop_loss: 1340, tp1: 1540
  }), POLICY);

  assert.notStrictEqual(res.status, R.STATUS.REJECTED, JSON.stringify(res.reasons));
  assert.strictEqual(res.rr, 1.5);
  assert.strictEqual(res.gateResults.riskReward.pass, true);
  assert.strictEqual(res.reasons.includes(R.REASON.RR_BELOW_MIN), false);
});

test('a fully valid candidate at rr>=1.5 reaches READY', () => {
  const res = R.evaluate(baseCandidate(), POLICY);
  assert.strictEqual(res.status, R.STATUS.READY, JSON.stringify({ reasons: res.reasons, gates: res.gateResults }));
  assert.ok(res.reasons.includes(R.REASON.ALL_GATES_PASSED));
  assert.strictEqual(R.actionForStatus(res.status), 'BUY');
  assert.strictEqual(R.isReady(res), true);
});

test('rr just above the boundary passes: 1.5001', () => {
  // entry 1000, sl 1000-100000 ... use clean numbers: entry 1000, sl 900, tp1 1150.01 => 1.50001
  const res = R.evaluate({
    ticker: 'TEST', last_price: 1000, entry_high: 1000, stop_loss: 900, tp1: 1150.01,
    volume: 1000000, trade_date: '2026-11-05', data_status: 'AVAILABLE'
  }, POLICY);
  assert.notStrictEqual(res.status, R.STATUS.REJECTED);
});

test('rr just below the boundary is rejected: 1.4999', () => {
  const res = R.evaluate({
    ticker: 'TEST', last_price: 1000, entry_high: 1000, stop_loss: 900, tp1: 1149.99,
    volume: 1000000, trade_date: '2026-11-05', data_status: 'AVAILABLE'
  }, POLICY);
  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.RR_BELOW_MIN));
});

/* -------------------------------------------------------------------------- */
/* 4. Unknown R/R                                                             */
/* -------------------------------------------------------------------------- */

test('rr=null with complete levels is recomputed, not assumed', () => {
  const res = R.evaluate(baseCandidate({ rr: null, risk_reward: null }), POLICY);
  // Levels give 1.97, so the engine derives it rather than failing.
  assert.strictEqual(res.rr, 1.97);
  assert.strictEqual(res.status, R.STATUS.READY, JSON.stringify(res.reasons));
});

test('rr=null with incomplete levels => INSUFFICIENT_DATA, never READY', () => {
  const res = R.evaluate(baseCandidate({
    rr: null, risk_reward: null, stop_loss: null, sl: null
  }), POLICY);
  assert.strictEqual(res.status, R.STATUS.INSUFFICIENT_DATA);
  assert.ok(res.reasons.includes(R.REASON.RR_UNKNOWN));
  assert.strictEqual(R.isReady(res), false);
  assert.strictEqual(R.actionForStatus(res.status), null);
});

test('NaN / Infinity / empty-string R/R are all treated as unknown, not as a pass', () => {
  for (const bad of [NaN, Infinity, -Infinity, '', 'abc']) {
    const res = R.evaluate(baseCandidate({
      rr: bad, risk_reward: bad, stop_loss: null, sl: null
    }), POLICY);
    assert.strictEqual(res.status, R.STATUS.INSUFFICIENT_DATA, 'value=' + String(bad));
    assert.ok(res.reasons.includes(R.REASON.RR_UNKNOWN), 'value=' + String(bad));
  }
});

/* -------------------------------------------------------------------------- */
/* 5. Staleness / expiry                                                      */
/* -------------------------------------------------------------------------- */

test('STALE older than maxStalenessMinutes => EXPIRED', () => {
  // 2026-11-04 00:00 WIB is 34 hours before the injected clock -> 2040 minutes.
  const res = R.evaluate(baseCandidate({
    trade_date: '2026-11-04',
    data_status: 'STALE',
    stale: true
  }), POLICY);

  assert.strictEqual(res.status, R.STATUS.EXPIRED, JSON.stringify(res.reasons));
  assert.ok(res.reasons.includes(R.REASON.DATA_EXPIRED));
  assert.strictEqual(res.gateResults.freshness.ageMinutes, 2040);
  assert.strictEqual(R.isReady(res), false);
});

test('STALE within the tolerance window => WAITING_CONFIRMATION, not READY', () => {
  // 2026-11-05 00:00 WIB is 10 hours before the clock -> 600 minutes < 1440.
  const res = R.evaluate(baseCandidate({
    trade_date: '2026-11-05',
    data_status: 'STALE',
    stale: true
  }), POLICY);

  assert.strictEqual(res.status, R.STATUS.WAITING_CONFIRMATION, JSON.stringify(res.reasons));
  assert.ok(res.reasons.includes(R.REASON.DATA_STALE_WITHIN_TOLERANCE));
  assert.strictEqual(R.isReady(res), false);
});

test('a row the producer marked stale cannot be READY even when data_status says AVAILABLE', () => {
  const res = R.evaluate(baseCandidate({
    trade_date: '2026-11-04',
    data_status: 'AVAILABLE',
    stale: true
  }), POLICY);
  assert.notStrictEqual(res.status, R.STATUS.READY);
  assert.strictEqual(res.status, R.STATUS.EXPIRED);
});

test('BUG-V5-P0 candidate: EXPIRED trade_date with AVAILABLE data_status and NO stale flag is NOT READY', () => {
  // The exact defect: a row says AVAILABLE and has no `stale` signal, but its
  // trade_date is 34h old (2040 minutes > 1440 window). It must degrade to
  // EXPIRED rather than silently pass as READY.
  const c = baseCandidate({
    trade_date: '2026-11-04',
    data_status: 'AVAILABLE'
  });
  delete c.stale; // stale field missing/unset entirely
  const res = R.evaluate(c, POLICY);
  assert.strictEqual(res.status, R.STATUS.EXPIRED, JSON.stringify(res.reasons));
  assert.ok(res.reasons.includes(R.REASON.DATA_EXPIRED), JSON.stringify(res.reasons));
  assert.strictEqual(res.gateResults.freshness.outcome, 'EXPIRED');
  assert.strictEqual(res.gateResults.freshness.pass, false);
  assert.strictEqual(R.isReady(res), false);
});

test('fresh AVAILABLE trade_date within the window with no stale flag stays READY', () => {
  // Freshness is preserved: a within-window AVAILABLE row (10h old) without any
  // stale signal remains READY — the new rule must not over-degrade.
  const c = baseCandidate({ trade_date: '2026-11-05', data_status: 'AVAILABLE' });
  delete c.stale;
  const res = R.evaluate(c, POLICY);
  assert.strictEqual(res.status, R.STATUS.READY, JSON.stringify({ reasons: res.reasons, gates: res.gateResults }));
  assert.strictEqual(res.gateResults.freshness.outcome, 'AVAILABLE');
});

test('PARTIAL data cannot be READY', () => {
  const res = R.evaluate(baseCandidate({ data_status: 'PARTIAL' }), POLICY);
  assert.strictEqual(res.status, R.STATUS.WAITING_CONFIRMATION);
  assert.ok(res.reasons.includes(R.REASON.DATA_PARTIAL));
});

test('every non-AVAILABLE data status is barred from READY', () => {
  const barred = ['PARTIAL', 'STALE', 'NOT_PUBLISHED', 'SOURCE_UNAVAILABLE', 'VALIDATION_FAILED', 'QUARANTINED'];
  for (const status of barred) {
    const res = R.evaluate(baseCandidate({ data_status: status }), POLICY);
    assert.notStrictEqual(res.status, R.STATUS.READY, 'status=' + status);
    assert.strictEqual(R.actionForStatus(res.status), null, 'status=' + status);
  }
});

test('an absent data_status cannot be READY', () => {
  const c = baseCandidate();
  delete c.data_status;
  const res = R.evaluate(c, POLICY);
  assert.notStrictEqual(res.status, R.STATUS.READY);
  assert.ok(res.reasons.includes(R.REASON.DATA_NOT_AVAILABLE));
});

/* -------------------------------------------------------------------------- */
/* 6. OHLCV and structural rejection                                          */
/* -------------------------------------------------------------------------- */

test('invalid OHLCV => REJECTED with INVALID_OHLCV', () => {
  const res = R.evaluate(baseCandidate({
    ohlcv: [
      { open: 100, high: 110, low: 90, close: 105, volume: 1000 },
      { open: 100, high: 90, low: 110, close: 100, volume: 1000 } // high < low
    ]
  }), POLICY);

  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.INVALID_OHLCV));
  assert.strictEqual(res.gateResults.ohlcv.pass, false);
  assert.strictEqual(res.gateResults.ohlcv.violations.length, 1);
});

test('negative volume bar => REJECTED with INVALID_OHLCV', () => {
  const res = R.evaluate(baseCandidate({
    candles: [{ open: 100, high: 110, low: 90, close: 105, volume: -5 }]
  }), POLICY);
  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.INVALID_OHLCV));
});

test('structurally invalid plan (sl >= entry) => REJECTED', () => {
  const res = R.evaluate(baseCandidate({
    entry_high: 1420, stop_loss: 1420, tp1: 1560
  }), POLICY);
  assert.strictEqual(res.status, R.STATUS.REJECTED);
  assert.ok(res.reasons.includes(R.REASON.TRADE_PLAN_STRUCTURALLY_INVALID));
});

test('valid OHLCV is accepted and does not by itself block READY', () => {
  const res = R.evaluate(baseCandidate({
    ohlcv: [{ open: 1410, high: 1430, low: 1400, close: 1425, volume: 1000 }]
  }), POLICY);
  assert.strictEqual(res.gateResults.ohlcv.pass, true);
  assert.strictEqual(res.status, R.STATUS.READY);
});

/* -------------------------------------------------------------------------- */
/* 7. Volume / liquidity                                                      */
/* -------------------------------------------------------------------------- */

test('zero volume is never READY', () => {
  const res = R.evaluate(baseCandidate({ volume: 0 }), POLICY);
  assert.notStrictEqual(res.status, R.STATUS.READY, JSON.stringify(res.reasons));
  assert.ok(res.reasons.includes(R.REASON.VOLUME_ZERO), JSON.stringify(res.reasons));
  assert.strictEqual(res.gateResults.volume.pass, false);
  assert.strictEqual(R.actionForStatus(res.status), null);
});

test('unknown volume is never READY', () => {
  const c = baseCandidate();
  delete c.volume;
  delete c.volume_today;
  const res = R.evaluate(c, POLICY);
  assert.notStrictEqual(res.status, R.STATUS.READY);
  assert.ok(res.reasons.includes(R.REASON.VOLUME_UNKNOWN));
});

test('a genuine zero survives as zero — it is not confused with absent volume', () => {
  const res = R.evaluate(baseCandidate({ volume: 0 }), POLICY);
  // The point: 0 is READ, reported and rejected as zero — not silently replaced.
  assert.strictEqual(res.gateResults.volume.values[0], 0);
  assert.strictEqual(res.gateResults.volume.outcome, 'VOLUME_ZERO');
});

test('liquidity below the policy floor is never READY', () => {
  const res = R.evaluate(baseCandidate({ liquidity_idr: 1000 }), {
    minRiskReward: 1.5, maxStalenessMinutes: 1440, minVolume: 1,
    minLiquidityValue: 5000000000, now: NOW
  });
  assert.notStrictEqual(res.status, R.STATUS.READY);
  assert.ok(res.reasons.includes(R.REASON.LIQUIDITY_BELOW_MIN));
});

test('unknown liquidity is never READY once a floor is set', () => {
  const c = baseCandidate();
  delete c.liquidity_idr;
  const res = R.evaluate(c, {
    minRiskReward: 1.5, maxStalenessMinutes: 1440, minVolume: 1,
    minLiquidityValue: 5000000000, now: NOW
  });
  assert.notStrictEqual(res.status, R.STATUS.READY);
  assert.ok(res.reasons.includes(R.REASON.LIQUIDITY_UNKNOWN));
});

/* -------------------------------------------------------------------------- */
/* 8. No waiver path                                                          */
/* -------------------------------------------------------------------------- */

test('a claimed waiver grants nothing on a 1.39 plan', () => {
  const res = R.evaluate(baseCandidate({
    entry_high: 1420, stop_loss: 1349, tp1: 1519,
    fusion_waived: true, waived: true, waiver: true, override: true
  }), POLICY);

  assert.strictEqual(res.status, R.STATUS.REJECTED, 'the waiver must not lift the veto');
  assert.ok(res.reasons.includes(R.REASON.RR_BELOW_MIN));
  assert.ok(res.reasons.includes(R.REASON.WAIVER_IGNORED), JSON.stringify(res.reasons));
  assert.strictEqual(res.gateResults.waiver.claimed, true);
  assert.strictEqual(res.gateResults.waiver.outcome, 'IGNORED_NO_WAIVER_PATH');
});

test('policy.allowWaiver cannot be turned on from outside', () => {
  const res = R.evaluate(baseCandidate({
    entry_high: 1420, stop_loss: 1349, tp1: 1519
  }), Object.assign({}, POLICY, { allowWaiver: true, minRiskReward: 0.1 }));
  // allowWaiver is forced false; minRiskReward IS honoured (it is the policy).
  assert.strictEqual(res.gateResults.riskReward.pass, true, 'explicit policy minimum 0.1 is honoured');
  const stillRejected = R.evaluate(baseCandidate({
    entry_high: 1420, stop_loss: 1349, tp1: 1519, waived: true
  }), POLICY);
  assert.strictEqual(stillRejected.status, R.STATUS.REJECTED);
});

/* -------------------------------------------------------------------------- */
/* 9. Purity / determinism                                                    */
/* -------------------------------------------------------------------------- */

test('evaluate() does not mutate its input', () => {
  const input = baseCandidate();
  const snapshot = JSON.stringify(input);
  R.evaluate(input, POLICY);
  assert.strictEqual(JSON.stringify(input), snapshot);
});

test('evaluate() is deterministic for identical arguments', () => {
  const input = baseCandidate();
  const a = R.evaluate(input, POLICY);
  const b = R.evaluate(input, POLICY);
  assert.deepStrictEqual(
    { status: a.status, reasons: a.reasons.slice(), rr: a.rr },
    { status: b.status, reasons: b.reasons.slice(), rr: b.rr }
  );
});

test('evaluate() reads no clock: without policy.now, staleness age is unknown', () => {
  const res = R.evaluate(baseCandidate({ trade_date: '2020-01-01', data_status: 'STALE' }), {
    minRiskReward: 1.5, maxStalenessMinutes: 1440
  });
  assert.strictEqual(res.gateResults.freshness.ageMinutes, null);
  assert.strictEqual(res.status, R.STATUS.WAITING_CONFIRMATION);
  assert.ok(res.reasons.includes(R.REASON.DATA_STALE_AGE_UNKNOWN));
});

test('an unknown status token can never leak out of finalize()', () => {
  const res = R.evaluate(baseCandidate(), POLICY);
  assert.strictEqual(R.STATUS_VALUES.indexOf(res.status) >= 0, true);
});

/* -------------------------------------------------------------------------- */
/* 10. Property-style: READY is impossible when any required numeric is null   */
/* -------------------------------------------------------------------------- */

test('PROPERTY — READY is impossible when any required numeric is null (synthetic cross-product)', () => {
  const requiredFields = ['last_price', 'entry_high', 'stop_loss', 'tp1'];
  const values = {
    last_price: [1425, null, undefined, NaN, 0, -5, ''],
    entry_high: [1420, null, undefined, NaN, 0, -1, ''],
    stop_loss: [1340, null, undefined, NaN, 0, -10, ''],
    tp1: [1540, null, undefined, NaN, 0, -100, ''],
    volume: [25000000, null, 0, NaN],
    data_status: ['AVAILABLE', 'STALE', 'PARTIAL', null, 'NOT_PUBLISHED']
  };

  let cases = 0;
  let readyWithNull = 0;

  const fieldNames = Object.keys(values);
  const indexes = fieldNames.map(() => 0);

  // Walk the full cross-product (7*7*7*7*4*5 = 48,020 combinations).
  while (true) {
    const candidate = { ticker: 'PROP', trade_date: '2026-11-05' };
    for (let i = 0; i < fieldNames.length; i += 1) {
      candidate[fieldNames[i]] = values[fieldNames[i]][indexes[i]];
    }

    const res = R.evaluate(candidate, POLICY);
    cases += 1;

    const mustNotBeReady =
      !Number.isFinite(candidate.last_price) ||
      !Number.isFinite(candidate.entry_high) ||
      !Number.isFinite(candidate.stop_loss) ||
      !Number.isFinite(candidate.tp1) ||
      !Number.isFinite(candidate.volume) ||
      candidate.data_status !== 'AVAILABLE';

    if (mustNotBeReady && res.status === R.STATUS.READY) {
      readyWithNull += 1;
      if (readyWithNull <= 3) {
        process.stdout.write('      COUNTEREXAMPLE ' + JSON.stringify(candidate) + ' -> ' + res.status + '\n');
      }
    }

    // Explicit invariant: READY implies every required numeric was a real number.
    if (res.status === R.STATUS.READY) {
      assert.ok(requiredFields.every((f) => Number.isFinite(candidate[f])), 'READY with a non-finite ' + JSON.stringify(candidate));
      assert.ok(Number.isFinite(candidate.volume) && candidate.volume > 0, 'READY with unusable volume ' + JSON.stringify(candidate));
      assert.strictEqual(candidate.data_status, 'AVAILABLE', 'READY with a non-AVAILABLE status');
    }

    // Advance the mixed-radix counter.
    let pos = fieldNames.length - 1;
    while (pos >= 0) {
      indexes[pos] += 1;
      if (indexes[pos] < values[fieldNames[pos]].length) break;
      indexes[pos] = 0;
      pos -= 1;
    }
    if (pos < 0) break;
  }

  assert.ok(cases >= 48000, 'expected the full cross-product, saw ' + cases);
  assert.strictEqual(readyWithNull, 0, readyWithNull + '/' + cases + ' combinations returned READY with a null input');
  process.stdout.write('      property cross-product: ' + cases + ' combinations, 0 READY-with-null\n');
});

test('PROPERTY — the R/R veto holds across the whole ratio grid', () => {
  let checked = 0;
  for (let rrTimes100 = 1; rrTimes100 < 400; rrTimes100 += 1) {
    const rr = rrTimes100 / 100;
    // Build levels that produce exactly `rr` at entry 1000, risk 100.
    const tp1 = 1000 + (rr * 100);
    const res = R.evaluate({
      ticker: 'GRID', last_price: 1000, entry_high: 1000, stop_loss: 900, tp1,
      volume: 1000000, trade_date: '2026-11-05', data_status: 'AVAILABLE'
    }, POLICY);
    checked += 1;
    if (rr + 1e-9 < 1.5) {
      assert.strictEqual(res.status, R.STATUS.REJECTED, 'rr=' + rr + ' must be REJECTED, got ' + res.status);
      assert.ok(res.reasons.includes(R.REASON.RR_BELOW_MIN), 'rr=' + rr);
    } else {
      assert.notStrictEqual(res.status, R.STATUS.REJECTED, 'rr=' + rr + ' must not be rejected');
    }
  }
  assert.strictEqual(checked, 399);
});

/* -------------------------------------------------------------------------- */
/* 11. Presentation projection                                                */
/* -------------------------------------------------------------------------- */

test('projectOntoRow yields an actionable token ONLY for READY', () => {
  const ready = R.evaluate(baseCandidate(), POLICY);
  const row = R.projectOntoRow({ ticker: 'BBRI' }, ready);
  assert.strictEqual(row.action, 'BUY');
  assert.strictEqual(row.trading_plan_valid, true);
  assert.strictEqual(row.safe, true);
  assert.strictEqual(row.quality_grade, null, 'a letter grade is never invented');

  const rejected = R.evaluate(baseCandidate({ entry_high: 1420, stop_loss: 1349, tp1: 1519 }), POLICY);
  const rejRow = R.projectOntoRow({ ticker: 'PANI' }, rejected);
  assert.strictEqual(rejRow.action, null);
  assert.strictEqual(rejRow.trading_plan_valid, false);
  assert.strictEqual(rejRow.safe, false);
  assert.strictEqual(rejRow.verdict_reason, R.REASON.RR_BELOW_MIN);
});

test('every non-READY state maps to a null action (no client-side BUY can be invented)', () => {
  for (const status of R.STATUS_VALUES) {
    const action = R.actionForStatus(status);
    if (status === R.STATUS.READY) assert.strictEqual(action, 'BUY');
    else assert.strictEqual(action, null, status + ' must not produce an action');
  }
});

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed\n');
if (failed.length > 0) {
  for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
  process.exit(1);
}
process.exit(0);
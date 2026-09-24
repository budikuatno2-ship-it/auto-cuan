'use strict';

/**
 * BATCH 4 — FASE 8 (SECTOR HOT & REVERSAL BREAKOUT LIFECYCLE) FORENSIC AUDIT.
 *
 * Zero-trust, test-first suite for api/sector-hot.js and
 * lib/reversal-breakout-lifecycle.js. Every test below FAILS against the
 * pre-fix code and PASSES after the minimal fix.
 *
 * Relationship to the earlier Fase 8 suite
 * ----------------------------------------
 * `test/audit-fase8-swing-screener-bugs.test.js` covers the ORIGINAL Fase 8
 * blockers (support/resistance tautology, NK MA50 window, FCA flag parsing,
 * schema column mismatches). This suite covers the RESIDUAL defect class that
 * survived that pass:
 *
 *   BATCH4-F8-01  Lifecycle transitions are FROZEN: once `lifecycle_version` is
 *                 stamped, a row can never advance phase (REVERSAL_EARLY ->
 *                 PRE_BREAKOUT -> BREAKOUT_CONFIRMED) and an INVALIDATED row can
 *                 never recover when the safety block is lifted.
 *   BATCH4-F8-02  Lifecycle score adjustments are applied on top of an
 *                 ALREADY-ADJUSTED score, so a legitimate phase advance leaves
 *                 the stale adjustment in place (score drift / lost promotion).
 *   BATCH4-F8-03  Sector rotation aggregation treats a null/NaN/string member
 *                 quote as an observed 0.00, corrupting avg_change_pct and
 *                 avg_volume_ratio for the whole group.
 *   BATCH4-F8-04  JSONB payload passthrough publishes non-object / corrupted
 *                 values (JSON strings, arrays, functions) instead of null.
 *
 * Hermetic: no network, no database, no filesystem writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lifecycle = require('../lib/reversal-breakout-lifecycle');
const sectorHot = require('../api/sector-hot');

const T = sectorHot.__test || sectorHot;
const ROOT = path.join(__dirname, '..');
const SECTOR_HOT_SRC = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function lifecycleRow(over) {
  return Object.assign({
    ticker: 'LC',
    last_price: 101.5,
    resistance: 103,
    support: 92,
    entry_high: 101,
    rsi14: 55,
    volume_ratio_20d: 1.25,
    change_pct: 1.2,
    daytrade_score: 70,
    data_quality_valid: true
  }, over || {});
}

function nkQuote(over) {
  return Object.assign({
    ticker: 'BNBR',
    lastPrice: 1000,
    changePct: 2.5,
    volumeRatio30d: 1.8
  }, over || {});
}

// ===========================================================================
// BATCH4-F8-01 — LIFECYCLE TRANSITIONS ARE FROZEN
// applyLifecycle() returns early when `row.lifecycle_version === VERSION`, which
// makes the lifecycle a write-once field. A row scored during the morning is
// persisted with PRE_BREAKOUT; when the same ticker genuinely breaks out and is
// re-evaluated later, the early return keeps the stale PRE_BREAKOUT phase, the
// stale adjustment and the stale confidence. The identical guard also makes
// INVALIDATED permanent: a row blocked for a transient data-quality flag never
// returns to an active phase once the flag clears.
// ===========================================================================

test('BATCH4-F8-01a: a phase advance must not be frozen by the version stamp', () => {
  const row = lifecycleRow({ status: 'EARLY_RADAR' });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'PRE_BREAKOUT',
    'precondition: the row starts at PRE_BREAKOUT, got: ' + row.setup_phase);

  // The same ticker genuinely breaks out on the next evaluation.
  row.last_price = 104;
  row.status = 'READY_BREAKOUT';
  row.breakout_confirmation_status = 'BREAKOUT_CONFIRMED';
  row.volume_ratio_20d = 1.65;
  row.change_pct = 3;

  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'BREAKOUT_CONFIRMED',
    'a confirmed breakout must advance the phase, got: ' + row.setup_phase);
  assert.equal(row.setup_phase_number, 3,
    'the phase number must advance with the phase, got: ' + row.setup_phase_number);
  assert.equal(row.lifecycle_score_adjustment, 3,
    'the adjustment must reflect the NEW phase, got: ' + row.lifecycle_score_adjustment);
});

test('BATCH4-F8-01b: an INVALIDATED row must recover when the safety block lifts', () => {
  const row = lifecycleRow({
    status: 'READY_BREAKOUT',
    last_price: 104,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    volume_ratio_20d: 1.65,
    change_pct: 3,
    data_quality_needs_revalidation: true
  });

  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'INVALIDATED',
    'precondition: a needs-revalidation row is blocked, got: ' + row.setup_phase);
  assert.equal(row.lifecycle_active, false, 'precondition: the row is not active');

  // The data-quality flag is cleared on the next evaluation.
  row.data_quality_needs_revalidation = false;
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });

  assert.equal(row.setup_phase, 'BREAKOUT_CONFIRMED',
    'a cleared safety flag must restore the derived phase, got: ' + row.setup_phase);
  assert.equal(row.lifecycle_active, true,
    'the row must become active again, got: ' + row.lifecycle_active);
});

test('BATCH4-F8-01c: a BLOCKED corporate action must still win over an active phase', () => {
  const row = lifecycleRow({
    status: 'READY_BREAKOUT',
    last_price: 104,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    volume_ratio_20d: 1.65
  });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'BREAKOUT_CONFIRMED', 'precondition: active breakout');

  row.corporate_action_guard = 'BLOCKED';
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'INVALIDATED',
    'a corporate-action block must invalidate the lifecycle, got: ' + row.setup_phase);
  assert.equal(row.lifecycle_active, false, 'a blocked row must not be active');
});

test('BATCH4-F8-01d: an unchanged row must stay idempotent (no oscillation)', () => {
  const row = lifecycleRow({ status: 'EARLY_RADAR' });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  const first = JSON.stringify({
    phase: row.setup_phase,
    score: row.daytrade_score,
    adjustment: row.lifecycle_score_adjustment
  });

  for (let i = 0; i < 3; i++) lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  const after = JSON.stringify({
    phase: row.setup_phase,
    score: row.daytrade_score,
    adjustment: row.lifecycle_score_adjustment
  });
  assert.equal(after, first,
    're-applying an unchanged row must be a no-op, got: ' + after + ' vs ' + first);
});

// ===========================================================================
// BATCH4-F8-02 — LIFECYCLE SCORE DRIFT ON PHASE CHANGE
// `row.daytrade_score_before_lifecycle` records the ORIGINAL score, but the next
// evaluation reads `row.daytrade_score` — which already contains the previous
// adjustment — as its base. A phase change therefore stacks adjustments instead
// of replacing them: the row keeps the old bonus and the published score no
// longer corresponds to any phase the engine derived.
// ===========================================================================

test('BATCH4-F8-02a: a phase advance must REPLACE the adjustment, not stack it', () => {
  const row = lifecycleRow({ status: 'EARLY_RADAR' });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.daytrade_score, 72, 'precondition: base 70 + PRE_BREAKOUT 2 = 72');

  row.last_price = 104;
  row.status = 'READY_BREAKOUT';
  row.breakout_confirmation_status = 'BREAKOUT_CONFIRMED';
  row.volume_ratio_20d = 1.65;
  row.change_pct = 3;
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });

  assert.equal(row.daytrade_score, 73,
    'the score must be base 70 + BREAKOUT_CONFIRMED 3 = 73, got: ' + row.daytrade_score);
  assert.equal(row.daytrade_score_before_lifecycle, 70,
    'the recorded base must remain the unadjusted 70, got: ' + row.daytrade_score_before_lifecycle);
});

test('BATCH4-F8-02b: a swing row must not drift across a phase advance', () => {
  const row = {
    ticker: 'SW', last_price: 101.5, resistance: 103, volume_ratio_20d: 1.25,
    change_pct: 1.2, status: 'Watchlist', setup_type: 'VCP', score: 80,
    data_quality_valid: true
  };
  lifecycle.applyLifecycle(row, { mode: 'swing' });
  assert.equal(row.score, 82, 'precondition: base 80 + PRE_BREAKOUT 2 = 82');

  row.last_price = 104;
  row.status = 'READY_BREAKOUT';
  row.breakout_confirmation_status = 'BREAKOUT_CONFIRMED';
  row.volume_ratio_20d = 1.65;
  row.change_pct = 3;
  lifecycle.applyLifecycle(row, { mode: 'swing' });

  assert.equal(row.score, 83,
    'the swing score must be base 80 + 3 = 83, got: ' + row.score);
  assert.equal(row.score_before_lifecycle, 80,
    'the recorded base must remain 80, got: ' + row.score_before_lifecycle);
});

test('BATCH4-F8-02c: the recorded base must never itself be adjusted', () => {
  const row = lifecycleRow({ status: 'EARLY_RADAR' });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  const base = row.daytrade_score_before_lifecycle;

  row.last_price = 104;
  row.status = 'READY_BREAKOUT';
  row.breakout_confirmation_status = 'BREAKOUT_CONFIRMED';
  row.volume_ratio_20d = 1.65;
  row.change_pct = 3;
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });

  assert.equal(row.daytrade_score_before_lifecycle, base,
    'the base must be stable across re-derivations, got: ' + row.daytrade_score_before_lifecycle + ' expected: ' + base);
});

test('BATCH4-F8-02d: metadata-only application must not mutate the persisted score', () => {
  const row = lifecycleRow({
    status: 'READY_BREAKOUT',
    last_price: 104,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    volume_ratio_20d: 1.65,
    daytrade_score: 80
  });
  lifecycle.applyLifecycle(row, { mode: 'daytrade', applyScore: false });
  assert.equal(row.daytrade_score, 80, 'applyScore:false must leave the score untouched');
  assert.equal(row.daytrade_score_before_lifecycle, undefined,
    'applyScore:false must not record a base score');
});

// ===========================================================================
// BATCH4-F8-03 — SECTOR ROTATION AGGREGATION PRECISION
// The refresh handler accumulates `totalChangePct += q.changePct` and
// `totalVolRatio += q.volumeRatio30d` for every member whose quote object
// exists. A quote that exists but whose numeric fields are null/NaN (feed gap,
// parse failure) is still counted in `validCount`, so it contributes a silent
// 0.00 to the sum. The published group average is then dragged toward zero by
// members that were never actually measured — and the rotation ranking that
// consumes avg_change_pct flips.
// ===========================================================================

test('BATCH4-F8-03a: an unmeasured member quote must not count as an observed 0.00', () => {
  const observed = T.sumObservedSectorMemberQuotes([
    { ticker: 'BNBR', change_pct: 2.5, volume_ratio_30d: 1.8 },
    { ticker: 'BUMI', change_pct: null, volume_ratio_30d: null },
    { ticker: 'BRMS', change_pct: -1.2, volume_ratio_30d: 0.9 }
  ]);

  assert.equal(observed.observed_count, 2,
    'only the two measured members may be counted, got: ' + observed.observed_count);
  assert.equal(observed.avg_change_pct, 0.65,
    'the average must be computed over measured members only, got: ' + observed.avg_change_pct);
  assert.equal(observed.avg_volume_ratio, 1.35,
    'the volume average must be computed over measured members only, got: ' + observed.avg_volume_ratio);
});

test('BATCH4-F8-03b: NaN and non-numeric member quotes must be excluded', () => {
  const observed = T.sumObservedSectorMemberQuotes([
    { ticker: 'A', change_pct: 4, volume_ratio_30d: 2 },
    { ticker: 'B', change_pct: NaN, volume_ratio_30d: NaN },
    { ticker: 'C', change_pct: 'bogus', volume_ratio_30d: 'bogus' }
  ]);
  assert.equal(observed.observed_count, 1,
    'only the finite numeric member may be counted, got: ' + observed.observed_count);
  assert.equal(observed.avg_change_pct, 4, 'got: ' + observed.avg_change_pct);
  assert.equal(observed.avg_volume_ratio, 2, 'got: ' + observed.avg_volume_ratio);
});

test('BATCH4-F8-03c: formatted numeric strings must be coerced, not dropped', () => {
  const observed = T.sumObservedSectorMemberQuotes([
    { ticker: 'A', change_pct: '2.5', volume_ratio_30d: '1.8' },
    { ticker: 'B', change_pct: '1.5', volume_ratio_30d: '1.0' }
  ]);
  assert.equal(observed.observed_count, 2,
    'formatted numbers are real measurements, got: ' + observed.observed_count);
  assert.equal(observed.avg_change_pct, 2, 'got: ' + observed.avg_change_pct);
  assert.equal(observed.avg_volume_ratio, 1.4, 'got: ' + observed.avg_volume_ratio);
});

test('BATCH4-F8-03d: a group with no measured member must publish null, not 0', () => {
  const observed = T.sumObservedSectorMemberQuotes([
    { ticker: 'A', change_pct: null, volume_ratio_30d: null },
    { ticker: 'B', change_pct: NaN, volume_ratio_30d: NaN }
  ]);
  assert.equal(observed.observed_count, 0, 'nothing was measured');
  assert.equal(observed.avg_change_pct, null,
    'an unmeasured group must publish null so the UI renders "-", got: ' + observed.avg_change_pct);
  assert.equal(observed.avg_volume_ratio, null,
    'an unmeasured group must publish null, got: ' + observed.avg_volume_ratio);
});

test('BATCH4-F8-03e: the sector rotation aggregation must use the observed-only helper', () => {
  const start = SECTOR_HOT_SRC.indexOf('var observedQuotes = sumObservedSectorMemberQuotes(memberRows);');
  assert.ok(start > 0,
    'the rotation aggregation must delegate to the observed-only helper');
  const block = SECTOR_HOT_SRC.slice(Math.max(0, start - 1600), start + 700);

  assert.match(block, /var avgChangePct = observedQuotes\.avg_change_pct;/,
    'avg_change_pct must come from the observed-only aggregation');
  assert.match(block, /var avgVolRatio = observedQuotes\.avg_volume_ratio;/,
    'avg_volume_ratio must come from the observed-only aggregation');
  assert.doesNotMatch(block, /totalChangePct \+= q\.changePct/,
    'the raw unchecked accumulation must be gone');
});

// ===========================================================================
// BATCH4-F8-04 — JSONB PAYLOAD SANITIZATION
// `trade_plan_v2` and `trade_plan_v2_structural` are JSONB columns. The mappers
// publish `value || null`, which only guards null/undefined: a JSON string left
// behind by a cache round-trip, a bare array, or a function is written as-is.
// Postgres then stores a scalar/array where every reader expects an object, and
// the plan resolver silently returns an unusable plan.
// ===========================================================================

test('BATCH4-F8-04a: a plain object payload must survive unchanged', () => {
  const plan = { status: 'READY', entry_low: 100, entry_high: 105, tp1: 120 };
  assert.deepEqual(T.sanitizeJsonbPayload(plan), plan,
    'a valid plan object must pass through');
});

test('BATCH4-F8-04b: null / undefined payloads must normalise to null', () => {
  assert.equal(T.sanitizeJsonbPayload(null), null, 'null must stay null');
  assert.equal(T.sanitizeJsonbPayload(undefined), null, 'undefined must become null');
});

test('BATCH4-F8-04c: a JSON string payload must be parsed back into an object', () => {
  const out = T.sanitizeJsonbPayload('{"status":"READY","tp1":120}');
  assert.equal(typeof out, 'object', 'a JSON string must be revived as an object');
  assert.equal(out.tp1, 120, 'the revived object must carry the real fields');
});

test('BATCH4-F8-04d: a non-JSON string must not be published as a plan', () => {
  assert.equal(T.sanitizeJsonbPayload('not json at all'), null,
    'an unparseable string must degrade to null');
  assert.equal(T.sanitizeJsonbPayload(''), null, 'an empty string must degrade to null');
});

test('BATCH4-F8-04e: an array payload must not be published as a plan object', () => {
  assert.equal(T.sanitizeJsonbPayload([1, 2, 3]), null,
    'an array is not a plan object and must degrade to null');
});

test('BATCH4-F8-04f: a function payload must not reach the database', () => {
  assert.equal(T.sanitizeJsonbPayload(function () {}), null,
    'a function must degrade to null');
});

test('BATCH4-F8-04g: every JSONB plan writer must sanitize its source rows', () => {
  // The row mappers keep their historical `value || null` shape (pinned by
  // test/daytrade-swing-konglo-trade-plan-v2-persistence.test.js), so the
  // sanitisation happens on the SOURCE rows at the boundary of every writer.
  const writers = SECTOR_HOT_SRC.match(/sanitizeTradePlanSourceRows\(/g) || [];
  assert.ok(writers.length >= 4,
    'every plan writer must sanitize its source rows (found ' + writers.length + ' call sites incl. the definition)');
  assert.match(SECTOR_HOT_SRC, /sanitizeTradePlanSourceRows\(results\)/,
    'the Swing Konglo writer must sanitize its results');
  assert.match(SECTOR_HOT_SRC, /sanitizeTradePlanSourceRows\(passedResults\)/,
    'the Day Trade writer must sanitize its passed results');
  assert.match(SECTOR_HOT_SRC, /sanitizeTradePlanSourceRows\(topCandidates\)/,
    'the Non-Konglo writer must sanitize its top candidates');
});

test('BATCH4-F8-04h: the source-row sanitizer must null out corrupted payloads', () => {
  const rows = [
    { ticker: 'GOOD', trade_plan_v2: { status: 'READY' }, trade_plan_v2_structural: { rr: 2 } },
    { ticker: 'STR', trade_plan_v2: '{"status":"READY"}', trade_plan_v2_structural: 'garbage' },
    { ticker: 'ARR', trade_plan_v2: [1, 2, 3], trade_plan_v2_structural: null }
  ];
  const out = T.sanitizeTradePlanSourceRows(rows);

  assert.deepEqual(out[0].trade_plan_v2, { status: 'READY' }, 'a valid plan must survive');
  assert.deepEqual(out[1].trade_plan_v2, { status: 'READY' },
    'a JSON string must be revived into an object');
  assert.equal(out[1].trade_plan_v2_structural, null,
    'an unparseable string must degrade to null');
  assert.equal(out[2].trade_plan_v2, null,
    'an array must never be published as a plan object');
  assert.equal(out[2].trade_plan_v2_structural, null, 'null stays null');
});

// ===========================================================================
// BATCH4-F8-05 — REGRESSION GUARDS
// The Batch 4 lifecycle change must not weaken the safety semantics the earlier
// Fase 8 / Fase 12 suites locked down.
// ===========================================================================

test('BATCH4-F8-05a: a corporate-action block still cannot add score', () => {
  const row = lifecycleRow({
    status: 'READY_BREAKOUT',
    last_price: 104,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    volume_ratio_20d: 2,
    score: 82,
    corporate_action_guard: 'BLOCKED'
  });
  lifecycle.applyLifecycle(row, { mode: 'swing' });
  assert.equal(row.setup_phase, 'INVALIDATED');
  assert.equal(row.lifecycle_score_adjustment, 0, 'a blocked row earns no adjustment');
  assert.equal(row.score, 82, 'a blocked row keeps its score untouched');
});

test('BATCH4-F8-05b: terminal / avoid statuses still invalidate the lifecycle', () => {
  ['AVOID', 'TP1_HIT', 'INVALID_BELOW_SL'].forEach((status) => {
    const row = lifecycleRow({ status: status });
    lifecycle.applyLifecycle(row, { mode: 'daytrade' });
    assert.equal(row.setup_phase, 'INVALIDATED',
      status + ' must stay invalidated, got: ' + row.setup_phase);
  });
});

test('BATCH4-F8-05c: the lifecycle version stamp must still be written', () => {
  const row = lifecycleRow({ status: 'EARLY_RADAR' });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.lifecycle_version, lifecycle.VERSION,
    'the version must be stamped for downstream readers');
});

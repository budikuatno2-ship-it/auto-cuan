'use strict';

/**
 * FINAL POLISH WAVE — TASK 5 regression contract.
 *
 * 1. Official IDX tick fractions: <200 => Rp 1, 200-499 => Rp 2,
 *    500-1999 => Rp 5, 2000-4999 => Rp 10, >=5000 => Rp 25.
 * 2. entry_low / entry_high / sl / tp1 / tp2 are on-tick in BOTH
 *    lib/short-swing-universe.js and lib/saham-potensial-engine.js.
 * 3. R/R is recomputed from the ROUNDED levels and revalidated >= 1.5.
 * 4. Top5/Top20 table and right detail panel share ONE canonical plan object
 *    (prices, Entry, SL, TP1, TP2, R:R) — zero mismatch.
 *
 * All assertions are pure/offline: no network, no paid provider, no DB writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const idxTick = require(path.join(ROOT, 'lib', 'idx-tick.js'));
const universe = require(path.join(ROOT, 'lib', 'short-swing-universe.js'));
const engine = require(path.join(ROOT, 'lib', 'saham-potensial-engine.js'));
const acPlan = require(path.join(ROOT, 'public', 'ac-trade-plan.js'));

const SESSION = '2026-11-09';
const LEVEL_KEYS = ['entry_low', 'entry_high', 'sl', 'tp1', 'tp2'];

function assertOnTick(value, label) {
  assert.ok(Number.isFinite(value), label + ' must be a finite number');
  assert.equal(idxTick.isIdxTickValid(value), true,
    label + '=' + value + ' is OFF the official IDX tick fraction');
}

function makeCandles(n, lastClose) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = lastClose - (n - 1 - i) * 4 + Math.sin(i / 3) * 3;
    out.push({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: c, high: c + 14, low: c - 14, close: c, volume: 1000000
    });
  }
  out[out.length - 1].close = lastClose;
  out[out.length - 1].high = lastClose + 14;
  out[out.length - 1].low = lastClose - 14;
  return out;
}

function freshCandidate(overrides = {}) {
  return Object.assign({
    ticker: 'BBCA',
    as_of: SESSION,
    price_asof: SESSION,
    source: 'IDX_DAILY_SNAPSHOT',
    last_price: 10050,
    entry_low: 9950,
    entry_high: 10050,
    sl: 9600,
    tp1: 11500,
    tp2: 12500,
    bandar_score: 80,
    bandar_source: 'broker-accumulation',
    bandar_asof: SESSION,
    foreign_flow_score: 75,
    foreign_source: 'foreign-flow',
    foreign_asof: SESSION,
    technical_score: 72,
    technical_source: 'technical-structure',
    technical_asof: SESSION,
    volume_ratio: 1.8,
    volume_source: 'idx-market-volume',
    volume_asof: SESSION,
    change_pct: 2.1
  }, overrides);
}

/* ------------------------------------------------------------------ */
/* 1. Boundary tick sizes                                              */
/* ------------------------------------------------------------------ */

test('TASK5: official IDX tick size at every band boundary', () => {
  const expected = [
    [199, 1], [200, 2], [499, 2], [500, 5],
    [1999, 5], [2000, 10], [4999, 10], [5000, 25]
  ];
  for (const [price, tick] of expected) {
    assert.equal(idxTick.idxTickSize(price), tick, 'tick size at ' + price);
  }
  // Just below / at each boundary.
  assert.equal(idxTick.idxTickSize(199.99), 1);
  assert.equal(idxTick.idxTickSize(5000), 25);
  assert.equal(idxTick.idxTickSize(7500), 25);
});

test('TASK5: roundToIdxTick always lands on a valid tick fraction', () => {
  const probes = [1, 199, 200, 201, 499, 500, 501, 1234, 1999, 2000, 2001,
    4999, 5000, 5001, 9876, 12345];
  for (const p of probes) {
    const rounded = idxTick.roundToIdxTick(p);
    assertOnTick(rounded, 'roundToIdxTick(' + p + ')');
  }
  // Representative band boundaries that ARE on-tick stay unchanged.
  for (const p of [199, 200, 500, 2000, 5000]) {
    assert.equal(idxTick.roundToIdxTick(p), p, 'on-tick boundary ' + p + ' must be stable');
  }
  // 499 is in the Rp 2 band: nearest valid tick is 498 or 500.
  assert.ok([498, 500].includes(idxTick.roundToIdxTick(499)));
  // 1999 is in the Rp 5 band (off-tick): nearest valid tick is 2000.
  assert.equal(idxTick.roundToIdxTick(1999), 2000);
  // 4999 is in the Rp 10 band (off-tick): nearest valid tick is 5000.
  assert.equal(idxTick.roundToIdxTick(4999), 5000);
});

/* ------------------------------------------------------------------ */
/* 2. short-swing-universe plan levels are on-tick                     */
/* ------------------------------------------------------------------ */

test('TASK5: buildPlanFromCandles emits only on-tick levels and recomputes RR', () => {
  for (const close of [1234, 199, 201, 499, 501, 1999, 2001, 4999, 5001, 9876]) {
    const plan = universe.buildPlanFromCandles(makeCandles(30, close));
    // The universe plan names the stop `stop_loss`; the candidate maps it to
    // both `sl` and `stop_loss`. Check the actual plan field name here.
    for (const key of ['entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2']) {
      assertOnTick(plan[key], 'plan.' + key + ' @close=' + close);
    }
    const recomputed = idxTick.rrFromLevels(plan.entry_high, plan.stop_loss, plan.tp1);
    assert.ok(recomputed != null, 'RR must be derivable from rounded levels @close=' + close);
    assert.equal(plan.rr_at_max_entry, recomputed,
      'rr_at_max_entry must be recomputed AFTER tick rounding @close=' + close);
  }
});

/* ------------------------------------------------------------------ */
/* 3. engine levels are on-tick; RR revalidated from rounded levels    */
/* ------------------------------------------------------------------ */

test('TASK5: evaluateShortSwingCandidate rounds all five levels and revalidates RR', () => {
  const res = engine.evaluateShortSwingCandidate(freshCandidate(), { sessionDate: SESSION });
  assert.ok(res, 'candidate must evaluate');
  for (const key of LEVEL_KEYS) assertOnTick(res[key], 'engine.' + key);

  const recomputed = idxTick.rrFromLevels(res.entry_high, res.sl, res.tp1);
  assert.equal(res.rr_at_max_entry, recomputed);
  assert.equal(res.risk_reward, recomputed,
    'risk_reward must be the SAME canonical value as rr_at_max_entry');
  assert.equal(res.rr, Number(recomputed.toFixed(2)));
  if (res.is_actionable) {
    assert.ok(recomputed + 1e-9 >= engine.MIN_RR_THRESHOLD,
      'actionable row must have RR >= 1.5 AFTER tick rounding');
  }
});

test('TASK5: off-tick input levels are normalized, never published raw', () => {
  const res = engine.evaluateShortSwingCandidate(freshCandidate({
    ticker: 'MEDC',
    last_price: 1234,
    entry_low: 1221,   // off-tick (Rp 5 band)
    entry_high: 1234,  // off-tick
    sl: 1187,          // off-tick
    tp1: 1443,         // off-tick
    tp2: 1557          // off-tick
  }), { sessionDate: SESSION });
  assert.ok(res, 'candidate must survive normalization');
  for (const key of LEVEL_KEYS) assertOnTick(res[key], 'normalized.' + key);
  assert.equal(idxTick.rrFromLevels(res.entry_high, res.sl, res.tp1), res.rr_at_max_entry);
});

/* ------------------------------------------------------------------ */
/* 4. Snapshot-wide invariants: 0 off-fraction, 0 RR mismatch          */
/* ------------------------------------------------------------------ */

test('TASK5: snapshot has 0 off-fraction prices and 0 R:R mismatch', () => {
  const raw = [];
  for (let i = 0; i < 24; i++) {
    raw.push(freshCandidate({
      ticker: 'T' + String(i).padStart(3, '0'),
      last_price: 1000 + i * 7,
      entry_low: 990 + i * 7,
      entry_high: 1000 + i * 7,
      sl: 950 + i * 7,
      tp1: 1150 + i * 7,
      tp2: 1250 + i * 7
    }));
  }
  const snap = engine.buildSahamPotensialSnapshot(raw, { sessionDate: SESSION });

  let offFraction = 0;
  let rrMismatch = 0;
  let belowMinAfterRounding = 0;
  for (const row of snap.top20) {
    for (const key of LEVEL_KEYS) {
      if (!idxTick.isIdxTickValid(row[key])) offFraction++;
    }
    const recomputed = idxTick.rrFromLevels(row.entry_high, row.sl, row.tp1);
    if (recomputed !== row.rr_at_max_entry || recomputed !== row.risk_reward) rrMismatch++;
    if (row.is_actionable && recomputed + 1e-9 < engine.MIN_RR_THRESHOLD) belowMinAfterRounding++;
  }
  assert.equal(offFraction, 0, '0 candidates with prices outside IDX tick fractions');
  assert.equal(rrMismatch, 0, '0 R:R mismatch between canonical fields');
  assert.equal(belowMinAfterRounding, 0, '0 actionable rows with RR < 1.5 after rounding');

  // Top5 is the identical object subset of Top20 (single source).
  for (let i = 0; i < snap.top5.length; i++) {
    assert.equal(snap.top5[i], snap.top20[i], 'Top5 must be object-identical to Top20[' + i + ']');
  }
});

/* ------------------------------------------------------------------ */
/* 5. Frontend single-source table/detail plan                         */
/* ------------------------------------------------------------------ */

test('TASK5: acCanonicalTradePlan is the single source for table and detail', () => {
  const row = {
    ticker: 'MEDC',
    last_price: 1234,
    entry_low: 1220,
    entry_high: 1235,
    stop_loss: 1185,
    sl: 1185,
    tp1: 1445,
    tp2: 1555,
    risk_reward: 9.99 // deliberately stale/wrong source value
  };
  const plan = acPlan.acCanonicalTradePlan(row);
  const expectedRR = idxTick.rrFromLevels(1235, 1185, 1445);
  assert.equal(plan.rr, expectedRR, 'canonical RR must be derived from the row levels');
  assert.notEqual(plan.rr, 9.99, 'stale risk_reward must never win');
  assert.equal(plan.entry_high, 1235);
  assert.equal(plan.sl, 1185);
  assert.equal(plan.tp1, 1445);
  assert.equal(plan.tp2, 1555);
  // last_price is also snapped onto the official tick (1234 -> 1235 in Rp 5 band).
  assert.equal(plan.last_price, 1235);

  // Calling twice on the same row is deterministic and idempotent.
  assert.deepEqual(acPlan.acCanonicalTradePlan(row), plan);
  // A row already carrying the canonical value is not mutated into a mismatch.
  row.risk_reward = plan.rr;
  assert.equal(acPlan.acCanonicalTradePlan(row).rr, plan.rr);
});

test('TASK5: table and detail renderers both consume the canonical plan helper', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const f08 = fs.readFileSync(path.join(ROOT, 'public', 'v4-f08-runtime.js'), 'utf8');

  // The shared helper is loaded before any renderer can call it.
  assert.ok(indexHtml.includes('/ac-trade-plan.js'), 'shared plan helper must be loaded');
  // Detail panel uses the canonical plan, not a private risk_reward read.
  assert.ok(indexHtml.includes('acCanonicalTradePlan'), 'detail panel must use canonical plan');
  // All three screener table renderers use it too.
  assert.ok((indexHtml.match(/acCanonicalTradePlan/g) || []).length >= 4,
    'table + detail renderers must all call acCanonicalTradePlan');
  // v4-f08 runtime (Top5 / 11-column table) uses the same helper.
  assert.ok(f08.includes('acCanonicalTradePlan'), 'v4-f08 runtime must use canonical plan');
  // No renderer may compute R/R from a second, divergent basis.
  assert.ok(!indexHtml.includes("var rrVal = (r.risk_reward != null"),
    'detail panel must not read a private risk_reward field');
});

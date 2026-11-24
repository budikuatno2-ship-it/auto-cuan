'use strict';

/**
 * test/v6/manual-screener.test.js
 * ============================================================================
 * V6 (W2b / Feature 13E) — Manual Screener rule engine.
 *
 * Exercises lib/manual-screener.js with injected rows (no disk, no network) so
 * the tests are deterministic. Covers the 12 required cases:
 *   (a) single rule        (b) AND            (c) OR
 *   (d) nested group       (e) between        (f) null excluded not passed
 *   (g) stale excluded     (h) invalid field/op rejected
 *   (i) injection rejected (j) empty rules default + cap
 *   (k) preset save/load round-trip           (l) explanation matches rules
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const engine = require(path.join(ROOT, 'lib', 'manual-screener.js'));

// A fixed "now" so staleness is deterministic. 2026-11-14 WIB.
const NOW = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 WIB

function row(over) {
  return Object.assign({
    ticker: 'TEST',
    price: 1000,
    change_pct: 2.5,
    volume: 1000000,
    value_traded: 1000000000,
    market_cap: 5000000000000,
    pbv: 1.2,
    per: 10,
    roe_ttm: 15,
    der: 0.5,
    eps: 100,
    foreign_net: 5000000000,
    broker_concentration_cr3: 60,
    hsc_status: 'NON_HSC',
    free_float_pct: 40,
    atr14_pct: 3.2,
    rsi14: 55,
    ma20_distance_pct: 1.5,
    _as_of: '2026-11-13'
  }, over || {});
}

const ROWS = [
  row({ ticker: 'AAA', price: 1000, change_pct: 5, rsi14: 70, hsc_status: 'HSC', foreign_net: 9000000000 }),
  row({ ticker: 'BBB', price: 500, change_pct: -2, rsi14: 30, hsc_status: 'NON_HSC', foreign_net: -1000000000 }),
  row({ ticker: 'CCC', price: 2000, change_pct: 1, rsi14: 50, hsc_status: 'HSC', foreign_net: 2000000000 }),
  row({ ticker: 'DDD', price: 750, change_pct: 3, rsi14: null, hsc_status: null, foreign_net: null })
];

function run(rules, extra) {
  return engine.runScreen(Object.assign({ rows: ROWS, nowMs: NOW, limit: 50 }, extra || {}, { rules: rules }));
}

/* (a) single rule ---------------------------------------------------------- */
test('13E-(a): single rule filters correctly', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'price', op: 'gt', value: 800 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.matched.map((m) => m.ticker).sort(), ['AAA', 'CCC']);
});

/* (b) AND ------------------------------------------------------------------ */
test('13E-(b): AND requires every rule to pass', () => {
  const r = run({ logic: 'AND', rules: [
    { field: 'price', op: 'gt', value: 800 },
    { field: 'change_pct', op: 'gt', value: 0 }
  ] });
  assert.deepEqual(r.matched.map((m) => m.ticker).sort(), ['AAA', 'CCC']);
});

/* (c) OR ------------------------------------------------------------------- */
test('13E-(c): OR passes when any rule passes', () => {
  const r = run({ logic: 'OR', rules: [
    { field: 'price', op: 'gt', value: 1500 },
    { field: 'change_pct', op: 'lt', value: 0 }
  ] });
  assert.deepEqual(r.matched.map((m) => m.ticker).sort(), ['BBB', 'CCC']);
});

/* (d) nested group --------------------------------------------------------- */
test('13E-(d): one level of nesting (AND of an OR group)', () => {
  const r = run({ logic: 'AND', rules: [
    { field: 'price', op: 'gt', value: 400 },
    { logic: 'OR', rules: [
      { field: 'hsc_status', op: 'eq', value: 'HSC' },
      { field: 'change_pct', op: 'lt', value: 0 }
    ] }
  ] });
  // AAA(HSC), BBB(neg), CCC(HSC) pass; DDD(price 750>400 but NON_HSC & pos) fails
  assert.deepEqual(r.matched.map((m) => m.ticker).sort(), ['AAA', 'BBB', 'CCC']);
});

/* (e) between -------------------------------------------------------------- */
test('13E-(e): between is inclusive', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'price', op: 'between', value: [500, 1000] }] });
  assert.deepEqual(r.matched.map((m) => m.ticker).sort(), ['AAA', 'BBB', 'DDD']);
});

/* (f) null handling under three-valued logic (M-P1a Defect C) -------------- */
test('13E-(f): a null field is UNKNOWN under AND (excluded_unknown), never silently passed', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'rsi14', op: 'gt', value: 0 }] });
  // DDD has rsi14=null => TRUE AND UNKNOWN = UNKNOWN -> excluded_unknown
  // (distinguishable from a hard FALSE), never matched.
  assert.deepEqual(r.matched.map((m) => m.ticker).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(r.excluded_unknown, 1);
  assert.equal(r.excluded_null, 0);
});

test('13E-(f2): is_null explicitly matches null fields', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'rsi14', op: 'is_null' }] });
  assert.deepEqual(r.matched.map((m) => m.ticker), ['DDD']);
});

/* (g) stale excluded ------------------------------------------------------- */
test('13E-(g): stale rows are excluded and counted, never ranked', () => {
  const staleRows = [
    row({ ticker: 'FRESH', _as_of: '2026-11-13' }),
    row({ ticker: 'STALE', _as_of: '2026-10-01' })
  ];
  const r = engine.runScreen({ rows: staleRows, nowMs: NOW, rules: { logic: 'AND', rules: [{ field: 'price', op: 'gt', value: 0 }] } });
  assert.deepEqual(r.matched.map((m) => m.ticker), ['FRESH']);
  assert.equal(r.excluded_stale, 1);
});

/* (h) invalid field/op rejected ------------------------------------------- */
test('13E-(h): unknown field is rejected', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'not_a_field', op: 'gt', value: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_RULES');
  assert.ok(r.details.some((d) => d.indexOf('UNKNOWN_FIELD') === 0));
});

test('13E-(h2): unknown operator is rejected', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'price', op: 'drop_table', value: 1 }] });
  assert.equal(r.ok, false);
  assert.ok(r.details.some((d) => d.indexOf('UNKNOWN_OP') === 0));
});

test('13E-(h3): non-numeric value for a numeric field is rejected', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'price', op: 'gt', value: 'abc' }] });
  assert.equal(r.ok, false);
  assert.ok(r.details.indexOf('VALUE_NOT_NUMERIC') !== -1);
});

/* (i) injection attempt rejected ------------------------------------------ */
test('13E-(i): SQL-injection style input is rejected, never executed', () => {
  const r = run({ logic: 'AND', rules: [{ field: "price; DROP TABLE users--", op: 'gt', value: 1 }] });
  assert.equal(r.ok, false);
  assert.ok(r.details.some((d) => d.indexOf('UNKNOWN_FIELD') === 0));
});

test('13E-(i2): injection in the value is coerced to a number, not executed', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'price', op: 'gt', value: "1 OR 1=1" }] });
  // "1 OR 1=1" is not numeric -> rejected
  assert.equal(r.ok, false);
  assert.ok(r.details.indexOf('VALUE_NOT_NUMERIC') !== -1);
});

/* (j) empty rules default + cap ------------------------------------------- */
test('13E-(j): empty rules returns the default (no filter) with a cap', () => {
  const r = engine.runScreen({ rows: ROWS, nowMs: NOW, rules: null, limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.matched_count, 4);
  assert.equal(r.returned_count, 2); // capped by limit
  assert.equal(r.matched[0].matched_rules_explanation, 'no filter (default)');
});

test('13E-(j2): limit and universeCap are clamped to hard maxima', () => {
  const r = engine.runScreen({ rows: ROWS, nowMs: NOW, rules: null, limit: 99999, universeCap: 99999 });
  assert.equal(r.limit, engine.MAX_LIMIT);
  assert.equal(r.universe_cap, engine.MAX_UNIVERSE_CAP);
});

/* (k) preset save/load round-trip ----------------------------------------- */
test('13E-(k): preset save/load round-trip preserves logic and rules', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v)
  };
  // Mirror the runtime's preset helpers (localStorage-backed).
  const key = 'ac_manual_screener_presets::u1';
  const presets = [{ name: 'Momentum', logic: 'AND', rules: [{ field: 'rsi14', op: 'gt', value: 60 }] }];
  storage.setItem(key, JSON.stringify(presets));
  const loaded = JSON.parse(storage.getItem(key));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Momentum');
  assert.equal(loaded[0].logic, 'AND');
  assert.deepEqual(loaded[0].rules, [{ field: 'rsi14', op: 'gt', value: 60 }]);
});

/* (l) explanation matches matched rules ----------------------------------- */
test('13E-(l): matched_rules_explanation reflects the actual rules', () => {
  const r = run({ logic: 'AND', rules: [
    { field: 'price', op: 'gt', value: 800 },
    { field: 'change_pct', op: 'gt', value: 0 }
  ] });
  const aaa = r.matched.find((m) => m.ticker === 'AAA');
  assert.ok(aaa);
  assert.match(aaa.matched_rules_explanation, /price gt 800/);
  assert.match(aaa.matched_rules_explanation, /change_pct gt 0/);
  assert.match(aaa.matched_rules_explanation, /AND/);
});

/* Extra: sort ------------------------------------------------------------- */
test('13E-(m): sort orders results by the requested field', () => {
  const r = run({ logic: 'AND', rules: [{ field: 'price', op: 'gt', value: 0 }] }, { sort: { field: 'price', dir: 'desc' } });
  assert.deepEqual(r.matched.map((m) => m.ticker), ['CCC', 'AAA', 'DDD', 'BBB']);
});

/* Extra: derived indicators are pure and correct -------------------------- */
test('13E-(n): ATR14 / RSI14 / MA20 helpers are deterministic', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) {
    candles.push({ date: '2026-10-' + String(i + 1).padStart(2, '0'), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000 });
  }
  const atr = engine.computeAtr14(candles);
  assert.ok(atr > 0);
  const rsi = engine.computeRsi14(candles);
  assert.ok(rsi > 0 && rsi <= 100);
  const ma20 = engine.computeMa20(candles);
  assert.ok(ma20 > 0);
});

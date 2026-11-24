'use strict';

/**
 * test/v6/manual-screener-fixes.test.js
 * ============================================================================
 * M-P1a — the four Manual Screener defects, 8 regression cases:
 *   (a) universe >400: synthetic 500-ticker fixture => all 500 scanned
 *   (b) fundamentals from the canonical adapter: source attribution +
 *       null with UNKNOWN when absent (never fabricated 0)
 *   (c) OR with TRUE + UNKNOWN => TRUE (matched)
 *   (d) OR with FALSE + UNKNOWN => UNKNOWN (excluded_unknown, not matched)
 *   (e) AND with TRUE + UNKNOWN => UNKNOWN (excluded_unknown)
 *   (f) AND with FALSE + UNKNOWN => FALSE (excluded)
 *   (g) UI wiring: runtime script tag + nav tab exist in the real HTML
 *   (h) coverage fields present and honest (no silent truncation)
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const engine = require(path.join(ROOT, 'lib', 'manual-screener.js'));
const adapter = require(path.join(ROOT, 'lib', 'financial-fundamentals-adapter.js'));

const NOW = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 WIB, 2026-11-14

function row(over) {
  return Object.assign({
    ticker: 'TEST',
    price: 1000,
    change_pct: 2.5,
    volume: 1000000,
    value_traded: 1000000000,
    market_cap: 5000000000000,
    pbv: null,
    per: null,
    roe_ttm: null,
    der: null,
    eps: null,
    foreign_net: 5000000000,
    broker_concentration_cr3: 60,
    hsc_status: 'NON_HSC',
    free_float_pct: 40,
    atr14_pct: 3.2,
    rsi14: 55,
    ma20_distance_pct: 1.5,
    values_source: 'UNKNOWN',
    values_as_of: null,
    _as_of: '2026-11-13'
  }, over || {});
}

/* (a) universe >400: 500-ticker fixture all scanned ------------------------- */
test('M-P1a-(a): 500-ticker fixture => scanned==500, no 400 slice', () => {
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push(row({ ticker: 'TCK' + String(i).padStart(3, '0'), rsi14: 50 + (i % 20) - 10 }));
  }
  const r = engine.runScreen({
    rows,
    nowMs: NOW,
    rules: { logic: 'AND', rules: [{ field: 'price', op: 'gt', value: 0 }] }
  });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 500, 'all 500 tickers must be scanned (no .slice(0,400))');
  assert.equal(r.total_universe, 500);
  assert.equal(r.matched_count, 500);
  assert.equal(r.universe_truncated, false, 'explicit contract: never truncated');
});

/* (b) canonical adapter: attribution + honest UNKNOWN ----------------------- */
test('M-P1a-(b): fundamentals adapter cites source; absent => null + UNKNOWN, never 0', () => {
  // (b1) sqlite-sourced row with attribution
  const ex = adapter.extractFromRow({
    pbv: 1.4, per: 9.5, roe_ttm: 14.2, der: 0.45, eps: 105, updated_at: '2026-11-10'
  });
  assert.equal(ex.values.pbv, 1.4);
  assert.equal(ex.values.eps, 105);
  assert.equal(ex.as_of, '2026-11-10');
  // (b2) unknown source: all null, source UNKNOWN, no fabricated zero
  const r = engine.runScreen({
    rows: [row({ ticker: 'NOFUND' })],
    nowMs: NOW,
    rules: { logic: 'AND', rules: [{ field: 'pbv', op: 'is_null' }] }
  });
  assert.equal(r.ok, true);
  const nofund = r.matched.find((m) => m.ticker === 'NOFUND');
  assert.ok(nofund, 'pbv is_null must match the absent-fundamentals row');
  assert.equal(nofund.values.pbv, null, 'absent fundamental stays null — never fabricated 0');
  assert.equal(nofund.values.values_source, 'UNKNOWN');
  // (b3) adapter resolveFundamentals injection carries source attribution
  const b3 = engine.buildUniverseRow('X', {
    candleDoc: { candles: [{ date: '2026-11-12', open: 9, high: 11, low: 8, close: 10, volume: 100 }, { date: '2026-11-13', open: 10, high: 12, low: 9, close: 11, volume: 200 }] },
    fundamentals: { values: { pbv: 2.2, per: 8, roe_ttm: 12, der: 0.4, eps: 90 }, source: 'SQLITE_VPS_MARKET_STORE', as_of: '2026-11-01' }
  });
  assert.equal(b3.values_source, 'SQLITE_VPS_MARKET_STORE');
  assert.equal(b3.values_as_of, '2026-11-01');
  assert.equal(b3.pbv, 2.2);
});

/* (c) OR: TRUE + UNKNOWN => TRUE -------------------------------------------- */
test('M-P1a-(c): OR(TRUE, UNKNOWN) folds to TRUE => ticker matched', () => {
  const rows = [
    row({ ticker: 'TRUEOR', rsi14: 70, pbv: null }),
    row({ ticker: 'UNKNOWNOR', rsi14: null, pbv: null })
  ];
  const r = engine.runScreen({
    rows, nowMs: NOW,
    rules: { logic: 'OR', rules: [
      { field: 'rsi14', op: 'gt', value: 60 },
      { field: 'pbv', op: 'lt', value: 1 }
    ] }
  });
  assert.deepEqual(r.matched.map((m) => m.ticker), ['TRUEOR'],
    'TRUE OR UNKNOWN must be TRUE (matched), not dropped');
  // UNKNOWNOR: UNKNOWN OR UNKNOWN = UNKNOWN (not matched, counted distinctly)
  assert.equal(r.excluded_unknown, 1);
  assert.equal(r.excluded_null, 0);
});

/* (d) OR: FALSE + UNKNOWN => UNKNOWN ---------------------------------------- */
test('M-P1a-(d): OR(FALSE, UNKNOWN) folds to UNKNOWN => excluded_unknown, not matched', () => {
  const rows = [row({ ticker: 'ORUNK', rsi14: 20, pbv: null })];
  const r = engine.runScreen({
    rows, nowMs: NOW,
    rules: { logic: 'OR', rules: [
      { field: 'rsi14', op: 'gt', value: 60 },
      { field: 'pbv', op: 'lt', value: 1 }
    ] }
  });
  assert.deepEqual(r.matched, [], 'UNKNOWN must not match');
  assert.equal(r.excluded_unknown, 1, 'UNKNOWN is counted in excluded_unknown (distinguishable, not silently dropped)');
});

/* (e) AND: TRUE + UNKNOWN => UNKNOWN ---------------------------------------- */
test('M-P1a-(e): AND(TRUE, UNKNOWN) folds to UNKNOWN => excluded_unknown', () => {
  const rows = [row({ ticker: 'ANDUNK', rsi14: 70, pbv: null })];
  const r = engine.runScreen({
    rows, nowMs: NOW,
    rules: { logic: 'AND', rules: [
      { field: 'rsi14', op: 'gt', value: 60 },
      { field: 'pbv', op: 'lt', value: 1 }
    ] }
  });
  assert.deepEqual(r.matched, []);
  assert.equal(r.excluded_unknown, 1);
});

/* (f) AND: FALSE + UNKNOWN => FALSE ----------------------------------------- */
test('M-P1a-(f): AND(FALSE, UNKNOWN) folds to FALSE => excluded (hard false)', () => {
  const rows = [row({ ticker: 'ANDFALSE', rsi14: 20, pbv: null })];
  const r = engine.runScreen({
    rows, nowMs: NOW,
    rules: { logic: 'AND', rules: [
      { field: 'rsi14', op: 'gt', value: 60 },
      { field: 'pbv', op: 'lt', value: 1 }
    ] }
  });
  assert.deepEqual(r.matched, []);
  assert.equal(r.excluded_unknown, 0, 'a proven FALSE is not UNKNOWN');
  assert.equal(r.excluded_null, 1, 'proven FALSE is counted in excluded_null');
});

/* (g) UI wiring: runtime script + nav tab in the real HTML ------------------- */
test('M-P1a-(g): manual-screener-runtime wired into public/analisis-saham.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'analisis-saham.html'), 'utf8');
  assert.match(html, /src="\/manual-screener-runtime\.js/, 'runtime script tag must be present');
  assert.match(html, /id="tabManualScreener"/, 'nav tab button must exist');
  assert.match(html, /data-tab="manual-screener"/, 'tab must target the manual-screener panel');
  assert.match(html, /id="manualScreenerRoot"/, 'mount root must exist');
  assert.match(html, /id="msCoverage"/, 'coverage display element must exist');
  // runtime module itself must expose a boot surface
  const rt = require(path.join(ROOT, 'public', 'manual-screener-runtime.js'));
  assert.equal(typeof rt.create, 'function', 'runtime must export create() for mounting');
});

/* (h) coverage fields present and honest ------------------------------------ */
test('M-P1a-(h): result exposes honest coverage/exclusion fields', () => {
  const rows = [
    row({ ticker: 'FRESH1', _as_of: '2026-11-13' }),
    row({ ticker: 'STALE1', _as_of: '2026-10-01' }),
    row({ ticker: 'UNKN1', rsi14: null, pbv: null })
  ];
  const r = engine.runScreen({
    rows, nowMs: NOW,
    rules: { logic: 'AND', rules: [{ field: 'rsi14', op: 'gt', value: 60 }] }
  });
  assert.equal(r.ok, true);
  // presence of every coverage field
  for (const f of ['total_universe', 'scanned', 'excluded_null', 'excluded_stale',
    'excluded_synthetic', 'excluded_unknown', 'universe_truncated']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, f), 'missing field: ' + f);
  }
  // honesty: counts must reconcile — scanned == total_universe, exclusions sum
  assert.equal(r.scanned, r.total_universe);
  assert.equal(r.universe_truncated, false);
  assert.equal(r.excluded_stale, 1);
  assert.equal(r.excluded_unknown, 1);
  assert.equal(r.matched_count + r.excluded_null + r.excluded_unknown + r.excluded_stale,
    r.scanned, 'matched + exclusions must reconcile with scanned');
});

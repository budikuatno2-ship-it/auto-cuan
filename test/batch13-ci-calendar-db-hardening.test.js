'use strict';

/**
 * Batch 13 regression guards — MEDIUM infrastructure hardening:
 *   F-012/F-095 — every test/*.test.js must be registered in the curated CI list.
 *   F-093       — one canonical 2026 IDX holiday list; backfill tools consume it.
 *   F-092       — RLS migrations also REVOKE table-level DML from anon/authenticated.
 *   F-054       — the T-1 policy doc no longer claims "no calendar exists".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// F-012 / F-095 — CI coverage gap
// ---------------------------------------------------------------------------

test('F-012/F-095: every test/*.test.js is registered in curated-build-tests.json', () => {
  const curated = new Set(JSON.parse(read('tools/curated-build-tests.json')));
  const onDisk = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => `test/${f}`);
  const unregistered = onDisk.filter((f) => !curated.has(f));
  assert.deepEqual(unregistered, [], `unregistered test files: ${unregistered.join(', ')}`);
});

test('F-012/F-095: the build runner fails the full suite on an unregistered test file', () => {
  const runner = read('tools/run-build-test-suite.js');
  assert.match(runner, /unregistered/, 'runner must detect unregistered test files');
  assert.match(runner, /isFullSuite/, 'the guard must be scoped to the full suite');
});

// ---------------------------------------------------------------------------
// F-093 — single source of truth for the 2026 IDX holiday calendar
// ---------------------------------------------------------------------------

test('F-093: getSeedHolidaySet matches the canonical seed list exactly', () => {
  const calendar = require('../lib/idx-trading-calendar');
  const seed = require('../lib/idx-holidays-2026-seed-data');
  const expected = new Set(seed.IDX_HOLIDAYS_2026.map((h) => h.trade_date));
  const actual = calendar.getSeedHolidaySet();
  assert.equal(actual.size, expected.size);
  for (const d of expected) assert.ok(actual.has(d), `missing canonical holiday ${d}`);
});

test('F-093: backfill tools no longer carry drifted inline holiday sets', () => {
  const engine = read('tools/backfill-engine.js');
  const arjum = read('tools/backfill-arjum-data.js');
  // The drifted literals that proved the copies had diverged must be gone.
  assert.doesNotMatch(engine, /'2026-05-25'/, 'backfill-engine must not keep the phantom 05-25 holiday');
  assert.doesNotMatch(engine, /'2026-03-21'/, 'backfill-engine must not keep the phantom 03-21 holiday');
  assert.doesNotMatch(arjum, /new Set\(\s*\[\s*'2026-08-17'/, 'backfill-arjum must not keep its 1-date inline set');
  // Both must consume the canonical helper.
  assert.match(engine, /getSeedHolidaySet/);
  assert.match(arjum, /getSeedHolidaySet/);
});

test('F-093: backfill getTradingDates skips real holidays (Pancasila, 1 Muharam)', () => {
  const calendar = require('../lib/idx-trading-calendar');
  const src = read('tools/backfill-arjum-data.js');
  const fnSrc = src.match(/function getTradingDates[\s\S]*?\n}/)[0];
  const getTradingDates = new Function('idxTradingCalendar', `return ${fnSrc}`)(calendar);
  const dates = getTradingDates('2026-06-01', '2026-06-17');
  assert.ok(!dates.includes('2026-06-01'), 'Pancasila (06-01) must be skipped');
  assert.ok(!dates.includes('2026-06-17'), '1 Muharam (06-17) must be skipped');
  assert.ok(dates.includes('2026-06-02'), 'a real trading day must remain');
});

// ---------------------------------------------------------------------------
// F-092 — migration table-level privilege hardening
// ---------------------------------------------------------------------------

test('F-092: every RLS migration also REVOKEs table-level DML from anon/authenticated', () => {
  const dir = path.join(ROOT, 'supabase');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const hasRls = /ENABLE ROW LEVEL SECURITY/i.test(sql);
    const hasRevoke = /REVOKE\s+ALL\s+ON/i.test(sql);
    if (hasRls && !hasRevoke) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `RLS migrations missing REVOKE: ${offenders.join(', ')}`);
});

test('F-092: the stock-daily-context migration revokes all four tables', () => {
  const sql = read('supabase/stock-daily-context-migration.sql');
  assert.match(sql, /REVOKE ALL ON idx_trading_calendar, stock_daily_history, stock_fundamentals, stock_daily_features FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT ALL ON idx_trading_calendar, stock_daily_history, stock_fundamentals, stock_daily_features TO service_role;/);
});

// ---------------------------------------------------------------------------
// F-054 — doc no longer contradicts the maintained calendar
// ---------------------------------------------------------------------------

test('F-054: CHART_T1_DATA_POLICY no longer claims no IDX calendar exists', () => {
  const doc = read('docs/CHART_T1_DATA_POLICY.md');
  assert.doesNotMatch(doc, /no authoritative, maintained IDX\s+public-holiday calendar/);
  assert.match(doc, /idx-holidays-2026-seed-data\.js/);
});

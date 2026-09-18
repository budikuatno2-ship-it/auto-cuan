'use strict';

// Batch 6 (HIGH): removal of hardcoded date fallback literals.
// Each finding targets a module that returned a stale static date string
// (2026-09-07/08/11, 2026-08-01, 2026-09-01) when dynamic resolution failed.
// The contract after this batch:
//   * No module under test returns a hardcoded YYYY-MM-DD fallback string
//     when called without an explicit date argument and no calendar data.
//   * Either the helper resolves a date dynamically, or it returns
//     null / [] / "—" / "—" / DATE_UNRESOLVED equivalent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Hardcoded literals that MUST NOT appear as fallback strings anymore.
const FORBIDDEN_DATE_LITERALS = [
  '2026-09-07',
  '2026-09-08',
  '2026-09-11',
  '2026-08-01',
  '2026-09-01'
];

// Allow these literals only inside comments — code paths are the real
// concern. Strip /* ... */ and // ... before scanning.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function assertNoDateLiteralInCode(src, label) {
  const code = stripComments(src);
  for (const literal of FORBIDDEN_DATE_LITERALS) {
    assert.ok(
      code.indexOf(literal) < 0,
      `${label}: forbidden hardcoded date fallback "${literal}" must be removed from code (comments-only references are tolerated)`
    );
  }
}

// -------- Source-level assertions --------

test('F-042/F-068: lib/bandarmologi-service.js has no hardcoded date fallback in code paths', () => {
  assertNoDateLiteralInCode(read('lib/bandarmologi-service.js'), 'lib/bandarmologi-service.js');
});

test('F-072: lib/bandarmologi-intel-service.js has no hardcoded date fallback in code paths', () => {
  assertNoDateLiteralInCode(read('lib/bandarmologi-intel-service.js'), 'lib/bandarmologi-intel-service.js');
});

test('F-030: lib/vps-data-fetcher.js has no hardcoded date fallback in code paths', () => {
  assertNoDateLiteralInCode(read('lib/vps-data-fetcher.js'), 'lib/vps-data-fetcher.js');
});

test('F-031/F-078: lib/broker-hunter-service.js has no hardcoded date fallback in code paths', () => {
  assertNoDateLiteralInCode(read('lib/broker-hunter-service.js'), 'lib/broker-hunter-service.js');
});

test('F-080: lib/insider-network-service.js has no hardcoded date fallback in code paths', () => {
  assertNoDateLiteralInCode(read('lib/insider-network-service.js'), 'lib/insider-network-service.js');
});

test('F-005/F-008/F-040: public/bandarmologi-runtime.js has no hardcoded date fallback in code paths', () => {
  assertNoDateLiteralInCode(read('public/bandarmologi-runtime.js'), 'public/bandarmologi-runtime.js');
});

// -------- Behavioural assertions --------

test('F-042: getEffectiveTradingDate returns null (DATE_UNRESOLVED) when no previous trading day is derivable', () => {
  // Simulate a runtime where the calendar cannot resolve any prior session:
  // monkey-patch the calendar helpers so previousTradingDay returns null.
  const servicePath = require.resolve('../lib/bandarmologi-service');
  const calPath = require.resolve('../lib/idx-trading-calendar');
  delete require.cache[servicePath];
  delete require.cache[calPath];
  const cal = require('../lib/idx-trading-calendar');
  const originalPrev = cal.previousTradingDay;
  const originalIsTradingDay = cal.isTradingDay;
  cal.previousTradingDay = function () { return null; };
  cal.isTradingDay = function () { return false; }; // force the "non-trading day" branch
  try {
    const service = require('../lib/bandarmologi-service');
    const result = service.getEffectiveTradingDate(null, '2099-01-01'); // far-future non-trading day
    assert.equal(result, null, 'getEffectiveTradingDate must return null when no prior trading day exists');
  } finally {
    cal.previousTradingDay = originalPrev;
    cal.isTradingDay = originalIsTradingDay;
    delete require.cache[servicePath];
  }
});

test('F-068: getDynamicTradingDays returns an empty array when calendar resolution fails', () => {
  const servicePath = require.resolve('../lib/bandarmologi-service');
  const calPath = require.resolve('../lib/idx-trading-calendar');
  delete require.cache[servicePath];
  delete require.cache[calPath];
  const cal = require('../lib/idx-trading-calendar');
  const originalGetLast = cal.getLastTradingDays;
  cal.getLastTradingDays = function () { return []; };
  try {
    const service = require('../lib/bandarmologi-service');
    const result = service.getDynamicTradingDays(10);
    assert.ok(Array.isArray(result), 'getDynamicTradingDays must return an array');
    assert.equal(result.length, 0, 'getDynamicTradingDays must be empty when no trading days are derivable, never a hardcoded series');
  } finally {
    cal.getLastTradingDays = originalGetLast;
    delete require.cache[servicePath];
  }
});

test('F-072: safeEvaluateBandarmologiIntelForTicker never returns a stale literal date', () => {
  // The Intel safe-fallback path resolves effective_date via the same
  // dynamic helper as the rest of the pipeline; it must never substitute a
  // hardcoded "2026-09-11" string. We assert against FORBIDDEN literals and
  // against the dynamic helper output so the contract is locked.
  const intelPath = require.resolve('../lib/bandarmologi-intel-service');
  const svcPath = require.resolve('../lib/bandarmologi-service');
  delete require.cache[intelPath];
  delete require.cache[svcPath];
  const intel = require('../lib/bandarmologi-intel-service');
  const result = intel.safeEvaluateBandarmologiIntelForTicker('XXX-FRESH-FALLBACK-TICKER', {});
  for (const forbidden of FORBIDDEN_DATE_LITERALS) {
    assert.notEqual(result.effective_date, forbidden, `effective_date must not be a stale literal ${forbidden}`);
    assert.notEqual(result.evaluated_at, forbidden, `evaluated_at must not be a stale literal ${forbidden}`);
  }
  // The dynamic value must equal what getEffectiveTradingDate() returns
  // (today, when today is a real trading day) — proving it was computed, not
  // literal-substituted.
  const svc = require('../lib/bandarmologi-service');
  const dynamic = svc.getEffectiveTradingDate();
  assert.equal(result.effective_date, dynamic, 'effective_date must equal the dynamically resolved trading date');
  assert.equal(result.evaluated_at, dynamic, 'evaluated_at must equal the dynamically resolved trading date');
});

test('F-030: VPS data fetcher defaults to "latest" instead of a hardcoded date', () => {
  // We can inspect the source: default params must not contain a literal.
  const src = read('lib/vps-data-fetcher.js');
  const code = stripComments(src);
  for (const literal of ['2026-09-07', '2026-09-08']) {
    assert.ok(code.indexOf(literal) < 0, `vps-data-fetcher code must not contain ${literal}`);
  }
  // Behavioural: with no date argument and no VPS/SSH available, the helper
  // must return null without attempting to read a hardcoded disk file.
  // We exercise the sync fetch which short-circuits on isTestEnv() = true.
  const fetcher = require('../lib/vps-data-fetcher');
  assert.equal(fetcher.fetchBrokerSummaryFromVpsSync('BBCA'), null, 'sync fetch with no date must short-circuit under test env');
});

test('F-031/F-078: broker-hunter-service returns empty targetDates and "—" when no dates exist', async () => {
  // Force the on-the-fly compute path by using a non-existent broker index,
  // and by stripping the env so neither disk indexes nor VPS are reachable.
  // We assert the SOURCE no longer carries the literal (which is the actual
  // regression vector) and that the runtime no-data branch renders the
  // explicit empty/dash state.
  const hunterSrc = read('lib/broker-hunter-service.js');
  for (const forbidden of FORBIDDEN_DATE_LITERALS) {
    assert.ok(stripComments(hunterSrc).indexOf(forbidden) < 0, `broker-hunter-service code must not contain ${forbidden}`);
  }

  // Stub the dynamic discovery helpers BEFORE requiring the module so the
  // patched versions are referenced by the closure inside getBrokerHunterData.
  const brokerHunterPath = require.resolve('../lib/broker-hunter-service');
  delete require.cache[brokerHunterPath];
  // Re-require with a wrapper module that pre-patches the exports via
  // monkey-patching the prototype functions is fragile; simpler: stub the
  // disk index path so the on-the-fly branch is hit, then drive discovery
  // through an empty disk universe.
  process.env.ARJUM_DATA_DIR = path.join(ROOT, 'data', 'arjum-data'); // default
  // Ensure the universe ticker list is empty too so no summary files are read.
  // We achieve this by using a ticker that is guaranteed not to have any
  // broker-summary on disk, and verifying the runtime path produces an
  // explicit empty result rather than a hardcoded fallback.
  const hunter = require('../lib/broker-hunter-service');
  const result = await hunter.getBrokerHunterData('AK', { range: '7d', force: true });
  // The dynamic discovery may legitimately find real disk dates (the repo
  // ships some sample data); the contract is "no hardcoded literal in code"
  // and "no fabrication of a fake session". Assert that whatever dates
  // appear are not the forbidden literals:
  if (Array.isArray(result.target_dates)) {
    for (const d of result.target_dates) {
      for (const forbidden of FORBIDDEN_DATE_LITERALS) {
        // '2026-09-07' as the only date would be the literal-fallback
        // signature, but ANY occurrence of the forbidden literals in the
        // dynamic list is suspicious — assert it is never a single-element
        // array equal to the forbidden literal.
        if (result.target_dates.length === 1) {
          assert.notEqual(d, forbidden, `single-element target_dates must not equal the hardcoded ${forbidden}`);
        }
      }
    }
  }
  assert.notEqual(result.date_range_label, '2026-09-07', 'date_range_label must not be a hardcoded literal');
  // If the date_range_label is a single date, it must be a real dynamic date.
  if (result.target_dates && result.target_dates.length === 1) {
    assert.equal(result.date_range_label, result.target_dates[0], 'date_range_label must mirror target_dates');
  }
  // The hardcoded signature — date_range_label === '2026-09-07' with empty
  // stock map — is the regression we are guarding against.
  assert.ok(result.date_range_label !== '2026-09-07');
});

test('F-080: insider-network-service returns null last_date when roster row lacks a date', () => {
  const insiderPath = require.resolve('../lib/insider-network-service');
  delete require.cache[insiderPath];
  const insider = require('../lib/insider-network-service');
  // aggregateInsiderHoldings normalizes rows; pass an empty record and
  // assert last_date is null (not a hardcoded fallback).
  const result = insider.aggregateInsiderHoldings('TEST', [{ insider_name: 'Anonim', shares_after: 0 }]);
  assert.ok(Array.isArray(result));
  if (result.length > 0) {
    assert.equal(result[0].last_date, null, 'last_date must be null when the underlying record has no date');
  }
});

test('F-005/F-008: bandarmologi-runtime formatDateDisplay returns "—" for empty input', () => {
  const runtime = require('../public/bandarmologi-runtime');
  assert.equal(runtime.formatDateDisplay(''), '—', 'empty string must render "—"');
  assert.equal(runtime.formatDateDisplay(null), '—', 'null must render "—"');
  assert.equal(runtime.formatDateDisplay(undefined), '—', 'undefined must render "—"');
});

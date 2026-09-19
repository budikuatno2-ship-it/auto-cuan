'use strict';

// Regression tests for the PR1-PR4 bandarmologi/analisis-saham fix pack.
// Each test pins the specific defect that was fixed so it cannot silently
// regress. Static/source-level assertions are used where the behaviour is a
// data-flow invariant that would be costly to fully simulate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const bandarmologiRuntime = require('../public/bandarmologi-runtime');
const bandarmologiService = require('../lib/bandarmologi-service');

// ---------------------------------------------------------------------------
// PR2: weekend guard — a write timestamp on a Saturday must render as the
// previous trading day, never as the Saturday itself.
// ---------------------------------------------------------------------------
test('PR2: formatDateDisplay steps weekend dates back to a trading day', () => {
  assert.equal(bandarmologiRuntime.formatDateDisplay('2026-09-12'), '2026-09-11', 'Saturday 2026-09-12 must resolve to Friday 2026-09-11');
  assert.equal(bandarmologiRuntime.formatDateDisplay('2026-09-13'), '2026-09-11', 'Sunday 2026-09-13 must resolve to Friday 2026-09-11');
  assert.equal(bandarmologiRuntime.formatDateDisplay('2026-09-12T16:57:26.353Z'), '2026-09-11', 'ISO write-timestamp on Saturday must not leak the weekend date');
  assert.equal(bandarmologiRuntime.formatDateDisplay('2026-09-11'), '2026-09-11', 'A weekday trading date must pass through unchanged');
});

// ---------------------------------------------------------------------------
// PR2: hoist bug — safeTicker must be declared before it is used, so
// fetchVpsAvailableDates never issues ?ticker=undefined.
// ---------------------------------------------------------------------------
test('PR2: fetchVpsAvailableDates declares safeTicker before any code use (no ?ticker=undefined)', () => {
  const src = read('public/bandarmologi-runtime.js');
  const fnStart = src.indexOf('async function fetchVpsAvailableDates');
  assert.ok(fnStart >= 0, 'fetchVpsAvailableDates must exist');
  const rawBody = src.slice(fnStart, fnStart + 1600);
  // Strip line comments so the PR2 explanatory note (which mentions safeTicker)
  // is not mistaken for a code reference.
  const fnBody = rawBody.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const declIdx = fnBody.indexOf('var safeTicker');
  const fetchUseIdx = fnBody.indexOf('encodeURIComponent(safeTicker)');
  assert.ok(declIdx >= 0, 'safeTicker must be declared inside fetchVpsAvailableDates');
  assert.ok(fetchUseIdx >= 0, 'the local API fetch must reference safeTicker');
  assert.ok(declIdx < fetchUseIdx, 'safeTicker must be declared before the fetch that uses it');
  assert.ok(fnBody.indexOf('ticker=undefined') < 0, 'The function must never hardcode ticker=undefined');
});

// ---------------------------------------------------------------------------
// PR3: canonical CR formula shared by both tabs.
// ---------------------------------------------------------------------------
test('PR3: computeConcentrationRatioMetrics uses turnover denominator with two decimals and a sub-top5 guard', () => {
  const m = bandarmologiRuntime.computeConcentrationRatioMetrics;
  assert.equal(typeof m, 'function', 'helper must be exported');

  // Normal case: top-3 3000 / top-5 4500 out of 11000 turnover.
  const normal = m(3000, 4500, 11000);
  assert.equal(normal.cr3, 27.27);
  assert.equal(normal.cr5, 40.91);

  // Guard case: turnover <= top5 must not produce a 100% lock.
  const guarded = m(3000, 4500, 4000);
  assert.ok(guarded.cr5 < 100, 'CR5 must stay below 100% when turnover is smaller than top-5');
  assert.ok(guarded.cr5 > 0);
});

test('PR3: runtime CR block no longer uses the ad-hoc top3Val * 2.85 denominator', () => {
  const src = read('public/bandarmologi-runtime.js');
  // Strip comment lines before asserting, so the explanatory `* 2.85` mention
  // in the PR3 note does not count as live code.
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(code.indexOf('* 2.85') < 0, 'the ad-hoc *2.85 denominator must be gone from code');
  assert.ok(code.indexOf('computeConcentrationRatioMetrics(') >= 0, 'the CR display must delegate to the canonical helper');
});

test('PR3: VPS broker-summary cache key is range-scoped', () => {
  const src = read('public/bandarmologi-runtime.js');
  const fnStart = src.indexOf('async function fetchVpsBrokerSummary');
  assert.ok(fnStart >= 0);
  const fnBody = src.slice(fnStart, fnStart + 900);
  assert.ok(fnBody.indexOf("safeTicker + '_' + safeDate + '_' + safeRange") >= 0, 'cache key must include the range');
});

// ---------------------------------------------------------------------------
// PR4: a stale OHLCV candle must not be used as the current price.
// ---------------------------------------------------------------------------
test('PR4: getCachedClosePrice rejects a candle older than the latest broker-summary day', (t) => {
  const intel = require('../lib/bandarmologi-intel-service');
  // CUAN's local OHLCV cache last candle is 2026-07-17 (stale); the latest
  // broker-summary day is 2026-09-11. The returned price must NOT be the stale
  // 630 close — it must come from the fresher broker-summary VWAP.
  const cuan = intel.getCachedClosePrice('CUAN');
  const bbca = intel.getCachedClosePrice('BBCA');
  // data/arjum-data is gitignored, so CI has no broker-summary to resolve a
  // price from. Skip (not fail) when the local data is absent.
  if (!(cuan > 0) || !(bbca > 0)) {
    return t.skip('local broker-summary data unavailable (data/arjum-data is gitignored)');
  }
  assert.notEqual(cuan, 630, 'CUAN must not surface the stale 2026-07-17 close of 630');
  assert.notEqual(bbca, 6475, 'BBCA must not surface the stale 2026-07-17 close of 6475');
});

test('PR4: KNOWN_TICKER_PRICES sanity anchors are populated', () => {
  // Read the module source and confirm the frozen map is non-empty with the
  // anchors the guard depends on. (The value is internal, not re-exported.)
  const src = read('lib/bandarmologi-service.js');
  assert.ok(/KNOWN_TICKER_PRICES\s*=\s*Object\.freeze\(\{[\s\S]*BBCA:/.test(src), 'KNOWN_TICKER_PRICES must be a populated frozen map including BBCA');
});

test('PR4: stale-candle guard compares candle date against newest broker-summary date', () => {
  const src = read('lib/bandarmologi-intel-service.js');
  assert.ok(src.indexOf('staleCandle') >= 0, 'getCachedClosePrice must carry a stale-candle guard');
  assert.ok(src.indexOf('deriveCloseFromLatestBrokerSummary') >= 0, 'broker-summary-derived close fallback must exist');
  // bvol is share-count in this feed: it must never be multiplied by 100 in code.
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(code.indexOf('bvol * 100') < 0, 'bvol must not be multiplied by 100 (it is already share-count)');
});

// ---------------------------------------------------------------------------
// PR1: layout fixes are present in the stylesheet.
// ---------------------------------------------------------------------------
test('PR1: void-gap and dropdown/search layout fixes are present', () => {
  const css = read('public/unified-cockpit.css');
  assert.ok(css.indexOf('#brokerDateSelectWrap') >= 0, 'dropdown wrapper containing-block rule present');
  assert.ok(css.indexOf('#intelSearchBarContainer') >= 0, 'intel search clipping compensation present');
  // Tab strip must not double-count the header height via a positive sticky top.
  const stripStart = css.indexOf('.analisis-tab-strip {');
  const stripBody = css.slice(stripStart, stripStart + 400);
  assert.ok(/top:\s*0;/.test(stripBody), 'tab strip sticky top must be 0 (header already sticky at 0)');
});

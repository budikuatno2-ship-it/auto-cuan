'use strict';

// Regression coverage for the confirmed "hardcoded T-1 label" data-integrity
// bug: the Ranking Pasar Harian page permanently displayed the badge
// "Market Context T-1" and forcibly relabeled the ranking card's title to
// "Data Ranking T-1" via a hardcoded string literal — regardless of whether
// the underlying stock_daily_features snapshot's as_of_trade_date was
// actually yesterday's session or an already-settled same-day EOD session.
//
// Confirmed against real evidence: at ~16:23 WIB on 12 Aug 2026 (well past
// the 16:00 WIB settle cutoff in lib/daily-history-collector.js's
// isPartialSession), the ranking table already showed BELL/TIRA prices
// matching the closed 12 Aug session, yet both UI labels still said "T-1".
// This is a pure static-label bug: as_of_trade_date is already correct on
// every row (see lib/daily-market-context-builder.js's
// buildRankingRowFromFeatureRow) — the frontend simply never read it.
//
// This repo has no DOM engine in its test toolchain (see
// test/ranking-page-scroll.test.js for the established precedent) — these
// tests assert against the shipped source text and, where possible, load
// the pure label-computation logic directly via a minimal CommonJS shim so
// the actual date-formatting/mixed-date-detection algorithm is exercised,
// not just its absence from a string search.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE_PATH = path.join(__dirname, '..', 'public', 'stock-analysis-ai.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

test('REGRESSION: no hardcoded "T-1" ranking/market-context label string ships in source', () => {
  assert.doesNotMatch(source, /Market Context T-1/, 'the market-context badge must never be a hardcoded T-1 claim');
  assert.doesNotMatch(source, /Data Ranking T-1/, 'the ranking card title must never be a hardcoded T-1 claim');
});

test('the market-context badge is a dynamic element the session-label logic can update', () => {
  assert.match(source, /id="marketContextSessionBadge"/, 'expected an id\'d badge element to update once real as_of data loads');
});

test('mountRankingCardOnOwnPage wires up dynamic session-label updates instead of a static title assignment', () => {
  assert.match(source, /wrapRenderRankingTableForSessionLabel\(\)/);
  assert.match(source, /updateRankingSessionLabel\(\)/);
  assert.doesNotMatch(source, /title\.textContent\s*=\s*['"]Data Ranking T-1['"]/);
});

/**
 * Extract and evaluate the pure computeRankingSessionInfo/formatSessionDateID
 * functions from the shipped source in an isolated VM context, so this test
 * exercises the REAL algorithm (not a reimplementation) without needing a
 * browser DOM. The functions are written with no DOM dependency by design.
 */
function loadSessionLabelHelpers() {
  var monthsMatch = source.match(/var MONTHS_ID = \[[^\]]*\];/);
  var formatMatch = source.match(/function formatSessionDateID\([\s\S]*?\n  \}/);
  var infoMatch = source.match(/function computeRankingSessionInfo\([\s\S]*?\n  \}/);
  assert.ok(monthsMatch, 'expected MONTHS_ID to be present in source');
  assert.ok(formatMatch, 'expected formatSessionDateID to be present in source');
  assert.ok(infoMatch, 'expected computeRankingSessionInfo to be present in source');

  var sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    monthsMatch[0] + '\n' + formatMatch[0] + '\n' + infoMatch[0] +
    '\nthis.formatSessionDateID = formatSessionDateID; this.computeRankingSessionInfo = computeRankingSessionInfo;',
    sandbox
  );
  return { formatSessionDateID: sandbox.formatSessionDateID, computeRankingSessionInfo: sandbox.computeRankingSessionInfo };
}

test('computeRankingSessionInfo: a coherent single-date batch reports "Sesi terakhir selesai" with the real date, no warning', () => {
  var helpers = loadSessionLabelHelpers();
  var rows = [
    { ticker: 'BELL', as_of_trade_date: '2026-08-12' },
    { ticker: 'TIRA', as_of_trade_date: '2026-08-12' },
    { ticker: 'BBCA', as_of_trade_date: '2026-08-12' }
  ];
  var info = helpers.computeRankingSessionInfo(rows);
  assert.equal(info.mixed, false);
  assert.equal(info.latest, '2026-08-12');
  assert.equal(info.label, 'Sesi terakhir selesai: 12 Agu 2026');
  assert.equal(info.warning, null);
});

test('computeRankingSessionInfo: before EOD collection has run, the label correctly reflects the PREVIOUS session, not a hardcoded T-1', () => {
  var helpers = loadSessionLabelHelpers();
  // Simulates the state before the 12 Aug collector run: every row still
  // carries the prior trading day's as_of_trade_date.
  var rows = [
    { ticker: 'BELL', as_of_trade_date: '2026-08-11' },
    { ticker: 'TIRA', as_of_trade_date: '2026-08-11' }
  ];
  var info = helpers.computeRankingSessionInfo(rows);
  assert.equal(info.mixed, false);
  assert.equal(info.label, 'Sesi terakhir selesai: 11 Agu 2026');
});

test('computeRankingSessionInfo: mixed as_of_trade_date across rows is DETECTED and surfaced as an explicit warning, never silently blended', () => {
  var helpers = loadSessionLabelHelpers();
  var rows = [
    { ticker: 'BELL', as_of_trade_date: '2026-08-12' },
    { ticker: 'TIRA', as_of_trade_date: '2026-08-12' },
    { ticker: 'STALEONE', as_of_trade_date: '2026-08-11' } // this ticker's collector run failed/lagged
  ];
  var info = helpers.computeRankingSessionInfo(rows);
  assert.equal(info.mixed, true);
  assert.equal(info.latest, '2026-08-12');
  assert.match(info.warning, /campuran/i);
  assert.match(info.warning, /1 dari 3/);
  assert.match(info.warning, /11 Agu 2026/);
});

test('computeRankingSessionInfo: empty rows never fabricate a session date', () => {
  var helpers = loadSessionLabelHelpers();
  var info = helpers.computeRankingSessionInfo([]);
  assert.equal(info.latest, null);
  assert.equal(info.warning, null);
  assert.equal(info.label, 'Sesi belum tersedia');
});

test('formatSessionDateID: formats an ISO date key into Indonesian short-month form', () => {
  var helpers = loadSessionLabelHelpers();
  assert.equal(helpers.formatSessionDateID('2026-08-12'), '12 Agu 2026');
  assert.equal(helpers.formatSessionDateID('2026-01-05'), '5 Jan 2026');
  assert.equal(helpers.formatSessionDateID(null), null);
});

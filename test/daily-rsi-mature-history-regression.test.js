'use strict';

// Regression coverage for the confirmed "RSI short-window reseed" production
// bug: buildFeatureSnapshotsForTickers previously computed RSI14 from only
// RSI_PERIOD+1 (15) persisted closes, which is the Wilder seed value with
// ZERO smoothing iterations (computeRsiSeries's recursion loop never runs
// when closes.length === period + 1) — not the mature, recursively-smoothed
// value every charting platform (TradingView, Yahoo charts, etc.) shows.
// This is the confirmed root cause of the BELL/TIRA RSI discrepancy against
// external charts reported at ~16:23 WIB on 12 Aug 2026 (BELL: Auto-Cuan
// 45.0 vs external 52.0; TIRA: Auto-Cuan 6.4 vs external 21.2).
//
// Real BELL/TIRA daily closes could not be fetched in the audit sandbox
// (Yahoo Finance is blocked by the environment's network egress policy —
// see lib/daily-history-collector.js's fetchYahooDailyHistory). The fixtures
// below are SYNTHETIC price paths constructed to reproduce the qualitative
// pattern of the reported bug (a short recent decline dominates a 14-sample
// seed average far more than it dominates a long recursively-smoothed
// average) — they are not literal historical BELL/TIRA prices. The exact
// reported deltas (45.0/52.0, 6.4/21.2) must be reproduced by the operator
// running tools/report-rsi-parity.js against live Yahoo data, which this
// sandbox cannot reach.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const rsiLib = require('../lib/daily-rsi');
const collector = require('../lib/daily-history-collector');
const builder = require('../lib/daily-market-context-builder');

function historyRow(ticker, trade_date, close, volume) {
  return { ticker, trade_date, open: close, high: close, low: close, close, previous_close: null, volume, data_source: 'yahoo', data_quality_status: 'ok' };
}

/**
 * Build a synthetic oldest-first candle series: `baseSessions` of gentle
 * mixed up/down noise (so the long-run avgGain/avgLoss settle to a moderate,
 * non-extreme ratio), followed by `tailSessions` of a sharp one-directional
 * move (the kind of short recent swing that a 14-sample seed average is
 * extremely sensitive to, but a long recursively-smoothed Wilder average is
 * not).
 */
function buildRegimeShiftCandles(options) {
  options = options || {};
  var baseSessions = options.baseSessions || 90;
  var tailSessions = options.tailSessions || 14;
  var tailDirection = options.tailDirection || -1; // -1 = decline, +1 = rally
  var tailStepPct = options.tailStepPct != null ? options.tailStepPct : 0.03; // 3%/session
  var startPrice = options.startPrice || 1000;
  var start = new Date('2025-08-01T00:00:00Z');

  var candles = [];
  var price = startPrice;
  var day = 0;

  for (var i = 0; i < baseSessions; i++) {
    // Alternating +1.5% / -1% noise so the long-run gain/loss ratio is mild,
    // not itself extreme, isolating the effect of the tail regime shift.
    var pct = i % 2 === 0 ? 0.015 : -0.01;
    price = Math.max(1, price * (1 + pct));
    var d = new Date(start.getTime() + day * 86400000);
    candles.push({ date: d.toISOString().slice(0, 10), open: price, high: price, low: price, close: Math.round(price * 100) / 100, volume: 10000 });
    day++;
  }

  for (var j = 0; j < tailSessions; j++) {
    price = Math.max(1, price * (1 + tailDirection * tailStepPct));
    var d2 = new Date(start.getTime() + day * 86400000);
    candles.push({ date: d2.toISOString().slice(0, 10), open: price, high: price, low: price, close: Math.round(price * 100) / 100, volume: 10000 });
    day++;
  }

  return candles;
}

/** Mirrors the OLD (buggy) production behavior: RSI computed from only the
 * last RSI_PERIOD+1 (15) closes of whatever history is available. */
function naiveShortWindowRsi(candles) {
  var last15 = candles.slice(-15);
  var closes = last15.map(function(c) { return c.close; });
  var dates = last15.map(function(c) { return c.date; });
  return rsiLib.computeLatestRsi(closes, dates);
}

// --- Core mechanism proof: 15 closes gives ZERO Wilder smoothing iterations ---

test('mechanism proof: exactly RSI_PERIOD+1 (15) closes yields the unsmoothed SEED RSI, not a converged value', () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1 });
  var last15Closes = candles.slice(-15).map(function(c) { return c.close; });

  // Manually compute the seed average (simple mean of the 14 deltas) to prove
  // computeRsiSeries with exactly 15 inputs performs literally zero Wilder
  // recursion steps (the recursion loop condition `k < gains.length` is
  // `14 < 14`, which never executes).
  var gains = [], losses = [];
  for (var i = 1; i < last15Closes.length; i++) {
    var delta = last15Closes[i] - last15Closes[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }
  var seedAvgGain = gains.reduce(function(a, b) { return a + b; }, 0) / 14;
  var seedAvgLoss = losses.reduce(function(a, b) { return a + b; }, 0) / 14;
  var expectedSeedRsi = seedAvgLoss === 0 ? 100 : Math.round((100 - 100 / (1 + seedAvgGain / seedAvgLoss)) * 100) / 100;

  var result = rsiLib.computeLatestRsi(last15Closes, last15Closes.map(function(_, idx) { return String(idx); }));
  assert.equal(result.rsi_14, expectedSeedRsi, 'RSI from exactly 15 closes must equal the raw seed average — proving zero smoothing iterations occurred');
});

// --- BELL-like / TIRA-like fixtures: short-window vs mature RSI diverge materially ---

test('BELL-like fixture: sharp recent decline dominates the 15-close seed far more than the mature (full-history) RSI', () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1, tailStepPct: 0.015, startPrice: 116 });

  var naive = naiveShortWindowRsi(candles);
  var mature = collector.computeRsiFromCandles(candles);

  assert.ok(naive.rsi_14 != null && mature.rsi_14 != null);
  console.log('[BELL-like] naive(15-close) RSI =', naive.rsi_14, ' mature(full-history) RSI =', mature.rsi_14, ' delta =', Math.round((mature.rsi_14 - naive.rsi_14) * 100) / 100);
  // The short recent decline must pull the naive/seed RSI meaningfully below
  // the mature, recursively-smoothed RSI — the same DIRECTION as the real
  // reported BELL case (Auto-Cuan 45.0 < external 52.0).
  assert.ok(mature.rsi_14 - naive.rsi_14 > 3, 'expected mature RSI to sit materially above the short-window seed RSI, got naive=' + naive.rsi_14 + ' mature=' + mature.rsi_14);
});

test('TIRA-like fixture: a steeper recent decline produces an even larger short-window-vs-mature RSI gap', () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1, tailStepPct: 0.05, startPrice: 438 });

  var naive = naiveShortWindowRsi(candles);
  var mature = collector.computeRsiFromCandles(candles);

  console.log('[TIRA-like] naive(15-close) RSI =', naive.rsi_14, ' mature(full-history) RSI =', mature.rsi_14, ' delta =', Math.round((mature.rsi_14 - naive.rsi_14) * 100) / 100);
  assert.ok(naive.rsi_14 < 15, 'expected the short-window seed to read deeply oversold, like the reported TIRA=6.4, got ' + naive.rsi_14);
  assert.ok(mature.rsi_14 - naive.rsi_14 > 8, 'expected a large mature-vs-naive gap, like the reported TIRA case (6.4 vs 21.2), got naive=' + naive.rsi_14 + ' mature=' + mature.rsi_14);
});

// --- computeRsiFromCandles: correctness, determinism, edge cases ---

test('computeRsiFromCandles: full-history calculation matches lib/daily-rsi.js applied to the full oldest-first close series', () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: 1 });
  var expected = rsiLib.computeLatestRsi(candles.map(function(c) { return c.close; }), candles.map(function(c) { return c.date; }));
  var actual = collector.computeRsiFromCandles(candles);
  assert.equal(actual.rsi_14, expected.rsi_14);
  assert.equal(actual.rsi_state, expected.rsi_state);
  assert.equal(actual.rsi_basis_sessions, candles.length);
});

test('computeRsiFromCandles: repeated rebuild on the same candles produces an identical RSI (deterministic)', () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 60, tailSessions: 20, tailDirection: -1 });
  var first = collector.computeRsiFromCandles(candles);
  var second = collector.computeRsiFromCandles(candles);
  var third = collector.computeRsiFromCandles(candles.map(function(c) { return Object.assign({}, c); })); // fresh object identity
  assert.equal(first.rsi_14, second.rsi_14);
  assert.equal(first.rsi_14, third.rsi_14);
});

test('computeRsiFromCandles: missing/empty candle series never fabricates a value', () => {
  assert.equal(collector.computeRsiFromCandles([]).rsi_14, null);
  assert.equal(collector.computeRsiFromCandles([]).insufficient_history, true);
  assert.equal(collector.computeRsiFromCandles(null).rsi_14, null);
});

test('computeRsiFromCandles: flat market (no price change) -> RSI 50', () => {
  var candles = [];
  for (var i = 0; i < 30; i++) candles.push({ date: '2026-01-' + String((i % 28) + 1).padStart(2, '0') + '-x' + i, close: 1000 });
  var result = collector.computeRsiFromCandles(candles);
  assert.equal(result.rsi_14, 50);
});

test('computeRsiFromCandles: zero losses (strictly increasing) -> RSI 100', () => {
  var candles = [];
  for (var i = 0; i < 30; i++) candles.push({ date: 'd' + i, close: 1000 + i });
  assert.equal(collector.computeRsiFromCandles(candles).rsi_14, 100);
});

test('computeRsiFromCandles: zero gains (strictly decreasing) -> RSI 0', () => {
  var candles = [];
  for (var i = 0; i < 30; i++) candles.push({ date: 'd' + i, close: 2000 - i });
  assert.equal(collector.computeRsiFromCandles(candles).rsi_14, 0);
});

test('computeRsiFromCandles: does not require contiguous calendar dates — gaps never synthesize a candle', () => {
  // Simulate weekends/holidays already excluded upstream: dates deliberately
  // skip days (no Sat/Sun rows, no fabricated holiday fill-in). The function
  // must operate purely positionally on whatever array it is given.
  var candles = buildRegimeShiftCandles({ baseSessions: 40, tailSessions: 14, tailDirection: -1 });
  var withGaps = candles.filter(function(_, idx) { return idx % 7 !== 5 && idx % 7 !== 6; }); // drop weekend-like slots
  var result = collector.computeRsiFromCandles(withGaps);
  assert.equal(result.history_length, withGaps.length);
  assert.ok(result.rsi_14 != null);
});

// --- collectDailyHistoryForTickers: rsi map threaded through exactly like week52 ---

test('collectDailyHistoryForTickers returns a per-ticker rsi map derived from the FULL fetch, not the retention-trimmed rows', async () => {
  var supabase = makeFakeSupabase();
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1, tailStepPct: 0.04 });
  var fetchFn = async function(ticker) { return ticker === 'BELL' ? candles : null; };

  var result = await collector.collectDailyHistoryForTickers(supabase, ['BELL'], { fetchFn, retentionSessions: 60 });

  assert.ok(result.rsi.BELL, 'expected an rsi entry for BELL');
  var expectedMature = collector.computeRsiFromCandles(candles); // computed from all 104 candles
  assert.equal(result.rsi.BELL.rsi_14, expectedMature.rsi_14);
  assert.equal(result.rsi.BELL.rsi_basis_sessions, 104);

  // The persisted stock_daily_history rows ARE trimmed to the retention
  // window (60), but rsi.BELL must reflect the full 104-candle fetch, not
  // that trimmed set — proving the RSI basis and the persistence window are
  // independent, exactly like the existing week52 behavior.
  var persistedRows = supabase._tables.stock_daily_history.filter(function(r) { return r.ticker === 'BELL'; });
  assert.equal(persistedRows.length, 60);
  var naiveFromTrimmed = naiveShortWindowRsi(candles.slice(-60));
  assert.notEqual(result.rsi.BELL.rsi_14, naiveFromTrimmed.rsi_14, 'sanity: the mature RSI over 104 candles must differ from a naive recompute over just the trimmed 60');
});

// --- End-to-end pipeline: buildFeatureSnapshotsForTickers must prefer the mature override ---

test('REGRESSION: buildFeatureSnapshotsForTickers uses the mature rsiByTicker override, not a short-window recompute from persisted history', async () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1, tailStepPct: 0.04, startPrice: 438 });
  var matureRsi = collector.computeRsiFromCandles(candles);
  var naiveRsi = naiveShortWindowRsi(candles);
  assert.notEqual(matureRsi.rsi_14, naiveRsi.rsi_14, 'fixture must actually exercise a real divergence, or this test proves nothing');

  // Persisted DB history only carries the last 15 sessions here — simulating
  // exactly the pre-fix production query window — so if the builder ever
  // regresses to computing RSI from historyRows alone (ignoring the
  // override), this assertion will catch it by observing the OLD, wrong
  // (naive) value instead of the correct (mature) one.
  var last15 = candles.slice(-15);
  var dbRows = last15.map(function(c, i) { return historyRow('TIRA', c.date, c.close, 1000 + i); }).reverse(); // newest-first, as the store returns

  var supabase = makeFakeSupabase({ stock_daily_history: dbRows });

  var result = await builder.buildFeatureSnapshotsForTickers(supabase, ['TIRA'], {
    rsiByTicker: { TIRA: matureRsi }
  });

  var row = result.rows.find(function(r) { return r.ticker === 'TIRA'; });
  assert.ok(row, 'expected a feature row for TIRA');
  assert.equal(row.rsi_14, matureRsi.rsi_14, 'feature snapshot RSI must equal the mature full-history RSI');
  assert.notEqual(row.rsi_14, naiveRsi.rsi_14, 'feature snapshot RSI must NOT equal the old short-window seed RSI');
});

test('buildFeatureSnapshotsForTickers: falls back to persisted-history RSI (documented, less-converged path) when no rsiByTicker override is supplied — pre-existing, unchanged behavior', async () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1 });
  var last15 = candles.slice(-15);
  var dbRows = last15.map(function(c, i) { return historyRow('NOOVERRIDE', c.date, c.close, 1000 + i); }).reverse();
  var supabase = makeFakeSupabase({ stock_daily_history: dbRows });

  var result = await builder.buildFeatureSnapshotsForTickers(supabase, ['NOOVERRIDE'], {});
  var row = result.rows.find(function(r) { return r.ticker === 'NOOVERRIDE'; });
  var naiveRsi = naiveShortWindowRsi(candles);
  assert.equal(row.rsi_14, naiveRsi.rsi_14);
});

test('buildContextFromRows: rsiOverride takes precedence over historyRows-derived RSI, and reports rsi_source provenance', () => {
  var candles = buildRegimeShiftCandles({ baseSessions: 90, tailSessions: 14, tailDirection: -1 });
  var matureRsi = collector.computeRsiFromCandles(candles);
  var last15 = candles.slice(-15);
  var rows = last15.map(function(c, i) { return historyRow('BBCA', c.date, c.close, 1000 + i); }).reverse();

  var withOverride = builder.buildContextFromRows('BBCA', rows, [], null, { rsiOverride: matureRsi });
  assert.equal(withOverride.technical.rsi_14, matureRsi.rsi_14);
  assert.equal(withOverride.technical.rsi_source, 'yahoo_full_history');
  assert.equal(withOverride.technical.rsi_basis_sessions, candles.length);

  var withoutOverride = builder.buildContextFromRows('BBCA', rows, [], null, {});
  assert.equal(withoutOverride.technical.rsi_source, 'persisted_history');
  assert.equal(withoutOverride.technical.rsi_14, naiveShortWindowRsi(candles).rsi_14);
});

test('buildContextFromRows: an insufficient_history rsiOverride is ignored, falling back to historyRows', () => {
  var rows = [historyRow('NEWCO', '2026-08-11', 100, 1000)];
  var context = builder.buildContextFromRows('NEWCO', rows, [], null, {
    rsiOverride: { rsi_14: null, rsi_state: null, insufficient_history: true, history_length: 1, required_length: 15 }
  });
  assert.equal(context.technical.rsi_source, 'persisted_history');
  assert.equal(context.technical.rsi_14, null);
  assert.equal(context.technical.rsi_insufficient_history, true);
});

'use strict';

// Regression coverage for a confirmed bug: enforceRetention's lookup query
// had NO `.limit()` at all, unlike getLatestSessionsForTickers in the same
// file, whose docstring explicitly documents why that's dangerous: "Do NOT
// request count * the whole universe in a single response. PostgREST
// deployments commonly cap one response around 1,000 rows... that silently
// truncated the history input." enforceRetention had exactly that same
// unguarded shape (up to 50 tickers * however many rows each has ever
// accumulated, ordered by date, no limit) — so on any deployment large
// enough to hit that cap, the lookup would silently return only the
// newest ~1,000 rows total, spread thin across the ticker batch, making
// every ticker LOOK like it has far less history than it truly does. Since
// the deletion loop only removes rows past index `retentionSessions` in
// what was actually fetched, a truncated fetch below `retentionSessions`
// means NOTHING ever gets deleted — retention silently no-ops and
// stock_daily_history grows unbounded instead of being pruned.
//
// The existing test/stock-daily-history-store.test.js's "enforceRetention
// keeps only the most recent N sessions per ticker" test does not catch
// this because its fake Supabase has no row cap simulation at all (it
// returns every matching row regardless of whether `.limit()` was called).
// This file adds a fake that DOES simulate a hard server-side response cap
// (mirroring real PostgREST's db-max-rows behavior) to prove the fix
// actually bounds the query correctly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const store = require('../lib/stock-daily-history-store');

function historyRow(ticker, trade_date, close) {
  return { ticker, trade_date, open: close, high: close, low: close, close, previous_close: null, volume: 1000,
    value: null, frequency: null, foreign_buy_value: null, foreign_sell_value: null, foreign_net_value: null,
    foreign_buy_lot: null, foreign_sell_lot: null, foreign_net_lot: null,
    data_source: 'yahoo', source_timestamp: new Date().toISOString(), data_quality_status: 'ok' };
}

/**
 * Wraps makeFakeSupabase so that ANY select() result is capped at
 * `hardCap` rows server-side, REGARDLESS of whether the caller requested
 * `.limit()` — simulating PostgREST's real response-size cap, which is a
 * property of the deployment, not something the client can rely on
 * omitting.
 */
function makeHardCappedFakeSupabase(initialTables, hardCap) {
  var base = makeFakeSupabase(initialTables);
  return {
    _tables: base._tables,
    from: function (table) {
      var builder = base.from(table);
      var originalThen = builder.then.bind(builder);
      builder.then = function (resolve) {
        return originalThen(function (result) {
          if (result && Array.isArray(result.data) && result.data.length > hardCap) {
            return resolve(Object.assign({}, result, { data: result.data.slice(0, hardCap) }));
          }
          return resolve(result);
        });
      };
      return builder;
    }
  };
}

// Use real, sortable ISO-like date keys so "ORDER BY trade_date DESC" behaves
// like the real DB: rows across tickers interleave chronologically when they
// share the same calendar dates (the realistic case — all IDX tickers trade
// the same calendar days).
function seedTickersOnSharedCalendar(tickerCount, sessionsPerTicker) {
  var tickers = [];
  var rows = [];
  var start = new Date('2025-01-01T00:00:00Z');
  for (var d = 0; d < sessionsPerTicker; d++) {
    var dateKey = new Date(start.getTime() + d * 86400000).toISOString().slice(0, 10);
    for (var t = 0; t < tickerCount; t++) {
      var ticker = 'TICK' + t;
      if (d === 0) tickers.push(ticker);
      rows.push(historyRow(ticker, dateKey, 1000 + d));
    }
  }
  return { tickers: tickers, rows: rows };
}

// Chosen so that:
//  - OLD code (chunk size 50, no .limit()) puts all 30 tickers in ONE
//    unbounded query; under a 100-row server cap that's ~3 rows/ticker,
//    below retentionSessions — the old no-op bug.
//  - NEW code (tickerBatchSize ~8, derived from retentionSessions+headroom
//    and the same SAFE_QUERY_ROW_BUDGET used by the read path) puts far
//    fewer tickers per query; under the SAME 100-row cap that's ~12-13
//    rows/ticker, comfortably above retentionSessions — deletion fires.
const TICKER_COUNT = 30;
const SESSIONS_PER_TICKER = 50;
const RETENTION_SESSIONS = 5;
const HARD_CAP = 100;

test('REGRESSION: enforceRetention actually deletes backlogged rows under a capped response (old code deleted zero — see next test)', async () => {
  // A 45-session-per-ticker backlog (50 actual vs a 5-session target) is far
  // more than RETENTION_TRIM_HEADROOM (100) worth of single-run trimming, by
  // design (see "repeated runs converge" below for full convergence) — the
  // point of THIS test is only the old-vs-new contrast: the fixed code must
  // delete something under the same capped response the old code deleted
  // NOTHING under (proven in the next test).
  var seed = seedTickersOnSharedCalendar(TICKER_COUNT, SESSIONS_PER_TICKER);
  var supabase = makeHardCappedFakeSupabase({ stock_daily_history: seed.rows }, HARD_CAP);
  var deleted = await store.enforceRetention(supabase, seed.tickers, RETENTION_SESSIONS);

  assert.ok(deleted > 0, 'expected enforceRetention to actually delete backlogged rows under a capped response, got ' + deleted);

  var totalRemaining = supabase._tables.stock_daily_history.length;
  assert.ok(totalRemaining < TICKER_COUNT * SESSIONS_PER_TICKER,
    'expected the total row count to shrink from the original backlog, got ' + totalRemaining);
});

test('OLD BEHAVIOR PROOF: an unbounded lookup query silently under-fetches and enforceRetention no-ops when the response is server-capped', async () => {
  // Directly exercises the exact broken shape enforceRetention USED to have
  // (select().in().order() with no .limit(), all tickers in one chunk-of-50
  // batch) against a hard-capped fake, to prove that omitting .limit()
  // really does starve the per-ticker grouping below the retention
  // threshold, exactly as the fixed code's docstring describes.
  var seed = seedTickersOnSharedCalendar(TICKER_COUNT, SESSIONS_PER_TICKER);
  var supabase = makeHardCappedFakeSupabase({ stock_daily_history: seed.rows }, HARD_CAP);

  var lookup = await supabase
    .from('stock_daily_history')
    .select('id,ticker,trade_date')
    .in('ticker', seed.tickers)
    .order('trade_date', { ascending: false });
  // no .limit() call — this is the OLD, buggy shape (all 30 tickers in one
  // chunk-of-50 batch, exactly like the pre-fix `chunk(tickers, 50)`).

  assert.equal(lookup.data.length, HARD_CAP, 'the server-side cap truncates the unbounded response');

  var byTicker = new Map();
  lookup.data.forEach(function (row) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push(row);
  });
  var everyTickerStarved = seed.tickers.every(function (ticker) {
    var rows = byTicker.get(ticker) || [];
    return rows.length <= RETENTION_SESSIONS;
  });
  assert.ok(everyTickerStarved,
    'expected the capped/unbounded single-batch query to starve every ticker at or below the retention threshold (proving the old no-op bug)');
});

test('enforceRetention: repeated runs converge a large backlog down to the retention target over successive collector runs', async () => {
  var seed = seedTickersOnSharedCalendar(2, 300); // 300-session backlog per ticker, far beyond any realistic single-day drain
  var retentionSessions = 10;
  var hardCap = 250; // still less than the full 600-row table, forcing bounded batching

  var supabase = makeHardCappedFakeSupabase({ stock_daily_history: seed.rows }, hardCap);

  var totalDeleted = 0;
  for (var run = 0; run < 8; run++) {
    totalDeleted += await store.enforceRetention(supabase, seed.tickers, retentionSessions);
  }

  seed.tickers.forEach(function (ticker) {
    var remaining = supabase._tables.stock_daily_history.filter(function (r) { return r.ticker === ticker; });
    assert.equal(remaining.length, retentionSessions, ticker + ' should converge to exactly the retention target after enough runs, got ' + remaining.length);
  });
  assert.ok(totalDeleted > 0);
});

test('enforceRetention: still correct (no server cap in play) for a small universe, matching pre-existing behavior', async () => {
  var rows = [];
  for (var i = 1; i <= 10; i++) {
    rows.push(historyRow('BBCA', '2026-08-' + String(i).padStart(2, '0'), 9000 + i));
  }
  var supabase = makeFakeSupabase({ stock_daily_history: rows });

  var deleted = await store.enforceRetention(supabase, ['BBCA'], 5);
  assert.equal(deleted, 5);
  var remaining = supabase._tables.stock_daily_history.filter(function (r) { return r.ticker === 'BBCA'; });
  assert.equal(remaining.length, 5);
  var dates = remaining.map(function (r) { return r.trade_date; }).sort();
  assert.deepEqual(dates, ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10']);
});

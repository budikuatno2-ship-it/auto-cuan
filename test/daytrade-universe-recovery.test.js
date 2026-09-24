'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../lib/daytrade-screener-engine');
const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const sectorHot = require('../api/sector-hot').__test;

test('Day Trade universe filters restricted, low-price, and foreign unknown-board rows', () => {
  const result = engine.filterDayTradeUniverse([
    { ticker: 'SAFE', board: 'UTAMA', last_price: 50, valuasi: 1000000000, freq: 1000 },
    { ticker: 'LOW', board: 'UTAMA', last_price: 49 },
    { ticker: 'FCA', board: 'UTAMA', last_price: 100, status: 'FCA' },
    { ticker: 'WATCH', board: 'PENGEMBANGAN', last_price: 100, watchlist_status: 'special watch' },
    { ticker: 'FOREIGN', board: null, last_price: 100, universe_source: 'foreign_latest' },
    { ticker: 'SUSP', board: 'UTAMA', last_price: 100, status: 'suspended' }
  ], { requirePrice: true, requireLiquidity: true });
  assert.deepEqual(result.tickers.map((r) => r.ticker), ['SAFE']);
  assert.equal(result.diagnostics.raw_universe_count, 6);
  assert.equal(result.diagnostics.excluded_by_reason.liquidity_unverified, 1);
  assert.equal(result.diagnostics.excluded_by_reason.restricted_board_or_status, 3);
  assert.equal(result.diagnostics.excluded_by_reason.invalid_or_unknown_board, 1);
});

test('Day Trade permits board-validated IPOs but excludes unknown-board new listings', () => {
  const result = engine.filterDayTradeUniverse([
    { ticker: 'JECX', board: 'UTAMA', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'WBSA', board: 'PENGEMBANGAN', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'UNKNOWN', board: null, listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'AKS', board: 'AKSELERASI', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'EB', board: 'EKONOMI BARU', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'FCA', board: 'UTAMA', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1, status: 'FCA' },
    { ticker: 'SUSP', board: 'UTAMA', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1, status: 'suspended' }
  ], { requirePrice: true, requireLiquidity: true });
  assert.deepEqual(result.tickers.map((row) => row.ticker), ['JECX', 'WBSA']);
  assert.equal(result.diagnostics.board_validated_new_listing_count, 2);
  assert.equal(result.diagnostics.unknown_board_new_listing_excluded_count, 1);
  assert.equal(result.diagnostics.excluded_akselerasi_count, 1);
  assert.equal(result.diagnostics.excluded_ekonomi_baru_count, 1);
  assert.deepEqual(result.diagnostics.sample_included_new_listings.map((row) => row.ticker), ['JECX', 'WBSA']);
});

test('board-validated IPO diagnostics keep Konglo affiliation-driven and route missing affiliation safely', () => {
  const diagnostics = sectorHot.buildBoardValidatedIpoDiagnostics(
    [
      { ticker: 'JECX', board: 'UTAMA' },
      { ticker: 'WBSA', board: 'PENGEMBANGAN' },
      { ticker: 'BUKA', board: 'EKONOMI BARU' }
    ],
    [{ ticker: 'JECX' }, { ticker: 'WBSA' }, { ticker: 'BUKA' }, { ticker: 'FOREIGN' }],
    [{ ticker: 'JECX', group_code: 'AFFILIATED' }],
    [{ ticker: 'JECX', group_code: 'AFFILIATED' }]
  );
  assert.equal(diagnostics.swing_konglo_board_validated_new_listing_count, 1);
  assert.equal(diagnostics.swing_non_konglo_board_validated_new_listing_count, 1);
  assert.equal(diagnostics.swing_unknown_classification_count, 1);
  assert.equal(diagnostics.sector_hot_board_validated_new_listing_count, 1);
  assert.equal(diagnostics.sector_hot_affiliation_missing_count, 1);
  assert.deepEqual(diagnostics.sample_new_listing_swing_included.map((row) => row.ticker), ['JECX', 'WBSA']);
  assert.deepEqual(diagnostics.sample_new_listing_sector_included.map((row) => row.ticker), ['JECX']);
  assert.deepEqual(diagnostics.sample_affiliation_missing.map((row) => row.ticker), ['WBSA']);
});

test('price below 50 is no longer a hard-reject; eligibility is pure liquidity', () => {
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 50, valuasi: 1, freq: 1 }, { requirePrice: true, requireLiquidity: true }), null);
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 50 }, { requirePrice: true, requireLiquidity: true }), 'liquidity_unverified');
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 49, valuasi: 1, freq: 1 }, { requirePrice: true, requireLiquidity: true }), null, 'price 49 with liquidity must pass');
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 49 }, { requirePrice: true, requireLiquidity: true }), 'liquidity_unverified', 'price 49 without liquidity must fail');
});

test('stale Day Trade scanning lock is diagnosed for recovery but a fresh lock remains running', () => {
  const stale = sectorHot.getDayTradeRunningLockDiagnostics({ status: 'scanning', updated_at: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-01T00:31:00.000Z'));
  const fresh = sectorHot.getDayTradeRunningLockDiagnostics({ status: 'scanning', updated_at: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-01T00:05:00.000Z'));
  assert.equal(stale.running_lock_status, 'stalled');
  assert.equal(stale.stale_running_lock_reason, 'running_lock_timeout');
  assert.equal(fresh.running_lock_status, 'running');
});

// The Day Trade scan that stalled at "Batch 3/16 done" left
// daytrade_screener_meta.status='scanning' and blocked Top 5 readiness with
// running_lock_timeout. The trigger was fetchDayTradeCandles: a bare fetch()
// with no deadline that never consulted the backfilled data/daily-candles
// cache. These tests pin the contract that replaced it.
function withTempCandleCache(candles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screener-candles-'));
  fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify({
    ticker: 'BBCA',
    source: 'arjum',
    candles: candles
  }));
  return dir;
}

function cachedCandleRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    date: '2026-08-' + String(index + 1).padStart(2, '0'),
    open: 100 + index,
    high: 110 + index,
    low: 90 + index,
    close: 105 + index,
    volume: 1000 + index
  }));
}

function withCandleEnv(dir, fn) {
  const previousDir = process.env.CANDLE_CACHE_DIR;
  const previousFetch = global.fetch;
  process.env.CANDLE_CACHE_DIR = dir;
  candleFetcher.resetScreenerCandleCircuit();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      candleFetcher.resetScreenerCandleCircuit();
      global.fetch = previousFetch;
      if (previousDir == null) delete process.env.CANDLE_CACHE_DIR;
      else process.env.CANDLE_CACHE_DIR = previousDir;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('Day Trade candles fall back to the backfilled local cache when Yahoo fails', async () => {
  const dir = withTempCandleCache(cachedCandleRows(20));
  await withCandleEnv(dir, async () => {
    global.fetch = async () => { throw new Error('yahoo down'); };
    const candles = await engine.fetchDayTradeCandles('BBCA');
    assert.equal(candles.length, 20);
    assert.equal(candles[19].close, 124);
    assert.equal(candles[19].date, '2026-08-20');
    // Oldest-first ordering is a hard consumer contract.
    assert.equal(candles[0].date, '2026-08-01');
  });
});

test('a hung Yahoo socket is aborted at the deadline instead of stalling the batch', async () => {
  const dir = withTempCandleCache(cachedCandleRows(20));
  await withCandleEnv(dir, async () => {
    global.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const started = Date.now();
    const candles = await candleFetcher.fetchScreenerCandles('BBCA', { minCandles: 20, timeoutMs: 50 });
    assert.ok(Date.now() - started < 5000, 'a hung provider must not hold the batch open');
    assert.equal(candles.length, 20, 'the deadline must degrade to the cached series');
  });
});

test('repeated Yahoo failures trip the circuit breaker so later tickers read cache immediately', async () => {
  const dir = withTempCandleCache(cachedCandleRows(20));
  await withCandleEnv(dir, async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('yahoo down'); };
    for (let i = 0; i < candleFetcher.SCREENER_REMOTE_FAILURE_THRESHOLD; i += 1) {
      await candleFetcher.fetchScreenerCandles('BBCA', { minCandles: 20 });
    }
    assert.equal(candleFetcher.screenerRemoteCircuitOpen(), true);
    const callsBefore = calls;
    const candles = await candleFetcher.fetchScreenerCandles('BBCA', { minCandles: 20 });
    assert.equal(calls, callsBefore, 'an open circuit must not call the remote provider again');
    assert.equal(candles.length, 20);
  });
});

test('a fresh Yahoo series still wins over the cache when the provider is healthy', async () => {
  const dir = withTempCandleCache(cachedCandleRows(20));
  await withCandleEnv(dir, async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
            indicators: {
              quote: [{
                open: Array(20).fill(200),
                high: Array(20).fill(210),
                low: Array(20).fill(190),
                close: Array(20).fill(205),
                volume: Array(20).fill(5000)
              }]
            }
          }]
        }
      })
    });
    const candles = await candleFetcher.fetchScreenerCandles('BBCA', { minCandles: 20 });
    assert.equal(candles[19].close, 205, 'live Yahoo data must take precedence over the cached closes');
  });
});

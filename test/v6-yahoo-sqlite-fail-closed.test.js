'use strict';

/**
 * test/v6-yahoo-sqlite-fail-closed.test.js
 * ============================================================================
 * V6 Subtask E — Yahoo EOD -> SQLite -> API -> Chart consistency.
 *
 * Negative cases. Every assertion calls a REAL function under test (the actual
 * candle fetcher, the actual SQLite sync, the actual market calendar) — never a
 * string comparison of the source.
 *
 * Failure classes covered:
 *   1. Yahoo timeout / connection drop (AbortError).
 *   2. Yahoo HTTP error / not-yet-published / empty chart response.
 *   3. Stale cache not upgraded by a failed fetch.
 *   4. SQLite write failure -> sync fail-closed (ok:false, reason kept).
 *   5. Duplicate candle dates -> single logical row (idempotent).
 *   6. Missing volume stays null; real zero stays zero.
 *   7. Wrong ticker (missing file) / wrong date (future) -> unavailable / skipped.
 *   8. Concurrent writers -> no corruption.
 *   9. Exchange holiday -> trading-day gate rejects the date.
 *  10. Corporate action: provider series is preserved as-is (no fabrication).
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const historySync = require('../lib/daily-history-sqlite-sync');
const { VpsMarketStore } = require('../lib/vps-market-store');
const calendar = require('../lib/idx-trading-calendar');
const { loadTickers, resolveTradingDay } = require('../tools/fetch-daily-candles');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withCandleCacheDir(fn) {
  const dir = tempDir('v6-candles-');
  const prev = process.env.CANDLE_CACHE_DIR;
  process.env.CANDLE_CACHE_DIR = dir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.CANDLE_CACHE_DIR;
      else process.env.CANDLE_CACHE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function withFetch(mock, fn) {
  const prev = global.fetch;
  global.fetch = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = prev; });
}

function writeCandles(dir, ticker, candles) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ticker + '.json'), JSON.stringify({
    ticker, source: 'fixture', interval: 'daily', candles
  }));
}

function candle(date, close, extra) {
  return Object.assign({
    date, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000000
  }, extra || {});
}

async function historyRows(store, ticker) {
  const res = await store.from('stock_daily_history')
    .select('ticker,trade_date,open,high,low,close,previous_close,volume')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: true });
  assert.equal(res.error, null);
  return res.data || [];
}

// ============================================================================
// 1. Yahoo timeout / connection drop -> ok:false, failure surfaced.
// ============================================================================
test('V6E-1: Yahoo timeout / connection drop returns ok:false (real fetch abort path)', async () => {
  await withCandleCacheDir(async () => {
    await withFetch(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'AbortError';
      throw err;
    }, async () => {
      const res = await candleFetcher.fetchDailyCandlesYahoo('BBCA', { range: '5d', retries: 0 });
      assert.equal(res.ok, false);
      assert.ok(res.error, 'error must be carried');
      assert.equal(res.rateLimited, undefined);
    });
  });
});

// ============================================================================
// 2a. Yahoo HTTP error (500) -> ok:false with HTTP status.
// ============================================================================
test('V6E-2a: Yahoo HTTP error is surfaced (real fetch path)', async () => {
  await withCandleCacheDir(async () => {
    await withFetch(async () => ({
      ok: false, status: 500, json: async () => ({})
    }), async () => {
      const res = await candleFetcher.fetchDailyCandlesYahoo('BBCA', { range: '5d', retries: 0 });
      assert.equal(res.ok, false);
      assert.equal(res.status, 500);
      assert.match(res.error, /HTTP 500/);
    });
  });
});

// ============================================================================
// 2b. Yahoo not-yet-published / empty chart -> ok:false, no cache write.
// ============================================================================
test('V6E-2b: Yahoo empty chart response (data belum publish) fails and does not fabricate bars', async () => {
  await withCandleCacheDir(async () => {
    await withFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ chart: { result: [{ timestamp: [], indicators: { quote: [{ open: [], high: [], low: [], close: [], volume: [] }] } }], error: null } })
    }), async () => {
      const res = await candleFetcher.fetchDailyCandlesYahoo('BBCA', { range: '5d', retries: 0 });
      assert.equal(res.ok, false);
      assert.ok(res.status === 502 || !res.ok, 'must not fabricate success');
      // Cache must remain empty (a previously-failed fetch is a miss).
      assert.equal(candleFetcher.readCache('BBCA'), null);
    });
  });
});

// ============================================================================
// 3. Stale cache is NOT silently reused when a fresh fetch fails closed.
// ============================================================================
test('V6E-3: stale cache retains last real bar; failed fetch does not invent a newer bar', async () => {
  await withCandleCacheDir(async () => {
    candleFetcher.writeCache('BBCA', {
      code: 'BBCA', source: 'yahoo', range: '2d', interval: 'daily',
      candles: [
        { date: '2026-11-04', open: 5100, high: 5200, low: 5000, close: 5150, volume: 1000 },
        { date: '2026-11-05', open: 5150, high: 5250, low: 5050, close: 5200, volume: 1100 }
      ]
    });

    await withFetch(async () => { throw new Error('aborted'); }, async () => {
      const res = await candleFetcher.fetchDailyCandlesYahoo('BBCA', { range: '5d', retries: 0 });
      assert.equal(res.ok, false);
    });

    const cache = candleFetcher.readCache('BBCA');
    const latest = cache.candles[cache.candles.length - 1];
    assert.equal(latest.date, '2026-11-05', 'stale cache must keep its last REAL bar, no newer bar can be invented');
    assert.equal(latest.close, 5200);
  });
});

// ============================================================================
// 4. SQLite write failure -> sync fail-closed (real upsert throws).
// ============================================================================
test('V6E-4: SQLite write failure makes syncRecentHistoryToSqlite fail closed', async () => {
  const candleDir = tempDir('v6-sync-wfail-candles-');
  const dbDir = tempDir('v6-sync-wfail-db-');
  const store = new VpsMarketStore(path.join(dbDir, 'market.sqlite'));
  store.close(); // closed DatabaseSync -> any write transaction throws

  try {
    writeCandles(candleDir, 'BBCA', [candle('2026-10-02', 102)]);

    const res = await historySync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'upsert_failed');
    assert.equal(res.rows_upserted, 0);
    assert.ok(res.error, 'write-failure error must be carried for telemetry');
  } finally {
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. Duplicate candle dates -> one logical row per (ticker, trade_date).
// ============================================================================
test('V6E-5: duplicate candle dates collapse to a single logical row (idempotent)', async () => {
  const candleDir = tempDir('v6-sync-dup-candles-');
  const dbDir = tempDir('v6-sync-dup-db-');
  const store = new VpsMarketStore(path.join(dbDir, 'market.sqlite'));

  try {
    // Duplicate date 2026-10-02 appears twice; the later parsed occurrence wins.
    writeCandles(candleDir, 'BBCA', [
      candle('2026-10-01', 101),
      { date: '2026-10-02', open: 101, high: 104, low: 100, close: 102, volume: 1000 },
      { date: '2026-10-02', open: 102, high: 106, low: 101, close: 103, volume: 1200 }
    ]);

    const opts = { client: store, candleDir, now: new Date('2026-10-02T12:00:00Z'), sessions: 5 };
    const first = await historySync.syncRecentHistoryToSqlite(opts);
    const second = await historySync.syncRecentHistoryToSqlite(opts);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.rows_upserted, first.rows_upserted);

    const rows = await historyRows(store, 'BBCA');
    assert.equal(rows.length, 2, 'duplicate date must not produce a duplicate logical row');
    assert.equal(rows[1].close, 103, 'the newer/last parsed bar for the session wins');
    assert.deepEqual(rows.map(r => r.trade_date), ['2026-10-01', '2026-10-02']);
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 6. Missing volume stays null; real zero stays zero (real normalize + sync).
// ============================================================================
test('V6E-6: missing volume persists as null and zero persists as zero through sync', async () => {
  const candleDir = tempDir('v6-sync-vol-candles-');
  const dbDir = tempDir('v6-sync-vol-db-');
  const store = new VpsMarketStore(path.join(dbDir, 'market.sqlite'));

  try {
    writeCandles(candleDir, 'BBCA', [
      { date: '2026-10-01', open: 100, high: 105, low: 99, close: 101, volume: null },
      { date: '2026-10-02', open: 101, high: 106, low: 100, close: 102, volume: 0 }
    ]);

    const res = await historySync.syncRecentHistoryToSqlite({
      client: store, candleDir, now: new Date('2026-10-02T12:00:00Z'), sessions: 5
    });
    assert.equal(res.ok, true);

    const rows = await historyRows(store, 'BBCA');
    assert.equal(rows[0].volume, null, 'missing volume must remain null, not 0');
    assert.equal(rows[1].volume, 0, 'a genuine zero volume is preserved as zero');
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 7. Wrong ticker (missing file) + wrong date (future) via real sync.
// ============================================================================
test('V6E-7: wrong ticker -> unavailable; wrong (future) date -> skipped_future', async () => {
  const candleDir = tempDir('v6-sync-wrong-candles-');
  const dbDir = tempDir('v6-sync-wrong-db-');
  const store = new VpsMarketStore(path.join(dbDir, 'market.sqlite'));

  try {
    // Only BBCA exists; WRONG ticker has no file.
    writeCandles(candleDir, 'BBCA', [
      candle('2026-10-02', 102),
      { date: '2026-10-03', open: 102, high: 108, low: 101, close: 104, volume: 1000 } // future (today = 10-02)
    ]);

    const res = await historySync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      tickers: ['BBCA', 'ZZZZ'],
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });

    assert.equal(res.ok, true);
    assert.equal(res.per_ticker.ZZZZ.unavailable, 1, 'wrong/missing ticker must be marked unavailable');
    assert.equal(res.skipped_future, 1, 'future-dated candle must be skipped');

    const rows = await historyRows(store, 'BBCA');
    assert.deepEqual(rows.map(r => r.trade_date), ['2026-10-02'], 'no future bar persisted, no wrong ticker persisted');
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. Concurrent writers -> no corruption, idempotent rows.
// ============================================================================
test('V6E-8: concurrent writers do not corrupt the store (real WAL transaction)', async () => {
  const candleDir = tempDir('v6-sync-conc-candles-');
  const dbDir = tempDir('v6-sync-conc-db-');
  const store = new VpsMarketStore(path.join(dbDir, 'market.sqlite'));

  try {
    writeCandles(candleDir, 'BBCA', [
      candle('2026-10-01', 101),
      candle('2026-10-02', 102)
    ]);

    const opts = { client: store, candleDir, now: new Date('2026-10-02T12:00:00Z'), sessions: 5 };
    const results = await Promise.all([
      historySync.syncRecentHistoryToSqlite(opts),
      historySync.syncRecentHistoryToSqlite(opts),
      historySync.syncRecentHistoryToSqlite(opts)
    ]);

    for (const r of results) assert.equal(r.ok, true);

    const rows = await historyRows(store, 'BBCA');
    assert.equal(rows.length, 2, 'concurrent upserts must remain idempotent');
    assert.deepEqual(rows.map(r => r.trade_date), ['2026-10-01', '2026-10-02']);
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. Exchange holiday -> trading-day gate rejects the date.
// ============================================================================
test('V6E-9: exchange holiday date is rejected by the real trading-day gate', async () => {
  // 2026-06-16 is 1 Muharam exchange holiday in the seed calendar.
  const holiday = '2026-06-16';
  const holidays = calendar.getSeedHolidaySet();
  assert.equal(calendar.isTradingDay(holiday, holidays), false);

  const resolved = await resolveTradingDay(holiday, null);
  assert.equal(resolved.shouldRun, false, 'holiday must not run the candle pass');
  assert.match(resolved.source, /calendar/);
});

// ============================================================================
// 10. Corporate action: provider series preserved as-is (adjusted or unadjusted
//     is the provider's responsibility; no x2/x halfing invented here).
// ============================================================================
test('V6E-10: corporate-action adjusted/unadjusted series is preserved without fabrication', () => {
  const raw = {
    rows: [
      { date: '2026-11-03', open: 1000, high: 1100, low: 990, close: 1080, volume: 5000 },
      { date: '2026-11-04', open: 540, high: 560, low: 535, close: 550, volume: 10000 } // post-split adjusted
    ]
  };
  const normalized = candleFetcher.normalizePayload('SPLIT', raw, 2);
  assert.equal(normalized.candles.length, 2);
  // No synthetic x2/x0.5 adjustment is applied by the normalizer.
  assert.equal(normalized.candles[1].close, 550, 'provider adjusted price must pass through unchanged');
  assert.equal(normalized.candles[1].open, 540);
});
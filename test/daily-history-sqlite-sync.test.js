'use strict';

// BUG-3C-03 regression — daily candle flat files → SQLite stock_daily_history.
//
// Runtime symptom: data/daily-candles/*.json was current but SQLite
// stock_daily_history stalled at 2026-09-29, so run-lifecycle-evaluator.js
// skipped recent history (skipped_no_history: 71).
//
// Every test uses a TEMPORARY local SQLite database (node:sqlite) — the
// production database path is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require('../lib/daily-history-sqlite-sync');
const { VpsMarketStore } = require('../lib/vps-market-store');

function tempCandleDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-candles-'));
  return dir;
}

function writeCandles(dir, ticker, candles) {
  fs.writeFileSync(path.join(dir, ticker + '.json'), JSON.stringify({
    ticker, source: 'fixture', interval: 'daily', candles
  }));
}

function candle(date, close, extra) {
  return Object.assign({
    date,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1000000
  }, extra || {});
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-sqlite-'));
  const store = new VpsMarketStore(path.join(dir, 'market.sqlite'));
  return { dir, store };
}

async function historyRows(store, ticker) {
  const res = await store.from('stock_daily_history')
    .select('ticker,trade_date,open,high,low,close,previous_close,volume')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: true });
  assert.equal(res.error, null);
  return res.data || [];
}

// 2026-10-02 (Fri) is the current trading date used in most fixtures.
// Rolling window sessions=5 ending 2026-10-02 = [2026-09-28..2026-10-02]
// minus none (all are trading days).

test('SYNC-A: empty store + candle fixture → rows inserted', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    writeCandles(candleDir, 'BBCA', [
      candle('2026-09-30', 100),
      candle('2026-10-01', 101),
      candle('2026-10-02', 102)
    ]);
    const result = await sync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'), // 19:00 WIB, after close
      sessions: 5
    });
    assert.equal(result.ok, true);
    assert.equal(result.rows_upserted, 3);
    assert.equal(result.store, 'injected');

    const rows = await historyRows(store, 'BBCA');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].trade_date, '2026-09-30');
    assert.equal(rows[2].trade_date, '2026-10-02');
    assert.equal(rows[2].close, 102);
    assert.equal(rows[1].previous_close, 100, 'previous_close chains from the prior candle');
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNC-B: re-running the same sync is idempotent (no duplicate logical dates)', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    writeCandles(candleDir, 'BBCA', [
      candle('2026-10-01', 101),
      candle('2026-10-02', 102)
    ]);
    const options = {
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    };
    const first = await sync.syncRecentHistoryToSqlite(options);
    const second = await sync.syncRecentHistoryToSqlite(options);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.rows_upserted, first.rows_upserted);

    const rows = await historyRows(store, 'BBCA');
    assert.equal(rows.length, 2, 're-run must not duplicate logical (ticker, trade_date) rows');
    const dates = rows.map((r) => r.trade_date);
    assert.deepEqual(dates, [...new Set(dates)], 'no duplicate trade dates');
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNC-C: existing latest row + newer candle → missing row added', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    // Simulate a store that stalled at 2026-09-30.
    await store.from('stock_daily_history').upsert([{
      ticker: 'BBCA', trade_date: '2026-09-30', open: 99, high: 102, low: 98, close: 100, volume: 900
    }], { onConflict: 'ticker,trade_date' });

    writeCandles(candleDir, 'BBCA', [
      candle('2026-09-30', 100),
      candle('2026-10-01', 101),
      candle('2026-10-02', 102)
    ]);
    const result = await sync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });
    assert.equal(result.ok, true);
    const rows = await historyRows(store, 'BBCA');
    assert.deepEqual(rows.map((r) => r.trade_date), ['2026-09-30', '2026-10-01', '2026-10-02']);
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNC-D: historical two-day gap → both missing days recovered by the rolling window', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    // Store stalled at 2026-09-29 (the verified production symptom).
    await store.from('stock_daily_history').upsert([{
      ticker: 'BBCA', trade_date: '2026-09-29', open: 98, high: 101, low: 97, close: 99, volume: 800
    }], { onConflict: 'ticker,trade_date' });

    writeCandles(candleDir, 'BBCA', [
      candle('2026-09-29', 99),
      candle('2026-09-30', 100),
      candle('2026-10-01', 101),
      candle('2026-10-02', 102)
    ]);
    const result = await sync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });
    assert.equal(result.ok, true);
    assert.equal(result.rows_upserted, 4);
    const rows = await historyRows(store, 'BBCA');
    assert.deepEqual(
      rows.map((r) => r.trade_date),
      ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
      'both missing dates (09-30, 10-01) must be recovered'
    );
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNC-E: invalid and future candles are rejected, never invented', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    writeCandles(candleDir, 'BBCA', [
      candle('2026-10-01', 101),
      candle('2026-10-02', 102),
      // Future date (after the current WIB trading date) must be rejected.
      candle('2026-10-03', 103),
      // Invalid: zero open (the known zero-open anomaly) must be skipped, not fixed.
      { date: '2026-09-30', open: 0, high: 101, low: 97, close: 100, volume: 900 },
      // Invalid: no close at all.
      { date: '2026-09-29', open: 98, high: 101, low: 97, volume: 900 }
    ]);
    const result = await sync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });
    assert.equal(result.ok, true);
    assert.equal(result.rows_upserted, 2, 'only the two valid, non-future candles may persist');
    assert.equal(result.skipped_future, 1);
    assert.equal(result.skipped_invalid, 2);
    assert.equal(result.zero_open_skipped, 1);

    const rows = await historyRows(store, 'BBCA');
    assert.deepEqual(rows.map((r) => r.trade_date), ['2026-10-01', '2026-10-02']);
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNC-F: an upsert failure surfaces as ok:false and leaves no partial batch for that run', async () => {
  const candleDir = tempCandleDir();
  try {
    writeCandles(candleDir, 'BBCA', [candle('2026-10-02', 102)]);
    const failingClient = {
      from() {
        return {
          upsert() {
            return { error: { message: 'simulated sqlite write failure' } };
          }
        };
      }
    };
    const result = await sync.syncRecentHistoryToSqlite({
      client: failingClient,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'upsert_failed');
    assert.equal(result.rows_upserted, 0);
    assert.ok(result.error && result.error.indexOf('simulated') !== -1, 'error message is carried for logging');
  } finally {
    fs.rmSync(candleDir, { recursive: true, force: true });
  }
});

test('SYNC-G: lifecycle evaluator can read the newly synchronized history', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    writeCandles(candleDir, 'BBCA', [
      candle('2026-10-01', 100),
      candle('2026-10-02', 101, { high: 125, low: 99 })
    ]);
    await sync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });

    // This mirrors tools/run-lifecycle-evaluator.js's read: history strictly
    // AFTER the signal date, ordered ascending — the exact query shape whose
    // empty result used to produce skipped_no_history.
    const res = await store.from('stock_daily_history')
      .select('trade_date,high,low')
      .eq('ticker', 'BBCA')
      .gt('trade_date', '2026-09-30')
      .order('trade_date', { ascending: true })
      .limit(60);
    assert.equal(res.error, null);
    assert.equal(res.data.length, 2, 'the evaluator must now see post-signal history');

    // TP1 resolution works on the synchronized row (high 125 >= tp1 120).
    const tp1 = 120;
    const hit = res.data.find((d) => Number(d.high) >= tp1);
    assert.ok(hit, 'TP1 outcome must be resolvable from synchronized history');
    assert.equal(hit.trade_date, '2026-10-02');
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNC-H: the rolling window is trading-session bounded (weekend/holiday aware)', async () => {
  const candleDir = tempCandleDir();
  const { dir, store } = tempStore();
  try {
    // Monday 2026-09-28 with sessions=2 must cover [Fri 09-25, Mon 09-28].
    writeCandles(candleDir, 'BBCA', [
      candle('2026-09-24', 98),
      candle('2026-09-25', 99),
      candle('2026-09-28', 100)
    ]);
    const result = await sync.syncRecentHistoryToSqlite({
      client: store,
      candleDir,
      now: new Date('2026-09-28T12:00:00Z'),
      sessions: 2
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.window, ['2026-09-28', '2026-09-25']);
    const rows = await historyRows(store, 'BBCA');
    assert.deepEqual(rows.map((r) => r.trade_date), ['2026-09-25', '2026-09-28'],
      'window must be two trading sessions, not two calendar days');
  } finally {
    store.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

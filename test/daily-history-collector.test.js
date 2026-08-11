'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const { collectDailyHistoryForTickers, candlesToHistoryRows } = require('../lib/daily-history-collector');

function makeCandles(startClose, count) {
  const candles = [];
  const start = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    candles.push({
      date: d.toISOString().slice(0, 10),
      open: startClose + i,
      high: startClose + i + 1,
      low: startClose + i - 1,
      close: startClose + i,
      volume: 1000 + i
    });
  }
  return candles;
}

test('candlesToHistoryRows chains previous_close from the prior fetched candle', () => {
  const candles = makeCandles(100, 3);
  const rows = candlesToHistoryRows('BBCA', candles, {});
  assert.equal(rows[0].previous_close, null);
  assert.equal(rows[1].previous_close, 100);
  assert.equal(rows[2].previous_close, 101);
});

test('candlesToHistoryRows trims to the retention window', () => {
  const candles = makeCandles(100, 200);
  const rows = candlesToHistoryRows('BBCA', candles, { retentionSessions: 120 });
  assert.equal(rows.length, 120);
});

test('collectDailyHistoryForTickers upserts fetched candles and skips insufficient data', async () => {
  const supabase = makeFakeSupabase();
  const fetchFn = async (ticker) => {
    if (ticker === 'BBCA') return makeCandles(9000, 30);
    if (ticker === 'THIN') return makeCandles(100, 5); // below MIN_CANDLES_REQUIRED(20)
    return null; // TLKM fails
  };

  const result = await collectDailyHistoryForTickers(supabase, ['BBCA', 'THIN', 'TLKM'], { fetchFn });

  assert.equal(result.tickers_collected, 1);
  assert.equal(result.skipped.length, 2); // THIN: below min candle count; TLKM: fetch returned null
  assert.ok(result.skipped.some((s) => s.ticker === 'THIN'));
  assert.ok(result.skipped.some((s) => s.ticker === 'TLKM'));
  assert.equal(result.rows_upserted, 30);

  const bbcaRows = supabase._tables.stock_daily_history.filter((r) => r.ticker === 'BBCA');
  assert.equal(bbcaRows.length, 30);
});

test('collectDailyHistoryForTickers is idempotent on repeated runs', async () => {
  const supabase = makeFakeSupabase();
  const fetchFn = async () => makeCandles(9000, 25);

  await collectDailyHistoryForTickers(supabase, ['BBCA'], { fetchFn });
  await collectDailyHistoryForTickers(supabase, ['BBCA'], { fetchFn });

  const bbcaRows = supabase._tables.stock_daily_history.filter((r) => r.ticker === 'BBCA');
  assert.equal(bbcaRows.length, 25); // no duplicates from the second run
});

test('a single ticker fetch error does not abort the batch', async () => {
  const supabase = makeFakeSupabase();
  const fetchFn = async (ticker) => {
    if (ticker === 'ERR') throw new Error('network fail');
    return makeCandles(100, 25);
  };

  const result = await collectDailyHistoryForTickers(supabase, ['ERR', 'BBCA'], { fetchFn });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].ticker, 'ERR');
  assert.equal(result.tickers_collected, 1);
});

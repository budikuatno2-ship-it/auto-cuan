'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const { collectDailyHistoryForTickers, candlesToHistoryRows, isPartialSession, computeWeek52FromCandles } = require('../lib/daily-history-collector');

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

// --- Intraday-partial vs final-EOD session classification ---

test('isPartialSession: today before the settle cutoff is partial', () => {
  const now = new Date('2026-08-11T05:00:00.000Z'); // 12:00 WIB — mid trading session
  assert.equal(isPartialSession('2026-08-11', now), true);
});

test('isPartialSession: today after the settle cutoff (16:00 WIB) is final', () => {
  const now = new Date('2026-08-11T10:00:00.000Z'); // 17:00 WIB — after close/settle
  assert.equal(isPartialSession('2026-08-11', now), false);
});

test('isPartialSession: a prior session date is never partial, regardless of time', () => {
  const now = new Date('2026-08-11T05:00:00.000Z'); // 12:00 WIB
  assert.equal(isPartialSession('2026-08-10', now), false);
});

test('candlesToHistoryRows marks only the LAST candle partial when fetched mid-session', () => {
  const candles = makeCandles(100, 3); // dates 2026-01-01, 01-02, 01-03
  const rows = candlesToHistoryRows('BBCA', candles, {
    now: new Date('2026-01-03T05:00:00.000Z') // 12:00 WIB on the last candle's date
  });
  assert.equal(rows[0].data_quality_status, 'ok');
  assert.equal(rows[1].data_quality_status, 'ok');
  assert.equal(rows[2].data_quality_status, 'partial');
});

test('candlesToHistoryRows marks all candles ok when the fetch happens after market close', () => {
  const candles = makeCandles(100, 3);
  const rows = candlesToHistoryRows('BBCA', candles, {
    now: new Date('2026-01-03T10:00:00.000Z') // 17:00 WIB, after settle cutoff
  });
  rows.forEach((r) => assert.equal(r.data_quality_status, 'ok'));
});

// --- 52-week high/low derived from the full ~1y Yahoo fetch ---

test('computeWeek52FromCandles finds the true high/low across the whole fetched series, not just the retention window', () => {
  // 200 candles: retention only keeps the last 120, but the 52W high/low
  // must come from ALL 200 (the early candles hold the real extremes here).
  const candles = makeCandles(100, 200); // close/high/low climb from 100..299
  const result = computeWeek52FromCandles(candles);
  assert.equal(result.week52_low, candles[0].low); // 99
  assert.equal(result.week52_low_date, candles[0].date);
  assert.equal(result.week52_high, candles[199].high); // 300
  assert.equal(result.week52_high_date, candles[199].date);
  assert.equal(result.week52_basis_sessions, 200);
});

test('computeWeek52FromCandles returns nulls for an empty/missing candle series (never fabricated)', () => {
  assert.deepEqual(computeWeek52FromCandles([]), {
    week52_high: null, week52_high_date: null, week52_low: null, week52_low_date: null, week52_basis_sessions: 0
  });
  assert.deepEqual(computeWeek52FromCandles(null), {
    week52_high: null, week52_high_date: null, week52_low: null, week52_low_date: null, week52_basis_sessions: 0
  });
});

test('collectDailyHistoryForTickers returns a per-ticker week52 map derived from the full fetch, not the trimmed rows', async () => {
  const supabase = makeFakeSupabase();
  const fetchFn = async (ticker) => (ticker === 'BBCA' ? makeCandles(9000, 200) : null);

  const result = await collectDailyHistoryForTickers(supabase, ['BBCA'], { fetchFn, retentionSessions: 120 });

  assert.ok(result.week52.BBCA);
  assert.equal(result.week52.BBCA.week52_low, 8999); // from candle index 0, outside the 120-row retention window
  assert.equal(result.week52.BBCA.week52_high, 9200); // close+1 of the last (200th) candle

  const bbcaRows = supabase._tables.stock_daily_history.filter((r) => r.ticker === 'BBCA');
  assert.equal(bbcaRows.length, 120); // retention trimmed the persisted rows...
  assert.equal(Math.min(...bbcaRows.map((r) => r.low)), 9079); // ...but week52 low above is NOT inside this trimmed set
});

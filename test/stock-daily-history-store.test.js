'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const store = require('../lib/stock-daily-history-store');

function historyRow(ticker, trade_date, close, volume) {
  return { ticker, trade_date, open: close, high: close, low: close, close, previous_close: null, volume,
    value: null, frequency: null, foreign_buy_value: null, foreign_sell_value: null, foreign_net_value: null,
    foreign_buy_lot: null, foreign_sell_lot: null, foreign_net_lot: null,
    data_source: 'yahoo', source_timestamp: new Date().toISOString(), data_quality_status: 'ok' };
}

test('duplicate ticker/trade_date upsert is idempotent (no duplicate rows)', async () => {
  const supabase = makeFakeSupabase();
  const row = historyRow('BBCA', '2026-08-11', 9000, 1000);

  await store.upsertDailyHistory(supabase, [row]);
  await store.upsertDailyHistory(supabase, [Object.assign({}, row, { close: 9100 })]);

  const rows = supabase._tables.stock_daily_history.filter((r) => r.ticker === 'BBCA' && r.trade_date === '2026-08-11');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].close, 9100); // second upsert overwrote, did not duplicate
});

test('getLatestSessionsForTickers batches multiple tickers in one call, newest first', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: [
      historyRow('BBCA', '2026-08-10', 9000, 100),
      historyRow('BBCA', '2026-08-11', 9100, 200),
      historyRow('TLKM', '2026-08-11', 3000, 300)
    ]
  });

  const map = await store.getLatestSessionsForTickers(supabase, ['BBCA', 'TLKM'], 7);
  assert.equal(map.get('BBCA').length, 2);
  assert.equal(map.get('BBCA')[0].trade_date, '2026-08-11'); // newest first
  assert.equal(map.get('TLKM').length, 1);
});

test('enforceRetention keeps only the most recent N sessions per ticker', async () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(historyRow('BBCA', '2026-08-' + String(i).padStart(2, '0'), 9000 + i, 100));
  }
  const supabase = makeFakeSupabase({ stock_daily_history: rows });

  const deleted = await store.enforceRetention(supabase, ['BBCA'], 5);
  assert.equal(deleted, 5);
  const remaining = supabase._tables.stock_daily_history.filter((r) => r.ticker === 'BBCA');
  assert.equal(remaining.length, 5);
  // The 5 most recent dates (08-06..08-10) should remain.
  const dates = remaining.map((r) => r.trade_date).sort();
  assert.deepEqual(dates, ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10']);
});

test('upsertDailyFeatures is keyed on ticker (one row per ticker)', async () => {
  const supabase = makeFakeSupabase();
  await store.upsertDailyFeatures(supabase, [{ ticker: 'BBCA', as_of_trade_date: '2026-08-11', last_price: 9100 }]);
  await store.upsertDailyFeatures(supabase, [{ ticker: 'BBCA', as_of_trade_date: '2026-08-12', last_price: 9200 }]);

  const rows = supabase._tables.stock_daily_features.filter((r) => r.ticker === 'BBCA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_price, 9200);
});

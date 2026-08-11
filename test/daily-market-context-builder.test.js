'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const builder = require('../lib/daily-market-context-builder');

function historyRow(ticker, trade_date, close, volume, extra) {
  return Object.assign({ ticker, trade_date, open: close, high: close, low: close, close,
    previous_close: null, volume, data_source: 'yahoo', data_quality_status: 'ok' }, extra || {});
}

function foreignRow(ticker, trade_date, foreign_net) {
  return { ticker, trade_date, foreign_buy: null, foreign_sell: null, foreign_net };
}

test('buildContextForTicker: complete data produces a full context object', async () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(9000 + i * 10);
  const rows = closes.map((c, i) => historyRow('BBCA', '2026-07-' + String(i + 1).padStart(2, '0'), c, 1000 + i))
    .reverse(); // newest first, as the store returns them

  const supabase = makeFakeSupabase({
    stock_daily_history: rows,
    foreign_watchlist_daily: [
      foreignRow('BBCA', '2026-07-20', 5000),
      foreignRow('BBCA', '2026-07-19', -2000)
    ],
    stock_fundamentals: [{ ticker: 'BBCA', book_value_per_share: 3000, fundamental_period: 'Q2-2026', source: 'manual' }]
  });

  const context = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-07-21T10:00:00Z') });

  assert.equal(context.ticker, 'BBCA');
  assert.ok(context.price.last > 0);
  assert.ok(context.technical.rsi_14 != null);
  assert.equal(context.fundamental.data_available, true);
  assert.ok(context.volume.volume_history_7d.length > 0);
  assert.ok(context.foreign.foreign_history_7d.length > 0);
});

test('buildContextForTicker: partial/missing data returns nulls, not fabricated values', async () => {
  const supabase = makeFakeSupabase({}); // nothing seeded
  const context = await builder.buildContextForTicker(supabase, 'NEWCO', {});

  assert.equal(context.price.last, null);
  assert.equal(context.technical.rsi_14, null);
  assert.equal(context.technical.rsi_insufficient_history, true);
  assert.equal(context.fundamental.pbv, null);
  assert.equal(context.fundamental.data_available, false);
  assert.equal(context.volume.volume_today, null);
  assert.equal(context.foreign.foreign_net_today, null);
});

test('buildContextForTicker: stale fundamental vs fresh price are both surfaced, not hidden', async () => {
  const rows = [historyRow('BBCA', '2026-08-11', 9500, 1000)];
  const supabase = makeFakeSupabase({
    stock_daily_history: rows,
    stock_fundamentals: [{ ticker: 'BBCA', book_value_per_share: 3000, fundamental_period: 'FY2023', source: 'manual', updated_at: '2024-01-01T00:00:00Z' }]
  });

  const context = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-08-11T10:00:00Z') });

  assert.equal(context.price.freshness, 'current');
  assert.equal(context.fundamental.fundamental_period, 'FY2023'); // old period preserved, not hidden
  assert.equal(context.fundamental.data_available, true);
});

test('buildFeatureSnapshotsForTickers builds rows for a whole ticker batch from bounded queries', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: [historyRow('BBCA', '2026-08-11', 9500, 1000), historyRow('TLKM', '2026-08-11', 3000, 500)]
  });

  const rows = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA', 'TLKM'], {});
  assert.equal(rows.length, 2);
  assert.ok(rows.find((r) => r.ticker === 'BBCA'));
  assert.ok(rows.find((r) => r.ticker === 'TLKM'));
});

test('priceFreshness marks old as_of_trade_date as stale', () => {
  const freshness = builder.priceFreshness('2026-01-01', new Date('2026-08-11T00:00:00Z'));
  assert.equal(freshness, 'stale');
});

test('priceFreshness marks a recent as_of_trade_date as current', () => {
  const freshness = builder.priceFreshness('2026-08-11', new Date('2026-08-11T10:00:00Z'));
  assert.equal(freshness, 'current');
});

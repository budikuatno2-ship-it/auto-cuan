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

  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA', 'TLKM'], {});
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.find((r) => r.ticker === 'BBCA'));
  assert.ok(result.rows.find((r) => r.ticker === 'TLKM'));
  assert.equal(result.skippedTickers.length, 0);
});

test('buildFeatureSnapshotsForTickers skips a ticker with no history entirely (never writes as_of_trade_date=null)', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: [historyRow('BBCA', '2026-08-11', 9500, 1000)]
    // TLKM has no rows in stock_daily_history at all.
  });

  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA', 'TLKM'], {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].ticker, 'BBCA');
  assert.equal(result.skippedTickers.length, 1);
  assert.equal(result.skippedTickers[0], 'TLKM');
  result.rows.forEach((r) => assert.notEqual(r.as_of_trade_date, null));
});

test('buildFeatureSnapshotsForTickers: mixed batch — valid ticker still builds even when another ticker has no history', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: [
      historyRow('AAAA', '2026-08-11', 100, 1000)
      // BBBB: no history rows (simulates a Yahoo fetch failure/insufficient data upstream).
    ]
  });

  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['AAAA', 'BBBB'], {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].ticker, 'AAAA');
  assert.deepEqual(result.skippedTickers, ['BBBB']);
});

test('buildFeatureSnapshotsForTickers returns empty rows/skipped for an empty ticker list', async () => {
  const supabase = makeFakeSupabase();
  const result = await builder.buildFeatureSnapshotsForTickers(supabase, [], {});
  assert.deepEqual(result, { rows: [], skippedTickers: [] });
});

test('buildContextFromRows: week52 distance is derived from options.week52, not the trimmed history window', () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(9000 + i * 10);
  const rows = closes.map((c, i) => historyRow('BBCA', '2026-07-' + String(i + 1).padStart(2, '0'), c, 1000 + i)).reverse();

  const context = builder.buildContextFromRows('BBCA', rows, [], null, {
    now: new Date('2026-07-21T10:00:00Z'),
    week52: { week52_high: 10000, week52_high_date: '2026-05-01', week52_low: 8000, week52_low_date: '2026-01-01' }
  });

  assert.equal(context.technical.week52_high, 10000);
  assert.equal(context.technical.week52_low, 8000);
  const lastPrice = context.price.last;
  assert.equal(context.technical.week52_high_dist_pct, Math.round(((lastPrice - 10000) / 10000) * 10000) / 100);
  assert.equal(context.technical.week52_low_dist_pct, Math.round(((lastPrice - 8000) / 8000) * 10000) / 100);
});

test('buildContextFromRows: week52 fields are null (not fabricated) when no week52 data is supplied', () => {
  const rows = [historyRow('BBCA', '2026-08-11', 9500, 1000)];
  const context = builder.buildContextFromRows('BBCA', rows, [], null, {});
  assert.equal(context.technical.week52_high, null);
  assert.equal(context.technical.week52_low, null);
  assert.equal(context.technical.week52_high_dist_pct, null);
});

test('buildFeatureSnapshotsForTickers persists week52 + change_pct fields when week52ByTicker is supplied', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: [
      historyRow('BBCA', '2026-08-10', 9000, 1000),
      historyRow('BBCA', '2026-08-11', 9500, 1100, { previous_close: 9000 })
    ]
  });

  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA'], {
    week52ByTicker: { BBCA: { week52_high: 10000, week52_high_date: '2026-05-01', week52_low: 8000, week52_low_date: '2026-01-01' } }
  });

  const row = result.rows.find((r) => r.ticker === 'BBCA');
  assert.equal(row.week52_high, 10000);
  assert.equal(row.week52_low, 8000);
  assert.ok(row.week52_high_dist_pct < 0); // last price (9500) is below the 52W high
  assert.equal(row.previous_close, 9000);
  assert.equal(row.change_pct, Math.round(((9500 - 9000) / 9000) * 10000) / 100);
});

test('buildFeatureSnapshotsForTickers leaves week52 fields null when no week52ByTicker is supplied (backward compatible)', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: [historyRow('BBCA', '2026-08-11', 9500, 1000)]
  });
  const result = await builder.buildFeatureSnapshotsForTickers(supabase, ['BBCA'], {});
  const row = result.rows.find((r) => r.ticker === 'BBCA');
  assert.equal(row.week52_high, null);
  assert.equal(row.week52_high_dist_pct, null);
});

test('buildRankingList maps stock_daily_features rows into the ranking table shape, excluding PBV', () => {
  const rows = builder.buildRankingList([
    {
      ticker: 'BBCA', as_of_trade_date: '2026-08-11', last_price: 9500, previous_close: 9000, change_pct: 5.56,
      data_freshness: 'current', rsi_14: 62.3, rsi_state: 'NEUTRAL',
      week52_high: 10000, week52_high_date: '2026-05-01', week52_low: 8000, week52_low_date: '2026-01-01',
      week52_high_dist_pct: -5, week52_low_dist_pct: 18.75,
      volume_today: 1000, volume_ratio_vs_7d_avg: 1.2,
      foreign_net_today: 5000, foreign_net_7d: 12000, foreign_net_streak: 3,
      pbv: 2.5 // must NOT appear in the mapped ranking row
    }
  ]);

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.ticker, 'BBCA');
  assert.equal(row.rsi_14, 62.3);
  assert.equal(row.week52_high_dist_pct, -5);
  assert.equal(row.change_pct, 5.56);
  assert.equal('pbv' in row, false);
});

test('buildRankingList renders genuinely missing fields as null (UI shows N/A), never a fabricated 0', () => {
  const rows = builder.buildRankingList([{ ticker: 'NEWCO', as_of_trade_date: '2026-08-11' }]);
  assert.equal(rows[0].rsi_14, null);
  assert.equal(rows[0].week52_high_dist_pct, null);
  assert.equal(rows[0].change_pct, null);
});

test('buildRankingList returns an empty array for empty/missing input', () => {
  assert.deepEqual(builder.buildRankingList([]), []);
  assert.deepEqual(builder.buildRankingList(null), []);
});

test('priceFreshness marks old as_of_trade_date as stale', () => {
  const freshness = builder.priceFreshness('2026-01-01', new Date('2026-08-11T00:00:00Z'));
  assert.equal(freshness, 'stale');
});

test('priceFreshness marks a recent as_of_trade_date as current', () => {
  const freshness = builder.priceFreshness('2026-08-11', new Date('2026-08-11T10:00:00Z'));
  assert.equal(freshness, 'current');
});

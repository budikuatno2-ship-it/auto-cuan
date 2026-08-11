'use strict';

/**
 * Proves the exact checklist of user-visible fields (task spec Part D) is
 * actually present on the object returned by buildContextForTicker — the
 * same function api/quote.js?action=daily-market-context calls to build its
 * response. This is deliberately a field-presence/semantics test, not a
 * re-test of the underlying math (already covered by the per-module test
 * files for RSI/volume/foreign/PBV).
 */

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

function buildDeepHistory(ticker, closesOldestFirst, datesOldestFirst) {
  return closesOldestFirst.map((c, i) => historyRow(ticker, datesOldestFirst[i], c, 1000 + i * 7))
    .slice().reverse(); // store newest-first, matching what the DB layer returns
}

test('last price is exposed', async () => {
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22'];
  const closes = [9000, 9050, 9100];
  const supabase = makeFakeSupabase({ stock_daily_history: buildDeepHistory('BBCA', closes, dates) });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-07-22T10:00:00Z') });
  assert.equal(ctx.price.last, 9100);
});

test('RSI14 + state classification covers OVERSOLD / NEUTRAL / OVERBOUGHT', async () => {
  const dates = Array.from({ length: 15 }, (_, i) => '2026-07-' + String(i + 1).padStart(2, '0'));

  const upClosesForOverbought = Array.from({ length: 15 }, (_, i) => 100 + i);
  let ctx = await builder.buildContextForTicker(
    makeFakeSupabase({ stock_daily_history: buildDeepHistory('AAAA', upClosesForOverbought, dates) }),
    'AAAA', {});
  assert.equal(ctx.technical.rsi_state, 'OVERBOUGHT');

  const downClosesForOversold = Array.from({ length: 15 }, (_, i) => 200 - i);
  ctx = await builder.buildContextForTicker(
    makeFakeSupabase({ stock_daily_history: buildDeepHistory('BBBB', downClosesForOversold, dates) }),
    'BBBB', {});
  assert.equal(ctx.technical.rsi_state, 'OVERSOLD');

  const flatClosesForNeutral = Array.from({ length: 15 }, () => 100);
  ctx = await builder.buildContextForTicker(
    makeFakeSupabase({ stock_daily_history: buildDeepHistory('CCCC', flatClosesForNeutral, dates) }),
    'CCCC', {});
  assert.equal(ctx.technical.rsi_state, 'NEUTRAL');
});

test('PBV is N/A (null) with provenance fields present but empty when no fundamentals exist', async () => {
  const supabase = makeFakeSupabase({ stock_daily_history: buildDeepHistory('BBCA', [9000], ['2026-07-20']) });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', {});
  assert.equal(ctx.fundamental.pbv, null);
  assert.equal(ctx.fundamental.data_available, false);
  assert.equal('fundamental_period' in ctx.fundamental, true);
  assert.equal('fundamental_source' in ctx.fundamental, true);
});

test('PBV is populated with provenance when fundamentals exist', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: buildDeepHistory('BBCA', [9000], ['2026-07-20']),
    stock_fundamentals: [{ ticker: 'BBCA', book_value_per_share: 4500, fundamental_period: 'FY2025', source: 'admin_csv_import' }]
  });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', {});
  assert.equal(ctx.fundamental.pbv, 2);
  assert.equal(ctx.fundamental.fundamental_period, 'FY2025');
  assert.equal(ctx.fundamental.fundamental_source, 'admin_csv_import');
});

test('current/latest and previous session volume, 7-session history, average, and ratios are all exposed', async () => {
  const dates = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12'];
  const closes = [100, 101, 102, 103, 104, 105, 106];
  const supabase = makeFakeSupabase({ stock_daily_history: buildDeepHistory('BBCA', closes, dates) });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-08-12T10:00:00Z') });

  assert.ok(ctx.volume.volume_today != null);
  assert.ok(ctx.volume.volume_previous_session != null);
  assert.equal(ctx.volume.volume_history_7d.length, 7);
  assert.ok(ctx.volume.volume_avg_7d != null);
  assert.ok(ctx.volume.volume_ratio_vs_previous != null);
  assert.ok(ctx.volume.volume_ratio_vs_7d_avg != null);
});

test('current-day volume session status is explicit: INTRADAY_PARTIAL vs FINAL_EOD', async () => {
  const partialRow = historyRow('BBCA', '2026-08-12', 106, 500, { data_quality_status: 'partial' });
  const finalRow = historyRow('BBCA', '2026-08-11', 105, 1000);
  const supabase = makeFakeSupabase({ stock_daily_history: [partialRow, finalRow] });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', {});
  assert.equal(ctx.volume.today_session_status, 'INTRADAY_PARTIAL');
  assert.equal(ctx.volume.is_today_partial_session, true);

  const eodOnly = makeFakeSupabase({ stock_daily_history: [finalRow] });
  const ctx2 = await builder.buildContextForTicker(eodOnly, 'BBCA', {});
  assert.equal(ctx2.volume.today_session_status, 'FINAL_EOD');
});

test('foreign net today and per-session history for the last 7 sessions are exposed', async () => {
  const rows = [
    foreignRow('BBCA', '2026-08-12', 500), foreignRow('BBCA', '2026-08-11', -200),
    foreignRow('BBCA', '2026-08-10', 100), foreignRow('BBCA', '2026-08-07', 300),
    foreignRow('BBCA', '2026-08-06', -50), foreignRow('BBCA', '2026-08-05', 10),
    foreignRow('BBCA', '2026-08-04', 20)
  ];
  const supabase = makeFakeSupabase({
    stock_daily_history: buildDeepHistory('BBCA', [100], ['2026-08-12']),
    foreign_watchlist_daily: rows
  });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', {});
  assert.equal(ctx.foreign.foreign_net_today, 500);
  assert.equal(ctx.foreign.foreign_history_7d.length, 7);
  assert.equal(ctx.foreign.foreign_net_7d, 500 - 200 + 100 + 300 - 50 + 10 + 20);
});

test('missing foreign data is null/N-A, never silently zero', async () => {
  const supabase = makeFakeSupabase({ stock_daily_history: buildDeepHistory('NEWCO', [100], ['2026-08-12']) });
  const ctx = await builder.buildContextForTicker(supabase, 'NEWCO', {});
  assert.equal(ctx.foreign.foreign_net_today, null);
  assert.equal(ctx.foreign.foreign_net_7d, null);
});

test('upcoming exchange holiday is exposed via calendar context', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: buildDeepHistory('BBCA', [100], ['2026-08-11']),
    idx_trading_calendar: [{ trade_date: '2026-08-17', status: 'HOLIDAY', name: 'Proklamasi Kemerdekaan', source: 'seed' }]
  });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-08-11T05:00:00Z') });
  assert.ok(ctx.calendar);
  assert.equal(ctx.calendar.next_holiday.trade_date, '2026-08-17');
  assert.equal(ctx.calendar.next_holiday.name, 'Proklamasi Kemerdekaan');
  assert.equal(ctx.calendar.market_open_today, true);
});

test('calendar context falls back cleanly when no holiday rows exist yet', async () => {
  const supabase = makeFakeSupabase({ stock_daily_history: buildDeepHistory('BBCA', [100], ['2026-08-11']) });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-08-11T05:00:00Z') });
  assert.equal(ctx.calendar.next_holiday, null);
  assert.equal(ctx.calendar.calendar_source, 'weekend_only_fallback');
});

test('calendar context reports market closed on a seeded holiday', async () => {
  const supabase = makeFakeSupabase({
    stock_daily_history: buildDeepHistory('BBCA', [100], ['2026-08-14']),
    idx_trading_calendar: [{ trade_date: '2026-08-17', status: 'HOLIDAY', name: 'Proklamasi Kemerdekaan', source: 'seed' }]
  });
  const ctx = await builder.buildContextForTicker(supabase, 'BBCA', { now: new Date('2026-08-17T02:00:00Z') });
  assert.equal(ctx.calendar.market_open_today, false);
});

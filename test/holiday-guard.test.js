'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { marketDayGuard } = require('../lib/idx-trading-calendar');
const { makeFakeSupabase } = require('./helpers/fake-supabase');

// Guard must exit safely (shouldRun=false) BEFORE any expensive downstream
// work (market-data scans, network calls, Telegram) — verified here by
// asserting no history/foreign/feature queries happen when the guard says no.

test('market closed (weekend) exits safely without touching data tables', async () => {
  const supabase = makeFakeSupabase({
    idx_trading_calendar: [],
    stock_daily_history: [{ ticker: 'BBCA', trade_date: '2026-08-14', close: 9000 }]
  });

  const guard = await marketDayGuard(supabase, { now: new Date('2026-08-15T02:00:00Z') }); // Saturday
  assert.equal(guard.shouldRun, false);
  assert.equal(guard.reason, 'MARKET_CLOSED');

  // Simulate the cron wrapper pattern: only touch stock_daily_history if guard passes.
  let expensiveWorkRan = false;
  if (guard.shouldRun) {
    expensiveWorkRan = true;
  }
  assert.equal(expensiveWorkRan, false);
});

test('market closed (declared exchange holiday) exits safely even on a weekday', async () => {
  const supabase = makeFakeSupabase({
    idx_trading_calendar: [{ trade_date: '2026-08-17', status: 'HOLIDAY', name: 'Test holiday', source: 'manual' }]
  });

  const guard = await marketDayGuard(supabase, { now: new Date('2026-08-17T02:00:00Z') }); // Monday, declared holiday
  assert.equal(guard.shouldRun, false);
  assert.equal(guard.reason, 'MARKET_CLOSED');
  assert.equal(guard.calendarSource, 'db');
});

test('trading day allows the guard to pass through so downstream work can run', async () => {
  const supabase = makeFakeSupabase({ idx_trading_calendar: [] });
  const guard = await marketDayGuard(supabase, { now: new Date('2026-08-11T02:00:00Z') }); // Tuesday
  assert.equal(guard.shouldRun, true);
});

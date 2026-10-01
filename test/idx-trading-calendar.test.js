'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const calendar = require('../lib/idx-trading-calendar');

test('weekday with no holidays is a trading day', () => {
  // 2026-08-11 is a Tuesday
  assert.equal(calendar.isTradingDay('2026-08-11', new Set()), true);
});

test('Saturday is not a trading day', () => {
  // 2026-08-15 is a Saturday
  assert.equal(calendar.isTradingDay('2026-08-15', new Set()), false);
});

test('Sunday is not a trading day', () => {
  // 2026-08-16 is a Sunday
  assert.equal(calendar.isTradingDay('2026-08-16', new Set()), false);
});

test('known holiday in the set is not a trading day', () => {
  const holidays = new Set(['2026-08-17']); // a Monday, marked as holiday
  assert.equal(calendar.isTradingDay('2026-08-17', holidays), false);
  assert.equal(calendar.isTradingDay('2026-08-18', holidays), true);
});

test('previousTradingDay skips a weekend', () => {
  // Monday 2026-08-17 -> previous trading day should be Friday 2026-08-14
  assert.equal(calendar.previousTradingDay('2026-08-17', new Set()), '2026-08-14');
});

test('previousTradingDay skips a holiday plus surrounding weekend', () => {
  // Friday 2026-08-14 marked HOLIDAY -> previous trading day from Monday 08-17
  // should skip Sat/Sun AND the Friday holiday, landing on Thursday 08-13.
  const holidays = new Set(['2026-08-14']);
  assert.equal(calendar.previousTradingDay('2026-08-17', holidays), '2026-08-13');
});

test('nextTradingDay skips a weekend', () => {
  // Friday 2026-08-14 -> next trading day should be Monday 2026-08-17
  assert.equal(calendar.nextTradingDay('2026-08-14', new Set()), '2026-08-17');
});

test('getLastTradingDays returns the last 7 trading sessions, most recent first', () => {
  // Anchor on Monday 2026-08-17 (a trading day), no holidays.
  const days = calendar.getLastTradingDays('2026-08-17', 7, new Set());
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-08-17');
  // Walking back from Monday: Fri, Thu, Wed, Tue, Mon (prior week), Fri (prior week)
  assert.deepEqual(days, [
    '2026-08-17', '2026-08-14', '2026-08-13', '2026-08-12', '2026-08-11', '2026-08-10', '2026-08-07'
  ]);
});

test('getLastTradingDays excludes the anchor date when it is not itself a trading day', () => {
  // Anchor on Saturday 2026-08-15 (not a trading day) -> should not appear in results.
  const days = calendar.getLastTradingDays('2026-08-15', 3, new Set());
  assert.equal(days.includes('2026-08-15'), false);
  assert.deepEqual(days, ['2026-08-14', '2026-08-13', '2026-08-12']);
});

test('getUpcomingMarketHolidays filters and sorts from a given date', () => {
  const rows = [
    { trade_date: '2026-03-19', name: 'Nyepi joint leave' },
    { trade_date: '2026-01-01', name: 'New Year' },
    { trade_date: '2026-08-17', name: 'Independence Day' }
  ];
  const upcoming = calendar.getUpcomingMarketHolidays(rows, '2026-02-01');
  assert.deepEqual(upcoming.map((r) => r.trade_date), ['2026-03-19', '2026-08-17']);
});

test('loadHolidayCalendar falls back to weekend_only when supabase client is missing', async () => {
  const result = await calendar.loadHolidayCalendar(null, {});
  assert.equal(result.source, 'weekend_only_fallback');
  assert.equal(result.holidaySet.size, 0);
});

test('loadHolidayCalendar falls back to weekend_only when table is empty', async () => {
  const fakeSupabase = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        gte() { return this; },
        lte() { return this; },
        then(resolve) { return resolve({ data: [], error: null }); }
      };
    }
  };
  const result = await calendar.loadHolidayCalendar(fakeSupabase, {});
  assert.equal(result.source, 'weekend_only_fallback');
});

test('marketDayGuard exits MARKET_CLOSED on a weekend without needing holiday data', async () => {
  const result = await calendar.marketDayGuard(null, { now: new Date('2026-08-15T02:00:00Z') });
  assert.equal(result.shouldRun, false);
  assert.equal(result.reason, 'MARKET_CLOSED');
});

test('marketDayGuard allows a plain weekday to run', async () => {
  const result = await calendar.marketDayGuard(null, { now: new Date('2026-08-11T02:00:00Z') });
  assert.equal(result.shouldRun, true);
  assert.equal(result.reason, 'trading_day');
});

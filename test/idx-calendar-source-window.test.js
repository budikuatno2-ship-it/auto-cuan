'use strict';

// Regression coverage for the calendar `source` label.
//
// loadHolidayCalendar reported:
//
//   source: rows.length ? 'db' : 'weekend_only_fallback'
//
// but most callers pass a narrow date window:
//
//   marketDayGuard        -> fromDate today-3, toDate today+3
//   buildContextForTicker -> fromDate today,   toDate today+90
//
// An empty result inside a narrow window does NOT mean the calendar is
// unavailable - it usually just means no exchange holiday falls in the next
// few days. The repo ships scripts/seed-idx-holidays-2026.js precisely so an
// operator can populate this table, and after they do,
// scripts/collect-daily-market-context.js:122 still logged
// `calendar_source=weekend_only_fallback` on every ordinary week, telling the
// operator their seeded calendar was not being used when it was.
//
// An empty result proves the table is empty ONLY when no window filter was
// applied. That distinction is what these tests pin.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadHolidayCalendar, marketDayGuard } = require('../lib/idx-trading-calendar');

// Minimal PostgREST-ish stub. It ACTUALLY APPLIES the gte/lte filters, which
// is the whole point: a stub that ignores them lets the pre-fix code look
// correct, because the row it should never have seen comes back anyway. The
// production failure only reproduces when the window really filters.
function fakeSupabase(rows, options) {
  options = options || {};
  const applied = { gte: null, lte: null, limit: null };
  const query = {
    select() { return query; },
    eq() { return query; },
    order() { return query; },
    gte(_col, value) { applied.gte = value; return query; },
    lte(_col, value) { applied.lte = value; return query; },
    limit(value) { applied.limit = value; return query; },
    then(resolve, reject) {
      if (options.error) {
        return Promise.resolve({ data: null, error: { message: options.error } }).then(resolve, reject);
      }
      const filtered = (rows || []).filter((row) => {
        const key = String(row.trade_date).slice(0, 10);
        if (applied.gte && key < applied.gte) return false;
        if (applied.lte && key > applied.lte) return false;
        return true;
      });
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    }
  };
  return { applied, from() { return query; } };
}

const HOLIDAY = { trade_date: '2026-12-25', status: 'HOLIDAY', name: 'Natal', source: 'seed' };

test('an empty calendar table is still reported as unverified', async () => {
  const db = fakeSupabase([]);
  const result = await loadHolidayCalendar(db, { fromDate: '2026-09-01', toDate: '2026-09-07' });
  assert.equal(result.source, 'weekend_only_fallback',
    'an empty calendar table must still be reported as unverified');
  assert.equal(result.reason, 'idx_holiday_calendar_empty');
  assert.equal(result.holidaySet.size, 0);
  assert.ok(db.applied.limit, 'the fetch must carry an explicit row cap');
});

test('an empty UNfiltered result still reports the weekend-only fallback', async () => {
  // With no window, empty really does mean the table has no holiday rows.
  const db = fakeSupabase([]);
  const result = await loadHolidayCalendar(db, {});
  assert.equal(result.source, 'weekend_only_fallback');
  assert.equal(result.reason, 'idx_holiday_calendar_empty');
});

test('a populated calendar with no holiday in the window still reads as db-backed', async () => {
  const db = fakeSupabase([HOLIDAY]); // December holiday, September window
  const result = await loadHolidayCalendar(db, { fromDate: '2026-09-01', toDate: '2026-09-07' });
  assert.equal(result.source, 'db',
    'a seeded calendar was reported as a weekend-only fallback because the window was quiet');
  assert.equal(result.reason, 'no_holidays_in_window');
  assert.equal(result.rows.length, 0, 'the caller window still shapes rows');
  assert.equal(result.holidaySet.has('2026-12-25'), true,
    'holidaySet must cover every known holiday, not only the window');
});

test('rows inside a window are reported as db-backed', async () => {
  const db = fakeSupabase([HOLIDAY]);
  const result = await loadHolidayCalendar(db, { fromDate: '2026-12-01', toDate: '2026-12-31' });
  assert.equal(result.source, 'db');
  assert.equal(result.holidaySet.has('2026-12-25'), true);
});

test('a query error is still a fallback, never silently db', async () => {
  const db = fakeSupabase(null, { error: 'connection refused' });
  const result = await loadHolidayCalendar(db, { fromDate: '2026-09-01', toDate: '2026-09-07' });
  assert.equal(result.source, 'weekend_only_fallback');
  assert.equal(result.reason, 'connection refused');
  assert.equal(result.holidaySet.size, 0);
});

test('a missing client is still a fallback', async () => {
  const result = await loadHolidayCalendar(null, {});
  assert.equal(result.source, 'weekend_only_fallback');
  assert.equal(result.reason, 'no_supabase_client');
});

test('marketDayGuard reports db on an ordinary week with a populated calendar', async () => {
  // Wednesday 2026-09-02. The calendar IS seeded, but its only holiday is in
  // December, far outside marketDayGuard's +/-3 day window - the ordinary case
  // that used to be misreported as a weekend-only fallback.
  const db = fakeSupabase([HOLIDAY]);
  const guard = await marketDayGuard(db, { now: new Date('2026-09-02T04:00:00Z') });
  assert.equal(guard.shouldRun, true);
  assert.equal(guard.tradeDate, '2026-09-02');
  assert.equal(guard.calendarSource, 'db',
    'the operator log would claim the seeded calendar is not in use');
});

test('marketDayGuard still refuses to run on a weekend', async () => {
  const db = fakeSupabase([]);
  const guard = await marketDayGuard(db, { now: new Date('2026-09-05T04:00:00Z') }); // Saturday
  assert.equal(guard.shouldRun, false);
  assert.equal(guard.reason, 'MARKET_CLOSED');
});

test('marketDayGuard still refuses to run on a seeded holiday', async () => {
  const db = fakeSupabase([{ trade_date: '2026-09-02', status: 'HOLIDAY', name: 'Uji' }]);
  const guard = await marketDayGuard(db, { now: new Date('2026-09-02T04:00:00Z') });
  assert.equal(guard.shouldRun, false);
  assert.equal(guard.reason, 'MARKET_CLOSED');
  assert.equal(guard.calendarSource, 'db');
});

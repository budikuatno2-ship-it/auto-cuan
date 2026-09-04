/**
 * IDX Trading Calendar — Asia/Jakarta exchange trading-day helpers.
 *
 * Two responsibilities (per project spec):
 *   A. Let scheduled jobs skip non-trading days cheaply, before expensive work.
 *   B. Resolve previous/latest N trading sessions for historical features
 *      (daily history, RSI, 7-session volume/foreign context).
 *
 * Weekend (Sat/Sun) detection is always correct and needs no data. Exchange
 * HOLIDAY overrides come from the `idx_trading_calendar` table (see
 * supabase/stock-daily-context-migration.sql), which ships EMPTY until the
 * official IDX/KSEI holiday announcement is manually entered — this module
 * never fabricates holiday dates. Until holiday rows exist, behavior is a
 * weekend-only guard, which the existing codebase already relies on in
 * several places (lib/chart-t1-policy.js, api/sector-hot.js, etc.) — this
 * module is a suitable single place those could migrate to later, but it does
 * not modify them.
 *
 * All pure calendar math (isTradingDay/previousTradingDay/nextTradingDay/
 * getLastTradingDays) takes an explicit holiday Set so callers can load the
 * calendar ONCE per batch run and reuse it, instead of querying per ticker.
 */

'use strict';

// Explicit cap on one calendar fetch. An exchange holiday table holds roughly
// 15-20 rows per year, so this covers a century while never relying on a
// server-side default row limit.
var CALENDAR_ROW_CAP = 2000;

function toDateKey(input) {
  if (input == null) throw new Error('date is required');
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new Error('invalid date input');
    return jakartaDateKeyFromInstant(input);
  }
  var raw = String(input).trim();
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (m) return m[1];
  var parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error('invalid date input: ' + input);
  return jakartaDateKeyFromInstant(parsed);
}

function jakartaDateKeyFromInstant(dateObj) {
  var fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(dateObj); // en-CA => "YYYY-MM-DD"
}

function dayOfWeek(dateKey) {
  // dateKey is a plain calendar date string; parsing as UTC midnight is safe
  // because it carries no time-of-day/timezone ambiguity at this point.
  return new Date(dateKey + 'T00:00:00Z').getUTCDay(); // 0=Sun .. 6=Sat
}

function isWeekend(dateKey) {
  var d = dayOfWeek(dateKey);
  return d === 0 || d === 6;
}

function addDaysToKey(dateKey, delta) {
  var d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function toHolidaySet(holidaySet) {
  if (holidaySet instanceof Set) return holidaySet;
  return new Set(Array.isArray(holidaySet) ? holidaySet : []);
}

function isTradingDay(dateInput, holidaySet) {
  var dateKey = toDateKey(dateInput);
  if (isWeekend(dateKey)) return false;
  if (toHolidaySet(holidaySet).has(dateKey)) return false;
  return true;
}

function previousTradingDay(dateInput, holidaySet, options) {
  options = options || {};
  var maxLookback = options.maxLookback || 30;
  var cursor = toDateKey(dateInput);
  for (var i = 0; i < maxLookback; i++) {
    cursor = addDaysToKey(cursor, -1);
    if (isTradingDay(cursor, holidaySet)) return cursor;
  }
  return null;
}

function nextTradingDay(dateInput, holidaySet, options) {
  options = options || {};
  var maxLookahead = options.maxLookahead || 30;
  var cursor = toDateKey(dateInput);
  for (var i = 0; i < maxLookahead; i++) {
    cursor = addDaysToKey(cursor, 1);
    if (isTradingDay(cursor, holidaySet)) return cursor;
  }
  return null;
}

/**
 * Return up to `count` trading-session date keys, most recent first.
 * By default includes `dateInput` itself if it is a trading day.
 */
function getLastTradingDays(dateInput, count, holidaySet, options) {
  options = options || {};
  var includeGiven = options.includeGiven !== false;
  var dateKey = toDateKey(dateInput);
  var results = [];
  if (includeGiven && isTradingDay(dateKey, holidaySet)) {
    results.push(dateKey);
  }
  var cursor = dateKey;
  var guard = 0;
  var maxGuard = Math.max(count * 15, 90);
  while (results.length < count && guard < maxGuard) {
    guard++;
    cursor = addDaysToKey(cursor, -1);
    if (isTradingDay(cursor, holidaySet)) results.push(cursor);
  }
  return results;
}

/**
 * Filter+sort already-loaded holiday rows to the upcoming ones.
 * rows: [{ trade_date, name, source, ... }]
 */
function getUpcomingMarketHolidays(rows, fromDateInput, options) {
  options = options || {};
  var limit = options.limit || 20;
  var fromKey = fromDateInput ? toDateKey(fromDateInput) : toDateKey(new Date());
  return (Array.isArray(rows) ? rows : [])
    .filter(function(row) { return row && row.trade_date && String(row.trade_date) >= fromKey; })
    .sort(function(a, b) { return String(a.trade_date).localeCompare(String(b.trade_date)); })
    .slice(0, limit);
}

// ------------------------------------------------------------
// DB-backed loader — call ONCE per batch job, not per ticker.
// ------------------------------------------------------------

/**
 * Load the holiday calendar from idx_trading_calendar into a Set + raw rows.
 * Returns { holidaySet, rows, source } where source is 'db' or
 * 'weekend_only_fallback' if the table is empty/unreachable — mirroring the
 * existing project convention (see lib/chart-t1-policy.js) of never silently
 * pretending an unverified calendar is authoritative.
 */
async function loadHolidayCalendar(supabase, options) {
  options = options || {};
  if (!supabase) {
    return { holidaySet: new Set(), rows: [], source: 'weekend_only_fallback', reason: 'no_supabase_client' };
  }

  try {
    // Deliberately NOT date-filtered in SQL. A windowed query cannot answer the
    // question `source` exists to answer: an empty result inside a narrow
    // window means "no holiday soon", not "calendar unavailable", and the two
    // are indistinguishable once the filter is applied. marketDayGuard asks for
    // +/-3 days, so on every ordinary week the old windowed query reported a
    // weekend-only fallback and told the operator their seeded calendar was not
    // in use. An exchange holiday table is a handful of rows per year, so
    // loading it whole is cheaper than a second existence probe; the cap is
    // explicit rather than left to a server-side default (see the response-cap
    // discipline in lib/stock-daily-history-store.js).
    var result = await supabase
      .from('idx_trading_calendar')
      .select('trade_date,status,name,source,verified_at,override_reason')
      .eq('status', 'HOLIDAY')
      .order('trade_date', { ascending: true })
      .limit(CALENDAR_ROW_CAP);

    if (result.error) {
      return { holidaySet: new Set(), rows: [], source: 'weekend_only_fallback', reason: result.error.message };
    }

    var allRows = result.data || [];
    // holidaySet covers every known holiday, so isTradingDay/getLastTradingDays
    // stay correct for any date a caller asks about, not only dates that
    // happened to fall inside a requested window.
    var holidaySet = new Set(allRows.map(function(row) { return String(row.trade_date).slice(0, 10); }));

    // The caller's window still shapes `rows` (what getUpcomingMarketHolidays
    // reads), it just no longer decides whether the calendar is trustworthy.
    var fromKey = options.fromDate ? toDateKey(options.fromDate) : null;
    var toKey = options.toDate ? toDateKey(options.toDate) : null;
    var rows = allRows.filter(function(row) {
      var key = String(row.trade_date).slice(0, 10);
      if (fromKey && key < fromKey) return false;
      if (toKey && key > toKey) return false;
      return true;
    });

    return {
      holidaySet: holidaySet,
      rows: rows,
      source: allRows.length ? 'db' : 'weekend_only_fallback',
      reason: allRows.length ? (rows.length ? null : 'no_holidays_in_window') : 'idx_holiday_calendar_empty'
    };
  } catch (e) {
    return { holidaySet: new Set(), rows: [], source: 'weekend_only_fallback', reason: e && e.message };
  }
}

/**
 * Cheap early-exit guard for cron-triggered jobs, per project spec section 12:
 *   cron -> wrapper -> resolve Jakarta date -> isTradingDay -> exit if false.
 * This function is provided for future integration; it does NOT modify any
 * existing cron job or wrapper script.
 */
async function marketDayGuard(supabase, options) {
  options = options || {};
  var now = options.now || new Date();
  var todayKey = toDateKey(now);
  var calendar = await loadHolidayCalendar(supabase, { fromDate: addDaysToKey(todayKey, -3), toDate: addDaysToKey(todayKey, 3) });
  var tradingDay = isTradingDay(todayKey, calendar.holidaySet);
  return {
    shouldRun: tradingDay,
    tradeDate: todayKey,
    reason: tradingDay ? 'trading_day' : 'MARKET_CLOSED',
    calendarSource: calendar.source
  };
}

module.exports = {
  toDateKey,
  isWeekend,
  isTradingDay,
  previousTradingDay,
  nextTradingDay,
  getLastTradingDays,
  getUpcomingMarketHolidays,
  loadHolidayCalendar,
  marketDayGuard,
  addDaysToKey
};

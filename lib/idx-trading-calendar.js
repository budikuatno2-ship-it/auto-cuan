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
    var query = supabase
      .from('idx_trading_calendar')
      .select('trade_date,status,name,source,verified_at,override_reason')
      .eq('status', 'HOLIDAY')
      .order('trade_date', { ascending: true });

    if (options.fromDate) query = query.gte('trade_date', toDateKey(options.fromDate));
    if (options.toDate) query = query.lte('trade_date', toDateKey(options.toDate));

    var result = await query;
    if (result.error) {
      return { holidaySet: new Set(), rows: [], source: 'weekend_only_fallback', reason: result.error.message };
    }

    var rows = result.data || [];
    var holidaySet = new Set(rows.map(function(row) { return String(row.trade_date).slice(0, 10); }));
    return {
      holidaySet: holidaySet,
      rows: rows,
      source: rows.length ? 'db' : 'weekend_only_fallback',
      reason: rows.length ? null : 'idx_holiday_calendar_empty'
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

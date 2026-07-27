'use strict';

var POLICY = 'completed_daily_candles_before_jakarta_today';
var JAKARTA_TIME_ZONE = 'Asia/Jakarta';

function formatJakartaDate(value) {
  var date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JAKARTA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  var out = {};
  parts.forEach(function(part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year && out.month && out.day ? out.year + '-' + out.month + '-' + out.day : null;
}

function normalizeUnixTimestampSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// This is deliberately weekday-only. The repository has no authoritative IDX
// public-holiday calendar, so callers must never interpret it as verification.
function previousWeekday(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) return null;
  var date = new Date(dateString + 'T00:00:00.000Z');
  if (isNaN(date.getTime())) return null;
  do { date.setUTCDate(date.getUTCDate() - 1); } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

function buildMetadata(actualDataDate, now) {
  var jakartaToday = formatJakartaDate(now || new Date());
  var expected = jakartaToday ? previousWeekday(jakartaToday) : null;
  var status = 'missing';
  var reason = 'no_completed_candle_before_jakarta_today';

  if (actualDataDate && expected) {
    if (actualDataDate < expected) {
      status = 'stale';
      reason = 'actual_data_predates_previous_weekday_candidate';
    } else {
      status = 'calendar_unverified';
      reason = 'idx_holiday_calendar_unavailable';
    }
  }

  return {
    data_policy: POLICY,
    jakarta_today: jakartaToday,
    expected_t1_date: expected,
    actual_data_date: actualDataDate || null,
    t1_status: status,
    t1_verified: false,
    t1_reason: reason
  };
}

function retainCompletedCandles(candles, now) {
  var jakartaToday = formatJakartaDate(now || new Date());
  var retained = (candles || []).filter(function(candle) {
    return candle && /^\d{4}-\d{2}-\d{2}$/.test(String(candle.time || '')) && jakartaToday && candle.time < jakartaToday;
  });
  var actual = retained.length ? retained[retained.length - 1].time : null;
  return { candles: retained, metadata: buildMetadata(actual, now) };
}

module.exports = {
  POLICY: POLICY,
  JAKARTA_TIME_ZONE: JAKARTA_TIME_ZONE,
  formatJakartaDate: formatJakartaDate,
  normalizeUnixTimestampSeconds: normalizeUnixTimestampSeconds,
  previousWeekday: previousWeekday,
  buildMetadata: buildMetadata,
  retainCompletedCandles: retainCompletedCandles
};

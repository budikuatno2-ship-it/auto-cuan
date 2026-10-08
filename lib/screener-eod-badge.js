'use strict';

/**
 * resolveScreenerEodBadge
 *
 * Deterministically resolves EOD screener freshness badge based on:
 * - Authoritative recorded trading date (trading_date || run_date || calculated_at)
 * - Authoritative completion markers (FINAL_EOD, is_eod_final, eod_complete)
 * - Reference time in WIB (Asia/Jakarta)
 * - Market holiday markers without guessing
 *
 * Scenarios handled:
 * (a) Weekdays before close (e.g. Wed 11:00 WIB with prior session or partial intraday)
 * (b) Weekdays after close (e.g. Wed 17:00 WIB with FINAL_EOD marker)
 * (c) Saturday / Sunday (Weekend viewing Friday close -> EOD · T-1, not stale)
 * (d) Market holiday (Holiday viewing prior trading session -> EOD · T-1)
 * (e) Missing finalization marker (Today's data without FINAL_EOD -> never falsely claims EOD · TODAY)
 * (f) Stale historical snapshot (Older date outside trading window -> STALE)
 */
function resolveScreenerEodBadge(meta, referenceNowWib, isPreview) {
  if (!meta) {
    return {
      badgeCode: 'PENDING',
      label: isPreview ? 'MOCK DATA' : 'PENDING',
      className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-gray-500/10 text-gray-400 border border-gray-500/25',
      status: 'pending',
      dateStr: null,
      reason: 'no_metadata'
    };
  }

  if (meta.status === 'scanning' || meta.status === 'finalizing') {
    return {
      badgeCode: 'SCANNING',
      label: 'SCANNING',
      className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-yellow-500/10 text-yellow-400 border border-yellow-500/25 animate-pulse-glow',
      status: 'scanning',
      dateStr: null,
      reason: 'scanning'
    };
  }

  if (meta.status === 'failed') {
    return {
      badgeCode: 'ERROR',
      label: 'ERROR',
      className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/25',
      status: 'failed',
      dateStr: null,
      reason: 'failed'
    };
  }

  // 1. Authoritative recorded trading date
  var rawDate = meta.trading_date || meta.run_date || meta.calculated_at || meta.last_updated_at;
  if (!rawDate) {
    return {
      badgeCode: 'PENDING',
      label: isPreview ? 'MOCK DATA' : 'PENDING',
      className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-gray-500/10 text-gray-400 border border-gray-500/25',
      status: 'unknown_session',
      dateStr: null,
      reason: 'no_recorded_date'
    };
  }

  var recDateStr = (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate))
    ? rawDate.slice(0, 10)
    : (new Date(new Date(rawDate).getTime() + 7 * 60 * 60 * 1000)).toISOString().slice(0, 10);

  // 2. Authoritative finalization markers
  var isFinalEod = meta.session_status === 'FINAL_EOD' || Boolean(meta.is_eod_final) || Boolean(meta.eod_complete);
  var isIntradayPartial = meta.session_status === 'INTRADAY_PARTIAL' || Boolean(meta.is_intraday);
  var isHoliday = Boolean(meta.is_holiday || meta.market_holiday || meta.session_status === 'HOLIDAY_CLOSED');
  var isExplicitStale = Boolean(meta.data_stale || meta.is_stale || meta.freshness_is_stale);

  // 3. Reference time in WIB
  var nowWib = referenceNowWib instanceof Date
    ? referenceNowWib
    : (typeof referenceNowWib === 'string' ? new Date(referenceNowWib) : new Date(Date.now() + 7 * 60 * 60 * 1000));
  var todayStr = nowWib.toISOString().slice(0, 10);
  var dayOfWeek = nowWib.getUTCDay(); // 0: Sun, 1: Mon, ..., 6: Sat

  var daysBackToPrevWeekday = (dayOfWeek === 0) ? 2 : (dayOfWeek === 1 ? 3 : (dayOfWeek === 6 ? 1 : 1));
  var prevWeekday = new Date(nowWib.getTime() - daysBackToPrevWeekday * 86400000);
  var prevWeekdayStr = prevWeekday.toISOString().slice(0, 10);
  var yesterday = new Date(nowWib.getTime() - 86400000);
  var yesterdayStr = yesterday.toISOString().slice(0, 10);

  // 4. Stale check
  if (isExplicitStale) {
    return {
      badgeCode: 'STALE',
      label: isPreview ? 'MOCK DATA' : 'STALE',
      className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/25',
      status: 'stale',
      dateStr: recDateStr,
      reason: 'explicit_stale'
    };
  }

  // 5. Evaluate relative date
  if (recDateStr === todayStr) {
    if (isFinalEod) {
      // Case (b): Weekdays after close with authoritative completion marker
      return {
        badgeCode: 'TODAY',
        label: isPreview ? 'MOCK DATA' : 'EOD · TODAY',
        className: isPreview
          ? 'px-2 py-1 rounded-md text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/25'
          : 'px-2 py-1 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25',
        status: 'final_eod_today',
        dateStr: recDateStr,
        reason: 'today_eod_final'
      };
    } else if (isIntradayPartial) {
      // Case (a): Weekdays before close with intraday partial data
      return {
        badgeCode: 'INTRADAY',
        label: isPreview ? 'MOCK DATA' : 'INTRADAY',
        className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25',
        status: 'intraday_partial',
        dateStr: recDateStr,
        reason: 'today_intraday_partial'
      };
    } else {
      // Case (e): Today's data but missing finalization marker (not marked FINAL_EOD)
      return {
        badgeCode: 'PENDING',
        label: isPreview ? 'MOCK DATA' : 'EOD · PENDING',
        className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-gray-500/10 text-gray-400 border border-gray-500/25',
        status: 'unfinalized',
        dateStr: recDateStr,
        reason: 'today_unfinalized_missing_marker'
      };
    }
  }

  // Is recorded date matching the previous valid trading session?
  var isPrevTradingMatch = (recDateStr === prevWeekdayStr) || (recDateStr === yesterdayStr);
  if (meta.holiday_prior_trading_date && recDateStr === meta.holiday_prior_trading_date) {
    isPrevTradingMatch = true;
  }

  if (isPrevTradingMatch) {
    // Case (a) previous trading session when viewing today before close,
    // Case (c) Saturday/Sunday viewing Friday close,
    // Case (d) Market holiday viewing prior trading session.
    return {
      badgeCode: 'T1',
      label: isPreview ? 'MOCK DATA' : 'EOD · T-1',
      className: isPreview
        ? 'px-2 py-1 rounded-md text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/25'
        : 'px-2 py-1 rounded-md text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/25',
      status: 'eod_t1',
      dateStr: recDateStr,
      reason: isHoliday ? 'holiday_prior_session' : ((dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend_prior_session' : 'weekday_t1_session')
    };
  }

  // Market holiday handling: if today is a holiday and recorded session date is known:
  if (isHoliday && meta.trading_date) {
    var ageDays = Math.round((new Date(todayStr).getTime() - new Date(recDateStr).getTime()) / 86400000);
    if (ageDays >= 1 && ageDays <= 7) {
      return {
        badgeCode: 'T1',
        label: isPreview ? 'MOCK DATA' : 'EOD · T-1',
        className: isPreview
          ? 'px-2 py-1 rounded-md text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/25'
          : 'px-2 py-1 rounded-md text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/25',
        status: 'eod_t1_holiday',
        dateStr: recDateStr,
        reason: 'market_holiday_prior_session'
      };
    }
  }

  // If session is older than expected:
  var diffDays = Math.round((new Date(todayStr).getTime() - new Date(recDateStr).getTime()) / 86400000);
  if (diffDays > 3) {
    // Case (f): Stale historical snapshot
    return {
      badgeCode: 'STALE',
      label: isPreview ? 'MOCK DATA' : 'STALE',
      className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/25',
      status: 'stale',
      dateStr: recDateStr,
      reason: 'historical_stale'
    };
  }

  return {
    badgeCode: 'UNCERTAIN',
    label: isPreview ? 'MOCK DATA' : ('EOD · ' + recDateStr),
    className: 'px-2 py-1 rounded-md text-[10px] font-semibold bg-gray-500/10 text-gray-400 border border-gray-500/25',
    status: 'uncertain_session',
    dateStr: recDateStr,
    reason: 'uncertain_session_date'
  };
}

module.exports = {
  resolveScreenerEodBadge
};

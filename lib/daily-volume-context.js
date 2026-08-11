/**
 * Daily volume context — descriptive stats over the last 7 TRADING SESSIONS.
 *
 * Input `rows` MUST already be trading-session rows for one ticker, newest
 * first (as returned by stock-daily-history-store.getLatestSessionsForTicker),
 * i.e. calendar weekends/holidays must already be excluded upstream by the
 * trading calendar — this module does no date-skipping itself.
 *
 * rows[0] is treated as "today". If the current session is still open and
 * only partially observed, the caller should mark that row's
 * data_quality_status as 'partial' (set by the collector) so callers can
 * label the semantic difference instead of silently comparing a partial
 * session's volume to a prior FULL session's volume.
 */

'use strict';

function median(values) {
  if (!values.length) return null;
  var sorted = values.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function safeRatio(numerator, denominator) {
  if (numerator == null || denominator == null || !Number.isFinite(denominator) || denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function pctChange(current, previous) {
  if (current == null || previous == null || !Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

function classifyPriceVolume(priceChangePct, volumeChangePct) {
  if (priceChangePct == null || volumeChangePct == null) return 'FLAT_OR_UNCLEAR';
  var priceUp = priceChangePct > 0;
  var priceDown = priceChangePct < 0;
  var volumeUp = volumeChangePct > 0;
  var volumeDown = volumeChangePct < 0;
  if (priceUp && volumeUp) return 'PRICE_UP_VOLUME_UP';
  if (priceUp && volumeDown) return 'PRICE_UP_VOLUME_DOWN';
  if (priceDown && volumeUp) return 'PRICE_DOWN_VOLUME_UP';
  if (priceDown && volumeDown) return 'PRICE_DOWN_VOLUME_DOWN';
  return 'FLAT_OR_UNCLEAR';
}

/**
 * Build the volume context object. `rows` newest-first, up to 7 rows expected
 * (fewer is handled gracefully — averages/ratios become null when there's
 * not enough history, never fabricated as zero).
 */
function buildVolumeContext(rows) {
  rows = Array.isArray(rows) ? rows : [];
  var today = rows[0] || null;
  var previous = rows[1] || null;

  var volumeToday = today ? numOrNull(today.volume) : null;
  var volumePrevious = previous ? numOrNull(previous.volume) : null;

  // 7-session average/median exclude the current (possibly partial) session
  // when it's flagged partial, so a partial day never drags down the stat it
  // is being compared against.
  var isTodayPartial = today && today.data_quality_status === 'partial';
  var windowRows = isTodayPartial ? rows.slice(1, 8) : rows.slice(0, 7);
  var windowVolumes = windowRows.map(function(r) { return numOrNull(r.volume); }).filter(function(v) { return v != null; });

  var volumeAvg7d = windowVolumes.length ? Math.round(windowVolumes.reduce(function(a, b) { return a + b; }, 0) / windowVolumes.length) : null;
  var volumeMedian7d = windowVolumes.length ? median(windowVolumes) : null;

  var priceToday = today ? numOrNull(today.close) : null;
  var pricePrevious = previous ? numOrNull(previous.close) : null;
  var priceChangePct = pctChange(priceToday, pricePrevious);
  var volumeChangePct = pctChange(volumeToday, volumePrevious);

  return {
    volume_today: volumeToday,
    volume_previous_session: volumePrevious,
    volume_change_1d_pct: volumeChangePct,
    volume_avg_7d: volumeAvg7d,
    volume_median_7d: volumeMedian7d,
    volume_ratio_vs_previous: safeRatio(volumeToday, volumePrevious),
    volume_ratio_vs_7d_avg: safeRatio(volumeToday, volumeAvg7d),
    price_change_1d_pct: priceChangePct,
    price_volume_classification: classifyPriceVolume(priceChangePct, volumeChangePct),
    is_today_partial_session: !!isTodayPartial,
    volume_history_7d: rows.slice(0, 7).map(function(r) {
      return {
        trade_date: r.trade_date,
        volume: numOrNull(r.volume),
        close: numOrNull(r.close),
        is_partial_session: r.data_quality_status === 'partial'
      };
    }).reverse() // oldest-first for chart display
  };
}

function numOrNull(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  buildVolumeContext,
  classifyPriceVolume
};

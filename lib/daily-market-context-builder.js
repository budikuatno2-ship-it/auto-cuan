/**
 * Daily Market Context Builder — orchestrates price/RSI/volume/foreign/PBV
 * into the API/UI response shape, and into the stock_daily_features cache
 * rows the collector job persists.
 *
 * Batch-first (project spec section 13/14): buildFeatureSnapshotsForTickers
 * does ONE query per data source (history, foreign, fundamentals) for the
 * whole ticker batch, then computes everything in memory — never a
 * per-ticker DB round trip in a loop.
 */

'use strict';

const historyStore = require('./stock-daily-history-store');
const foreignStore = require('./foreign-flow-store');
const rsi = require('./daily-rsi');
const volumeContext = require('./daily-volume-context');
const foreignContext = require('./daily-foreign-context');
const pbv = require('./daily-pbv');
const calendar = require('./idx-trading-calendar');
const {
  DISPLAY_TRADING_SESSIONS,
  HISTORY_RETENTION_TRADING_SESSIONS,
  PRICE_FRESHNESS_MAX_AGE_HOURS
} = require('./daily-market-context-constants');

function priceFreshness(asOfTradeDate, now) {
  if (!asOfTradeDate) return 'unknown';
  now = now || new Date();
  var asOf = new Date(asOfTradeDate + 'T16:00:00+07:00'); // approx IDX close, Jakarta time
  if (Number.isNaN(asOf.getTime())) return 'unknown';
  var ageHours = (now.getTime() - asOf.getTime()) / 3600000;
  if (ageHours < 0) return 'current';
  return ageHours <= PRICE_FRESHNESS_MAX_AGE_HOURS ? 'current' : 'stale';
}

/**
 * Build the full context object for one ticker from already-fetched rows.
 * historyRows/foreignRows newest-first; fundamentalsRow may be undefined.
 */
function buildContextFromRows(ticker, historyRows, foreignRows, fundamentalsRow, options) {
  options = options || {};
  var now = options.now || new Date();

  historyRows = Array.isArray(historyRows) ? historyRows : [];
  foreignRows = Array.isArray(foreignRows) ? foreignRows : [];

  var latest = historyRows[0] || null;
  var lastPrice = latest ? Number(latest.close) : null;
  var lastPriceAsOf = latest ? latest.trade_date : null;

  // RSI needs oldest-first closes.
  var closesOldestFirst = historyRows.slice().reverse().map(function(r) { return Number(r.close); });
  var datesOldestFirst = historyRows.slice().reverse().map(function(r) { return r.trade_date; });
  var rsiResult = rsi.computeLatestRsi(closesOldestFirst, datesOldestFirst, { period: options.rsiPeriod });

  var volume = volumeContext.buildVolumeContext(historyRows.slice(0, DISPLAY_TRADING_SESSIONS));
  var foreign = foreignContext.buildForeignContext(foreignRows.slice(0, DISPLAY_TRADING_SESSIONS));
  var pbvResult = pbv.buildPbvContext(lastPrice, fundamentalsRow);

  return {
    ticker: String(ticker).toUpperCase(),
    as_of: lastPriceAsOf,
    generated_at: now.toISOString(),

    price: {
      last: lastPrice,
      last_price_as_of: lastPriceAsOf,
      last_price_source: latest ? (latest.data_source || 'stock_daily_history') : null,
      previous_close: latest ? numOrNull(latest.previous_close) : null,
      change_pct: volume.price_change_1d_pct,
      freshness: priceFreshness(lastPriceAsOf, now)
    },

    technical: {
      rsi_14: rsiResult.rsi_14,
      rsi_state: rsiResult.rsi_state,
      rsi_insufficient_history: rsiResult.insufficient_history,
      rsi_history_length: rsiResult.history_length
    },

    fundamental: {
      pbv: pbvResult.pbv,
      pbv_as_of_price: pbvResult.pbv_as_of_price,
      book_value_per_share: pbvResult.book_value_per_share,
      fundamental_period: pbvResult.fundamental_period,
      fundamental_source: pbvResult.fundamental_source,
      fundamental_updated_at: pbvResult.fundamental_updated_at,
      data_available: pbvResult.data_available
    },

    volume: volume,

    foreign: foreign,

    price_volume_classification: volume.price_volume_classification,

    data_quality: {
      history_sessions_available: historyRows.length,
      history_retention_target: HISTORY_RETENTION_TRADING_SESSIONS,
      price_freshness: priceFreshness(lastPriceAsOf, now),
      foreign_data_quality: foreign.foreign_net_7d_data_quality,
      fundamental_data_available: pbvResult.data_available
    }
  };
}

function numOrNull(v) {
  if (v == null) return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Single-ticker on-demand build — used as an API fallback when the
 * stock_daily_features cache is missing/stale for that ticker. Still just
 * 3 queries total (history, foreign, fundamentals), not N+1. */
async function buildContextForTicker(supabase, ticker, options) {
  options = options || {};
  var historySessions = options.historySessions || HISTORY_RETENTION_TRADING_SESSIONS;
  var now = options.now || new Date();

  var [historyMap, foreignMap, fundamentalsMap, calendarResult] = await Promise.all([
    historyStore.getLatestSessionsForTickers(supabase, [ticker], Math.max(historySessions, rsi.RSI_PERIOD + 1)),
    foreignStore.getLatestForeignForTickers(supabase, [ticker], DISPLAY_TRADING_SESSIONS),
    historyStore.getFundamentalsForTickers(supabase, [ticker]),
    calendar.loadHolidayCalendar(supabase, { fromDate: now, toDate: calendar.addDaysToKey(calendar.toDateKey(now), 90) })
  ]);

  var upperTicker = String(ticker).toUpperCase();
  var context = buildContextFromRows(
    ticker,
    historyMap.get(upperTicker) || [],
    foreignMap.get(upperTicker) || [],
    fundamentalsMap.get(upperTicker),
    options
  );
  context.calendar = buildCalendarContext(calendarResult, now);
  return context;
}

/**
 * Market-wide (not per-ticker) calendar context: is the market open today,
 * and what's the next known upcoming exchange holiday. `calendarResult`
 * comes from idx-trading-calendar.loadHolidayCalendar — its `source` field
 * (`'db'` vs `'weekend_only_fallback'`) is passed through so callers can see
 * whether this reflects a real seeded calendar or just the weekend guard.
 */
function buildCalendarContext(calendarResult, now) {
  now = now || new Date();
  var todayKey = calendar.toDateKey(now);
  var marketOpenToday = calendar.isTradingDay(todayKey, calendarResult.holidaySet);
  var upcoming = calendar.getUpcomingMarketHolidays(calendarResult.rows, todayKey, { limit: 1 });
  var next = upcoming[0] || null;

  return {
    as_of: todayKey,
    market_open_today: marketOpenToday,
    next_holiday: next ? { trade_date: next.trade_date, name: next.name } : null,
    calendar_source: calendarResult.source
  };
}

/**
 * Batch build feature snapshot rows for stock_daily_features, for a whole
 * ticker universe in a bounded number of queries (3 total, regardless of
 * ticker count).
 */
async function buildFeatureSnapshotsForTickers(supabase, tickers, options) {
  options = options || {};
  var uniqueTickers = Array.from(new Set((tickers || []).map(function(t) { return String(t).toUpperCase(); })));
  if (!uniqueTickers.length) return [];

  var historySessions = options.historySessions || HISTORY_RETENTION_TRADING_SESSIONS;

  var [historyMap, foreignMap, fundamentalsMap] = await Promise.all([
    historyStore.getLatestSessionsForTickers(supabase, uniqueTickers, Math.max(historySessions, rsi.RSI_PERIOD + 1)),
    foreignStore.getLatestForeignForTickers(supabase, uniqueTickers, DISPLAY_TRADING_SESSIONS),
    historyStore.getFundamentalsForTickers(supabase, uniqueTickers)
  ]);

  return uniqueTickers.map(function(ticker) {
    var context = buildContextFromRows(
      ticker,
      historyMap.get(ticker) || [],
      foreignMap.get(ticker) || [],
      fundamentalsMap.get(ticker),
      options
    );
    return {
      ticker: ticker,
      as_of_trade_date: context.as_of,
      last_price: context.price.last,
      last_price_as_of: context.price.last_price_as_of,
      last_price_source: context.price.last_price_source,
      rsi_14: context.technical.rsi_14,
      rsi_state: context.technical.rsi_state,
      pbv: context.fundamental.pbv,
      pbv_as_of_price: context.fundamental.pbv_as_of_price,
      fundamental_period: context.fundamental.fundamental_period,
      fundamental_source: context.fundamental.fundamental_source,
      volume_today: context.volume.volume_today,
      volume_previous_session: context.volume.volume_previous_session,
      volume_avg_7d: context.volume.volume_avg_7d,
      volume_median_7d: context.volume.volume_median_7d,
      volume_ratio_vs_previous: context.volume.volume_ratio_vs_previous,
      volume_ratio_vs_7d_avg: context.volume.volume_ratio_vs_7d_avg,
      foreign_net_today: context.foreign.foreign_net_today,
      foreign_net_3d: context.foreign.foreign_net_3d,
      foreign_net_5d: context.foreign.foreign_net_5d,
      foreign_net_7d: context.foreign.foreign_net_7d,
      foreign_positive_days_7d: context.foreign.foreign_positive_days_7d,
      foreign_negative_days_7d: context.foreign.foreign_negative_days_7d,
      foreign_net_streak: context.foreign.foreign_net_streak,
      data_freshness: context.data_quality.price_freshness
    };
  });
}

module.exports = {
  buildContextFromRows,
  buildContextForTicker,
  buildFeatureSnapshotsForTickers,
  buildCalendarContext,
  priceFreshness
};

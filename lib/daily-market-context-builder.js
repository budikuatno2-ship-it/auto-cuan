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

  // 52-week high/low cannot be derived from historyRows here — persisted
  // stock_daily_history only retains HISTORY_RETENTION_TRADING_SESSIONS
  // (120 sessions, ~6 months), not a true 52-week window. The real values
  // come from the Yahoo 1-year fetch in lib/daily-history-collector.js and
  // are threaded through as `options.week52` (see buildFeatureSnapshotsForTickers
  // and buildContextForTicker) — never fabricated here from insufficient data.
  var week52 = options.week52 || null;
  var week52High = week52 ? numOrNull(week52.week52_high) : null;
  var week52Low = week52 ? numOrNull(week52.week52_low) : null;
  var week52HighDistPct = (week52High != null && lastPrice != null)
    ? Math.round(((lastPrice - week52High) / week52High) * 10000) / 100 : null;
  var week52LowDistPct = (week52Low != null && lastPrice != null)
    ? Math.round(((lastPrice - week52Low) / week52Low) * 10000) / 100 : null;

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
      rsi_history_length: rsiResult.history_length,
      week52_high: week52High,
      week52_high_date: week52 ? (week52.week52_high_date || null) : null,
      week52_low: week52Low,
      week52_low_date: week52 ? (week52.week52_low_date || null) : null,
      week52_high_dist_pct: week52HighDistPct,
      week52_low_dist_pct: week52LowDistPct
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

  var [historyMap, foreignMap, fundamentalsMap, calendarResult, featuresMap] = await Promise.all([
    historyStore.getLatestSessionsForTickers(supabase, [ticker], Math.max(historySessions, rsi.RSI_PERIOD + 1)),
    foreignStore.getLatestForeignForTickers(supabase, [ticker], DISPLAY_TRADING_SESSIONS),
    historyStore.getFundamentalsForTickers(supabase, [ticker]),
    calendar.loadHolidayCalendar(supabase, { fromDate: now, toDate: calendar.addDaysToKey(calendar.toDateKey(now), 90) }),
    // stock_daily_features carries the 52-week high/low derived at collection
    // time from a full 1-year Yahoo fetch (see daily-history-collector.js) —
    // the on-demand path here only has HISTORY_RETENTION_TRADING_SESSIONS
    // (120 sessions) of persisted history, not enough for a true 52W metric,
    // so it reads the precomputed snapshot instead of fabricating one.
    historyStore.getDailyFeaturesForTickers(supabase, [ticker])
  ]);

  var upperTicker = String(ticker).toUpperCase();
  var featureRow = featuresMap.get(upperTicker) || null;
  var week52 = featureRow ? {
    week52_high: featureRow.week52_high,
    week52_high_date: featureRow.week52_high_date,
    week52_low: featureRow.week52_low,
    week52_low_date: featureRow.week52_low_date
  } : null;

  var context = buildContextFromRows(
    ticker,
    historyMap.get(upperTicker) || [],
    foreignMap.get(upperTicker) || [],
    fundamentalsMap.get(upperTicker),
    Object.assign({}, options, { week52: week52 })
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
  if (!uniqueTickers.length) return { rows: [], skippedTickers: [] };

  var historySessions = options.historySessions || HISTORY_RETENTION_TRADING_SESSIONS;
  // Per-ticker 52-week high/low derived from the collector's full 1-year
  // Yahoo fetch (lib/daily-history-collector.js#collectDailyHistoryForTickers
  // returns this as `week52`), keyed by uppercase ticker. Optional — when the
  // caller doesn't pass it (e.g. an older/unrelated caller), week52 fields
  // simply stay null rather than being guessed from the trimmed history.
  var week52ByTicker = options.week52ByTicker || {};

  var [historyMap, foreignMap, fundamentalsMap] = await Promise.all([
    historyStore.getLatestSessionsForTickers(supabase, uniqueTickers, Math.max(historySessions, rsi.RSI_PERIOD + 1)),
    foreignStore.getLatestForeignForTickers(supabase, uniqueTickers, DISPLAY_TRADING_SESSIONS),
    historyStore.getFundamentalsForTickers(supabase, uniqueTickers)
  ]);

  var rows = [];
  var skippedTickers = [];

  uniqueTickers.forEach(function(ticker) {
    var historyRows = historyMap.get(ticker) || [];
    // A ticker with no persisted daily history has no trade date to anchor
    // a snapshot on. stock_daily_features.as_of_trade_date is NOT NULL by
    // design (a feature row with a null as_of_trade_date is meaningless —
    // "features as of when?") — skip it entirely rather than writing a row
    // that would either violate the constraint or fabricate a date.
    if (!historyRows.length) {
      skippedTickers.push(ticker);
      return;
    }

    var context = buildContextFromRows(
      ticker,
      historyRows,
      foreignMap.get(ticker) || [],
      fundamentalsMap.get(ticker),
      Object.assign({}, options, { week52: week52ByTicker[ticker] || null })
    );

    // Belt-and-suspenders: even with history rows present, only persist if
    // a real as_of date was resolved.
    if (!context.as_of) {
      skippedTickers.push(ticker);
      return;
    }

    rows.push({
      ticker: ticker,
      as_of_trade_date: context.as_of,
      last_price: context.price.last,
      last_price_as_of: context.price.last_price_as_of,
      last_price_source: context.price.last_price_source,
      previous_close: context.price.previous_close,
      change_pct: context.price.change_pct,
      rsi_14: context.technical.rsi_14,
      rsi_state: context.technical.rsi_state,
      week52_high: context.technical.week52_high,
      week52_high_date: context.technical.week52_high_date,
      week52_low: context.technical.week52_low,
      week52_low_date: context.technical.week52_low_date,
      week52_high_dist_pct: context.technical.week52_high_dist_pct,
      week52_low_dist_pct: context.technical.week52_low_dist_pct,
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
    });
  });

  return { rows: rows, skippedTickers: skippedTickers };
}

/**
 * Map one raw stock_daily_features DB row into the shape the "Ranking
 * Harian" table UI consumes. This reads the already-precomputed snapshot
 * cache (rebuilt in batch by scripts/collect-daily-market-context.js) —
 * no recomputation, no extra per-ticker queries, so listing the whole
 * universe stays a single query regardless of how many tickers exist.
 * PBV is deliberately NOT included — this ranking view excludes it by
 * design. Any field the collector hasn't populated yet (e.g. week52_*
 * before this feature shipped, or a ticker with genuinely insufficient
 * history) comes through as null, which the UI renders as N/A rather than
 * a fabricated value.
 */
function buildRankingRowFromFeatureRow(row) {
  row = row || {};
  return {
    ticker: row.ticker,
    as_of_trade_date: row.as_of_trade_date || null,
    last_price: numOrNull(row.last_price),
    previous_close: numOrNull(row.previous_close),
    change_pct: numOrNull(row.change_pct),
    price_freshness: row.data_freshness || null,
    rsi_14: numOrNull(row.rsi_14),
    rsi_state: row.rsi_state || null,
    week52_high: numOrNull(row.week52_high),
    week52_high_date: row.week52_high_date || null,
    week52_low: numOrNull(row.week52_low),
    week52_low_date: row.week52_low_date || null,
    week52_high_dist_pct: numOrNull(row.week52_high_dist_pct),
    week52_low_dist_pct: numOrNull(row.week52_low_dist_pct),
    volume_today: numOrNull(row.volume_today),
    volume_ratio_vs_previous: numOrNull(row.volume_ratio_vs_previous),
    volume_ratio_vs_7d_avg: numOrNull(row.volume_ratio_vs_7d_avg),
    foreign_net_today: numOrNull(row.foreign_net_today),
    foreign_net_7d: numOrNull(row.foreign_net_7d),
    foreign_net_streak: row.foreign_net_streak != null ? Number(row.foreign_net_streak) : null,
    updated_at: row.updated_at || null
  };
}

/** Batch map — the whole ranking table's data source. */
function buildRankingList(featureRows) {
  return (Array.isArray(featureRows) ? featureRows : []).map(buildRankingRowFromFeatureRow);
}

module.exports = {
  buildContextFromRows,
  buildContextForTicker,
  buildFeatureSnapshotsForTickers,
  buildCalendarContext,
  buildRankingRowFromFeatureRow,
  buildRankingList,
  priceFreshness
};

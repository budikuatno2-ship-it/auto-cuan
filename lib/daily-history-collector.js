/**
 * Daily History Collector — batch ingest of daily OHLCV into
 * stock_daily_history from Yahoo Finance (same provider already used by
 * api/quote.js / api/candles.js / lib/daytrade-ohlcv-cache.js).
 *
 * Design goal (project spec section 13, performance): collect once per
 * ticker per run, upsert in batches, never do this work per-scan inside a
 * screener. This module is meant to be invoked by
 * scripts/collect-daily-market-context.js on a schedule the operator adds
 * to cron manually (this repo does not modify cron).
 *
 * Foreign flow is intentionally NOT populated here — it comes from the
 * existing foreign_watchlist_daily table (manual CSV upload) via
 * lib/foreign-flow-store.js, a different unit/provenance than Yahoo OHLCV.
 * Mixing them into one row here would blur two different data-quality
 * pictures, so stock_daily_history.foreign_* columns stay null for
 * Yahoo-sourced rows.
 */

'use strict';

const historyStore = require('./stock-daily-history-store');
const { HISTORY_RETENTION_TRADING_SESSIONS } = require('./daily-market-context-constants');
const { toDateKey } = require('./idx-trading-calendar');

const DEFAULT_TIMEOUT_MS = 12000;
const MIN_CANDLES_REQUIRED = 20;
// IDX regular session: 09:00-15:30 WIB (matches lib/daytrade-ohlcv-cache.js).
// EOD data typically settles shortly after close, so treat anything up to
// 16:00 WIB on the session date as still-partial to be conservative.
const SESSION_PARTIAL_CUTOFF_MINUTES = 16 * 60; // 16:00 WIB

/**
 * Decide whether `candleDate` (the last candle in a freshly fetched series)
 * represents a still-open/partial session as of `now`, using Asia/Jakarta
 * wall-clock time. Only the LATEST candle can ever be partial — every prior
 * session in the same fetch is, by definition, already closed.
 */
function isPartialSession(candleDate, now) {
  now = now || new Date();
  var todayJakarta = toDateKey(now);
  if (candleDate !== todayJakarta) return false;

  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var totalMin = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return totalMin < SESSION_PARTIAL_CUTOFF_MINUTES;
}

function safeTicker(ticker) {
  return String(ticker || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

/**
 * Fetch 1-year daily candles from Yahoo Finance for one ticker.
 * Returns an array of { date, open, high, low, close, volume } oldest-first,
 * or null on failure / insufficient data.
 */
async function fetchYahooDailyHistory(ticker, options) {
  options = options || {};
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  var symbol = safeTicker(ticker) + '.JK';
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=1y&interval=1d';

  var ac = new AbortController();
  var timer = setTimeout(function() { ac.abort(); }, timeoutMs);

  try {
    var response = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!response.ok) {
      var err = new Error('Yahoo HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }

    var data = await response.json();
    var result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;

    var timestamps = result.timestamp || [];
    var indicators = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!indicators) return null;

    var opens = indicators.open || [];
    var highs = indicators.high || [];
    var lows = indicators.low || [];
    var closes = indicators.close || [];
    var volumes = indicators.volume || [];

    var candles = [];
    for (var i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null && volumes[i] != null) {
        candles.push({
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: opens[i],
          high: highs[i],
          low: lows[i],
          close: closes[i],
          volume: volumes[i]
        });
      }
    }

    return candles.length >= MIN_CANDLES_REQUIRED ? candles : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert an oldest-first candle array into stock_daily_history rows,
 * trimmed to the retention window and with previous_close chained from the
 * prior candle in the SAME fetched series (a real prior trading session,
 * never a fabricated placeholder).
 */
function candlesToHistoryRows(ticker, candles, options) {
  options = options || {};
  var retention = options.retentionSessions || HISTORY_RETENTION_TRADING_SESSIONS;
  var now = options.now || new Date();
  var sourceTimestamp = options.sourceTimestamp || now.toISOString();
  var upperTicker = safeTicker(ticker);

  var trimmed = candles.slice(-retention);
  return trimmed.map(function(candle, index) {
    var priorCandle = index > 0 ? trimmed[index - 1] : null;
    var isLast = index === trimmed.length - 1;
    var partial = isLast && isPartialSession(candle.date, now);
    return {
      ticker: upperTicker,
      trade_date: candle.date,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      previous_close: priorCandle ? priorCandle.close : null,
      volume: candle.volume,
      value: null,
      frequency: null,
      foreign_buy_value: null,
      foreign_sell_value: null,
      foreign_net_value: null,
      foreign_buy_lot: null,
      foreign_sell_lot: null,
      foreign_net_lot: null,
      data_source: 'yahoo',
      source_timestamp: sourceTimestamp,
      data_quality_status: partial ? 'partial' : 'ok'
    };
  });
}

/**
 * Collect + upsert daily history for a batch of tickers.
 * Returns { collected, failed, skipped, errors }.
 */
async function collectDailyHistoryForTickers(supabase, tickers, options) {
  options = options || {};
  var fetchFn = options.fetchFn || fetchYahooDailyHistory;
  var uniqueTickers = Array.from(new Set((tickers || []).map(safeTicker))).filter(Boolean);

  var allRows = [];
  var failed = [];
  var skipped = [];

  for (var ticker of uniqueTickers) {
    try {
      var candles = await fetchFn(ticker, { timeoutMs: options.timeoutMs });
      if (!candles || candles.length < MIN_CANDLES_REQUIRED) {
        skipped.push({ ticker: ticker, reason: 'insufficient_candles' });
        continue;
      }
      var rows = candlesToHistoryRows(ticker, candles, options);
      allRows = allRows.concat(rows);
    } catch (e) {
      failed.push({ ticker: ticker, error: e && e.message });
    }
  }

  var upsertedCount = 0;
  if (allRows.length && supabase) {
    upsertedCount = await historyStore.upsertDailyHistory(supabase, allRows);
    await historyStore.enforceRetention(supabase, uniqueTickers, options.retentionSessions);
  }

  return {
    tickers_requested: uniqueTickers.length,
    rows_upserted: upsertedCount,
    tickers_collected: uniqueTickers.length - failed.length - skipped.length,
    failed: failed,
    skipped: skipped
  };
}

module.exports = {
  fetchYahooDailyHistory,
  candlesToHistoryRows,
  collectDailyHistoryForTickers,
  isPartialSession
};

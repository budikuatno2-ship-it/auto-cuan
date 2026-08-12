/**
 * Stock Daily History Store — batch-oriented Supabase access for
 * stock_daily_history / stock_daily_features / stock_fundamentals.
 *
 * Deliberately batch-first: screeners/API code should call
 * getLatestSessionsForTickers(supabase, tickers, count) ONCE per run and
 * build an in-memory map, not query per ticker. See project spec section 13
 * (performance requirements) and section 14 (feature snapshot cache).
 */

'use strict';

const { HISTORY_RETENTION_TRADING_SESSIONS } = require('./daily-market-context-constants');

function chunk(items, size) {
  var result = [];
  for (var i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

const UPSERT_BATCH_SIZE = 200;

/**
 * Idempotent upsert of daily history rows. Conflict key is (ticker, trade_date).
 * rows: [{ ticker, trade_date, open, high, low, close, previous_close, volume,
 *          value, frequency, foreign_buy_value, foreign_sell_value,
 *          foreign_net_value, foreign_buy_lot, foreign_sell_lot,
 *          foreign_net_lot, data_source, source_timestamp, data_quality_status }]
 */
async function upsertDailyHistory(supabase, rows) {
  if (!supabase) throw new Error('supabase client is required');
  var normalized = (rows || []).map(function(row) {
    return Object.assign({}, row, { updated_at: new Date().toISOString() });
  });

  var upserted = 0;
  for (var batch of chunk(normalized, UPSERT_BATCH_SIZE)) {
    var result = await supabase
      .from('stock_daily_history')
      .upsert(batch, { onConflict: 'ticker,trade_date' });
    if (result.error) throw new Error('Upsert stock_daily_history gagal: ' + result.error.message);
    upserted += batch.length;
  }
  return upserted;
}

/**
 * Delete history rows older than the retention window, per ticker.
 * Keeps the most recent `retentionSessions` rows for each ticker in `tickers`.
 */
async function enforceRetention(supabase, tickers, retentionSessions) {
  retentionSessions = retentionSessions || HISTORY_RETENTION_TRADING_SESSIONS;
  var deleted = 0;

  for (var tickerBatch of chunk(tickers, 50)) {
    var lookup = await supabase
      .from('stock_daily_history')
      .select('id,ticker,trade_date')
      .in('ticker', tickerBatch)
      .order('trade_date', { ascending: false });
    if (lookup.error) throw new Error('Retention lookup gagal: ' + lookup.error.message);

    var byTicker = new Map();
    for (var row of lookup.data || []) {
      if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
      byTicker.get(row.ticker).push(row);
    }

    var deleteIds = [];
    for (var tickerRows of byTicker.values()) {
      for (var i = retentionSessions; i < tickerRows.length; i++) deleteIds.push(tickerRows[i].id);
    }

    for (var idBatch of chunk(deleteIds, 200)) {
      var removal = await supabase.from('stock_daily_history').delete().in('id', idBatch);
      if (removal.error) throw new Error('Retention delete gagal: ' + removal.error.message);
      deleted += idBatch.length;
    }
  }
  return deleted;
}

/**
 * Batch-load the latest `count` sessions for a set of tickers in ONE query,
 * returning a Map<ticker, rows[]> with rows sorted newest-first.
 */
async function getLatestSessionsForTickers(supabase, tickers, count) {
  if (!supabase) throw new Error('supabase client is required');
  var uniqueTickers = Array.from(new Set((tickers || []).map(function(t) { return String(t).toUpperCase(); })));
  if (!uniqueTickers.length) return new Map();

  // Fetch a generous window (count is per-ticker, query is cross-ticker) then
  // group+trim in memory — one round trip regardless of ticker count.
  var fetchLimit = Math.max(count * uniqueTickers.length, uniqueTickers.length);
  var result = await supabase
    .from('stock_daily_history')
    .select('ticker,trade_date,open,high,low,close,previous_close,volume,value,frequency,' +
      'foreign_buy_value,foreign_sell_value,foreign_net_value,foreign_buy_lot,foreign_sell_lot,foreign_net_lot,' +
      'data_source,data_quality_status')
    .in('ticker', uniqueTickers)
    .order('trade_date', { ascending: false })
    .limit(fetchLimit);

  if (result.error) throw new Error('Load stock_daily_history gagal: ' + result.error.message);

  var map = new Map();
  for (var row of result.data || []) {
    if (!map.has(row.ticker)) map.set(row.ticker, []);
    var rowsForTicker = map.get(row.ticker);
    if (rowsForTicker.length < count) rowsForTicker.push(row);
  }
  return map;
}

/** Single-ticker convenience wrapper (still one query). */
async function getLatestSessionsForTicker(supabase, ticker, count) {
  var map = await getLatestSessionsForTickers(supabase, [ticker], count);
  return map.get(String(ticker).toUpperCase()) || [];
}

/** Batch upsert of precomputed feature snapshots (one row per ticker). */
async function upsertDailyFeatures(supabase, rows) {
  if (!supabase) throw new Error('supabase client is required');
  // Defense-in-depth: stock_daily_features.as_of_trade_date is NOT NULL.
  // The preferred safety layer is upstream (daily-market-context-builder's
  // buildFeatureSnapshotsForTickers already skips tickers with no history),
  // but this guard ensures one malformed row can never poison an otherwise
  // valid batch upsert or throw away good tickers' data.
  var validRows = (rows || []).filter(function(row) {
    var valid = !!(row && row.ticker && row.as_of_trade_date);
    if (!valid && typeof console !== 'undefined' && console.warn) {
      console.warn('[stock-daily-history-store] Dropping invalid feature row (missing ticker/as_of_trade_date): ' +
        JSON.stringify({ ticker: row && row.ticker, as_of_trade_date: row && row.as_of_trade_date }));
    }
    return valid;
  });

  var normalized = validRows.map(function(row) {
    return Object.assign({}, row, { updated_at: new Date().toISOString() });
  });
  var upserted = 0;
  for (var batch of chunk(normalized, UPSERT_BATCH_SIZE)) {
    var result = await supabase.from('stock_daily_features').upsert(batch, { onConflict: 'ticker' });
    if (result.error) throw new Error('Upsert stock_daily_features gagal: ' + result.error.message);
    upserted += batch.length;
  }
  return upserted;
}

/** Batch fetch of precomputed feature snapshots — ONE query for N tickers. */
async function getDailyFeaturesForTickers(supabase, tickers) {
  if (!supabase) throw new Error('supabase client is required');
  var uniqueTickers = Array.from(new Set((tickers || []).map(function(t) { return String(t).toUpperCase(); })));
  if (!uniqueTickers.length) return new Map();

  var result = await supabase.from('stock_daily_features').select('*').in('ticker', uniqueTickers);
  if (result.error) throw new Error('Load stock_daily_features gagal: ' + result.error.message);

  var map = new Map();
  for (var row of result.data || []) map.set(row.ticker, row);
  return map;
}

/**
 * Batch fetch of the ENTIRE stock_daily_features cache — the data source for
 * the "Ranking Harian" table, which needs to compare/sort across the whole
 * ticker universe rather than a caller-supplied list. One query regardless
 * of universe size (bounded by `limit`).
 */
async function getAllDailyFeatures(supabase, options) {
  if (!supabase) throw new Error('supabase client is required');
  options = options || {};
  var limit = options.limit || 1000;

  var result = await supabase
    .from('stock_daily_features')
    .select('*')
    .order('ticker', { ascending: true })
    .limit(limit);
  if (result.error) throw new Error('Load stock_daily_features (all) gagal: ' + result.error.message);
  return result.data || [];
}

async function getFundamentalsForTickers(supabase, tickers) {
  if (!supabase) throw new Error('supabase client is required');
  var uniqueTickers = Array.from(new Set((tickers || []).map(function(t) { return String(t).toUpperCase(); })));
  if (!uniqueTickers.length) return new Map();

  var result = await supabase.from('stock_fundamentals').select('*').in('ticker', uniqueTickers);
  if (result.error) throw new Error('Load stock_fundamentals gagal: ' + result.error.message);

  var map = new Map();
  for (var row of result.data || []) map.set(row.ticker, row);
  return map;
}

module.exports = {
  upsertDailyHistory,
  enforceRetention,
  getLatestSessionsForTickers,
  getLatestSessionsForTicker,
  upsertDailyFeatures,
  getDailyFeaturesForTickers,
  getAllDailyFeatures,
  getFundamentalsForTickers
};

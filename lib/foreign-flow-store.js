/**
 * Foreign Flow Store — batch reads from the existing `foreign_watchlist_daily`
 * table (see supabase/foreign-watchlist-daily-migration.sql). This module
 * does NOT create a new table: per repository audit, foreign flow already
 * has a working ingestion path (manual admin CSV upload,
 * lib/admin-foreign-upload.js) and this is the single source of truth for
 * `foreign_net` (an IDR VALUE, computed as close * nbsa). `foreign_buy` and
 * `foreign_sell` are always null in that table today — there is no verified
 * buy/sell-split source in this repository, so this module never fabricates
 * a split and only ever surfaces `foreign_net`.
 */

'use strict';

// Keep every request comfortably below common PostgREST/Supabase max-row
// response caps. The old whole-universe query asked for ~7 * 771 rows in one
// response; a server-side 1,000-row cap could silently return only the newest
// session for most tickers, which made Foreign 7D equal Foreign Terbaru.
const SAFE_QUERY_ROW_BUDGET = 900;

function chunk(items, size) {
  var result = [];
  for (var i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * Batch-load the latest `count` foreign rows for a set of tickers, returning
 * Map<ticker, rows[]> sorted newest-first.
 *
 * Queries are chunked so count * tickers-per-query stays below the response
 * row budget. This preserves batch behaviour without relying on a single
 * oversized response that can be truncated by PostgREST.
 */
async function getLatestForeignForTickers(supabase, tickers, count) {
  if (!supabase) throw new Error('supabase client is required');
  var uniqueTickers = Array.from(new Set((tickers || []).map(function(t) { return String(t).toUpperCase(); })));
  if (!uniqueTickers.length) return new Map();

  count = Math.max(1, Number(count) || 1);
  var tickerBatchSize = Math.max(1, Math.floor(SAFE_QUERY_ROW_BUDGET / count));
  var map = new Map();

  for (var tickerBatch of chunk(uniqueTickers, tickerBatchSize)) {
    var fetchLimit = Math.max(count * tickerBatch.length, tickerBatch.length);
    var result = await supabase
      .from('foreign_watchlist_daily')
      .select('ticker,trade_date,foreign_buy,foreign_sell,foreign_net,close,volume')
      .in('ticker', tickerBatch)
      .order('trade_date', { ascending: false })
      .limit(fetchLimit);

    if (result.error) throw new Error('Load foreign_watchlist_daily gagal: ' + result.error.message);

    for (var row of result.data || []) {
      if (!map.has(row.ticker)) map.set(row.ticker, []);
      var rowsForTicker = map.get(row.ticker);
      if (rowsForTicker.length < count) rowsForTicker.push(row);
    }
  }

  return map;
}

async function getLatestForeignForTicker(supabase, ticker, count) {
  var map = await getLatestForeignForTickers(supabase, [ticker], count);
  return map.get(String(ticker).toUpperCase()) || [];
}

module.exports = {
  getLatestForeignForTickers,
  getLatestForeignForTicker
};

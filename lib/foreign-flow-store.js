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

/**
 * Batch-load the latest `count` foreign rows for a set of tickers in ONE
 * query, returning Map<ticker, rows[]> sorted newest-first.
 */
async function getLatestForeignForTickers(supabase, tickers, count) {
  if (!supabase) throw new Error('supabase client is required');
  var uniqueTickers = Array.from(new Set((tickers || []).map(function(t) { return String(t).toUpperCase(); })));
  if (!uniqueTickers.length) return new Map();

  var fetchLimit = Math.max(count * uniqueTickers.length, uniqueTickers.length);
  var result = await supabase
    .from('foreign_watchlist_daily')
    .select('ticker,trade_date,foreign_buy,foreign_sell,foreign_net,close,volume')
    .in('ticker', uniqueTickers)
    .order('trade_date', { ascending: false })
    .limit(fetchLimit);

  if (result.error) throw new Error('Load foreign_watchlist_daily gagal: ' + result.error.message);

  var map = new Map();
  for (var row of result.data || []) {
    if (!map.has(row.ticker)) map.set(row.ticker, []);
    var rowsForTicker = map.get(row.ticker);
    if (rowsForTicker.length < count) rowsForTicker.push(row);
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

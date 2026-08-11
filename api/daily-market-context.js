/**
 * Auto-Cuan Daily Market Context API
 *
 * GET /api/daily-market-context?ticker=BBCA
 *
 * Returns last price, RSI14, PBV, 7-session volume context, and 7-session
 * foreign flow context for one ticker, per the Daily Market Context data
 * layer (supabase/stock-daily-context-migration.sql).
 *
 * Reads the precomputed stock_daily_features cache first (fast path, no
 * recomputation). Falls back to an on-demand build (3 bounded queries) if
 * the cache is missing or older than the price-freshness window, so a newly
 * onboarded ticker isn't stuck returning nothing until the next collector run.
 *
 * This endpoint is purely additive — it does not read from or write to any
 * table used by the Fast Watcher, Day Trade screener, Swing screener, or
 * Telegram delivery pipeline.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const historyStore = require('../lib/stock-daily-history-store');
const contextBuilder = require('../lib/daily-market-context-builder');

function normalizeTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\.JK$/, '');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const ticker = normalizeTicker(req.query && req.query.ticker);
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ success: false, error: 'Parameter ticker wajib diisi dan valid.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ success: false, error: 'Database belum dikonfigurasi.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const cacheMap = await historyStore.getDailyFeaturesForTickers(supabase, [ticker]);
    const cacheExists = cacheMap.has(ticker);

    // Single-ticker request: computing RSI/volume/foreign context in memory
    // from the 3 bounded queries below is negligible CPU cost, so we always
    // build a complete, internally-consistent response (including the 7-day
    // history arrays) rather than serving a reduced cached snapshot that
    // lacks them. The stock_daily_features cache exists for BATCH reads
    // (screeners / future Fast Watcher shadow integration), not this endpoint.
    const context = await contextBuilder.buildContextForTicker(supabase, ticker, {});
    return res.status(200).json({
      success: true,
      source: cacheExists ? 'live_with_cache_available' : 'live_no_cache',
      context: context
    });
  } catch (error) {
    return res.status(200).json({
      success: false,
      error: 'Gagal memuat konteks pasar harian.',
      diagnostic: error && error.message
    });
  }
};

module.exports.__test = { normalizeTicker };

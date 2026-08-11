/**
 * Daily Market Context — Collector CLI
 *
 * Usage: node scripts/collect-daily-market-context.js [TICKER1,TICKER2,...]
 *
 * Requires environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * What it does:
 * 1. Cheap market-day guard (Asia/Jakarta) — exits successfully without any
 *    network/DB work if today is not a trading day (weekend, or a holiday if
 *    idx_trading_calendar has been populated).
 * 2. Resolves the ticker universe: explicit CLI arg list, or the existing
 *    full eligible universe (stock_boards) if no arg is given.
 * 3. Batch-collects daily OHLCV from Yahoo Finance into stock_daily_history
 *    (idempotent upsert, retention enforced).
 * 4. Batch-builds stock_daily_features snapshots (RSI/volume/foreign/PBV)
 *    from the data now in the DB — 3 queries total, not per ticker.
 *
 * IMPORTANT: this script is NOT wired into cron by this change. Per the
 * project's safety rules, production cron is not modified here — an
 * operator must add this manually (e.g. a daily systemd timer / cron entry
 * after market close, ~16:15 WIB) once reviewed.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const calendar = require('../lib/idx-trading-calendar');
const collector = require('../lib/daily-history-collector');
const contextBuilder = require('../lib/daily-market-context-builder');
const historyStore = require('../lib/stock-daily-history-store');
const universe = require('../lib/daytrade-full-eligible-universe');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function resolveTickers(argTickers) {
  if (argTickers && argTickers.length) return argTickers;
  const result = await universe.loadFullEligibleUniverseFromSupabase();
  return result.tickers || [];
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[collect-daily-market-context] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const guard = await calendar.marketDayGuard(supabase, {});
  if (!guard.shouldRun) {
    console.log('[collect-daily-market-context] MARKET_CLOSED reason=' + guard.reason + ' trade_date=' + guard.tradeDate + '. Exiting successfully.');
    process.exit(0);
  }
  console.log('[collect-daily-market-context] trade_date=' + guard.tradeDate + ' calendar_source=' + guard.calendarSource);

  const argTickers = (process.argv[2] || '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const tickers = await resolveTickers(argTickers);
  console.log('[collect-daily-market-context] Universe size: ' + tickers.length);

  const startTime = Date.now();
  const collectResult = await collector.collectDailyHistoryForTickers(supabase, tickers, {});
  console.log('[collect-daily-market-context] History collected: ' + JSON.stringify({
    tickers_requested: collectResult.tickers_requested,
    rows_upserted: collectResult.rows_upserted,
    failed: collectResult.failed.length,
    skipped: collectResult.skipped.length
  }));

  const featureRows = await contextBuilder.buildFeatureSnapshotsForTickers(supabase, tickers, {});
  const upserted = await historyStore.upsertDailyFeatures(supabase, featureRows);
  console.log('[collect-daily-market-context] Feature snapshots upserted: ' + upserted);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[collect-daily-market-context] Done in ' + elapsedSec + 's.');
}

main().catch((e) => {
  console.error('[collect-daily-market-context] Unexpected error:', e && e.message);
  process.exit(1);
});

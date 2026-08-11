/**
 * Daily Market Context — Collector CLI
 *
 * Usage:
 *   node scripts/collect-daily-market-context.js [TICKER1,TICKER2,...]
 *   node scripts/collect-daily-market-context.js [TICKER1,TICKER2,...] --dry-run
 *
 * Requires environment variables (skipped in --dry-run):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * What it does:
 * 1. Cheap market-day guard (Asia/Jakarta) — exits 0 with a MARKET_CLOSED
 *    reason, before any network/DB work, if today is not a trading day
 *    (weekend, or a holiday once idx_trading_calendar has rows).
 * 2. Resolves the ticker universe: explicit CLI arg list, or the existing
 *    full eligible universe (stock_boards) if no arg is given.
 * 3. Batch-collects daily OHLCV from Yahoo Finance into stock_daily_history
 *    (idempotent upsert, retention enforced).
 * 4. Batch-builds stock_daily_features snapshots (RSI/volume/foreign/PBV)
 *    from the data now in the DB — 3 queries total, not per ticker.
 *
 * --dry-run: validates configuration, runs the market-day guard, resolves
 * the ticker universe, and logs what WOULD be collected — makes zero Yahoo
 * requests and zero writes. Useful for VPS wrapper smoke-testing before
 * enabling a real cron entry.
 *
 * Never sends Telegram messages, never touches the Fast Watcher state, never
 * modifies cron. This file only runs main() when executed directly (not
 * when required by tests), so `require`-ing it for its helper functions
 * never triggers real work.
 *
 * See deploy/vps/run-daily-market-context-collector.sh for the safe VPS
 * wrapper (lock + timeout) meant to eventually call this script, and the
 * documented (not-yet-installed) cron line in that wrapper's header comment.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const calendar = require('../lib/idx-trading-calendar');
const collector = require('../lib/daily-history-collector');
const contextBuilder = require('../lib/daily-market-context-builder');
const historyStore = require('../lib/stock-daily-history-store');
const universe = require('../lib/daytrade-full-eligible-universe');

async function resolveTickers(argTickers) {
  if (argTickers && argTickers.length) return argTickers;
  const result = await universe.loadFullEligibleUniverseFromSupabase();
  return result.tickers || [];
}

function parseArgs(argv) {
  const isDryRun = argv.includes('--dry-run');
  const positional = argv.filter((a) => a !== '--dry-run')[0] || '';
  const argTickers = positional.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  return { isDryRun, argTickers };
}

async function run(argv, options) {
  options = options || {};
  const SUPABASE_URL = options.supabaseUrl !== undefined ? options.supabaseUrl : process.env.SUPABASE_URL;
  const SUPABASE_KEY = options.supabaseKey !== undefined ? options.supabaseKey : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { isDryRun, argTickers } = parseArgs(argv);

  if (!isDryRun && (!SUPABASE_URL || !SUPABASE_KEY)) {
    console.error('[collect-daily-market-context] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    return { exitCode: 1 };
  }

  const supabase = isDryRun && (!SUPABASE_URL || !SUPABASE_KEY)
    ? null
    : createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const guard = await calendar.marketDayGuard(supabase, {});
  if (!guard.shouldRun) {
    console.log('[collect-daily-market-context] MARKET_CLOSED reason=' + guard.reason + ' trade_date=' + guard.tradeDate + '. Exiting successfully.');
    return { exitCode: 0, guard };
  }
  console.log('[collect-daily-market-context] trade_date=' + guard.tradeDate + ' calendar_source=' + guard.calendarSource);

  const tickers = supabase ? await resolveTickers(argTickers) : argTickers;
  console.log('[collect-daily-market-context] Universe size: ' + tickers.length);

  if (isDryRun) {
    console.log('[collect-daily-market-context] --dry-run: no Yahoo requests or writes performed.');
    return { exitCode: 0, guard, dryRun: true, tickerCount: tickers.length };
  }

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
  return { exitCode: 0, guard, collectResult, featuresUpserted: upserted };
}

if (require.main === module) {
  run(process.argv.slice(2)).then((result) => {
    process.exit(result && result.exitCode != null ? result.exitCode : 0);
  }).catch((e) => {
    console.error('[collect-daily-market-context] Unexpected error:', e && e.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, resolveTickers };

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
  // Explicit CLI tickers are already normalized by parseArgs; re-normalizing
  // here is a harmless no-op for that path and makes this function safe to
  // call directly (as tests do) with either strings or row objects.
  if (argTickers && argTickers.length) return normalizeTickerList(argTickers);
  const result = await universe.loadFullEligibleUniverseFromSupabase();
  // result.tickers is an array of full eligibility ROW OBJECTS (each with a
  // `.ticker` field), not plain ticker strings — that's
  // daytrade-full-eligible-universe.js's existing, unchanged contract (other
  // consumers rely on the row shape). Normalize only at this boundary.
  return normalizeTickerList(result.tickers);
}

function parseArgs(argv) {
  const isDryRun = argv.includes('--dry-run');
  // Skip --dry-run AND any empty-string entries — an empty leading arg
  // (e.g. a wrapper accidentally forwarding an unset env var as its own
  // positional slot) must never shadow a real ticker list positioned after
  // it. This is a defense-in-depth guard; the wrapper itself is also fixed
  // to never emit an empty positional (deploy/vps/run-daily-market-context-collector.sh).
  const positional = argv.filter((a) => a !== '--dry-run' && String(a || '').trim() !== '')[0] || '';
  const argTickers = normalizeTickerList(positional.split(','));
  return { isDryRun, argTickers };
}

/**
 * Normalize a mixed list of ticker entries into clean, deduplicated,
 * uppercase ticker strings. Accepts either plain strings ("BBCA") or row
 * objects with a `.ticker` string field (the shape
 * lib/daytrade-full-eligible-universe.js's `tickers` array actually returns
 * — full eligibility rows, not plain strings, per its existing contract,
 * which this function does not change). Anything else (null, numbers,
 * objects without a usable `.ticker`) is dropped rather than coerced via
 * String(), which would otherwise silently produce garbage like
 * "[OBJECT OBJECT]".
 */
function normalizeTickerList(items) {
  const seen = new Set();
  const result = [];
  for (const item of (items || [])) {
    let raw = null;
    if (typeof item === 'string') {
      raw = item;
    } else if (item && typeof item === 'object' && typeof item.ticker === 'string') {
      raw = item.ticker;
    }
    if (raw == null) continue;
    const ticker = raw.trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    result.push(ticker);
  }
  return result;
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

  const featureResult = await contextBuilder.buildFeatureSnapshotsForTickers(supabase, tickers, {});

  // 52W metrics are derived from the SAME full one-year Yahoo payload used
  // above. Keep rows without a fresh Yahoo metric separate so a transient
  // Yahoo failure cannot overwrite a previously cached 52W value with null.
  const metricRows = [];
  const baseRows = [];
  const tickerMetrics = collectResult.ticker_metrics || {};

  for (const row of featureResult.rows) {
    const metric = tickerMetrics[row.ticker];

    if (metric) {
      metricRows.push(Object.assign({}, row, {
        high_52w: metric.high_52w,
        distance_to_high_52w_pct: metric.distance_to_high_52w_pct
      }));
    } else {
      baseRows.push(row);
    }
  }

  let upserted = 0;
  if (baseRows.length) {
    upserted += await historyStore.upsertDailyFeatures(supabase, baseRows);
  }
  if (metricRows.length) {
    upserted += await historyStore.upsertDailyFeatures(supabase, metricRows);
  }
  console.log('[collect-daily-market-context] Feature snapshots upserted: ' + upserted +
    ', skipped_no_history: ' + featureResult.skippedTickers.length);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('[collect-daily-market-context] Done in ' + elapsedSec + 's.');
  return {
    exitCode: 0,
    guard,
    collectResult,
    featuresUpserted: upserted,
    featuresSkippedNoHistory: featureResult.skippedTickers
  };
}

if (require.main === module) {
  run(process.argv.slice(2)).then((result) => {
    process.exit(result && result.exitCode != null ? result.exitCode : 0);
  }).catch((e) => {
    console.error('[collect-daily-market-context] Unexpected error:', e && e.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, resolveTickers, normalizeTickerList };

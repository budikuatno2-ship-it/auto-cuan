'use strict';

/**
 * Daily candle close & volume fetch (EOD retry window from 18:00 WIB).
 * Uses lib/chart-engine/candle-fetcher.js against the Arjum history endpoint.
 * Idempotent by target trade date: a complete cached OHLCV row is reused,
 * even when a newer session is present. Missing target rows are refreshed.
 *
 * Usage (VPS):
 *   set -a; . ./.env.ai-eval-once; set +a
 *   node tools/fetch-daily-candles.js            # full universe
 *   node tools/fetch-daily-candles.js --limit=50
 *   node tools/fetch-daily-candles.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const fetcher = require('../lib/chart-engine/candle-fetcher');
const idxTradingCalendar = require('../lib/idx-trading-calendar');
const { getVpsMarketStore } = require('../lib/vps-market-store');
const { createClient: createHybridClient, marketDataVpsEnabled } = require('../lib/hybrid-supabase-client');
const { isValidIdxTicker } = require('../lib/idx-ticker');

const DEFAULT_CROSSCHECK_TICKERS = [
  // 10 likuid
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'ASII', 'TLKM', 'BUMI', 'BRPT', 'AMMN', 'ADRO',
  // 10 lainnya
  'MEDC', 'PGAS', 'PTBA', 'CPIN', 'KLBF', 'ALDO', 'BIKA', 'CITY', 'FISH', 'LIFE'
];

async function performDailyCrossCheck(targetDate, options = {}) {
  const sampleTickers = options.tickers || DEFAULT_CROSSCHECK_TICKERS;
  const maxVariancePct = Number(options.maxVariancePct || 0.5); // 0.5% threshold
  const details = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const ticker of sampleTickers) {
    // 1. Fetch from Arjum (1 request per sample ticker)
    const arjumRes = await fetcher.fetchDailyCandles(ticker, { force: true, source: 'arjum' });
    const arjumCandle = arjumRes.ok && arjumRes.data && Array.isArray(arjumRes.data.candles)
      ? arjumRes.data.candles.find(c => String(c.date || '').slice(0, 10) === targetDate)
      : (fetcher.readCache(ticker)?.candles?.find(c => String(c.date || '').slice(0, 10) === targetDate));

    const arjumClose = arjumCandle ? Number(arjumCandle.close) : null;

    // 2. Fetch from Yahoo
    const yahooRes = await fetcher.fetchDailyCandlesYahoo(ticker, { range: '5d', retries: 2 });
    const yahooCandle = yahooRes.ok && yahooRes.data && Array.isArray(yahooRes.data.candles)
      ? yahooRes.data.candles.find(c => String(c.date || '').slice(0, 10) === targetDate)
      : null;

    if (!arjumCandle) {
      // Arjum itself has not published EOD candle yet
      details.push({ ticker, status: 'arjum_not_ready', passed: false });
      failedCount++;
      continue;
    }

    if (!yahooCandle) {
      details.push({ ticker, status: 'yahoo_missing_bar', passed: false });
      failedCount++;
      continue;
    }

    const aClose = arjumClose;
    const yClose = Number(yahooCandle.close);
    const diffPct = aClose > 0 ? (Math.abs(yClose - aClose) / aClose) * 100 : 0;
    const isOk = diffPct <= maxVariancePct;

    if (isOk) passedCount++;
    else failedCount++;

    details.push({
      ticker,
      arjumClose: aClose,
      yahooClose: yClose,
      diffPct: Number(diffPct.toFixed(2)),
      passed: isOk
    });
  }

  const allPassed = failedCount === 0 && passedCount === sampleTickers.length;
  return {
    ok: allPassed,
    total: sampleTickers.length,
    passed: passedCount,
    failed: failedCount,
    details
  };
}

function loadEnvFile() {
  const candidates = [path.join(__dirname, '..', '.env.ai-eval-once'), path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    } catch (_) {}
  }
}

function loadTickers() {
  const master = path.join(process.cwd(), 'data', 'daytrade-observe-tickers.txt');
  let tickers = [];
  try {
    if (fs.existsSync(master)) {
      tickers = Array.from(new Set(
        fs.readFileSync(master, 'utf8').split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(isValidIdxTicker)
      )).sort();
    }
  } catch (_) {}

  if (!tickers.length) {
    const idx = path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary');
    try {
      const dirs = fs.readdirSync(idx, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).filter(isValidIdxTicker);
      if (dirs.length) tickers = dirs.sort();
    } catch (_) {}
  }

  // Langkah 2: IHSG otomatis masuk cron candle harian jika IHSG_SYMBOL diset
  const ihsgSymbol = String(process.env.IHSG_SYMBOL || '').trim();
  if (ihsgSymbol && !tickers.includes('IHSG')) {
    tickers.push('IHSG');
  }

  return tickers;
}

function todayWib(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now || new Date());
}

function createCalendarClient() {
  if (marketDataVpsEnabled(process.env)) {
    try { return getVpsMarketStore(); } catch (_) {}
  }
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      return createHybridClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
    } catch (_) {}
  }
  return null;
}

async function resolveTradingDay(targetDate, client) {
  const dbCalendar = await idxTradingCalendar.loadHolidayCalendar(client, {
    fromDate: targetDate,
    toDate: targetDate
  });
  const holidaySet = dbCalendar.source === 'db'
    ? dbCalendar.holidaySet
    : idxTradingCalendar.getSeedHolidaySet();
  return {
    shouldRun: idxTradingCalendar.isTradingDay(targetDate, holidaySet),
    source: dbCalendar.source === 'db' ? 'vps_or_hybrid_calendar' : 'seed_calendar_fallback'
  };
}

function latestCachedDate(ticker) {
  const cache = fetcher.readCache(ticker);
  const candles = cache && Array.isArray(cache.candles) ? cache.candles : [];
  let latest = null;
  for (const row of candles) {
    const d = String(row && row.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!latest || d > latest)) latest = d;
  }
  return latest;
}

// B3 (2026-10-20): the standalone J2 cron run must take the shared Arjum lock so
// it never runs in parallel with J1 or the backfill worker. When J1 itself
// invokes this in-process (already holding the lock) the lock is reentrant and
// runs directly.
//
// The lock is acquired only AFTER the trading-day check: a market-closed day
// must stay a pure no-op (MARKET_CLOSED) and must never be reported as
// "busy" — that would mask the real reason for a skipped run.
async function main(options) {
  return mainUnlocked(options);
}

async function mainUnlocked(options) {
  options = options || {};
  loadEnvFile();
  const argv = options.argv || process.argv;
  const dryRun = options.dryRun != null ? options.dryRun : argv.includes('--dry-run');
  const limitArg = Number((argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
  let tickers = options.tickers;
  if (!tickers) {
    const tickersArg = (argv.find(a => a.startsWith('--tickers=')) || '').slice(10);
    if (tickersArg) {
      tickers = tickersArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    } else {
      tickers = loadTickers();
    }
  }
  const universe = limitArg > 0 ? tickers.slice(0, limitArg) : tickers;

  const targetDate = options.targetDate || todayWib(options.now);
  const tradingDay = await resolveTradingDay(targetDate, options.calendarClient || createCalendarClient());
  if (!tradingDay.shouldRun) {
    const closedSummary = {
      universe: universe.length,
      target_date: targetDate,
      skipped: true,
      reason: 'MARKET_CLOSED',
      calendar_source: tradingDay.source,
      fetched: 0,
      cached: 0,
      stale: 0,
      failed: 0,
      stale_after_fetch: 0,
      quota_stop: false
    };
    console.log(JSON.stringify({ mode: dryRun ? 'DRY_RUN' : 'LIVE', ...closedSummary }, null, 2));
    return closedSummary;
  }

  const summary = {
    universe: universe.length,
    target_date: targetDate,
    calendar_source: tradingDay.source,
    candle_source: options.source || process.env.CANDLE_SOURCE || 'yahoo',
    arjum_touched: (options.source || process.env.CANDLE_SOURCE || 'yahoo') === 'arjum',
    cross_check_enabled: false,
    fetched: 0,
    cached: 0,
    stale: 0,
    failed: 0,
    stale_after_fetch: 0,
    quota_stop: false,
    yahoo_fetched: 0,
    ihsg_ok: null,
    cross_check_failed: false,
    cross_check: null,
    sqlite_sync: null,
    sqlite_sync_failed: false
  };

  const candleSource = options.source || process.env.CANDLE_SOURCE || 'yahoo';

  // V6 AUDIT FIX: Arjum cross-check is now strictly OPT-IN for the Yahoo pass.
  // The default Yahoo-only path MUST NOT consume Arjum quota. Previously
  // `crossCheckEnabled` defaulted to true, so a "Yahoo pass" could still burn 20
  // Arjum requests through performDailyCrossCheck. Enable only when explicitly
  // requested via --cross-check / options.crossCheck === true, or when the
  // operator opts in via env CANDLE_CROSSCHECK=true (and CANDLE_ARJUM_CROSSCHECK
  // is not explicitly 'false').
  // An explicit `crossCheckTickers` array is itself an opt-in: a caller that
  // names the sample set clearly intends a cross-check to run. This keeps the
  // quota-safe default (no cross-check unless requested) while making the
  // explicit request meaningful — the R2 regression was that supplying
  // crossCheckTickers alone silently disabled the cross-check entirely.
  const crossCheckRequested =
    options.crossCheck === true ||
    process.env.CANDLE_CROSSCHECK === 'true' ||
    (Array.isArray(options.crossCheckTickers) && options.crossCheckTickers.length > 0);
  const crossCheckEnabled =
    crossCheckRequested &&
    process.env.CANDLE_ARJUM_CROSSCHECK !== 'false';
  summary.cross_check_enabled = crossCheckEnabled;
  summary.arjum_touched = summary.arjum_touched || (candleSource === 'arjum');

  // B3 (2026-10-20): take the shared Arjum lock for the REQUEST phase only.
  // It is acquired here (after the trading-day check, so a market-closed day
  // stays MARKET_CLOSED) and released as soon as the pass finishes. J1 invokes
  // this in-process while already holding the lock — the lock is reentrant, so
  // the nested pass runs directly.
  // V6 AUDIT FIX: Yahoo Finance (0 kuota) berjalan 100% independen tanpa lock Arjum!
  // Mengambil lock Arjum untuk Yahoo menyebabkan J2 diskip (SKIPPED_ARJUM_BUSY)
  // jika ada job Arjum/backfill/J1 lain aktif. Padahal Yahoo tidak mengonsumsi kuota Arjum.
  // Hanya ambil shared Arjum lock jika candleSource === 'arjum'.
  if (candleSource === 'arjum') {
    const arjumSharedLock = require('../lib/arjum-shared-lock');
    const lockOutcome = await arjumSharedLock.withArjumLock({ job: 'J2-candles', waitMs: 0 }, () => runCandlePass({
      options, universe, targetDate, dryRun, candleSource, crossCheckEnabled, summary, tradingDay
    }));
    if (lockOutcome && lockOutcome.skipped) {
      console.warn('[CANDLE-SKIP] SKIPPED_ARJUM_BUSY: job Arjum lain sedang berjalan; J2 dilewati untuk firing ini.');
      const busy = { universe: universe.length, target_date: targetDate, skipped: true, reason: 'SKIPPED_ARJUM_BUSY', calendar_source: tradingDay.source, fetched: 0, cached: 0, stale: 0, failed: 0, stale_after_fetch: 0, quota_stop: false };
      console.log(JSON.stringify({ mode: dryRun ? 'DRY_RUN' : 'LIVE', ...busy }, null, 2));
      return busy;
    }
    return lockOutcome;
  }

  // Yahoo pass runs independently without blocking Arjum lock
  return await runCandlePass({
    options, universe, targetDate, dryRun, candleSource, crossCheckEnabled, summary, tradingDay
  });
}

// B3: the actual request phase of the daily candle pass (runs under the shared
// Arjum lock).
async function runCandlePass(ctx) {
  const { options, universe, targetDate, dryRun, candleSource, crossCheckEnabled, summary, tradingDay } = ctx;
  summary.cross_check_enabled = crossCheckEnabled;

  // BUG-01 Fix: Yahoo Finance is the primary, free, quota-less source for all 962 stocks.
  // Cross-check to Arjum is an analytical verification, NOT a blocker that aborts saving Yahoo candles!
  // At 16:40 WIB, Arjum often has not published EOD yet, but Yahoo already has it.
  // Yahoo candles must ALWAYS be fetched and persisted immediately without waiting for 23:30 WIB.

  for (const ticker of universe) {

    const hasTarget = () => {
      const cache = fetcher.readCache(ticker);
      return (cache && cache.candles || []).some(row => String(row.date || '').slice(0,10) === targetDate &&
        ['open','high','low','close','volume'].every(key => row[key] != null && String(row[key]).trim() !== '' && Number.isFinite(Number(row[key]))));
    };
    if (hasTarget()) {
      summary.cached++;
      continue;
    }

    summary.stale++;
    if (dryRun) continue;

    let res = null;
    let usedYahoo = false;

    if (candleSource === 'yahoo') {
      // V6 AUDIT FIX: IHSG now routes through Yahoo ^JKSE like every other ticker.
      res = await fetcher.fetchDailyCandlesYahoo(ticker, { range: '5d', retries: 2 });
      usedYahoo = Boolean(res && res.ok);
      if (ticker === 'IHSG') summary.ihsg_ok = usedYahoo;

      // V6 AUDIT FIX: Arjum fallback is STRICTLY OPT-IN. A Yahoo-only pass must
      // never touch Arjum quota by default — not even on the late night pass.
      // Only the explicit flag (options.allowArjumFallback true or
      // CANDLE_ALLOW_ARJUM_FALLBACK=1) enables the fallback.
      if (!usedYahoo && (options.allowArjumFallback === true || process.env.CANDLE_ALLOW_ARJUM_FALLBACK === '1')) {
        console.warn(`[CANDLE-FALLBACK] Yahoo failed for ${ticker} (${res ? res.error : 'unknown'}), falling back to Arjum.`);
        summary.arjum_touched = true;
        res = await fetcher.fetchDailyCandles(ticker, {
          limit: Number(process.env.CANDLE_LIMIT) || 500,
          force: true
        });
      }
    } else {
      // Direct Arjum fetch (candleSource === 'arjum'), including IHSG.
      summary.arjum_touched = true;
      res = await fetcher.fetchDailyCandles(ticker, {
        limit: Number(process.env.CANDLE_LIMIT) || 500,
        force: true
      });
      if (ticker === 'IHSG') summary.ihsg_ok = Boolean(res && res.ok);
    }

    if (res && res.ok) {
      if (hasTarget()) {
        summary.fetched++;
        if (usedYahoo) summary.yahoo_fetched++;
      } else {
        summary.failed++;
        summary.stale_after_fetch++;
      }
    } else if (res && res.rateLimited) {
      summary.quota_stop = true;
      break;
    } else {
      summary.failed++;
    }

    // Pacing delay (50ms) between remote calls
    await new Promise(r => setTimeout(r, 50));
    if (summary.fetched % 50 === 0 && summary.fetched > 0) console.log('fetched=' + summary.fetched + ' last=' + ticker);
  }

  // R2: the legacy `allowMassFallbackOnCrossCheckFail` override is now EXPLICIT
  // and LOGGED rather than silently ignored. Under the BUG-01 policy a failed
  // cross-check never triggers a mass Arjum fallback (Yahoo candles are always
  // retained), so the override no longer re-enables the old mass-fallback — it
  // is recorded so an operator can see the request was seen and intentionally
  // not honoured. A mass fallback still requires the separate, explicit
  // `allowArjumFallback` opt-in, which is never reachable with the provider key
  // absent.
  if (options.allowMassFallbackOnCrossCheckFail === true) {
    summary.mass_fallback_override_requested = true;
    console.warn('[CROSS-CHECK-OVERRIDE] allowMassFallbackOnCrossCheckFail=true was supplied; legacy mass Arjum fallback is NOT performed (Yahoo candles retained). Use allowArjumFallback for an explicit per-ticker fallback.');
  }

  // Non-blocking cross-check after Yahoo fetch
  if (candleSource === 'yahoo' && crossCheckEnabled && !dryRun && universe.length > 20 && !options.skipCrossCheck) {
    try {
      const check = await performDailyCrossCheck(targetDate, {
        tickers: options.crossCheckTickers || DEFAULT_CROSSCHECK_TICKERS
      });
      summary.cross_check = {
        total: check.total, passed: check.passed, failed: check.failed, ok: check.ok
      };
      if (!check.ok) {
        summary.cross_check_failed = true;
        console.warn(`[CROSS-CHECK-AUDIT] ${check.failed}/${check.total} sample diffs > 0.5% (Arjum EOD might still be compiling). Yahoo candles safely retained.`);
      } else {
        console.log(`[CROSS-CHECK-OK] ${check.passed}/${check.total} samples matched <= 0.5%.`);
      }
    } catch (err) {
      summary.cross_check_failed = true;
      summary.cross_check = { error: err && err.message };
      console.warn(`[CROSS-CHECK-AUDIT-ERROR] ${err && err.message}. Yahoo candles safely retained.`);
    }
  }

  // V6 AUDIT FIX: Atomic bridge to SQLite stock_daily_history!
  // Flat files in data/daily-candles must immediately sync to SQLite store
  // so chart APIs, screeners, and lifecycle evaluators never observe stale history.
  //
  // FAIL-CLOSED: a failed sync must make the WHOLE job fail. It is no longer a
  // swallowable warning — chart APIs, screeners, and lifecycle consumers read
  // stock_daily_history, so silently succeeding with a broken bridge means they
  // all observe stale (or no) history.
  if (!dryRun && (summary.fetched > 0 || options.forceSqliteSync || process.env.FORCE_SQLITE_SYNC === '1')) {
    try {
      const historySync = require('../lib/daily-history-sqlite-sync');
      const candleDir = path.join(__dirname, '..', 'data', 'daily-candles');
      const syncRes = await historySync.syncRecentHistoryToSqlite({
        candleDir,
        env: process.env,
        sessions: 5
      });
      summary.sqlite_sync = {
        ok: syncRes.ok,
        rows_upserted: syncRes.rows_upserted,
        tickers_scanned: syncRes.tickers_scanned,
        tickers_with_rows: syncRes.tickers_with_rows,
        tickers_unreadable: syncRes.tickers_unreadable,
        tickers_unavailable: syncRes.tickers_unavailable,
        tickers_stale: syncRes.tickers_stale,
        reason: syncRes.reason || null,
        per_ticker: syncRes.per_ticker || null
      };
      if (!syncRes.ok) {
        summary.sqlite_sync_failed = true;
        summary.sqlite_sync_failure_reason = syncRes.reason || 'sqlite_sync_failed';
        console.error(`[SQLITE-SYNC-FAILED] reason=${syncRes.reason || 'unknown'} rows_upserted=${syncRes.rows_upserted || 0}`);
      } else {
        console.log(`[SQLITE-SYNC] Updated SQLite history: rows_upserted=${syncRes.rows_upserted} tickers_scanned=${syncRes.tickers_scanned} stale=${syncRes.tickers_stale || 0}`);
      }
    } catch (syncErr) {
      summary.sqlite_sync_failed = true;
      summary.sqlite_sync_failure_reason = 'sqlite_sync_exception';
      summary.sqlite_sync = { ok: false, error: syncErr.message };
      console.error('[SQLITE-SYNC-FAILED] exception:', syncErr.message);
    }
  }

  // V6 AUDIT FIX: fail-closed health gate. A SQLite sync failure, a failed
  // fetch pass (stale_after_fetch), or a failed opt-in Arjum cross-check means
  // the firing is NOT a success. `ok:false` is in the emitted JSON summary AND
  // the process exit code is non-zero so the VPS wrapper / cron observes a
  // failed firing instead of a silently successful one (the prior behavior
  // only console.warn'd the sync error — FAIL SILENT).
  summary.ok = !summary.sqlite_sync_failed &&
    !summary.cross_check_failed &&
    summary.failed === 0 &&
    summary.stale_after_fetch === 0;
  if (require.main === module && !summary.ok) {
    process.exitCode = 3;
  }

  console.log(JSON.stringify({
    mode: dryRun ? 'DRY_RUN' : 'LIVE',
    used_today: fetcher.getUsedQuotaToday(),
    quota: fetcher.getConfiguredDailyQuota(),
    ...summary
  }, null, 2));
  return summary;
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });
}

module.exports = {
  loadTickers,
  todayWib,
  latestCachedDate,
  createCalendarClient,
  resolveTradingDay,
  performDailyCrossCheck,
  DEFAULT_CROSSCHECK_TICKERS,
  main
};

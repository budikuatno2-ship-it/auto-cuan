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
async function main(options) {
  const arjumSharedLock = require('../lib/arjum-shared-lock');
  const outcome = await arjumSharedLock.withArjumLock({ job: 'J2-candles', waitMs: 0 }, () => mainUnlocked(options));
  if (outcome && outcome.skipped) {
    console.warn('[CANDLE-SKIP] SKIPPED_ARJUM_BUSY: job Arjum lain sedang berjalan; J2 dilewati untuk firing ini.');
    return { skipped: true, reason: 'SKIPPED_ARJUM_BUSY', universe: 0, target_date: (options && options.targetDate) || todayWib() };
  }
  return outcome;
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
    fetched: 0,
    cached: 0,
    stale: 0,
    failed: 0,
    stale_after_fetch: 0,
    quota_stop: false,
    yahoo_fetched: 0,
    cross_check_failed: false,
    cross_check: null
  };

  const candleSource = options.source || process.env.CANDLE_SOURCE || 'yahoo';
  const crossCheckEnabled = options.crossCheck !== false && process.env.CANDLE_CROSSCHECK !== 'false';

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
        console.warn(`[CROSS-CHECK-FAILED] ${check.failed}/${check.total} sample diffs > 0.5%. Falling back to Arjum for all tickers today.`);
      } else {
        console.log(`[CROSS-CHECK-OK] ${check.passed}/${check.total} samples matched <= 0.5%.`);
      }
    } catch (err) {
      summary.cross_check_failed = true;
      summary.cross_check = { error: err && err.message };
      console.warn(`[CROSS-CHECK-ERROR] ${err && err.message}. Falling back to Arjum for all tickers today.`);
    }
  }

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

    let res;
    let usedYahoo = false;

    if (ticker === 'IHSG') {
      // IHSG is ALWAYS fetched from Arjum canonical benchmark
      res = await fetcher.fetchDailyCandles(ticker, {
        limit: Number(process.env.CANDLE_LIMIT) || 500,
        force: true
      });
    } else if (candleSource === 'yahoo' && !summary.cross_check_failed) {
      res = await fetcher.fetchDailyCandlesYahoo(ticker, { range: '5d', retries: 2 });
      usedYahoo = Boolean(res && res.ok);
      if (!res.ok) {
        // Fallback to Arjum for this ticker
        console.warn(`[CANDLE-FALLBACK] Yahoo failed for ${ticker} (${res.error}), falling back to Arjum.`);
        res = await fetcher.fetchDailyCandles(ticker, {
          limit: Number(process.env.CANDLE_LIMIT) || 500,
          force: true
        });
      }
    } else {
      // Direct Arjum fetch
      res = await fetcher.fetchDailyCandles(ticker, {
        limit: Number(process.env.CANDLE_LIMIT) || 500,
        force: true
      });
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

'use strict';

/**
 * Daily candle close & volume fetch (EOD retry window from 18:00 WIB).
 * Uses lib/chart-engine/candle-fetcher.js against the Arjum history endpoint.
 * Idempotent by trade date: tickers whose latest cached daily candle already
 * matches the current WIB trade date are skipped; stale tickers are refreshed.
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
const { isValidIdxTicker } = require('../lib/idx-ticker');

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
  try {
    if (fs.existsSync(master)) {
      return Array.from(new Set(
        fs.readFileSync(master, 'utf8').split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(isValidIdxTicker)
      )).sort();
    }
  } catch (_) {}

  const idx = path.join(process.cwd(), 'data', 'arjum-data', 'broker-summary');
  try {
    const dirs = fs.readdirSync(idx, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).filter(isValidIdxTicker);
    if (dirs.length) return dirs.sort();
  } catch (_) {}
  return [];
}

function todayWib() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
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

async function main() {
  loadEnvFile();
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
  const tickers = loadTickers();
  const universe = limitArg > 0 ? tickers.slice(0, limitArg) : tickers;

  const targetDate = todayWib();
  const summary = { universe: universe.length, target_date: targetDate, fetched: 0, cached: 0, stale: 0, failed: 0, quota_stop: false };

  for (const ticker of universe) {
    const latest = latestCachedDate(ticker);
    if (latest === targetDate) {
      summary.cached++;
      continue;
    }

    summary.stale++;
    if (dryRun) continue;

    const res = await fetcher.fetchDailyCandles(ticker, {
      limit: Number(process.env.CANDLE_LIMIT) || 500,
      force: true
    });
    if (res.ok) summary.fetched++;
    else if (res.rateLimited) { summary.quota_stop = true; break; }
    else summary.failed++;
    if (summary.fetched % 50 === 0 && summary.fetched > 0) console.log('fetched=' + summary.fetched + ' last=' + ticker);
  }

  console.log(JSON.stringify({ mode: dryRun ? 'DRY_RUN' : 'LIVE', used_today: fetcher.getUsedQuotaToday(), quota: fetcher.getConfiguredDailyQuota(), ...summary }, null, 2));
}

main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });

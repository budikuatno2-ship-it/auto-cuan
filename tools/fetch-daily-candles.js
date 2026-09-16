'use strict';

/**
 * Daily candle close & volume fetch (cron 19:30 WIB).
 * Uses lib/chart-engine/candle-fetcher.js against the Arjum history endpoint.
 * Idempotent: cached tickers are skipped.
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
  // Use the full universe index if present; otherwise derive from broker-summary dirs.
  const idx = path.join(process.cwd(), 'data', 'arjum-data', 'broker-summary');
  try {
    const dirs = fs.readdirSync(idx, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (dirs.length) return dirs.sort();
  } catch (_) {}
  return [];
}

async function main() {
  loadEnvFile();
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
  const tickers = loadTickers();
  const universe = limitArg > 0 ? tickers.slice(0, limitArg) : tickers;

  const summary = { universe: universe.length, fetched: 0, cached: 0, failed: 0, quota_stop: false };

  for (const ticker of universe) {
    if (dryRun) { summary.cached++; continue; }
    const res = await fetcher.fetchDailyCandles(ticker, { limit: Number(process.env.CANDLE_LIMIT) || 200 });
    if (res.ok && res.from_cache) summary.cached++;
    else if (res.ok) summary.fetched++;
    else if (res.rateLimited) { summary.quota_stop = true; break; }
    else summary.failed++;
    if (summary.fetched % 50 === 0 && summary.fetched > 0) console.log('fetched=' + summary.fetched + ' last=' + ticker);
  }

  console.log(JSON.stringify({ mode: dryRun ? 'DRY_RUN' : 'LIVE', used_today: fetcher.getUsedQuotaToday(), quota: fetcher.getConfiguredDailyQuota(), ...summary }, null, 2));
}

main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });

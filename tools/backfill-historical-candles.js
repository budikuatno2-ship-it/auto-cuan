'use strict';

/**
 * Historical candle backfill (cron 00:05 WIB, quota-safe).
 * Fills daily candles for tickers missing cache, bounded by a max request budget.
 *
 * Usage (VPS):
 *   set -a; . ./.env.ai-eval-once; set +a
 *   node tools/backfill-historical-candles.js --max-requests=2500
 *   node tools/backfill-historical-candles.js --max-requests=2500 --dry-run
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
  // Resolve the broker-summary directory robustly regardless of cwd.
  // Strategy: find the repo root by looking for package.json starting from
  // the script's actual location (using require.main.filename as fallback for __dirname).
  function findRepoRoot(startDir) {
    let current = startDir;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(current, 'package.json'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = path.dirname(current);
    }
    return null;
  }

  // Get the script's actual directory, not the cwd.
  // require.main.filename gives the entry point script path.
  const scriptDir = path.dirname(require.main.filename || __filename);
  const repoRoot = findRepoRoot(scriptDir);
  if (!repoRoot) {
    // Fallback: try relative to __dirname (legacy behavior)
    const legacyIdx = path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary');
    if (fs.existsSync(legacyIdx)) return legacyIdx;
    return null;
  }

  const idx = path.join(repoRoot, 'data', 'arjum-data', 'broker-summary');
  if (!fs.existsSync(idx)) return null;
  return idx;
}

function loadTickers() {
  const idx = findBrokerSummaryDir();
  if (!idx) return [];
  try {
    return fs.readdirSync(idx, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(isValidIdxTicker)
      .sort();
  } catch (_) { return []; }
}

function findBrokerSummaryDir() {
  // Strategy: walk up from the script's actual directory to find repo root (package.json),
  // then resolve data/arjum-data/broker-summary from there.
  function findRepoRoot(startDir) {
    let current = startDir;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(current, 'package.json'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = path.dirname(current);
    }
    return null;
  }

  // Use require.main.filename to get the actual entry point script directory,
  // which is stable regardless of how the script is invoked.
  const scriptDir = path.dirname(require.main.filename || __filename);
  const repoRoot = findRepoRoot(scriptDir);
  if (!repoRoot) {
    // Fallback: try relative to __dirname (legacy behavior)
    const legacyIdx = path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary');
    if (fs.existsSync(legacyIdx)) return legacyIdx;
    return null;
  }

  const idx = path.join(repoRoot, 'data', 'arjum-data', 'broker-summary');
  if (!fs.existsSync(idx)) return null;
  return idx;
}

async function main() {
  loadEnvFile();
  const dryRun = process.argv.includes('--dry-run');
  const maxRequests = Number((process.argv.find(a => a.startsWith('--max-requests=')) || '').split('=')[1]) || 2500;
  const tickers = loadTickers();

  const summary = { universe: tickers.length, budget: maxRequests, requested: 0, fetched: 0, cached: 0, failed: 0, quota_stop: false };

  // Configurable candle depth: --limit=200 (default) and --force-refresh re-fetch
  // even when a short cache exists. The fetcher already treats caches with
  // <170 candles as a miss, so the history reaches back to January 2026.
  const candleLimit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 200;
  const forceRefresh = process.argv.includes('--force-refresh');

  for (const ticker of tickers) {
    const cache = fetcher.readCache(ticker);
    const cacheGood = cache && Array.isArray(cache.candles) && cache.candles.length >= Math.min(170, candleLimit);
    if (cacheGood && !forceRefresh) { summary.cached++; continue; }
    if (summary.requested >= maxRequests) break;
    if (dryRun) { summary.requested++; continue; }

    summary.requested++;
    const res = await fetcher.fetchDailyCandles(ticker, { limit: candleLimit, force: true, skipCache: false });
    if (res.ok) summary.fetched++;
    else if (res.rateLimited) { summary.quota_stop = true; break; }
    else summary.failed++;
    if (summary.fetched % 50 === 0 && summary.fetched > 0) console.log('fetched=' + summary.fetched + ' last=' + ticker);
  }

  console.log(JSON.stringify({ mode: dryRun ? 'DRY_RUN' : 'LIVE', used_today: fetcher.getUsedQuotaToday(), quota: fetcher.getConfiguredDailyQuota(), ...summary }, null, 2));
}

main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });

'use strict';

/**
 * Targeted September 2026 broker-summary backfill (VPS, quota-safe).
 *
 * Fills ONLY the missing ticker/date files for 2026-09-07..2026-09-15 by
 * calling the same arjumClient.fetchBrokerSummary path the daily worker uses,
 * writing through bandarmologiService.writeDiskCache so completion markers
 * and quota accounting stay consistent. Idempotent: existing files are skipped.
 *
 * Usage (on VPS, from repo root):
 *   set -a; . ./.env.ai-eval-once; set +a
 *   node tools/targeted-september-backfill.js --dry-run
 *   node tools/targeted-september-backfill.js --daily-limit 4000 --reserve 1100
 */

const fs = require('fs');
const path = require('path');
const { isValidIdxTicker } = require('../lib/idx-ticker');

const DATES = ['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-14','2026-09-15'];
const BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');

function loadEnvFile() {
  const candidates = ['.env.ai-eval-once', '.env.local', '.env'].map(n => path.join(__dirname, '..', n));
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

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : fallback;
}

function fileFor(ticker, date) {
  return path.join(BASE_DIR, 'broker-summary', ticker, date + '.json');
}

async function main() {
  loadEnvFile();
  const dryRun = process.argv.includes('--dry-run');
  const dailyLimit = Number(arg('daily-limit', process.env.ARJUM_DAILY_QUOTA || 5000));
  const reserve = Number(arg('reserve', process.env.ARJUM_EOD_RESERVE || 1100));
  const effective = Math.max(0, dailyLimit - reserve);
  const delayMs = Number(arg('delay', 260));

  const arjumClient = require('../lib/arjum-client');
  const bandarmologiService = require('../lib/bandarmologi-service');

  if (!arjumClient.hasArjumApiKey()) {
    console.error('ERROR: ARJUM_API_KEY tidak tersedia. Backfill dibatalkan.');
    process.exit(1);
  }

  console.log('=== TARGETED SEPTEMBER BACKFILL ===');
  console.log('Mode: ' + (dryRun ? 'DRY-RUN' : 'LIVE') + ' | Effective quota: ' + effective);

  const summary = { planned: 0, skipped: 0, fetched: 0, pending: 0, errors: 0, quota_stop: false, perDate: {} };

  for (const date of DATES) {
    summary.perDate[date] = { missing: 0, fetched: 0 };
    const dir = path.join(BASE_DIR, 'broker-summary');
    let tickers = [];
    try {
      tickers = fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).filter(isValidIdxTicker);
    } catch (_) { tickers = []; }

    for (const ticker of tickers) {
      if (fs.existsSync(fileFor(ticker, date))) { summary.skipped++; continue; }
      summary.planned++;
      summary.perDate[date].missing++;
      if (dryRun) continue;

      if (arjumClient.getUsedQuotaToday() >= effective) {
        summary.quota_stop = true;
        console.log('QUOTA STOP pada ' + date + ' ' + ticker);
        break;
      }
      try {
        const res = await Promise.race([
          arjumClient.fetchBrokerSummary(ticker, date),
          new Promise(resolve => setTimeout(() => resolve({ ok: false, status: 0, error: 'client_timeout' }), 20000))
        ]);
        if (res && res.ok && res.data) {
          // Persist whenever the provider returned usable data. Some historical
          // rows expose broker_levels/brokers instead of top_buyers/top_sellers,
          // so requiring normalized buy/sell rows would wrongly skip them.
          bandarmologiService.writeDiskCache('broker-summary', ticker, date, res.data);
          summary.fetched++;
          summary.perDate[date].fetched++;
          if (summary.fetched % 50 === 0) console.log('progress: fetched=' + summary.fetched + ' ' + date + ' ' + ticker);
        } else if (res && res.rateLimited) {
          summary.quota_stop = true;
          break;
        } else {
          summary.errors++;
        }
      } catch (_) {
        summary.errors++;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    if (summary.quota_stop) break;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });

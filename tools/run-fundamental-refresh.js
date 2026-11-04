#!/usr/bin/env node
'use strict';

/**
 * AUTO-CUAN - Fundamental Rolling Refresh & Completeness Guard (Fase 7)
 *
 * Checks data completeness by comparing the latest statement period
 * (e.g. requiring Q2 2026+) instead of merely checking file existence.
 * Refreshes batches of stale/incomplete emiten during evening Pilar 5 maintenance,
 * strictly respecting the Arjum daily quota and night reserve floor (300 requests).
 *
 * Usage:
 *   node tools/run-fundamental-refresh.js --dry-run
 *   node tools/run-fundamental-refresh.js --batch=20
 *   node tools/run-fundamental-refresh.js --ticker=BRPT,BBCA --apply
 */

const fs = require('fs');
const path = require('path');
const { parsePeriodScore } = require('../lib/financial-statements-import');
const importStatements = require('./import-financial-statements');
const wibHardStop = require('../lib/wib-hard-stop');

const ROOT = path.resolve(__dirname, '..');

/**
 * FASE 10C — Anti-bocor tengah malam.
 * Fundamental refresh berjalan 22:20 WIB; dengan batch 20 emiten x 6 request
 * prosesnya bisa melewati 23:50 bila upstream lambat. Guard ini memaksa
 * berhenti rapi sebelum reset kuota 00:00 WIB.
 *
 * @param {string} [label]
 * @returns {boolean} true bila pemanggil harus berhenti
 */
function checkWibHardStop(label) {
  const stop = wibHardStop.describeStop(label || 'fundamental-refresh');
  if (!stop) return false;
  console.log(`[fundamental-refresh] BERHENTI: HARD STOP 23:50 WIB tercapai (${stop.iso}). Kuota hari berikutnya dilindungi.`);
  return true;
}
const BASE_URL = 'https://stock.arjum.com';
const DEFAULT_FIN_DIR = path.join(ROOT, 'data', 'arjum-data', 'financial-statements');
const DEFAULT_MARKET_CAP_DIR = path.join(ROOT, 'data', 'arjum-data', 'market-cap');
const PROD_DB_PATH = '/home/ubuntu/auto-cuan-data/market.sqlite';

const REPORT_TYPES = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW_REPORT'];
const PERIODS = [
  { period: 'quarterly', limit: 8 },
  { period: 'annually', limit: 8 }
];

const TARGET_MIN_PERIOD = 'Q2 2026';
const TARGET_MIN_SCORE = parsePeriodScore(TARGET_MIN_PERIOD) || 20262;
const RESERVE_FLOOR = 300;
const MAX_FILE_AGE_DAYS = 14;

function loadApiKey() {
  if (process.env.ARJUM_API_KEY) return process.env.ARJUM_API_KEY.trim();
  const envCandidates = [
    '/home/ubuntu/auto-cuan-runner/.env',
    path.join(ROOT, '.env'),
    path.join(ROOT, '.env.local')
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(?:export\s+)?ARJUM_API_KEY\s*=\s*["']?([^"'\r\n]+)/);
        if (match && match[1]) return match[1].trim();
      }
    }
  }
  return '';
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    batch: 20,
    tickers: null,
    finDir: DEFAULT_FIN_DIR,
    marketCapDir: DEFAULT_MARKET_CAP_DIR,
    dbPath: fs.existsSync(PROD_DB_PATH) ? PROD_DB_PATH : null,
    // FASE 10 — reserve floor dapat di-override per jadwal:
    //   malam hari kerja : 300 (default)
    //   akhir pekan      : 50  (kuota menganggur, buffer kecil saja)
    floor: null
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') options.dryRun = true;
    else if (a === '--apply') options.dryRun = false;
    else if (a === '--floor' && args[i + 1] !== undefined) {
      const f = parseInt(args[++i], 10);
      if (Number.isFinite(f) && f >= 0) options.floor = f;
    }
    else if (a.startsWith('--floor=')) {
      const f = parseInt(a.slice(8), 10);
      if (Number.isFinite(f) && f >= 0) options.floor = f;
    }
    else if (a.startsWith('--batch=')) options.batch = Math.max(1, Number(a.split('=')[1]) || 20);
    else if (a === '--batch' && args[i + 1] !== undefined) options.batch = Math.max(1, Number(args[++i]) || 20);
    else if (a.startsWith('--ticker=')) options.tickers = a.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a.startsWith('--db-path=')) options.dbPath = path.resolve(a.split('=')[1]);
  }
  return options;
}

function inspectTickerCompleteness(finDir, ticker) {
  const tickerDir = path.join(finDir, ticker);
  if (!fs.existsSync(tickerDir)) {
    return { ticker, status: 'MISSING_DIR', needsRefresh: true, reason: 'directory_missing', latestPeriod: null, latestScore: 0 };
  }

  const qISPath = path.join(tickerDir, 'INCOME_STATEMENT-quarterly.json');
  if (!fs.existsSync(qISPath)) {
    return { ticker, status: 'MISSING_FILE', needsRefresh: true, reason: 'quarterly_income_missing', latestPeriod: null, latestScore: 0 };
  }

  try {
    const stat = fs.statSync(qISPath);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);

    const json = JSON.parse(fs.readFileSync(qISPath, 'utf8'));
    const items = (json.data && json.data.items) || json.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return { ticker, status: 'EMPTY_ITEMS', needsRefresh: true, reason: 'no_items_in_statement', latestPeriod: null, latestScore: 0 };
    }

    const latestItem = items[0];
    const latestPeriod = latestItem.label || (latestItem.year ? `Q${latestItem.quarter} ${latestItem.year}` : null);
    const latestScore = parsePeriodScore(latestPeriod) || 0;

    // Completeness guard: if below Q2 2026, it is incomplete and needs refresh!
    if (latestScore < TARGET_MIN_SCORE) {
      return { ticker, status: 'INCOMPLETE_PERIOD', needsRefresh: true, reason: `latest_${latestPeriod}_lt_${TARGET_MIN_PERIOD}`, latestPeriod, latestScore, ageDays };
    }

    // Age guard: if older than 14 days, rolling refresh
    if (ageDays > MAX_FILE_AGE_DAYS) {
      return { ticker, status: 'STALE_CACHE', needsRefresh: true, reason: `cache_age_${Math.round(ageDays)}d_gt_${MAX_FILE_AGE_DAYS}d`, latestPeriod, latestScore, ageDays };
    }

    return { ticker, status: 'FRESH', needsRefresh: false, reason: 'complete_and_fresh', latestPeriod, latestScore, ageDays };
  } catch (err) {
    return { ticker, status: 'CORRUPT_JSON', needsRefresh: true, reason: err.message, latestPeriod: null, latestScore: 0 };
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function fetchFromUpstream(apiKey, ticker, reportType, period, limit) {
  const qs = new URLSearchParams({
    report_type: reportType,
    period,
    limit: String(limit)
  });
  const url = `${BASE_URL}/api/financial-statements/${encodeURIComponent(ticker)}?${qs}`;
  const res = await fetch(url, {
    headers: {
      'X-API-Key': apiKey,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP_${res.status}: ${txt.slice(0, 100)}`);
  }
  return res.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('[fundamental-refresh] Starting fundamental completeness check and rolling refresh...');
  console.log(`[fundamental-refresh] Mode: ${options.dryRun ? 'DRY-RUN' : 'APPLY'}, Batch: ${options.batch}`);

  const apiKey = loadApiKey();
  if (!options.dryRun && !apiKey) {
    throw new Error('ARJUM_API_KEY tidak ditemukan di environment atau file .env');
  }

  let quotaTracker = null;
  let arjumClient = null;
  try {
    quotaTracker = require('../lib/arjum-quota-tracker');
    arjumClient = require('../lib/arjum-client');
  } catch (_) {}

  const reserveFloor = Number.isFinite(options.floor) && options.floor >= 0 ? options.floor : RESERVE_FLOOR;

  let remainingQuota = 99999;
  if (quotaTracker && arjumClient) {
    const configured = arjumClient.getConfiguredDailyQuota();
    const used = quotaTracker.getUsedToday();
    remainingQuota = quotaTracker.getRemainingToday(configured);
    console.log(`[fundamental-refresh] Quota: configured=${configured}, used=${used}, remaining=${remainingQuota}, floor=${reserveFloor}`);
    if (remainingQuota <= reserveFloor) {
      console.log(`[fundamental-refresh] Quota remaining (${remainingQuota}) <= reserve floor (${reserveFloor}). Skipping network calls.`);
      return;
    }
  }

  // Scan all tickers in financial directory
  let tickers = options.tickers;
  if (!tickers || tickers.length === 0) {
    if (fs.existsSync(options.finDir)) {
      tickers = fs.readdirSync(options.finDir).filter(d => {
        try {
          return fs.statSync(path.join(options.finDir, d)).isDirectory() && !d.startsWith('.');
        } catch (_) {
          return false;
        }
      }).sort();
    } else {
      tickers = [];
    }
  }

  console.log(`[fundamental-refresh] Auditing ${tickers.length} tickers for completeness vs ${TARGET_MIN_PERIOD}...`);
  const auditResults = tickers.map(t => inspectTickerCompleteness(options.finDir, t));
  const needRefresh = auditResults.filter(r => r.needsRefresh);

  // Sort by priority: incomplete periods first (oldest score first), then stales
  needRefresh.sort((a, b) => a.latestScore - b.latestScore);

  console.log(`[fundamental-refresh] Completeness summary: total=${tickers.length}, fresh=${tickers.length - needRefresh.length}, needsRefresh=${needRefresh.length}`);

  if (needRefresh.length > 0) {
    console.log('[fundamental-refresh] Sample tickers needing refresh:');
    needRefresh.slice(0, 10).forEach(r => {
      console.log(`  - ${r.ticker}: status=${r.status}, reason=${r.reason}, latest=${r.latestPeriod}`);
    });
  }

  if (options.dryRun) {
    console.log('[fundamental-refresh] Dry-run completed. No network calls or disk writes performed.');
    return;
  }

  // Select batch
  const maxAllowedBatch = Math.min(options.batch, Math.floor((remainingQuota - reserveFloor) / (REPORT_TYPES.length * PERIODS.length)));
  const batchToProcess = needRefresh.slice(0, Math.max(0, maxAllowedBatch));

  console.log(`[fundamental-refresh] Processing batch of ${batchToProcess.length} tickers (quota budget: ${batchToProcess.length * 6} req)...`);
  const updatedTickers = [];
  let hardStopped = false;

  // FASE 10C — lapis kedua: jangan mulai sama sekali bila sudah >= 23:50 WIB.
  if (checkWibHardStop('fundamental-refresh')) {
    console.log('[fundamental-refresh] Dijadwalkan ulang; tidak ada request jaringan yang dikirim.');
    return;
  }

  for (const item of batchToProcess) {
    if (hardStopped) break;
    if (checkWibHardStop('fundamental-refresh')) { hardStopped = true; break; }
    const { ticker } = item;
    console.log(`\n[fundamental-refresh] Refreshing ${ticker}...`);
    let tickerOk = true;

    for (const reportType of REPORT_TYPES) {
      for (const p of PERIODS) {
        if (checkWibHardStop('fundamental-refresh')) { hardStopped = true; break; }
        const file = path.join(options.finDir, ticker, `${reportType}-${p.period}.json`);
        try {
          const data = await fetchFromUpstream(apiKey, ticker, reportType, p.period, p.limit);
          const envelope = {
            ticker,
            report_type: reportType,
            period: p.period,
            requested_limit: p.limit,
            collected_at: new Date().toISOString(),
            data
          };
          writeJsonAtomic(file, envelope);
        } catch (err) {
          tickerOk = false;
          console.error(`  FAIL ${ticker} ${reportType} ${p.period}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (tickerOk) {
      updatedTickers.push(ticker);
      console.log(`  OK ${ticker} (6/6 files updated)`);
    }
  }

  // Apply SQLite sync if dbPath provided
  // P2: import-financial-statements.js mengekspor { main, parseArgs } (bukan fungsi langsung).
  if (updatedTickers.length > 0 && options.dbPath && fs.existsSync(options.dbPath)) {
    console.log(`\n[fundamental-refresh] Syncing ${updatedTickers.length} updated tickers to SQLite ${options.dbPath}...`);
    process.env.ALLOW_PROD_DB_WRITE = '1';
    await importStatements.main([
      '--ticker', updatedTickers.join(','),
      '--statements-dir', options.finDir,
      '--market-cap-dir', options.marketCapDir,
      '--db-path', options.dbPath,
      '--apply'
    ]);
  }

  console.log(`[fundamental-refresh] Done. Successfully refreshed ${updatedTickers.length} tickers.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[fundamental-refresh] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  inspectTickerCompleteness,
  checkWibHardStop,
  TARGET_MIN_PERIOD,
  TARGET_MIN_SCORE,
  RESERVE_FLOOR
};

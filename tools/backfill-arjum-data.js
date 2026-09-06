'use strict';

/**
 * Backfill Script for stock.arjum.com Data
 * Usage:
 *   node tools/backfill-arjum-data.js --tickers BBCA,BBRI,BMRI,TLKM,ASII
 *   node tools/backfill-arjum-data.js --all --limit 50
 *   node tools/backfill-arjum-data.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');

// Optional local/server .env or .env.local loader (without external dependencies)
try {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local')
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
} catch (_) {}

// Bursa Efek Indonesia trading calendar for August - September 2026 (weekdays, skip known holidays)
// 17 Agustus 2026 (HUT RI), etc.
function getTradingDates(startDateStr = '2026-08-03', endDateStr = '2026-09-04') {
  const dates = [];
  const current = new Date(startDateStr);
  const end = new Date(endDateStr);

  const holidays = new Set([
    '2026-08-17' // Hari Kemerdekaan RI
  ]);

  while (current <= end) {
    const day = current.getDay();
    const iso = current.toISOString().slice(0, 10);
    // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6 && !holidays.has(iso)) {
      dates.push(iso);
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Default top universe tickers
const TOP_TICKERS = [
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII', 'ICBP', 'INDF',
  'UNVR', 'KLBF', 'ADRO', 'PTBA', 'ITMG', 'ANTM', 'INCO', 'MDKA',
  'AMMN', 'BREN', 'TPIA', 'BRPT', 'PGAS', 'CPIN', 'JPFA', 'GOTO',
  'ACES', 'MYOR', 'SMGR', 'INTP', 'CTRA', 'BSDE', 'PWON', 'SMRA',
  'MEDC', 'AKRA', 'ESSA', 'AUTO', 'HEAL', 'MIKA', 'SILO', 'SIDO'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const isAll = args.includes('--all');

  let delayMs = 250;
  const delayIdx = args.indexOf('--delay');
  if (delayIdx >= 0 && args[delayIdx + 1]) {
    delayMs = parseInt(args[delayIdx + 1], 10) || 250;
  }

  let limit = Infinity;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10) || Infinity;
  }

  let dailyLimit = 5000;
  const dailyLimitIdx = args.indexOf('--daily-limit');
  if (dailyLimitIdx >= 0 && args[dailyLimitIdx + 1]) {
    dailyLimit = parseInt(args[dailyLimitIdx + 1], 10) || 5000;
  } else if (process.env.ARJUM_DAILY_LIMIT) {
    dailyLimit = parseInt(process.env.ARJUM_DAILY_LIMIT, 10) || 5000;
  }

  let tickers = TOP_TICKERS;
  const tickerArgIdx = args.indexOf('--tickers');
  if (tickerArgIdx >= 0 && args[tickerArgIdx + 1]) {
    tickers = args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  } else if (isAll) {
    try {
      const txtFile = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
      const jsonFile = path.join(__dirname, '..', 'data', 'bei_universe.json');
      if (fs.existsSync(txtFile)) {
        tickers = fs.readFileSync(txtFile, 'utf8').split(/\r?\n/).map(t => t.trim().toUpperCase()).filter(Boolean);
      } else if (fs.existsSync(jsonFile)) {
        tickers = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      }
    } catch (_) {}
  }

  if (isFinite(limit)) {
    tickers = tickers.slice(0, limit);
  }

  let startDate = '2026-08-03';
  let endDate = '2026-09-04';
  const startIdx = args.indexOf('--start-date');
  if (startIdx >= 0 && args[startIdx + 1]) startDate = args[startIdx + 1];
  const endIdx = args.indexOf('--end-date');
  if (endIdx >= 0 && args[endIdx + 1]) endDate = args[endIdx + 1];

  const tradingDates = getTradingDates(startDate, endDate);
  const hasDirectKey = arjumClient.hasArjumApiKey();

  console.log('=== AUTO-CUAN ARJUM BACKFILL WORKER ===');
  console.log(`ARJUM_API_KEY: [${hasDirectKey ? 'ADA' : 'TIDAK ADA'}]`);
  console.log(`Connection Source: Direct API (${arjumClient.ARJUM_BASE_URL})`);
  console.log(`Daily Request Limit: ${dailyLimit}`);
  console.log(`Total Tickers to process: ${tickers.length}`);
  console.log(`Trading Dates count: ${tradingDates.length} (${tradingDates[0]} s/d ${tradingDates[tradingDates.length - 1]})`);
  console.log(`Delay per request: ${delayMs}ms | Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log('----------------------------------------------------');

  if (!hasDirectKey && !dryRun) {
    console.error('ERROR: ARJUM_API_KEY tidak ditemukan di environment atau .env.');
    console.error('Direct API access membutuhkan ARJUM_API_KEY yang valid.');
    process.exit(1);
  }

  let totalRequested = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let quotaReached = false;
  let stopReason = ''; // 'daily_limit' | 'api_quota_exceeded'

  // A single 429/quota response from Arjum means the account's real quota is
  // gone for the day — further requests just fail the same way and waste
  // time. Stop immediately instead of grinding through every remaining
  // ticker/date racking up errors.
  function checkApiQuota(res) {
    if (res.ok) return false;
    const classified = arjumClient.classifyFailure(res);
    if (classified.reason === 'quota_exceeded') {
      quotaReached = true;
      stopReason = 'api_quota_exceeded';
      console.log(`\n[BERHENTI: KUOTA API HABIS] Arjum menolak request dengan status kuota (${classified.detail || 'quota exceeded'}). Worker berhenti rapi, tidak retry.`);
      return true;
    }
    return false;
  }

  for (let i = 0; i < tickers.length; i++) {
    if (quotaReached) break;
    const ticker = tickers[i];
    console.log(`\n[${i + 1}/${tickers.length}] Memproses ${ticker}...`);

    // 1. Broker Accumulation (1 call per ticker)
    const accCached = typeof bandarmologiService.hasDiskCache === 'function'
      ? bandarmologiService.hasDiskCache('broker-accumulation', ticker, 'series')
      : bandarmologiService.readDiskCache('broker-accumulation', ticker, 'series');
    if (accCached) {
      totalSkipped++;
    } else if (dryRun) {
      totalRequested++;
    } else {
      if (totalRequested >= dailyLimit) {
        console.log(`\n[BERHENTI: BATAS HARIAN] Batas limit harian tercapai (${dailyLimit} request). Worker berhenti.`);
        quotaReached = true;
        stopReason = 'daily_limit';
        break;
      }
      totalRequested++;
      const res = await arjumClient.fetchBrokerAccumulation(ticker);
      if (res.ok && res.data) {
        bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', res.data);
        totalSaved++;
      } else {
        totalErrors++;
        if (checkApiQuota(res)) break;
      }
      await sleep(delayMs);
    }

    // 2. Insiders (1 call per ticker)
    if (quotaReached) break;
    const insCached = typeof bandarmologiService.hasDiskCache === 'function'
      ? bandarmologiService.hasDiskCache('insiders', ticker, 'p1')
      : bandarmologiService.readDiskCache('insiders', ticker, 'p1');
    if (insCached) {
      totalSkipped++;
    } else if (dryRun) {
      totalRequested++;
    } else {
      if (totalRequested >= dailyLimit) {
        console.log(`\n[BERHENTI: BATAS HARIAN] Batas limit harian tercapai (${dailyLimit} request). Worker berhenti.`);
        quotaReached = true;
        stopReason = 'daily_limit';
        break;
      }
      totalRequested++;
      const res = await arjumClient.fetchInsiders(ticker, 1, 15);
      if (res.ok && res.data) {
        bandarmologiService.writeDiskCache('insiders', ticker, 'p1', res.data);
        totalSaved++;
      } else {
        totalErrors++;
        if (checkApiQuota(res)) break;
      }
      await sleep(delayMs);
    }

    // 3. Broker Summary (per trading date)
    for (const date of tradingDates) {
      if (quotaReached) break;
      const sumCached = typeof bandarmologiService.hasDiskCache === 'function'
        ? bandarmologiService.hasDiskCache('broker-summary', ticker, date)
        : bandarmologiService.readDiskCache('broker-summary', ticker, date);
      if (sumCached) {
        totalSkipped++;
      } else if (dryRun) {
        totalRequested++;
      } else {
        if (totalRequested >= dailyLimit) {
          console.log(`\n[BERHENTI: BATAS HARIAN] Batas limit harian tercapai (${dailyLimit} request). Worker berhenti.`);
          quotaReached = true;
          stopReason = 'daily_limit';
          break;
        }
        totalRequested++;
        const res = await arjumClient.fetchBrokerSummary(ticker, date);
        if (res.ok && res.data) {
          bandarmologiService.writeDiskCache('broker-summary', ticker, date, res.data);
          if (date === tradingDates[tradingDates.length - 1]) {
            bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', res.data);
          }
          totalSaved++;
        } else {
          totalErrors++;
          if (checkApiQuota(res)) break;
        }
        await sleep(delayMs);
      }
    }
  }

  const stopReasonLabel = {
    daily_limit: 'BERHENTI: BATAS HARIAN TERCAPAI (--daily-limit)',
    api_quota_exceeded: 'BERHENTI: KUOTA API ARJUM HABIS (bukan --daily-limit)',
    '': 'SELESAI LENGKAP'
  };
  console.log('\n----------------------------------------------------');
  console.log('=== RINGKASAN HASIL BACKFILL ===');
  console.log(`Status Berhenti:               ${stopReasonLabel[stopReason] || stopReasonLabel['']}`);
  console.log(`Batas Request Harian:          ${dailyLimit}`);
  console.log(`Total Permintaan Terkirim:     ${totalRequested}`);
  console.log(`Total File Tersimpan Baru:     ${totalSaved}`);
  console.log(`Total Terlewati (Sudah Ada):   ${totalSkipped}`);
  console.log(`Total Error / Gagal:           ${totalErrors}`);
  console.log('Proses worker selesai.');

  // Distinct exit code for "quota exhausted" so a wrapping cron/scheduler can
  // tell it apart from a clean finish or a real crash, without parsing logs.
  if (stopReason === 'api_quota_exceeded') process.exitCode = 2;
}

run().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});

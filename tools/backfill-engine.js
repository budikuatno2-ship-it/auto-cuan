'use strict';

/**
 * Historical Backfill Engine for stock.arjum.com Data
 *
 * Supports range backfill:
 *   node tools/backfill-engine.js --from 2026-01-01 --to 2026-05-31
 *   node tools/backfill-engine.js --from 2026-01-01 --to 2026-05-31 --tickers BBCA,BBRI
 *   node tools/backfill-engine.js --from 2026-01-01 --to 2026-05-31 --limit 50 --fresh
 */

const fs = require('fs');
const path = require('path');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');

// Optional local/server .env or .env.local loader
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

// Indonesian Stock Exchange (BEI / IDX) Holiday calendar for 2026
const IDX_HOLIDAYS_2026 = new Set([
  '2026-01-01', // Tahun Baru Masehi
  '2026-01-16', // Isra Miraj Nabi Muhammad SAW
  '2026-02-17', // Tahun Baru Imlek 2577 Kongzili
  '2026-03-20', // Hari Suci Nyepi Tahun Baru Saka 1948
  '2026-03-21', // Hari Raya Idul Fitri 1447 H
  '2026-03-23', // Cuti Bersama Idul Fitri
  '2026-03-24', // Cuti Bersama Idul Fitri
  '2026-04-03', // Wafat Yesus Kristus
  '2026-05-01', // Hari Buruh Internasional
  '2026-05-14', // Kenaikan Yesus Kristus
  '2026-05-25', // Hari Raya Idul Adha 1447 H
  '2026-05-31', // Hari Raya Waisak 2570 BE
  '2026-06-01', // Hari Lahir Pancasila
  '2026-06-16', // Tahun Baru Islam 1448 H
  '2026-08-17', // Hari Kemerdekaan RI
  '2026-08-25', // Maulid Nabi Muhammad SAW
  '2026-12-25'  // Hari Raya Natal
]);

function getTradingDates(startDateStr = '2026-01-01', endDateStr = '2026-05-31') {
  const dates = [];
  const current = new Date(startDateStr);
  const end = new Date(endDateStr);

  while (current <= end) {
    const day = current.getDay();
    const iso = current.toISOString().slice(0, 10);
    // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6 && !IDX_HOLIDAYS_2026.has(iso)) {
      dates.push(iso);
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

const DEFAULT_PRIORITY_TICKERS = [
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII', 'ICBP', 'INDF',
  'UNVR', 'KLBF', 'ADRO', 'PTBA', 'ITMG', 'ANTM', 'INCO', 'MDKA',
  'AMMN', 'BREN', 'TPIA', 'BRPT', 'PGAS', 'CPIN', 'JPFA', 'GOTO',
  'ACES', 'MYOR', 'SMGR', 'INTP', 'CTRA', 'BSDE', 'PWON', 'SMRA',
  'MEDC', 'AKRA', 'ESSA', 'AUTO', 'HEAL', 'MIKA', 'SILO', 'SIDO',
  'BUMI', 'DEWA', 'BRMS', 'DOID', 'ENRG', 'ELSA', 'HRUM', 'INDY'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getStorageDir() {
  if (typeof bandarmologiService.getStorageDir === 'function') {
    return bandarmologiService.getStorageDir();
  }
  const configured = process.env.ARJUM_DATA_DIR;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(__dirname, '..', 'data', 'arjum-data');
}

function isValidCachedJson(endpoint, ticker, identifier) {
  try {
    const baseDir = getStorageDir();
    const filePath = path.join(baseDir, endpoint, ticker, `${identifier}.json`);
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat || stat.size <= 2) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object';
  } catch (_) {
    return false;
  }
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const isFresh = args.includes('--fresh');

  // Parse --from and --to (with fallback to --start-date and --end-date)
  let fromDate = '2026-01-01';
  const fromIdx = args.indexOf('--from');
  const startIdx = args.indexOf('--start-date');
  if (fromIdx >= 0 && args[fromIdx + 1]) fromDate = args[fromIdx + 1];
  else if (startIdx >= 0 && args[startIdx + 1]) fromDate = args[startIdx + 1];

  let toDate = '2026-05-31';
  const toIdx = args.indexOf('--to');
  const endIdx = args.indexOf('--end-date');
  if (toIdx >= 0 && args[toIdx + 1]) toDate = args[toIdx + 1];
  else if (endIdx >= 0 && args[endIdx + 1]) toDate = args[endIdx + 1];

  let delayMs = 800;
  const delayIdx = args.indexOf('--delay');
  if (delayIdx >= 0 && args[delayIdx + 1]) {
    delayMs = parseInt(args[delayIdx + 1], 10) || 800;
    if (!dryRun && delayMs < 600) {
      console.warn(`[THROTTLING] Delay ${delayMs}ms terlalu cepat. Dinaikkan otomatis ke batas aman 600ms.`);
      delayMs = 600;
    }
  }

  let limit = Infinity;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10) || Infinity;
  }

  let dailyQuota = arjumClient.getConfiguredDailyQuota();
  let eodReserve = parseInt(process.env.ARJUM_EOD_RESERVE, 10);
  if (!Number.isFinite(eodReserve) || eodReserve < 0) eodReserve = 5000;

  // Max usage limit for backfill engine: accounts for EOD reserve
  let dailyLimit = Math.max(0, dailyQuota - eodReserve);
  const dailyLimitIdx = args.indexOf('--daily-limit');
  if (dailyLimitIdx >= 0 && args[dailyLimitIdx + 1]) {
    dailyLimit = parseInt(args[dailyLimitIdx + 1], 10) || dailyLimit;
  } else if (process.env.ARJUM_DAILY_LIMIT) {
    dailyLimit = parseInt(process.env.ARJUM_DAILY_LIMIT, 10) || dailyLimit;
  }

  // Tickers selection
  let tickers = [];
  const tickerArgIdx = args.indexOf('--tickers');
  if (tickerArgIdx >= 0 && args[tickerArgIdx + 1]) {
    tickers = args[tickerArgIdx + 1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  } else {
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

  if (!tickers || tickers.length === 0) {
    tickers = DEFAULT_PRIORITY_TICKERS;
  }

  if (isFinite(limit)) {
    tickers = tickers.slice(0, limit);
  }

  let tradingDates = getTradingDates(fromDate, toDate);
  const hasDirectKey = arjumClient.hasArjumApiKey();

  // Guard jam bursa: data EOD hari ini hanya boleh diproses jika sudah >= 16:15 WIB
  if (typeof arjumClient.getJakartaTime === 'function') {
    const { dateKey: todayKey, hour: nowHour, minute: nowMinute } = arjumClient.getJakartaTime();
    const isEodPassed = nowHour > 16 || (nowHour === 16 && nowMinute >= 15);
    if (tradingDates.includes(todayKey) && !isEodPassed && !dryRun) {
      console.warn(`[GUARD JAM BURSA] Tanggal hari ini (${todayKey}) belum melewati 16:15 WIB (rilis data resmi bursa). Hari ini dilewati.`);
      tradingDates = tradingDates.filter(d => d !== todayKey);
    }
  }

  console.log('=== AUTO-CUAN HISTORICAL BACKFILL ENGINE ===');
  console.log(`Periode: ${fromDate} s/d ${toDate}`);
  console.log(`Trading Dates count: ${tradingDates.length} hari bursa`);
  console.log(`Total Tickers to process: ${tickers.length}`);
  console.log(`ARJUM_API_KEY: [${hasDirectKey ? 'ADA' : 'TIDAK ADA'}]`);
  console.log(`Total Account Quota: ${dailyQuota} | EOD Reserve (18:00 WIB): ${eodReserve}`);
  console.log(`Max Backfill Budget: ${dailyLimit} | Used Quota Today: ${arjumClient.getUsedQuotaToday()}`);
  console.log(`Delay per request: ${delayMs}ms | Mode: ${dryRun ? 'DRY-RUN' : (isFresh ? 'LIVE (FRESH OVERWRITE)' : 'LIVE (SMART-SKIP)')}`);
  console.log('----------------------------------------------------');

  if (!hasDirectKey && !dryRun) {
    console.error('ERROR: ARJUM_API_KEY tidak ditemukan di environment atau .env.');
    process.exit(1);
  }

  let totalRequested = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let quotaReached = false;

  function checkApiQuota(res) {
    if (!res) return false;
    if (res.ok) return false;
    const classified = arjumClient.classifyFailure(res);
    if (classified.reason === 'quota_exceeded') {
      quotaReached = true;
      console.log(`\n[BERHENTI: KUOTA API HABIS] Status: ${classified.detail || 'quota exceeded'}. Backfill dihentikan.`);
      return true;
    }
    return false;
  }

  for (let i = 0; i < tickers.length; i++) {
    const circuitTripped = typeof arjumClient.isCircuitBreakerTripped === 'function' && arjumClient.isCircuitBreakerTripped();
    if (circuitTripped || quotaReached || arjumClient.getUsedQuotaToday() >= dailyLimit) {
      console.log(`\n[CIRCUIT BREAKER / QUOTA LIMIT] Batas kuota tercapai atau circuit breaker aktif. Engine berhenti.`);
      break;
    }

    const ticker = tickers[i];
    console.log(`\n[${i + 1}/${tickers.length}] Memproses ${ticker} (${tradingDates.length} hari bursa)...`);

    // 1. Check & Fetch Broker Accumulation (series) if missing
    if (!dryRun) {
      const accCached = !isFresh && isValidCachedJson('broker-accumulation', ticker, 'series');
      if (!accCached) {
        if (arjumClient.getUsedQuotaToday() >= dailyLimit) break;
        totalRequested++;
        const accRes = await arjumClient.fetchBrokerAccumulation(ticker);
        if (accRes.ok && accRes.data) {
          bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', accRes.data);
          totalSaved++;
        } else if (checkApiQuota(accRes)) {
          break;
        } else {
          totalErrors++;
        }
        await sleep(delayMs);
      } else {
        totalSkipped++;
      }
    }

    // 2. Check & Fetch Insiders (p1) if missing
    if (!dryRun) {
      const insCached = !isFresh && isValidCachedJson('insiders', ticker, 'p1');
      if (!insCached) {
        if (arjumClient.getUsedQuotaToday() >= dailyLimit) break;
        totalRequested++;
        const insRes = await arjumClient.fetchInsiders(ticker, 1, 15);
        if (insRes.ok && insRes.data) {
          bandarmologiService.writeDiskCache('insiders', ticker, 'p1', insRes.data);
          totalSaved++;
        } else if (checkApiQuota(insRes)) {
          break;
        } else {
          totalErrors++;
        }
        await sleep(delayMs);
      } else {
        totalSkipped++;
      }
    }

    // 3. Loop over trading dates for Broker Summary
    for (let di = 0; di < tradingDates.length; di++) {
      const circuitTripped = typeof arjumClient.isCircuitBreakerTripped === 'function' && arjumClient.isCircuitBreakerTripped();
      if (circuitTripped || quotaReached || arjumClient.getUsedQuotaToday() >= dailyLimit) break;

      const dateStr = tradingDates[di];
      const sumCached = !isFresh && isValidCachedJson('broker-summary', ticker, dateStr);

      if (sumCached) {
        totalSkipped++;
        continue;
      }

      if (dryRun) {
        totalRequested++;
        continue;
      }

      totalRequested++;
      const sumRes = await arjumClient.fetchBrokerSummary(ticker, dateStr);
      if (sumRes.ok && sumRes.data) {
        bandarmologiService.writeDiskCache('broker-summary', ticker, dateStr, sumRes.data);
        totalSaved++;
      } else if (checkApiQuota(sumRes)) {
        break;
      } else {
        totalErrors++;
      }

      await sleep(delayMs);
    }
  }

  console.log('\n----------------------------------------------------');
  console.log('=== RINGKASAN HISTORICAL BACKFILL ENGINE ===');
  console.log(`Total Permintaan Terkirim : ${totalRequested}`);
  console.log(`Total Disimpan Baru       : ${totalSaved}`);
  console.log(`Total Dilewati (Cached)   : ${totalSkipped}`);
  console.log(`Total Error / Gagal       : ${totalErrors}`);
  console.log(`Kuota Terpakai Hari Ini   : ${arjumClient.getUsedQuotaToday()} / ${dailyLimit}`);
  console.log('Status: Selesai.');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal Error backfill engine:', err);
    process.exit(1);
  });
}

module.exports = {
  run,
  getTradingDates,
  IDX_HOLIDAYS_2026
};

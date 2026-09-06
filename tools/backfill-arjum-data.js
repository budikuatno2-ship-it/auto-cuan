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

  console.log('=== AUTO-CUAN ARJUM BACKFILL WORKER ===');
  console.log(`ARJUM_API_KEY: [${arjumClient.hasArjumApiKey() ? 'ADA' : 'TIDAK ADA'}]`);
  console.log(`Base URL: ${arjumClient.ARJUM_BASE_URL}`);
  console.log(`Total Tickers to process: ${tickers.length}`);
  console.log(`Trading Dates count: ${tradingDates.length} (${tradingDates[0]} s/d ${tradingDates[tradingDates.length - 1]})`);
  console.log(`Delay per request: ${delayMs}ms | Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log('----------------------------------------------------');

  if (!arjumClient.hasArjumApiKey() && !dryRun) {
    console.warn('⚠️ PERINGATAN: process.env.ARJUM_API_KEY belum terdeteksi di runtime.');
    console.warn('  Worker akan mensimulasikan proses atau menyimpan demo cache.');
    console.warn('  Pastikan ARJUM_API_KEY di-export di environment sebelum run produksi.');
  }

  let totalRequested = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    console.log(`\n[${i + 1}/${tickers.length}] Memproses ${ticker}...`);

    // 1. Broker Accumulation (1 call per ticker)
    const accCached = bandarmologiService.readDiskCache('broker-accumulation', ticker, 'series');
    if (accCached) {
      totalSkipped++;
    } else if (dryRun) {
      totalRequested++;
    } else {
      totalRequested++;
      const res = await arjumClient.fetchBrokerAccumulation(ticker);
      if (res.ok && res.data) {
        bandarmologiService.writeDiskCache('broker-accumulation', ticker, 'series', res.data);
        totalSaved++;
      } else {
        totalErrors++;
      }
      await sleep(delayMs);
    }

    // 2. Insiders (1 call per ticker)
    const insCached = bandarmologiService.readDiskCache('insiders', ticker, 'p1');
    if (insCached) {
      totalSkipped++;
    } else if (dryRun) {
      totalRequested++;
    } else {
      totalRequested++;
      const res = await arjumClient.fetchInsiders(ticker, 1, 15);
      if (res.ok && res.data) {
        bandarmologiService.writeDiskCache('insiders', ticker, 'p1', res.data);
        totalSaved++;
      } else {
        totalErrors++;
      }
      await sleep(delayMs);
    }

    // 3. Broker Summary (per trading date)
    for (const date of tradingDates) {
      const sumCached = bandarmologiService.readDiskCache('broker-summary', ticker, date);
      if (sumCached) {
        totalSkipped++;
      } else if (dryRun) {
        totalRequested++;
      } else {
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
        }
        await sleep(delayMs);
      }
    }
  }

  console.log('\n----------------------------------------------------');
  console.log('=== RINGKASAN HASIL BACKFILL ===');
  console.log(`Total Permintaan Direncanakan: ${totalRequested}`);
  console.log(`Total File Tersimpan Baru:     ${totalSaved}`);
  console.log(`Total Terlewati (Sudah Ada):   ${totalSkipped}`);
  console.log(`Total Error / Gagal:           ${totalErrors}`);
  console.log('Proses selesai.');
}

run().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});

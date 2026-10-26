'use strict';

/**
 * Runner Refill Riwayat Tertua (Done Details LPM)
 * ===============================================
 * 1. Menghitung daftar 29 hari bursa dari 8 Sep s.d. 16 Okt 2026.
 * 2. Menjalankan dry-run untuk seluruh 29 hari bursa bagi emiten di priority.txt.
 * 3. Menjalankan pengisian data riil HANYA untuk hari bursa tertua (8 Sep, lalu 9 Sep, dst.)
 *    dalam batas 50% sisa kuota hari ini dan berhenti jika remaining < 1.500.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { estimatePages } = require('./collect-done');

const BASE_DIR = __dirname;
const PRIORITY_FILE = path.join(BASE_DIR, 'priority.txt');

// 29 trading days
const TRADING_DAYS = [
  '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25',
  '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'
];

function getPriorityTickers() {
  return fs.readFileSync(PRIORITY_FILE, 'utf8')
    .split('\n')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0 && !s.startsWith('#'));
}

function runDryRunAllDays(tickers) {
  console.log('====================================================');
  console.log('DRY-RUN ESTIMATION ACROSS ALL 29 TRADING DAYS');
  console.log('====================================================\n');

  let totalAllDaysReq = 0;
  const dayBreakdown = [];

  for (const day of TRADING_DAYS) {
    let dayReq = 0;
    const tickerEst = [];
    for (const tk of tickers) {
      const est = estimatePages(tk, day);
      dayReq += est.estPages;
      tickerEst.push({ ticker: tk, estPages: est.estPages });
    }
    totalAllDaysReq += dayReq;
    dayBreakdown.push({ date: day, totalEstRequests: dayReq, tickerEst });
  }

  console.log(`Universe Size: ${tickers.length} tickers (${tickers.join(', ')})`);
  console.log(`Total Trading Days: ${TRADING_DAYS.length} days (${TRADING_DAYS[0]} s.d. ${TRADING_DAYS[TRADING_DAYS.length - 1]})`);
  console.log(`Total Estimated Requests (All Days): ${totalAllDaysReq.toLocaleString()} requests`);
  console.log(`Estimated Total Download Time (at 2 req/s): ~${Math.round(totalAllDaysReq * 0.65 / 60)} minutes (~${(totalAllDaysReq * 0.65 / 3600).toFixed(1)} hours)\n`);

  fs.writeFileSync(path.join(BASE_DIR, 'dry_run_refill_29days.json'), JSON.stringify({
    totalTradingDays: TRADING_DAYS.length,
    tickers,
    totalAllDaysReq,
    dayBreakdown
  }, null, 2));

  return { totalAllDaysReq, dayBreakdown };
}

function runLiveOldestDays(tickers, maxBudget) {
  console.log('====================================================');
  console.log('LIVE COLLECTION OF OLDEST TRADING DAYS');
  console.log(`MAX RUN BUDGET: ${maxBudget} requests`);
  console.log('====================================================\n');

  let remainingBudget = maxBudget;
  const collectedDays = [];

  for (const day of TRADING_DAYS) {
    if (remainingBudget <= 10) {
      console.log(`\n[BUDGET REACHED] Sisa anggaran run ${remainingBudget} req. Selesai untuk sesi hari ini.`);
      break;
    }

    console.log(`\n>>> Processing Date: ${day} (Available Budget: ${remainingBudget})...`);
    // Run collect-done.js for this day
    const cmd = `node collect-done.js --date ${day} --codes ${tickers.join(',')} --budget ${remainingBudget}`;
    try {
      const out = execSync(cmd, { cwd: BASE_DIR, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      console.log(out);

      // Extract requests used from output
      const m = out.match(/Total Requests Used in Run:\s+(\d+)/);
      const used = m ? parseInt(m[1], 10) : 0;
      remainingBudget -= used;

      const remMatch = out.match(/Final Remaining Quota:\s+(\d+)/);
      const curRemaining = remMatch ? parseInt(remMatch[1], 10) : null;

      collectedDays.push({ date: day, requestsUsed: used, quotaRemaining: curRemaining });

      if (curRemaining && curRemaining < 1500) {
        console.warn(`[SAFETY TRIGGER] Quota remaining ${curRemaining} < 1500. Menghentikan proses pengisian.`);
        break;
      }
    } catch (err) {
      console.error(`Error processing date ${day}:`, err.message);
      break;
    }
  }

  console.log('\n--- REFILL RUN SUMMARY ---');
  console.log(JSON.stringify(collectedDays, null, 2));
  fs.writeFileSync(path.join(BASE_DIR, 'live_refill_summary.json'), JSON.stringify(collectedDays, null, 2));
}

function main() {
  const tickers = getPriorityTickers();
  const { totalAllDaysReq } = runDryRunAllDays(tickers);

  // Read current remaining from previous probe (~4.186)
  // Safe budget 50% = ~2.000 requests max, but let us run for the oldest days with safe budget 500 requests
  // so we definitely keep quota abundant (> 3.500) while filling 8 Sep and 9 Sep!
  const runBudget = 600;
  runLiveOldestDays(tickers, runBudget);
}

main();

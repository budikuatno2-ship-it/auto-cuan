#!/usr/bin/env node
'use strict';

/**
 * PRE-KOMPUTASI BROKSUM DOMESTIK & AKUMULASI BROKER ROLLING DI DISK (FASE 5)
 * =========================================================================
 * 0 KUOTA UPSTREAM (Murni komputasi lokal dari arsip yang ada di disk).
 * Idempoten (aman dijalankan berulang).
 *
 * Menghasilkan:
 * 1. Arsip Domestik: data/arjum-data/broker-summary-D/<TICKER>/<YYYY-MM-DD>.json (bila ALL & F lengkap).
 * 2. Data Rolling: data/broker-accumulation/<TICKER>.json (termasuk history date-addressable untuk Fase 6).
 * 3. Indeks Broker Hunter: data/broker-hunter-indexes/ (latest_1d.json, latest_3d.json, latest_1w.json, latest_1m.json).
 *
 * Penggunaan:
 *   node tools/build-domestic-broksum-and-accum.js                          # dry-run
 *   node tools/build-domestic-broksum-and-accum.js --apply                  # simpan semua emiten
 *   node tools/build-domestic-broksum-and-accum.js --apply --tickers=BBCA,BMRI,CUAN
 *   node tools/build-domestic-broksum-and-accum.js --apply --limit=30
 */

const fs = require('node:fs');
const path = require('node:path');
const accumLocal = require('../lib/broker-accumulation-local');
const brokerHunterService = require('../lib/broker-hunter-service');

const ROOT = path.resolve(__dirname, '..');
const BASE_DATA = fs.existsSync('/home/ubuntu/auto-cuan/data')
  ? '/home/ubuntu/auto-cuan/data'
  : path.join(ROOT, 'data');

const ARJUM_DATA_DIR = path.join(BASE_DATA, 'arjum-data');
const ALL_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary');
const F_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary-F');
const D_DIR = path.join(ARJUM_DATA_DIR, 'broker-summary-D');
const ACCUM_DIR = path.join(BASE_DATA, 'broker-accumulation');
const HUNTER_INDEX_DIR = path.join(BASE_DATA, 'broker-hunter-indexes');

function parseArgs(argv) {
  const options = {
    apply: false,
    force: false,
    quiet: false,
    limit: null,
    tickers: null,
    skipHunter: false,
    skipDomestic: false,
    allBrokerHunter: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--skip-hunter') options.skipHunter = true;
    else if (arg === '--skip-domestic') options.skipDomestic = true;
    else if (arg === '--all-broker-hunter') options.allBrokerHunter = true;
    else if (arg.startsWith('--limit=')) options.limit = Math.max(1, Number(arg.split('=')[1]) || 0);
    else if (arg.startsWith('--tickers=')) {
      options.tickers = arg.split('=')[1].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    }
  }

  return options;
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function run() {
  const options = parseArgs(process.argv);
  const startTime = Date.now();

  console.log('================================================================');
  console.log(' FASE 5 — BUILD DOMESTIC BROKSUM & ROLLING ACCUMULATION');
  console.log('================================================================');
  console.log('Mode:', options.apply ? 'APPLY (Menulis ke disk)' : 'DRY-RUN (Simulasi saja)');
  console.log('Base Data Dir:', BASE_DATA);
  console.log('Arsip ALL:', ALL_DIR);
  console.log('Arsip F:', F_DIR);
  console.log('Target D:', D_DIR);
  console.log('Target Accumulation:', ACCUM_DIR);
  console.log('Target Broker Hunter:', HUNTER_INDEX_DIR);
  console.log('0 Kuota Upstream: DIJAMIN (Hanya membaca file disk lokal)');
  console.log('----------------------------------------------------------------');

  if (!fs.existsSync(ALL_DIR)) {
    console.error('ERROR: Folder arsip ALL tidak ditemukan di', ALL_DIR);
    process.exit(1);
  }

  let tickers = fs.readdirSync(ALL_DIR).filter(d => {
    try {
      return fs.statSync(path.join(ALL_DIR, d)).isDirectory() && /^[A-Z0-9.-]{2,10}$/.test(d);
    } catch {
      return false;
    }
  }).sort();

  if (options.tickers && options.tickers.length > 0) {
    const selected = new Set(options.tickers);
    tickers = tickers.filter(t => selected.has(t));
  }

  if (options.limit && options.limit > 0) {
    tickers = tickers.slice(0, options.limit);
  }

  console.log(`Memproses ${tickers.length} emiten...`);

  const stats = {
    total_tickers: tickers.length,
    processed_tickers: 0,
    skipped_tickers: 0,
    domestic_files_written: 0,
    domestic_files_skipped_existing: 0,
    domestic_foreign_not_released: 0,
    accum_files_written: 0,
    total_dates_processed: 0,
    hunter_indexes_generated: 0
  };

  for (let idx = 0; idx < tickers.length; idx++) {
    const ticker = tickers[idx];
    const tickerAllDir = path.join(ALL_DIR, ticker);
    const tickerFDir = path.join(F_DIR, ticker);
    const tickerDDir = path.join(D_DIR, ticker);

    const allDateFiles = fs.readdirSync(tickerAllDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();

    if (allDateFiles.length === 0) {
      stats.skipped_tickers++;
      continue;
    }

    const rawAllDays = [];
    const rawFDays = [];

    for (const file of allDateFiles) {
      const date = file.slice(0, 10);
      const allJson = safeReadJson(path.join(tickerAllDir, file));
      if (!allJson) continue;

      rawAllDays.push({ date, broksum: allJson });

      const fJson = safeReadJson(path.join(tickerFDir, file));
      if (fJson) {
        rawFDays.push({ date, broksum: fJson });
      }

      // Domestic daily synthesis and write
      if (!options.skipDomestic) {
        const destDFile = path.join(tickerDDir, file);
        const existsD = fs.existsSync(destDFile);

        if (existsD && !options.force) {
          stats.domestic_files_skipped_existing++;
        } else if (fJson) {
          const domResult = accumLocal.computeDomesticBroksum(allJson, fJson, date, ticker);
          if (domResult.status === 'RELEASED') {
            if (options.apply) {
              safeWriteJson(destDFile, domResult);
            }
            stats.domestic_files_written++;
          } else {
            stats.domestic_foreign_not_released++;
          }
        } else {
          stats.domestic_foreign_not_released++;
        }
      }

      stats.total_dates_processed++;
    }

    // Compute rolling accumulation (1H, 3H, 5H, 10H, 20H) + full date history
    const rollingData = accumLocal.computeFullRollingAccumulation(ticker, rawAllDays, rawFDays);

    if (options.apply) {
      const accumOut = path.join(ACCUM_DIR, `${ticker}.json`);
      safeWriteJson(accumOut, rollingData);
      stats.accum_files_written++;
    }

    stats.processed_tickers++;

    if (!options.quiet && (idx + 1) % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${idx + 1}/${tickers.length}] Ticker ${ticker} selesai (${elapsed}s)`);
    }
  }

  // Generate Broker Hunter summary indexes (latest_1d, latest_3d, latest_1w, latest_1m)
  if (!options.skipHunter && options.apply) {
    console.log('Menghasilkan Broker Hunter Indexes...');
    fs.mkdirSync(HUNTER_INDEX_DIR, { recursive: true });

    // Generate latest_<range>.json index summaries directly from accumulation
    const hunterWindows = [
      { range: '1d', days: 1, out: 'latest_1d.json' },
      { range: '3d', days: 3, out: 'latest_3d.json' },
      { range: '1w', days: 5, out: 'latest_1w.json' },
      { range: '1m', days: 20, out: 'latest_1m.json' }
    ];

    for (const hw of hunterWindows) {
      const indexSummary = {
        range: hw.range,
        days: hw.days,
        generated_at: new Date().toISOString(),
        total_tickers: tickers.length,
        items: []
      };

      for (const ticker of tickers) {
        const accumFile = path.join(ACCUM_DIR, `${ticker}.json`);
        const acc = safeReadJson(accumFile);
        if (!acc || !acc.latest || !acc.latest.windows) continue;

        const winKey = hw.days === 1 ? '1H' : (hw.days === 3 ? '3H' : (hw.days === 5 ? '5H' : '20H'));
        const win = acc.latest.windows[winKey];
        if (!win || !win.all) continue;

        indexSummary.items.push({
          ticker,
          net_lot_all: win.all.net_lot,
          net_val_all: win.all.net_val,
          bs_ratio_3_all: win.all.bs_ratio_3,
          arah_all: win.all.arah,
          top_buyers_all: win.all.top_buyers.slice(0, 3).map(b => b.broker_code),
          net_val_foreign: win.foreign ? win.foreign.net_val : 0,
          net_val_domestic: win.domestic ? win.domestic.net_val : 0,
          bandar_vwap: acc.latest.bandar_vwap
        });
      }

      // Sort items by net_val_all descending
      indexSummary.items.sort((a, b) => b.net_val_all - a.net_val_all);

      const outIndexFile = path.join(HUNTER_INDEX_DIR, hw.out);
      safeWriteJson(outIndexFile, indexSummary);
      stats.hunter_indexes_generated++;
      console.log(`Index tersimpan: ${hw.out} (${indexSummary.items.length} saham)`);
    }

    if (options.allBrokerHunter) {
      try {
        console.log('Generating per-broker hunter indexes...');
        const hunterRes = await brokerHunterService.generateBrokerHunterIndex({
          ranges: ['1d', '7d', '30d'],
          forceOverwriteGit: true,
          updateGitCatalog: true
        });
        stats.hunter_indexes_generated += (hunterRes.files_written || 0);
      } catch (hunterErr) {
        console.warn('Peringatan: Indexing per-broker hunter:', hunterErr.message);
      }
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('----------------------------------------------------------------');
  console.log(' RINGKASAN HASIL BUILD:');
  console.log(` - Total Ticker Diproses : ${stats.processed_tickers} / ${stats.total_tickers}`);
  console.log(` - Sesi Harian Dihitung  : ${stats.total_dates_processed}`);
  console.log(` - File Domestik Ditulis : ${stats.domestic_files_written}`);
  console.log(` - File Domestik Sudah Ada: ${stats.domestic_files_skipped_existing}`);
  console.log(` - Data Asing Belum Rilis : ${stats.domestic_foreign_not_released}`);
  console.log(` - File Akumulasi Ditulis: ${stats.accum_files_written}`);
  console.log(` - Indeks Hunter Dibuat  : ${stats.hunter_indexes_generated}`);
  console.log(` - Waktu Eksekusi Total  : ${durationSec} detik`);
  console.log(` - Kuota Upstream Digunakan: 0 request (100% lokal)`);
  console.log('================================================================');

  return stats;
}

if (require.main === module) {
  run().catch(err => {
    console.error('FATAL BUILD ERROR:', err);
    process.exit(1);
  });
}

module.exports = {
  run,
  parseArgs
};

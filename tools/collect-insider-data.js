#!/usr/bin/env node
'use strict';

/**
 * Collect Insider Data Across Full IHSG Universe (Zero Artificial Slicing)
 *
 * Scans all ~957 emitens from daytrade-observe-tickers.txt and disk caches.
 * Uses controlled concurrency (5-10 workers) with delays to pull authentic
 * insider transactions via Arjum API or VPS on-demand cache.
 *
 * Aggregates and deduplicates all insider records into:
 *   - data/insider-network/insiders-db.json
 *   - data/insider-network/universe.json
 *
 * Usage:
 *   node tools/collect-insider-data.js
 *   node tools/collect-insider-data.js --concurrency 8 --delay 50
 *   node tools/collect-insider-data.js --tickers BBCA,BBRI,BMRI,BREN,BRPT,TPIA,GPRA
 *   node tools/collect-insider-data.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const vpsFetcher = require('../lib/vps-data-fetcher');

// Load environment variables if available (.env / .env.local)
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

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tickers: null,
    concurrency: 8,
    delayMs: 60,
    dryRun: false,
    forceApi: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force-api') {
      options.forceApi = true;
    } else if (arg === '--concurrency' && args[i + 1]) {
      const c = parseInt(args[++i], 10);
      if (Number.isFinite(c) && c > 0) options.concurrency = Math.min(20, Math.max(1, c));
    } else if (arg === '--delay' && args[i + 1]) {
      const d = parseInt(args[++i], 10);
      if (Number.isFinite(d) && d >= 0) options.delayMs = d;
    } else if (arg === '--tickers' && args[i + 1]) {
      options.tickers = args[++i].split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    }
  }

  return options;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadUniverseTickers() {
  const tickerSet = new Set();

  // 1. Observe tickers file (957 IDX emitens)
  const txtPath = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
  if (fs.existsSync(txtPath)) {
    fs.readFileSync(txtPath, 'utf8')
      .split(/\r?\n/)
      .map(t => t.trim().toUpperCase())
      .filter(t => Boolean(t) && /^[A-Z0-9.-]{2,10}$/.test(t))
      .forEach(t => tickerSet.add(t));
  }

  // 2. Local broker-summary directory
  const sumDir = path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary');
  if (fs.existsSync(sumDir)) {
    fs.readdirSync(sumDir)
      .filter(f => /^[A-Z0-9.-]+$/.test(f))
      .forEach(t => tickerSet.add(t));
  }

  // 3. Local insiders directory
  const insDir = path.join(__dirname, '..', 'data', 'arjum-data', 'insiders');
  if (fs.existsSync(insDir)) {
    fs.readdirSync(insDir)
      .filter(f => /^[A-Z0-9.-]+$/.test(f))
      .forEach(t => tickerSet.add(t));
  }

  return Array.from(tickerSet).sort();
}

function getLocalInsiderFile(ticker) {
  const filePath = path.join(__dirname, '..', 'data', 'arjum-data', 'insiders', ticker, 'p1.json');
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {}
  }
  return null;
}

function saveLocalInsiderFile(ticker, data) {
  const dirPath = path.join(__dirname, '..', 'data', 'arjum-data', 'insiders', ticker);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(path.join(dirPath, 'p1.json'), JSON.stringify(data, null, 2), 'utf8');
}

function deduplicateKey(item) {
  const ticker = String(item.ticker || '').toUpperCase();
  const date = String(item.date || '').trim();
  const name = String(item.insider_name || item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const action = String(item.action_type || 'BUY').toUpperCase();
  const shares = item.shares_change != null ? item.shares_change : (item.shares || 0);
  const price = item.price || 0;
  return `${ticker}|${date}|${name}|${action}|${shares}|${price}`;
}

async function runInsiderCollector() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log('====================================================');
  console.log('  AUTO-CUAN: FULL UNIVERSE INSIDER DATA COLLECTOR   ');
  console.log('====================================================');
  console.log(`Concurrency:    ${opts.concurrency} concurrent workers`);
  console.log(`Delay per call: ${opts.delayMs} ms`);
  console.log(`Dry Run:        ${opts.dryRun ? 'YA (Tidak menyimpan)' : 'TIDAK'}`);

  const allTickers = opts.tickers && opts.tickers.length > 0
    ? opts.tickers
    : loadUniverseTickers();

  console.log(`Total Universe: ${allTickers.length} emiten\n`);

  let processedCount = 0;
  let fromLocalCount = 0;
  let fromVpsCount = 0;
  let fromApiCount = 0;
  let emptyCount = 0;
  let errorCount = 0;

  const collectedRecords = [];

  // Concurrency worker queue
  async function processTicker(ticker) {
    let rawData = null;

    // 1. Check local cache
    rawData = getLocalInsiderFile(ticker);
    if (rawData) {
      fromLocalCount++;
    }

    // 2. Check VPS on-demand cache if not local
    if (!rawData && !opts.forceApi && vpsFetcher.hasSshKey()) {
      try {
        rawData = vpsFetcher.fetchInsidersFromVpsSync(ticker);
        if (rawData) {
          fromVpsCount++;
        }
      } catch (_) {}
    }

    // 3. Fallback to Arjum direct API
    if (!rawData && arjumClient.hasArjumApiKey()) {
      try {
        const apiRes = await arjumClient.fetchInsiders(ticker, 1, 15);
        if (apiRes && apiRes.ok && apiRes.data) {
          rawData = apiRes.data;
          fromApiCount++;
          if (!opts.dryRun) {
            saveLocalInsiderFile(ticker, rawData);
          }
        }
      } catch (_) {
        errorCount++;
      }
    }

    if (opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }

    if (!rawData) {
      emptyCount++;
      return;
    }

    // Normalize records and attach ticker
    const normalized = bandarmologiService.normalizeInsiders(rawData);
    if (Array.isArray(normalized) && normalized.length > 0) {
      for (const item of normalized) {
        if (item && (item.insider_name || item.name) && item.insider_name !== '—') {
          collectedRecords.push(Object.assign({}, item, { ticker }));
        }
      }
    } else {
      emptyCount++;
    }
  }

  // Execute in batches based on concurrency
  for (let i = 0; i < allTickers.length; i += opts.concurrency) {
    const chunk = allTickers.slice(i, i + opts.concurrency);
    await Promise.all(chunk.map(t => processTicker(t)));
    processedCount += chunk.length;

    if (processedCount % 50 === 0 || processedCount === allTickers.length) {
      const pct = ((processedCount / allTickers.length) * 100).toFixed(1);
      process.stdout.write(`\rProgress: ${processedCount}/${allTickers.length} emiten (${pct}%) | Transaksi terkumpul: ${collectedRecords.length}`);
    }
  }

  console.log('\n\n--- MENGGABUNGKAN DAN MENYIMPAN DATABASE INSIDER ---');

  // Load existing database to merge without losing historical records
  const dbDir = path.join(__dirname, '..', 'data', 'insider-network');
  const dbPath = path.join(dbDir, 'insiders-db.json');
  const universePath = path.join(dbDir, 'universe.json');

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const existingMap = new Map();

  if (fs.existsSync(dbPath)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (Array.isArray(existingData)) {
        for (const item of existingData) {
          const key = deduplicateKey(item);
          existingMap.set(key, item);
        }
      }
    } catch (_) {}
  }

  // Merge newly collected records
  for (const item of collectedRecords) {
    const key = deduplicateKey(item);
    existingMap.set(key, item);
  }

  const finalRecords = Array.from(existingMap.values());

  // Sort by date descending, then ticker
  finalRecords.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db.localeCompare(da);
    return (a.ticker || '').localeCompare(b.ticker || '');
  });

  const uniqueEmitens = new Set(finalRecords.map(r => r.ticker)).size;
  const uniqueInsiders = new Set(finalRecords.map(r => (r.insider_name || r.name || '').trim().toLowerCase())).size;

  if (!opts.dryRun) {
    fs.writeFileSync(dbPath, JSON.stringify(finalRecords, null, 2), 'utf8');
    fs.writeFileSync(universePath, JSON.stringify(finalRecords, null, 2), 'utf8');
    console.log(`[SUCCESS] Database disimpan ke: ${dbPath}`);
    console.log(`[SUCCESS] Backup universe disimpan ke: ${universePath}`);
  } else {
    console.log('[DRY-RUN] Melewati penulisan berkas ke disk.');
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n====================================================');
  console.log('               RINGKASAN KOLEKSI DATA               ');
  console.log('====================================================');
  console.log(`Waktu Eksekusi:         ${elapsedSec} detik`);
  console.log(`Total Emiten Diproses:  ${processedCount}`);
  console.log(`Dari Cache Lokal:       ${fromLocalCount}`);
  console.log(`Dari VPS On-Demand:     ${fromVpsCount}`);
  console.log(`Dari Arjum API:         ${fromApiCount}`);
  console.log(`Emiten Tanpa Data:      ${emptyCount}`);
  console.log(`Total Transaksi di DB:  ${finalRecords.length}`);
  console.log(`Total Emiten Tercatat:  ${uniqueEmitens}`);
  console.log(`Total Tokoh/Entitas:    ${uniqueInsiders}`);
  console.log('====================================================\n');

  return {
    totalRecords: finalRecords.length,
    uniqueEmitens,
    uniqueInsiders
  };
}

if (require.main === module) {
  runInsiderCollector().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}

module.exports = {
  runInsiderCollector,
  loadUniverseTickers
};

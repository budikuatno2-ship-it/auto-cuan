#!/usr/bin/env node
'use strict';

/**
 * CLI Tool to import financial statements and market cap data into SQLite stock_fundamentals.
 *
 * Usage:
 *   node tools/import-financial-statements.js --dry-run
 *   node tools/import-financial-statements.js --apply
 *   node tools/import-financial-statements.js --ticker BBCA --apply
 *   node tools/import-financial-statements.js --statements-dir <dir> --market-cap-dir <dir> --db-path <path> --apply
 *
 * Idempotent:
 *   - Preserves all existing free_float_* and hsc_* fields in stock_fundamentals.
 *   - Safely updates equity, shares_outstanding, market_cap, book_value_per_share, fundamental_period, financial_statements.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  loadMarketCapData,
  parseTickerStatements,
  buildMergedFundamentalRecord
} = require('../lib/financial-statements-import');
const marketStore = require('../lib/vps-market-store');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATEMENTS_DIR = path.join(ROOT, 'data', 'arjum-data', 'financial-statements');
const DEFAULT_MARKET_CAP_DIR = path.join(ROOT, 'data', 'arjum-data', 'market-cap');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    apply: args.includes('--apply'),
    dryRun: args.includes('--dry-run') || !args.includes('--apply'),
    statementsDir: DEFAULT_STATEMENTS_DIR,
    marketCapDir: DEFAULT_MARKET_CAP_DIR,
    dbPath: process.env.AUTO_CUAN_MARKET_DB || null,
    tickers: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--statements-dir' && args[i + 1]) {
      options.statementsDir = path.resolve(args[++i]);
    } else if (args[i] === '--market-cap-dir' && args[i + 1]) {
      options.marketCapDir = path.resolve(args[++i]);
    } else if (args[i] === '--db-path' && args[i + 1]) {
      options.dbPath = path.resolve(args[++i]);
    } else if (args[i] === '--ticker' && args[i + 1]) {
      options.tickers = args[++i].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();
  console.log('[import-financial-statements] Mode:', options.apply ? 'APPLY' : 'DRY_RUN (Validation Only)');
  console.log('[import-financial-statements] Statements directory:', options.statementsDir);
  console.log('[import-financial-statements] Market cap directory:', options.marketCapDir);

  const hasStatements = fs.existsSync(options.statementsDir);
  const hasMarketCap = fs.existsSync(options.marketCapDir);

  if (!hasStatements && !hasMarketCap) {
    console.warn('[import-financial-statements] Ketergantungan data sumber belum tersedia di path lokal:');
    console.warn('  - statementsDir:', options.statementsDir);
    console.warn('  - marketCapDir:', options.marketCapDir);
    console.warn('[import-financial-statements] Pada runtime produksi VPS, data tersedia di /home/ubuntu/auto-cuan/data/arjum-data/');
    return;
  }

  // 1. Load Market Cap Data
  console.log('[import-financial-statements] Membaca data market cap...');
  const marketCapMap = loadMarketCapData(options.marketCapDir);
  console.log('[import-financial-statements] Loaded market cap for ' + marketCapMap.size + ' tickers.');

  // 2. Discover tickers
  let targetTickers = options.tickers;
  if (!targetTickers) {
    if (hasStatements) {
      targetTickers = fs.readdirSync(options.statementsDir)
        .filter((name) => !name.startsWith('.') && fs.statSync(path.join(options.statementsDir, name)).isDirectory());
    } else {
      targetTickers = Array.from(marketCapMap.keys());
    }
  }

  console.log('[import-financial-statements] Target emiten: ' + targetTickers.length);

  // 3. Connect to SQLite store if apply
  let store = null;
  if (options.apply) {
    store = marketStore.getVpsMarketStore(options.dbPath);
  }

  let countProcessed = 0;
  let countWithStatements = 0;
  let countWithMarketCap = 0;
  let countWithBvps = 0;
  const updates = [];

  for (const ticker of targetTickers) {
    const tickerDir = hasStatements ? path.join(options.statementsDir, ticker) : null;
    const parsedStatements = tickerDir ? parseTickerStatements(tickerDir, ticker) : null;
    const marketCapInfo = marketCapMap.get(ticker) || null;

    let existingRecord = null;
    if (store) {
      const existingRows = store.queryRows('stock_fundamentals', {
        filters: [{ field: 'ticker', op: 'eq', value: ticker }]
      });
      existingRecord = existingRows && existingRows[0] ? existingRows[0] : null;
    }

    const merged = buildMergedFundamentalRecord({
      ticker,
      existingRecord,
      parsedStatements,
      marketCapInfo
    });

    if (parsedStatements) countWithStatements++;
    if (marketCapInfo && marketCapInfo.market_cap != null) countWithMarketCap++;
    if (merged.book_value_per_share != null) countWithBvps++;

    updates.push(merged);
    countProcessed++;
  }

  console.log('[import-financial-statements] Ringkasan Validasi:');
  console.log('  - Total emiten diproses: ' + countProcessed);
  console.log('  - Dengan laporan keuangan rinci: ' + countWithStatements);
  console.log('  - Dengan market cap / shares: ' + countWithMarketCap);
  console.log('  - BVPS berhasil dihitung: ' + countWithBvps);

  if (!options.apply) {
    console.log('[import-financial-statements] Dry run selesai. Tidak ada data yang ditulis ke database.');
    return;
  }

  // 4. Batch upsert into stock_fundamentals
  console.log('[import-financial-statements] Menulis ' + updates.length + ' baris ke SQLite stock_fundamentals...');
  const keyFields = ['ticker'];
  store.transaction(() => {
    for (const record of updates) {
      store.writeRow('stock_fundamentals', record, keyFields, true);
    }
  });

  console.log('[import-financial-statements] Selesai. Seluruh data berhasil di-upsert secara idempoten.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[import-financial-statements] Error:', err);
    process.exit(1);
  });
}

module.exports = { main };

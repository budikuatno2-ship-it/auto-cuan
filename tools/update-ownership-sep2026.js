#!/usr/bin/env node
'use strict';

/**
 * Update Ownership & Free Float Data per 30 September 2026
 *
 * Idempotently updates market_rows (table_name = 'stock_fundamentals' and
 * 'stock_daily_features') with official IDX/KSEI 30 September 2026 ownership data:
 * - free_float_pct = item.freeFloat
 * - free_float_source = 'idx-stocks-ownership'
 * - free_float_as_of = '2026-09-30'
 * - name = item.name
 * - company_name = 'PT ' + cleanName + ' Tbk'
 * - sector = item.sector
 * - investor_count = item.investorCount
 *
 * Also creates indexed roster cache data/insider-network/roster_30sep2026.json
 * for sub-20ms API response time.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_PATH = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
const DEFAULT_DB_PATH = process.env.AUTO_CUAN_MARKET_DB || '/home/ubuntu/auto-cuan-data/market.sqlite';

function parseArgs() {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB_PATH;
  let dataPath = DEFAULT_DATA_PATH;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') {
      apply = true;
    } else if (args[i] === '--db-path' && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === '--data-path' && args[i + 1]) {
      dataPath = args[++i];
    }
  }

  return { apply, dbPath, dataPath };
}

const KNOWN_ACRONYMS = new Set(['BCA', 'BRI', 'BNI', 'BSI', 'BTN', 'CIMB', 'DBS', 'OCBC', 'UOB', 'BTPN', 'MNC', 'SCMA', 'ICBP', 'INDF', 'ASII', 'TLKM', 'BBCA', 'BBRI', 'BMRI', 'TASPEN', 'BPJS', 'IDX', 'BEI', 'KSEI', 'KPEI']);

function normalizeCompanyName(rawName, ticker) {
  if (!rawName) return 'PT ' + ticker + ' Tbk';
  let str = String(rawName).trim();
  str = str.replace(/^PT\.?\s+/i, '').replace(/\.$/, '').trim();
  str = str.replace(/\bTbk\b/i, '').trim();

  // Convert to Title Case for readability while preserving acronyms
  const words = str.split(/\s+/).map((word) => {
    const upper = word.toUpperCase();
    if (KNOWN_ACRONYMS.has(upper)) return upper;
    if (word.length <= 1) return upper;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  return 'PT ' + words.join(' ') + ' Tbk';
}

function ensureGeneratedColumn(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info('market_rows')").all();
    const hasCol = tableInfo.some((col) => col.name === 'free_float_as_of');
    if (!hasCol) {
      db.exec("ALTER TABLE market_rows ADD COLUMN free_float_as_of TEXT GENERATED ALWAYS AS (json_extract(row_json, '$.free_float_as_of')) VIRTUAL;");
      console.log('[update-ownership] Kolom virtual free_float_as_of berhasil ditambahkan ke market_rows.');
    }
  } catch (err) {
    if (!/duplicate column name/i.test(err && err.message || '')) {
      console.warn('[update-ownership] Warning saat memastikan kolom generated:', err.message);
    }
  }
}

function main() {
  const { apply, dbPath, dataPath } = parseArgs();

  console.log('[update-ownership] Mode:', apply ? 'APPLY' : 'DRY RUN');
  console.log('[update-ownership] Data path:', dataPath);
  console.log('[update-ownership] DB path:', dbPath);

  if (!fs.existsSync(dataPath)) {
    throw new Error('Dataset 30 September tidak ditemukan: ' + dataPath);
  }

  const rawJson = fs.readFileSync(dataPath, 'utf8');
  const items = JSON.parse(rawJson);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Dataset 30 September kosong atau tidak valid.');
  }

  console.log(`[update-ownership] Membaca ${items.length} emiten dari dataset.`);

  // Build fast roster map and write indexed roster file
  const rosterMap = {};
  for (const item of items) {
    const ticker = String(item.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    rosterMap[ticker] = (item.investors || []).map((inv, idx) => ({
      no: idx + 1,
      ticker: ticker,
      name: inv.investorName,
      investorName: inv.investorName,
      investor_name: inv.investorName,
      type: inv.investorType,
      investorType: inv.investorType,
      investor_type: inv.investorType,
      category: inv.investorType || 'Pemegang Saham',
      position: inv.investorType || 'Pemegang Saham',
      origin: inv.localForeign,
      localForeign: inv.localForeign,
      local_foreign: inv.localForeign,
      domicile: inv.domicile,
      shares: inv.totalHoldingShare,
      totalHoldingShare: inv.totalHoldingShare,
      total_holding_shares: inv.totalHoldingShare,
      percentage: inv.percentage,
      percentage_formatted: inv.percentage != null ? inv.percentage.toFixed(2) + '%' : '—',
      hasPrevData: inv.hasPrevData,
      has_prev_data: inv.hasPrevData,
      change: inv.change != null ? inv.change : 0,
      last_change: (inv.change != null && inv.change !== 0) ? (inv.change > 0 ? '+' : '') + inv.change + '%' : '0%',
      nationality: inv.localForeign === 'F' ? 'foreign' : 'local'
    }));
  }

  const indexedRosterPath = path.join(ROOT, 'data', 'insider-network', 'roster_30sep2026.json');
  try {
    fs.writeFileSync(indexedRosterPath, JSON.stringify({
      updated_at: '2026-09-30T00:00:00.000Z',
      as_of: '2026-09-30',
      total_tickers: Object.keys(rosterMap).length,
      tickers: rosterMap
    }, null, 2), 'utf8');
    console.log(`[update-ownership] Berkas terindeks disimpan: ${indexedRosterPath} (${Object.keys(rosterMap).length} emiten).`);
  } catch (err) {
    console.warn('[update-ownership] Gagal menulis roster_30sep2026.json:', err.message);
  }

  if (!fs.existsSync(dbPath)) {
    console.log('[update-ownership] Database tidak ditemukan di', dbPath, '- melewatkan update SQLite.');
    return;
  }

  // Safety guard for production database
  const isProdDb = dbPath.includes('auto-cuan-data') || dbPath.includes('market.sqlite');
  if (isProdDb && apply && process.env.ALLOW_PROD_DB_WRITE !== '1') {
    throw new Error('ALLOW_PROD_DB_WRITE=1 wajib disetel untuk menulis ke database pasar produksi!');
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');

  ensureGeneratedColumn(db);

  if (!apply) {
    console.log('[update-ownership] DRY RUN selesai. Gunakan --apply untuk menerapkan ke database.');
    return;
  }

  const now = new Date().toISOString();
  const selectStmt = db.prepare("SELECT row_json FROM market_rows WHERE table_name = 'stock_fundamentals' AND row_key = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO market_rows(table_name, row_key, row_json, updated_at) VALUES('stock_fundamentals', ?, ?, ?) " +
    "ON CONFLICT(table_name, row_key) DO UPDATE SET row_json = excluded.row_json, updated_at = excluded.updated_at"
  );

  let updatedCount = 0;
  let insertedCount = 0;

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    for (const item of items) {
      const ticker = String(item.ticker || '').trim().toUpperCase();
      if (!ticker) continue;

      const existing = selectStmt.get(ticker);
      let row = {};
      if (existing && existing.row_json) {
        try { row = JSON.parse(existing.row_json); } catch (_) { row = {}; }
        updatedCount++;
      } else {
        insertedCount++;
      }

      const formattedName = normalizeCompanyName(item.name, ticker);

      row.ticker = ticker;
      row.name = item.name || formattedName;
      row.company_name = formattedName;
      row.sector = item.sector || row.sector || null;
      row.free_float_pct = Number(item.freeFloat);
      row.free_float_source = 'idx-stocks-ownership';
      row.free_float_as_of = '2026-09-30';
      row.investor_count = Number(item.investorCount) || (item.investors ? item.investors.length : 0);
      row.float = item.float != null ? Number(item.float) : null;
      row.updated_at = now;

      upsertStmt.run(ticker, JSON.stringify(row), now);
    }

    db.exec('COMMIT;');
    console.log(`[update-ownership] Berhasil memproses ${items.length} emiten (Updated: ${updatedCount}, Inserted: ${insertedCount}).`);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  // Also sync stock_daily_features if table exists
  try {
    const featSelect = db.prepare("SELECT row_json FROM market_rows WHERE table_name = 'stock_daily_features' AND row_key = ?");
    const featUpdate = db.prepare("UPDATE market_rows SET row_json = ?, updated_at = ? WHERE table_name = 'stock_daily_features' AND row_key = ?");
    let featUpdated = 0;

    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    for (const item of items) {
      const ticker = String(item.ticker || '').trim().toUpperCase();
      const existing = featSelect.get(ticker);
      if (existing && existing.row_json) {
        try {
          const row = JSON.parse(existing.row_json);
          row.free_float_pct = Number(item.freeFloat);
          row.free_float_source = 'idx-stocks-ownership';
          row.free_float_as_of = '2026-09-30';
          row.name = item.name;
          row.company_name = normalizeCompanyName(item.name, ticker);
          row.sector = item.sector;
          row.investor_count = Number(item.investorCount);
          featUpdate.run(JSON.stringify(row), now, ticker);
          featUpdated++;
        } catch (_) {}
      }
    }
    db.exec('COMMIT;');
    console.log(`[update-ownership] stock_daily_features diperbarui untuk ${featUpdated} emiten.`);
  } catch (err) {
    console.warn('[update-ownership] Warning saat sync stock_daily_features:', err.message);
  }

  // Verification query
  try {
    const summary = db.prepare("SELECT count(*) as count, free_float_as_of FROM market_rows WHERE table_name = 'stock_fundamentals' GROUP BY free_float_as_of").all();
    console.log('[update-ownership] Verifikasi SQLite grouping:');
    summary.forEach((s) => console.log(`  - as_of: ${s.free_float_as_of} -> ${s.count} emiten`));
  } catch (err) {
    console.warn('[update-ownership] Warning saat verifikasi query:', err.message);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[update-ownership] FATAL:', err.message);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, normalizeCompanyName };

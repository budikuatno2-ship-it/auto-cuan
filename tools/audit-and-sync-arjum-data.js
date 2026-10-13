#!/usr/bin/env node
'use strict';

/**
 * AUTO-CUAN - Audit & Sync Stock Arjum data (data/arjum-data/) into SQLite.
 *
 * Workstream 1 of the Oct-2026 master repair. The production SQLite store is
 * /home/ubuntu/auto-cuan-data/market.sqlite (single table market_rows with a
 * JSON blob per row). This tool audits every Arjum dataset and syncs the
 * derived fundamentals into market_rows(table_name='stock_fundamentals').
 *
 * Audit coverage:
 *   1. financial-statements/  -> coverage vs the 962 official emiten, corrupt
 *      or 0-byte JSON detection, key-ratio extraction (revenue, net_profit,
 *      equity, bvps, pbv) and mapping into stock_fundamentals when missing.
 *   2. company-profiles/      -> when present: official name, sector,
 *      sub-sector, shares outstanding. When absent the tool reports the
 *      directory as NOT_AVAILABLE and derives shares_outstanding from
 *      market-cap + close, marking the field source honestly.
 *   3. daily-candles/         -> close/volume consistency against the
 *      stock_daily_history table for the most recent trading date available.
 *   4. PENDING_REPORT         -> emiten with no valid financial-statement
 *      payload are labelled fundamental_status='PENDING_REPORT' so the UI can
 *      render an informative empty state instead of a blank value.
 *
 * Usage:
 *   node tools/audit-and-sync-arjum-data.js                    # read-only audit
 *   node tools/audit-and-sync-arjum-data.js --apply            # sync to SQLite
 *   node tools/audit-and-sync-arjum-data.js --apply --db-path=/path/to.sqlite
 *   node tools/audit-and-sync-arjum-data.js --apply --limit=50 --verbose
 *
 * Safety:
 *   - read-only unless --apply;
 *   - --apply against the production DB requires ALLOW_PROD_DB_WRITE=1;
 *   - idempotent upserts keyed by ticker; existing unrelated fields preserved.
 */

const fs = require('node:fs');
const path = require('node:path');

const marketStore = require('../lib/vps-market-store');
const financialStatementsImport = require('../lib/financial-statements-import');

const ROOT = path.resolve(__dirname, '..');
const PROD_MARKET_DB = '/home/ubuntu/auto-cuan-data/market.sqlite';
const OFFICIAL_EMITEN_COUNT = 962;

const DATA_DIR_CANDIDATES = [
  process.env.ARJUM_DATA_DIR,
  '/home/ubuntu/auto-cuan/data/arjum-data',
  path.join(ROOT, 'data', 'arjum-data')
].filter(Boolean);

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      if (Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
      let value = match[2].replace(/\s+#.*$/, '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value || /^\[(?:sensitive|redacted|secret|placeholder|todo)\]$/i.test(value)) continue;
      process.env[match[1]] = value;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function initEnv() {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  [
    path.join(runnerDir, '.env'),
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '.env.intraday-runtime'),
    path.join(ROOT, '.env')
  ].forEach(loadEnvFile);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    dbPath: null,
    dataDir: null,
    limit: null,
    verbose: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg.startsWith('--db-path=')) options.dbPath = path.resolve(arg.split('=')[1].trim());
    else if (arg.startsWith('--data-dir=')) options.dataDir = path.resolve(arg.split('=')[1].trim());
    else if (arg.startsWith('--limit=')) options.limit = Math.max(1, Number(arg.split('=')[1]) || 0);
  }
  return options;
}

function resolveDataDir(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const candidate of DATA_DIR_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return path.join(ROOT, 'data', 'arjum-data');
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch (_) {
        return false;
      }
    })
    .sort();
}

function inspectJsonFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat) return { status: 'MISSING', size: 0 };
    if (stat.size === 0) return { status: 'ZERO_BYTES', size: 0 };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { status: 'INVALID_SHAPE', size: stat.size };
    return { status: 'OK', size: stat.size, data: parsed };
  } catch (err) {
    return { status: 'CORRUPT', size: 0, error: String(err && err.message || err).slice(0, 120) };
  }
}

// --- 1. financial statements -------------------------------------------------

const STATEMENT_FILES = [
  'BALANCE_SHEET-quarterly.json',
  'BALANCE_SHEET-annually.json',
  'BALANCE_SHEET-annual.json',
  'INCOME_STATEMENT-quarterly.json',
  'INCOME_STATEMENT-annually.json',
  'INCOME_STATEMENT-annual.json',
  'CASH_FLOW_REPORT-quarterly.json',
  'CASH_FLOW_REPORT-annually.json',
  'CASH_FLOW_REPORT-annual.json'
];

function auditFinancialStatements(dataDir) {
  const dir = path.join(dataDir, 'financial-statements');
  const tickers = listDirs(dir);
  const report = {
    dir,
    ticker_folders: tickers.length,
    expected_emiten: OFFICIAL_EMITEN_COUNT,
    missing_folders: Math.max(0, OFFICIAL_EMITEN_COUNT - tickers.length),
    folders_with_data: 0,
    empty_or_corrupt_files: [],
    zero_byte_files: [],
    tickers: []
  };

  for (const ticker of tickers) {
    const tickerDir = path.join(dir, ticker);
    const files = STATEMENT_FILES
      .map((name) => ({ name, path: path.join(tickerDir, name) }))
      .filter((entry) => fs.existsSync(entry.path));

    let valid = 0;
    let corrupt = 0;
    for (const entry of files) {
      const check = inspectJsonFile(entry.path);
      if (check.status === 'OK') valid++;
      else {
        corrupt++;
        if (check.status === 'ZERO_BYTES') {
          report.zero_byte_files.push(ticker + '/' + entry.name);
        } else {
          report.empty_or_corrupt_files.push(ticker + '/' + entry.name + ':' + check.status);
        }
      }
    }

    const hasData = files.length > 0 && valid > 0;
    if (hasData) report.folders_with_data++;
    report.tickers.push({
      ticker,
      files_present: files.length,
      files_valid: valid,
      files_corrupt: corrupt,
      status: hasData ? 'OK' : 'PENDING_REPORT'
    });
  }

  return report;
}

// --- 2. company profiles -----------------------------------------------------

function auditCompanyProfiles(dataDir) {
  const dir = path.join(dataDir, 'company-profiles');
  const report = {
    dir,
    available: fs.existsSync(dir),
    profiles: 0,
    with_official_name: 0,
    with_sector: 0,
    with_sub_sector: 0,
    with_shares_outstanding: 0,
    status: fs.existsSync(dir) ? 'AUDITED' : 'NOT_AVAILABLE'
  };
  if (!report.available) return report;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  report.profiles = files.length;
  for (const file of files) {
    const check = inspectJsonFile(path.join(dir, file));
    if (check.status !== 'OK') continue;
    const d = check.data || {};
    const name = d.name || d.company_name || d.official_name || (d.data && (d.data.name || d.data.company_name));
    const sector = d.sector || (d.data && d.data.sector);
    const subSector = d.sub_sector || d.subsector || (d.data && (d.data.sub_sector || d.data.subsector));
    const shares = d.shares_outstanding || d.listed_shares || (d.data && (d.data.shares_outstanding || d.data.listed_shares));
    if (name) report.with_official_name++;
    if (sector) report.with_sector++;
    if (subSector) report.with_sub_sector++;
    if (shares != null) report.with_shares_outstanding++;
  }
  return report;
}

// --- 3. daily candles vs stock_daily_history ---------------------------------

function latestHistoryDate(store) {
  try {
    const rows = store.queryRows('stock_daily_history', {
      orders: [{ field: 'trade_date', ascending: false }],
      limit: 1
    });
    if (rows && rows[0] && rows[0].trade_date) return String(rows[0].trade_date).slice(0, 10);
  } catch (_) {}
  return null;
}

function auditDailyCandles(dataDir, store) {
  const dir = path.join(dataDir, 'daily-candles');
  const report = {
    dir,
    files: 0,
    parse_errors: 0,
    reference_date: null,
    db_rows_for_date: 0,
    db_tickers_for_date: 0,
    close_mismatches: 0,
    volume_mismatches: 0,
    missing_in_db: 0,
    samples: []
  };
  if (!fs.existsSync(dir)) {
    report.status = 'NOT_AVAILABLE';
    return report;
  }

  const referenceDate = store ? latestHistoryDate(store) : null;
  report.reference_date = referenceDate;

  let dbIndex = new Map();
  if (store && referenceDate) {
    try {
      const dbRows = store.queryRows('stock_daily_history', {
        filters: [{ field: 'trade_date', op: 'eq', value: referenceDate }]
      });
      report.db_rows_for_date = dbRows.length;
      const tickers = new Set();
      dbRows.forEach((row) => {
        if (!row || !row.ticker) return;
        tickers.add(String(row.ticker).toUpperCase());
        dbIndex.set(String(row.ticker).toUpperCase(), row);
      });
      report.db_tickers_for_date = tickers.size;
    } catch (_) {
      dbIndex = new Map();
    }
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  report.files = files.length;

  for (const file of files) {
    const ticker = file.replace(/\.json$/i, '').toUpperCase();
    const check = inspectJsonFile(path.join(dir, file));
    if (check.status !== 'OK') {
      report.parse_errors++;
      continue;
    }
    const candles = Array.isArray(check.data.candles) ? check.data.candles : [];
    if (!referenceDate) continue;

    const local = candles.find((c) => c && String(c.date).slice(0, 10) === referenceDate);
    const dbRow = dbIndex.get(ticker);
    if (!dbRow) {
      if (local) report.missing_in_db++;
      continue;
    }
    if (!local) continue;

    const localClose = Number(local.close);
    const dbClose = Number(dbRow.close);
    if (Number.isFinite(localClose) && Number.isFinite(dbClose) && Math.abs(localClose - dbClose) > 0.001) {
      report.close_mismatches++;
      if (report.samples.length < 5) {
        report.samples.push({ ticker, field: 'close', local: localClose, db: dbClose });
      }
    }
    const localVolume = Number(local.volume);
    const dbVolume = Number(dbRow.volume);
    if (Number.isFinite(localVolume) && Number.isFinite(dbVolume) && localVolume !== dbVolume) {
      report.volume_mismatches++;
      if (report.samples.length < 5) {
        report.samples.push({ ticker, field: 'volume', local: localVolume, db: dbVolume });
      }
    }
  }

  report.status = (report.close_mismatches === 0 && report.volume_mismatches === 0 && report.parse_errors === 0)
    ? 'CONSISTENT'
    : 'DISCREPANCIES_FOUND';
  return report;
}

// --- key ratio extraction + sync --------------------------------------------

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extracts the key ratios the directive lists (revenue, net_profit, equity,
 * bvps, pbv) from the parsed statements. Values that are absent stay null -
 * nothing is fabricated.
 */
function extractKeyRatios(parsedStatements, existing, marketCapInfo) {
  const ratios = {
    revenue: null,
    net_profit: null,
    equity: null,
    bvps: null,
    pbv: null,
    shares_outstanding: null,
    market_cap: null,
    fundamental_period: null
  };
  if (!parsedStatements) return ratios;

  const quarterly = parsedStatements.quarterly || null;
  const annual = parsedStatements.annual || null;
  const income = (quarterly && quarterly.income_statement) || (annual && annual.income_statement) || null;
  const balance = (quarterly && quarterly.balance_sheet) || (annual && annual.balance_sheet) || null;

  function firstValue(statement, labels) {
    if (!statement || !Array.isArray(statement.rows)) return null;
    for (const row of statement.rows) {
      if (!row || !row.label) continue;
      const label = String(row.label).toLowerCase();
      if (labels.some((l) => label.indexOf(l) >= 0)) {
        const values = Array.isArray(row.values) ? row.values : [];
        for (const v of values) {
          const n = numOrNull(v);
          if (n != null) return n;
        }
      }
    }
    return null;
  }

  // Income statement values are stored in Miliar IDR (see toMiliarIdr).
  ratios.revenue = firstValue(income, ['pendapatan usaha', 'revenue', 'penjualan bersih']);
  ratios.net_profit = firstValue(income, ['laba bersih', 'net profit', 'laba periode berjalan']);
  ratios.equity = firstValue(balance, ['total ekuitas', 'ekuitas', 'total equity']);
  ratios.fundamental_period = parsedStatements.fundamental_period || (quarterly && quarterly.periods && quarterly.periods[0]) || null;

  const existingBvps = existing && existing.book_value_per_share != null ? Number(existing.book_value_per_share) : null;
  ratios.bvps = existingBvps;
  if (ratios.bvps == null && ratios.equity != null && marketCapInfo && marketCapInfo.listed_shares) {
    const shares = Number(marketCapInfo.listed_shares);
    if (Number.isFinite(shares) && shares > 0) {
      // equity is in Miliar IDR; BVPS is in IDR per share.
      ratios.bvps = Math.round(((ratios.equity * 1e9) / shares) * 100) / 100;
    }
  }

  if (marketCapInfo) {
    ratios.shares_outstanding = marketCapInfo.listed_shares != null ? Number(marketCapInfo.listed_shares) : null;
    ratios.market_cap = marketCapInfo.market_cap != null ? Number(marketCapInfo.market_cap) : null;
    const close = marketCapInfo.close != null ? Number(marketCapInfo.close) : null;
    if (ratios.bvps != null && ratios.bvps > 0 && close != null && close > 0) {
      ratios.pbv = Math.round((close / ratios.bvps) * 100) / 100;
    }
  }

  const existingPbv = existing && existing.pbv != null ? Number(existing.pbv) : null;
  if (ratios.pbv == null && existingPbv != null) ratios.pbv = existingPbv;

  return ratios;
}

function auditAndSync(options, deps = {}) {
  const log = deps.log || console.log;
  const dataDir = resolveDataDir(options.dataDir);
  const dbPath = options.dbPath || process.env.AUTO_CUAN_MARKET_DB || PROD_MARKET_DB;

  const isProdDb = /auto-cuan-data[\\/]market\.sqlite$/i.test(path.resolve(dbPath));
  if (options.apply && isProdDb && process.env.ALLOW_PROD_DB_WRITE !== '1') {
    throw new Error('Safety guard: --apply terhadap database produksi membutuhkan ALLOW_PROD_DB_WRITE=1.');
  }

  log('=== AUTO-CUAN AUDIT & SYNC STOCK ARJUM DATA ===');
  log('Data dir : ' + dataDir);
  log('DB path  : ' + dbPath);
  log('Mode     : ' + (options.apply ? 'APPLY (sync ke SQLite)' : 'READ-ONLY AUDIT'));
  log('');

  // ---- 1. financial statements
  const finAudit = auditFinancialStatements(dataDir);
  log('[1] Laporan Keuangan');
  log('    Folder emiten       : ' + finAudit.ticker_folders + ' / ' + finAudit.expected_emiten + ' resmi');
  log('    Folder berisi data  : ' + finAudit.folders_with_data);
  log('    Folder belum ada    : ' + finAudit.missing_folders);
  log('    File 0 bytes        : ' + finAudit.zero_byte_files.length);
  log('    File korup/invalid  : ' + finAudit.empty_or_corrupt_files.length);
  if (options.verbose && finAudit.zero_byte_files.length) {
    finAudit.zero_byte_files.slice(0, 10).forEach((f) => log('      - ' + f));
  }
  log('');

  // ---- 2. company profiles
  const profileAudit = auditCompanyProfiles(dataDir);
  log('[2] Profil Perusahaan');
  log('    Status direktori    : ' + profileAudit.status);
  if (profileAudit.available) {
    log('    Profil terbaca      : ' + profileAudit.profiles);
    log('    Nama resmi          : ' + profileAudit.with_official_name);
    log('    Sektor / sub-sektor : ' + profileAudit.with_sector + ' / ' + profileAudit.with_sub_sector);
    log('    Shares outstanding  : ' + profileAudit.with_shares_outstanding);
  } else {
    log('    (data/arjum-data/company-profiles belum tersedia; shares outstanding');
    log('     tetap diisi dari market-cap + close bila tersedia)');
  }
  log('');

  // ---- 3. store + candles
  let store = deps.store || null;
  if (!store) {
    try {
      store = marketStore.getVpsMarketStore(dbPath);
    } catch (err) {
      log('[3] Daily Candles: store tidak dapat dibuka (' + (err && err.message || err) + ')');
      store = null;
    }
  }

  let candleAudit = { status: 'SKIPPED' };
  if (store) {
    candleAudit = auditDailyCandles(dataDir, store);
    log('[3] Candle Historis vs stock_daily_history');
    log('    File daily-candles  : ' + candleAudit.files + (candleAudit.parse_errors ? ' (' + candleAudit.parse_errors + ' parse error)' : ''));
    log('    Tanggal referensi   : ' + (candleAudit.reference_date || '-'));
    log('    Baris DB tanggal itu: ' + candleAudit.db_rows_for_date + ' (' + candleAudit.db_tickers_for_date + ' emiten)');
    log('    Selisih close       : ' + candleAudit.close_mismatches);
    log('    Selisih volume      : ' + candleAudit.volume_mismatches);
    log('    Emiten hanya di file: ' + candleAudit.missing_in_db);
    log('    Status              : ' + candleAudit.status);
    candleAudit.samples.forEach((s) => log('      sample: ' + s.ticker + ' ' + s.field + ' file=' + s.local + ' db=' + s.db));
  }
  log('');

  // ---- 4. sync into stock_fundamentals
  const sync = {
    target_table: 'stock_fundamentals',
    tickers_seen: 0,
    synced: 0,
    created: 0,
    updated: 0,
    pending_report: 0,
    with_ratios: { revenue: 0, net_profit: 0, equity: 0, bvps: 0, pbv: 0 },
    errors: []
  };

  if (!store) {
    log('[4] Sync ke stock_fundamentals: DILEWATI (store tidak tersedia)');
    return { financial_statements: finAudit, company_profiles: profileAudit, candles: candleAudit, sync };
  }

  const marketCapMap = financialStatementsImport.loadMarketCapData(path.join(dataDir, 'market-cap'));
  const statementsDir = path.join(dataDir, 'financial-statements');
  let tickers = finAudit.tickers.map((t) => t.ticker);
  if (options.limit) tickers = tickers.slice(0, options.limit);

  const existingRows = store.queryRows('stock_fundamentals', {});
  const existingIndex = new Map();
  existingRows.forEach((row) => {
    if (row && row.ticker) existingIndex.set(String(row.ticker).toUpperCase(), row);
  });

  const updates = [];
  for (const ticker of tickers) {
    sync.tickers_seen++;
    const existing = existingIndex.get(ticker) || null;
    const tickerDir = path.join(statementsDir, ticker);
    const parsedStatements = financialStatementsImport.parseTickerStatements(tickerDir, ticker);
    const marketCapInfo = marketCapMap.get(ticker) || null;

    const record = financialStatementsImport.buildMergedFundamentalRecord({
      ticker,
      existingRecord: existing,
      parsedStatements,
      marketCapInfo
    });

    const ratios = extractKeyRatios(parsedStatements, existing, marketCapInfo);
    record.revenue = ratios.revenue != null ? ratios.revenue : (existing && existing.revenue != null ? existing.revenue : null);
    record.net_profit = ratios.net_profit != null ? ratios.net_profit : (existing && existing.net_profit != null ? existing.net_profit : null);
    record.equity = ratios.equity != null ? ratios.equity : (existing && existing.equity != null ? existing.equity : null);
    record.pbv = ratios.pbv != null ? ratios.pbv : (existing && existing.pbv != null ? existing.pbv : null);
    record.bvps = ratios.bvps != null ? ratios.bvps : (record.book_value_per_share != null ? record.book_value_per_share : null);
    record.ratio_source = 'arjum-audit-sync';
    record.ratios_audited_at = new Date().toISOString();

    // A report exists when the parser produced at least one period row for
    // quarterly or annual statements. Relying on fundamental_period alone was
    // too strict: a vendor payload whose equity path differs from the known
    // schema still contains real statements and must not be mislabelled
    // PENDING_REPORT.
    const hasValidStatements = !!(parsedStatements && (
      (parsedStatements.quarterly && Array.isArray(parsedStatements.quarterly.periods) && parsedStatements.quarterly.periods.length > 0) ||
      (parsedStatements.annual && Array.isArray(parsedStatements.annual.periods) && parsedStatements.annual.periods.length > 0)
    ));
    if (!hasValidStatements) {
      record.fundamental_status = 'PENDING_REPORT';
      record.fundamental_status_note = 'Emiten belum merilis laporan keuangan di Arjum; nilai fundamental belum tersedia.';
      sync.pending_report++;
    } else {
      record.fundamental_status = 'AVAILABLE';
    }

    ['revenue', 'net_profit', 'equity', 'bvps', 'pbv'].forEach((key) => {
      if (record[key] != null) sync.with_ratios[key]++;
    });

    updates.push(record);
    if (existing) sync.updated++;
    else sync.created++;
  }

  if (options.apply) {
    store.transaction(() => {
      for (const record of updates) {
        store.writeRow('stock_fundamentals', record, ['ticker'], true);
      }
    });
    sync.synced = updates.length;
  } else {
    sync.synced = 0;
  }

  log('[4] Sync ke stock_fundamentals');
  log('    Emiten diperiksa    : ' + sync.tickers_seen);
  log('    ' + (options.apply ? 'Baris di-upsert' : 'Baris siap-upsert') + '    : ' + updates.length + ' (baru: ' + sync.created + ', update: ' + sync.updated + ')');
  log('    Label PENDING_REPORT: ' + sync.pending_report);
  log('    Rasio revenue       : ' + sync.with_ratios.revenue);
  log('    Rasio net_profit    : ' + sync.with_ratios.net_profit);
  log('    Rasio equity        : ' + sync.with_ratios.equity);
  log('    Rasio BVPS          : ' + sync.with_ratios.bvps);
  log('    Rasio PBV           : ' + sync.with_ratios.pbv);
  if (!options.apply) {
    log('    (dry-run: tidak ada perubahan ditulis. Jalankan --apply untuk sinkronisasi.)');
  }

  return { financial_statements: finAudit, company_profiles: profileAudit, candles: candleAudit, sync };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  initEnv();
  const options = parseArgs(argv);
  const result = auditAndSync(options, deps);
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('audit-and-sync-arjum-data fatal:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  resolveDataDir,
  auditFinancialStatements,
  auditCompanyProfiles,
  auditDailyCandles,
  extractKeyRatios,
  auditAndSync,
  main
};

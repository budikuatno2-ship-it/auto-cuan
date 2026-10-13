#!/usr/bin/env node
'use strict';

/**
 * Generator / backfill for dated broker-accumulation caches.
 *
 * Root cause (audit 1-12 Oct 2026): 2026-10-06 had complete candles and
 * broker-summary (831 emiten) but ZERO files under
 * data/arjum-data/broker-accumulation/ for that date. The accumulation
 * endpoint of Arjum is a snapshot-only series (it is NOT date-addressable),
 * so a day whose snapshot request failed can never be refetched from the
 * vendor afterwards. What CAN be reconstructed deterministically is the
 * per-day accumulation record derived from that day's broker-summary, which
 * is date-addressable and already on disk.
 *
 * This tool therefore:
 *   1. reads the dated broker-summary cache for --date,
 *   2. normalizes it with the canonical bandarmologi service,
 *   3. synthesizes the per-day accumulation record
 *      (synthesizeAccumulationFromSummary - the same deterministic derivation
 *      the runtime already uses when only a summary is available),
 *   4. writes data/arjum-data/broker-accumulation/<TICKER>/<date>.json.
 *
 * Nothing is fabricated: every number comes from the vendor summary rows.
 * Emiten with no broker-summary rows for the date are reported as
 * NO_SUMMARY (never written with invented values).
 *
 * Usage:
 *   node tools/generate-broker-accumulation.js --date=2026-10-06             # dry-run report
 *   node tools/generate-broker-accumulation.js --date=2026-10-06 --apply     # write files
 *   node tools/generate-broker-accumulation.js --date=2026-10-06 --apply --limit=50
 *   node tools/generate-broker-accumulation.js --date=2026-10-06 --apply --tickers=AADI,BBCA
 *
 * Safety:
 *   - dry-run by default;
 *   - refuses --apply without ALLOW_PROD_DB_WRITE=1 when the target data dir
 *     resolves to the production VPS location (parity with the other writers);
 *   - never overwrites an existing dated accumulation file unless --force.
 */

const fs = require('node:fs');
const path = require('node:path');

const bandarmologiService = require('../lib/bandarmologi-service');
const idxTradingCalendar = require('../lib/idx-trading-calendar');

const ROOT = path.resolve(__dirname, '..');
const PROD_DATA_DIR = '/home/ubuntu/auto-cuan/data/arjum-data';

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
    date: null,
    apply: false,
    force: false,
    limit: null,
    tickers: null,
    quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg.startsWith('--date=')) options.date = arg.split('=')[1].trim();
    else if (arg.startsWith('--limit=')) options.limit = Math.max(1, Number(arg.split('=')[1]) || 0);
    else if (arg.startsWith('--tickers=')) {
      options.tickers = arg.split('=')[1].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    }
  }
  return options;
}

function resolveDataDir() {
  if (process.env.ARJUM_DATA_DIR && fs.existsSync(process.env.ARJUM_DATA_DIR)) {
    return process.env.ARJUM_DATA_DIR;
  }
  if (typeof bandarmologiService.getStorageDir === 'function') {
    return bandarmologiService.getStorageDir();
  }
  return path.join(ROOT, 'data', 'arjum-data');
}

function isProductionDataDir(dir) {
  return String(dir).replace(/\\/g, '/').toLowerCase().indexOf('/auto-cuan/data/arjum-data') >= 0;
}

function listTickersFromSummaries(dataDir, date) {
  const summaryRoot = path.join(dataDir, 'broker-summary');
  if (!fs.existsSync(summaryRoot)) return [];
  return fs.readdirSync(summaryRoot)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return fs.statSync(path.join(summaryRoot, name)).isDirectory();
      } catch (_) {
        return false;
      }
    })
    .filter((ticker) => fs.existsSync(path.join(summaryRoot, ticker, date + '.json')))
    .sort();
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat || stat.size <= 2) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isTradingDay(date) {
  try {
    if (typeof idxTradingCalendar.isTradingDay === 'function') {
      return idxTradingCalendar.isTradingDay(date);
    }
    const holidays = idxTradingCalendar.getSeedHolidaySet();
    const d = new Date(date + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6 && !holidays.has(date);
  } catch (_) {
    return true;
  }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  initEnv();
  const options = parseArgs(argv);
  const log = deps.log || console.log;

  if (!options.date || !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error('Argumen --date=YYYY-MM-DD wajib dan harus berupa tanggal valid.');
  }

  const dataDir = deps.dataDir || resolveDataDir();
  const accumulationDir = path.join(dataDir, 'broker-accumulation');

  log('=== AUTO-CUAN GENERATE BROKER-ACCUMULATION ===');
  log('Tanggal     : ' + options.date + (isTradingDay(options.date) ? ' (hari bursa)' : ' (BUKAN hari bursa)'));
  log('Data dir    : ' + dataDir);
  log('Mode        : ' + (options.apply ? 'APPLY' : 'DRY-RUN'));

  if (options.apply && isProductionDataDir(dataDir) && process.env.ALLOW_PROD_DB_WRITE !== '1') {
    throw new Error('Safety guard: --apply pada direktori data produksi membutuhkan ALLOW_PROD_DB_WRITE=1.');
  }

  const tickers = options.tickers && options.tickers.length
    ? options.tickers
    : listTickersFromSummaries(dataDir, options.date);

  log('Kandidat emiten dengan broker-summary ' + options.date + ': ' + tickers.length);

  const summary = {
    date: options.date,
    candidates: tickers.length,
    written: 0,
    already_present: 0,
    no_summary_rows: 0,
    invalid_summary: 0,
    failed: 0,
    samples: []
  };

  let processed = 0;
  for (const ticker of tickers) {
    if (options.limit && processed >= options.limit) break;
    processed++;

    const targetFile = path.join(accumulationDir, ticker, options.date + '.json');
    if (fs.existsSync(targetFile) && !options.force) {
      summary.already_present++;
      continue;
    }

    const rawSummary = readJsonSafe(path.join(dataDir, 'broker-summary', ticker, options.date + '.json'));
    if (!rawSummary) {
      summary.invalid_summary++;
      continue;
    }

    let normalized;
    try {
      normalized = bandarmologiService.normalizeBrokerSummary(rawSummary, options.date, ticker, { skipLivePrice: true });
    } catch (_) {
      normalized = null;
    }

    const hasRows = normalized && (
      (normalized.top_buyers && normalized.top_buyers.length) ||
      (normalized.top_sellers && normalized.top_sellers.length) ||
      (normalized.net_buyers && normalized.net_buyers.length) ||
      (normalized.net_sellers && normalized.net_sellers.length)
    );

    if (!hasRows) {
      // NO_TRADE / provider-empty day: never fabricate an accumulation record.
      summary.no_summary_rows++;
      continue;
    }

    let synthesized;
    try {
      synthesized = bandarmologiService.synthesizeAccumulationFromSummary(normalized, ticker);
    } catch (_) {
      synthesized = null;
    }

    if (!synthesized || !Array.isArray(synthesized.series) || synthesized.series.length === 0) {
      summary.no_summary_rows++;
      continue;
    }

    const payload = Object.assign({}, synthesized, {
      code: ticker,
      ticker: ticker,
      date: options.date,
      source: 'derived-from-broker-summary',
      derived_at: new Date().toISOString()
    });

    if (options.apply) {
      try {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf8');
        summary.written++;
        if (summary.samples.length < 5) summary.samples.push(ticker);
      } catch (_) {
        summary.failed++;
      }
    } else {
      summary.written++;
      if (summary.samples.length < 5) summary.samples.push(ticker);
    }
  }

  log('----------------------------------------------------');
  log('Ringkasan ' + options.date + ':');
  log('  - kandidat broker-summary : ' + summary.candidates);
  log('  - ' + (options.apply ? 'ditulis' : 'akan ditulis') + '            : ' + summary.written + (summary.samples.length ? ' (' + summary.samples.join(', ') + '...)' : ''));
  log('  - sudah ada (skip)        : ' + summary.already_present);
  log('  - tanpa baris broker      : ' + summary.no_summary_rows);
  log('  - summary tidak valid     : ' + summary.invalid_summary);
  log('  - gagal tulis             : ' + summary.failed);
  if (!options.apply) {
    log('Dry-run selesai. Jalankan dengan --apply untuk menulis file.');
  }

  return summary;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('generate-broker-accumulation fatal:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  resolveDataDir,
  listTickersFromSummaries,
  isTradingDay,
  main
};

#!/usr/bin/env node
'use strict';

/**
 * Candle coverage preflight for the nightly screener (2026-10-13).
 *
 * The EOD candle set for the official 962-emiten universe only reaches full
 * coverage around 21:12 WIB. Running the screener before that produced signals
 * on partial data (~87% at 19:00). This checker reports the day-T coverage so
 * deploy/vps/run-screeners-preflight.sh can defer the sweep until the
 * threshold (default 95%) is met.
 *
 * Output contract (parsed by the shell wrapper):
 *   COVERAGE_OK coverage_pct=NN.NN tickers=N universe=962 date=YYYY-MM-DD
 *   COVERAGE_INSUFFICIENT coverage_pct=NN.NN tickers=N universe=962 date=YYYY-MM-DD
 *
 * Usage:
 *   node tools/check-candle-coverage.js
 *   node tools/check-candle-coverage.js --min-pct=95
 *   node tools/check-candle-coverage.js --date=2026-10-12
 *
 * Exit codes: 0 = OK, 2 = insufficient, 1 = error (fail-open at the wrapper).
 */

const fs = require('node:fs');
const path = require('node:path');

const marketStore = require('../lib/vps-market-store');
const idxTradingCalendar = require('../lib/idx-trading-calendar');

const ROOT = path.resolve(__dirname, '..');
const PROD_MARKET_DB = '/home/ubuntu/auto-cuan-data/market.sqlite';
const OFFICIAL_EMITEN_COUNT = 962;

function parseArgs(argv) {
  const options = { minPct: 95, date: null, dbPath: null, quiet: false };
  for (const arg of argv) {
    if (arg.startsWith('--min-pct=')) options.minPct = Number(arg.split('=')[1]) || options.minPct;
    else if (arg.startsWith('--date=')) options.date = arg.split('=')[1].trim();
    else if (arg.startsWith('--db-path=')) options.dbPath = path.resolve(arg.split('=')[1].trim());
    else if (arg === '--quiet') options.quiet = true;
  }
  return options;
}

function wibToday() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Resolves the trading date whose candles must be complete for tonight's
 * screener. Defaults to the latest trading date available in the store, which
 * is what the screener itself will read.
 */
function resolveTargetDate(store, explicit) {
  if (explicit) return explicit;
  try {
    const rows = store.queryRows('stock_daily_history', {
      orders: [{ field: 'trade_date', ascending: false }],
      limit: 1
    });
    if (rows && rows[0] && rows[0].trade_date) return String(rows[0].trade_date).slice(0, 10);
  } catch (_) {}
  return wibToday();
}

function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const log = options.quiet ? () => {} : (deps.log || console.log);
  const dbPath = options.dbPath || process.env.AUTO_CUAN_MARKET_DB || PROD_MARKET_DB;

  if (!fs.existsSync(dbPath)) {
    log('Candle coverage: DB tidak ditemukan di ' + dbPath + '; fail-open.');
    console.log('COVERAGE_OK coverage_pct=unknown tickers=0 universe=' + OFFICIAL_EMITEN_COUNT + ' date=' + (options.date || wibToday()) + ' note=db_missing');
    return 0;
  }

  const store = deps.store || marketStore.getVpsMarketStore(dbPath);
  const date = resolveTargetDate(store, options.date);

  let rows = [];
  try {
    rows = store.queryRows('stock_daily_history', {
      filters: [{ field: 'trade_date', op: 'eq', value: date }]
    });
  } catch (err) {
    log('Candle coverage: query gagal (' + (err && err.message || err) + '); fail-open.');
    console.log('COVERAGE_OK coverage_pct=unknown tickers=0 universe=' + OFFICIAL_EMITEN_COUNT + ' date=' + date + ' note=query_failed');
    return 0;
  }

  const tickers = new Set();
  let zeroVolume = 0;
  rows.forEach((row) => {
    if (!row || !row.ticker) return;
    tickers.add(String(row.ticker).toUpperCase());
    if (Number(row.volume) === 0) zeroVolume++;
  });

  const covered = tickers.size;
  const pct = Math.round((covered / OFFICIAL_EMITEN_COUNT) * 10000) / 100;
  const isTradingDay = (() => {
    try {
      if (typeof idxTradingCalendar.isTradingDay === 'function') return idxTradingCalendar.isTradingDay(date);
      const holidays = idxTradingCalendar.getSeedHolidaySet();
      const d = new Date(date + 'T00:00:00Z');
      const day = d.getUTCDay();
      return day !== 0 && day !== 6 && !holidays.has(date);
    } catch (_) {
      return true;
    }
  })();

  log('Candle coverage ' + date + ': ' + covered + '/' + OFFICIAL_EMITEN_COUNT + ' (' + pct + '%), zero-volume rows: ' + zeroVolume + (isTradingDay ? '' : ' [BUKAN hari bursa]'));

  if (!isTradingDay) {
    // Non-trading day: the screener has nothing to scan; treat as OK so the
    // wrapper proceeds (the screener itself no-ops on holidays).
    console.log('COVERAGE_OK coverage_pct=' + pct + ' tickers=' + covered + ' universe=' + OFFICIAL_EMITEN_COUNT + ' date=' + date + ' note=non_trading_day');
    return 0;
  }

  if (pct >= options.minPct) {
    console.log('COVERAGE_OK coverage_pct=' + pct + ' tickers=' + covered + ' universe=' + OFFICIAL_EMITEN_COUNT + ' date=' + date);
    return 0;
  }

  console.log('COVERAGE_INSUFFICIENT coverage_pct=' + pct + ' tickers=' + covered + ' universe=' + OFFICIAL_EMITEN_COUNT + ' date=' + date);
  return 2;
}

if (require.main === module) {
  try {
    const code = main();
    process.exitCode = code;
  } catch (err) {
    console.error('check-candle-coverage fatal:', err && err.message ? err.message : err);
    // Fail-open: a broken checker must never block the nightly producer.
    console.log('COVERAGE_OK coverage_pct=unknown tickers=0 universe=962 date=' + wibToday() + ' note=checker_error');
    process.exitCode = 0;
  }
}

module.exports = { parseArgs, resolveTargetDate, main };

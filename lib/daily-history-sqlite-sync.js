'use strict';

/**
 * Daily History → SQLite synchronization — BUG-3C-03.
 *
 * Runtime symptom this module fixes:
 *   data/daily-candles/*.json is current (canonical flat-file candle cache),
 *   but SQLite stock_daily_history stalled at 2026-09-29, so
 *   tools/run-lifecycle-evaluator.js logged skipped_no_history: 71.
 *
 * The coordinator (tools/run-daily-market-update.js) updated the flat files
 * but nothing fed the SQLite history store. This module is the missing bridge:
 * it reads the canonical flat-file candles and upserts them through the
 * canonical storage API (lib/stock-daily-history-store.js → upsertDailyHistory,
 * conflict key (ticker, trade_date)).
 *
 * Design:
 *   - CANONICAL PRODUCTION STORE = VPS SQLITE (/home/ubuntu/auto-cuan-data/market.sqlite)
 *   - IDEMPOTENT: upsert on (ticker, trade_date); re-running changes nothing.
 *   - DETERMINISTIC: the window is the last N completed trading sessions per
 *     the IDX calendar (weekend/holiday aware), never "last N calendar days".
 *   - BOUNDED: rolling reconciliation (default 5 sessions) recovers recent
 *     gaps — e.g. two missed days — without a full historical backfill.
 *   - NO FUTURE DATES: a candle dated after the current WIB trading date is
 *     rejected.
 *   - FAIL CLOSED / STORE ASSERTION: in a production writer context, if VPS routing
 *     is not enabled, fail loudly with MARKET_HISTORY_STORE_MISMATCH before writing.
 *
 * Validation mirrors lib/stock-daily-history-store.js isValidCandle: close is
 * required and strictly positive; open/high/low must be positive when present;
 * volume must be a finite number >= 0. A canonical flat-file candle with
 * open == 0 (the known 24-ticker zero-open anomaly on 2026-10-01) is therefore
 * skipped — reported as skipped_invalid, never repaired with an invented
 * value. This is a documented compatibility decision, not a fix for that
 * separate data-integrity issue.
 */

const fs = require('node:fs');
const path = require('node:path');

const calendar = require('./idx-trading-calendar');
const historyStore = require('./stock-daily-history-store');
const { isValidIhsgCandle } = require('./ihsg-validation');
const { getVpsMarketStore } = require('./vps-market-store');
const { createClient: createHybridClient, marketDataVpsEnabled } = require('./hybrid-supabase-client');
const { getWibComponents } = require('./market-hours-guard');

const DEFAULT_RECENT_SESSIONS = 5;
const MAX_RECENT_SESSIONS = 60;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the canonical flat-file candle directory.
 *
 * NEVER use process.cwd() here: the cron entries invoke the coordinator with an
 * absolute path and no `cd`, so cwd is the cron owner's home (/home/ubuntu).
 * process.cwd()-based resolution then points at /home/ubuntu/data/daily-candles
 * (nonexistent) → zero candles synced → SQLite stock_daily_history stalls →
 * the nightly screener coverage gate defers and never produces a snapshot →
 * Swing Konglo/Non-Konglo stay STALE_SNAPSHOT (production evidence:
 * stock_daily_history stalled at 2026-09-29, Swing frozen since 2026-09-30).
 *
 * This module lives at <repo>/lib/, so the repo root is one level up.
 */
function defaultCandleDir() {
  return process.env.CANDLE_CACHE_DIR || path.join(__dirname, '..', 'data', 'daily-candles');
}

function safeTicker(ticker) {
  return String(ticker || '').trim().replace(/\.JK$/i, '').toUpperCase().replace(/[^A-Z0-9._-]/g, '');
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isPositive(value) {
  const n = finiteNumber(value);
  return n !== null && n > 0;
}

function validDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Determine if the runtime is in an active production market-history writer context.
 */
function isProductionWriterContext(env) {
  const source = env || process.env;
  if (source.NODE_ENV === 'production' || source.AUTO_CUAN_PRODUCTION_ROUTING === '1') {
    return true;
  }
  // Host has runner directory and test mode is not explicitly active
  const runnerDir = source.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  if (fs.existsSync(runnerDir) && source.AUTO_CUAN_TEST_MODE !== '1') {
    return true;
  }
  return false;
}

/**
 * Resolve the store client used for the sync.
 * Priority: VPS SQLite (canonical) -> fail-closed in production -> hybrid Supabase fallback (test/dev) -> null.
 */
function resolveSyncClient(env) {
  const source = env || process.env;
  if (marketDataVpsEnabled(source)) {
    const dbPath = (source && source.AUTO_CUAN_MARKET_DB) || process.env.AUTO_CUAN_MARKET_DB;
    try { return { client: getVpsMarketStore(dbPath), store: 'vps_sqlite' }; }
    catch (_) { return { client: null, store: 'vps_sqlite_unavailable' }; }
  }

  // BUG-3C-03 Section 11 fail-closed assertion:
  // In a production market-history writer context, canonical store is VPS SQLite.
  // If VPS routing is expected but resolves to Supabase instead, fail loudly.
  if (isProductionWriterContext(source)) {
    return { client: null, store: 'MARKET_HISTORY_STORE_MISMATCH' };
  }

  // Documented safe fallback for non-production tests / local development
  if (source.SUPABASE_URL && source.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      return {
        client: createHybridClient(source.SUPABASE_URL, source.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false }
        }),
        store: 'hybrid_client'
      };
    } catch (_) {
      return { client: null, store: 'hybrid_unavailable' };
    }
  }
  return { client: null, store: 'market_store_unavailable' };
}

function listCandleTickers(candleDir) {
  try {
    return fs.readdirSync(candleDir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .map((name) => safeTicker(name.replace(/\.json$/i, '')))
      .filter(Boolean)
      .sort();
  } catch (_) {
    return [];
  }
}

function readCandleFile(candleDir, ticker) {
  try {
    const raw = fs.readFileSync(path.join(candleDir, ticker + '.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.candles) ? parsed.candles : [];
  } catch (_) {
    return null;
  }
}

/**
 * Build stock_daily_history rows from one ticker's candle series.
 * Only dates inside `allowedDates` and not after `todayWib` are accepted.
 */
function buildRowsForTicker(ticker, candles, options) {
  const opts = options || {};
  const allowedDates = opts.allowedDates || new Set();
  const todayWib = opts.todayWib || null;
  const sourceTimestamp = opts.sourceTimestamp || new Date().toISOString();
  const rows = [];
  const stats = {
    skipped_invalid: 0,
    skipped_outside_window: 0,
    skipped_future: 0,
    zero_open_skipped: 0,
    ohlc_invariant_violated: 0
  };

  // Dedupe by date: a flat file with a duplicated date must yield ONE logical row
  // (matching the store conflict key (ticker, trade_date)) and the liquid,
  // most-recently-parsed occurrence wins so an older bar can never replace a
  // newer bar for the same session within a single reconciliation pass.
  const byDate = new Map();
  for (const candle of (Array.isArray(candles) ? candles : [])) {
    const date = String((candle && (candle.date || candle.price_date)) || '').slice(0, 10);
    if (!validDateKey(date)) continue;
    // A later duplicate entry supersedes an earlier one for the same date.
    byDate.set(date, candle);
  }

  const series = Array.from(byDate.entries())
    .map(([date, candle]) => ({ candle, date }))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 0; i < series.length; i += 1) {
    const { candle, date } = series[i];
    if (todayWib && date > todayWib) { stats.skipped_future += 1; continue; }
    if (allowedDates.size && !allowedDates.has(date)) { stats.skipped_outside_window += 1; continue; }

    const open = finiteNumber(candle.open);
    const high = finiteNumber(candle.high);
    const low = finiteNumber(candle.low);
    const close = finiteNumber(candle.close);
    const volume = finiteNumber(candle.volume);

    if (open !== null && open <= 0) stats.zero_open_skipped += 1;
    const positive = close !== null && close > 0 &&
      (open === null || open > 0) &&
      (high === null || high > 0) &&
      (low === null || low > 0) &&
      (volume === null || volume >= 0);

    // OHLC geometric invariant: high must be the max and low the min of the
    // session (high >= {low,open,close}; low <= {open,close}). It is only
    // meaningful when all four OHLC fields are strictly positive; a
    // zero/negative open or missing close is already rejected by `positive` and
    // must stay classified as skipped_invalid (or zero_open_skipped) so the
    // pre-existing SYNC-E accounting contract is preserved.
    const allOhlcPositive = open > 0 && high > 0 && low > 0 && close > 0;
    let ohlcInvariant = true;
    if (allOhlcPositive) {
      ohlcInvariant = high >= low && high >= open && high >= close && low <= open && low <= close;
    }

    // Date-aware IHSG anomaly validation (R13): protect modern era 6000-8500 while preserving historical <2024
    let ihsgValid = true;
    if (safeTicker(ticker) === 'IHSG' || safeTicker(ticker) === 'COMPOSITE') {
      ihsgValid = isValidIhsgCandle({ close, date });
    }

    const valid = positive && ohlcInvariant && ihsgValid;
    if (!valid) {
      if (allOhlcPositive && !ohlcInvariant) stats.ohlc_invariant_violated += 1;
      else stats.skipped_invalid += 1;
      continue;
    }

    const prior = i > 0 ? series[i - 1].candle : null;
    const priorClose = prior ? finiteNumber(prior.close) : null;
    rows.push({
      ticker,
      trade_date: date,
      open,
      high,
      low,
      close,
      previous_close: priorClose,
      volume,
      data_source: String((candle && candle.source) || 'daily_candles_flat_file'),
      source_timestamp: sourceTimestamp,
      data_quality_status: String((candle && candle.data_quality_status) || 'ok')
    });
  }
  return { rows, stats };
}

/**
 * Sync the canonical flat-file candles into stock_daily_history.
 *
 * @param {Object} [options]
 * @param {Object} [options.client] store client override (tests)
 * @param {string} [options.candleDir] flat-file candle directory
 * @param {string[]} [options.tickers] explicit ticker list
 * @param {number} [options.sessions] rolling window in trading sessions
 * @param {Date|string|number} [options.now] instant used to resolve "today"
 * @param {Set|Array} [options.holidaySet] IDX holiday set override
 * @param {Object} [options.env] env for client resolution
 * @returns {Promise<Object>} { ok, store, window, tickers_scanned, rows_upserted, ... }
 */
async function syncRecentHistoryToSqlite(options) {
  const opts = options || {};
  const now = opts.now == null ? new Date() : opts.now;
  const wib = getWibComponents(now);
  if (!wib || !wib.isValid) return { ok: false, reason: 'invalid_now' };
  const todayWib = wib.dateStr;

  let sessions = Number.isInteger(opts.sessions) ? opts.sessions : DEFAULT_RECENT_SESSIONS;
  sessions = Math.max(1, Math.min(sessions, MAX_RECENT_SESSIONS));
  const holidaySet = opts.holidaySet instanceof Set
    ? opts.holidaySet
    : calendar.getSeedHolidaySet();

  // Rolling window of the most recent completed trading sessions. When today
  // is a trading day it is included: the coordinator runs at/after 18:00 WIB,
  // after the EOD candle is expected to exist. A missing today's candle simply
  // yields no row for it (recovered by the next run).
  const window = calendar.getLastTradingDays(todayWib, sessions, holidaySet);
  const allowedDates = new Set(window);

  let client = opts.client || null;
  let storeName = 'injected';
  if (!client) {
    const resolved = resolveSyncClient(opts.env);
    client = resolved.client;
    storeName = resolved.store;
    if (!client) return { ok: false, reason: storeName };
  }

  const candleDir = opts.candleDir || defaultCandleDir();
  const tickers = Array.isArray(opts.tickers) && opts.tickers.length
    ? Array.from(new Set(opts.tickers.map(safeTicker).filter(Boolean))).sort()
    : listCandleTickers(candleDir);
  if (!tickers.length) return { ok: false, reason: 'no_candles_found', candle_dir: candleDir };

  const sourceTimestamp = new Date(now).toISOString();
  const allRows = [];
  const totals = {
    skipped_invalid: 0,
    skipped_outside_window: 0,
    skipped_future: 0,
    zero_open_skipped: 0,
    ohlc_invariant_violated: 0
  };
  let tickersWithRows = 0;
  let tickersUnreadable = 0;
  let tickersUnavailable = 0;
  let tickersStale = 0;

  // The newest session the rolling window expects valid rows for. A ticker whose
  // newest flat-file candle is strictly older than this is STALE (the provider
  // has not published/merged today's bar yet), not silently "successful".
  // `window` from getLastTradingDays is newest-first ([today, H-1, H-2, ...]).
  const newestWindowDate = window.length ? window[0] : null;

  // Per-ticker telemetry: expected / updated / skipped / stale / failed /
  // unavailable. Emitted on every return so the coordinator can gate SUCCESS on
  // the absence of `failed` and `stale` instead of inferring from row counts.
  const perTicker = {};

  const readCandlesFor = (ticker) => {
    const filePath = path.join(candleDir, ticker + '.json');
    if (!fs.existsSync(filePath)) return { status: 'unavailable', candles: null };
    const candles = readCandleFile(candleDir, ticker);
    return candles === null ? { status: 'failed', candles: null } : { status: 'ok', candles };
  };

  for (const ticker of tickers) {
    const outcome = readCandlesFor(ticker);
    const entry = { expected: 0, updated: 0, skipped: 0, stale: 0, failed: 0, unavailable: 0 };

    if (outcome.status === 'unavailable') {
      entry.unavailable = 1;
      tickersUnavailable += 1;
      perTicker[ticker] = entry;
      continue;
    }
    if (outcome.status === 'failed') {
      entry.failed = 1;
      tickersUnreadable += 1;
      perTicker[ticker] = entry;
      continue;
    }

    const built = buildRowsForTicker(ticker, outcome.candles, { allowedDates, todayWib, sourceTimestamp });
    totals.skipped_invalid += built.stats.skipped_invalid;
    totals.skipped_outside_window += built.stats.skipped_outside_window;
    totals.skipped_future += built.stats.skipped_future;
    totals.zero_open_skipped += built.stats.zero_open_skipped;
    totals.ohlc_invariant_violated += built.stats.ohlc_invariant_violated;

    if (built.rows.length) {
      tickersWithRows += 1;
      allRows.push(...built.rows);
    }

    entry.expected = allowedDates.size || 1;
    entry.updated = built.rows.length;
    entry.skipped = built.stats.skipped_invalid + built.stats.skipped_outside_window +
      built.stats.skipped_future + built.stats.zero_open_skipped + built.stats.ohlc_invariant_violated;

    // Stale detection: candle series exists but its latest bar predates the
    // newest session the rolling window advertises.
    const latestRow = built.rows.length ? built.rows[built.rows.length - 1].trade_date : null;
    if (newestWindowDate && (!latestRow || latestRow < newestWindowDate)) {
      entry.stale = 1;
      tickersStale += 1;
    }
    perTicker[ticker] = entry;
  }

  const buildResultBase = {
    store: storeName,
    window,
    tickers_scanned: tickers.length,
    tickers_with_rows: tickersWithRows,
    tickers_unreadable: tickersUnreadable,
    tickers_unavailable: tickersUnavailable,
    tickers_stale: tickersStale,
    per_ticker: perTicker,
    ...totals
  };

  if (!flatFilesExisted(tickers, candleDir)) {
    // No ticker input existed at all — nothing to reconcile (e.g. mounted dir
    // empty after a fresh deploy). Distinct from a provider outage: this is a
    // terminal no-op, not a stale-store condition.
    return Object.assign({ ok: false, reason: 'no_candles_found', candle_dir: candleDir, rows_upserted: 0 }, buildResultBase);
  }

  if (!allRows.length) {
    return Object.assign({ ok: true, rows_upserted: 0 }, buildResultBase);
  }

  let rowsUpserted = 0;
  try {
    rowsUpserted = await historyStore.upsertDailyHistory(client, allRows);
  } catch (error) {
    return Object.assign({
      ok: false,
      reason: 'upsert_failed',
      error: String(error && error.message || error).slice(0, 200),
      rows_upserted: 0
    }, buildResultBase);
  }

  return Object.assign({ ok: true, rows_upserted: rowsUpserted }, buildResultBase);
}

/**
 * True when at least one ticker flat file physically exists. Mirrors listCandleTickers
 * semantics but distinguishes "no files at all" from "files present but unreadable".
 */
function flatFilesExisted(tickers, candleDir) {
  for (const ticker of tickers) {
    if (fs.existsSync(path.join(candleDir, ticker + '.json'))) return true;
  }
  return false;
}

/**
 * Sinkronisasi rentang tanggal tertentu ke SQLite KV market_rows (R06, R07).
 *
 * Mendukung mode dryRun untuk audit non-destruktif dan mode live berbasis
 * transaksi SQLite terverifikasi dengan kueri canonical:
 * SELECT count(*), max(json_extract(row_json, '$.trade_date'))
 * FROM market_rows WHERE table_name = 'stock_daily_history'
 *
 * @param {Object} options
 * @param {string} [options.dbPath] Path file database SQLite
 * @param {string} [options.candleDir] Direktori sumber flat candle
 * @param {string} options.startDate Tanggal mulai format YYYY-MM-DD
 * @param {string} options.endDate Tanggal akhir format YYYY-MM-DD
 * @param {boolean} [options.dryRun=false] Mode simulasi (tanpa mutasi database)
 * @param {string[]} [options.tickers] Daftar ticker spesifik
 * @param {Object} [options.client] Client override untuk pengetesan
 * @param {Object} [options.env] Environment override
 * @returns {Promise<Object>}
 */
async function syncDateRange(options) {
  const opts = options || {};
  const startDate = String(opts.startDate || '');
  const endDate = String(opts.endDate || '');
  const dryRun = opts.dryRun === true;

  if (!validDateKey(startDate) || !validDateKey(endDate)) {
    return { ok: false, reason: 'invalid_date_range', startDate, endDate };
  }
  if (startDate > endDate) {
    return { ok: false, reason: 'start_date_after_end_date', startDate, endDate };
  }

  const candleDir = opts.candleDir || defaultCandleDir();
  const tickers = Array.isArray(opts.tickers) && opts.tickers.length
    ? Array.from(new Set(opts.tickers.map(safeTicker).filter(Boolean))).sort()
    : listCandleTickers(candleDir);

  if (!tickers.length) {
    return { ok: false, reason: 'no_candles_found', candle_dir: candleDir };
  }

  let client = opts.client || null;
  let storeName = 'injected';
  if (!client) {
    if (opts.dbPath) {
      try {
        client = getVpsMarketStore(opts.dbPath);
        storeName = 'vps_sqlite_custom';
      } catch (err) {
        return { ok: false, reason: 'db_open_failed', error: String(err && err.message || err) };
      }
    } else if (dryRun) {
      storeName = 'dry_run_simulation';
      client = { dryRun: true };
    } else {
      const resolved = resolveSyncClient(opts.env);
      client = resolved.client;
      storeName = resolved.store;
      if (!client) return { ok: false, reason: storeName };
    }
  }

  const allRows = [];
  const totals = {
    skipped_invalid: 0,
    skipped_outside_window: 0,
    skipped_future: 0,
    zero_open_skipped: 0,
    ohlc_invariant_violated: 0
  };
  let tickersWithRows = 0;

  for (const ticker of tickers) {
    const rawCandles = readCandleFile(candleDir, ticker);
    if (!Array.isArray(rawCandles) || !rawCandles.length) continue;

    // Filter candle dalam rentang [startDate, endDate]
    const filteredCandles = rawCandles.filter((c) => {
      const d = String((c && (c.date || c.time || c.price_date)) || '').slice(0, 10);
      return d >= startDate && d <= endDate;
    });

    if (!filteredCandles.length) continue;

    const allowedDates = new Set(filteredCandles.map((c) => String(c.date || c.time || '').slice(0, 10)));
    const built = buildRowsForTicker(ticker, filteredCandles, { allowedDates, todayWib: endDate });

    totals.skipped_invalid += built.stats.skipped_invalid;
    totals.skipped_outside_window += built.stats.skipped_outside_window;
    totals.skipped_future += built.stats.skipped_future;
    totals.zero_open_skipped += built.stats.zero_open_skipped;
    totals.ohlc_invariant_violated += built.stats.ohlc_invariant_violated;

    if (built.rows.length) {
      tickersWithRows += 1;
      allRows.push(...built.rows);
    }
  }

  const summary = {
    store: storeName,
    start_date: startDate,
    end_date: endDate,
    dry_run: dryRun,
    tickers_scanned: tickers.length,
    tickers_with_rows: tickersWithRows,
    total_valid_rows: allRows.length,
    ...totals
  };

  if (dryRun) {
    return Object.assign({ ok: true, rows_upserted: 0, message: 'DRY_RUN_SUCCESS_NO_DB_WRITE' }, summary);
  }

  if (!allRows.length) {
    return Object.assign({ ok: true, rows_upserted: 0, message: 'NO_ROWS_IN_RANGE' }, summary);
  }

  let rowsUpserted = 0;
  try {
    rowsUpserted = await historyStore.upsertDailyHistory(client, allRows);
  } catch (error) {
    return Object.assign({
      ok: false,
      reason: 'upsert_failed',
      error: String(error && error.message || error).slice(0, 200),
      rows_upserted: 0
    }, summary);
  }

  // Canonical KV verification query: SELECT count(*), max(json_extract(row_json, '$.trade_date'))
  let verifiedCount = null;
  let maxTradeDate = null;
  try {
    if (client.db && typeof client.db.prepare === 'function') {
      const stmt = client.db.prepare(
        "SELECT count(*) as count, max(json_extract(row_json, '$.trade_date')) as max_date " +
        "FROM market_rows WHERE table_name = 'stock_daily_history'"
      );
      const row = stmt.get();
      if (row) {
        verifiedCount = row.count;
        maxTradeDate = row.max_date;
      }
    }
  } catch (_) {}

  return Object.assign({
    ok: true,
    rows_upserted: rowsUpserted,
    verified_count: verifiedCount,
    max_trade_date: maxTradeDate
  }, summary);
}

module.exports = {
  DEFAULT_RECENT_SESSIONS,
  MAX_RECENT_SESSIONS,
  defaultCandleDir,
  resolveSyncClient,
  isProductionWriterContext,
  listCandleTickers,
  readCandleFile,
  buildRowsForTicker,
  syncRecentHistoryToSqlite,
  syncDateRange
};

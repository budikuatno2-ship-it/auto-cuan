'use strict';

/**
 * FIX 4 — canonical stock_daily_history source (READ-ONLY).
 *
 * Pattern Radar previously read a stale flat-file cache (2026-11-04, BBCA
 * 9860). This module binds the scan to the canonical market.sqlite snapshot's
 * `stock_daily_history` table (max date 2026-11-20, BBCA 5550 / 147637100)
 * without ever writing to the database or issuing an HTTP request.
 *
 * Contract:
 *  - opens the configured market DB with readOnly:true, fileMustExist:true
 *  - never writes a file, never retries upstream, never calls a paid provider
 *  - returns real OHLCV rows only; missing data is NO_DATA, never fabricated
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANONICAL_SNAPSHOT_REL = path.join(
  'audit-evidence', 'v6_recovery_17nov', 'polish_final_20261121_v1',
  'task_1_4', 'market.sqlite.snapshot'
);
const CANONICAL_SHA256_PREFIX = 'c2128eb8';
const DATA_SOURCE = 'stock_daily_history (canonical market.sqlite snapshot)';

let cache = null;
let cacheStamp = null;

function getDbStamp(fp) {
  if (!fp) return null;
  try {
    const st = fs.statSync(fp);
    let wal = 'nowal';
    try {
      const wst = fs.statSync(fp + '-wal');
      wal = `${wst.ino}:${wst.size}:${wst.mtimeMs}`;
    } catch (_) {}
    return `${fp}|${st.ino}:${st.size}:${st.mtimeMs}|${wal}`;
  } catch (_) {
    return null;
  }
}

function resolveDbPath() {
  const candidates = [];
  if (process.env.AUTO_CUAN_MARKET_DB) candidates.push(process.env.AUTO_CUAN_MARKET_DB);
  candidates.push('/home/ubuntu/auto-cuan-data/market.sqlite');
  candidates.push(path.resolve(__dirname, '..', 'data', 'market.sqlite'));
  candidates.push(path.resolve(__dirname, '..', CANONICAL_SNAPSHOT_REL));
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function sha256File(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.size > 25 * 1024 * 1024) {
      return crypto.createHash('sha256').update(String(getDbStamp(fp) || fp)).digest('hex');
    }
    return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
  } catch (_) { return null; }
}

/**
 * Load all canonical daily candles grouped by ticker, ascending by trade date.
 * Returns { status, meta, byTicker }.
 */
function loadCanonicalDailyHistory() {
  const dbPath = resolveDbPath();
  const currentStamp = getDbStamp(dbPath);
  if (cache && currentStamp && currentStamp === cacheStamp) return cache;
  const empty = {
    status: 'NO_DATA',
    meta: {
      data_source: DATA_SOURCE, rows: 0, tickers: 0, max_date: null,
      db_path: dbPath || null, sha256: null, verified: false
    },
    byTicker: new Map()
  };
  if (!dbPath) { cache = empty; cacheStamp = null; return cache; }

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (_) { cache = empty; cacheStamp = null; return cache; }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, fileMustExist: true, timeout: 15000 });
  } catch (_) { cache = empty; cacheStamp = null; return cache; }

  try {
    const rows = db.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_daily_history'"
    ).all();
    const byTicker = new Map();
    let maxDate = '';
    for (const row of rows) {
      let payload;
      try { payload = JSON.parse(row.row_json); } catch (_) { continue; }
      const ticker = String(payload.ticker || String(row.row_key || '').split('\u001f')[0] || '').trim().toUpperCase();
      const date = String(payload.trade_date || '').slice(0, 10);
      const close = Number(payload.close);
      if (!/^[A-Z0-9.]{1,10}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!Number.isFinite(close) || close <= 0) continue;
      if (date > maxDate) maxDate = date;
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push({
        time: date,
        open: Number(payload.open) || close,
        high: Number(payload.high) || close,
        low: Number(payload.low) || close,
        close,
        volume: Number(payload.volume) || 0
      });
    }
    for (const list of byTicker.values()) list.sort((a, b) => a.time.localeCompare(b.time));

    const sha = sha256File(dbPath);
    const verified = Boolean(sha && sha.startsWith(CANONICAL_SHA256_PREFIX));
    cache = {
      status: rows.length > 0 ? 'OK' : 'NO_DATA',
      meta: {
        status: rows.length > 0 ? 'OK' : 'NO_DATA',
        data_source: DATA_SOURCE,
        rows: rows.length,
        tickers: byTicker.size,
        max_date: maxDate || null,
        db_path: dbPath,
        sha256: sha,
        verified
      },
      byTicker
    };
    cacheStamp = currentStamp;
    return cache;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function getCanonicalDailyHistoryMeta() {
  return Object.assign({}, loadCanonicalDailyHistory().meta);
}

function getCanonicalCandles(ticker, limit) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/\.JK$/i, '');
  const list = loadCanonicalDailyHistory().byTicker.get(clean) || [];
  const n = Number(limit) > 0 ? Number(limit) : list.length;
  return list.slice(-n).map((c) => Object.assign({}, c));
}

function clearCanonicalDailyHistoryCache() { cache = null; cacheStamp = null; }

module.exports = {
  DATA_SOURCE,
  CANONICAL_SNAPSHOT_REL,
  CANONICAL_SHA256_PREFIX,
  loadCanonicalDailyHistory,
  getCanonicalDailyHistoryMeta,
  getCanonicalCandles,
  clearCanonicalDailyHistoryCache
};

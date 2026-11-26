'use strict';

/**
 * Shared read/hydration bridge for Arjum market data stored canonically in
 * VPS SQLite (`market_rows` tables: arjum_broker_summary_all,
 * arjum_broker_summary_foreign, arjum_insiders).
 *
 * Ensures downstream scripts and runtime readers consume canonical SQLite rows
 * with zero Stock Arjum API calls before falling back to network or skipping
 * dates already persisted in SQLite.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const broksumProvenance = require('./broksum-provenance');

const ROOT = path.resolve(__dirname, '..');
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Z0-9.-]{2,12}$/;

const FLOW_TO_TABLE = Object.freeze({
  ALL: 'arjum_broker_summary_all',
  F: 'arjum_broker_summary_foreign',
  INSIDER: 'arjum_insiders'
});

let cachedDbPath = null;
let cachedDb = null;

function resolveSqliteDbPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AUTO_CUAN_MARKET_DB,
    '/home/ubuntu/auto-cuan-data/market.sqlite',
    path.join(ROOT, 'data', 'market.sqlite')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function getReadonlyDb(explicitPath) {
  const dbPath = resolveSqliteDbPath(explicitPath);
  if (!dbPath) return null;
  if (cachedDb && cachedDbPath === dbPath) return cachedDb;

  try {
    if (cachedDb) {
      try { cachedDb.close(); } catch (_) {}
    }
    const { DatabaseSync } = require('node:sqlite');
    cachedDb = new DatabaseSync(dbPath, { readOnly: true });
    cachedDbPath = dbPath;
    return cachedDb;
  } catch (_) {
    cachedDb = null;
    cachedDbPath = null;
    return null;
  }
}

function closeReadonlyDb() {
  if (cachedDb) {
    try { cachedDb.close(); } catch (_) {}
  }
  cachedDb = null;
  cachedDbPath = null;
}

function normalizeTicker(ticker) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/\.JK$/i, '');
  return TICKER_RE.test(clean) ? clean : '';
}

function normalizeDate(date) {
  const raw = String(date || '').trim().slice(0, 10);
  return DATE_KEY_RE.test(raw) ? raw : '';
}

function tableForFlow(flow) {
  const key = String(flow || 'all').trim().toUpperCase();
  if (key === 'F' || key === 'FOREIGN') return FLOW_TO_TABLE.F;
  if (key === 'INSIDER' || key === 'INSIDERS') return FLOW_TO_TABLE.INSIDER;
  return FLOW_TO_TABLE.ALL;
}

function keyCandidates(ticker, date) {
  return [
    `${ticker} ${date}`,
    `${ticker}|${date}`,
    `${date}|${ticker}`,
    `${date} ${ticker}`
  ];
}

function extractTickerFromRowKey(rowKey, date) {
  const s = String(rowKey || '').trim().toUpperCase();
  if (!s) return '';
  if (date) {
    if (s.endsWith(' ' + date)) return normalizeTicker(s.slice(0, -(date.length + 1)));
    if (s.endsWith('|' + date)) return normalizeTicker(s.slice(0, -(date.length + 1)));
    if (s.startsWith(date + '|')) return normalizeTicker(s.slice(date.length + 1));
    if (s.startsWith(date + ' ')) return normalizeTicker(s.slice(date.length + 1));
  }
  const parts = s.split(/[\s|]+/).filter(Boolean);
  for (const part of parts) {
    if (!DATE_KEY_RE.test(part) && TICKER_RE.test(part)) return normalizeTicker(part);
  }
  return '';
}

function readArjumRowFromSqlite(tableName, ticker, date, options = {}) {
  const cleanTicker = normalizeTicker(ticker);
  if (!cleanTicker || !tableName) return null;

  const db = options.db || getReadonlyDb(options.dbPath);
  if (!db) return null;

  const safeDate = date === 'latest' ? 'latest' : normalizeDate(date);
  try {
    let row = null;
    if (safeDate && safeDate !== 'latest') {
      const candidates = keyCandidates(cleanTicker, safeDate);
      row = db.prepare(
        'SELECT row_json FROM market_rows WHERE table_name = ? AND row_key IN (?, ?, ?, ?) LIMIT 1'
      ).get(tableName, ...candidates);
    } else {
      row = db.prepare(
        'SELECT row_json FROM market_rows WHERE table_name = ? AND (row_key LIKE ? OR row_key LIKE ? OR row_key LIKE ?) ORDER BY updated_at DESC LIMIT 1'
      ).get(tableName, `${cleanTicker} %`, `${cleanTicker}|%`, `%|${cleanTicker}`);
    }
    if (!row || !row.row_json) return null;
    const parsed = JSON.parse(row.row_json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isUsableSqliteBrokerPayload(payload, ticker, date, flow) {
  if (!payload || typeof payload !== 'object') return false;
  const cleanFlow = String(flow || 'all').trim().toUpperCase();
  if (cleanFlow === 'F') {
    const verdict = broksumProvenance.isActionableBrokerDataset({
      dataset: payload,
      date: date && date !== 'latest' ? date : undefined,
      ticker,
      flow: 'F'
    });
    return Boolean(verdict && verdict.actionable);
  }
  if (cleanFlow === 'INSIDER' || cleanFlow === 'INSIDERS') {
    const status = String(payload._fetch_meta && payload._fetch_meta.status || '').toUpperCase();
    return Array.isArray(payload.items) || Array.isArray(payload.data) || status === 'OK' || status === 'EMPTY_CONFIRMED';
  }
  const hasBrokers = Array.isArray(payload.brokers) || Array.isArray(payload.broker_levels) ||
    Array.isArray(payload.top_buyers) || Array.isArray(payload.top_sellers);
  const status = String(payload._fetch_meta && payload._fetch_meta.status || '').toUpperCase();
  return hasBrokers || status === 'EMPTY_CONFIRMED' || payload.empty_confirmed === true;
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function targetCachePath(baseDir, ticker, date, flow) {
  const cleanTicker = normalizeTicker(ticker);
  const safeDate = normalizeDate(date);
  if (!baseDir || !cleanTicker || !safeDate) return null;
  const cleanFlow = String(flow || 'all').trim().toUpperCase();
  if (cleanFlow === 'F') return path.join(baseDir, 'broker-summary-F', cleanTicker, `${safeDate}.json`);
  if (cleanFlow === 'INSIDER' || cleanFlow === 'INSIDERS') return path.join(baseDir, 'insiders', cleanTicker, `${safeDate}.json`);
  return path.join(baseDir, 'broker-summary', cleanTicker, `${safeDate}.json`);
}

function hydrateFromSqliteIfPresent(options = {}) {
  const ticker = normalizeTicker(options.ticker);
  const date = options.date === 'latest' ? 'latest' : normalizeDate(options.date);
  const flow = String(options.flow || 'all').trim().toUpperCase();
  if (!ticker || !date) return null;

  const tableName = tableForFlow(flow);
  const payload = readArjumRowFromSqlite(tableName, ticker, date, options);
  if (!isUsableSqliteBrokerPayload(payload, ticker, date, flow)) return null;

  if (options.hydrateToDisk !== false && options.baseDir && date !== 'latest') {
    const outPath = targetCachePath(options.baseDir, ticker, date, flow);
    if (outPath && !fs.existsSync(outPath)) {
      try { atomicWriteJson(outPath, payload); } catch (_) {}
    }
  }
  return payload;
}

function readAllDateRowsForTickerFromSqlite(tableName, ticker, options = {}) {
  const cleanTicker = normalizeTicker(ticker);
  if (!cleanTicker || !tableName) return [];
  const db = options.db || getReadonlyDb(options.dbPath);
  if (!db) return [];

  try {
    const rows = db.prepare(
      'SELECT row_key, row_json FROM market_rows WHERE table_name = ? AND (row_key LIKE ? OR row_key LIKE ? OR row_key LIKE ?) ORDER BY row_key ASC'
    ).all(tableName, `${cleanTicker} %`, `${cleanTicker}|%`, `%|${cleanTicker}`);
    const out = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.row_json);
        if (!parsed || typeof parsed !== 'object') continue;
        const date = normalizeDate(
          (parsed._fetch_meta && parsed._fetch_meta.trade_date) ||
          parsed.date ||
          parsed.broker_start_date ||
          String(r.row_key || '').split(/[\s|]+/).find((p) => DATE_KEY_RE.test(p)) ||
          ''
        );
        if (date) out.push({ date, payload: parsed });
      } catch (_) {}
    }
    return out;
  } catch (_) {
    return [];
  }
}

function listRowsForDateFromSqlite(tableName, date, options = {}) {
  const safeDate = normalizeDate(date);
  if (!safeDate || !tableName) return new Map();
  const db = options.db || getReadonlyDb(options.dbPath);
  if (!db) return new Map();

  const out = new Map();
  try {
    const rows = db.prepare(
      'SELECT row_key, row_json FROM market_rows WHERE table_name = ? AND (row_key LIKE ? OR row_key LIKE ? OR row_key LIKE ? OR row_key LIKE ?)'
    ).all(tableName, `% ${safeDate}`, `%|${safeDate}`, `${safeDate}|%`, `${safeDate} %`);
    for (const r of rows) {
      const tk = extractTickerFromRowKey(r.row_key, safeDate);
      if (!tk) continue;
      try {
        const parsed = JSON.parse(r.row_json);
        if (parsed && typeof parsed === 'object') out.set(tk, parsed);
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function listTickersInSqliteTable(tableName, options = {}) {
  if (!tableName) return [];
  const db = options.db || getReadonlyDb(options.dbPath);
  if (!db) return [];

  const set = new Set();
  try {
    const rows = db.prepare('SELECT row_key FROM market_rows WHERE table_name = ?').all(tableName);
    for (const r of rows) {
      const tk = extractTickerFromRowKey(r.row_key, null);
      if (tk) set.add(tk);
    }
  } catch (_) {}
  return Array.from(set).sort();
}

module.exports = {
  FLOW_TO_TABLE,
  resolveSqliteDbPath,
  getReadonlyDb,
  closeReadonlyDb,
  tableForFlow,
  readArjumRowFromSqlite,
  isUsableSqliteBrokerPayload,
  hydrateFromSqliteIfPresent,
  readAllDateRowsForTickerFromSqlite,
  listRowsForDateFromSqlite,
  listTickersInSqliteTable
};

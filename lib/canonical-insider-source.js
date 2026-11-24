'use strict';

/**
 * FIX 3 — canonical arjum_insiders source (READ-ONLY).
 *
 * The served Insider network used a hard-coded BBCA graph and a separate
 * insiders-db.json disk cache. This module binds the network to the canonical
 * snapshot table `arjum_insiders` (3,852 rows / 963 issuers / max date
 * 2026-11-20) without ever writing to the database.
 *
 * Contract:
 *  - opens the configured market DB with readOnly:true, fileMustExist:true
 *  - never issues an HTTP request, never writes a file, never retries upstream
 *  - every returned record carries explicit `data_source` and `as_of`
 *  - missing data is reported as NO_DATA, never fabricated
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANONICAL_SNAPSHOT_REL = path.join(
  'audit-evidence', 'v6_recovery_17nov', 'polish_final_20261121_v1',
  'task_1_4', 'market.sqlite.snapshot'
);
const CANONICAL_SHA256_PREFIX = 'c2128eb8';
const DATA_SOURCE = 'Data Keterbukaan Insider IDX';

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

function parsePct(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/[%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Load the canonical universe. Returns { status, meta, records, byTicker }.
 * Safe to call repeatedly when DB unchanged; auto-refreshes when DB/WAL changes.
 */
function loadCanonicalInsiderUniverse() {
  const dbPath = resolveDbPath();
  const currentStamp = getDbStamp(dbPath);
  if (cache && currentStamp && currentStamp === cacheStamp) return cache;
  const empty = {
    status: 'NO_DATA',
    meta: {
      data_source: DATA_SOURCE,
      rows: 0, issuers: 0, max_date: null,
      db_path: dbPath || null, sha256: null,
      verified: false
    },
    records: [], byTicker: new Map()
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
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_insiders'"
    ).all();
    const byTicker = new Map();
    let maxDate = '';
    let itemCount = 0;
    for (const row of rows) {
      const key = String(row.row_key || '');
      const ticker = key.split(' ')[0].toUpperCase();
      if (!/^[A-Z0-9.]{1,10}$/.test(ticker)) continue;
      let payload;
      try { payload = JSON.parse(row.row_json); } catch (_) { continue; }
      const items = Array.isArray(payload.items) ? payload.items : [];
      const snapshotDate = key.slice(ticker.length + 1).trim() || null;
      if (snapshotDate && snapshotDate > maxDate) maxDate = snapshotDate;
      const normalized = items.map((it) => {
        if (it.date && String(it.date) > maxDate) maxDate = String(it.date);
        itemCount++;
        return {
          ticker,
          name: String(it.name || '').trim(),
          insider_name: String(it.name || '').trim(),
          date: it.date || null,
          action_type: String(it.action_type || '').toLowerCase() || 'unknown',
          nationality: it.nationality || 'unknown',
          shares: parseNum(it.current_value),
          shares_before: parseNum(it.previous_value),
          percentage: parsePct(it.current_percentage),
          percentage_before: parsePct(it.previous_percentage),
          change_percentage: parsePct(it.changes_percentage),
          broker_code: it.broker_code || null,
          badges: Array.isArray(it.badges) ? it.badges.slice() : [],
          data_source: DATA_SOURCE,
          as_of: it.date || snapshotDate || null,
          snapshot_date: snapshotDate
        };
      }).filter((r) => r.name);
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push(...normalized);
    }
    const sha = sha256File(dbPath);
    const verified = Boolean(sha && sha.startsWith(CANONICAL_SHA256_PREFIX));
    cache = {
      status: rows.length > 0 ? 'OK' : 'NO_DATA',
      meta: {
        status: rows.length > 0 ? 'OK' : 'NO_DATA',
        data_source: DATA_SOURCE,
        rows: rows.length,
        issuers: byTicker.size,
        items: itemCount,
        max_date: maxDate || null,
        db_path: dbPath,
        sha256: sha,
        verified
      },
      records: Array.from(byTicker.values()).reduce((a, b) => a.concat(b), []),
      byTicker
    };
    cacheStamp = currentStamp;
    return cache;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function getCanonicalInsiderMeta() {
  return Object.assign({}, loadCanonicalInsiderUniverse().meta);
}

function getCanonicalInsidersForTicker(ticker) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/\.JK$/i, '');
  const found = loadCanonicalInsiderUniverse().byTicker.get(clean) || [];
  return found.map((r) => Object.assign({}, r));
}

function getCanonicalInsiderUniverse() {
  return loadCanonicalInsiderUniverse().records.map((r) => Object.assign({}, r));
}

function clearCanonicalInsiderCache() { cache = null; cacheStamp = null; }

module.exports = {
  DATA_SOURCE,
  CANONICAL_SNAPSHOT_REL,
  CANONICAL_SHA256_PREFIX,
  loadCanonicalInsiderUniverse,
  getCanonicalInsiderMeta,
  getCanonicalInsidersForTicker,
  getCanonicalInsiderUniverse,
  clearCanonicalInsiderCache
};

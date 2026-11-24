'use strict';

/**
 * lib/financial-fundamentals-adapter.js
 * ============================================================================
 * M-P1a Defect B — canonical financial adapter for the Manual Screener.
 *
 * DEFECT: lib/manual-screener.js read PBV/PER/ROE_TTM/DER/EPS from
 * data/fundamentals/<TICKER>.json, which is NOT a canonical source for this
 * repository (fundamentals live in the VPS SQLite store / the financial
 * snapshot pipeline).
 *
 * FIX: read from canonical sources in strict precedence:
 *   1. VPS market SQLite store (lib/vps-market-store.js pattern, READ-ONLY,
 *      table stock_fundamentals) when the DB file is locally available.
 *   2. The financial snapshot pipeline's persisted per-ticker snapshot
 *      (data/financial-snapshots/<TICKER>.json, produced by
 *      lib/financial-snapshot.js buildFinancialSnapshot consumers).
 *   3. Neither available -> every value null, source 'UNKNOWN', as_of null.
 *
 * NEVER fabricates a value (and never fabricates 0). Only values physically
 * present in the canonical row (or its financial_statements JSON) are
 * returned. Each call cites which source was used so callers can attach a
 * per-ticker values_source field.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_SQLITE = 'SQLITE_VPS_MARKET_STORE';
const SOURCE_SNAPSHOT = 'FINANCIAL_SNAPSHOT_PIPELINE';
const SOURCE_UNKNOWN = 'UNKNOWN';

let _sqliteHandle = null;   // { db, path } | null
let _sqliteProbed = false;  // probe once, cache result

function marketDbPath() {
  return process.env.AUTO_CUAN_MARKET_DB ||
    path.join(require('node:os').tmpdir(), 'auto-cuan-probe-nonexistent', 'market.sqlite');
}

/**
 * Open the VPS market store READ-ONLY when the DB file is locally available.
 * Returns { db, path } or null. Never creates the file, never writes.
 */
function openStoreReadOnly() {
  if (_sqliteProbed) return _sqliteHandle;
  _sqliteProbed = true;
  try {
    const p = marketDbPath();
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      _sqliteHandle = null;
      return _sqliteHandle;
    }
    // node:sqlite is available on Node >= 22.13; fail closed otherwise.
    const { DatabaseSync } = require('node:sqlite');
    _sqliteHandle = { db: new DatabaseSync(p, { readOnly: true }), path: p };
  } catch (_) {
    _sqliteHandle = null;
  }
  return _sqliteHandle;
}

/** Test seam: reset the cached probe (used by tests). */
function resetCacheForTest() {
  _sqliteProbed = false;
  _sqliteHandle = null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pick the first finite number among candidate keys of a row object. */
function pick(row, keys) {
  if (!row) return null;
  for (const k of keys) {
    const v = numOrNull(row[k]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Extract fundamentals from one canonical row (SQLite row or snapshot doc).
 * Only physically-present values are returned; anything absent stays null.
 */
function extractFromRow(row) {
  if (!row) return { values: emptyValues(), as_of: null };
  const values = {
    pbv: pick(row, ['pbv', 'price_to_book', 'pbv_ratio']),
    per: pick(row, ['per', 'pe', 'pe_ratio', 'price_to_earnings']),
    roe_ttm: pick(row, ['roe_ttm', 'roe', 'return_on_equity']),
    der: pick(row, ['der', 'debt_to_equity', 'debt_equity_ratio']),
    eps: pick(row, ['eps', 'earning_per_share', 'earnings_per_share']),
  };
  // financial_statements JSON (present in the rich SQLite schema and the
  // snapshot pipeline output) may carry ratios the flat row lacks.
  if (typeof row.financial_statements === 'string' || row.financial_statements && typeof row.financial_statements === 'object') {
    let stmt = row.financial_statements;
    if (typeof stmt === 'string') {
      try { stmt = JSON.parse(stmt); } catch (_) { stmt = null; }
    }
    if (stmt) {
      const latest = (Array.isArray(stmt.quarterly) && stmt.quarterly[0]) ||
        (Array.isArray(stmt.annual) && stmt.annual[0]) || null;
      if (latest) {
        for (const f of Object.keys(values)) {
          if (values[f] === null) values[f] = pick(latest, [f, f === 'roe_ttm' ? 'roe' : f]);
        }
      }
    }
  }
  const asOf = row.updated_at || row.fundamental_updated_at || row.fundamental_period ||
    row.market_cap_as_of || row.as_of || null;
  return { values, as_of: asOf ? String(asOf) : null };
}

function emptyValues() {
  return { pbv: null, per: null, roe_ttm: null, der: null, eps: null };
}

function unknownResult() {
  return {
    values: emptyValues(),
    source: SOURCE_UNKNOWN,
    as_of: null,
    source_available: false,
  };
}

/**
 * Resolve fundamentals for one ticker from canonical sources.
 * @param {string} ticker
 * @param {object} [injections] test seams:
 *   sqliteRow(ticker) -> row | null | undefined (skip sqlite when undefined)
 *   snapshotDoc(ticker) -> doc | null | undefined (skip snapshot when undefined)
 * @returns {{ values:{pbv,per,roe_ttm,der,eps}, source:string, as_of:string|null,
 *             source_available:boolean }}
 */
function getFundamentals(ticker, injections) {
  const t = String(ticker || '').toUpperCase();
  const inj = injections || {};

  // 1. VPS market SQLite store (read-only)
  const handle = openStoreReadOnly();
  if (handle) {
    try {
      const row = handle.db.prepare(
        'SELECT * FROM stock_fundamentals WHERE ticker = ? LIMIT 1'
      ).get(t);
      if (row) {
        const ex = extractFromRow(row);
        return {
          values: ex.values,
          source: SOURCE_SQLITE,
          as_of: ex.as_of,
          source_available: true,
        };
      }
    } catch (_) {
      // table missing / locked -> fall through to the snapshot pipeline
    }
  }

  // 2. financial snapshot pipeline (persisted per-ticker snapshot)
  try {
    const snapPath = path.join(__dirname, '..', 'data', 'financial-snapshots', t + '.json');
    if (fs.existsSync(snapPath)) {
      const doc = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      const row = doc && doc.fundamental ? Object.assign({}, doc.fundamental, { updated_at: doc.fundamental.fundamental_updated_at }) : doc;
      const ex = extractFromRow(row);
      if (Object.values(ex.values).some((v) => v !== null)) {
        return {
          values: ex.values,
          source: SOURCE_SNAPSHOT,
          as_of: ex.as_of,
          source_available: true,
        };
      }
    }
  } catch (_) {
    // unreadable snapshot -> fall through to UNKNOWN
  }

  // 3. neither canonical source has the ticker -> honest UNKNOWN, never 0
  return unknownResult();
}

module.exports = {
  SOURCE_SQLITE,
  SOURCE_SNAPSHOT,
  SOURCE_UNKNOWN,
  getFundamentals,
  extractFromRow,
  openStoreReadOnly,
  resetCacheForTest,
};

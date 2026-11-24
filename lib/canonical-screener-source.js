'use strict';

/**
 * FIX 5 — canonical fresh screener source (READ-ONLY local snapshot).
 *
 * The live screener was serving a 3 Nov 2026 snapshot (~426h old). This module
 * binds /api/screener to the one measured local regeneration produced from the
 * canonical stock_daily_history snapshot through 20 Nov 2026. It never writes
 * to market.sqlite, never calls a paid provider, and never fabricates a row.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_REL = path.join(
  'audit-evidence', 'v6_recovery_17nov', 'unified_final_20261122_v1',
  'fix4_5', 'swing_screener_latest.canonical-20261120.json'
);
const EXPECTED_SHA256 = '4ec75c3b0b06369a8146c32c128ba84ccd9c8fefdc9773b86fa8c83daf5ebf72';
const DATA_SOURCE = 'canonical stock_daily_history local regeneration (20 Nov 2026)';

let cache = null;

function resolvePath() {
  const p = path.resolve(__dirname, '..', SNAPSHOT_REL);
  try { return fs.existsSync(p) ? p : null; } catch (_) { return null; }
}

function sha256File(fp) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); }
  catch (_) { return null; }
}

function loadCanonicalScreener() {
  if (cache) return cache;
  const fp = resolvePath();
  const empty = {
    status: 'NO_DATA',
    meta: { data_source: DATA_SOURCE, rows: 0, trade_date: null, sha256: null, verified: false },
    rows: []
  };
  if (!fp) { cache = empty; return cache; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { cache = empty; return cache; }
  const sha = sha256File(fp);
  const rows = Array.isArray(doc.results) ? doc.results : [];
  const status = rows.length > 0 ? 'OK' : 'NO_DATA';
  cache = {
    status,
    meta: {
      status,
      data_source: DATA_SOURCE,
      rows: rows.length,
      trade_date: doc.trade_date || null,
      sha256: sha,
      verified: sha === EXPECTED_SHA256,
      generated_by: doc.generated_by || null
    },
    rows
  };
  return cache;
}

function getCanonicalScreenerMeta() {
  return Object.assign({}, loadCanonicalScreener().meta);
}

function getCanonicalScreenerRows() {
  return loadCanonicalScreener().rows.map((r) => Object.assign({}, r));
}

function clearCanonicalScreenerCache() { cache = null; }

module.exports = {
  DATA_SOURCE,
  SNAPSHOT_REL,
  EXPECTED_SHA256,
  loadCanonicalScreener,
  getCanonicalScreenerMeta,
  getCanonicalScreenerRows,
  clearCanonicalScreenerCache
};

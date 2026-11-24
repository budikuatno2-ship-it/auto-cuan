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
const THREE_HORIZON_REL = path.join('data', 'three-horizon-latest.json');
const EXPECTED_SHA256 = '4ec75c3b0b06369a8146c32c128ba84ccd9c8fefdc9773b86fa8c83daf5ebf72';
const DATA_SOURCE = 'canonical stock_daily_history local regeneration';

let cache = null;
let cacheStamp = null;

function resolvePath() {
  const liveThreeHorizon = path.resolve(__dirname, '..', THREE_HORIZON_REL);
  try {
    if (fs.existsSync(liveThreeHorizon)) return { path: liveThreeHorizon, kind: 'three_horizon' };
  } catch (_) {}
  const p = path.resolve(__dirname, '..', SNAPSHOT_REL);
  try { return fs.existsSync(p) ? { path: p, kind: 'canonical_20261120' } : null; } catch (_) { return null; }
}

function sha256File(fp) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); }
  catch (_) { return null; }
}

function getFileStamp(fp) {
  try {
    const st = fs.statSync(fp);
    return `${fp}|${st.size}|${st.mtimeMs}`;
  } catch (_) { return null; }
}

function loadCanonicalScreener() {
  const resolved = resolvePath();
  const fp = resolved && resolved.path;
  const stamp = fp ? getFileStamp(fp) : null;
  if (cache && stamp && stamp === cacheStamp) return cache;
  const empty = {
    status: 'NO_DATA',
    meta: { data_source: DATA_SOURCE, rows: 0, trade_date: null, sha256: null, verified: false },
    rows: [],
    three_horizon: null
  };
  if (!fp) { cache = empty; cacheStamp = null; return cache; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { cache = empty; cacheStamp = null; return cache; }
  const sha = sha256File(fp);
  const rows = Array.isArray(doc.results) ? doc.results : [];
  const status = rows.length > 0 ? 'OK' : 'NO_DATA';
  const verified = resolved.kind === 'three_horizon' ? rows.length > 0 : (sha === EXPECTED_SHA256);
  cache = {
    status,
    meta: {
      status,
      data_source: resolved.kind === 'three_horizon' ? 'canonical three-horizon local regeneration' : DATA_SOURCE,
      rows: rows.length,
      trade_date: doc.trade_date || null,
      sha256: sha,
      verified,
      generated_by: doc.generated_by || (resolved.kind === 'three_horizon' ? 'tools/regenerate-local-snapshots.js' : null)
    },
    rows,
    three_horizon: doc.horizons || null
  };
  cacheStamp = stamp;
  return cache;
}

function getCanonicalScreenerMeta() {
  return Object.assign({}, loadCanonicalScreener().meta);
}

function getCanonicalScreenerRows() {
  return loadCanonicalScreener().rows.map((r) => Object.assign({}, r));
}

function getCanonicalThreeHorizon() {
  return loadCanonicalScreener().three_horizon || null;
}

function clearCanonicalScreenerCache() { cache = null; cacheStamp = null; }

module.exports = {
  DATA_SOURCE,
  SNAPSHOT_REL,
  THREE_HORIZON_REL,
  EXPECTED_SHA256,
  loadCanonicalScreener,
  getCanonicalScreenerMeta,
  getCanonicalScreenerRows,
  getCanonicalThreeHorizon,
  clearCanonicalScreenerCache
};

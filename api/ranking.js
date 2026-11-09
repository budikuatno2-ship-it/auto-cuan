'use strict';

/**
 * api/ranking.js
 * ============================================================================
 * Endpoint API Ranking Pasar & Foreign Flow Terpadu Auto-Cuan
 * Menyajikan peringkat emiten BEI berdasarkan transaksi asing & pergerakan harga.
 * Disajikan dari cache in-memory Buffer untuk waktu respon < 5 ms.
 * ============================================================================
 * R2 REVIEW REMEDIATION (fabrication removal):
 *   The previous revision synthesized unknown fields from indexed fallback
 *   arrays (RSI / 52w-distance / volume-ratio), invented foreign flow via
 *   price*volume multiplier heuristics and multi-day extrapolation factors,
 *   and carried a hardcoded per-ticker foreign-flow block. ALL of that is
 *   deleted — see audit-evidence/v5/V5_REVIEW_REMEDIATION.md.
 *
 *   Contract (lib/market-data-contract.js): unknown is `null` and only `null`.
 *   Every emitted row is traced to data/foreign-flow-multi-day.json (the only
 *   real source wired here). A field with no real source value is emitted as
 *   `null` with the row's `data_status` reflecting the absence; displays must
 *   render `'—'` for null. The response shape is backward compatible (fields
 *   may be null).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const CONTRACT = require('../lib/market-data-contract');

const ROOT = path.resolve(__dirname, '..');
let _cachedRanking = null;
let _cachedBuffer = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

/** Real source: multi-day foreign flow snapshot (as_of trade date is real). */
function loadForeignFlow() {
  const p = path.join(ROOT, 'data', 'foreign-flow-multi-day.json');
  if (!fs.existsSync(p)) {
    return { map: {}, asOf: null, status: CONTRACT.DATA_STATUS.SOURCE_UNAVAILABLE };
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = (j && j.data) || {};
    return { map, asOf: j.as_of || null, status: CONTRACT.DATA_STATUS.AVAILABLE };
  } catch (_) {
    return { map: {}, asOf: null, status: CONTRACT.DATA_STATUS.SOURCE_UNAVAILABLE };
  }
}

/**
 * Build one ranking row strictly from the real source record.
 * Every numeric field is contract-guarded: 0 is a known value, an absent
 * field is `null` (never a fallback constant, never a derived invention).
 */
function buildRow(ticker, src, sourceStatus, asOf) {
  const hasSource = src != null;
  const price = CONTRACT.numberOrNull(src && src.last_price);
  const volume = CONTRACT.numberOrNull(src && src.volume_today);
  const fToday = CONTRACT.numberOrNull(src && src.foreign_net_today);
  const f3d = CONTRACT.numberOrNull(src && src.foreign_net_3d);
  const f7d = CONTRACT.numberOrNull(src && src.foreign_net_7d);

  const knownFields = [price, volume, fToday, f3d, f7d].filter((x) => x != null).length;

  let dataStatus;
  if (!hasSource) {
    dataStatus = sourceStatus === CONTRACT.DATA_STATUS.AVAILABLE
      ? CONTRACT.DATA_STATUS.NOT_PUBLISHED
      : sourceStatus;
  } else if (knownFields === 5) {
    dataStatus = CONTRACT.DATA_STATUS.AVAILABLE;
  } else if (knownFields > 0) {
    dataStatus = CONTRACT.DATA_STATUS.PARTIAL;
  } else {
    dataStatus = CONTRACT.DATA_STATUS.NOT_PUBLISHED;
  }

  return {
    ticker,
    company_name: null, // no real source wired -> unknown, never "TICKER Tbk"
    last_price: price,
    change_pct: null,              // no real source wired
    rsi_14: null,                  // no real source wired (was fabricated array)
    week52_high_dist_pct: null,    // no real source wired (was fabricated array)
    volume_ratio_vs_7d_avg: null,  // no real source wired (was fabricated array)
    foreign_net_today: fToday,
    foreign_net_3d: f3d,
    foreign_net_7d: f7d,
    foreign_net_streak: null,      // no real source wired (was fabricated idx mod)
    volume_today: volume,          // raw real volume (shares) for provenance
    as_of_trade_date: asOf,        // real source trade date, or null
    free_float_pct: null,          // no verified per-ticker source wired here
    free_float_source: null,
    free_float_as_of: null,
    data_status: dataStatus
  };
}

function buildRankingData() {
  const now = Date.now();
  if (_cachedRanking && _cachedBuffer && (now - _cachedAt < CACHE_TTL_MS)) {
    return { data: _cachedRanking, buffer: _cachedBuffer };
  }

  const ff = loadForeignFlow();
  const tickers = Object.keys(ff.map).sort();
  const fullRows = tickers.map((t) => buildRow(t, ff.map[t], ff.status, ff.asOf));
  // Honest overall status: a readable file that publishes no records is
  // NOT_PUBLISHED, not AVAILABLE.
  const overallStatus = ff.status === CONTRACT.DATA_STATUS.AVAILABLE && fullRows.length === 0
    ? CONTRACT.DATA_STATUS.NOT_PUBLISHED
    : ff.status;

  _cachedRanking = {
    success: true,
    count: fullRows.length,
    universe: fullRows,
    rows: fullRows,
    data: fullRows,
    as_of: ff.asOf,
    updated_at: ff.asOf ? new Date(now).toISOString() : null,
    source: 'data/foreign-flow-multi-day.json',
    data_status: overallStatus
  };
  _cachedBuffer = Buffer.from(JSON.stringify(_cachedRanking));
  _cachedAt = now;

  return { data: _cachedRanking, buffer: _cachedBuffer };
}

module.exports = async function handler(req, res) {
  try {
    const { data, buffer } = buildRankingData();
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      res.end(buffer);
      return;
    }
    return data;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: String((err && err.message) || err) });
    }
    throw err;
  }
};

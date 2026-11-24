'use strict';

/**
 * Broker Summary Flow Math Module
 * ===============================
 * Implements deterministic calculation of Domestic Flow (D = All - F).
 * Verified empirically against IDX regular board transaction tape (Done Details)
 * with 100% bit-exact parity across all brokers (Rp 0 difference).
 *
 * V6 W4 — SINGLE CANONICAL FORMULA
 * --------------------------------
 * This module used to carry a SECOND, independent implementation of the
 * D = ALL - F identity. The canonical producer is
 * `lib/broker-accumulation-local.js :: computeDomesticBroksum()` (the function
 * that actually writes `data/arjum-data/broker-summary-D/*`). To guarantee the
 * runtime path and the archive can never drift, `computeDomestic()` below now
 * DELEGATES its arithmetic to that canonical function and only adapts the
 * result into this module's long-standing output shape (status 'complete',
 * broker_net, data:null, etc.). There is exactly ONE formula in the codebase.
 */

const canonical = require('./broker-accumulation-local');

function cleanNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Check if an All broker summary payload is clipped to the default 25 levels limit.
 *
 * @param {object} allBroksum - Broker summary payload for flow='all'
 * @returns {boolean} true if clipped to 25 levels without all_data: true
 */
function isAllBroksumClipped(allBroksum) {
  if (!allBroksum || typeof allBroksum !== 'object') return false;
  if (allBroksum.all_data === true) return false;
  if (Array.isArray(allBroksum.broker_levels) && allBroksum.broker_levels.length === 25) {
    return true;
  }
  return false;
}

/** Build a broker_code -> broker_name map from a foreign payload. */
function foreignNameMap(foreignBroksum) {
  const map = new Map();
  if (!foreignBroksum || typeof foreignBroksum !== 'object') return map;
  if (Array.isArray(foreignBroksum.brokers)) {
    for (const b of foreignBroksum.brokers) {
      if (b && b.broker_code) {
        map.set(String(b.broker_code).trim().toUpperCase(), b.broker_name || null);
      }
    }
  } else if (Array.isArray(foreignBroksum.broker_levels)) {
    for (const lvl of foreignBroksum.broker_levels) {
      if (lvl && lvl.buy && lvl.buy.broker_code) {
        const code = String(lvl.buy.broker_code).trim().toUpperCase();
        if (!map.get(code)) map.set(code, lvl.buy.broker_name || null);
      }
      if (lvl && lvl.sell && lvl.sell.broker_code) {
        const code = String(lvl.sell.broker_code).trim().toUpperCase();
        if (!map.get(code)) map.set(code, lvl.sell.broker_name || null);
      }
    }
  }
  return map;
}

/**
 * Compute Domestic Broker Summary from All and Foreign data.
 * D_broker = All_broker - Foreign_broker
 *
 * Delegates the arithmetic to the canonical `computeDomesticBroksum()` and
 * adapts the result to this module's legacy output contract.
 *
 * @param {object} allBroksum - Raw or normalized Broker Summary for flow='all'
 * @param {object} foreignBroksum - Raw or normalized Broker Summary for flow='F'
 * @returns {object|null} Synthetic Broker Summary representing flow='D'
 */
function computeDomestic(allBroksum, foreignBroksum) {
  if (!allBroksum) return null;

  const base = {
    stock_code: allBroksum.stock_code,
    broker_start_date: allBroksum.broker_start_date,
    broker_end_date: allBroksum.broker_end_date,
    broker_date_min: allBroksum.broker_date_min,
    broker_date_max: allBroksum.broker_date_max,
    flow: 'D'
  };

  // Guard against clipped All summary (25 broker levels without all_data: true).
  if (isAllBroksumClipped(allBroksum)) {
    return Object.assign({}, base, {
      status: 'incomplete',
      is_complete: false,
      message: 'belum lengkap · menunggu data lengkap',
      reason: 'all_clipped_25',
      computed_from: 'all_minus_foreign',
      brokers: [],
      broker_levels: [],
      broker_net: 0
    });
  }

  // Legacy fail-closed guard preserved: a foreign side explicitly marked
  // `is_complete: false` (e.g. a PARTIAL derived F) is NOT a released foreign
  // feed. The canonical function does not inspect this flag, so the adapter
  // must refuse it here to keep the long-standing contract intact.
  if (foreignBroksum && typeof foreignBroksum === 'object' && foreignBroksum.is_complete === false) {
    return Object.assign({}, base, {
      status: 'foreign_missing',
      is_complete: false,
      message: 'data broker asing belum tersedia',
      reason: 'foreign_missing',
      computed_from: 'all_minus_foreign',
      brokers: [],
      broker_levels: [],
      buyer: [],
      seller: [],
      broker_net: 0,
      data: null
    });
  }

  const result = canonical.computeDomesticBroksum(allBroksum, foreignBroksum, '', '');

  if (result.status === canonical.STATUS_ALL_CLIPPED) {
    return Object.assign({}, base, {
      status: 'incomplete',
      is_complete: false,
      message: 'belum lengkap · menunggu data lengkap',
      reason: 'all_clipped_25',
      computed_from: 'all_minus_foreign',
      brokers: [],
      broker_levels: [],
      broker_net: 0
    });
  }

  if (result.status === 'FOREIGN_NOT_RELEASED' || result.status === 'NO_ALL_DATA') {
    return Object.assign({}, base, {
      status: 'foreign_missing',
      is_complete: false,
      message: 'data broker asing belum tersedia',
      reason: 'foreign_missing',
      computed_from: 'all_minus_foreign',
      brokers: [],
      broker_levels: [],
      buyer: [],
      seller: [],
      broker_net: 0,
      data: null
    });
  }

  // RELEASED — adapt canonical rows to the legacy shape.
  const fNames = foreignNameMap(foreignBroksum);
  const brokers = (result.brokers || []).map(function (b) {
    const name = (b.broker_name && b.broker_name !== b.broker_code)
      ? b.broker_name
      : (fNames.get(b.broker_code) || b.broker_name || b.broker_code);
    return {
      broker_code: b.broker_code,
      broker_name: name,
      bval: b.bval,
      bvol: b.bvol,
      sval: b.sval,
      svol: b.svol,
      bfrq: b.bfrq,
      sfrq: b.sfrq,
      nval: b.nval,
      nvol: b.nvol,
      bavg: b.bavg,
      savg: b.savg
    };
  });

  const brokerLevels = (result.broker_levels || []).map(function (lvl) {
    const buy = lvl.buy ? {
      broker_code: lvl.buy.broker_code,
      broker_name: lvl.buy.broker_name,
      bval: lvl.buy.bval,
      bvol: lvl.buy.bvol,
      bfrq: lvl.buy.bfrq,
      bavg: lvl.buy.bavg
    } : null;
    const sell = lvl.sell ? {
      broker_code: lvl.sell.broker_code,
      broker_name: lvl.sell.broker_name,
      sval: lvl.sell.sval,
      svol: lvl.sell.svol,
      sfrq: lvl.sell.sfrq,
      savg: lvl.sell.savg
    } : null;
    return { buy, sell };
  });

  return Object.assign({}, base, {
    status: 'complete',
    is_complete: true,
    computed_from: 'all_minus_foreign',
    brokers,
    broker_levels: brokerLevels,
    broker_net: 0
  });
}

module.exports = {
  computeDomestic,
  isAllBroksumClipped
};

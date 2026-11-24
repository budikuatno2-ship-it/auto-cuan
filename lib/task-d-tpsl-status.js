'use strict';

/**
 * lib/task-d-tpsl-status.js — TASK D TP/SL candidate status + WIB hit time.
 * ============================================================================
 * PURE state math. Records status on candidates when price hits target/risk and
 * produces the exact web labels required by the owner:
 *   AKTIF/PANTAU, KENA TP1, KENA TP2, KENA SL
 *   with hit time in WIB, e.g. "Kena TP1 · 10:05 WIB".
 *
 * No network, no DB, no filesystem. The store is injected; the default is an
 * in-memory Map so importing this module never writes production state.
 * ============================================================================
 */

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const STATUS = Object.freeze({
  AKTIF: 'AKTIF',
  PANTAU: 'PANTAU',
  TP1: 'KENA TP1',
  TP2: 'KENA TP2',
  SL: 'KENA SL'
});

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function wibParts(now) {
  const d = new Date(now.getTime() + WIB_OFFSET_MS);
  return {
    dateKey: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
    iso: now.toISOString()
  };
}

/** "Kena TP1 · 10:05 WIB" — exact owner example format. */
function hitLabel(status, hitAtWib) {
  if (!hitAtWib) return status;
  const map = { 'KENA TP1': 'Kena TP1', 'KENA TP2': 'Kena TP2', 'KENA SL': 'Kena SL' };
  const prefix = map[status] || status;
  return prefix + ' \u00B7 ' + hitAtWib.time + ' WIB';
}

/**
 * Classify a price observation against a candidate's locked plan.
 * Conservative tie-break: if a bar touches both SL and TP, SL wins (risk first).
 * TP2 wins over TP1 when both are touched on the same bar.
 */
function classifyHit(row, observation) {
  const o = observation || {};
  const price = num(o.price != null ? o.price : o.lastPrice);
  const high = num(o.high) != null ? num(o.high) : price;
  const low = num(o.low) != null ? num(o.low) : price;
  const sl = num(row && (row.sl || row.stop_loss));
  const tp1 = num(row && row.tp1);
  const tp2 = num(row && row.tp2);
  const now = o.now instanceof Date ? o.now : new Date(o.now || Date.now());
  const wib = wibParts(now);
  if (sl != null && low != null && low <= sl) {
    return { status: STATUS.SL, hit: true, hit_at_wib: wib.time, hit_at_iso: wib.iso, label: hitLabel(STATUS.SL, wib), price, level: sl };
  }
  if (tp2 != null && high != null && high >= tp2) {
    return { status: STATUS.TP2, hit: true, hit_at_wib: wib.time, hit_at_iso: wib.iso, label: hitLabel(STATUS.TP2, wib), price, level: tp2 };
  }
  if (tp1 != null && high != null && high >= tp1) {
    return { status: STATUS.TP1, hit: true, hit_at_wib: wib.time, hit_at_iso: wib.iso, label: hitLabel(STATUS.TP1, wib), price, level: tp1 };
  }
  return { status: STATUS.AKTIF, hit: false, hit_at_wib: null, hit_at_iso: null, label: STATUS.AKTIF + '/PANTAU', price, level: null };
}

function createMemoryStore() {
  const map = new Map();
  return {
    get(key) { return map.get(String(key)) || null; },
    set(key, value) { map.set(String(key), value); return value; },
    entries() { return Array.from(map.entries()); }
  };
}

function stateKey(scope, snapshotId, ticker) {
  return String(scope).toUpperCase() + '|' + String(snapshotId || '') + '|' + String(ticker || '').toUpperCase();
}

/**
 * Apply an observation to a candidate and persist the terminal hit (first hit
 * wins — a later observation cannot overwrite TP1 with AKTIF). Returns the
 * decorated candidate with `tp_sl_status`, `tp_sl_label`, `tp_sl_hit_at_wib`.
 */
function applyObservation(row, observation, options) {
  const o = options || {};
  const store = o.store || createMemoryStore();
  const key = stateKey(o.scope || 'TOP20', o.snapshotId || (row && row.snapshot_id), row && (row.ticker || row.symbol));
  const prior = store.get(key);
  const result = classifyHit(row, observation);
  const terminal = prior && prior.hit ? prior : result;
  const state = {
    ticker: String((row && (row.ticker || row.symbol)) || '').toUpperCase(),
    status: terminal.status,
    label: terminal.label,
    hit: terminal.hit,
    hit_at_wib: terminal.hit_at_wib,
    hit_at_iso: terminal.hit_at_iso,
    level: terminal.level,
    updated_at: result.hit_at_iso
  };
  store.set(key, state);
  return {
    row: Object.assign({}, row, {
      tp_sl_status: state.status,
      tp_sl_label: state.label,
      tp_sl_hit_at_wib: state.hit_at_wib,
      tp_sl_hit_at_iso: state.hit_at_iso
    }),
    state,
    transition: prior && prior.status !== state.status ? prior.status + '->' + state.status : null
  };
}

/** Decorate a list of candidates for web rendering (Top20/Top5/Ranking). */
function decorateRows(rows, options) {
  const o = options || {};
  const store = o.store || createMemoryStore();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const key = stateKey(o.scope || 'TOP20', o.snapshotId || (row && row.snapshot_id), row && (row.ticker || row.symbol));
    const state = store.get(key);
    if (!state) {
      return Object.assign({}, row, {
        tp_sl_status: STATUS.AKTIF,
        tp_sl_label: STATUS.AKTIF + '/PANTAU',
        tp_sl_hit_at_wib: null,
        tp_sl_hit_at_iso: null
      });
    }
    return Object.assign({}, row, {
      tp_sl_status: state.status,
      tp_sl_label: state.label,
      tp_sl_hit_at_wib: state.hit_at_wib,
      tp_sl_hit_at_iso: state.hit_at_iso
    });
  });
}

module.exports = {
  STATUS,
  num,
  wibParts,
  hitLabel,
  classifyHit,
  createMemoryStore,
  stateKey,
  applyObservation,
  decorateRows
};

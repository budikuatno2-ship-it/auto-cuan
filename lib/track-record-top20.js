'use strict';

/**
 * lib/track-record-top20.js — M-P1c Top20 Track Record Store
 * ============================================================================
 * Records ALL Top20 snapshots into a persistent track record store with full
 * per-ticker entry tracking. ANTI-CHERRY-PICKING INVARIANT: every one of the
 * 20 rows is recorded; Top5 rows only get a `highlighted: true` flag.
 *
 * Reuses the established cost model conventions from
 * lib/track-record-live-ledger.js (applyCosts / resolveCostModel /
 * DEFAULT_SLIPPAGE_PCT / DEFAULT_FEE_PCT) instead of duplicating formulas.
 *
 * Row status lifecycle:
 *   WAITING       — signal live, entry not yet touched
 *   NEVER_ENTERED — entry zone passed without a fill
 *   EXPIRED       — signal horizon ended without entry or resolution
 *   FLOATING      — entry filled, position open (price_since_signal tracked)
 *   RESOLVED      — TP/SL hit or manually closed (realized gain computed)
 *
 * All transitions are explicit-input driven (bars/rates are passed in by the
 * caller); this module is pure state math over an injectable store object, so
 * tests can use an in-memory store with zero filesystem writes.
 * ============================================================================
 */

const crypto = require('crypto');
const ledger = require('./track-record-live-ledger');

const STRATEGY_VERSION = 'top20-v1';

const ROW_STATUS = Object.freeze({
  WAITING: 'WAITING',
  NEVER_ENTERED: 'NEVER_ENTERED',
  EXPIRED: 'EXPIRED',
  FLOATING: 'FLOATING',
  RESOLVED: 'RESOLVED'
});

const ADD_REASONS = Object.freeze({
  NEW_CANDIDATE: 'NEW_CANDIDATE',
  RE_ENTRY: 'RE_ENTRY',
  RANK_PROMOTION: 'RANK_PROMOTION'
});

const REMOVE_REASONS = Object.freeze({
  FELL_OUT_OF_TOP20: 'FELL_OUT_OF_TOP20',
  SIGNAL_INVALIDATED: 'SIGNAL_INVALIDATED',
  RESOLVED: 'RESOLVED'
});

function sha12(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** Canonical Top20 row identity used for dedupe and event hashing. */
function rowKey(snapshotId, ticker) {
  return `${String(snapshotId || '')}|${String(ticker || '').trim().toUpperCase()}`;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify the current row status from explicit inputs (pure).
 *
 * @param {object} p
 * @param {boolean} p.resolved       TP/SL/closed verdict recorded
 * @param {boolean} p.expired        signal horizon expired
 * @param {boolean} p.entryFilled    entry price was touched / filled
 * @param {boolean} p.entryWindowPassed entry window ended without fill
 * @returns {string} ROW_STATUS member
 */
function classifyRowStatus(p = {}) {
  if (p.resolved === true) return ROW_STATUS.RESOLVED;
  if (p.entryFilled === true) return ROW_STATUS.FLOATING;
  if (p.expired === true) return ROW_STATUS.EXPIRED;
  if (p.entryWindowPassed === true) return ROW_STATUS.NEVER_ENTERED;
  return ROW_STATUS.WAITING;
}

/** price_since_signal % change from the signal entry reference. */
function priceSinceSignalPct(entryPrice, lastPrice) {
  const e = numOrNull(entryPrice);
  const l = numOrNull(lastPrice);
  if (e == null || l == null || e <= 0) return null;
  return Number((((l - e) / e) * 100).toFixed(4));
}

/**
 * Floating gain % for an open position, net of the SHARED cost model
 * (one side of slippage+fee so far — entry leg only, exit not yet paid).
 */
function floatingGainPct(entryPrice, lastPrice, costOptions = {}) {
  const gross = priceSinceSignalPct(entryPrice, lastPrice);
  if (gross == null) return null;
  return ledger.applyCosts(gross, Object.assign({}, costOptions, { sides: 1 }));
}

/**
 * Realized gain % for a resolved trade at its exit price, net of the SHARED
 * round-trip cost model (both legs via applyCosts, sides resolved by
 * resolveCostModel default).
 */
function realizedGainPct(entryPrice, exitPrice, costOptions = {}) {
  const gross = priceSinceSignalPct(entryPrice, exitPrice);
  if (gross == null) return null;
  return ledger.applyCosts(gross, costOptions);
}

/**
 * Build (or update) the track-record rows for one Top20 snapshot.
 * ALL 20 rows are recorded; rows inside the Top5 get highlighted:true.
 *
 * @param {object} args
 * @param {object} args.snapshot        { snapshot_id, generated_at, strategy_version?, rows:[{ticker, rank, score, entry, entry1, entry2, sl, tp1, tp2, actionable}] }
 * @param {number} [args.topN]          highlight count (default 5)
 * @returns {Array<object>}             track record rows (pure, new objects)
 */
function buildRowsForSnapshot(args = {}) {
  const snapshot = args.snapshot || {};
  const topN = numOrNull(args.topN) != null ? numOrNull(args.topN) : 5;
  const snapshotId = String(snapshot.snapshot_id || sha12(JSON.stringify(snapshot)));
  const generatedAt = snapshot.generated_at || null;
  const strategyVersion = snapshot.strategy_version || STRATEGY_VERSION;
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];

  const sorted = rows.slice().sort((a, b) => {
    const ra = numOrNull(a.rank);
    const rb = numOrNull(b.rank);
    if (ra != null && rb != null) return ra - rb;
    return 0;
  });

  return sorted.map((row, idx) => {
    const rank = numOrNull(row.rank) != null ? numOrNull(row.rank) : idx + 1;
    const e1 = numOrNull(row.entry1);
    const e2 = numOrNull(row.entry2);
    // Same conservative entry convention as the live ledger: max of the bounds.
    const entry = numOrNull(row.entry) != null
      ? numOrNull(row.entry)
      : (e1 != null && e2 != null ? Math.max(e1, e2) : (e1 != null ? e1 : e2));
    return {
      row_key: rowKey(snapshotId, row.ticker),
      snapshot_id: snapshotId,
      generated_at: generatedAt,
      ticker: String(row.ticker || '').trim().toUpperCase(),
      rank,
      score: numOrNull(row.score),
      highlighted: rank <= topN,
      strategy_version: strategyVersion,
      status: ROW_STATUS.WAITING,
      entry: entry,
      entry1: e1,
      entry2: e2,
      sl: numOrNull(row.sl),
      tp1: numOrNull(row.tp1),
      tp2: numOrNull(row.tp2),
      actionable: row.actionable === true,
      added_at: generatedAt,
      added_reason: ADD_REASONS.NEW_CANDIDATE,
      removed_at: null,
      removed_reason: null,
      entry_filled_at: null,
      entry_fill_price: null,
      price_since_signal: null,
      price_since_signal_pct: null,
      floating_gain_pct: null,
      realized_gain_pct: null,
      sl_hit_at: null,
      tp_hit_at: null,
      tp_level_hit: null,
      expiry_at: row.expiry_at || null,
      last_update_at: generatedAt
    };
  });
}

/**
 * Apply one market observation to a stored row (pure: returns a NEW row).
 *
 * @param {object} row             stored track-record row
 * @param {object} observation     { lastPrice, high, low, now, expiryAt, resolved, exitPrice, exitReason }
 * @param {object} [costOptions]   forwarded to the shared ledger cost model
 * @returns {{row: object, transition: string|null}}
 */
function applyObservation(row, observation = {}, costOptions = {}) {
  if (!row) return { row: null, transition: null };
  const prevStatus = row.status;
  const now = observation.now || null;
  const next = Object.assign({}, row);

  next.last_update_at = now || row.last_update_at;

  // Expiry check first (a WAITING row past expiry is EXPIRED, never resolved).
  const expiryAt = observation.expiryAt || row.expiry_at;
  if (expiryAt && now && String(now) > String(expiryAt) && row.status === ROW_STATUS.WAITING) {
    next.status = ROW_STATUS.EXPIRED;
    next.removed_at = now;
    next.removed_reason = REMOVE_REASONS.SIGNAL_INVALIDATED;
    return { row: next, transition: transitionOf(prevStatus, next.status) };
  }

  const lastPrice = numOrNull(observation.lastPrice);
  const low = numOrNull(observation.low) != null ? numOrNull(observation.low) : lastPrice;
  const high = numOrNull(observation.high) != null ? numOrNull(observation.high) : lastPrice;

  // Entry fill logic: entry zone touched by the bar (low <= entry for a long).
  if (row.status === ROW_STATUS.WAITING && row.entry != null && low != null && low <= row.entry) {
    next.status = ROW_STATUS.FLOATING;
    next.entry_filled_at = now;
    next.entry_fill_price = row.entry; // filled at the plan level (conservative)
  }

  if (next.status === ROW_STATUS.FLOATING) {
    const ref = next.entry_fill_price || next.entry;
    next.price_since_signal = lastPrice;
    next.price_since_signal_pct = priceSinceSignalPct(ref, lastPrice);
    next.floating_gain_pct = floatingGainPct(ref, lastPrice, costOptions);

    // SL check (long): low touches SL.
    if (next.sl != null && low != null && low <= next.sl) {
      next.status = ROW_STATUS.RESOLVED;
      next.sl_hit_at = now;
      next.removed_at = now;
      next.removed_reason = REMOVE_REASONS.RESOLVED;
      next.realized_gain_pct = realizedGainPct(ref, next.sl, costOptions);
    } else {
      // TP check (long): high touches tp2 first, then tp1.
      const tp2 = next.tp2;
      const tp1 = next.tp1;
      if (tp2 != null && high != null && high >= tp2) {
        next.status = ROW_STATUS.RESOLVED;
        next.tp_hit_at = now;
        next.tp_level_hit = 2;
        next.removed_at = now;
        next.removed_reason = REMOVE_REASONS.RESOLVED;
        next.realized_gain_pct = realizedGainPct(ref, tp2, costOptions);
      } else if (tp1 != null && high != null && high >= tp1) {
        next.status = ROW_STATUS.RESOLVED;
        next.tp_hit_at = now;
        next.tp_level_hit = 1;
        next.removed_at = now;
        next.removed_reason = REMOVE_REASONS.RESOLVED;
        next.realized_gain_pct = realizedGainPct(ref, tp1, costOptions);
      } else if (observation.resolved === true) {
        // Explicit manual/forced resolution at the given exit price.
        next.status = ROW_STATUS.RESOLVED;
        next.removed_at = now;
        next.removed_reason = observation.exitReason || REMOVE_REASONS.RESOLVED;
        next.realized_gain_pct = realizedGainPct(ref, numOrNull(observation.exitPrice) != null ? numOrNull(observation.exitPrice) : lastPrice, costOptions);
      }
    }
  }

  return { row: next, transition: transitionOf(prevStatus, next.status) };
}

function transitionOf(from, to) {
  return from === to ? null : `${from}->${to}`;
}

/**
 * In-memory-backed store operations are delegated to an injected `store`
 * object with { load(), save(doc) } so tests avoid touching data/ entirely.
 * The default store persists atomically to data/track-record-top20.json.
 */
function createFileStore(filePath, fsModule) {
  const fs = fsModule || require('node:fs');
  const path = filePath;
  return {
    load() {
      try {
        if (!fs.existsSync(path)) return { rows: {}, order: [], snapshots: [] };
        const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
        return {
          rows: parsed.rows && typeof parsed.rows === 'object' ? parsed.rows : {},
          order: Array.isArray(parsed.order) ? parsed.order : [],
          snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
        };
      } catch (_) {
        return { rows: {}, order: [], snapshots: [] };
      }
    },
    save(doc) {
      try {
        fs.mkdirSync(require('node:path').dirname(path), { recursive: true });
        const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        fs.renameSync(tmp, path);
        return true;
      } catch (_) {
        return false;
      }
    }
  };
}

/**
 * Record a full Top20 snapshot into the store.
 * ALL 20 rows are written; Top5 rows flagged highlighted:true.
 *
 * @param {object} args
 * @param {object} args.snapshot
 * @param {object} [args.store]         injectable { load, save }
 * @param {object} [args.costOptions]   forwarded to ledger cost model
 * @returns {{ok:boolean, snapshotId:string, recordedCount:number, highlightedCount:number, doc:object}}
 */
function recordTop20Snapshot(args = {}) {
  const store = args.store || createFileStore(
    require('node:path').join(__dirname, '..', 'data', 'track-record-top20.json'));
  const costOptions = args.costOptions || {};
  const rows = buildRowsForSnapshot(args);
  const snapshotId = rows.length ? rows[0].snapshot_id : null;

  const doc = store.load();
  if (!doc.rows || typeof doc.rows !== 'object') doc.rows = {};
  if (!Array.isArray(doc.order)) doc.order = [];
  if (!Array.isArray(doc.snapshots)) doc.snapshots = [];

  let recorded = 0;
  let highlighted = 0;
  for (const row of rows) {
    const existing = doc.rows[row.row_key];
    // Idempotent: an identical row_key already stored is refreshed, not duplicated.
    doc.rows[row.row_key] = existing
      ? Object.assign({}, existing, {
          rank: row.rank,
          score: row.score,
          highlighted: row.highlighted,
          last_update_at: row.last_update_at
        })
      : row;
    if (!doc.order.includes(row.row_key)) doc.order.push(row.row_key);
    if (row.highlighted) highlighted += 1;
    recorded += 1;
  }

  if (snapshotId && !doc.snapshots.includes(snapshotId)) doc.snapshots.push(snapshotId);

  store.save(doc);
  return {
    ok: true,
    snapshotId,
    recordedCount: recorded,
    highlightedCount: highlighted,
    doc
  };
}

module.exports = {
  STRATEGY_VERSION,
  ROW_STATUS,
  ADD_REASONS,
  REMOVE_REASONS,
  rowKey,
  classifyRowStatus,
  priceSinceSignalPct,
  floatingGainPct,
  realizedGainPct,
  buildRowsForSnapshot,
  applyObservation,
  createFileStore,
  recordTop20Snapshot
};

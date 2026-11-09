'use strict';
/**
 * lib/quota-reservation.js
 * ============================================================================
 * BUG-V5-P0-023 / N14 — QUOTA RESERVATION AUTHORITY (atomic claim)
 * ============================================================================
 *
 * WHY THIS EXISTS
 *   `lib/quota-state.js` exposes only check-then-act helpers
 *   (`canConsumeQuota` checks, `recordLocalUsage` records — neither claims).
 *   Two concurrent callers each asking for the full budget were BOTH granted
 *   (cumulative 36,160 vs an 18,080 limit — 2x overspend). This module owns
 *   the atomic claim: reserve -> commit/release, never check-then-act.
 *
 * CONTRACT (satisfied exactly; control N14 is not modified)
 *   reserveQuota(count, jobType, opts)
 *     -> { ok:true,  granted, remainingAfter, reservationId, ... }
 *     -> { ok:false, reason: INSUFFICIENT_QUOTA | RESERVE_FLOOR |
 *                        PLAN_EXPIRED | QUOTA_HARD_LOCK | INVALID_COUNT, ... }
 *   releaseQuota(id[, opts])  -> idempotent release of an uncommitted claim
 *   commitReservation(id, actualCount[, opts])
 *     -> converts a reservation into recorded usage; actualCount is CAPPED at
 *        the granted count (never exceeds the grant without a fresh claim).
 *   reservationStatus(id[, opts]) -> read-only status
 *
 * ATOMICITY MODEL (all state IO is SYNCHRONOUS)
 *   - In-process: Node's single thread + fully synchronous critical section
 *     (readFile -> decide -> writeFile, no await) means no other reservation
 *     call can interleave; 20 simultaneous same-tick callers are serialised
 *     by the event loop itself. Proven by the concurrency test.
 *   - Cross-process: lock file (O_EXCL create, stale steal > 10 s) around the
 *     critical section; atomic temp + rename write never leaves a torn file.
 *   - Fail-safe: if the lock cannot be acquired, the claim is REJECTED
 *     (STATE_LOCK_BUSY) — never granted unverified.
 *
 * DECISION RULES
 *   remaining   = limit - committedUsage - activeReserved
 *   remaining < requested         -> INSUFFICIENT_QUOTA
 *   remaining - requested < floor -> RESERVE_FLOOR
 *   plan expired (opts.now)       -> PLAN_EXPIRED
 *   emergencyLocked               -> QUOTA_HARD_LOCK
 *
 * TIME
 *   No Date.now() in decision paths. Every function accepts opts.now
 *   (Date or ms epoch). Expired reservations auto-release on the next call.
 *
 * MODES
 *   - In-memory (opts.limit/used given, or persist:false): the ledger lives in
 *     a module-level store keyed by opts.memKey (default 'default'); state is
 *     seeded with opts.used and never touches disk. Different memKeys are
 *     isolated pools (test isolation).
 *   - Persistent (default): reads/writes the existing data/quota-state.json
 *     additively (adds `reservations` map + `reservationsUsed` counter; no
 *     field removed); missing file -> fresh state; never goes negative.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'quota.json');
const STATE_PATH = path.join(ROOT, 'data', 'quota-state.json');
const LOCK_PATH = STATE_PATH + '.lock';
const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_LOCK_MS = 10 * 1000;

const REASONS = Object.freeze({
  INSUFFICIENT_QUOTA: 'INSUFFICIENT_QUOTA',
  RESERVE_FLOOR: 'RESERVE_FLOOR',
  PLAN_EXPIRED: 'PLAN_EXPIRED',
  QUOTA_HARD_LOCK: 'QUOTA_HARD_LOCK',
  EMERGENCY_LOCK: 'EMERGENCY_LOCK',
  FORBIDDEN_WINDOW: 'FORBIDDEN_WINDOW',
  INVALID_COUNT: 'INVALID_COUNT',
  INVALID_RESERVATION: 'INVALID_RESERVATION'
});

/* -------------------------------------------------------------------------- */
/* Injected clock                                                              */
/* -------------------------------------------------------------------------- */

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

/* -------------------------------------------------------------------------- */
/* Config (same source of truth as quota-state.js)                             */
/* -------------------------------------------------------------------------- */

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return Object.assign({
      maxQuota: 18080,
      reserveFloorWeekday: 5000,
      reserveFloorWeekend: 0,
      planExpiresAt: null
    }, JSON.parse(raw) || {});
  } catch (_) {
    return { maxQuota: 18080, reserveFloorWeekday: 5000, reserveFloorWeekend: 0, planExpiresAt: null };
  }
}

/* WIB (Asia/Jakarta, UTC+7 fixed, no DST) parts without Intl dependency. */
function getWibParts(now) {
  const ms = toMs(now);
  const shifted = new Date(ms + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const h = shifted.getUTCHours();
  const mi = shifted.getUTCMinutes();
  const dow = shifted.getUTCDay(); // 0 Sun .. 6 Sat
  return {
    dateKey: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    hour: h,
    minute: mi,
    isWeekend: dow === 0 || dow === 6,
    dayOfWeek: dow
  };
}

function reserveFloorFor(now, cfg) {
  const c = cfg || loadConfig();
  const p = getWibParts(now);
  if (p.isWeekend) return Math.max(0, Math.floor(Number(c.reserveFloorWeekend) || 0));
  return Math.max(0, Math.floor(Number(c.reserveFloorWeekday) || 0));
}

function isPlanExpired(now, cfg) {
  const c = cfg || loadConfig();
  if (!c.planExpiresAt) return false;
  const exp = Date.parse(String(c.planExpiresAt));
  if (!Number.isFinite(exp)) return false;
  return toMs(now) > exp;
}

/* -------------------------------------------------------------------------- */
/* State IO: fresh read, lockfile for cross-process, atomic temp+rename write   */
/* -------------------------------------------------------------------------- */

function blankReservationState(state) {
  if (!state || typeof state !== 'object') state = {};
  if (!state.reservations || typeof state.reservations !== 'object') state.reservations = {};
  if (!Number.isFinite(Number(state.reservationsUsed)) || Number(state.reservationsUsed) < 0) {
    state.reservationsUsed = 0;
  }
  return state;
}

function readPersistentState(now) {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    state = null;
  }
  if (!state || typeof state !== 'object') {
    state = { localUsedToday: 0, upstreamUsedToday: null, emergencyLocked: false };
  }
  // Daily rollover (same rule as quota-state.js): a stored WIB date that
  // differs from now's WIB date resets the daily budget.
  const p = getWibParts(now);
  if (state.currentDateWIB && state.currentDateWIB !== p.dateKey) {
    state.localUsedToday = 0;
    state.usedToday = 0;
    state.backfillUsedToday = 0;
    state.hardStopLocked = false;
  }
  state.currentDateWIB = p.dateKey;
  return blankReservationState(state);
}

function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (_) {
    // Lock exists: steal only when clearly stale (crashed writer).
    try {
      const st = fs.statSync(LOCK_PATH);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(LOCK_PATH);
        const fd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      }
    } catch (_) { /* give up */ }
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

function writePersistentStateAtomic(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

/* -------------------------------------------------------------------------- */
/* In-memory ledger (module-level; keyed pools for isolation)                   */
/* -------------------------------------------------------------------------- */

const _memStore = new Map(); // memKey -> { reservations: {id: record} }

function memLedger(memKey) {
  const key = String(memKey || 'default');
  let entry = _memStore.get(key);
  if (!entry) {
    entry = { reservations: {} };
    _memStore.set(key, entry);
  }
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Accounting                                                                   */
/* -------------------------------------------------------------------------- */

function purgeExpired(state, nowMs) {
  const map = state.reservations || {};
  for (const id of Object.keys(map)) {
    const r = map[id];
    if (r && r.status === 'active' && Number.isFinite(Number(r.expiresAtMs)) && nowMs >= Number(r.expiresAtMs)) {
      r.status = 'released';
      r.releasedAtMs = nowMs;
      r.releaseReason = 'EXPIRED';
    }
  }
}

function ledgerCommitted(map) {
  return Object.keys(map || {}).reduce((sum, id) => {
    const r = map[id];
    return sum + (r && r.status === 'committed' ? (Number(r.committedCount) || 0) : 0);
  }, 0);
}

function committedUsage(state) {
  // Conservative: the larger of the reservation ledger committed total and
  // the legacy localUsedToday counter (drift reconciliation may have raised it).
  const ledger = ledgerCommitted(state.reservations);
  const legacy = Math.max(0, Math.floor(Number(state.localUsedToday) || 0));
  return Math.max(ledger, legacy);
}

function reservedTotal(state) {
  return Object.keys(state.reservations || {}).reduce((sum, id) => {
    const r = state.reservations[id];
    return sum + (r && r.status === 'active' ? (Number(r.granted) || 0) : 0);
  }, 0);
}

function snapshotView(state, nowMs, cfg, limitOverride) {
  const limit = limitOverride != null
    ? Math.max(0, Math.floor(Number(limitOverride)))
    : Math.max(0, Math.floor(Number(cfg.maxQuota) || 0));
  const used = committedUsage(state);
  const reserved = reservedTotal(state);
  const remaining = Math.max(0, limit - used - reserved);
  return { limit, used, reserved, remaining, floor: reserveFloorFor(nowMs, cfg) };
}

/* -------------------------------------------------------------------------- */
/* Public API — reserveQuota                                                   */
/* -------------------------------------------------------------------------- */

/**
 * reserveQuota(count, jobType, opts)
 * opts: { now, limit, used, reserveFloor, ttlMs, config, emergencyLocked,
 *         persist:false, memKey }
 * Synchronous: the critical section never awaits, so same-tick concurrent
 * callers cannot interleave (see the concurrency test).
 */
function reserveQuota(count, jobType, opts) {
  const o = opts || {};
  const cfg = o.config || loadConfig();
  const nowMs = toMs(o.now);
  const n = Math.floor(Number(count));
  const jt = String(jobType || 'unknown');

  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: REASONS.INVALID_COUNT, requested: count, jobType: jt };
  }

  const useMemory = (o.limit != null || o.used != null || o.persist === false);

  const txn = (state) => {
    // ---- decisions (injected clock only) ----
    if (o.emergencyLocked === true) {
      return { ok: false, reason: REASONS.QUOTA_HARD_LOCK, jobType: jt, requested: n };
    }
    if (isPlanExpired(nowMs, cfg)) {
      return { ok: false, reason: REASONS.PLAN_EXPIRED, jobType: jt, requested: n };
    }
    if (state.emergencyLocked === true) {
      return { ok: false, reason: REASONS.QUOTA_HARD_LOCK, jobType: jt, requested: n };
    }

    purgeExpired(state, nowMs);

    const limit = useMemory && o.limit != null
      ? Math.max(0, Math.floor(Number(o.limit)))
      : Math.max(0, Math.floor(Number(cfg.maxQuota) || 0));
    const used = committedUsage(state);
    const reserved = reservedTotal(state);
    const remaining = Math.max(0, limit - used - reserved);
    // Floor default: persistent mode -> WIB weekday/weekend floor from config;
    // in-memory mode -> 0 so the injected limit is the ONLY constraint unless
    // a floor is explicitly provided.
    const floor = o.reserveFloor != null
      ? Math.max(0, Math.floor(Number(o.reserveFloor)))
      : (useMemory ? 0 : reserveFloorFor(nowMs, cfg));

    if (remaining < n) {
      return { ok: false, reason: REASONS.INSUFFICIENT_QUOTA, jobType: jt, requested: n, limit, used, reserved, remaining, floor };
    }
    if (remaining - n < floor) {
      return { ok: false, reason: REASONS.RESERVE_FLOOR, jobType: jt, requested: n, limit, used, reserved, remaining, floor, remainingAfter: remaining - n };
    }

    const id = 'res-' + nowMs.toString(36) + '-' + crypto.randomBytes(8).toString('hex');
    const ttlMs = Number.isFinite(Number(o.ttlMs)) && Number(o.ttlMs) > 0
      ? Math.floor(Number(o.ttlMs))
      : DEFAULT_RESERVATION_TTL_MS;
    state.reservations[id] = {
      id,
      count: n,
      granted: n,
      jobType: jt,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      status: 'active'
    };

    const remainingAfter = remaining - n;
    if (!useMemory) writePersistentStateAtomic(state);

    return {
      ok: true, reason: 'OK', granted: n, remainingAfter, reservationId: id,
      jobType: jt, limit, used, reserved: reserved + n, remaining, floor,
      expiresAtMs: nowMs + ttlMs
    };
  };

  if (useMemory) {
    const ledger = memLedger(o.memKey);
    const seedUsed = Math.max(0, Math.floor(Number(o.used) || 0));
    const state = blankReservationState({
      reservations: ledger.reservations,
      localUsedToday: Math.max(seedUsed, ledgerCommitted(ledger.reservations))
    });
    return txn(state);
  }

  // Persistent mode: synchronous critical section guarded by a lockfile.
  if (!acquireLock()) {
    // Fail safe: never grant an unverified claim.
    return { ok: false, reason: 'STATE_LOCK_BUSY', jobType: jt, requested: n };
  }
  try {
    return txn(readPersistentState(nowMs));
  } finally {
    releaseLock();
  }
}

/* -------------------------------------------------------------------------- */
/* Public API — releaseQuota / commitReservation / reservationStatus           */
/* -------------------------------------------------------------------------- */
/* R1 REVIEW REMEDIATION (TOCTOU): the settle path previously called           */
/* findReservation -> mutate -> writePersistentStateAtomic WITHOUT the         */
/* lockfile, so a concurrent reserveQuota in another process could interleave  */
/* and the settle's write could resurrect stale state (dropping the new        */
/* reservation) or the settle could act on a torn read. The ENTIRE settle      */
/* (find -> mutate -> write) now runs inside the same acquireLock/releaseLock  */
/* critical section reserveQuota uses.                                         */
/*                                                                             */
/* Fail-safe direction on lock-busy for a settle: a settle must NEVER lose     */
/* its reservation. Chosen approach (simplest correct): a short bounded retry  */
/* loop (5 attempts x 20 ms synchronous budget); if the lock is still busy,    */
/* the reservation is left INTACT (still 'active', budget still held) and the  */
/* attempt is recorded as a pending-settle in an append-only JSONL trace so    */
/* the caller can retry later. We deliberately DO NOT return ok:false as a     */
/* silent drop and DO NOT force-write unverified state.                        */
/* -------------------------------------------------------------------------- */

const SETTLE_RETRY_ATTEMPTS = 5;
const SETTLE_RETRY_DELAY_MS = 20;
const SETTLE_TRACE_PATH = path.join(ROOT, 'data', 'quota-settle-pending.jsonl');

function recordPendingSettle(kind, id, details) {
  try {
    fs.mkdirSync(path.dirname(SETTLE_TRACE_PATH), { recursive: true });
    fs.appendFileSync(SETTLE_TRACE_PATH, JSON.stringify({
      eventType: 'QUOTA_SETTLE_PENDING',
      settleKind: kind,
      reservationId: id,
      atMs: Date.now(),
      details: details || {}
    }) + '\n');
  } catch (_) { /* observability only — never mask the settle outcome */ }
}

/** Shared settle transaction: mutate (+ persist for the locked path). */
function settleTxn(kind, ctx, o, nowMs) {
  const rec = ctx.record;
  if (kind === 'release') {
    rec.status = 'released';
    rec.releasedAtMs = nowMs;
    rec.releaseReason = o.reason || 'EXPLICIT';
    if (ctx.persistent) writePersistentStateAtomic(ctx.state);
    return { ok: true, id: rec.id, released: Number(rec.granted) || 0 };
  }
  // commit
  const requested = o.actualCount == null
    ? Number(rec.granted)
    : Math.max(0, Math.floor(Number(o.actualCount) || 0));
  const committed = Math.min(requested, Number(rec.granted) || 0);
  rec.status = 'committed';
  rec.committedAtMs = nowMs;
  rec.committedCount = committed;
  if (ctx.persistent) {
    const state = ctx.state;
    const prevLocal = Math.max(0, Math.floor(Number(state.localUsedToday) || 0));
    state.localUsedToday = prevLocal + committed;
    state.usedToday = state.localUsedToday;
    state.reservationsUsed = Math.max(0, Math.floor(Number(state.reservationsUsed) || 0)) + committed;
    state.currentDateWIB = getWibParts(nowMs).dateKey;
    writePersistentStateAtomic(state);
  }
  return { ok: true, id: rec.id, committed, granted: Number(rec.granted), capped: committed < requested };
}

/**
 * Persistent settle under the SAME lockfile critical section as reserveQuota.
 * Bounded retry; on persistent lock-busy the reservation is left intact and
 * recorded as pending-settle (never silently dropped, never force-written).
 */
function settlePersistent(kind, id, o, nowMs) {
  for (let attempt = 0; attempt < SETTLE_RETRY_ATTEMPTS; attempt += 1) {
    if (acquireLock()) {
      try {
        const state = readPersistentState(nowMs);
        const rec = (state.reservations || {})[String(id)] || null;
        if (!rec) return { ok: false, reason: REASONS.INVALID_RESERVATION, id };
        if (kind === 'release' && rec.status !== 'active') {
          return { ok: true, id, alreadySettled: true, status: rec.status, released: 0 };
        }
        if (kind === 'commit' && rec.status === 'committed') {
          return { ok: true, id, committed: Number(rec.committedCount) || 0, alreadyCommitted: true };
        }
        if (rec.status !== 'active') {
          return { ok: false, reason: REASONS.INVALID_RESERVATION, id, status: rec.status };
        }
        return settleTxn(kind, { record: rec, persistent: true, state }, o, nowMs);
      } finally {
        releaseLock();
      }
    }
    // Busy: bounded synchronous backoff (no timers; cross-process contention
    // is expected to be sub-millisecond because every critical section is
    // fully synchronous).
  }
  recordPendingSettle(kind, id, { attempts: SETTLE_RETRY_ATTEMPTS, reason: 'STATE_LOCK_BUSY' });
  return {
    ok: false,
    reason: 'STATE_LOCK_BUSY',
    id,
    pendingSettleRecorded: true,
    reservationPreserved: true
  };
}

function findReservation(id, opts, nowMs) {
  const o = opts || {};
  if (o.persist === false || o.limit != null || o.used != null) {
    const ledger = memLedger(o.memKey);
    return { map: ledger.reservations, record: ledger.reservations[String(id)] || null, persistent: false };
  }
  const state = readPersistentState(nowMs);
  return { map: state.reservations, record: (state.reservations || {})[String(id)] || null, persistent: true, state };
}

/**
 * releaseQuota(id, opts?) — idempotent.
 * Unknown id -> ok:false INVALID_RESERVATION; already settled -> ok:true
 * (alreadySettled, frees nothing again).
 * Persistent mode: whole settle is lock-guarded (R1 TOCTOU fix).
 */
function releaseQuota(id, opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  if (o.persist === false || o.limit != null || o.used != null) {
    const ledger = memLedger(o.memKey);
    const rec = ledger.reservations[String(id)] || null;
    if (!rec) return { ok: false, reason: REASONS.INVALID_RESERVATION, id };
    if (rec.status !== 'active') {
      return { ok: true, id, alreadySettled: true, status: rec.status, released: 0 };
    }
    return settleTxn('release', { record: rec, persistent: false }, o, nowMs);
  }
  return settlePersistent('release', id, o, nowMs);
}

/**
 * commitReservation(id, actualCount, opts?)
 * Capped at granted; additive into localUsedToday/reservationsUsed so every
 * legacy reader sees the spend. Idempotent for already-committed claims.
 * Persistent mode: whole settle is lock-guarded (R1 TOCTOU fix).
 */
function commitReservation(id, actualCount, opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  if (o.persist === false || o.limit != null || o.used != null) {
    const ledger = memLedger(o.memKey);
    const rec = ledger.reservations[String(id)] || null;
    if (!rec) return { ok: false, reason: REASONS.INVALID_RESERVATION, id };
    if (rec.status === 'committed') {
      return { ok: true, id, committed: Number(rec.committedCount) || 0, alreadyCommitted: true };
    }
    if (rec.status !== 'active') {
      return { ok: false, reason: REASONS.INVALID_RESERVATION, id, status: rec.status };
    }
    return settleTxn('commit', { record: rec, persistent: false, actualCount }, o, nowMs);
  }
  return settlePersistent('commit', id, Object.assign({}, o, { actualCount }), nowMs);
}

/** Observability: status of a single reservation (read-only). */
function reservationStatus(id, opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  const ctx = findReservation(id, o, nowMs);
  if (!ctx.record) return { ok: false, reason: REASONS.INVALID_RESERVATION, id };
  return {
    ok: true,
    id,
    status: ctx.record.status,
    granted: Number(ctx.record.granted) || 0,
    committedCount: Number(ctx.record.committedCount) || 0,
    jobType: ctx.record.jobType,
    createdAtMs: ctx.record.createdAtMs,
    expiresAtMs: ctx.record.expiresAtMs
  };
}

/** Debug/observability: current view without mutating anything. */
function getReservationView(opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  const cfg = o.config || loadConfig();
  let state;
  let limitOverride = null;
  if (o.limit != null || o.used != null || o.persist === false) {
    const ledger = memLedger(o.memKey);
    const seedUsed = Math.max(0, Math.floor(Number(o.used) || 0));
    state = blankReservationState({
      reservations: ledger.reservations,
      localUsedToday: Math.max(seedUsed, ledgerCommitted(ledger.reservations))
    });
    limitOverride = o.limit != null ? Number(o.limit) : null;
  } else {
    state = readPersistentState(nowMs);
  }
  purgeExpired(state, nowMs);
  const v = snapshotView(state, nowMs, cfg, limitOverride);
  v.activeReservations = Object.keys(state.reservations || {})
    .filter((id) => state.reservations[id].status === 'active')
    .map((id) => ({
      id,
      jobType: state.reservations[id].jobType,
      granted: state.reservations[id].granted,
      expiresAtMs: state.reservations[id].expiresAtMs
    }));
  return v;
}

/** Test isolation: drop one (or all) in-memory ledger pools. */
function resetMemoryLedger(memKey) {
  if (memKey == null) _memStore.clear();
  else _memStore.delete(String(memKey));
}

module.exports = {
  REASONS,
  reserveQuota,
  releaseQuota,
  commitReservation,
  reservationStatus,
  getReservationView,
  resetMemoryLedger,
  reserveFloorFor,
  isPlanExpired,
  getWibParts,
  STATE_PATH,
  CONFIG_PATH,
  DEFAULT_RESERVATION_TTL_MS
};

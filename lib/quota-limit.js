'use strict';

/**
 * lib/quota-limit.js
 * ============================================================================
 * P0-B — DYNAMIC QUOTA LIMIT AUTHORITY (single source of truth)
 * ============================================================================
 * WHY
 *   The active provider limit was previously hardcoded and the admin status
 *   endpoint fabricated numbers. The vendor reality is DYNAMIC: package limits
 *   change over time, are ACCOUNT-WIDE (shared by every API key / worker), and
 *   go stale.
 *
 * CONTRACT (fail-closed)
 *   - `resolveLimit()` returns an EXPLICIT `unknown` when the effective limit
 *     cannot be verified. A FRESH verified provider snapshot is the authority
 *     ceiling: it is preferred over a stale package-expiry flag, and NO manual
 *     override or operator env override may ever raise the ceiling above the
 *     verified provider capacity (they may only LOWER it).
 *   - `resolveUsage()` distinguishes MEASURED ZERO (known, used === 0) from
 *     USAGE UNKNOWN (no same-day provider witness). `null`/`undefined`/`''`
 *     usage is UNKNOWN — it must never be coerced to a measured 0 via
 *     `Number(null)`. Unknown usage is FAIL-CLOSED.
 *   - `remaining` is derived as `max(0, limit - used)`, so it is NEVER positive
 *     once the provider is already over-usage.
 *   - A manual override can only set the CEILING (limit) and metadata. It can
 *     NEVER fake usage down, clear billing, or bypass the hard stop.
 *
 * SINGLE TIMEZONE AUTHORITY
 *   WIB (Asia/Jakarta, UTC+7, no DST) date parts live here. All quota modules
 *   reuse this one implementation so the 00:00 reset and day-key rollover are
 *   consistent everywhere.
 *
 * PERSISTENCE
 *   data/quota-limit.json (new companion blob). No provider limit is ever
 *   hardcoded here — it starts `unknown` and is populated dynamically by
 *   setProviderLimit() (from provider status/headers) and setOverride()
 *   (Admin Console). Write failure is surfaced (ok:false), never swallowed.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// V5 F5 (Part A): allow a test/isolated runtime to redirect the limit blob so
// an E2E runner never mutates the repository's real `data/quota-limit.json`.
const LIMIT_BLOB_PATH = process.env.QUOTA_LIMIT_BLOB_PATH || path.join(ROOT, 'data', 'quota-limit.json');
const CONFIG_PATH = path.join(ROOT, 'config', 'quota.json');

const TZ = 'Asia/Jakarta';
const RESET_HOUR_WIB = 0;
// A provider-reported limit stays trustworthy for ~1 day + grace. After that
// it is treated as stale and the system FAILS CLOSED until re-verified.
const LIMIT_STALENESS_MS = 26 * 60 * 60 * 1000;

const REASONS = Object.freeze({
  LIMIT_UNKNOWN: 'LIMIT_UNKNOWN',
  USAGE_UNKNOWN: 'USAGE_UNKNOWN',
  PLAN_EXPIRED: 'PLAN_EXPIRED',
  LIMIT_STALE: 'LIMIT_STALE'
});

/* -------------------------------------------------------------------------- */
/* Time (single authority, WIB / Asia/Jakarta)                                 */
/* -------------------------------------------------------------------------- */

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function getWibParts(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(d);
  let Y = '', M = '', D = '', h = 0, mi = 0, s = 0;
  for (const p of parts) {
    if (p.type === 'year') Y = p.value;
    else if (p.type === 'month') M = p.value;
    else if (p.type === 'day') D = p.value;
    else if (p.type === 'hour') h = parseInt(p.value, 10);
    else if (p.type === 'minute') mi = parseInt(p.value, 10);
    else if (p.type === 'second') s = parseInt(p.value, 10);
  }
  if (h === 24) h = 0;
  const dateKey = Y + '-' + M + '-' + D;
  const dow = new Date(dateKey + 'T00:00:00Z').getUTCDay();
  return { dateKey, hour: h, minute: mi, second: s, dayOfWeek: dow, isWeekend: dow === 0 || dow === 6 };
}

function getWibDateKey(now) { return getWibParts(now).dateKey; }
function getWibDateKeyFromDate(d) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d instanceof Date ? d : new Date(d));
  } catch (_) { return getWibDateKey(d); }
}

/* -------------------------------------------------------------------------- */
/* Blob persistence                                                            */
/* -------------------------------------------------------------------------- */

function blankBlob() {
  return {
    schemaVersion: 1,
    providerLimit: null,
    providerLimitSource: null,
    providerLimitVerifiedAt: null,
    providerPeriodUsed: null,
    providerPeriodUsedVerifiedAt: null,
    providerPeriodUsedWibDate: null,
    planExpiresAt: null,
    source: 'unknown',
    resetHourWib: RESET_HOUR_WIB,
    tz: TZ,
    override: { limit: null, actor: null, reason: null, setAt: null },
    updatedAt: null
  };
}

function normalizeBlob(blob) {
  if (!blob || typeof blob !== 'object') blob = {};
  const b = Object.assign(blankBlob(), blob);
  if (!b.override || typeof b.override !== 'object') b.override = blankBlob().override;
  b.override = Object.assign({ limit: null, actor: null, reason: null, setAt: null }, b.override);
  return b;
}

function readLimitBlob() {
  try {
    const raw = fs.readFileSync(LIMIT_BLOB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, blob: normalizeBlob(parsed), error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, blob: blankBlob(), error: null };
    return { ok: false, blob: blankBlob(), error: String((err && err.message) || err) };
  }
}

function writeLimitBlob(blob) {
  try {
    fs.mkdirSync(path.dirname(LIMIT_BLOB_PATH), { recursive: true });
    const tmp = LIMIT_BLOB_PATH + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 10) + '.tmp';
    const payload = Object.assign(normalizeBlob(blob), { updatedAt: new Date().toISOString() });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, LIMIT_BLOB_PATH);
    return { ok: true, blob: payload, error: null };
  } catch (err) {
    return { ok: false, blob: null, error: String((err && err.message) || err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Cross-process lock (S2) — the limit blob is read-modified-written by BOTH    */
/* the Admin Console (setOverride/clearOverride) and worker processes           */
/* (snapshot sync via setProviderLimit). The previous design relied only on an  */
/* atomic temp+rename, which prevents TORN files but cannot prevent a LOST       */
/* UPDATE across processes (worker reads, admin writes, worker writes an older   */
/* snapshot and clobbers the admin override). This lock mirrors the exact        */
/* O_EXCL + stale-steal (> 10 s) pattern already used by lib/quota-reservation.js */
/* so the whole read->decide->write critical section is cross-process atomic.    */
/* -------------------------------------------------------------------------- */

const LIMIT_LOCK_PATH = LIMIT_BLOB_PATH + '.lock';
const LIMIT_STALE_LOCK_MS = 10 * 1000;

function acquireLimitLock() {
  try {
    fs.mkdirSync(path.dirname(LIMIT_LOCK_PATH), { recursive: true });
    const fd = fs.openSync(LIMIT_LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (_) {
    // Lock exists: steal only when clearly stale (crashed writer).
    try {
      const st = fs.statSync(LIMIT_LOCK_PATH);
      if (Date.now() - st.mtimeMs > LIMIT_STALE_LOCK_MS) {
        fs.unlinkSync(LIMIT_LOCK_PATH);
        const fd = fs.openSync(LIMIT_LOCK_PATH, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      }
    } catch (_) { /* give up */ }
    return false;
  }
}

function releaseLimitLock() {
  try { fs.unlinkSync(LIMIT_LOCK_PATH); } catch (_) {}
}

/**
 * Atomic, lock-guarded read-modify-write of the limit blob.
 *   mutator(blob) -> blob  (mutates in place; may throw to reject the mutation)
 * Returns:
 *   { ok:true,  blob, previous }                                   on success
 *   { ok:false, reason: 'LIMIT_LOCK_BUSY'|'LIMIT_READ_FAILED'|
 *                         'LIMIT_MUTATE_FAILED'|'LIMIT_WRITE_FAILED', error }
 * Fail-closed: a busy lock, unreadable blob, or failed write NEVER yields ok:true,
 * and the caller receives the previous full snapshot for audit/rollback.
 */
function mutateLimitBlob(mutator) {
  if (!acquireLimitLock()) {
    return { ok: false, reason: 'LIMIT_LOCK_BUSY', error: 'limit blob lock busy' };
  }
  try {
    const prev = readLimitBlob();
    if (!prev.ok) return { ok: false, reason: 'LIMIT_READ_FAILED', error: prev.error };
    const previous = JSON.parse(JSON.stringify(prev.blob));
    let next;
    try {
      next = mutator(prev.blob);
    } catch (err) {
      return { ok: false, reason: 'LIMIT_MUTATE_FAILED', error: String((err && err.message) || err) };
    }
    const wrote = writeLimitBlob(next);
    if (!wrote.ok) return { ok: false, reason: 'LIMIT_WRITE_FAILED', error: wrote.error };
    return { ok: true, blob: wrote.blob, previous };
  } finally {
    releaseLimitLock();
  }
}

/* -------------------------------------------------------------------------- */
/* Setters (internal code + later Admin Console)                               */
/* -------------------------------------------------------------------------- */

/**
 * Record a fresh provider snapshot (status endpoint / response headers).
 * This is the ONLY way a non-manual provider limit/usage enters the system.
 * `used === 0` is a legitimate MEASURED ZERO and is preserved as such.
 */
function applyProviderSnapshotInto(blob, o, nowMs) {
  const limit = Number(o.limit);
  if (Number.isFinite(limit) && limit > 0) {
    blob.providerLimit = Math.floor(limit);
    blob.providerLimitSource = String(o.source || 'provider');
    blob.providerLimitVerifiedAt = new Date(nowMs).toISOString();
    blob.source = 'provider';
  }
  if (o.used != null && Number.isFinite(Number(o.used)) && Number(o.used) >= 0) {
    blob.providerPeriodUsed = Math.floor(Number(o.used));
    blob.providerPeriodUsedVerifiedAt = new Date(nowMs).toISOString();
    blob.providerPeriodUsedWibDate = getWibDateKey(nowMs);
  }
  if (o.planExpiresAt) blob.planExpiresAt = String(o.planExpiresAt);
  blob.updatedAt = new Date(nowMs).toISOString();
  return blob;
}

function setProviderLimit(input) {
  const o = input || {};
  const nowMs = toMs(o.now);
  // Injected blob (test/deterministic seam): mutate in place, no IO.
  if (o.blob) {
    return { ok: true, blob: applyProviderSnapshotInto(o.blob, o, nowMs), error: null };
  }
  // Persistent path is lock-guarded so a worker's snapshot sync can never
  // clobber a concurrent admin override (lost-update across processes).
  const r = mutateLimitBlob(function (blob) { return applyProviderSnapshotInto(blob, o, nowMs); });
  if (!r.ok) return { ok: false, blob: null, error: r.reason || r.error };
  return { ok: true, blob: r.blob, error: null };
}

/**
 * Admin/operator ceiling override. Accepts ONLY a limit + metadata. Usage and
 * billing are deliberately NOT accepted, so an override can never erase spent
 * usage. Persistence failure is surfaced (ok:false), never swallowed.
 */
function applyOverrideInto(blob, o, nowMs) {
  const raw = o.limit;
  let limit = null;
  if (raw == null) {
    limit = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('override.limit must be null or a positive number');
    }
    limit = Math.floor(n);
  }
  blob.override = {
    limit,
    actor: String(o.actor || 'admin'),
    reason: String(o.reason || ''),
    setAt: new Date(nowMs).toISOString()
  };
  blob.updatedAt = new Date(nowMs).toISOString();
  return blob;
}

function setOverride(input) {
  const o = input || {};
  const nowMs = toMs(o.now);
  if (o.blob) {
    try {
      return { ok: true, blob: applyOverrideInto(o.blob, o, nowMs), error: null };
    } catch (err) {
      return { ok: false, blob: null, error: String((err && err.message) || err) };
    }
  }
  const r = mutateLimitBlob(function (blob) { return applyOverrideInto(blob, o, nowMs); });
  if (!r.ok) return { ok: false, blob: null, error: r.reason || r.error };
  return { ok: true, blob: r.blob, error: null };
}

function clearOverride(input) {
  const o = input || {};
  const nowMs = toMs(o.now);
  const apply = function (blob) {
    blob.override = { limit: null, actor: String(o.actor || 'admin'), reason: String(o.reason || 'cleared'), setAt: new Date(nowMs).toISOString() };
    blob.updatedAt = new Date(nowMs).toISOString();
    return blob;
  };
  if (o.blob) return { ok: true, blob: apply(o.blob), error: null };
  const r = mutateLimitBlob(apply);
  if (!r.ok) return { ok: false, blob: null, error: r.reason || r.error };
  return { ok: true, blob: r.blob, error: null };
}

/* -------------------------------------------------------------------------- */
/* Resolve limit (deterministic, explicit `unknown`)                           */
/* -------------------------------------------------------------------------- */

function loadConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (_) { return {}; }
}

/**
 * resolveLimit({ now, env, blob, cfg }) ->
 *   { ok:true, limit, source:'provider'|'manual'|'env', verifiedAt } OR
 *   { ok:false, limit:null, source:'expired'|'stale'|'unknown', reason }
 *
 * Resolution order (single source of truth):
 *   1. FRESH verified provider snapshot is the authoritative CEILING.
 *      A manual override / operator env may only LOWER it (never exceed the
 *      verified provider capacity). A fresh snapshot also wins over a stale
 *      package-expiry flag (the provider has been re-verified).
 *   2. Without a fresh provider snapshot:
 *      - an expired package fails closed (PLAN_EXPIRED);
 *      - a manual override / operator env may only LOWER a verified ceiling
 *        (they are an OPERATIONAL CAP, never a capacity creator);
 *      - a stale (too-old) provider snapshot fails closed (LIMIT_STALE);
 *      - otherwise LIMIT_UNKNOWN.
 * NEVER derives the active limit from the legacy config number.
 */
function resolveLimit(opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  const blob = o.blob != null ? normalizeBlob(o.blob) : readLimitBlob().blob;
  const env = o.env || process.env;
  const cfg = o.cfg || o.config || loadConfigSafe();

  // Freshness of the provider snapshot.
  const pl = Number(blob && blob.providerLimit);
  const vAt = blob && blob.providerLimitVerifiedAt;
  let providerLimit = null;
  let providerFresh = false;
  if (Number.isFinite(pl) && pl > 0 && vAt) {
    const parsedAt = Date.parse(vAt);
    const ageMs = nowMs - parsedAt;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= LIMIT_STALENESS_MS) {
      providerLimit = Math.floor(pl);
      providerFresh = true;
    }
  }

  // Manual admin override ceiling.
  const ov = blob && blob.override;
  let overrideLimit = null;
  if (ov && Number.isFinite(Number(ov.limit)) && Number(ov.limit) > 0) {
    overrideLimit = Math.floor(Number(ov.limit));
  }

  // Operator environment override ceiling.
  let envLimit = null;
  for (const k of ['ARJUM_DAILY_LIMIT', 'ARJUM_DAILY_QUOTA']) {
    const v = Number(env[k]);
    if (Number.isFinite(v) && v > 0) { envLimit = Math.floor(v); break; }
  }

  // 1. A fresh verified provider snapshot is the authority ceiling. A stale
  //    package-expiry flag must NOT lock out a re-verified provider truth, and
  //    no override may raise the ceiling above provider capacity.
  if (providerFresh) {
    let eff = providerLimit;
    let source = 'provider';
    let verifiedAt = vAt;
    if (overrideLimit != null && overrideLimit < eff) { eff = overrideLimit; source = 'manual'; verifiedAt = ov.setAt; }
    if (envLimit != null && envLimit < eff) { eff = envLimit; source = 'env'; verifiedAt = null; }
    return { ok: true, limit: eff, source, verifiedAt };
  }

  // 2. No fresh provider snapshot. An expired package fails closed.
  const planExp = (blob && blob.planExpiresAt) || (cfg && cfg.planExpiresAt);
  if (planExp) {
    const exp = Date.parse(planExp);
    if (Number.isFinite(exp) && nowMs > exp) {
      return { ok: false, limit: null, source: 'expired', reason: REASONS.PLAN_EXPIRED };
    }
  }

  // 3. Without a FRESH verified provider snapshot, an admin/operator override
  //    is an OPERATIONAL CAP only — it may LOWER a verified ceiling but can
  //    NEVER invent capacity from a stale (or absent) provider truth. Fail
  //    closed: a stale snapshot is LIMIT_STALE, otherwise LIMIT_UNKNOWN.
  if (Number.isFinite(pl) && pl > 0 && vAt) {
    return { ok: false, limit: null, source: 'stale', reason: REASONS.LIMIT_STALE };
  }

  return { ok: false, limit: null, source: 'unknown', reason: REASONS.LIMIT_UNKNOWN };
}

/* -------------------------------------------------------------------------- */
/* Resolve usage (measured zero vs unknown)                                    */
/* -------------------------------------------------------------------------- */

/**
 * resolveUsage({ now, state, used, usageKnown }) ->
 *   { known:boolean, used:number|null, measuredZero:boolean, source:string }
 *
 * Account-wide usage is only KNOWN when the provider reported a same-day
 * figure (upstreamUsedToday), which includes a legitimate 0. `null`,
 * `undefined`, or `''` usage is UNKNOWN — NOT a measured zero. Local-only
 * counts are NOT sufficient to know the account-wide remaining (multiple keys
 * share the account), so their absence is FAIL-CLOSED.
 */
function resolveUsage(opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  const state = o.state || {};
  const today = getWibDateKey(nowMs);
  const stateDate = state.currentDateWIB || state.date || null;

  // Explicit test/admin injection wins (o.usageKnown === false -> unknown).
  if (o.usageKnown === false) {
    return { known: false, used: null, measuredZero: false, source: 'unknown' };
  }
  if (o.used != null && o.usageKnown !== false) {
    const u = Math.floor(Number(o.used));
    if (Number.isFinite(u) && u >= 0) {
      return { known: true, used: u, measuredZero: u === 0, source: 'injected' };
    }
  }

  // A same-day provider witness is REQUIRED for account-wide usage to be known.
  if (stateDate !== today) {
    return { known: false, used: null, measuredZero: false, source: 'unknown' };
  }

  const upRaw = state.upstreamUsedToday;
  // null/undefined/'' => UNKNOWN (never coerced to measured 0 via Number(null)).
  if (upRaw === null || upRaw === undefined || upRaw === '') {
    return { known: false, used: null, measuredZero: false, source: 'unknown' };
  }
  const upNum = Number(upRaw);
  if (!Number.isFinite(upNum) || upNum < 0) {
    return { known: false, used: null, measuredZero: false, source: 'unknown' };
  }

  const local = Number.isFinite(Number(state.localUsedToday != null ? state.localUsedToday : state.usedToday))
    ? Math.floor(Number(state.localUsedToday != null ? state.localUsedToday : state.usedToday)) : 0;
  const authoritative = Number.isFinite(Number(state.authoritativeUsedToday))
    ? Math.floor(Number(state.authoritativeUsedToday)) : 0;
  // Conservative: never trust the lower number.
  const used = Math.max(local, Math.floor(upNum), authoritative);
  return { known: true, used, measuredZero: used === 0, source: 'provider' };
}

/**
 * Combined truth used by every consumer: limit + usage + remaining + overage.
 * `ok === false` (or remaining === null) means FAIL-CLOSED.
 */
function resolveTruth(opts) {
  const o = opts || {};
  const nowMs = toMs(o.now);
  const lim = resolveLimit(o);
  const usage = resolveUsage(o);
  const expired = lim.source === 'expired';

  const limitKnown = lim.ok === true;
  const usageKnown = usage.known === true;

  let remaining = null;
  let overage = null;
  if (limitKnown && usageKnown) {
    remaining = Math.max(0, lim.limit - usage.used);
    overage = Math.max(0, usage.used - lim.limit);
  }

  const ok = limitKnown && usageKnown && remaining != null;

  return {
    ok,
    limit: limitKnown ? lim.limit : null,
    limitSource: lim.source,
    limitKnown,
    usageKnown,
    measuredZero: usage.measuredZero,
    used: usageKnown ? usage.used : null,
    remaining,
    overage,
    expired,
    reason: !limitKnown ? lim.reason : (!usageKnown ? REASONS.USAGE_UNKNOWN : null),
    resetHourWib: RESET_HOUR_WIB,
    tz: TZ
  };
}

module.exports = {
  TZ,
  RESET_HOUR_WIB,
  LIMIT_STALENESS_MS,
  REASONS,
  LIMIT_BLOB_PATH,
  CONFIG_PATH,
  toMs,
  getWibParts,
  getWibDateKey,
  getWibDateKeyFromDate,
  blankBlob,
  normalizeBlob,
  readLimitBlob,
  writeLimitBlob,
  setProviderLimit,
  setOverride,
  clearOverride,
  resolveLimit,
  resolveUsage,
  resolveTruth,
  loadConfigSafe,
  LIMIT_LOCK_PATH,
  acquireLimitLock,
  releaseLimitLock,
  mutateLimitBlob
};
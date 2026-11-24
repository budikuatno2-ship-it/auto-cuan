'use strict';

/**
 * lib/quota-policy-bridge.js
 * ============================================================================
 * V6 (Subtask E) — AUTHORITATIVE QUOTA POLICY BRIDGE (single source of policy)
 * ============================================================================
 * ROOT-CAUSE FIX (P0):
 *   `lib/quota-config-store.js` durably saves admin policy to
 *   `data/quota-ops-config.json`, but `lib/quota-manager.js` (and the legacy
 *   `lib/quota-state.js` path) still read only `config/quota.json`. An admin
 *   saving reserve=1200 had NO effect on the manager (still 5000). This module
 *   is the ONE authoritative bridge:
 *
 *     admin PUT -> quota-config-store (durable, versioned, audited)
 *                          |
 *                          v
 *     lib/quota-policy-bridge.getEffectivePolicy(now)   <-- THE ONLY READER
 *                          |
 *      +-------------------+--------------------+
 *      v                   v                    v
 *  lib/quota-manager   lib/quota-state     lib/quota-queue-worker
 *  (getQuotaStatus,    (canConsumeQuota,   (backfill gating + queue
 *   checkBackfill)      reserveFloorFor)    obligations)
 *
 * PRECEDENCE (per knob):
 *   1. data/quota-ops-config.json (admin, versioned)  — when field != null
 *   2. config/quota.json (legacy static)              — when present
 *   3. Built-in policy defaults (below)               — last resort
 *
 * RESERVE RELEASE POLICY (no clock-only release):
 *   The weekday reserve is NEVER released automatically at 20:30 WIB.
 *   Release requires ONE of:
 *     a) all mandatory daily obligations verified complete
 *        (status EXECUTED_AND_READBACK_VERIFIED in the obligation ledger), or
 *     b) an explicit, audited admin waiver for today's WIB date
 *        (data/quota-reserve-waiver.json).
 *
 * WEEKEND POLICY:
 *   Weekend uses reserveFloorWeekend (ops store -> legacy -> 0). The 5000
 *   weekday default does NOT apply on Sat/Sun unless an admin sets it.
 *
 * UNKNOWN != ZERO:
 *   All fields keep null = UNKNOWN; a concrete 0 is a KNOWN value. Provider
 *   numbers are NEVER produced here (that is lib/quota-limit.js) — policy only.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Builtin LAST-RESORT policy defaults (never a provider/package number).
const POLICY_DEFAULTS = Object.freeze({
  reserveFloorWeekday: 5000,
  reserveFloorWeekend: 0,
  weekdayBackfillLimit: 13000,
  weekendBackfillLimit: null, // null = full remainder of usable quota
  hardStopWIB: '23:50'
});

// Mandatory daily obligations that hold the weekday reserve until verified.
const MANDATORY_OBLIGATIONS = Object.freeze([
  'broksum-ALL',
  'broksum-Foreign',
  'insider-tiered'
]);

const WAIVER_PATH = process.env.QUOTA_RESERVE_WAIVER_PATH ||
  path.join(ROOT, 'data', 'quota-reserve-waiver.json');
const OBLIGATION_PATH = process.env.QUOTA_OBLIGATION_LEDGER_PATH ||
  path.join(ROOT, 'data', 'quota-obligation-ledger.json');

let _store = null;
function store() {
  if (_store === null) {
    try { _store = require('./quota-config-store'); } catch (_) { _store = false; }
  }
  return _store || null;
}

let _legacyConfigCache = null;
let _legacyConfigCacheAt = 0;
const LEGACY_TTL_MS = 2000;

function loadLegacyConfig() {
  const nowMs = Date.now();
  if (_legacyConfigCache && (nowMs - _legacyConfigCacheAt) < LEGACY_TTL_MS) {
    return _legacyConfigCache;
  }
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'quota.json'), 'utf8')) || {};
  } catch (_) { cfg = {}; }
  _legacyConfigCache = cfg;
  _legacyConfigCacheAt = nowMs;
  return cfg;
}

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function getWibParts(now) {
  const shifted = new Date(toMs(now) + 7 * 3600 * 1000);
  const dow = shifted.getUTCDay();
  return {
    dateKey: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    isWeekend: dow === 0 || dow === 6,
    dayOfWeek: dow
  };
}

/* -------------------------------------------------------------------------- */
/* Effective policy resolution (the ONLY authoritative read path)              */
/* -------------------------------------------------------------------------- */

/**
 * getEffectivePolicy(now) -> {
 *   reserveFloorWeekday, reserveFloorWeekend, weekdayBackfillLimit,
 *   weekendBackfillLimit, hardStopWIB, configuredOperatingCap,
 *   planExpiresAt, storeVersion, sources: { field: 'ops-store'|'legacy-config'|'default' }
 * }
 */
function getEffectivePolicy(now) {
  const s = store();
  let ops = null;
  let opsVersion = null;
  if (s) {
    const r = s.get();
    if (r && r.ok) { ops = r.doc; opsVersion = r.doc.version; }
  }
  const legacy = loadLegacyConfig();

  const pick = (opsVal, legacyVal, def) => {
    if (opsVal != null && Number.isFinite(Number(opsVal))) return { value: Math.floor(Number(opsVal)), source: 'ops-store' };
    if (legacyVal != null && Number.isFinite(Number(legacyVal))) return { value: Math.floor(Number(legacyVal)), source: 'legacy-config' };
    return { value: def, source: 'default' };
  };

  const weekday = pick(ops && ops.reserveFloorWeekday, legacy.reserveFloorWeekday, POLICY_DEFAULTS.reserveFloorWeekday);
  const weekend = pick(ops && ops.reserveFloorWeekend, legacy.reserveFloorWeekend, POLICY_DEFAULTS.reserveFloorWeekend);
  const wbLimit = pick(ops && ops.weekdayBackfillLimit, legacy.weekdayBackfillLimit, POLICY_DEFAULTS.weekdayBackfillLimit);
  const webLimit = pick(ops && ops.weekendBackfillLimit, legacy.weekendBackfillLimit, POLICY_DEFAULTS.weekendBackfillLimit);

  const capOps = (ops && (ops.configuredOperatingCap != null ? ops.configuredOperatingCap : ops.dailyLimitOverride));
  const capLegacy = (legacy.dailyLimitOverride != null ? legacy.dailyLimitOverride : null);
  const cap = capOps != null && Number.isFinite(Number(capOps))
    ? { value: Math.floor(Number(capOps)), source: 'ops-store' }
    : (capLegacy != null && Number.isFinite(Number(capLegacy))
      ? { value: Math.floor(Number(capLegacy)), source: 'legacy-config' }
      : { value: null, source: 'default' });

  const defaultPriorities = ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial'];
  const priorityOrder = (ops && Array.isArray(ops.priorityOrder) && ops.priorityOrder.length)
    ? ops.priorityOrder
    : (Array.isArray(legacy.priorityOrder) && legacy.priorityOrder.length ? legacy.priorityOrder : defaultPriorities);

  const concurrency = (ops && Number.isInteger(Number(ops.concurrency)) && Number(ops.concurrency) > 0)
    ? Number(ops.concurrency)
    : (legacy.concurrency && Number.isInteger(Number(legacy.concurrency)) ? Number(legacy.concurrency) : 2);

  const rateLimit = (ops && Number.isFinite(Number(ops.rateLimit)) && Number(ops.rateLimit) > 0)
    ? Number(ops.rateLimit)
    : (legacy.rateLimit && Number.isFinite(Number(legacy.rateLimit)) ? Number(legacy.rateLimit) : 5);

  const retryCount = (ops && Number.isInteger(Number(ops.retryCount)) && Number(ops.retryCount) >= 0)
    ? Number(ops.retryCount)
    : (legacy.retryCount != null && Number.isInteger(Number(legacy.retryCount)) ? Number(legacy.retryCount) : 3);

  const backoffBaseMs = (ops && Number.isInteger(Number(ops.backoffBaseMs)) && Number(ops.backoffBaseMs) >= 100)
    ? Number(ops.backoffBaseMs)
    : (legacy.backoffBaseMs != null && Number.isInteger(Number(legacy.backoffBaseMs)) ? Number(legacy.backoffBaseMs) : 1000);

  const killSwitch = (ops && (ops.killSwitch === true || ops.killSwitch === 'true')) || legacy.killSwitch === true;

  const pausedServices = (ops && ops.pausedServices && typeof ops.pausedServices === 'object')
    ? Object.assign({}, legacy.pausedServices || {}, ops.pausedServices)
    : (legacy.pausedServices && typeof legacy.pausedServices === 'object' ? legacy.pausedServices : {});

  const backfillBudget = (ops && ops.backfillBudget != null && Number.isFinite(Number(ops.backfillBudget)))
    ? Number(ops.backfillBudget)
    : (legacy.backfillBudget != null && Number.isFinite(Number(legacy.backfillBudget)) ? Number(legacy.backfillBudget) : null);

  return {
    reserveFloorWeekday: weekday.value,
    dailyReserveFloor: weekday.value,
    reserveFloorWeekend: weekend.value,
    weekdayBackfillLimit: wbLimit.value,
    weekendBackfillLimit: webLimit.value,
    hardStopWIB: (ops && ops.hardStopWIB) || legacy.hardStopWIB || POLICY_DEFAULTS.hardStopWIB,
    configuredOperatingCap: cap.value,
    planExpiresAt: (ops && ops.planExpiresAt) || legacy.planExpiresAt || null,
    lowQuotaMode: (ops && ops.lowQuotaMode === true) || legacy.lowQuotaMode === true,
    holidayManualMode: (ops && ops.holidayManualMode) || legacy.holidayManualMode || 'normal',
    holidayManualDateWIB: (ops && ops.holidayManualDateWIB) || legacy.holidayManualDateWIB || null,
    concurrency,
    rateLimit,
    retryCount,
    backoffBaseMs,
    priorityOrder,
    killSwitch,
    pausedServices,
    backfillBudget,
    storeVersion: opsVersion,
    sources: {
      reserveFloorWeekday: weekday.source,
      reserveFloorWeekend: weekend.source,
      weekdayBackfillLimit: wbLimit.source,
      weekendBackfillLimit: webLimit.source,
      configuredOperatingCap: cap.source,
      concurrency: (ops && ops.concurrency != null) ? 'ops-store' : (legacy.concurrency != null ? 'legacy-config' : 'default'),
      rateLimit: (ops && ops.rateLimit != null) ? 'ops-store' : (legacy.rateLimit != null ? 'legacy-config' : 'default'),
      retryCount: (ops && ops.retryCount != null) ? 'ops-store' : (legacy.retryCount != null ? 'legacy-config' : 'default'),
      backoffBaseMs: (ops && ops.backoffBaseMs != null) ? 'ops-store' : (legacy.backoffBaseMs != null ? 'legacy-config' : 'default'),
      priorityOrder: (ops && ops.priorityOrder != null) ? 'ops-store' : (legacy.priorityOrder != null ? 'legacy-config' : 'default'),
      killSwitch: (ops && ops.killSwitch != null) ? 'ops-store' : (legacy.killSwitch != null ? 'legacy-config' : 'default'),
      pausedServices: (ops && ops.pausedServices != null) ? 'ops-store' : (legacy.pausedServices != null ? 'legacy-config' : 'default'),
      backfillBudget: (ops && ops.backfillBudget != null) ? 'ops-store' : (legacy.backfillBudget != null ? 'legacy-config' : 'default')
    },
    policyAsOfIso: new Date(toMs(now)).toISOString()
  };
}

/* -------------------------------------------------------------------------- */
/* Reserve floor WITHOUT clock-only release                                    */
/* -------------------------------------------------------------------------- */

/**
 * reserveFloorFor(now):
 *   - Weekend: reserveFloorWeekend policy (default 0). The weekday default
 *     does NOT leak into weekends.
 *   - Weekday: reserveFloorWeekday policy (default 5000). NO time-based
 *     release at 20:30 WIB. Release requires verified obligations or a valid
 *     admin waiver (see canReleaseReserve).
 */
function reserveFloorFor(now) {
  const policy = getEffectivePolicy(now);
  const p = getWibParts(now);
  if (p.isWeekend) return policy.reserveFloorWeekend;
  // Weekday: hold the configured floor unless release is LEGITIMATE.
  if (canReleaseReserve(now).ok) return 0;
  return policy.reserveFloorWeekday;
}

/* -------------------------------------------------------------------------- */
/* Obligation ledger (mandatory daily jobs)                                    */
/* -------------------------------------------------------------------------- */

function readObligations() {
  try { return JSON.parse(fs.readFileSync(OBLIGATION_PATH, 'utf8')) || {}; } catch (_) { return {}; }
}

function writeObligationsAtomic(doc) {
  fs.mkdirSync(path.dirname(OBLIGATION_PATH), { recursive: true });
  const tmp = OBLIGATION_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, OBLIGATION_PATH);
}

/**
 * markObligation(dateWIB, job, status, meta)
 *   status must be one of QUEUED/APPROVED/RUNNING/FAILED/RETRY_WAIT/
 *   EXECUTED_AND_READBACK_VERIFIED.
 */
function markObligation(dateWIB, job, status, meta) {
  const ALLOWED = ['QUEUED', 'APPROVED', 'RUNNING', 'FAILED', 'RETRY_WAIT', 'EXECUTED_AND_READBACK_VERIFIED'];
  const st = String(status || '').toUpperCase();
  if (!ALLOWED.includes(st)) return { ok: false, reason: 'INVALID_STATUS' };
  const doc = readObligations();
  doc.dates = doc.dates || {};
  doc.dates[String(dateWIB)] = doc.dates[String(dateWIB)] || {};
  doc.dates[String(dateWIB)][String(job)] = {
    status: st,
    at: new Date().toISOString(),
    detail: meta && meta.detail != null ? String(meta.detail).slice(0, 300) : null
  };
  doc.updatedAt = new Date().toISOString();
  try { writeObligationsAtomic(doc); return { ok: true }; } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

function getObligations(dateWIB) {
  const doc = readObligations();
  const d = doc && doc.dates && doc.dates[String(dateWIB)];
  const out = {};
  for (const job of MANDATORY_OBLIGATIONS) {
    out[job] = (d && d[job] && d[job].status) ? String(d[job].status) : 'PENDING';
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Admin waiver (audited, per-WIB-date)                                        */
/* -------------------------------------------------------------------------- */

function readWaivers() {
  try { return JSON.parse(fs.readFileSync(WAIVER_PATH, 'utf8')) || { waivers: [] }; } catch (_) { return { waivers: [] }; }
}

function writeWaiversAtomic(doc) {
  fs.mkdirSync(path.dirname(WAIVER_PATH), { recursive: true });
  const tmp = WAIVER_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, WAIVER_PATH);
}

/**
 * grantReserveWaiver({ actor, reason, dateWIB }) — explicit admin release for
 * ONE WIB date. Audited append-only (bounded to last 200).
 */
function grantReserveWaiver(input) {
  const o = input || {};
  const dateWIB = String(o.dateWIB || getWibParts(Date.now()).dateKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateWIB)) return { ok: false, reason: 'INVALID_DATE' };
  if (!String(o.actor || '').trim()) return { ok: false, reason: 'ACTOR_REQUIRED' };
  if (!String(o.reason || '').trim()) return { ok: false, reason: 'REASON_REQUIRED' };
  const doc = readWaivers();
  doc.waivers = (doc.waivers || []).filter((w) => w.dateWIB !== dateWIB);
  doc.waivers.push({
    dateWIB,
    actor: String(o.actor).slice(0, 80),
    reason: String(o.reason).slice(0, 300),
    grantedAt: new Date().toISOString()
  });
  doc.waivers = doc.waivers.slice(-200);
  try { writeWaiversAtomic(doc); return { ok: true, dateWIB }; } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

function getActiveWaiver(dateWIB) {
  const doc = readWaivers();
  return (doc.waivers || []).find((w) => w.dateWIB === String(dateWIB)) || null;
}

/* -------------------------------------------------------------------------- */
/* Legitimate reserve release decision                                         */
/* -------------------------------------------------------------------------- */

/**
 * canReleaseReserve(now) -> { ok, reason, evidence }
 *   ok:true  ONLY when (a) every mandatory obligation for today's WIB date is
 *   EXECUTED_AND_READBACK_VERIFIED, or (b) a valid admin waiver exists.
 */
function canReleaseReserve(now) {
  const p = getWibParts(now);
  const waiver = getActiveWaiver(p.dateKey);
  if (waiver) {
    return { ok: true, reason: 'ADMIN_WAIVER', evidence: { dateWIB: p.dateKey, actor: waiver.actor, grantedAt: waiver.grantedAt } };
  }
  const obs = getObligations(p.dateKey);
  const allVerified = MANDATORY_OBLIGATIONS.every((j) => obs[j] === 'EXECUTED_AND_READBACK_VERIFIED');
  if (allVerified) {
    return { ok: true, reason: 'OBLIGATIONS_VERIFIED', evidence: { dateWIB: p.dateKey, obligations: obs } };
  }
  return {
    ok: false,
    reason: 'OBLIGATIONS_PENDING',
    evidence: { dateWIB: p.dateKey, obligations: obs, pending: MANDATORY_OBLIGATIONS.filter((j) => obs[j] !== 'EXECUTED_AND_READBACK_VERIFIED') }
  };
}

/* -------------------------------------------------------------------------- */
/* Dynamic Service Authorization & Backfill Eligibility                       */
/* -------------------------------------------------------------------------- */

function reloadConfig() {
  _legacyConfigCache = null;
  _legacyConfigCacheAt = 0;
}

function isServiceAllowed(serviceName, now) {
  const policy = getEffectivePolicy(now);
  if (policy.killSwitch === true) {
    return { allowed: false, reason: 'KILL_SWITCH_ACTIVE' };
  }
  const s = String(serviceName || '').toLowerCase().trim();
  const paused = policy.pausedServices || {};
  if (paused.all === true) {
    return { allowed: false, reason: 'PAUSED_BY_ADMIN' };
  }
  if (s && (paused[s] === true || paused[serviceName] === true)) {
    return { allowed: false, reason: 'PAUSED_BY_ADMIN' };
  }
  return { allowed: true, reason: null };
}

/**
 * calculateEligibleBackfill(opts)
 * Formula Mandat Owner:
 * eligibleBackfill = Math.max(0, Math.min(remaining, configuredCap) - Math.max(reserveUnspent, mandatoryQueued) - overhead)
 */
function calculateEligibleBackfill(opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : Date.now();
  const remainingKnown = o.remaining != null ? Number(o.remaining) : null;
  if (remainingKnown == null || !Number.isFinite(remainingKnown)) return null;

  const check = isServiceAllowed('backfill', now);
  if (!check.allowed) return 0;

  const policy = getEffectivePolicy(now);
  const p = getWibParts(now);

  const configuredCap = (policy.configuredOperatingCap != null && Number.isFinite(Number(policy.configuredOperatingCap)))
    ? Number(policy.configuredOperatingCap)
    : remainingKnown;
  const usableRemaining = Math.min(remainingKnown, configuredCap);

  const reserveUnspent = reserveFloorFor(now);

  let mandatoryQueued = 0;
  if (o.mandatoryQueued != null && Number.isFinite(Number(o.mandatoryQueued))) {
    mandatoryQueued = Number(o.mandatoryQueued);
  } else {
    const obs = getObligations(p.dateKey);
    for (const job of MANDATORY_OBLIGATIONS) {
      if (obs[job] !== 'EXECUTED_AND_READBACK_VERIFIED') {
        mandatoryQueued += 100;
      }
    }
  }

  const overhead = (o.overhead != null && Number.isFinite(Number(o.overhead))) ? Number(o.overhead) : 10;

  let eligible = Math.max(0, usableRemaining - Math.max(reserveUnspent, mandatoryQueued) - overhead);

  const backfillCap = p.isWeekend
    ? (policy.weekendBackfillLimit != null ? policy.weekendBackfillLimit : policy.backfillBudget)
    : (policy.weekdayBackfillLimit != null ? policy.weekdayBackfillLimit : policy.backfillBudget);

  if (backfillCap != null && Number.isFinite(Number(backfillCap))) {
    eligible = Math.min(eligible, Number(backfillCap));
  }

  return eligible;
}

/**
 * backfillBudget(now, remainingKnown)
 *   Evaluates backfill budget using dynamic policy and formula.
 *   Fail-closed: null remaining -> null budget (UNKNOWN != ZERO).
 */
function backfillBudget(now, remainingKnown) {
  if (remainingKnown == null || !Number.isFinite(Number(remainingKnown))) return null;
  const policy = getEffectivePolicy(now);
  const p = getWibParts(now);
  const reserve = reserveFloorFor(now);
  const cap = p.isWeekend ? policy.weekendBackfillLimit : policy.weekdayBackfillLimit;
  const usable = Math.max(0, Number(remainingKnown) - reserve);
  return cap == null ? usable : Math.max(0, Math.min(cap, usable));
}

module.exports = {
  POLICY_DEFAULTS,
  MANDATORY_OBLIGATIONS,
  WAIVER_PATH,
  OBLIGATION_PATH,
  getEffectivePolicy,
  reserveFloorFor,
  canReleaseReserve,
  getObligations,
  markObligation,
  grantReserveWaiver,
  getActiveWaiver,
  backfillBudget,
  calculateEligibleBackfill,
  isServiceAllowed,
  reloadConfig,
  getWibParts,
  loadLegacyConfig
};

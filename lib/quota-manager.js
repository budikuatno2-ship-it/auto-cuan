'use strict';

/**
 * lib/quota-manager.js
 * ============================================================================
 * V6 (Subtask C) — QUOTA STATE/PROVIDER CONTRACT (fail-closed)
 * ============================================================================
 * WHY THIS REWRITE
 *   The legacy module carried TOTAL_QUOTA = 18080 plus synchronous-historical
 *   fallback numbers. Audit finding #1: unknown/missing provider evidence must
 *   NEVER be coerced to 0 or the legacy 18080 package number. A legitimate
 *   zero (measured provider zero) must be distinguishable from `null`.
 *
 * CANONICAL CONTRACT FIELDS
 *   provider_limit          claim/ceiling reported by the provider (null=unknown)
 *   provider_used           usage reported by the provider (null=unknown)
 *   provider_remaining      max(0, provider_limit - provider_used) when known
 *   configured_operating_cap admin/operator ceiling (may only LOWER, never raise)
 *   effective_limit         min(known provider limit, cap, reserve, safety) or null
 *   used                    authoritative usage (null=unknown)
 *   remaining               max(0, effective_limit - used) when both known
 *   reserved                hard reserve floor for the current WIB window
 *   available_for_backfill  remaining - reserved when both known (floor 0)
 *   usage_date              WIB date key the usage evidence belongs to
 *   reset_at                next WIB midnight (ISO)
 *   package_expiry          plan expiry (ISO or null)
 *   source_checked_at       when provider truth was last verified
 *   verification_status     'verified'|'stale'|'expired'|'unknown'|'error'
 *
 * SINGLE SOURCE OF TRUTH
 *   lib/quota-limit.js `resolveTruth` is the authority. NO package number is
 *   hardcoded here. When either the limit or usage is unknown, the result is
 *   FAIL-CLOSED (ok:false, null numeric fields), never 0/18080.
 * ============================================================================
 */

const path = require('path');

// V6 (Subtask E): authoritative POLICY bridge. All reserve/backfill/cap policy
// values now flow through lib/quota-policy-bridge.js, which reads the durable
// ops-config store (data/quota-ops-config.json) FIRST, then legacy
// config/quota.json, then builtin defaults. quota-manager never re-implements
// precedence itself anymore.
const policyBridge = require('./quota-policy-bridge');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'quota.json');
const STATE_PATH = path.join(ROOT_DIR, 'data', 'quota-state.json');

// Legacy alias constants retained ONLY for backwards-compatible exports; the
// live policy values come from the bridge (see reserveFloorFor below).
const RESERVE_FLOOR_WEEKDAY_LEGACY = policyBridge.POLICY_DEFAULTS.reserveFloorWeekday;
const WEEKEND_RESERVE_FLOOR_LEGACY = policyBridge.POLICY_DEFAULTS.reserveFloorWeekend;

// WIB (Asia/Jakarta, UTC+7 fixed offset, no DST) — single authority reuse.
let _quotaLimit = null;
function quotaLimit() {
  if (_quotaLimit === null) {
    try { _quotaLimit = require('./quota-limit'); } catch (_) { _quotaLimit = false; }
  }
  return _quotaLimit || null;
}

let _quotaState = null;
function quotaState() {
  if (_quotaState === null) {
    try { _quotaState = require('./quota-state'); } catch (_) { _quotaState = false; }
  }
  return _quotaState || null;
}

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function getWibParts(now) {
  const ms = toMs(now);
  const shifted = new Date(ms + 7 * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const h = shifted.getUTCHours();
  const mi = shifted.getUTCMinutes();
  const dow = shifted.getUTCDay();
  return {
    dateKey: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    hour: h,
    minute: mi,
    isWeekend: dow === 0 || dow === 6,
    dayOfWeek: dow
  };
}

function nextWibMidnightIso(now) {
  const p = getWibParts(now);
  // WIB midnight == UTC(+7) => compute instant 17:00Z of the prior UTC day.
  const isoDate = p.dateKey + 'T00:00:00+07:00';
  const d = new Date(isoDate);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function loadConfigSafe() {
  // V6 (Subtask E): the legacy static file remains readable for reference
  // fields, but POLICY (reserve/cap/limits) must come from the bridge.
  try {
    const cfg = JSON.parse(require('fs').readFileSync(CONFIG_PATH, 'utf8')) || {};
    return cfg;
  } catch (_) { return {}; }
}

// V6 (Subtask E): policy authority = lib/quota-policy-bridge.js.
// NO automatic release at 20:30 WIB — the bridge only releases when mandatory
// obligations are EXECUTED_AND_READBACK_VERIFIED or a valid admin waiver
// exists for today's WIB date (fail-closed otherwise).
function reserveFloorFor(now, _cfgIgnored) {
  return policyBridge.reserveFloorFor(now);
}

// V6 (Subtask E): expose the bridge decision so callers/UI can see WHY the
// reserve is held or released (obligations vs waiver vs pending).
function reserveReleaseStatus(now) {
  return policyBridge.canReleaseReserve(now);
}

function availableForBackfill(remaining, reserved) {
  if (remaining == null || reserved == null) return null;
  return Math.max(0, remaining - reserved);
}

/**
 * Build the canonical, fail-closed quota contract. Never coerces unknown to
 * 0/18080. `null` means UNKNOWN.
 */
function getQuotaStatus(now, stateOverride) {
  const ms = toMs(now);
  const cfg = loadConfigSafe();
  const st = quotaState();
  let state = stateOverride && typeof stateOverride === 'object' ? stateOverride : null;
  try {
    if (!state && st) state = st.readState(new Date(ms));
  } catch (_) { state = state || {}; }

  const ql = quotaLimit();
  let truth = { ok: false, limit: null, limitSource: 'unknown', limitKnown: false, usageKnown: false, used: null, remaining: null, overage: null, measuredZero: false, reason: 'LIMIT_UNKNOWN' };
  let providerLimit = null;
  let providerUsed = null;
  let providerRemaining = null;
  let sourceCheckedAt = null;
  let verificationStatus = 'unknown';
  let packageExpiry = cfg.planExpiresAt || null;

  if (ql) {
    try {
      truth = ql.resolveTruth({ now: ms, state, config: cfg });
      const blob = ql.readLimitBlob().blob;
      providerLimit = (blob && Number.isFinite(Number(blob.providerLimit)) && Number(blob.providerLimit) > 0) ? Math.floor(Number(blob.providerLimit)) : null;
      providerUsed = (blob && blob.providerPeriodUsedWibDate === getWibParts(ms).dateKey && Number.isFinite(Number(blob.providerPeriodUsed)) && Number(blob.providerPeriodUsed) >= 0) ? Math.floor(Number(blob.providerPeriodUsed)) : (state && state.upstreamUsedToday != null && Number.isFinite(Number(state.upstreamUsedToday)) && Number(state.upstreamUsedToday) >= 0 ? Math.floor(Number(state.upstreamUsedToday)) : null);
      sourceCheckedAt = (blob && (blob.providerLimitVerifiedAt || blob.providerPeriodUsedVerifiedAt)) || null;
      if (blob && blob.planExpiresAt) packageExpiry = blob.planExpiresAt;
      verificationStatus = truth.ok ? 'verified' : (truth.expired ? 'expired' : (truth.limitSource === 'stale' ? 'stale' : 'unknown'));
    } catch (_) {}
  }

  const effective_limit = truth.limitKnown ? truth.limit : null;
  const used = truth.usageKnown ? truth.used : null;
  const remaining = truth.ok ? Math.max(0, effective_limit - used) : null;
  // Reserve floor is an OPERATIONAL POLICY (independent of whether the
  // provider truth is currently measured), so it is always computed. Only the
  // derived `available_for_backfill` stays null while truth is unknown.
  // V6 (Subtask E): policy (reserved floor + operating cap) flows through the
  // authoritative bridge; the admin ops-config store is the primary source.
  const policy = policyBridge.getEffectivePolicy(ms);
  const reserved = reserveFloorFor(ms);
  const avail = availableForBackfill(remaining, reserved);
  const eligibleBackfill = policyBridge.calculateEligibleBackfill({ now: ms, remaining });

  const configuredCap = (state && state.operationalCap != null)
    ? state.operationalCap
    : policy.configuredOperatingCap;

  const p = getWibParts(ms);
  return {
    ok: truth.ok === true,
    used,
    total: effective_limit,
    limit: effective_limit,
    limitKnown: truth.limitKnown === true,
    usageKnown: truth.usageKnown === true,
    measuredZero: truth.measuredZero === true,
    remaining,
    overage: truth.overage != null ? truth.overage : (effective_limit != null && used != null ? Math.max(0, used - effective_limit) : null),
    reserved,
    available_for_backfill: avail,
    eligible_backfill: eligibleBackfill,
    // Dynamic policy knobs controlled by Admin Console
    concurrency: policy.concurrency,
    rateLimit: policy.rateLimit,
    retryCount: policy.retryCount,
    backoffBaseMs: policy.backoffBaseMs,
    priorityOrder: policy.priorityOrder,
    killSwitch: policy.killSwitch,
    pausedServices: policy.pausedServices,
    backfillBudget: policy.backfillBudget,
    dailyReserveFloor: policy.reserveFloorWeekday,
    // canonical fields
    provider_limit: providerLimit,
    provider_used: providerUsed,
    provider_remaining: (providerLimit != null && providerUsed != null) ? Math.max(0, providerLimit - providerUsed) : null,
    configured_operating_cap: configuredCap != null && Number.isFinite(Number(configuredCap)) ? Math.floor(Number(configuredCap)) : null,
    // Legacy alias (singular) retained for existing consumers; same value.
    configured_operating_limit: configuredCap != null && Number.isFinite(Number(configuredCap)) ? Math.floor(Number(configuredCap)) : null,
    effective_limit,
    usage_date: state && (state.currentDateWIB || state.date) ? String(state.currentDateWIB || state.date) : p.dateKey,
    reset_at: nextWibMidnightIso(ms),
    package_expiry: packageExpiry || null,
    source_checked_at: sourceCheckedAt,
    verification_status: verificationStatus,
    // legacy-compatible aliases
    reserved0: reserved,
    reserveFloorWeekday: policy.reserveFloorWeekday,
    weekendReserveFloor: policy.reserveFloorWeekend,
    reserveFloor: reserved,
    backfillLocked: avail == null ? false : (avail <= 0 || (eligibleBackfill != null && eligibleBackfill <= 0) || policy.killSwitch === true || (policy.pausedServices && (policy.pausedServices.all || policy.pausedServices.backfill))),
    lockReason: policy.killSwitch === true
      ? 'KILL_SWITCH_ACTIVE'
      : ((policy.pausedServices && (policy.pausedServices.all || policy.pausedServices.backfill))
        ? 'PAUSED_BY_ADMIN'
        : (avail == null ? null : (avail <= 0 ? 'RESERVE_FLOOR_OR_EXHAUSTED' : ((eligibleBackfill != null && eligibleBackfill <= 0) ? 'ELIGIBLE_BACKFILL_ZERO' : null)))),
    // V6 (Subtask E): authoritative policy provenance + release evidence.
    policy: {
      sources: policy.sources,
      storeVersion: policy.storeVersion,
      reserveFloorWeekday: policy.reserveFloorWeekday,
      reserveFloorWeekend: policy.reserveFloorWeekend,
      weekdayBackfillLimit: policy.weekdayBackfillLimit,
      weekendBackfillLimit: policy.weekendBackfillLimit,
      concurrency: policy.concurrency,
      rateLimit: policy.rateLimit,
      retryCount: policy.retryCount,
      backoffBaseMs: policy.backoffBaseMs,
      priorityOrder: policy.priorityOrder,
      killSwitch: policy.killSwitch,
      pausedServices: policy.pausedServices,
      backfillBudget: policy.backfillBudget,
      release: reserveReleaseStatus(ms),
      asOfWib: getWibParts(ms).dateKey
    },
    isWeekend: p.isWeekend,
    isHoliday: p.isWeekend,
    date: (state && (state.currentDateWIB || state.date)) ? String(state.currentDateWIB || state.date) : p.dateKey,
    updatedAt: new Date(ms).toISOString(),
    config: cfg
  };
}

function reloadConfig() {
  policyBridge.reloadConfig();
}

function getPolicyConfig(now) {
  return policyBridge.getEffectivePolicy(now);
}

function updatePolicyConfig(patch, opts) {
  const store = require('./quota-config-store');
  const res = store.put(patch, opts);
  if (res.ok) {
    reloadConfig();
  }
  return res;
}

function checkBackfillExecution(now, opts) {
  const status = getQuotaStatus(now, opts && opts.state);
  if (status.killSwitch === true) {
    if ((opts && opts.autoExit !== false) && process.env.NODE_ENV !== 'test') {
      console.warn('[QUOTA-MANAGER] Backfill locked (KILL_SWITCH_ACTIVE). Exiting code 0.');
      process.exit(0);
    }
    return { ok: false, reason: 'KILL_SWITCH_ACTIVE', status, exitCode: 0 };
  }
  if (status.pausedServices && (status.pausedServices.all === true || status.pausedServices.backfill === true)) {
    if ((opts && opts.autoExit !== false) && process.env.NODE_ENV !== 'test') {
      console.warn('[QUOTA-MANAGER] Backfill locked (PAUSED_BY_ADMIN). Exiting code 0.');
      process.exit(0);
    }
    return { ok: false, reason: 'PAUSED_BY_ADMIN', status, exitCode: 0 };
  }
  if (status.ok !== true) {
    // Fail-closed: unknown limit/usage NEVER backfills.
    if ((opts && opts.autoExit !== false) && process.env.NODE_ENV !== 'test') {
      console.warn('[QUOTA-MANAGER] Backfill fail-closed (UNKNOWN truth). Exiting code 0.');
      process.exit(0);
    }
    return { ok: false, status, exitCode: 0 };
  }
  if (status.available_for_backfill != null && status.available_for_backfill <= 0) {
    if ((opts && opts.autoExit !== false) && process.env.NODE_ENV !== 'test') {
      console.warn('[QUOTA-MANAGER] Backfill locked. Available: ' + status.available_for_backfill + '. Exiting code 0.');
      process.exit(0);
    }
    return { ok: false, status, exitCode: 0 };
  }
  if (status.eligible_backfill != null && status.eligible_backfill <= 0) {
    if ((opts && opts.autoExit !== false) && process.env.NODE_ENV !== 'test') {
      console.warn('[QUOTA-MANAGER] Backfill locked. Eligible: ' + status.eligible_backfill + '. Exiting code 0.');
      process.exit(0);
    }
    return { ok: false, reason: 'ELIGIBLE_BACKFILL_ZERO', status, exitCode: 0 };
  }
  return { ok: true, status };
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  RESERVE_FLOOR_WEEKDAY_LEGACY,
  WEEKEND_RESERVE_FLOOR_LEGACY,
  getQuotaStatus,
  calculateQuotaState: getQuotaStatus,
  checkBackfillExecution,
  reserveReleaseStatus,
  reloadConfig,
  getPolicyConfig,
  updatePolicyConfig,
  calculateEligibleBackfill: policyBridge.calculateEligibleBackfill,
  isServiceAllowed: policyBridge.isServiceAllowed,
  policyBridge,
  getWibParts,
  getWibInfo: function (d) {
    const p = getWibParts(d);
    return p;
  }
};

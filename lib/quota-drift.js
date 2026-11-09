'use strict';
/**
 * lib/quota-drift.js
 * ============================================================================
 * BUG-V5-P0-023 — DRIFT TRUTH: local counter vs upstream burn reconciliation
 * ============================================================================
 *
 * VPS FACTS (2026-11-05 audit)
 *   data/quota-state.json: driftDetected=true, drift=12080
 *     upstreamUsedToday = 13091, localUsedToday = 1011
 *   data/quota-burn-state.json: usedNow = 13094, stopped = RESERVE_FLOOR
 *   config/quota.json: maxQuota = 18080, reserveFloorWeekday = 5000
 *
 * TRUTH RULE (conservative, never the lower number)
 *   authoritativeUsed = max(localUsedToday, upstreamUsedToday)
 *   authoritativeRemaining = max(0, maxQuota - authoritativeUsed)
 *   -> 18080 - 13091 = 4989  (< floor 5000 on weekdays => RESERVE_FLOOR stop
 *      is reproducible: any reserve > 0 at 15:00 WIB weekday is rejected
 *      because remaining - n < floor).
 *
 * API
 *   computeDrift({localUsedToday, upstreamUsedToday, maxQuota})  -> pure math
 *   reconcile(opts)     -> adopt authoritative usage into quota-state.json
 *                          (additive fields only), append drift record to
 *                          data/quota-drift-log.jsonl (no secrets).
 *   getAuthoritativeRemaining(opts) -> number (>= 0)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'quota-state.json');
const BURN_PATH = path.join(ROOT, 'data', 'quota-burn-state.json');
const DRIFT_LOG_PATH = path.join(ROOT, 'data', 'quota-drift-log.jsonl');
const CONFIG_PATH = path.join(ROOT, 'config', 'quota.json');

function loadJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function loadConfigSafe() {
  const cfg = loadJsonSafe(CONFIG_PATH);
  return Object.assign({ maxQuota: 18080, reserveFloorWeekday: 5000, reserveFloorWeekend: 0 }, cfg || {});
}

/* WIB date parts (UTC+7 fixed offset, no DST). */
function getWibParts(now) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const shifted = new Date((Number.isFinite(ms) ? ms : Date.now()) + 7 * 3600 * 1000);
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
    isWeekend: dow === 0 || dow === 6
  };
}

/* -------------------------------------------------------------------------- */
/* PURE MATH — the drift truth                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} input { localUsedToday, upstreamUsedToday, maxQuota }
 * Either counter may be null/absent -> the present one wins; both absent -> 0.
 */
function computeDrift(input) {
  const o = input || {};
  const local = Number.isFinite(Number(o.localUsedToday)) && Number(o.localUsedToday) >= 0
    ? Math.floor(Number(o.localUsedToday)) : null;
  const upstream = Number.isFinite(Number(o.upstreamUsedToday)) && Number(o.upstreamUsedToday) >= 0
    ? Math.floor(Number(o.upstreamUsedToday)) : null;
  const maxQuota = Math.max(0, Math.floor(Number(o.maxQuota) || 0));

  let authoritativeUsed;
  if (local != null && upstream != null) authoritativeUsed = Math.max(local, upstream);
  else if (upstream != null) authoritativeUsed = upstream;
  else if (local != null) authoritativeUsed = local;
  else authoritativeUsed = 0;

  const drift = (local != null && upstream != null) ? upstream - local : 0;
  const driftDetected = drift > 0;
  const source = (local != null && upstream != null)
    ? (upstream > local ? 'upstream' : (local > upstream ? 'local' : 'equal'))
    : (upstream != null ? 'upstream-only' : (local != null ? 'local-only' : 'none'));

  return {
    localUsedToday: local,
    upstreamUsedToday: upstream,
    authoritativeUsed,
    authoritativeSource: source,
    drift,
    driftDetected,
    maxQuota,
    authoritativeRemaining: Math.max(0, maxQuota - authoritativeUsed)
  };
}

/* -------------------------------------------------------------------------- */
/* Structured drift log (append-only JSONL, no secrets)                        */
/* -------------------------------------------------------------------------- */

function appendDriftLog(record) {
  try {
    fs.mkdirSync(path.dirname(DRIFT_LOG_PATH), { recursive: true });
    fs.appendFileSync(DRIFT_LOG_PATH, JSON.stringify(record) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

function makeDriftRecord(input, nowMs) {
  const d = computeDrift(input);
  return {
    eventId: 'drift-' + Number(nowMs).toString(36) + '-' + crypto.randomBytes(5).toString('hex'),
    timestampIso: new Date(nowMs).toISOString(),
    pid: process.pid,
    eventType: 'QUOTA_DRIFT_RECONCILE',
    localUsedToday: d.localUsedToday,
    upstreamUsedToday: d.upstreamUsedToday,
    authoritativeUsed: d.authoritativeUsed,
    authoritativeSource: d.authoritativeSource,
    drift: d.drift,
    driftDetected: d.driftDetected,
    maxQuota: d.maxQuota,
    authoritativeRemaining: d.authoritativeRemaining
  };
}

/* -------------------------------------------------------------------------- */
/* Read the live state (with burn-state fallback)                              */
/* -------------------------------------------------------------------------- */

function readObservedCounters(now) {
  const nowMs = now instanceof Date ? now.getTime() : (Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const state = loadJsonSafe(STATE_PATH) || {};
  const burn = loadJsonSafe(BURN_PATH) || {};

  // Daily rollover guard: stale WIB date resets the LOCAL counter only;
  // upstream truth is never inferred from a stale file.
  const p = getWibParts(nowMs);
  let local = null;
  if (state.currentDateWIB === p.dateKey || !state.currentDateWIB) {
    if (Number.isFinite(Number(state.localUsedToday))) local = Math.max(0, Math.floor(Number(state.localUsedToday)));
  }
  let upstream = null;
  if (Number.isFinite(Number(state.upstreamUsedToday)) && Number(state.upstreamUsedToday) >= 0) {
    upstream = Math.floor(Number(state.upstreamUsedToday));
  }
  // Burn ledger is an independent upstream-side witness.
  const burnUsed = Number.isFinite(Number(burn.usedNow)) && Number(burn.usedNow) >= 0
    ? Math.floor(Number(burn.usedNow)) : null;

  const cfg = loadConfigSafe();
  const observed = { localUsedToday: local, upstreamUsedToday: upstream, burnUsed, maxQuota: Math.floor(Number(cfg.maxQuota) || 0), wibDateKey: p.dateKey };
  // Burn witness participates in the conservative max.
  if (burnUsed != null) {
    const d = computeDrift({ localUsedToday: observed.localUsedToday, upstreamUsedToday: observed.upstreamUsedToday, maxQuota: observed.maxQuota });
    observed.authoritativeUsed = Math.max(d.authoritativeUsed, burnUsed);
    observed.authoritativeRemaining = Math.max(0, observed.maxQuota - observed.authoritativeUsed);
  }
  return observed;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * reconcile(opts)
 *   Adopts the CONSERVATIVE (higher) figure as authoritative usage.
 *   Writes back additively into data/quota-state.json:
 *     authoritativeUsedToday (new field) and localUsedToday raised (never
 *     lowered below the upstream truth). Appends a structured drift record.
 *   opts: { now, statePath, driftLogPath, dryRun }
 */
function reconcile(opts) {
  const o = opts || {};
  const nowMs = o.now instanceof Date ? o.now.getTime() : (Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now());
  const statePath = o.statePath || STATE_PATH;
  const cfg = loadConfigSafe();

  const state = loadJsonSafe(statePath) || {};
  const burnPath = path.join(path.dirname(statePath), 'quota-burn-state.json');
  const burn = loadJsonSafe(burnPath) || {};

  const p = getWibParts(nowMs);
  const local = Number.isFinite(Number(state.localUsedToday)) ? Math.max(0, Math.floor(Number(state.localUsedToday))) : 0;
  const upstream = Number.isFinite(Number(state.upstreamUsedToday)) ? Math.max(0, Math.floor(Number(state.upstreamUsedToday))) : null;
  const burnUsed = Number.isFinite(Number(burn.usedNow)) ? Math.max(0, Math.floor(Number(burn.usedNow))) : null;

  const input = { localUsedToday: local, upstreamUsedToday: upstream, maxQuota: Math.floor(Number(cfg.maxQuota) || 0) };
  const d = computeDrift(input);
  let authoritativeUsed = d.authoritativeUsed;
  if (burnUsed != null) authoritativeUsed = Math.max(authoritativeUsed, burnUsed);
  const authoritativeRemaining = Math.max(0, input.maxQuota - authoritativeUsed);

  const record = {
    eventId: 'drift-' + nowMs.toString(36) + '-' + crypto.randomBytes(5).toString('hex'),
    timestampIso: new Date(nowMs).toISOString(),
    pid: process.pid,
    eventType: 'QUOTA_DRIFT_RECONCILE',
    wibDateKey: p.dateKey,
    localUsedToday: local,
    upstreamUsedToday: upstream,
    burnUsed,
    authoritativeUsed,
    authoritativeSource: authoritativeUsed === upstream || (burnUsed != null && authoritativeUsed === burnUsed && (upstream == null || upstream < burnUsed)) ? 'upstream' : (authoritativeUsed === local ? 'local' : 'upstream'),
    drift: d.drift,
    driftDetected: d.driftDetected,
    maxQuota: input.maxQuota,
    authoritativeRemaining,
    action: o.dryRun ? 'DRY_RUN' : 'ADOPTED'
  };

  if (!o.dryRun) {
    // ADDITIVE adoption: never lower localUsedToday below upstream truth.
    const nextState = Object.assign({}, state);
    nextState.authoritativeUsedToday = authoritativeUsed;
    nextState.localUsedToday = Math.max(local, upstream != null ? upstream : local, burnUsed != null ? burnUsed : local);
    nextState.usedToday = nextState.localUsedToday;
    nextState.authoritativeRemainingToday = authoritativeRemaining;
    nextState.drift = d.drift;
    nextState.driftDetected = d.driftDetected;
    nextState.currentDateWIB = p.dateKey;
    try {
      const tmp = statePath + '.' + process.pid + '.reconcile.tmp';
      fs.writeFileSync(tmp, JSON.stringify(nextState, null, 2));
      fs.renameSync(tmp, statePath);
    } catch (_) {
      record.action = 'ADOPT_FAILED';
    }
    appendDriftLog(record);
  }

  return { ok: true, drift: d.drift, driftDetected: d.driftDetected, authoritativeUsed, authoritativeRemaining, record };
}

/**
 * getAuthoritativeRemaining(opts)
 *   opts: { now, statePath, config } -> { remaining, used, maxQuota, driftDetected }
 */
function getAuthoritativeRemaining(opts) {
  const o = opts || {};
  const nowMs = o.now instanceof Date ? o.now.getTime() : (Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now());
  const statePath = o.statePath || STATE_PATH;
  const cfg = o.config || loadConfigSafe();
  const state = loadJsonSafe(statePath) || {};
  const burnPath = path.join(path.dirname(statePath), 'quota-burn-state.json');
  const burn = loadJsonSafe(burnPath) || {};

  const p = getWibParts(nowMs);
  const local = Number.isFinite(Number(state.localUsedToday)) ? Math.max(0, Math.floor(Number(state.localUsedToday))) : 0;
  const upstream = Number.isFinite(Number(state.upstreamUsedToday)) ? Math.max(0, Math.floor(Number(state.upstreamUsedToday))) : null;
  const burnUsed = Number.isFinite(Number(burn.usedNow)) ? Math.max(0, Math.floor(Number(burn.usedNow))) : null;
  const maxQuota = Math.floor(Number(cfg.maxQuota) || 0);

  const d = computeDrift({ localUsedToday: local, upstreamUsedToday: upstream, maxQuota });
  let used = d.authoritativeUsed;
  if (burnUsed != null) used = Math.max(used, burnUsed);
  const remaining = Math.max(0, maxQuota - used);

  return { remaining, used, maxQuota, drift: d.drift, driftDetected: d.driftDetected, floor: p.isWeekend ? Math.max(0, Math.floor(Number(cfg.reserveFloorWeekend) || 0)) : Math.max(0, Math.floor(Number(cfg.reserveFloorWeekday) || 0)), isWeekend: p.isWeekend, wibDateKey: p.dateKey };
}

module.exports = {
  computeDrift,
  reconcile,
  getAuthoritativeRemaining,
  readObservedCounters,
  makeDriftRecord,
  DRIFT_LOG_PATH,
  STATE_PATH,
  BURN_PATH
};

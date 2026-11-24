'use strict';

/**
 * lib/admin-schedule-engine.js
 * ============================================================================
 * V6 (Subtask D) — DURABLE SCHEDULER ENGINE
 * ============================================================================
 * Reads the config produced by lib/admin-schedule-store.js and computes the
 * REAL next run times in Asia/Jakarta (WIB), applies dependency gates,
 * idempotency keys, leases/locks, retry/catch-up, and collision detection —
 * with NO duplicate execution.
 *
 * This engine never spawns a job by itself: it is a pure decision layer that
 * the VPS cron claimer (`deploy/vps/job-wrapper.sh`) and/or a future
 * scheduler-daemon can consult. It is fully injectable so tests drive it with
 * a fake clock and a real runner fixture (no production fetch / no Telegram).
 *
 * TIME MODEL
 *   WIB = UTC+7 (Asia/Jakarta, no DST). All `now` instants are `Date` objects;
 *   the engine converts to Jakarta wall-clock internally via Intl so the
 *   "reset WIB / midnight" boundary is handled deterministically.
 * ============================================================================
 */

const store = require('./admin-schedule-store');
const controlPlane = require('./schedule-control-plane');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Jakarta wall-clock helpers                                                   */
/* -------------------------------------------------------------------------- */

function jakartaDate(now) {
  return new Date(now.getTime() + WIB_OFFSET_MS);
}

function jakartaDateKey(now) {
  const d = jakartaDate(now);
  return d.toISOString().slice(0, 10);
}

// 0=Sunday .. 6=Saturday (UTC day-of-week of the Jakarta-shifted clock).
function jakartaWeekday(now) {
  return jakartaDate(now).getUTCDay();
}

function jakartaHoursMinutes(now) {
  const d = jakartaDate(now);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function minutesToMillis(min) {
  return Math.max(0, Number(min) || 0) * 60 * 1000;
}

/**
 * Set the WIB wall-clock to a specific HH:mm on a given Jakarta date.
 * Returns a UTC Date.
 */
function jakartaInstant(y, m, d, hh, mm) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - WIB_OFFSET_MS);
}

/* -------------------------------------------------------------------------- */
/* Dependency gates + provider readiness (injectable)                           */
/* -------------------------------------------------------------------------- */

function getGateKey(jobKey) {
  return jobKey + '.done';
}

/**
 * Build the canonical dependency resolver. Callers inject:
 *   dataState     : { jobKey: true|false }  (true => dependency satisfied)
 *   providerState : { jobKey: 'READY'|'PENDING_PROVIDER'|'UNAVAILABLE' }
 *   quotaState    : { known:boolean, remaining:number|null } (null => UNKNOWN)
 * A missing provider entry is treated as UNAVAILABLE (fail-closed).
 */
function buildGates(opts) {
  const o = opts || {};
  const dataState = o.dataState || {};
  const providerState = o.providerState || {};
  const quotaState = o.quotaState || { known: false, remaining: null };
  return { dataState, providerState, quotaState };
}

/**
 * Evaluate whether `job` may run given current dependency/provider/quota.
 * Returns { ok:boolean, reason:string, details:object }.
 */
function evaluateGate(job, gates) {
  const requiresQuota = job.costClass !== 'ZERO_QUOTA';
  const q = gates.quotaState;

  if (requiresQuota) {
    // Quota UNKNOWN or zero => blocked accurately (never fake success).
    if (!q.known) {
      return { ok: false, reason: 'QUOTA_UNKNOWN', details: { costClass: job.costClass } };
    }
    if (Number(q.remaining) <= 0) {
      return { ok: false, reason: 'QUOTA_EXHAUSTED', details: { remaining: Number(q.remaining), costClass: job.costClass } };
    }
  }

  // Dependency gate: all required jobs must report success.
  const missingDeps = [];
  for (const dep of job.dependsOn || []) {
    const satisfied = gates.dataState[dep] === true;
    if (!satisfied) missingDeps.push(dep);
  }
  if (missingDeps.length > 0) {
    return { ok: false, reason: 'DEPENDENCY_BLOCKED', details: { missingDeps } };
  }

  // Provider readiness: for provider-backed jobs the upstream must be ready.
  const needsProvider = job.costClass !== 'ZERO_QUOTA';
  if (needsProvider) {
    const ps = gates.providerState[job.key];
    if (ps === 'PENDING_PROVIDER') {
      return { ok: false, reason: 'PENDING_PROVIDER', details: { providerState: ps } };
    }
    if (ps !== 'READY') {
      return { ok: false, reason: 'PROVIDER_UNAVAILABLE', details: { providerState: ps || 'UNAVAILABLE' } };
    }
  }

  return { ok: true, reason: 'READY', details: { providerState: gates.providerState[job.key] || 'N/A' } };
}

/* -------------------------------------------------------------------------- */
/* Next-run computation                                                        */
/* -------------------------------------------------------------------------- */

function isEligibleDay(job, weekday, holidaySet) {
  const days = store.normalizeDays(job.days);
  const inWeekday = days.length === 0 ? true : days.includes(weekday);
  if (!inWeekday) return false;
  if (job.marketDaysOnly) {
    if (weekday === 0 || weekday === 6) return false;
    const hs = holidaySet instanceof Set ? holidaySet : new Set(Array.isArray(holidaySet) ? holidaySet : []);
    // We don't know the date-key here without a full date; handled by callers
    // that pass isHoliday(). Default: only skip explicit weekend here.
  }
  return true;
}

/**
 * Compute the next run instant (UTC Date) for one job at/after `now`.
 *   days: [] means every day; [1..5] means Mon..Fri (0=Sun..6=Sat).
 *   holidaySet (optional): Set of 'YYYY-MM-DD' Jakarta date keys to skip.
 * Returns null when the job is disabled.
 */
function computeNextRun(job, now, opts) {
  const o = opts || {};
  if (job.enabled !== true) return null;
  const targetMinutes = store.timeToMinutes(job.timeWIB);
  if (targetMinutes == null) return null;

  const holidaySet = o.holidaySet instanceof Set ? o.holidaySet : new Set(Array.isArray(o.holidaySet) ? o.holidaySet : []);

  const startJakarta = jakartaDate(now);
  let cursor = new Date(Date.UTC(
    startJakarta.getUTCFullYear(), startJakarta.getUTCMonth(), startJakarta.getUTCDate(),
    Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0
  ) - WIB_OFFSET_MS);

  const maxDays = 370;
  for (let i = 0; i < maxDays; i++) {
    const dayKey = jakartaDateKey(cursor);
    const weekday = jakartaWeekday(cursor);
    const days = store.normalizeDays(job.days);
    const dayMatches = days.length === 0 ? true : days.includes(weekday);
    let eligible = dayMatches;
    if (job.marketDaysOnly) {
      if (weekday === 0 || weekday === 6) eligible = false;
      if (holidaySet.has(dayKey)) eligible = false;
    }
    if (eligible && cursor.getTime() >= now.getTime()) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

/**
 * Next N runs for a job (most common use: preview "next 5 runs").
 */
function computeNextRuns(job, now, count, opts) {
  const list = [];
  let cursor = now;
  for (let i = 0; i < (count || 5); i++) {
    const next = computeNextRun(job, cursor, opts);
    if (!next) break;
    list.push(next);
    cursor = new Date(next.getTime() + 60 * 1000); // +1 min so the same slot is skipped
  }
  return list;
}

/**
 * V6 (Subtask F) — TODAY'S SLOT (catch-up candidate).
 * Returns the WIB slot of the CURRENT Jakarta day for `job` (even when it is
 * already in the past), or null when today is not an eligible day. Used by
 * decideRun() so a runner that was down at 20:00 and restarts at 20:10 can
 * still catch up within the retry window instead of silently waiting a day.
 *
 * Cross-midnight catch-up is deliberately NOT supported: a slot older than the
 * current WIB day belongs to a different trade_date, and executing it late
 * would attribute data to the wrong WIB date (quota-reset boundary safety).
 */
function computeTodaySlot(job, now, holidaySet) {
  if (!job || job.enabled !== true) return null;
  const targetMinutes = store.timeToMinutes(job.timeWIB);
  if (targetMinutes == null) return null;
  const sj = jakartaDate(now);
  const slot = new Date(Date.UTC(
    sj.getUTCFullYear(), sj.getUTCMonth(), sj.getUTCDate(),
    Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0
  ) - WIB_OFFSET_MS);
  const weekday = jakartaWeekday(slot);
  const days = store.normalizeDays(job.days);
  const dayMatches = days.length === 0 ? true : days.includes(weekday);
  if (!dayMatches) return null;
  if (job.marketDaysOnly) {
    if (weekday === 0 || weekday === 6) return null;
    const hs = holidaySet instanceof Set ? holidaySet : new Set(Array.isArray(holidaySet) ? holidaySet : []);
    if (hs.has(jakartaDateKey(slot))) return null;
  }
  return slot;
}

/**
 * How long after a slot we still label a non-execution MISSED_BEYOND_CATCHUP
 * (instead of falling through to NOT_YET for the next day's slot). Keeps the
 * MISSED taxonomy honest for restart/downtime forensics without spamming old
 * slots (e.g. 00:15 jobs viewed at 23:55 the same WIB day).
 */
const MISSED_HORIZON_MS = 120 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Idempotency + leasing                                                        */
/* -------------------------------------------------------------------------- */

function idempotencyKey(job, session, version, nextRunIso) {
  return [job.key, String(session || 'scheduler'), 'v' + version, nextRunIso].join(':');
}

/**
 * In-memory lease manager keyed by idempotency key. Deterministically
 * configurable via `now` and survives across a single process runtime; the
 * durable config (store) is what survives a restart. `execute` is only called
 * once per (key, lease) in a single engine instance.
 */
function createLeaseManager(opts) {
  const o = opts || {};
  const nowFn = o.now || (() => Date.now());
  const leaseMs = o.leaseMs || 60 * 1000;
  const _leases = new Map();
  return {
    acquire(key) {
      const now = nowFn();
      const existing = _leases.get(key);
      if (existing && existing.until > now) return { ok: false, reason: 'LEASE_HELD', owner: existing.owner };
      _leases.set(key, { owner: String(o.owner || 'engine'), until: now + leaseMs });
      return { ok: true };
    },
    release(key) {
      _leases.delete(key);
    },
    has(key) {
      const existing = _leases.get(key);
      return Boolean(existing && existing.until > nowFn());
    },
    _map: _leases
  };
}

/* -------------------------------------------------------------------------- */
/* Run decision (with catch-up + retry + lease + gate)                          */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether `job` should execute at `now`, and produce a fully-described
 * execution plan (not executed here). This is the "no duplicate execution"
 * decision core.
 *
 * opts:
 *   session       — scheduler session id (defaults to 'scheduler')
 *   version       — config version (defaults to 0)
 *   gates         — from buildGates()
 *   leases        — createLeaseManager()
 *   holidaySet    — optional Set of Jakarta date keys
 *   catchUpMs     — how far back a missed run is still eligible to catch up
 *   lastResult    — { session, version, nextRunIso, status } prior state
 *   sourceState   — { jobKey: 'AVAILABLE'|'UNAVAILABLE'|'PENDING_PROVIDER' }
 *
 * Returns { shouldRun:boolean, reason:..., plan: {...}|null, gate: {...} }.
 */
function decideRun(job, now, opts) {
  const o = opts || {};
  if (job.enabled !== true) return { shouldRun: false, reason: 'DISABLED', gate: null, plan: null };

  // Catch-up model (V6 Subtask F): the effective candidate is TODAY's WIB slot
  // when it is recent (within the missed horizon), otherwise the next future
  // slot. This makes restart/downtime catch-up real: a runner down at 20:00
  // that restarts at 20:10 (retry window 20m) still executes the 20:00 slot
  // exactly once; beyond the window it is recorded MISSED_BEYOND_CATCHUP.
  const catchUpMs = o.catchUpMs != null ? Number(o.catchUpMs) : minutesToMillis(job.retryWindowMinutes);
  const missedHorizonMs = o.missedHorizonMs != null ? Number(o.missedHorizonMs) : MISSED_HORIZON_MS;
  let nextRun = computeNextRun(job, now, { holidaySet: o.holidaySet });
  const todaySlot = computeTodaySlot(job, now, o.holidaySet);
  if (todaySlot) {
    const ageMs = now.getTime() - todaySlot.getTime();
    if (ageMs >= 0 && ageMs <= missedHorizonMs) nextRun = todaySlot;
  }
  if (!nextRun) return { shouldRun: false, reason: 'NO_NEXT_RUN', gate: null, plan: null };

  const gate = evaluateGate(job, o.gates || buildGates());
  if (!gate.ok) {
    // PENDING_PROVIDER => do NOT fake success; signal retry eligibility.
    return { shouldRun: false, reason: gate.reason, gate, plan: null, retryEligible: gate.reason === 'PENDING_PROVIDER' };
  }

  // V6 (Subtask F) LEGACY EXECUTOR GUARD — P0-07:
  // While a legacy production executor (cron/PM2/systemd) of the SAME
  // side-effect class is still ACTIVE, the dynamic job MUST NOT execute:
  // two executors for one side effect = double broker-API requests / double
  // publishes. This is a hard block (not retry-eligible within the slot);
  // cutover = retire the legacy executor in the registry (approval required).
  //
  // OPT-IN CONTRACT: the guard activates when the caller passes `legacyActive`
  // (array of active legacy executor names) or `legacyGuard: true` (read the
  // registry from disk, fail-closed all-ACTIVE when missing). The production
  // runner (scripts/schedule-runner-local.js) ALWAYS passes it; pure decision
  // tests that omit it keep the pre-Subtask-F behavior.
  if (Array.isArray(o.legacyActive) || o.legacyGuard === true) {
    const legacyActive = Array.isArray(o.legacyActive)
      ? o.legacyActive
      : controlPlane.readLegacyActive(o.legacyActivePath).activeNames;
    const cls = controlPlane.SIDE_EFFECT_CLASS[job.key];
    const sameClass = cls ? controlPlane.activeExecutorsForClass(cls, legacyActive) : [];
    if (sameClass.length > 0) {
      return {
        shouldRun: false,
        reason: 'BLOCKED_LEGACY_ACTIVE',
        gate,
        plan: null,
        retryEligible: false,
        details: {
          sideEffectClass: cls,
          activeLegacyExecutors: sameClass.map((e) => e.name),
          cutover: 'Retire executor legacy di registry HANYA setelah approval (lihat lib/schedule-control-plane.js CUTOVER_PLAN_MD).'
        }
      };
    }
  }

  const nextRunIso = nextRun.toISOString();
  const session = String(o.session || 'scheduler');
  const version = Number.isInteger(Number(o.version)) ? Number(o.version) : 0;
  const key = idempotencyKey(job, session, version, nextRunIso);
  const leases = o.leases || createLeaseManager({ now: () => now.getTime() });

  const source = o.sourceState ? o.sourceState[job.key] : 'AVAILABLE';
  if (source === 'UNAVAILABLE') {
    return { shouldRun: false, reason: 'SOURCE_UNAVAILABLE', gate, plan: null, retryEligible: true };
  }
  if (source === 'PENDING_PROVIDER') {
    return { shouldRun: false, reason: 'PENDING_PROVIDER', gate, plan: null, retryEligible: true };
  }

  // Catch-up / schedule de-duplication: a job is eligible only if we are
  // at/after next run AND within the catch-up window.
  const missedBy = now.getTime() - nextRun.getTime();
  const inWindow = missedBy >= 0 && missedBy <= catchUpMs;

  if (!inWindow) {
    return { shouldRun: false, reason: missedBy < 0 ? 'NOT_YET' : 'MISSED_BEYOND_CATCHUP', gate, plan: null };
  }

  // Dedupe against prior completed run for the same session/version/next-run.
  if (o.lastResult && o.lastResult.session === session && o.lastResult.version === version &&
      o.lastResult.nextRunIso === nextRunIso && o.lastResult.status === 'DONE') {
    return { shouldRun: false, reason: 'ALREADY_DONE', gate, plan: null };
  }

  const lease = leases.acquire(key);
  if (!lease.ok) {
    return { shouldRun: false, reason: 'LEASE_HELD', gate, plan: null };
  }

  return {
    shouldRun: true,
    reason: 'READY',
    gate,
    retryEligible: false,
    plan: {
      key: job.key,
      name: job.name,
      idempotencyKey: key,
      session,
      version,
      nextRunIso,
      nextRunWIB: formatWibIso(nextRunIso),
      priority: job.priority,
      costClass: job.costClass,
      maxDurationSeconds: job.maxDurationSeconds,
      dependsOn: (job.dependsOn || []).slice(),
      leaseOwner: 'engine'
    }
  };
}

function formatWibIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const w = jakartaDate(d);
  const pad = (n) => String(n).padStart(2, '0');
  return w.toISOString().slice(0, 10) + 'T' + pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes()) + ':00+07:00';
}

/**
 * Collision check over the current doc, exposed for the endpoint preview.
 */
function detectCollisions(doc) {
  return store.listCollisions(doc);
}

function wibNowLabel(now) {
  const d = jakartaDate(now);
  const pad = (n) => String(n).padStart(2, '0');
  return d.toISOString().slice(0, 10) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' WIB';
}

module.exports = {
  WIB_OFFSET_MS,
  controlPlane,
  jakartaDate,
  jakartaDateKey,
  jakartaWeekday,
  jakartaHoursMinutes,
  jakartaInstant,
  minutesToMillis,
  getGateKey,
  buildGates,
  evaluateGate,
  isEligibleDay,
  computeNextRun,
  computeNextRuns,
  computeTodaySlot,
  MISSED_HORIZON_MS,
  idempotencyKey,
  createLeaseManager,
  decideRun,
  detectCollisions,
  formatWibIso,
  wibNowLabel,
  jakartaDateKeyForIso: formatWibIso
};
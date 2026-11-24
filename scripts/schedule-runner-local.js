#!/usr/bin/env node
'use strict';

/**
 * scripts/schedule-runner-local.js
 * ============================================================================
 * V6 (Subtask F) — REAL LOCAL SCHEDULE RUNNER (P0-07 CLOSURE)
 * ============================================================================
 * WHY THIS EXISTS
 *   The admin schedule editor writes a durable versioned doc
 *   (data/admin-schedule-config.json via lib/admin-schedule-store.js) and
 *   lib/admin-schedule-engine.js decides WIB next-runs — but until now nothing
 *   PROVED the wiring with a real process. This runner is a real, spawnable
 *   daemon (or single-tick CLI) that closes the loop:
 *
 *     admin PUT -> durable store (versioned, audited)
 *              -> runner tick (REAL PROCESS) reads the SAME store file
 *              -> engine.decideRun (WIB next-run, dependency gate, lease)
 *              -> durable file lease (no double spawn ACROSS processes)
 *              -> side-effect FIXTURE artifact (local file, zero network)
 *              -> heartbeat.json + executions.jsonl (forensic evidence)
 *
 *   It NEVER touches production: no cron install, no PM2 change, no network,
 *   no Telegram. Side effects are fixture files under the state dir. The
 *   production executor remains deploy/vps/final-schedule.cron; while its
 *   legacy executors are ACTIVE the runner's dynamic jobs are
 *   BLOCKED_LEGACY_ACTIVE (see lib/schedule-control-plane.js CUTOVER_PLAN_MD).
 *
 * STATE DIR (env SCHEDULE_RUNNER_STATE_DIR, default data/schedule-runner):
 *   heartbeat.json                — liveness + config version + last tick
 *   executions.jsonl              — append-only forensic log (DONE/BLOCKED/
 *                                   MISSED/SKIPPED/RETRIED/LEASE_HELD/...)
 *   state.json                    — per-job last result + dedupe keys
 *   leases/<sha1(idemKey)>.json   — durable cross-process lease
 *   artifacts/<job>/<tradeDate>.json — side-effect fixture (dependency gate
 *                                   reads THESE, not wall-clock time)
 *   control/clock.json            — optional fake clock { nowIso } (tests)
 *   control/gates.json            — optional { providerState, quotaState,
 *                                   sourceState, holidaySet[] } (tests)
 *   control/legacy-active.json    — optional legacy executor registry
 *
 * CLI:
 *   node scripts/schedule-runner-local.js --once [--json]
 *   node scripts/schedule-runner-local.js --loop --interval-ms 250 --max-ticks 40
 *   node scripts/schedule-runner-local.js --print-state
 *
 * WIB CORRECTNESS
 *   trade_date / next-run / cutoff are ALWAYS Asia/Jakarta (UTC+7) via
 *   engine.jakartaDateKey(). `toISOString().slice(0,10)` on a UTC instant is
 *   FORBIDDEN for trade_date (it would flip the date for 00:00-06:59 WIB).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'lib', 'admin-schedule-store.js'));
const engine = require(path.join(ROOT, 'lib', 'admin-schedule-engine.js'));
const controlPlane = require(path.join(ROOT, 'lib', 'schedule-control-plane.js'));

const STATE_DIR = process.env.SCHEDULE_RUNNER_STATE_DIR || path.join(ROOT, 'data', 'schedule-runner');
const HEARTBEAT_PATH = path.join(STATE_DIR, 'heartbeat.json');
const EXEC_LOG_PATH = path.join(STATE_DIR, 'executions.jsonl');
const RUNNER_STATE_PATH = path.join(STATE_DIR, 'state.json');
const LEASE_DIR = path.join(STATE_DIR, 'leases');
const ARTIFACT_DIR = path.join(STATE_DIR, 'artifacts');
const CONTROL_DIR = path.join(STATE_DIR, 'control');
const CLOCK_PATH = path.join(CONTROL_DIR, 'clock.json');
const GATES_PATH = path.join(CONTROL_DIR, 'gates.json');
const LEGACY_ACTIVE_PATH = process.env.SCHEDULE_LEGACY_ACTIVE_PATH || path.join(CONTROL_DIR, 'legacy-active.json');

const LEASE_TTL_MS = Number(process.env.SCHEDULE_RUNNER_LEASE_TTL_MS || 90 * 1000);
const STALE_HEARTBEAT_MS = Number(process.env.SCHEDULE_RUNNER_STALE_MS || 60 * 1000);
const BACKFILL_PREEMPT_MINUTES = 15; // stop backfill safely N minutes before Broksum
const RUNNER_SESSION = 'local-runner';

/* -------------------------------------------------------------------------- */
/* FS helpers                                                                   */
/* -------------------------------------------------------------------------- */

function ensureDirs() {
  for (const d of [STATE_DIR, LEASE_DIR, ARTIFACT_DIR, CONTROL_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(p, obj) {
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function appendJsonl(p, obj) {
  try { fs.appendFileSync(p, JSON.stringify(obj) + '\n'); } catch (_) {}
}

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

/* -------------------------------------------------------------------------- */
/* Clock + control                                                              */
/* -------------------------------------------------------------------------- */

function nowDate() {
  const fake = readJsonSafe(CLOCK_PATH, null);
  if (fake && fake.nowIso) {
    const d = new Date(fake.nowIso);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function readControlGates() {
  return readJsonSafe(GATES_PATH, {});
}

function readQuotaPolicy() {
  const p = process.env.QUOTA_OPS_CONFIG_PATH || path.join(ROOT, 'data', 'quota-ops-config.json');
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ok: true, doc };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, doc: null };
    return { ok: false, doc: null, error: String(err && err.message || err) };
  }
}

function quotaServiceFor(jobKey) {
  if (/^broksum-/.test(jobKey) || jobKey === 'ihsg' || jobKey === 'insider' || jobKey === 'fundamental' || jobKey === 'quota-backfill') return 'arjum';
  if (jobKey === 'yahoo-ohlcv') return 'yahoo';
  return 'local';
}

function quotaBlockedReason(job, policyRead, control, now) {
  if (!policyRead.ok) return 'QUOTA_POLICY_READ_FAILED';
  const policy = policyRead.doc || {};
  if (!policy) return job.costClass === 'ZERO_QUOTA' ? null : 'QUOTA_POLICY_UNKNOWN';
  const service = quotaServiceFor(job.key);
  if (policy.killSwitch === true) return 'ADMIN_KILL_SWITCH';
  const paused = policy.pausedServices || {};
  if (paused.all === true || paused[service] === true || paused[job.key] === true) return 'ADMIN_PAUSED';
  const provider = control && control.providerState && control.providerState[job.key];
  if (['HTTP_429', 'AUTH_FAILED', 'UNAVAILABLE', 'ERROR_401'].includes(provider)) return 'PROVIDER_GUARD_' + provider;
  if (job.costClass !== 'ZERO_QUOTA') {
    const quota = control && control.quotaState;
    if (!quota || quota.known !== true || !Number.isFinite(Number(quota.remaining)) || !Number.isFinite(Number(quota.limit)) || !Number.isFinite(Number(quota.used))) return 'QUOTA_UNKNOWN';
    if (quota.source === 'OFFLINE_TEST_FIXTURE') {
      const cap = Number(policy.configuredOperatingCap);
      const cost = Number(policy.endpointCostUnits && policy.endpointCostUnits[job.key]);
      const reserve = Number(policy.reserveFloorWeekday);
      const obligations = Number(policy.currentDayObligations);
      if (!Number.isFinite(cap) || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(reserve) || !Number.isFinite(obligations)) return 'QUOTA_POLICY_INCOMPLETE';
      if (Math.min(Number(quota.remaining), cap) - obligations < cost) return 'ADMIN_BUDGET_EXHAUSTED';
      if (job.costClass === 'BACKFILL' && Math.min(Number(quota.remaining), cap) - obligations - reserve < cost) return 'RESERVE_OR_OBLIGATIONS';
      return null;
    }
    if (quota.source !== 'OFFLINE_TEST_FIXTURE') {
      const asOf = Date.parse(quota.asOf || quota.as_of || '');
      const maxAge = Math.max(1, Number(policy.staleThresholdMinutes) || 120) * 60 * 1000;
      if (!Number.isFinite(asOf) || asOf > now.getTime() || now.getTime() - asOf > maxAge) return 'QUOTA_STALE_OR_UNVERIFIED';
    }
    if (Number(quota.used) + Number(quota.remaining) !== Number(quota.limit)) return 'QUOTA_INCONSISTENT';
    const cap = Number(policy.configuredOperatingCap);
    const cost = Number(policy.endpointCostUnits && policy.endpointCostUnits[job.key]);
    const obligations = Number(policy.currentDayObligations);
    const reserve = Number(policy.reserveFloorWeekday);
    if (!Number.isFinite(cap) || cap < 0) return 'QUOTA_CAP_UNKNOWN';
    if (!Number.isFinite(cost) || cost <= 0) return 'ENDPOINT_COST_UNKNOWN';
    if (!Number.isFinite(obligations) || obligations < 0) return 'OBLIGATIONS_UNKNOWN';
    if (!Number.isFinite(reserve) || reserve < 0) return 'RESERVE_UNKNOWN';
    const available = Math.min(Number(quota.remaining), cap) - obligations;
    if (available < cost) return job.costClass === 'BACKFILL' ? 'RESERVE_OR_OBLIGATIONS' : 'ADMIN_BUDGET_EXHAUSTED';
    if (job.costClass === 'BACKFILL' && available - reserve < cost) return 'RESERVE_OR_OBLIGATIONS';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Runner state (per-job last result + dedupe)                                  */
/* -------------------------------------------------------------------------- */

function loadRunnerState() {
  return readJsonSafe(RUNNER_STATE_PATH, { last: {}, logged: {}, startedAt: null, tickCount: 0 });
}

function saveRunnerState(st) {
  writeJsonAtomic(RUNNER_STATE_PATH, st);
}

/* -------------------------------------------------------------------------- */
/* Durable cross-process lease                                                  */
/* -------------------------------------------------------------------------- */

function leasePath(idemKey) { return path.join(LEASE_DIR, sha1(idemKey) + '.json'); }

function readLease(idemKey) { return readJsonSafe(leasePath(idemKey), null); }

/**
 * Acquire a durable lease via O_EXCL ('wx') — atomic across processes.
 * Stale-lease recovery: a lease whose expiresAt has passed AND whose holder
 * heartbeat is older than STALE_HEARTBEAT_MS is recovered WITH EVIDENCE
 * (RECOVERED_STALE_LEASE record). A stale lease is NEVER silently turned into
 * SUCCESS: after recovery the job still has to pass the catch-up window.
 */
function acquireDurableLease(idemKey, meta, now, record) {
  const p = leasePath(idemKey);
  const lease = {
    key: idemKey,
    owner: RUNNER_SESSION,
    pid: process.pid,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
    heartbeatAt: now.toISOString(),
    meta: meta || {}
  };
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeFileSync(fd, JSON.stringify(lease, null, 2));
    fs.closeSync(fd);
    return { ok: true, recovered: false };
  } catch (err) {
    if (err && err.code !== 'EEXIST') return { ok: false, reason: 'LEASE_IO_ERROR', error: String(err.message || err) };
    const existing = readLease(idemKey);
    if (!existing) return { ok: false, reason: 'LEASE_HELD' };
    const expired = new Date(existing.expiresAt || 0).getTime() <= now.getTime();
    const holderStale = now.getTime() - new Date(existing.heartbeatAt || existing.acquiredAt || 0).getTime() > STALE_HEARTBEAT_MS;
    if (expired && holderStale) {
      record({
        decision: 'RECOVERED_STALE_LEASE',
        jobKey: (existing.meta && existing.meta.jobKey) || meta.jobKey,
        idemKey,
        detail: { previousOwner: existing.owner, previousPid: existing.pid, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt },
        note: 'Lease stale dipulihkan dengan bukti; job TIDAK otomatis SUCCESS — tetap harus lolos catch-up window.'
      });
      try { fs.unlinkSync(p); } catch (_) {}
      try {
        const fd = fs.openSync(p, 'wx');
        fs.writeFileSync(fd, JSON.stringify(lease, null, 2));
        fs.closeSync(fd);
        return { ok: true, recovered: true };
      } catch (_) {
        return { ok: false, reason: 'LEASE_HELD' };
      }
    }
    return { ok: false, reason: 'LEASE_HELD', holder: { owner: existing.owner, pid: existing.pid, expiresAt: existing.expiresAt } };
  }
}

function releaseDurableLease(idemKey) {
  try { fs.unlinkSync(leasePath(idemKey)); } catch (_) {}
}

/** Any ACTIVE (non-expired) lease belonging to a different job of the same provider. */
function findProviderBusyLease(provider, jobKey, now) {
  if (!provider) return null;
  let files = [];
  try { files = fs.readdirSync(LEASE_DIR); } catch (_) { return null; }
  for (const f of files) {
    const lease = readJsonSafe(path.join(LEASE_DIR, f), null);
    if (!lease || !lease.meta) continue;
    if (lease.meta.jobKey === jobKey) continue;
    if (lease.meta.provider !== provider) continue;
    if (new Date(lease.expiresAt || 0).getTime() > now.getTime()) return lease;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Side-effect fixture (the ONLY "execution" — zero network)                    */
/* -------------------------------------------------------------------------- */

function artifactPath(jobKey, tradeDateWib) {
  return path.join(ARTIFACT_DIR, jobKey, tradeDateWib + '.json');
}

function artifactExists(jobKey, tradeDateWib) {
  return fs.existsSync(artifactPath(jobKey, tradeDateWib));
}

function executeFixtureSideEffect(plan, tradeDateWib, now) {
  const p = artifactPath(plan.key, tradeDateWib);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomic(p, {
    jobKey: plan.key,
    sideEffect: 'FIXTURE',
    tradeDateWib,
    executedAtWib: engine.formatWibIso(now.toISOString()),
    executedAtIso: now.toISOString(),
    configVersion: plan.version,
    idempotencyKey: plan.idempotencyKey,
    nextRunIso: plan.nextRunIso,
    pid: process.pid,
    session: plan.session,
    note: 'Side-effect fixture lokal (tanpa network/Telegram). Bukti eksekusi runner nyata.'
  });
  return p;
}

/* -------------------------------------------------------------------------- */
/* Dependency gate from REAL artifacts (not wall-clock)                         */
/* -------------------------------------------------------------------------- */

function buildDataStateFromArtifacts(tradeDateWib) {
  const dataState = {};
  for (const def of store.JOB_CATALOG) {
    dataState[def.key] = artifactExists(def.key, tradeDateWib);
  }
  return dataState;
}

/* -------------------------------------------------------------------------- */
/* WIB helpers                                                                  */
/* -------------------------------------------------------------------------- */

function wibMinutes(now) { return engine.jakartaHoursMinutes(now); }

function inForbiddenWindow(now) {
  const m = wibMinutes(now);
  return m >= 23 * 60 + 50 || m < 10; // 23:50-00:10 WIB hard stop
}

/* -------------------------------------------------------------------------- */
/* Backfill preemption (safe stop before Broksum)                               */
/* -------------------------------------------------------------------------- */

function preemptBackfillIfNeeded(doc, now, record) {
  const broksum = doc.jobs['broksum-all'];
  if (!broksum || !broksum.enabled) return null;
  const nextBroksum = engine.computeNextRun(broksum, now, {});
  if (!nextBroksum) return null;
  const msUntil = nextBroksum.getTime() - now.getTime();
  if (msUntil < 0 || msUntil > BACKFILL_PREEMPT_MINUTES * 60 * 1000) return null;
  // Within the preempt window: any ACTIVE backfill lease must yield.
  let files = [];
  try { files = fs.readdirSync(LEASE_DIR); } catch (_) { return null; }
  for (const f of files) {
    const lease = readJsonSafe(path.join(LEASE_DIR, f), null);
    if (!lease || !lease.meta || lease.meta.costClass !== 'BACKFILL') continue;
    if (new Date(lease.expiresAt || 0).getTime() <= now.getTime()) continue;
    try { fs.unlinkSync(path.join(LEASE_DIR, f)); } catch (_) {}
    record({
      decision: 'PREEMPT_BACKFILL',
      jobKey: lease.meta.jobKey,
      idemKey: lease.key,
      detail: { broksumNextRunWib: engine.formatWibIso(nextBroksum.toISOString()), msUntilBroksum: msUntil },
      note: 'Backfill panjang dihentikan aman sebelum Broksum; reserve kuota wajib tetap tersedia (floor weekday 5000).'
    });
    return lease.meta.jobKey;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Heartbeat + execution log                                                    */
/* -------------------------------------------------------------------------- */

function writeHeartbeat(info) {
  writeJsonAtomic(HEARTBEAT_PATH, Object.assign({
    runner: 'schedule-runner-local',
    pid: process.pid,
    updatedAt: new Date().toISOString()
  }, info));
}

function makeRecorder(now, st) {
  return function record(rec) {
    const line = Object.assign({
      ts: now.toISOString(),
      tsWib: engine.formatWibIso(now.toISOString()),
      tradeDateWib: engine.jakartaDateKey(now),
      pid: process.pid,
      session: RUNNER_SESSION
    }, rec);
    appendJsonl(EXEC_LOG_PATH, line);
    if (rec.dedupeKey) st.logged[rec.dedupeKey] = true;
  };
}

/* -------------------------------------------------------------------------- */
/* TICK — one full decision+execution pass                                      */
/* -------------------------------------------------------------------------- */

function tick(opts) {
  const o = opts || {};
  ensureDirs();
  const now = o.now instanceof Date ? o.now : nowDate();
  const st = loadRunnerState();
  st.tickCount = Number(st.tickCount || 0) + 1;
  if (!st.startedAt) st.startedAt = now.toISOString();
  const record = makeRecorder(now, st);

  const read = store.get();
  if (!read.ok) {
    record({ decision: 'STORE_READ_FAILED', jobKey: '*', detail: { error: read.error } });
    writeHeartbeat({ status: 'STORE_READ_FAILED', tickCount: st.tickCount, nowWib: engine.wibNowLabel(now) });
    saveRunnerState(st);
    return { ok: false, reason: 'STORE_READ_FAILED', decisions: [] };
  }
  const doc = read.doc;
  const tradeDateWib = engine.jakartaDateKey(now); // WIB-correct trade date (never UTC slice)
  const legacy = controlPlane.readLegacyActive(LEGACY_ACTIVE_PATH);
  const control = readControlGates();
  const policyRead = readQuotaPolicy();
  const holidaySet = new Set(Array.isArray(control.holidaySet) ? control.holidaySet : []);
  const forbidden = inForbiddenWindow(now);

  // Backfill preemption guard (safe stop approaching Broksum).
  preemptBackfillIfNeeded(doc, now, record);

  const dataState = Object.assign(buildDataStateFromArtifacts(tradeDateWib), control.dataState || {});
  const gates = engine.buildGates({
    dataState,
    providerState: control.providerState || {},
    quotaState: control.quotaState || { known: false, remaining: null }
  });

  const decisions = [];
  const jobs = Object.values(doc.jobs)
    .filter((j) => j && j.enabled)
    .sort((a, b) => (a.priority - b.priority) || a.key.localeCompare(b.key));

  for (const job of jobs) {
    const usesQuota = job.costClass !== 'ZERO_QUOTA';

    if (job.marketDaysOnly) {
      const wd = engine.jakartaWeekday(now);
      if (wd === 0 || wd === 6 || holidaySet.has(tradeDateWib)) {
        const dk = job.key + ':' + tradeDateWib + ':SKIPPED_DAY';
        if (!st.logged[dk]) {
          record({ decision: 'SKIPPED', jobKey: job.key, reason: holidaySet.has(tradeDateWib) ? 'IDX_HOLIDAY' : 'WEEKEND', dedupeKey: dk,
            detail: { tradeDateWib, weekday: wd } });
          decisions.push({ jobKey: job.key, decision: 'SKIPPED', reason: holidaySet.has(tradeDateWib) ? 'IDX_HOLIDAY' : 'WEEKEND' });
        }
        continue;
      }
    }

    const quotaBlock = usesQuota ? quotaBlockedReason(job, policyRead, control, now) : null;
    if (quotaBlock) {
      const dk = job.key + ':' + tradeDateWib + ':' + quotaBlock;
      if (!st.logged[dk]) {
        record({ decision: 'BLOCKED', jobKey: job.key, reason: quotaBlock, dedupeKey: dk,
          detail: { service: quotaServiceFor(job.key), providerState: control.providerState && control.providerState[job.key] || 'UNKNOWN' } });
        decisions.push({ jobKey: job.key, decision: 'BLOCKED', reason: quotaBlock });
      }
      continue;
    }

    // 23:50-00:10 WIB hard stop for quota-consuming jobs (mirrors job-wrapper.sh).
    if (forbidden && usesQuota) {
      const dk = job.key + ':' + tradeDateWib + ':FORBIDDEN_WINDOW';
      if (!st.logged[dk]) {
        record({ decision: 'BLOCKED', jobKey: job.key, reason: 'FORBIDDEN_WINDOW', dedupeKey: dk,
          detail: { windowWib: '23:50-00:10', costClass: job.costClass },
          note: 'Hard stop WIB; job kuota tidak boleh start/lanjut di jendela terlarang.' });
        decisions.push({ jobKey: job.key, decision: 'BLOCKED', reason: 'FORBIDDEN_WINDOW' });
      }
      continue;
    }


    // Once-per-trade-date contract (P0-07): a job already DONE for THIS WIB
    // trade_date is NOT re-executed even when the admin moved its time and a
    // new versioned slot appears later the same day. Scenario: edit 20:00->20:30
    // while the 20:00 job runs => one job completes, the new schedule takes
    // effect on the NEXT eligible day, never a double spawn / double broker burn.
    const prevLast = st.last[job.key] || null;
    if (prevLast && prevLast.status === 'DONE' && prevLast.tradeDateWib === tradeDateWib) {
      const dk = job.key + ':' + tradeDateWib + ':ALREADY_DONE_TODAY';
      if (!st.logged[dk]) {
        record({ decision: 'SKIPPED', jobKey: job.key, reason: 'ALREADY_DONE_TODAY', dedupeKey: dk,
          detail: { doneNextRunIso: prevLast.nextRunIso, doneVersion: prevLast.version, currentVersion: doc.version },
          note: 'Slot hari ini sudah DONE; perubahan jadwal admin berlaku untuk hari bursa berikutnya (kontrak versioned, tanpa double spawn).' });
        decisions.push({ jobKey: job.key, decision: 'SKIPPED', reason: 'ALREADY_DONE_TODAY' });
      }
      continue;
    }

    const last = prevLast;
    const d = engine.decideRun(job, now, {
      session: RUNNER_SESSION,
      version: doc.version,
      gates,
      holidaySet,
      lastResult: last,
      sourceState: control.sourceState || {},
      legacyActive: legacy.activeNames
    });

    if (!d.shouldRun) {
      const reason = d.reason;
      if (reason === 'NOT_YET' || reason === 'ALREADY_DONE') continue; // silent (no spam)
      const dk = job.key + ':' + (d.plan ? d.plan.nextRunIso : tradeDateWib) + ':' + reason;
      const dedupeKey = reason === 'MISSED_BEYOND_CATCHUP'
        ? job.key + ':' + tradeDateWib + ':MISSED'
        : dk;
      if (st.logged[dedupeKey]) continue;
      const decision = reason === 'MISSED_BEYOND_CATCHUP' ? 'MISSED'
        : (reason === 'BLOCKED_LEGACY_ACTIVE' || reason === 'QUOTA_EXHAUSTED' || reason === 'QUOTA_UNKNOWN' ||
           reason === 'DEPENDENCY_BLOCKED' || reason === 'PROVIDER_UNAVAILABLE' || reason === 'SOURCE_UNAVAILABLE') ? 'BLOCKED'
        : (reason === 'PENDING_PROVIDER') ? 'RETRIED'
        : reason;
      record({ decision, jobKey: job.key, reason, dedupeKey,
        detail: d.details || (d.gate && d.gate.details) || {},
        retryEligible: d.retryEligible === true });
      decisions.push({ jobKey: job.key, decision, reason });
      continue;
    }

    const plan = d.plan;

    // Provider mutex: two different jobs sharing the same broker API must not
    // double-request. If another ACTIVE lease holds the same provider => defer.
    const provider = usesQuota && /BROKER_SUMMARY/.test(controlPlane.SIDE_EFFECT_CLASS[job.key] || '')
      ? 'ARJUM_BROKER_API' : null;
    const busy = findProviderBusyLease(provider, job.key, now);
    if (busy) {
      const dk = job.key + ':' + plan.nextRunIso + ':PROVIDER_BUSY';
      if (!st.logged[dk]) {
        record({ decision: 'BLOCKED', jobKey: job.key, reason: 'PROVIDER_BUSY', dedupeKey: dk,
          detail: { provider, heldBy: busy.meta && busy.meta.jobKey, holderPid: busy.pid },
          note: 'Broker API sama sedang dipakai job lain — tidak boleh dobel request.' });
        decisions.push({ jobKey: job.key, decision: 'BLOCKED', reason: 'PROVIDER_BUSY' });
      }
      continue;
    }

    // Durable cross-process lease (no double spawn even across two runners).
    const lease = acquireDurableLease(plan.idempotencyKey, {
      jobKey: job.key, provider, costClass: job.costClass, nextRunIso: plan.nextRunIso, version: plan.version
    }, now, record);
    if (!lease.ok) {
      const dk = job.key + ':' + plan.nextRunIso + ':LEASE_HELD';
      if (!st.logged[dk]) {
        record({ decision: 'LEASE_HELD', jobKey: job.key, reason: 'LEASE_HELD', dedupeKey: dk,
          detail: lease.holder || {}, idempotencyKey: plan.idempotencyKey,
          note: 'Job sudah dipegang proses lain — tidak ada double spawn.' });
        decisions.push({ jobKey: job.key, decision: 'LEASE_HELD', reason: 'LEASE_HELD' });
      }
      continue;
    }

    // EXECUTE the fixture side effect, then release the lease.
    const startMs = Date.now();
    let artifact = null;
    let execError = null;
    try {
      artifact = executeFixtureSideEffect(plan, tradeDateWib, now);
    } catch (err) {
      execError = String((err && err.message) || err);
    }
    const durationMs = Date.now() - startMs;
    releaseDurableLease(plan.idempotencyKey);

    if (execError) {
      // FAILED — never disguised as SUCCESS; retry-eligible within window.
      st.last[job.key] = { session: plan.session, version: plan.version, nextRunIso: plan.nextRunIso, status: 'FAILED' };
      record({ decision: 'FAILED', jobKey: job.key, reason: 'SIDE_EFFECT_ERROR', idempotencyKey: plan.idempotencyKey,
        detail: { error: execError }, retryEligible: true });
      decisions.push({ jobKey: job.key, decision: 'FAILED', reason: 'SIDE_EFFECT_ERROR' });
      continue;
    }

    const isRetry = last && last.status === 'FAILED' && last.nextRunIso === plan.nextRunIso;
    st.last[job.key] = {
      session: plan.session, version: plan.version, nextRunIso: plan.nextRunIso, status: 'DONE',
      tradeDateWib,
      lastStartWib: engine.formatWibIso(now.toISOString()),
      lastEndWib: engine.formatWibIso(new Date(now.getTime() + durationMs).toISOString()),
      lastSuccessWib: engine.formatWibIso(now.toISOString()),
      lastResult: 'DONE',
      artifact: path.relative(ROOT, artifact)
    };
    record({
      decision: isRetry ? 'RETRIED_DONE' : 'DONE',
      jobKey: job.key,
      reason: 'READY',
      idempotencyKey: plan.idempotencyKey,
      configVersion: plan.version,
      nextRunIso: plan.nextRunIso,
      nextRunWib: plan.nextRunWIB,
      tradeDateWib,
      durationMs,
      artifact: path.relative(ROOT, artifact),
      leaseRecovered: lease.recovered === true
    });
    decisions.push({ jobKey: job.key, decision: isRetry ? 'RETRIED_DONE' : 'DONE', artifact });
  }

  writeHeartbeat({
    status: policyRead.ok ? 'OK' : 'QUOTA_POLICY_READ_FAILED',
    tickCount: st.tickCount,
    nowWib: engine.wibNowLabel(now),
    tradeDateWib,
    configVersion: doc.version,
    quotaPolicyVersion: policyRead.doc && policyRead.doc.version != null ? policyRead.doc.version : null,
    providerQuotaKnown: !!(control.quotaState && control.quotaState.known === true),
    configUpdatedAt: doc.updatedAt,
    legacyActiveCount: legacy.activeNames.length,
    forbiddenWindow: forbidden,
    lastDecisions: decisions.slice(0, 20)
  });
  saveRunnerState(st);
  return { ok: true, tickCount: st.tickCount, configVersion: doc.version, tradeDateWib, decisions };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                          */
/* -------------------------------------------------------------------------- */

function printState() {
  ensureDirs();
  const st = loadRunnerState();
  const hb = readJsonSafe(HEARTBEAT_PATH, null);
  const read = store.get();
  process.stdout.write(JSON.stringify({
    stateDir: STATE_DIR,
    heartbeat: hb,
    configVersion: read.ok ? read.doc.version : null,
    last: st.last,
    tickCount: st.tickCount
  }, null, 2) + '\n');
}

function main(argv) {
  const args = new Set(argv);
  ensureDirs();
  if (args.has('--print-state')) { printState(); return; }
  if (args.has('--loop')) {
    const intervalIdx = argv.indexOf('--interval-ms');
    const interval = intervalIdx >= 0 ? Math.max(20, Number(argv[intervalIdx + 1]) || 1000) : 1000;
    const maxIdx = argv.indexOf('--max-ticks');
    const maxTicks = maxIdx >= 0 ? Number(argv[maxIdx + 1]) || Infinity : Infinity;
    const durationIdx = argv.indexOf('--max-duration-ms');
    const deadline = durationIdx >= 0 ? Date.now() + Number(argv[durationIdx + 1] || 0) : Infinity;
    let n = 0;
    const timer = setInterval(() => {
      try { tick({}); } catch (err) {
        appendJsonl(EXEC_LOG_PATH, { ts: new Date().toISOString(), decision: 'TICK_ERROR', detail: { error: String((err && err.message) || err) } });
      }
      n++;
      if (n >= maxTicks || Date.now() > deadline) { clearInterval(timer); }
    }, interval);
    tick({});
    writeHeartbeat(Object.assign(readJsonSafe(HEARTBEAT_PATH, {}), { status: 'LOOP_STARTED', intervalMs: interval }));
    return;
  }
  // default: --once
  const result = tick({});
  if (args.has('--json')) process.stdout.write(JSON.stringify(result) + '\n');
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  tick,
  main,
  nowDate,
  STATE_DIR,
  HEARTBEAT_PATH,
  EXEC_LOG_PATH,
  RUNNER_STATE_PATH,
  LEASE_DIR,
  ARTIFACT_DIR,
  CONTROL_DIR,
  LEGACY_ACTIVE_PATH,
  readQuotaPolicy,
  quotaBlockedReason,
  acquireDurableLease,
  releaseDurableLease,
  leasePath,
  artifactPath,
  artifactExists,
  buildDataStateFromArtifacts,
  inForbiddenWindow,
  loadRunnerState
};

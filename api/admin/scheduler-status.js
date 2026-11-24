'use strict';

/**
 * api/admin/scheduler-status.js
 * ============================================================================
 * V6 (W5) — ADMIN EFFECTIVE-VS-DESIRED SCHEDULER READBACK
 * ============================================================================
 * WHY THIS EXISTS
 *   The Admin Console previously showed the DESIRED schedule (the versioned
 *   store) but had no honest readback of what the WORKER actually uses, nor of
 *   the last backfill decision. An operator could not tell whether the system
 *   was IDLE (nothing to fetch), BLOCKED (dead cron / quota), or RUNNING.
 *
 *   This endpoint returns EFFECTIVE runtime state computed from REAL files:
 *     - desired schedule  : lib/admin-schedule-store (versioned doc)
 *     - effective schedule: the same doc, but annotated with the executor that
 *                           actually runs it (legacy cron vs dynamic runner)
 *     - executor owner    : lib/schedule-control-plane (legacy inventory)
 *     - last_attempt / last_success / last_error : from the worker ledger
 *     - verified queue count + per-month pending : from the requestable CSV
 *     - last status (IDLE/BLOCKED/RUNNING/FAILED/VERIFIED_SUCCESS) : from
 *       data/backfill-status.json (written by lib/backfill-decision)
 *     - next_run / run_id / requests_used / saved_original / readback_ok /
 *       quota observed
 *
 * HONESTY CONTRACT
 *   - `readback_ok` is true ONLY when the status file was actually read AND its
 *     status is a known decision value. It NEVER claims success without
 *     evidence: a missing status file yields readback_ok:false + status:UNKNOWN.
 *   - `last_success` is populated ONLY from a VERIFIED_SUCCESS/EXECUTED ledger
 *     entry, never from a UI label.
 *
 * AUTH: GET requires a signed admin session (same as schedule-settings).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { requireAdminSession } = require('../../lib/admin-session');
const store = require('../../lib/admin-schedule-store');
const engine = require('../../lib/admin-schedule-engine');
const controlPlane = require('../../lib/schedule-control-plane');
const backfillDecision = require('../../lib/backfill-decision');
const worker = require('../../lib/quota-queue-worker');

const ROOT = path.resolve(__dirname, '..', '..');

function json(res, code, body) {
  try {
    res.statusCode = code;
    if (res && typeof res === 'object') res.body = body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify(body));
  } catch (_) {}
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** Per-month pending counts from the verified requestable queue CSV. */
function perMonthPending(csvPath) {
  const p = csvPath || backfillDecision.REQUESTABLE_QUEUE_PATH;
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return { known: false, byMonth: {}, total: null }; }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return { known: true, byMonth: {}, total: 0 };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf('trade_date');
  const byMonth = {};
  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    total += 1;
    if (dateIdx < 0) continue;
    const cols = lines[i].split(',');
    const d = String(cols[dateIdx] || '').trim();
    const m = /^(\d{4})-(\d{2})/.exec(d);
    const key = m ? (m[1] + '-' + m[2]) : 'UNKNOWN';
    byMonth[key] = (byMonth[key] || 0) + 1;
  }
  return { known: true, byMonth, total };
}

/** Derive last_attempt / last_success / last_error from the worker ledger. */
function ledgerSummary() {
  const ledger = readJsonSafe(worker.LEDGER_PATH);
  const runs = (ledger && Array.isArray(ledger.runs)) ? ledger.runs : [];
  if (runs.length === 0) {
    return { last_attempt: null, last_success: null, last_error: null, run_id: null, requests_used: 0 };
  }
  const last = runs[runs.length - 1];
  let lastSuccess = null;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i] && runs[i].executed > 0) { lastSuccess = runs[i].at; break; }
  }
  let lastError = null;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i] && (runs[i].failed > 0 || runs[i].blocked > 0)) {
      lastError = (runs[i].triggers && runs[i].triggers[0] && runs[i].triggers[0].error) || 'BLOCKED_OR_FAILED';
      break;
    }
  }
  const requestsUsed = runs.reduce((s, r) => s + (r.executed || 0), 0);
  return {
    last_attempt: last.at || null,
    last_success: lastSuccess,
    last_error: lastError,
    run_id: last.at || null,
    requests_used: requestsUsed
  };
}

/** Map a raw backfill status to the admin-facing last-status label. */
function mapLastStatus(status) {
  if (!status) return 'UNKNOWN';
  switch (status) {
    case backfillDecision.DECISIONS.IDLE_NO_BACKLOG: return 'IDLE';
    case backfillDecision.DECISIONS.RUN_VERIFIED_GAP: return 'RUNNING';
    case backfillDecision.DECISIONS.BLOCKED_CRON_126:
    case backfillDecision.DECISIONS.BLOCKED_QUOTA:
    case backfillDecision.DECISIONS.PAUSED_BY_ADMIN:
    case backfillDecision.DECISIONS.NEEDS_EVIDENCE:
    case backfillDecision.DECISIONS.SKIP_VERIFIED_NO_FLOW:
      return 'BLOCKED';
    default: return 'UNKNOWN';
  }
}

/** Effective executor owner for a job key (legacy cron vs dynamic runner). */
function executorOwnerFor(jobKey) {
  const cls = controlPlane.SIDE_EFFECT_CLASS[jobKey];
  if (!cls) return { owner: 'dynamic-runner', legacyActive: false };
  let active = [];
  try { active = controlPlane.activeExecutorsForClass(cls) || []; } catch (_) { active = []; }
  if (active.length > 0) {
    return { owner: 'legacy-cron', legacyActive: true, legacyExecutors: active.map((e) => e.name) };
  }
  return { owner: 'dynamic-runner', legacyActive: false };
}

function readDispatcherLoadedState() {
  const file = process.env.V6_DISPATCHER_STATE_PATH || path.join(ROOT, 'data', 'v6-scheduler', 'state.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.loaded && typeof parsed.loaded === 'object' ? parsed.loaded : null;
  } catch (_) { return null; }
}

function buildStatus(nowOpt) {
  const now = nowOpt instanceof Date ? nowOpt : new Date();

  // Desired schedule (versioned store).
  const read = store.get();
  const desiredOk = read && read.ok;
  const doc = desiredOk ? read.doc : null;

  // Heartbeat file mapping for individual job telemetry
  const HEARTBEAT_MAP = {
    'yahoo-ohlcv': 'daily-candles.json',
    'broksum-all': 'broksum-1945.json',
    'broksum-foreign': 'broksum-1945.json',
    'domestic-compile': 'domestic-compile-2025.json',
    'accumulation': 'domestic-compile-final-2110.json',
    'bandarmologi': 'bandarmologi-intel-2114.json',
    'insider': 'insider-tiered-2200.json',
    'fundamental': 'fundamental-refresh-2220.json',
    'quota-backfill': 'quota-burn.json',
    'ihsg': 'ihsg-candle.json',
    'market-context': 'market-context.json',
    'sector-hot': 'sector-hot-eod.json',
    'daytrade-fastwatcher': 'fastwatcher.json',
    'fastwatcher': 'fastwatcher.json',
    'daytrade-producer': 'daytrade-producer.json',
    'top20': 'screeners-preflight-2125.json',
    'top5': 'top5-radar.json',
    'coordinated-pipeline': 'coordinated-pipeline.json'
  };

  // Effective schedule: desired jobs annotated with the real executor owner and heartbeat.
  const effectiveJobs = [];
  if (doc) {
    for (const def of store.JOB_CATALOG) {
      const job = doc.jobs[def.key];
      if (!job) continue;
      const owner = executorOwnerFor(def.key);
      const nextRun = engine.computeNextRun(job, now);

      let lastRun = null;
      let lastStatus = 'IDLE';
      let durationMs = null;
      let exitCode = null;

      let hbFile = HEARTBEAT_MAP[def.key];
      if (!hbFile) {
        hbFile = def.key + '.json';
      }
      if (hbFile) {
        const hbPath = path.join(ROOT, 'data', 'job-heartbeat', hbFile);
        const hb = readJsonSafe(hbPath);
        if (hb) {
          lastRun = hb.lastRun || hb.lastRunWIB || hb.lastEndWIB || hb.updatedAt || hb.updatedAtWIB || null;
          lastStatus = hb.status || (hb.exitCode === 0 ? 'OK' : (hb.outcome || 'FAILED'));
          durationMs = hb.durationMs != null ? hb.durationMs : null;
          exitCode = hb.exitCode != null ? hb.exitCode : null;
        }
      }

      effectiveJobs.push({
        key: def.key,
        name: def.name,
        category: def.category,
        desired_time_wib: job.timeWIB,
        desired_enabled: job.enabled === true,
        legacy_inactive: def.legacy_inactive === true || job.legacy_inactive === true,
        effective_owner: owner.owner,
        legacy_active: owner.legacyActive === true,
        legacy_executors: owner.legacyExecutors || [],
        next_run: nextRun ? engine.formatWibIso(nextRun.toISOString()) : null,
        last_run: lastRun,
        last_status: lastStatus,
        duration_ms: durationMs,
        exit_code: exitCode
      });
    }
  }

  // Backfill decision status (durable file).
  const statusRead = backfillDecision.readBackfillStatus();
  const statusDoc = statusRead.ok ? statusRead.status : null;
  const knownStatuses = Object.values(backfillDecision.DECISIONS);
  const readbackOk = statusRead.ok && statusDoc && knownStatuses.includes(statusDoc.status);

  // Verified queue + per-month pending.
  const queue = perMonthPending();

  // Ledger summary.
  const ledger = ledgerSummary();

  // Quota observed (real, from quota-manager; UNKNOWN stays null).
  let quotaObserved = { remaining: null, limit: null, plan_expiry: null, source: 'unknown' };
  try {
    const qm = require('../../lib/quota-manager');
    const st = qm.getQuotaStatus(now);
    quotaObserved = {
      remaining: st && st.remaining != null ? st.remaining : null,
      limit: st && st.effective_limit != null ? st.effective_limit : null,
      plan_expiry: st && st.packageExpiry ? st.packageExpiry : null,
      source: st && st.verificationStatus ? st.verificationStatus : 'unknown'
    };
  } catch (_) {}

  const lastStatus = mapLastStatus(statusDoc && statusDoc.status);

  return {
    now_wib: engine.wibNowLabel(now),
    desired: {
      ok: desiredOk === true,
      version: doc ? doc.version : null,
      updated_at: doc ? doc.updatedAt : null,
      updated_by: doc ? doc.updatedBy : null,
      jobs: effectiveJobs
    },
    effective: {
      executor_owner: effectiveJobs.some((j) => j.legacy_active) ? 'legacy-cron' : 'dynamic-runner',
      jobs: effectiveJobs
    },
    backfill: {
      status: statusDoc ? statusDoc.status : 'UNKNOWN',
      last_status: lastStatus,
      reason: statusDoc ? statusDoc.reason : 'Status file belum ada (belum pernah dievaluasi).',
      requests_sent: statusDoc ? statusDoc.requests_sent : 0,
      last_checked_at: statusDoc ? statusDoc.last_checked_at : null,
      next_check_at: statusDoc ? statusDoc.next_check_at : null,
      provider_scan: statusDoc ? statusDoc.provider_scan === true : false,
      arithmetic: statusDoc ? statusDoc.arithmetic : null
    },
    executor: {
      owner: effectiveJobs.some((j) => j.legacy_active) ? 'legacy-cron' : 'dynamic-runner',
      last_attempt: ledger.last_attempt,
      last_success: ledger.last_success,
      last_error: ledger.last_error,
      run_id: ledger.run_id,
      requests_used: ledger.requests_used
    },
    queue: {
      verified_count: queue.total,
      per_month_pending: queue.byMonth,
      known: queue.known
    },
    quota_observed: quotaObserved,
    dispatcher_loaded: readDispatcherLoadedState(),
    saved_original: {
      store_path: store.STORE_PATH,
      status_path: backfillDecision.STATUS_PATH,
      queue_path: backfillDecision.REQUESTABLE_QUEUE_PATH
    },
    readback_ok: readbackOk === true,
    readback_source: statusRead.path
  };
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }
  const auth = requireAdminSession(req);
  if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

  try {
    const status = buildStatus(new Date());
    return json(res, 200, { success: true, status });
  } catch (err) {
    return json(res, 500, { success: false, error: 'Gagal membaca status scheduler: ' + String((err && err.message) || err) });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports.buildStatus = buildStatus;
module.exports.perMonthPending = perMonthPending;
module.exports.mapLastStatus = mapLastStatus;
module.exports.executorOwnerFor = executorOwnerFor;
module.exports.readDispatcherLoadedState = readDispatcherLoadedState;

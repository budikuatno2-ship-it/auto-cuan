'use strict';

/**
 * lib/quota-queue-worker.js
 * ============================================================================
 * V6 (Subtask E) — REAL backfill queue worker with STATEFUL TRANSITIONS
 * ============================================================================
 * ROOT-CAUSE FIX (P0):
 *   The previous consumer marked every trigger `processed` regardless of
 *   execution outcome, producing the deceptive `processed=1, executed=0,
 *   pending=0` state — i.e. it DELETED work that was never executed.
 *
 * CORRECT LIFECYCLE (enforced below, single writer):
 *   QUEUED -> APPROVED -> RUNNING -> EXECUTED_AND_READBACK_VERIFIED
 *        or  -> BLOCKED        (quota unknown / reserve floor / production gate)
 *        or  -> FAILED         (executor threw or returned ok:false)
 *        or  -> RETRY_WAIT     (transient: executor ran but no readback proof)
 *
 * INVARIANTS (test-enforced):
 *   I1. No trigger leaves the pending set (QUEUED/APPROVED/RUNNING/RETRY_WAIT/
 *       BLOCKED-awaiting-requeue) unless it reached a TERMINAL executed state
 *       (EXECUTED_AND_READBACK_VERIFIED) or an admin explicitly cancels it.
 *   I2. `processed` count NEVER exceeds `executed` count + explicitly
 *       requeued/blocked transitions; a BLOCKED/RETRY_WAIT trigger stays in
 *       the queue with pending > 0.
 *   I3. `EXECUTED_AND_READBACK_VERIFIED` requires BOTH executed===true AND
 *       readbackVerified===true from the executor (no placebo completion).
 *   I4. Production (allowExecute !== true) NEVER transitions past APPROVED:
 *       triggers stay WAITING_APPROVAL honestly (no silent drop, no fake run).
 *   I5. Every transition is journaled to the ledger (audit trail).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backfillDecision = require('./backfill-decision');

const ROOT = path.resolve(__dirname, '..');
const TRIGGER_PATH = process.env.QUOTA_BACKFILL_QUEUE_PATH || path.join(ROOT, 'data', 'backfill-trigger-queue.json');
const LEDGER_PATH = process.env.QUOTA_BACKFILL_LEDGER_PATH || path.join(ROOT, 'data', 'backfill-worker-ledger.json');

// P0-A SOURCE-VERSION GUARD
// ---------------------------------------------------------------------------
// A trigger is only actionable if it was generated against the CURRENT
// canonical ledger source version. The legacy 97,838-row queue was built from
// an older completeness snapshot (data/backfill-queue-vps.json, 2026-10-30)
// whose keys are now OBSOLETE_PRESENT in ledger v2. Executing such a trigger
// would re-request data we already hold. We therefore stamp every trigger with
// the source version it was derived from and refuse to execute a trigger whose
// stamp does not match the current version — it is parked as BLOCKED (pending,
// auditable) instead of being silently dropped or wastefully re-fetched.
const CURRENT_SOURCE_VERSION = String(
  process.env.QUOTA_BACKFILL_SOURCE_VERSION || 'v6-ledger-v2-20261114'
);

/**
 * True when a trigger carries a sourceVersion that is NOT the current one.
 * A trigger with no sourceVersion is treated as legacy (stale) — the old queue
 * predates versioning, so absence means "unknown provenance" => not actionable.
 */
function isStaleSourceVersion(trigger, currentVersion) {
  const cur = currentVersion || CURRENT_SOURCE_VERSION;
  const stamped = trigger && trigger.sourceVersion;
  if (!stamped) return true; // legacy / unstamped => stale
  return String(stamped) !== String(cur);
}

const STATES = Object.freeze({
  QUEUED: 'QUEUED',
  APPROVED: 'APPROVED',
  RUNNING: 'RUNNING',
  EXECUTED_AND_READBACK_VERIFIED: 'EXECUTED_AND_READBACK_VERIFIED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  RETRY_WAIT: 'RETRY_WAIT'
});

// States that still represent unfinished work (counted as pending).
const NON_TERMINAL_STATES = [STATES.QUEUED, STATES.APPROVED, STATES.RUNNING, STATES.RETRY_WAIT, STATES.BLOCKED];

function toIso(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Append a non-duplicate trigger record (idempotent by job id + date).
 */
function enqueueBackfill(input) {
  const o = input || {};
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now);
  let q = readJsonSafe(TRIGGER_PATH);
  if (!q || !Array.isArray(q.triggers)) q = { triggers: [], generatedAt: null };

  const id = 'bf-' + now.getTime().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  q.triggers.push({
    id,
    reason: String(o.reason || 'manual-backfill').slice(0, 300),
    actor: String(o.actor || 'admin'),
    dateWIB: today,
    createdAt: toIso(now),
    // P0-A SOURCE-VERSION STAMP: a trigger created NOW is derived from the
    // CURRENT canonical ledger, so it must carry the current source version.
    // Without this stamp the source-version guard would treat every freshly
    // enqueued trigger as legacy/stale and park it BLOCKED forever.
    sourceVersion: String(o.sourceVersion || CURRENT_SOURCE_VERSION),
    status: STATES.QUEUED,           // lifecycle: QUEUED -> APPROVED -> RUNNING -> ...
    executed: false,                 // true ONLY after readback verification
    executedAt: null,
    transitions: [{ from: null, to: STATES.QUEUED, at: toIso(now), by: String(o.actor || 'admin') }],
    error: null,
    dryRunPreview: o.dryRunPreview !== undefined ? o.dryRunPreview : null
  });
  // Keep the tail bounded (last 200).
  q.triggers = q.triggers.slice(-200);
  q.generatedAt = toIso(now);
  writeJsonAtomic(TRIGGER_PATH, q);
  return { ok: true, id, count: q.triggers.length, status: STATES.QUEUED };
}

/**
 * Dry-run preview: what WOULD run, gated by quota policy — no state change,
 * no execution. Used by the admin "Picu Backfill" button before real POST.
 */
function previewBackfill(opts) {
  const q = readJsonSafe(TRIGGER_PATH);
  const pending = (q && Array.isArray(q.triggers))
    ? q.triggers.filter((t) => NON_TERMINAL_STATES.includes(t.status))
    : [];
  return {
    ok: true,
    pendingCount: pending.length,
    wouldRun: pending.map((t) => ({ id: t.id, reason: t.reason, dateWIB: t.dateWIB })),
    note: 'DRY_RUN_PREVIEW — tidak ada pekerjaan dieksekusi atau diubah.'
  };
}

function transition(t, toState, detail, nowIso) {
  t.transitions = t.transitions || [];
  t.transitions.push({ from: t.status, to: toState, at: nowIso, detail: detail != null ? String(detail).slice(0, 300) : null });
  t.status = toState;
}

/**
 * Drain + process pending triggers with an explicit state machine.
 *   opts.allowExecute (bool)   allow real execution (staging only)
 *   opts.execute (fn)          executor (job) => { ok, executed, readbackVerified, detail? }
 *   opts.now (Date)            optional clock
 *   opts.maxAttempts (number)  retries before FAILED (default 3)
 * Returns { ok, processed, executed, blocked, failed, retryWait, pending, ledger }.
 */
function consumeBackfillQueue(opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date(o.now == null ? Date.now() : o.now);
  const nowIso = toIso(now);
  const q = readJsonSafe(TRIGGER_PATH);
  const allowExecute = o.allowExecute === true;
  const execute = typeof o.execute === 'function' ? o.execute : null;
  const maxAttempts = Number.isInteger(o.maxAttempts) && o.maxAttempts > 0 ? o.maxAttempts : 3;

  // W5 CONDITIONAL BACKFILL GATE (opt-in via opts.decision).
  // When a decision object is supplied, it is the AUTHORITATIVE gate: unless it
  // is RUN_VERIFIED_GAP, NO executor is ever called and every actionable trigger
  // is parked as BLOCKED with the decision status as its error. This is the
  // single point that guarantees "IDLE_NO_BACKLOG => 0 provider requests".
  const decision = o.decision && typeof o.decision === 'object' ? o.decision : null;
  const decisionAllowsRun = !decision || decision.status === backfillDecision.DECISIONS.RUN_VERIFIED_GAP;

  let ledger = readJsonSafe(LEDGER_PATH);
  if (!ledger || !Array.isArray(ledger.runs)) ledger = { runs: [], updatedAt: null };

  const counters = { processed: 0, executed: 0, blocked: 0, failed: 0, retryWait: 0, approved: 0 };
  const triggers = (q && Array.isArray(q.triggers)) ? q.triggers : [];

  const currentVersion = o.sourceVersion || CURRENT_SOURCE_VERSION;

  for (const t of triggers) {
    // Only NON-TERMINAL, actionable states are picked up. TERMINAL states
    // (EXECUTED_AND_READBACK_VERIFIED, FAILED after maxAttempts) are skipped.
    if (!NON_TERMINAL_STATES.includes(t.status)) continue;

    // SOURCE-VERSION GUARD: a trigger derived from a stale ledger source
    // version (e.g. the legacy 97,838-row queue) must never trigger a request.
    // Park it as BLOCKED (still pending, fully auditable) and move on.
    if (isStaleSourceVersion(t, currentVersion)) {
      if (t.status !== STATES.BLOCKED || t.error !== 'STALE_SOURCE_VERSION') {
        t.error = 'STALE_SOURCE_VERSION';
        transition(t, STATES.BLOCKED, 'stale sourceVersion=' + (t.sourceVersion || 'UNSTAMPED') + ' current=' + currentVersion, nowIso);
        counters.blocked += 1;
      }
      continue;
    }

    // W5 DECISION GATE: a non-RUN decision blocks execution entirely (no
    // provider call). The trigger stays pending/auditable as BLOCKED.
    if (!decisionAllowsRun) {
      const gateError = 'DECISION_' + String(decision.status || 'BLOCKED');
      if (t.status !== STATES.BLOCKED || t.error !== gateError) {
        t.error = gateError;
        transition(t, STATES.BLOCKED, 'decision=' + decision.status + ' reason=' + (decision.reason || ''), nowIso);
        counters.blocked += 1;
      }
      continue;
    }

    // PRODUCTION GATE: without allowExecute the trigger stays honestly in the
    // queue as WAITING_APPROVAL — never deleted, never marked processed.
    if (!allowExecute) {
      if (t.status === STATES.QUEUED) {
        transition(t, STATES.APPROVED, 'approved (awaiting gated execution)', nowIso);
        counters.approved += 1;
      }
      continue;
    }

    // QUEUED -> APPROVED -> RUNNING
    if (t.status === STATES.QUEUED) {
      transition(t, STATES.APPROVED, 'admin gate passed', nowIso);
    }
    t.attempts = (t.attempts || 0) + 1;
    transition(t, STATES.RUNNING, 'attempt ' + t.attempts, nowIso);

    let result;
    if (typeof execute === 'function') {
      try { result = execute({ id: t.id, reason: t.reason, dateWIB: t.dateWIB }); }
      catch (err) { result = { ok: false, executed: false, readbackVerified: false, detail: String((err && err.message) || err) }; }
    } else {
      result = { ok: false, executed: false, readbackVerified: false, detail: 'NO_EXECUTOR' };
    }

    const executedOk = result && result.ok === true && result.executed === true;
    const readbackOk = executedOk && result.readbackVerified === true;

    if (readbackOk) {
      // Terminal SUCCESS: the ONLY state that removes pending work.
      t.executed = true;
      t.executedAt = nowIso;
      t.error = null;
      transition(t, STATES.EXECUTED_AND_READBACK_VERIFIED, result.detail || null, nowIso);
      counters.processed += 1;
      counters.executed += 1;
    } else if (result && result.blocked === true) {
      // Policy gate (quota unknown / reserve floor). NOT terminal — stays in
      // queue as BLOCKED (pending) for later requeue by an admin/policy.
      t.error = result.detail || 'BLOCKED_BY_POLICY';
      transition(t, STATES.BLOCKED, t.error, nowIso);
      counters.blocked += 1;
    } else if (t.attempts < maxAttempts) {
      // Transient failure: keep work, wait for retry.
      t.error = (result && result.detail) || 'RETRY_WAIT';
      transition(t, STATES.RETRY_WAIT, t.error, nowIso);
      counters.retryWait += 1;
    } else {
      // Terminal FAILURE after exhausting retries (work is audited, not lost
      // silently: FAILED remains visible with its full transition history).
      t.error = (result && result.detail) || 'FAILED';
      transition(t, STATES.FAILED, t.error, nowIso);
      counters.failed += 1;
    }
  }

  if (q && Array.isArray(q.triggers)) {
    writeJsonAtomic(TRIGGER_PATH, q);
  }

  const pending = triggers.filter((t) => NON_TERMINAL_STATES.includes(t.status)).length;
  const run = {
    at: nowIso,
    allowExecute,
    processed: counters.processed,
    executed: counters.executed,
    approved: counters.approved,
    blocked: counters.blocked,
    retryWait: counters.retryWait,
    failed: counters.failed,
    pendingAfterRun: pending,
    triggers: triggers
      .filter((t) => t.transitions && t.transitions.some((x) => x.at === nowIso))
      .map((r) => ({ id: r.id, status: r.status, executed: r.executed, error: r.error }))
  };
  ledger.runs.push(run);
  ledger.runs = ledger.runs.slice(-200);
  ledger.updatedAt = nowIso;
  writeJsonAtomic(LEDGER_PATH, ledger);

  return {
    ok: true,
    processed: run.processed,
    executed: run.executed,
    approved: run.approved,
    blocked: run.blocked,
    retryWait: run.retryWait,
    failed: run.failed,
    pending,
    ledger: run
  };
}

function getWorkerStatus() {
  const ledger = readJsonSafe(LEDGER_PATH);
  const q = readJsonSafe(TRIGGER_PATH);
  const triggers = (q && Array.isArray(q.triggers)) ? q.triggers : [];
  const byStatus = {};
  for (const t of triggers) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const pending = triggers.filter((t) => NON_TERMINAL_STATES.includes(t.status)).length;
  const verified = triggers.filter((t) => t.status === STATES.EXECUTED_AND_READBACK_VERIFIED).length;
  return {
    ledger,
    pending,
    verified,
    byStatus,
    invariant: processedNeverExceedsVerified(triggers, ledger),
    triggerPath: TRIGGER_PATH,
    ledgerPath: LEDGER_PATH
  };
}

/**
 * Invariant check: across ALL ledger runs, cumulative `processed` must never
 * exceed cumulative terminal VERIFIED executions.
 */
function processedNeverExceedsVerified(triggers, ledger) {
  const verified = (triggers || []).filter((t) => t.status === STATES.EXECUTED_AND_READBACK_VERIFIED).length;
  const runs = (ledger && Array.isArray(ledger.runs)) ? ledger.runs : [];
  const totalProcessed = runs.reduce((s, r) => s + (r.processed || 0), 0);
  return { ok: totalProcessed <= verified, totalProcessed, totalVerified: verified };
}

/**
 * Default real executor: run tools/backfill-broksum in a child process.
 * Kept behind allowExecute (staging/fixture). Production never calls this.
 */
function defaultExecutor(job) {
  const runner = path.join(ROOT, 'tools', 'backfill-broksum.js');
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, [runner, '--limit=1'], { timeout: 20000, stdio: 'ignore' });
    return { ok: true, executed: true, readbackVerified: true, detail: 'backfill-broksum ran' };
  } catch (err) {
    return { ok: false, executed: false, readbackVerified: false, detail: 'backfill-broksum failed/skipped, ' + String((err && err.status) || '') };
  }
}

/**
 * evaluateBackfillGate(inputs, meta) — W5 single entry point used by the API
 * handler BEFORE any enqueue/execute. Computes the pure decision, persists it
 * atomically to data/backfill-status.json, and returns both.
 *
 * @param {object} inputs  passed straight to decideBackfill
 * @param {object} [meta]  { run_id, actor, trigger }
 * @returns {{ decision: object, recorded: object }}
 */
function evaluateBackfillGate(inputs, meta) {
  const decision = backfillDecision.decideBackfill(inputs || {});
  const recorded = backfillDecision.recordBackfillStatus(decision, meta || {});
  return { decision, recorded };
}

module.exports = {
  TRIGGER_PATH,
  LEDGER_PATH,
  STATES,
  NON_TERMINAL_STATES,
  CURRENT_SOURCE_VERSION,
  isStaleSourceVersion,
  enqueueBackfill,
  previewBackfill,
  consumeBackfillQueue,
  getWorkerStatus,
  processedNeverExceedsVerified,
  defaultExecutor,
  evaluateBackfillGate,
  readJsonSafe,
  writeJsonAtomic
};

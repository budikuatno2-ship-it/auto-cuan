'use strict';

/**
 * test/v6-quota-queue-states.test.js
 * ============================================================================
 * V6 (Subtask E) — BACKFILL QUEUE STATE MACHINE CONTRACT
 * ============================================================================
 * Proves the P0 fix for the deceptive `processed=1, executed=0, pending=0`
 * outcome. The ONLY terminal success state is EXECUTED_AND_READBACK_VERIFIED.
 * Blocked/Waiting/Retry transitions NEVER delete unexecuted work.
 * Lifecycle: QUEUED -> APPROVED -> RUNNING -> EXECUTED_AND_READBACK_VERIFIED
 *                                        |-> BLOCKED / FAILED / RETRY_WAIT
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-queue-')); }

function loadWorker(tmp) {
  const prevQ = process.env.QUOTA_BACKFILL_QUEUE_PATH;
  const prevL = process.env.QUOTA_BACKFILL_LEDGER_PATH;
  process.env.QUOTA_BACKFILL_QUEUE_PATH = path.join(tmp, 'queue.json');
  process.env.QUOTA_BACKFILL_LEDGER_PATH = path.join(tmp, 'ledger.json');
  const p = path.join(ROOT, 'lib', 'quota-queue-worker.js');
  delete require.cache[require.resolve(p)];
  const worker = require(p);
  return { worker, restore: () => {
    if (prevQ === undefined) delete process.env.QUOTA_BACKFILL_QUEUE_PATH; else process.env.QUOTA_BACKFILL_QUEUE_PATH = prevQ;
    if (prevL === undefined) delete process.env.QUOTA_BACKFILL_LEDGER_PATH; else process.env.QUOTA_BACKFILL_LEDGER_PATH = prevL;
  } };
}

function readQueue(worker) { return worker.readJsonSafe(worker.TRIGGER_PATH); }

/* ========================================================================== */
/* G. Full happy-path transition: QUEUED -> APPROVED -> RUNNING -> VERIFIED    */
/* ========================================================================== */

test('G: happy path ends ONLY at EXECUTED_AND_READBACK_VERIFIED with full journal', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'daily broksum', actor: 'budi' });
    assert.equal(enq.status, worker.STATES.QUEUED);

    const drained = worker.consumeBackfillQueue({
      allowExecute: true,
      execute: () => ({ ok: true, executed: true, readbackVerified: true, detail: 'ran + readback ok' })
    });
    assert.equal(drained.processed, 1);
    assert.equal(drained.executed, 1, 'processed == executed (no placebo)');
    assert.equal(drained.pending, 0, 'queue empty only AFTER verified execution');

    const q = readQueue(worker);
    const t = q.triggers.find((x) => x.id === enq.id);
    assert.equal(t.status, worker.STATES.EXECUTED_AND_READBACK_VERIFIED);
    assert.equal(t.executed, true);
    const chain = t.transitions.map((x) => x.to).join('->');
    assert.match(chain, /QUEUED->APPROVED->RUNNING->EXECUTED_AND_READBACK_VERIFIED/, 'got: ' + chain);

    // Invariant check passes.
    const status = worker.getWorkerStatus();
    assert.equal(status.invariant.ok, true);
    assert.equal(status.verified, 1);
  } finally { restore(); }
});

/* ========================================================================== */
/* G. BLOCKED (policy) keeps the job in the queue — no deletion of real work   */
/* ========================================================================== */

test('G: quota-blocked executor -> BLOCKED, trigger REMAINS pending (no PROCESSED without executed)', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'backfill inside reserve floor', actor: 'budi' });
    const drained = worker.consumeBackfillQueue({
      allowExecute: true,
      execute: () => ({ ok: false, executed: false, readbackVerified: false, blocked: true, detail: 'RESERVE_FLOOR' })
    });
    assert.equal(drained.blocked, 1);
    assert.equal(drained.processed, 0, 'BLOCKED is NEVER counted as processed');
    assert.equal(drained.executed, 0);
    assert.equal(drained.pending, 1, 'blocked job stays in the queue');

    const q = readQueue(worker);
    const t = q.triggers.find((x) => x.id === enq.id);
    assert.equal(t.status, worker.STATES.BLOCKED);
    assert.equal(t.executed, false, 'work not deleted');
    const status = worker.getWorkerStatus();
    assert.equal(status.pending, 1, 'admin sees honest pending=1');
    assert.equal(status.byStatus[worker.STATES.BLOCKED], 1);
  } finally { restore(); }
});

/* ========================================================================== */
/* G. RETRY_WAIT keeps transient failures alive until maxAttempts               */
/* ========================================================================== */

test('G: transient failures -> RETRY_WAIT (kept), then FAILED only after maxAttempts', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'flaky provider', actor: 'budi' });
    let attempts = 0;
    const fail = () => { attempts += 1; return { ok: false, executed: false, readbackVerified: false, detail: 'TIMEOUT attempt ' + attempts }; };

    const r1 = worker.consumeBackfillQueue({ allowExecute: true, execute: fail });
    assert.equal(r1.retryWait, 1);
    const r2 = worker.consumeBackfillQueue({ allowExecute: true, execute: fail });
    assert.equal(r2.retryWait, 1);
    assert.equal(attempts, 2, 'same trigger retried, not dropped');
    const r3 = worker.consumeBackfillQueue({ allowExecute: true, execute: fail, maxAttempts: 3 });
    assert.equal(r3.failed, 1, 'terminal FAILED after exhausting retries');
    assert.equal(r3.processed, 0, 'FAILED is not processed/executed');

    const q = readQueue(worker);
    const t = q.triggers.find((x) => x.id === enq.id);
    assert.equal(t.status, worker.STATES.FAILED);
    assert.equal(t.executed, false);
    assert.equal(t.attempts, 3);
    // Full history audited.
    const chain = t.transitions.map((x) => x.to);
    assert.deepEqual(chain.slice(0, 4), ['QUEUED', 'APPROVED', 'RUNNING', 'RETRY_WAIT']);
    assert.equal(chain[chain.length - 1], worker.STATES.FAILED);
  } finally { restore(); }
});

test('G: executor throw is captured as failure, never crashes the drain, job preserved', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'boom', actor: 'budi' });
    const drained = worker.consumeBackfillQueue({
      allowExecute: true,
      execute: () => { throw new Error('executor exploded'); }
    });
    assert.equal(drained.retryWait, 1, 'throw = transient first attempt');
    const q = readQueue(worker);
    const t = q.triggers.find((x) => x.id === enq.id);
    assert.equal(t.status, worker.STATES.RETRY_WAIT);
    assert.match(t.error, /executor exploded/);
  } finally { restore(); }
});

/* ========================================================================== */
/* H. Production honesty: WAITING_APPROVAL — no burn, no fake processed        */
/* ========================================================================== */

test('H: production drain (allowExecute=false) stops at APPROVED and keeps pending work', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'prod trigger', actor: 'budi' });
    const drained = worker.consumeBackfillQueue({ allowExecute: false });
    assert.equal(drained.executed, 0, 'production NEVER executes the provider');
    assert.equal(drained.processed, 0, 'production NEVER reports fake processed');
    assert.equal(drained.approved, 1, 'queued -> approved (waiting) only');

    const q = readQueue(worker);
    const t = q.triggers.find((x) => x.id === enq.id);
    assert.equal(t.status, worker.STATES.APPROVED);
    assert.equal(t.executed, false);

    const status = worker.getWorkerStatus();
    assert.equal(status.pending, 1, 'WAITING_APPROVAL is honest pending work');
  } finally { restore(); }
});

/* ========================================================================== */
/* H. Dry-run preview changes nothing                                          */
/* ========================================================================== */

test('H: dry-run preview reports what WOULD run without touching state', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    worker.enqueueBackfill({ reason: 'p1', actor: 'budi' });
    worker.enqueueBackfill({ reason: 'p2', actor: 'budi' });
    const before = readQueue(worker);

    const preview = worker.previewBackfill({});
    assert.equal(preview.pendingCount, 2);
    assert.equal(preview.wouldRun.length, 2);
    assert.match(preview.note, /DRY_RUN_PREVIEW/);

    const after = readQueue(worker);
    assert.deepEqual(after, before, 'preview is side-effect free');
  } finally { restore(); }
});

/* ========================================================================== */
/* F. Crash/restart durability: state survives process reload                  */
/* ========================================================================== */

test('F: queue survives a simulated crash/restart (module reload) with statuses intact', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'restart-safe', actor: 'budi' });
    // Simulate crash mid-run: RUNNING then restart.
    worker.consumeBackfillQueue({
      allowExecute: true,
      execute: () => ({ ok: false, executed: false, readbackVerified: false, blocked: true, detail: 'quota unknown' })
    });
    const before = readQueue(worker);

    // "Restart": fresh module instance, same files.
    const p = path.join(ROOT, 'lib', 'quota-queue-worker.js');
    delete require.cache[require.resolve(p)];
    const worker2 = require(p);
    const after = worker2.readJsonSafe(worker2.TRIGGER_PATH);
    const t = after.triggers.find((x) => x.id === enq.id);
    assert.equal(t.status, worker.STATES.BLOCKED, 'blocked state durable across restart');
    assert.deepEqual(after.triggers.map((x) => x.status), before.triggers.map((x) => x.status));

    // Recovery: a later drain with a working executor completes the work.
    const rec = worker2.consumeBackfillQueue({
      allowExecute: true,
      execute: () => ({ ok: true, executed: true, readbackVerified: true, detail: 'recovered' })
    });
    assert.equal(rec.executed, 1, 'BLOCKED job recovered and verified');
    const q2 = worker2.readJsonSafe(worker2.TRIGGER_PATH);
    assert.equal(q2.triggers.find((x) => x.id === enq.id).status, worker.STATES.EXECUTED_AND_READBACK_VERIFIED);
  } finally { restore(); }
});

/* ========================================================================== */
/* F. 429-style retry convergence to verified, invariant holds across runs     */
/* ========================================================================== */

test('F: 429-thens-success converges to EXECUTED_AND_READBACK_VERIFIED; global invariant holds', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'rate limited', actor: 'budi' });
    let calls = 0;
    const executor = () => {
      calls += 1;
      if (calls === 1) return { ok: false, executed: false, readbackVerified: false, detail: 'HTTP 429' };
      return { ok: true, executed: true, readbackVerified: true, detail: 'success after 429' };
    };
    const r1 = worker.consumeBackfillQueue({ allowExecute: true, execute: executor });
    assert.equal(r1.retryWait, 1, 'first 429 -> RETRY_WAIT');
    const r2 = worker.consumeBackfillQueue({ allowExecute: true, execute: executor });
    assert.equal(r2.executed, 1, 'second attempt verified');
    assert.equal(r2.pending, 0);

    const status = worker.getWorkerStatus();
    assert.equal(status.invariant.ok, true, 'processed never exceeds verified');
  } finally { restore(); }
});

/* ========================================================================== */
/* G. in-flight reservation + near-cap behavior via worker + bridge             */
/* ========================================================================== */

test('G: near-cap policy block keeps job BLOCKED until quota frees (no silent drop)', () => {
  const tmp = tmpdir();
  const { worker, restore } = loadWorker(tmp);
  try {
    const enq = worker.enqueueBackfill({ reason: 'near-cap backfill', actor: 'budi' });

    // First drain: quota still near cap -> executor reports policy block.
    worker.consumeBackfillQueue({
      allowExecute: true,
      execute: () => ({ ok: false, executed: false, readbackVerified: false, blocked: true, detail: 'AVAILABLE_FOR_BACKFILL=0' })
    });
    let q = readQueue(worker);
    assert.equal(q.triggers.find((x) => x.id === enq.id).status, worker.STATES.BLOCKED);

    // Reset 00:00 WIB frees budget -> requeue decision: drain again succeeds.
    const rec = worker.consumeBackfillQueue({
      allowExecute: true,
      execute: () => ({ ok: true, executed: true, readbackVerified: true, detail: 'quota freed after WIB reset' })
    });
    assert.equal(rec.executed, 1);
    q = readQueue(worker);
    assert.equal(q.triggers.find((x) => x.id === enq.id).status, worker.STATES.EXECUTED_AND_READBACK_VERIFIED);
  } finally { restore(); }
});

/* ========================================================================== */
/* Endpoint honesty (production gate + dry run)                                */
/* ========================================================================== */

test('H: quota-backfill-trigger endpoint has dry-run preview + honest WAITING_APPROVAL in prod', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'admin', 'quota-backfill-trigger.js'), 'utf8');
  assert.match(src, /dryRun/, 'endpoint supports dry-run preview');
  assert.match(src, /WAITING_APPROVAL/, 'honest production queue state surfaced');
  assert.match(src, /queueState/, 'explicit queue state returned to UI');
});

'use strict';
/**
 * P0-A regression test: source-version guard in lib/quota-queue-worker.js.
 *
 * The legacy 97,838-row backfill queue was derived from an older completeness
 * snapshot. Its keys are now OBSOLETE_PRESENT in canonical ledger v2. The guard
 * must ensure such stale triggers can NEVER cause a provider request: they are
 * parked as BLOCKED (still pending, auditable) and the executor is never called.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const worker = require('../lib/quota-queue-worker');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0a-guard-'));
  return path.join(dir, name);
}

test('isStaleSourceVersion: unstamped trigger is stale', () => {
  assert.strictEqual(worker.isStaleSourceVersion({}, 'v6-ledger-v2-20261114'), true);
  assert.strictEqual(worker.isStaleSourceVersion({ sourceVersion: null }, 'v6-ledger-v2-20261114'), true);
});

test('isStaleSourceVersion: mismatched version is stale', () => {
  assert.strictEqual(
    worker.isStaleSourceVersion({ sourceVersion: 'legacy-20261030' }, 'v6-ledger-v2-20261114'),
    true
  );
});

test('isStaleSourceVersion: matching version is fresh', () => {
  assert.strictEqual(
    worker.isStaleSourceVersion({ sourceVersion: 'v6-ledger-v2-20261114' }, 'v6-ledger-v2-20261114'),
    false
  );
});

test('consumeBackfillQueue: stale trigger is BLOCKED and executor never runs', () => {
  const triggerPath = tmpFile('triggers.json');
  const ledgerPath = tmpFile('ledger.json');
  process.env.QUOTA_BACKFILL_QUEUE_PATH = triggerPath;
  process.env.QUOTA_BACKFILL_LEDGER_PATH = ledgerPath;

  // Re-require with the env paths in place.
  delete require.cache[require.resolve('../lib/quota-queue-worker')];
  const w = require('../lib/quota-queue-worker');

  fs.writeFileSync(triggerPath, JSON.stringify({
    triggers: [{
      id: 'legacy-1',
      reason: 'legacy 97838 queue',
      dateWIB: '2026-10-30',
      status: 'QUEUED',
      executed: false,
      transitions: [],
      // no sourceVersion => legacy/stale
    }],
    generatedAt: null,
  }));

  let executorCalls = 0;
  const res = w.consumeBackfillQueue({
    allowExecute: true,
    sourceVersion: 'v6-ledger-v2-20261114',
    execute: () => { executorCalls += 1; return { ok: true, executed: true, readbackVerified: true }; },
  });

  assert.strictEqual(executorCalls, 0, 'executor must NOT be called for a stale trigger');
  assert.strictEqual(res.executed, 0, 'nothing executed');
  assert.strictEqual(res.blocked, 1, 'stale trigger parked as BLOCKED');
  assert.strictEqual(res.pending, 1, 'stale trigger remains pending (auditable, not dropped)');

  const q = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
  assert.strictEqual(q.triggers[0].status, 'BLOCKED');
  assert.strictEqual(q.triggers[0].error, 'STALE_SOURCE_VERSION');
});

test('consumeBackfillQueue: fresh trigger executes normally', () => {
  const triggerPath = tmpFile('triggers2.json');
  const ledgerPath = tmpFile('ledger2.json');
  process.env.QUOTA_BACKFILL_QUEUE_PATH = triggerPath;
  process.env.QUOTA_BACKFILL_LEDGER_PATH = ledgerPath;

  delete require.cache[require.resolve('../lib/quota-queue-worker')];
  const w = require('../lib/quota-queue-worker');

  fs.writeFileSync(triggerPath, JSON.stringify({
    triggers: [{
      id: 'fresh-1',
      reason: 'ledger v2 requestable',
      dateWIB: '2026-11-13',
      status: 'QUEUED',
      executed: false,
      sourceVersion: 'v6-ledger-v2-20261114',
      transitions: [],
    }],
    generatedAt: null,
  }));

  let executorCalls = 0;
  const res = w.consumeBackfillQueue({
    allowExecute: true,
    sourceVersion: 'v6-ledger-v2-20261114',
    execute: () => { executorCalls += 1; return { ok: true, executed: true, readbackVerified: true }; },
  });

  assert.strictEqual(executorCalls, 1, 'fresh trigger must execute');
  assert.strictEqual(res.executed, 1);
  assert.strictEqual(res.pending, 0);
});

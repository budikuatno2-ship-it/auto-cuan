'use strict';

/**
 * Batch 13 — Skrip Deploy Otomatis & Atomik (Git Pull + PM2 Restart)
 *
 * Membuktikan kebijakan deploy atomik di `deriveDeployDecision()`:
 *   1. Working tree kotor → ABORT (jangan menimpa edit).
 *   2. Revisi sudah sama dengan remote → no-op bersih (tanpa reload).
 *   3. Test gagal → ROLLBACK, TIDAK reload (kode lama tetap jalan = aman).
 *   4. Test lolos → deploy + reload zero-downtime.
 *   5. --skip-tests melewati gate (hanya bila sengaja).
 *   6. parseArgs default & override.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveDeployDecision, parseArgs } = require('../tools/atomic-deploy');

test('Batch 13: dirty worktree aborts without deploy, reload, or rollback', () => {
  const d = deriveDeployDecision({ dirty: true, preSha: 'aaa', remoteSha: 'bbb' });
  assert.equal(d.deploy, false);
  assert.equal(d.reload, false);
  assert.equal(d.rollback, false);
  assert.equal(d.status, 'DIRTY_WORKTREE');
  assert.equal(d.exit_code, 2);
});

test('Batch 13: already up-to-date revision is a clean no-op (no needless reload)', () => {
  const d = deriveDeployDecision({ dirty: false, preSha: 'abc123', remoteSha: 'abc123' });
  assert.equal(d.deploy, false);
  assert.equal(d.reload, false);
  assert.equal(d.rollback, false);
  assert.equal(d.status, 'UP_TO_DATE');
  assert.equal(d.exit_code, 0);
});

test('Batch 13: failing tests roll back and never reload into RAM', () => {
  const d = deriveDeployDecision({ dirty: false, preSha: 'aaa', remoteSha: 'bbb', testsPassed: false });
  assert.equal(d.deploy, true);
  assert.equal(d.reload, false, 'a failing revision must not be reloaded');
  assert.equal(d.rollback, true);
  assert.equal(d.status, 'TESTS_FAILED_ROLLED_BACK');
  assert.equal(d.exit_code, 3);
});

test('Batch 13: passing tests deploy with a zero-downtime reload', () => {
  const d = deriveDeployDecision({ dirty: false, preSha: 'aaa', remoteSha: 'bbb', testsPassed: true });
  assert.equal(d.deploy, true);
  assert.equal(d.reload, true);
  assert.equal(d.rollback, false);
  assert.equal(d.status, 'DEPLOYED_RELOADED');
  assert.equal(d.exit_code, 0);
});

test('Batch 13: test gate is skipped only when explicitly opted out', () => {
  const skipped = deriveDeployDecision({ dirty: false, preSha: 'aaa', remoteSha: 'bbb', skipTests: true });
  assert.equal(skipped.reload, true);
  assert.equal(skipped.rollback, false);
  // Without the opt-out and without a pass result, it must NOT proceed.
  const gated = deriveDeployDecision({ dirty: false, preSha: 'aaa', remoteSha: 'bbb', skipTests: false });
  assert.equal(gated.reload, false);
  assert.equal(gated.rollback, true);
});

test('Batch 13: parseArgs defaults to the feature branch with no skips', () => {
  const args = parseArgs([]);
  assert.equal(args.branch, 'feat/daytrade-screener-v1');
  assert.equal(args.skipTests, false);
  assert.equal(args.dryRun, false);

  const overridden = parseArgs(['--branch', 'fix/x', '--skip-tests', '--dry-run']);
  assert.equal(overridden.branch, 'fix/x');
  assert.equal(overridden.skipTests, true);
  assert.equal(overridden.dryRun, true);
});

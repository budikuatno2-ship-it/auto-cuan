'use strict';

/**
 * Batch 13 — Atomic Deploy (Git Pull + PM2 Reload)
 *
 * Orchestrates a safe, zero-downtime VPS deploy that eliminates the "stale code
 * in RAM" root cause (Akar Masalah #1). Ordering is deliberate:
 *
 *   1. Pre-flight: working tree must be clean (else abort, never clobber edits).
 *   2. Fetch + capture PREV_SHA, then `git pull --ff-only`.
 *   3. Run the test suite BEFORE touching the running process.
 *      - On failure: `git reset --hard PREV_SHA` and abort. The old code keeps
 *        running in RAM, so a bad revision can never reach production.
 *      - On success: `pm2 reload ecosystem.config.js --update-env` (zero-downtime).
 *
 * An already-current revision is a clean no-op: no pull, no test run, no reload.
 *
 * Usage:
 *   node tools/atomic-deploy.js --branch feat/daytrade-screener-v1
 *   node tools/atomic-deploy.js --skip-tests          # trusted hotfix (not recommended)
 *   node tools/atomic-deploy.js --dry-run
 *
 * Exit codes: 0 ok/up-to-date, 2 dirty tree, 3 tests failed (rolled back),
 *             4 git/deploy command failed, 5 usage error.
 */

const { spawnSync } = require('node:child_process');

const ECOSYSTEM = 'ecosystem.config.js';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim()
  };
}

/**
 * Pure decision function — the entire deploy policy, isolated for testing.
 * No I/O: callers gather the observations, this decides what to do.
 *
 * @param {Object} o
 * @param {boolean} o.dirty        Working tree has uncommitted changes.
 * @param {string}  o.preSha       Current HEAD sha (before pull).
 * @param {string}  o.remoteSha    Fetched remote sha for the target branch.
 * @param {boolean} o.skipTests    Operator opted out of the test gate.
 * @param {boolean} [o.testsPassed] Result of the test gate (ignored if skipped/up-to-date).
 * @returns {{ deploy: boolean, reload: boolean, rollback: boolean, status: string, exit_code: number }}
 */
function deriveDeployDecision(o) {
  const dirty = o.dirty === true;
  const preSha = String(o.preSha || '');
  const remoteSha = String(o.remoteSha || '');
  const skipTests = o.skipTests === true;

  if (dirty) {
    return { deploy: false, reload: false, rollback: false, status: 'DIRTY_WORKTREE', exit_code: 2 };
  }

  // Nothing to do: the on-disk revision already matches the remote. A needless
  // reload here would restart healthy processes for no reason.
  if (preSha && remoteSha && preSha === remoteSha) {
    return { deploy: false, reload: false, rollback: false, status: 'UP_TO_DATE', exit_code: 0 };
  }

  // Test gate is mandatory unless explicitly skipped. A failing revision must
  // never be reloaded into RAM — roll back to the last-good sha instead.
  if (!skipTests && o.testsPassed !== true) {
    return { deploy: true, reload: false, rollback: true, status: 'TESTS_FAILED_ROLLED_BACK', exit_code: 3 };
  }

  return { deploy: true, reload: true, rollback: false, status: 'DEPLOYED_RELOADED', exit_code: 0 };
}

function parseArgs(argv) {
  const args = { branch: 'feat/daytrade-screener-v1', skipTests: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch') args.branch = argv[++i];
    else if (a === '--skip-tests') args.skipTests = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.branch) {
    console.error('usage: node tools/atomic-deploy.js --branch <name> [--skip-tests] [--dry-run]');
    return 5;
  }

  // 1. Pre-flight: never clobber uncommitted work.
  const statusRes = run('git', ['status', '--porcelain']);
  if (!statusRes.ok) { console.error('git status failed: ' + statusRes.stderr); return 4; }
  const dirty = statusRes.stdout.length > 0;

  // 2. Capture current revision, then fetch the target.
  const preRes = run('git', ['rev-parse', 'HEAD']);
  if (!preRes.ok) { console.error('git rev-parse failed: ' + preRes.stderr); return 4; }
  const preSha = preRes.stdout;

  const fetchRes = run('git', ['fetch', 'origin', args.branch]);
  if (!fetchRes.ok) { console.error('git fetch failed: ' + fetchRes.stderr); return 4; }
  const remoteRes = run('git', ['rev-parse', 'origin/' + args.branch]);
  const remoteSha = remoteRes.ok ? remoteRes.stdout : '';

  if (dirty) {
    console.error('WORKTREE_DIRTY: commit or stash changes before deploying.');
    return 2;
  }
  if (preSha && remoteSha && preSha === remoteSha) {
    console.log('UP_TO_DATE: ' + preSha.slice(0, 12) + ' already matches origin/' + args.branch);
    return 0;
  }
  if (args.dryRun) {
    console.log('DRY_RUN: would deploy ' + preSha.slice(0, 12) + ' -> ' + remoteSha.slice(0, 12));
    return 0;
  }

  // 3. Pull the new revision (fast-forward only — no merge commits on the VPS).
  const pullRes = run('git', ['pull', '--ff-only', 'origin', args.branch]);
  if (!pullRes.ok) { console.error('git pull failed: ' + pullRes.stderr); return 4; }

  // 4. Test gate BEFORE the running process is touched.
  let testsPassed = true;
  if (!args.skipTests) {
    const testRes = run('npm', ['test'], { stdio: 'inherit' });
    testsPassed = testRes.ok;
  }

  const decision = deriveDeployDecision({ dirty: false, preSha, remoteSha, skipTests: args.skipTests, testsPassed });

  if (decision.rollback) {
    console.error('TESTS_FAILED: rolling back to ' + preSha.slice(0, 12) + ' (running process untouched).');
    const resetRes = run('git', ['reset', '--hard', preSha]);
    if (!resetRes.ok) console.error('rollback reset failed: ' + resetRes.stderr);
    return decision.exit_code;
  }

  // 5. Zero-downtime reload so disk code == RAM code.
  const reloadRes = run('pm2', ['reload', ECOSYSTEM, '--update-env'], { stdio: 'inherit' });
  if (!reloadRes.ok) {
    console.error('pm2 reload failed: ' + reloadRes.stderr);
    return 4;
  }

  console.log('DEPLOYED_RELOADED: ' + preSha.slice(0, 12) + ' -> ' + remoteSha.slice(0, 12));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { deriveDeployDecision, parseArgs };
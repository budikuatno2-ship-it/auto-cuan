'use strict';

/**
 * B3 (2026-10-20): shared cross-process Arjum lock.
 *
 * Guarantees pinned here:
 *   - only one holder at a time; a second contender SKIPS with SKIPPED_ARJUM_BUSY
 *   - a stale lock (dead owner / too old) is reclaimed
 *   - reentrancy: a nested job in the SAME process reuses the held lock
 *   - ARJUM_SHARED_LOCK=0 disables locking entirely
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const lock = require('../lib/arjum-shared-lock');

function tmpLockFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-lock-'));
  return { dir, file: path.join(dir, 'arjum-api.lock') };
}

test('withArjumLock: second contender skips with SKIPPED_ARJUM_BUSY', async () => {
  const { dir, file } = tmpLockFile();
  try {
    let innerRan = false;
    // Simulate another process by writing the lock file with a LIVE pid.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, job: 'other', started_at: Date.now() }));
    const result = await lock.withArjumLock({ job: 'J1', lockFile: file, waitMs: 0, enable: true, log: () => {} }, async () => { innerRan = true; return 'done'; });
    assert.equal(innerRan, false, 'must not run while another holder owns the lock');
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'SKIPPED_ARJUM_BUSY');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withArjumLock: reclaims a lock whose owner pid is dead', async () => {
  const { dir, file } = tmpLockFile();
  try {
    // pid 999999 is extremely unlikely to exist → treated as dead.
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, job: 'ghost', started_at: Date.now() }));
    const result = await lock.withArjumLock({ job: 'J1', lockFile: file, waitMs: 0, enable: true, log: () => {} }, async () => 'ran');
    assert.equal(result, 'ran', 'a dead-owner lock must be reclaimed and the job runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withArjumLock: never trips on a lock with our own live pid, waitMs>0 eventually skips', async () => {
  const { dir, file } = tmpLockFile();
  const origPid = process.pid;
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: origPid, job: 'self-live', started_at: Date.now() }));
    const result = await lock.withArjumLock({ job: 'J1', lockFile: file, waitMs: 300, enable: true, log: () => {} }, async () => 'ran');
    assert.equal(result.skipped, true, 'a live holder (even our own pid) is not reclaimed when not reentrant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isStale: stale by age or by dead pid, fresh otherwise', () => {
  const now = Date.now();
  assert.equal(lock.isStale({ pid: process.pid, started_at: now }, now, 1000, () => true), false);
  assert.equal(lock.isStale({ pid: process.pid, started_at: now - 5000 }, now, 1000, () => true), true, 'too old is stale');
  assert.equal(lock.isStale({ pid: 123, started_at: now }, now, 100000, () => false), true, 'dead pid is stale');
  assert.equal(lock.isStale(null, now, 100000, () => true), true, 'missing info is stale');
});

test('disabled: true skips locking (job always runs even when a lock exists)', async () => {
  const { dir, file } = tmpLockFile();
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, job: 'other', started_at: Date.now() }));
    const result = await lock.withArjumLock({ job: 'J1', lockFile: file, waitMs: 0, disabled: true, log: () => {} }, async () => 'ran-disabled');
    assert.equal(result, 'ran-disabled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reentrancy: a nested acquisition in the same process reuses the held lock', async () => {
  const { dir, file } = tmpLockFile();
  try {
    const outer = await lock.withArjumLock({ job: 'J1', lockFile: file, waitMs: 0, enable: true, log: () => {} }, async () => {
      assert.equal(lock.hasLockInThisProcess(), true);
      // Nested: must NOT skip and NOT try to re-create the file.
      const inner = await lock.withArjumLock({ job: 'J2', lockFile: file, waitMs: 0, enable: true, log: () => {} }, async () => 'inner-ran');
      return inner;
    });
    assert.equal(outer, 'inner-ran');
    assert.equal(fs.existsSync(file), false, 'lock released after outer completes');
  } finally {
    lock.__resetReentrancyForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
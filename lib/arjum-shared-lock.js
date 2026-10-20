'use strict';

/**
 * B3 (2026-10-20): shared, cross-process Arjum API lock.
 *
 * Why: arjum-client.js throttles requests *within a single process* (a serial
 * queue + 800ms spacing). It has NO cross-process coordination, so on the VPS
 * (1 vCPU) J1 (broker summary + accum + insider), J2 (candles) and the backfill
 * worker could all hammer stock.arjum.com at once. On 2026-10-19 that overlap
 * was in the 18:00-23:30 WIB window exactly when Arjum started returning 5xx.
 *
 * This module gives J1/J2/backfill ONE shared lock file. A holder is either the
 * single job running Arjum work, or a stale remnant that is reclaimed. A job
 * that cannot take the lock WAITS briefly, then SKIPS with `SKIPPED_ARJUM_BUSY`
 * instead of running in parallel.
 *
 * Implementation notes:
 *  - Exclusive create (`wx`) is the atomic primitive; only one process wins.
 *  - The file records {pid, job, started_at}. A lock is reclaimed when it is
 *    older than staleMs OR its owner pid is not alive (checked via kill(pid,0)).
 *  - Pure decision logic (isStale) is split out so it is unit-testable.
 *
 * Env:
 *  - ARJUM_SHARED_LOCK=0 disables the lock entirely (escape hatch / tests).
 *  - ARJUM_SHARED_LOCK_FILE overrides the default path.
 *  - ARJUM_SHARED_LOCK_STALE_MS overrides the stale threshold.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_MS = Number(process.env.ARJUM_SHARED_LOCK_STALE_MS) || 45 * 60 * 1000;

function defaultLockFile() {
  if (process.env.ARJUM_SHARED_LOCK_FILE) return process.env.ARJUM_SHARED_LOCK_FILE;
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  return path.join(runnerDir, 'state', 'arjum-api.lock');
}

function isLockDisabled() {
  if (String(process.env.ARJUM_SHARED_LOCK || '').trim() === '0') return true;
  // Never take a real cross-process file lock under the test runner (mirrors
  // the same detection arjum-client.js uses to relax throttling in tests).
  if (process.env.NODE_ENV === 'test' ||
      typeof global.it === 'function' || typeof global.test === 'function' ||
      process.argv.some(a => a.includes('test'))) {
    return true;
  }
  return false;
}

// Reentrancy: run-daily-market-update.js (J1) holds the shared lock for its
// whole run and invokes both the broker worker and the candle worker
// IN-PROCESS. Those nested calls must not try to re-acquire the same file
// (that would deadlock/skip). A process that already holds the lock simply
// runs the nested work directly.
let heldByThisProcess = false;
function hasLockInThisProcess() {
  return heldByThisProcess === true;
}
function __resetReentrancyForTests() {
  heldByThisProcess = false;
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * Pure staleness decision.
 * @param {{pid?: number, started_at?: number}|null} info parsed lock content
 * @param {number} now
 * @param {number} staleMs
 * @param {function(number):boolean} pidAlive
 */
function isStale(info, now, staleMs, pidAlive) {
  if (!info || typeof info !== 'object') return true;
  const started = Number(info.started_at);
  if (Number.isFinite(started) && now - started > staleMs) return true;
  const checker = typeof pidAlive === 'function' ? pidAlive : isPidAlive;
  if (info.pid != null && !checker(info.pid)) return true;
  return false;
}

function readLockInfo(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function tryAcquire(lockFile, job, now) {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, job, started_at: now }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

function reclaimIfStale(lockFile, now, staleMs) {
  const info = readLockInfo(lockFile);
  if (!isStale(info, now, staleMs, isPidAlive)) return false;
  try { fs.unlinkSync(lockFile); return true; } catch (_) { return false; }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (_) {}
}

/**
 * Run `fn` while holding the shared Arjum lock. Returns fn()'s value on
 * success. If the lock cannot be acquired within waitMs, returns
 * { skipped: true, reason: 'SKIPPED_ARJUM_BUSY' } WITHOUT running fn.
 *
 * @param {object} options
 * @param {string} options.job - label written into the lock file (J1/J2/backfill)
 * @param {function} fn - async work to run under the lock
 * @param {number} [options.waitMs] - max time to wait for the lock (default 0)
 * @param {number} [options.staleMs] - stale threshold
 * @param {boolean} [options.disabled] - force-disable
 * @param {function} [options.log] - logger (default console.log)
 */
async function withArjumLock(options, fn) {
  const opts = options || {};
  const job = opts.job || 'arjum-job';
  const log = typeof opts.log === 'function' ? opts.log : function (m) { console.log(m); };
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : DEFAULT_STALE_MS;

  if (opts.disabled === true || (opts.enable !== true && isLockDisabled())) {
    return fn();
  }

  // Reentrant: a nested job in the SAME process reuses the held lock.
  if (heldByThisProcess) {
    return fn();
  }

  const lockFile = opts.lockFile || defaultLockFile();
  const waitMs = Number.isFinite(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs : 0;
  const pollMs = 2000;
  const deadline = Date.now() + waitMs;

  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    if (tryAcquire(lockFile, job, now)) {
      log(`[ARJUM-LOCK] ${job} memegang lock bersama (${lockFile}).`);
      heldByThisProcess = true;
      try {
        return await fn();
      } finally {
        heldByThisProcess = false;
        releaseLock(lockFile);
        log(`[ARJUM-LOCK] ${job} melepas lock bersama.`);
      }
    }
    // Could not acquire: reclaim if the holder is stale/dead, else wait/skip.
    if (reclaimIfStale(lockFile, now, staleMs)) {
      log(`[ARJUM-LOCK] ${job} merebut lock basi/yatim dan mencoba lagi.`);
      continue;
    }
    if (Date.now() >= deadline) {
      log(`[ARJUM-LOCK] SKIPPED_ARJUM_BUSY: ${job} tidak mendapat lock bersama dalam ${waitMs}ms; job lain sedang memakai Arjum.`);
      return { skipped: true, reason: 'SKIPPED_ARJUM_BUSY', lockFile };
    }
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(100, deadline - Date.now()))));
  }
}

module.exports = {
  DEFAULT_STALE_MS,
  defaultLockFile,
  isLockDisabled,
  hasLockInThisProcess,
  isPidAlive,
  isStale,
  readLockInfo,
  reclaimIfStale,
  releaseLock,
  withArjumLock,
  __resetReentrancyForTests
};
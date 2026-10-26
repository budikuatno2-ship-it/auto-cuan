'use strict';

// DARURAT 23 Oct 2026 — J1 did not run on 20, 21, 22 Oct.
//
// Root cause (evidence in REPORT_DARURAT_J1_20261023.md):
//  1. `getConfiguredDailyQuota()` preferred a value "learned" from an
//     `x-ratelimit-limit` response header over ARJUM_DAILY_LIMIT, so the
//     circuit breaker could trip on a vendor ceiling lower than the plan.
//  2. J1 took the shared Arjum lock with `waitMs: 0`, so ANY overlapping
//     backfill firing made it skip instantly (SKIPPED_ARJUM_BUSY) — every EOD
//     firing on 20-22 Oct skipped, and nothing alerted.
//
// These tests pin the fixes: ARJUM_DAILY_LIMIT is the single source of truth
// (a header may only LOWER it), the breaker logs limit/used/remaining, J1 waits
// for the lock, and repeated skips raise an alarm.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const arjumClient = require('../lib/arjum-client');
const skipAlarm = require('../lib/j1-skip-alarm');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('B2: ARJUM_DAILY_LIMIT is the single source of truth for the daily quota', () => {
  withEnv({ ARJUM_DAILY_LIMIT: '18080', ARJUM_DAILY_QUOTA: '' }, () => {
    arjumClient.__setObservedVendorLimit(null);
    assert.equal(arjumClient.getConfiguredPlanLimit(), 18080);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 18080);
  });
});

test('B2: a vendor header can only LOWER the limit, never replace the configured plan', () => {
  withEnv({ ARJUM_DAILY_LIMIT: '18080' }, () => {
    // A header claiming 12060 must not silently become the limit...
    arjumClient.__setObservedVendorLimit(12060);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 12060, 'a lower vendor ceiling is honoured');
    // ...and a header claiming MORE than the plan must not raise it.
    arjumClient.__setObservedVendorLimit(999999);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 18080, 'a higher vendor value cannot exceed the plan');
    arjumClient.__setObservedVendorLimit(null);
  });
});

test('B2: the old "header wins outright" behaviour is gone from the source', () => {
  const src = read('lib/arjum-client.js');
  assert.match(src, /Math\.min\(plan, lastObservedVendorLimit\)/);
  assert.match(src, /function getConfiguredPlanLimit\(\)/);
});

test('B4: the circuit breaker logs limit, used and remaining when it trips', () => {
  const src = read('lib/arjum-client.js');
  assert.match(src, /limit=\$\{snap\.limit\} used=\$\{snap\.used\} remaining=\$\{snap\.remaining\}/);
  assert.match(src, /function quotaSnapshot\(\)/);
});

test('B3: J1 waits for the shared lock instead of skipping at 0ms', () => {
  const src = read('tools/run-daily-market-update.js');
  assert.doesNotMatch(src, /withArjumLock\(\{ job: 'J1', waitMs: 0 \}/);
  assert.match(src, /withArjumLock\(\{ job: 'J1', waitMs: j1LockWaitMs \}/);
  assert.match(src, /J1_LOCK_WAIT_MS/);
});

test('B3: the backfill hands the lock back between batches', () => {
  const src = read('tools/backfill-broksum.js');
  assert.match(src, /yieldLockToDailyJobs/);
  assert.match(src, /processedTickers % batchSize === 0/);
  assert.match(src, /function backfillBatchSize/);
});

test('B3: the skip alarm fires on the 3rd consecutive skip, once per cooldown', () => {
  const now = Date.now();
  assert.equal(skipAlarm.evaluate({ consecutiveSkips: 2, now }).shouldAlert, false);
  assert.equal(skipAlarm.evaluate({ consecutiveSkips: 3, now }).shouldAlert, true);
  assert.equal(skipAlarm.evaluate({ consecutiveSkips: 3, now, lastAlertAt: new Date(now - 60000).toISOString() }).reason, 'cooldown');
});

test('B3: recordSkip counts up and recordSuccess clears the counter', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'j1-skip-'));
  const statePath = path.join(tmp, 'j1-skip-alarm.json');
  try {
    assert.equal(skipAlarm.recordSkip({ statePath }).consecutiveSkips, 1);
    assert.equal(skipAlarm.recordSkip({ statePath }).consecutiveSkips, 2);
    const third = skipAlarm.recordSkip({ statePath });
    assert.equal(third.consecutiveSkips, 3);
    assert.equal(third.shouldAlert, true);
    skipAlarm.recordSuccess({ statePath });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.consecutive_skips, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('B3: the alarm message names the job and carries no secrets', () => {
  const msg = skipAlarm.buildMessage({ consecutiveSkips: 3, threshold: 3, lastSkipAt: '2026-10-23T09:30:00Z' });
  assert.match(msg, /J1/);
  assert.match(msg, /3 kali/);
  assert.doesNotMatch(msg, /token|secret|168\.\d|password/i);
});

test('B1: backfill cron lines are configured with appropriate modes', () => {
  const cron = read('deploy/vps/final-schedule.cron');
  // Candle backfill is paused with DIJEDA marker
  assert.match(cron, /# 5 0 \* \* \* .*backfill-historical-candles\.js/);
  // Broksum backfill lines are restored with weekday and weekend modes
  const activeBroksum = cron.split('\n').filter((l) => /^\s*\d/.test(l) && /backfill-broksum\.js/.test(l));
  assert.ok(activeBroksum.length >= 4, 'active broksum backfill lines must exist');
  assert.match(cron, /backfill-broksum\.js --mode=weekday/);
  assert.match(cron, /backfill-broksum\.js --mode=weekend/);
});

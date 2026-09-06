'use strict';

// Root cause this fixes: backfill and the daily-update job each tracked
// "requests used today" in an in-process variable starting at 0 on every
// invocation. Both are separate cron-fired processes, so neither ever knew
// how much of the shared daily quota the OTHER had already spent — a
// --reserve-quota computed against a counter that resets every run is not a
// real cross-process reservation. This tracker persists actual usage to
// disk, keyed by WIB date, so every process reads the true total.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const quotaTracker = require('../lib/arjum-quota-tracker');

function withTempDataDir(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-quota-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;
  return Promise.resolve()
    .then(() => fn(tmpBase))
    .finally(() => {
      if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
      else delete process.env.ARJUM_DATA_DIR;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    });
}

test('arjumQuotaTracker: starts at 0 usage with no state file yet', async () => {
  await withTempDataDir(() => {
    assert.equal(quotaTracker.getUsedToday(), 0);
  });
});

test('arjumQuotaTracker: recordUsage persists and accumulates across separate calls (simulating separate processes)', async () => {
  await withTempDataDir(() => {
    quotaTracker.recordUsage(1);
    quotaTracker.recordUsage(1);
    quotaTracker.recordUsage(5);
    // A fresh "process" reading the same state file (same ARJUM_DATA_DIR)
    // must see the cumulative total, not just its own calls.
    assert.equal(quotaTracker.getUsedToday(), 7);
  });
});

test('arjumQuotaTracker: two independent trackers sharing the same data dir see each other\'s usage (cross-process simulation)', async () => {
  await withTempDataDir(() => {
    // Simulate "process A" (e.g. the backfill worker at 00:05).
    quotaTracker.recordUsage(9000);
    // Simulate "process B" (e.g. the daily-update job at 20:00) re-requiring
    // the module fresh — Node's require cache would normally return the
    // same singleton in-process, but the persisted state is what actually
    // crosses the process boundary in production, which getUsedToday reads
    // fresh from disk every call (no in-memory cache to go stale).
    delete require.cache[require.resolve('../lib/arjum-quota-tracker')];
    const trackerB = require('../lib/arjum-quota-tracker');
    assert.equal(trackerB.getUsedToday(), 9000, 'a second reader must see the first reader\'s usage without restarting the process');
  });
});

test('arjumQuotaTracker: getRemainingToday subtracts usage from the configured total and never goes negative', async () => {
  await withTempDataDir(() => {
    quotaTracker.recordUsage(100);
    assert.equal(quotaTracker.getRemainingToday(16000), 15900);
    quotaTracker.resetForTesting(20000);
    assert.equal(quotaTracker.getRemainingToday(16000), 0, 'usage exceeding the configured total must floor remaining at 0, not go negative');
  });
});

test('arjumQuotaTracker: usage resets automatically on a new WIB day (no explicit midnight job needed)', async () => {
  await withTempDataDir((tmpBase) => {
    quotaTracker.resetForTesting(500);
    assert.equal(quotaTracker.getUsedToday(), 500);

    // Simulate "yesterday" by writing a state file dated in the past directly.
    const statePath = quotaTracker.getStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ date: '2020-01-01', used: 12345 }));
    assert.equal(quotaTracker.getUsedToday(), 0, 'a stale date in the state file must be treated as a new day, not carried forward');
  });
});

test('arjumQuotaTracker: a corrupted or unreadable state file degrades to 0 usage instead of throwing', async () => {
  await withTempDataDir(() => {
    const statePath = quotaTracker.getStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'not valid json{{{');
    assert.doesNotThrow(() => quotaTracker.getUsedToday());
    assert.equal(quotaTracker.getUsedToday(), 0);
  });
});

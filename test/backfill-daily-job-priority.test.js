'use strict';

/**
 * B6 (2026-10-20): the backfill must yield to the daily jobs.
 *
 * Policy pinned here:
 *   - `reserve` is a FLOOR on the REMAINING quota: the worker stops as soon as
 *     `remaining <= reserve`. It is therefore the amount of quota that must
 *     STAY AVAILABLE for the daily jobs, not the amount the backfill may spend.
 *   - `spendable` = remaining - reserve = what the backfill may still use.
 *   - a single invalid provider response skips the task and CONTINUES.
 *   - the hard provider-error halt still exists for N consecutive 5xx.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const backfill = require('../tools/backfill-broksum');

test('B6: reserve is the daily-job need + retry buffer (the floor that must stay)', () => {
  const dailyNeed = 4400;
  const buffer = Math.ceil(dailyNeed * backfill.DAILY_JOB_RETRY_RATIO); // 440
  const b = backfill.computeBackfillReserve({ remaining: 12980, dailyNeed, mode: 'weekday' });
  assert.equal(b.dailyNeed, dailyNeed);
  assert.equal(b.retryBuffer, buffer);
  assert.equal(b.reserve, dailyNeed + buffer, 'reserve = need + buffer');
  assert.equal(b.reserve, 4840);
  assert.equal(b.spendable, 12980 - 4840, 'spendable = remaining - reserve');
  assert.equal(b.spendable, 8140);
});

test('B6: the backfill must never be able to dip into the daily-job reserve', () => {
  // With only 5.000 left, the backfill may spend 5.000 - 4.840 = 160 and must
  // then stop, leaving the full 4.840 for the daily jobs.
  const b = backfill.computeBackfillReserve({ remaining: 5000, dailyNeed: 4400, mode: 'weekday' });
  assert.equal(b.reserve, 4840);
  assert.equal(b.spendable, 160);
  // The floor can never be negative (an unlimited backfill would be worse).
  const c = backfill.computeBackfillReserve({ remaining: 100, dailyNeed: 4400, mode: 'weekday' });
  assert.equal(c.reserve, 4840);
  assert.equal(c.spendable, 0, 'no backfill spend when the reserve is not covered');
});

test('B6: unknown remaining quota falls back to a conservative reserve and spends nothing', () => {
  const b = backfill.computeBackfillReserve({ remaining: null, mode: 'weekday' });
  assert.equal(b.remaining, null);
  assert.ok(b.reserve > 0, 'unknown remaining must keep a conservative reserve');
  assert.equal(b.spendable, 0);
});

test('B6: a bigger remaining quota allows a bigger backfill budget', () => {
  const small = backfill.computeBackfillReserve({ remaining: 9000, dailyNeed: 4400, mode: 'weekday' });
  const big = backfill.computeBackfillReserve({ remaining: 18000, dailyNeed: 4400, mode: 'weekday' });
  assert.ok(big.spendable > small.spendable);
  assert.equal(small.reserve, big.reserve, 'the reserve depends on the daily need, not on the remaining');
});

test('B6: daily-job need and retry ratio are the documented values', () => {
  assert.equal(backfill.DAILY_JOB_BASE_NEED, 4400);
  assert.equal(backfill.DAILY_JOB_RETRY_RATIO, 0.10);
});

test('B6: the reserve floor is the daily-job floor while the EOD work is pending', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reserve-floor-'));
  try {
    // No .done sentinel for today -> the daily jobs still need their quota.
    const pending = backfill.resolveBackfillReserveFloor({
      baseDir: tmp, explicitModeArg: 'weekday', remaining: 5000, mode: 'weekday'
    });
    assert.equal(pending, 4840, 'the daily-job floor must be protected');
    assert.ok(pending >= backfill.DAILY_JOB_BASE_NEED);

    // With today's .done sentinel present -> the daily need is already spent,
    // so the historical fixed reserve applies and the leftover is usable.
    const eodDir = path.join(tmp, '_eod');
    fs.mkdirSync(eodDir, { recursive: true });
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    fs.writeFileSync(path.join(eodDir, todayKey + '.done'), '{}');
    const done = backfill.resolveBackfillReserveFloor({
      baseDir: tmp, explicitModeArg: 'weekday', remaining: 5000, mode: 'weekday'
    });
    assert.ok(done < 4840, 'after the EOD work the backfill may use the leftover');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

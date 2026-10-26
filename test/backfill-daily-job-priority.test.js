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

test('B6: reserve is the WEEKDAY floor of 5000 (hard minimum, never drops below)', () => {
  const dailyNeed = 4400;
  const buffer = Math.ceil(dailyNeed * backfill.DAILY_JOB_RETRY_RATIO); // 440
  const b = backfill.computeBackfillReserve({ remaining: 12980, dailyNeed, mode: 'weekday' });
  assert.equal(b.dailyNeed, dailyNeed);
  assert.equal(b.retryBuffer, buffer);
  // WEEKDAY_RESERVE_BEFORE_EOD = 5000 is the hard floor, so reserve is 5000, not 4840
  assert.equal(b.reserve, 5000, 'reserve = max(WEEKDAY_RESERVE_BEFORE_EOD, need+buffer) = 5000');
  assert.equal(b.spendable, 12980 - 5000, 'spendable = remaining - 5000');
  assert.equal(b.spendable, 7980);
});

test('B6: the backfill must never be able to dip into the weekday reserve of 5000', () => {
  // With only 5.000 left, the backfill may spend 5.000 - 5.000 = 0
  const b = backfill.computeBackfillReserve({ remaining: 5000, dailyNeed: 4400, mode: 'weekday' });
  assert.equal(b.reserve, 5000);
  assert.equal(b.spendable, 0);
  // The floor can never be negative, reserve stays at 5000
  const c = backfill.computeBackfillReserve({ remaining: 100, dailyNeed: 4400, mode: 'weekday' });
  assert.equal(c.reserve, 5000);
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

test('B6: the reserve floor grows with the OUTSTANDING daily demand (today + H-1 backlog)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-need-'));
  try {
    const today = '2026-10-20';
    const prev = '2026-10-19';
    const tickers = ['AAA', 'BBB', 'CCC'];
    // Today: 2 of 3 tickers still missing. Previous day: marker says 871 pending.
    const dir = path.join(tmp, 'broker-summary', 'AAA');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, today + '.json'), '{}');
    const markerDir = path.join(tmp, '_daily-update-marker');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, prev + '.json'), JSON.stringify({ pending: 871 }));

    const need = backfill.computePendingDailyNeed(tmp, today, tickers);
    // today: 2 missing x 4 = 8 ; H-1 backlog: 871 x 4 = 3484
    assert.equal(need, 8 + 3484);
    assert.equal(backfill.DAILY_REQUESTS_PER_TICKER, 4);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
    assert.equal(pending, 5000, 'the daily-job floor must be protected (min 5000)');
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
    assert.ok(done < 5000, 'after the EOD work the backfill may use the leftover');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

'use strict';

/**
 * B6 (2026-10-20): the backfill must yield to the daily jobs.
 *
 * Policy pinned here:
 *   - reserve = remaining quota - remaining daily-job need - 10% retry buffer
 *   - a single invalid provider response skips the task and CONTINUES
 *     (it must not halt the whole backfill)
 *   - the hard provider-error halt still exists for N consecutive 5xx
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const backfill = require('../tools/backfill-broksum');

test('B6: reserve keeps the daily-job need + retry buffer out of the backfill budget', () => {
  const dailyNeed = 4400;
  const buffer = Math.ceil(dailyNeed * backfill.DAILY_JOB_RETRY_RATIO); // 440
  const b = backfill.computeBackfillReserve({ remaining: 12980, dailyNeed, mode: 'weekday' });
  assert.equal(b.dailyNeed, dailyNeed);
  assert.equal(b.retryBuffer, buffer);
  assert.equal(b.reserve, 12980 - dailyNeed - buffer);
  assert.equal(b.reserve, 8140);
});

test('B6: reserve never goes negative', () => {
  const b = backfill.computeBackfillReserve({ remaining: 100, dailyNeed: 4400, mode: 'weekday' });
  assert.ok(b.reserve >= 0, 'reserve must not be negative');
  assert.equal(b.reserve, 0);
});

test('B6: unknown remaining quota falls back to the conservative fixed reserve', () => {
  const b = backfill.computeBackfillReserve({ remaining: null, mode: 'weekday' });
  assert.equal(b.remaining, null);
  assert.ok(b.reserve > 0, 'unknown remaining must keep a conservative reserve');
});

test('B6: a bigger remaining quota allows a bigger backfill budget', () => {
  const small = backfill.computeBackfillReserve({ remaining: 9000, dailyNeed: 4400, mode: 'weekday' });
  const big = backfill.computeBackfillReserve({ remaining: 18000, dailyNeed: 4400, mode: 'weekday' });
  assert.ok(big.reserve > small.reserve);
});

test('B6: daily-job need and retry ratio are the documented values', () => {
  assert.equal(backfill.DAILY_JOB_BASE_NEED, 4400);
  assert.equal(backfill.DAILY_JOB_RETRY_RATIO, 0.10);
});
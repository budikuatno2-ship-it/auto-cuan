'use strict';

/**
 * Nightly DayTrade full scan must not be skipped by the intraday FAST run
 * (change request B, 2026-10-20).
 *
 * Bug: the 15-minute FAST producer publishes 258/258, so the nightly gate in
 * `runDayTrade` (and the api/sector-hot.js `already_done` guard) treated the
 * day as done and the full ~800-name scan stopped running (frozen since
 * 30 Sep 2026). The gate now requires run_speed === 'full' with full coverage.
 * Legacy rows without run_speed are treated as fast so the night scan runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runner = require('../tools/run-all-screeners-vps');
const sectorHot = require('../api/sector-hot');

const TODAY = runner.wibDate();

async function runNight(meta) {
  const calls = [];
  const client = {
    call: async (q) => {
      calls.push(q.action);
      if (q.action === 'daytrade-screener') return { meta };
      if (q.action === 'daytrade-screener-run') return { status: 'published', published_count: 3 };
      throw new Error('unexpected action: ' + q.action);
    }
  };
  const result = await runner.runDayTrade(
    client,
    { execute: true, force: false, maxAttempts: 3, sleepMs: 1, limit: 50 },
    () => {}
  );
  return { result, ran: calls.includes('daytrade-screener-run') };
}

test('FUN-01: intraday FAST publish 258/258 does NOT skip the nightly scan', async () => {
  const { result, ran } = await runNight({ status: 'published', run_date: TODAY, run_speed: 'fast', scanned_count: 258, universe_count: 258 });
  assert.equal(ran, true, 'night run must still be issued');
  assert.notEqual(result.skipped, true);
  assert.equal(result.finalized, true);
});

test('FUN-02: a completed FULL publish 800/800 DOES skip the nightly scan', async () => {
  const { result, ran } = await runNight({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 800, universe_count: 800 });
  assert.equal(ran, false, 'night run must be skipped when a full scan already published');
  assert.equal(result.skipped, true);
});

test('FUN-03: legacy meta WITHOUT run_speed is treated as fast and does NOT skip', async () => {
  const { result, ran } = await runNight({ status: 'published', run_date: TODAY, scanned_count: 258, universe_count: 258 });
  assert.equal(ran, true, 'legacy rows have no run_speed; the night scan must still run');
  assert.notEqual(result.skipped, true);
});

test('FUN-04: a partial full scan (500/800) does NOT satisfy the night skip', async () => {
  const { ran } = await runNight({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 500, universe_count: 800 });
  assert.equal(ran, true, 'only a fully-covered full scan may skip the night run');
});

test('FUN-05: isFullScanPublishedToday pins the fast/full/legacy matrix', () => {
  assert.equal(runner.isFullScanPublishedToday({ status: 'published', run_date: TODAY, run_speed: 'fast', scanned_count: 258, universe_count: 258 }), false);
  assert.equal(runner.isFullScanPublishedToday({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 800, universe_count: 800 }), true);
  assert.equal(runner.isFullScanPublishedToday({ status: 'published', run_date: TODAY, scanned_count: 258, universe_count: 258 }), false, 'no run_speed = fast');
  assert.equal(runner.isFullScanPublishedToday({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 500, universe_count: 800 }), false);
  assert.equal(runner.isFullScanPublishedToday({ status: 'published', run_date: '2026-01-01', run_speed: 'full', scanned_count: 800, universe_count: 800 }), false, 'stale run_date');
  assert.equal(runner.isFullScanPublishedToday({ status: 'scanning', run_date: TODAY, run_speed: 'full', scanned_count: 800, universe_count: 800 }), false);
});

test('FUN-06: api/sector-hot.js already_done guard uses the same full-scan predicate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const start = source.indexOf('async function handleDayTradeScreenerRun');
  const end = source.indexOf('async function finalizeDtScreener', start);
  const handler = source.slice(start, end);
  assert.match(handler, /isPublishedFullScan\(meta, runDate\)/, 'run handler must use the full-scan guard, not the old scanned>=universe check');
  assert.doesNotMatch(handler, /meta\.status === 'published' && meta\.run_date === runDate/);
});

test('FUN-07: server-side isPublishedFullScan matches the runner predicate', () => {
  const fn = sectorHot.__test.isPublishedFullScan;
  assert.equal(typeof fn, 'function');
  assert.equal(fn({ status: 'published', run_date: TODAY, run_speed: 'fast', scanned_count: 258, universe_count: 258 }, TODAY), false);
  assert.equal(fn({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 800, universe_count: 800 }, TODAY), true);
  assert.equal(fn({ status: 'published', run_date: TODAY, scanned_count: 258, universe_count: 258 }, TODAY), false, 'legacy = fast');
  assert.equal(fn({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 500, universe_count: 800 }, TODAY), false);
  assert.equal(fn({ status: 'published', run_date: TODAY, run_speed: 'full', scanned_count: 800, universe_count: 800 }, '2026-01-01'), false, 'run_date mismatch');
});
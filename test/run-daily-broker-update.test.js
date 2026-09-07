'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const dailyUpdate = require('../tools/run-daily-broker-update');

// run() sets process.exitCode on several non-success paths (quota stop,
// incomplete, --final failure). Reset it after every test in this file so
// one test's exit code doesn't leak into the next test or into the overall
// process exit code for the whole suite.
test.afterEach(() => { process.exitCode = undefined; });

function withTempDataDir(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-update-'));
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

function mockArjum(overrides) {
  const orig = {
    hasArjumApiKey: arjumClient.hasArjumApiKey,
    fetchBrokerSummary: arjumClient.fetchBrokerSummary,
    fetchBrokerAccumulation: arjumClient.fetchBrokerAccumulation,
    fetchInsiders: arjumClient.fetchInsiders
  };
  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = overrides.fetchBrokerSummary || (async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } }));
  arjumClient.fetchBrokerAccumulation = overrides.fetchBrokerAccumulation || (async () => ({ ok: true, data: { series: [] } }));
  arjumClient.fetchInsiders = overrides.fetchInsiders || (async () => ({ ok: true, data: [] }));
  return () => Object.assign(arjumClient, orig);
}

test('run-daily-broker-update: a ticker with real buy/sell rows is written to disk and counted done', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [{ broker: 'YU', bval: 100, sval: 0, bvol: 10, svol: 0 }], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'BBCA', '2026-09-07'), true);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, true);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: empty buyer/seller lists are treated as "not yet published", never cached as if they were real data', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'BBCA', '2026-09-07'), false, 'an empty response must not be cached as a confirmed "no data" day');
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.pending, 1);
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: a quota-exceeded response stops the run cleanly and marks it incomplete, not errored', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: false, status: 429, error: 'Too Many Requests' })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA,BBRI', '--date', '2026-09-07', '--delay', '0']);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, false);
      assert.equal(marker.errors, 0, 'a quota stop must not be counted as a per-ticker error');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: an already-complete marker makes the next firing a fast no-op', async () => {
  await withTempDataDir(async () => {
    dailyUpdate.writeMarker('2026-09-07', { date: '2026-09-07', complete: true, completed_at: new Date().toISOString(), total_tickers: 1 });
    let calledFetch = false;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { calledFetch = true; return { ok: true, data: { top_buyers: [], top_sellers: [] } }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      assert.equal(calledFetch, false, 'an already-complete marker must skip all work, not re-fetch');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: --final on an incomplete run reports failure via a distinct exit code', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0', '--final']);
      assert.equal(process.exitCode, 4, 'a --final run left incomplete must set a distinct failure exit code');
    } finally {
      restore();
    }
  });
});

test('run-daily-broker-update: resolveTargetDate safety guard shifts to T-1 before 16:30 WIB when --date is omitted', () => {
  // 10:00 WIB on Monday 2026-09-07 (03:00 UTC)
  const mondayMorning = new Date('2026-09-07T03:00:00.000Z');
  const resMorning = dailyUpdate.resolveTargetDate({ now: mondayMorning });
  assert.equal(resMorning.shifted, true);
  assert.equal(resMorning.reason, 'before_market_close_cutoff');
  // Previous trading day before Monday 2026-09-07 is Friday 2026-09-04
  assert.equal(resMorning.targetDate, '2026-09-04');

  // 16:29 WIB on Monday 2026-09-07 (09:29 UTC)
  const justBeforeCutoff = new Date('2026-09-07T09:29:00.000Z');
  const resJustBefore = dailyUpdate.resolveTargetDate({ now: justBeforeCutoff });
  assert.equal(resJustBefore.shifted, true);
  assert.equal(resJustBefore.targetDate, '2026-09-04');
});

test('run-daily-broker-update: resolveTargetDate targets today (T-0) at or after 16:30 WIB', () => {
  // 16:30 WIB on Monday 2026-09-07 (09:30 UTC)
  const exactlyAtCutoff = new Date('2026-09-07T09:30:00.000Z');
  const resCutoff = dailyUpdate.resolveTargetDate({ now: exactlyAtCutoff });
  assert.equal(resCutoff.shifted, false);
  assert.equal(resCutoff.targetDate, '2026-09-07');

  // 20:00 WIB evening scheduled firing (13:00 UTC)
  const eveningFiring = new Date('2026-09-07T13:00:00.000Z');
  const resEvening = dailyUpdate.resolveTargetDate({ now: eveningFiring });
  assert.equal(resEvening.shifted, false);
  assert.equal(resEvening.targetDate, '2026-09-07');
});

test('run-daily-broker-update: resolveTargetDate honors explicit date argument regardless of time', () => {
  const morningTime = new Date('2026-09-07T03:00:00.000Z');
  const resExplicit = dailyUpdate.resolveTargetDate({ dateArg: '2026-08-28', now: morningTime });
  assert.equal(resExplicit.shifted, false);
  assert.equal(resExplicit.targetDate, '2026-08-28');
  assert.equal(resExplicit.reason, 'explicit_argument');
});

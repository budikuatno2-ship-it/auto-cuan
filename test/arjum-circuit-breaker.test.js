'use strict';

/**
 * B2 (2026-10-20): daily broker update MUST stop and fail loudly when the very
 * start of a run shows a systemic provider outage, instead of burning the whole
 * daily quota (the 2026-10-19 run sent 921 requests that ALL failed and still
 * looked like a normal "incomplete" run).
 *
 * Policy pinned here:
 *   - first 20 attempts all failed            -> circuit trips, exit code 5
 *   - more than 50% of the first 50 failed    -> circuit trips, exit code 5
 *   - a healthy run                           -> never trips
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const dailyUpdate = require('../tools/run-daily-broker-update');

test.afterEach(() => { process.exitCode = undefined; });

function withTempDataDir(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-'));
  const orig = {
    ARJUM_DATA_DIR: process.env.ARJUM_DATA_DIR,
    AUTO_CUAN_EOD_TEST_TODAY: process.env.AUTO_CUAN_EOD_TEST_TODAY,
    INTEL_INDEX_DIR: process.env.INTEL_INDEX_DIR,
    INTEL_CACHE_DIR: process.env.INTEL_CACHE_DIR,
    BROKER_HUNTER_INDEX_DIR: process.env.BROKER_HUNTER_INDEX_DIR
  };
  process.env.AUTO_CUAN_EOD_TEST_TODAY = '2026-09-07';
  process.env.ARJUM_DATA_DIR = tmpBase;
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.INTEL_INDEX_DIR = path.join(tmpBase, 'bandarmologi-intel-indexes');
  process.env.INTEL_CACHE_DIR = path.join(tmpBase, 'bandarmologi-intel');
  process.env.BROKER_HUNTER_INDEX_DIR = path.join(tmpBase, 'broker-hunter-indexes');
  return Promise.resolve().then(() => fn(tmpBase)).finally(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
}

function mockArjum(fetchBrokerSummary) {
  const intel = require('../lib/bandarmologi-intel-service');
  const originalCompute = intel.computeAndSaveIntel;
  intel.computeAndSaveIntel = () => {};
  const orig = {
    hasArjumApiKey: arjumClient.hasArjumApiKey,
    fetchBrokerSummary: arjumClient.fetchBrokerSummary
  };
  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = fetchBrokerSummary;
  return () => { Object.assign(arjumClient, orig); intel.computeAndSaveIntel = originalCompute; };
}

function tickers(n) {
  return Array.from({ length: n }, (_, i) => 'T' + String(i).padStart(4, '0')).join(',');
}

function isAllFlow(flow) {
  return flow == null || String(flow).trim().toUpperCase() === 'ALL';
}

function validAll(ticker) {
  return { ok: true, data: { flow: 'all', stock_code: String(ticker || 'T').toUpperCase(), top_buyers: [{ broker: 'YU', bval: 1, bvol: 1 }], top_sellers: [] } };
}

test('B2: first 20 attempts all failing trips the circuit and exits 5', async () => {
  await withTempDataDir(async () => {
    let calls = 0;
    const restore = mockArjum(async () => { calls++; return { ok: false, status: 502, error: 'origin overloaded' }; });
    try {
      const result = await dailyUpdate.run(['--tickers', tickers(120), '--date', '2026-09-07', '--delay', '0']);
      assert.equal(process.exitCode, 5, 'systemic outage must exit 5, not a soft incompleteness code');
      assert.equal(result && result.circuitTripped, true);
      assert.match(result.circuitReason, /first_20_all_failed/);
      assert.ok(calls >= 20 && calls <= 51, 'breaker must stop right after the first 20-50 attempts, got ' + calls);
      assert.equal(result.failures.counts.provider_5xx, calls);
    } finally {
      restore();
    }
  });
});

test('B2: more than 50% of the first 50 failing trips the circuit', async () => {
  await withTempDataDir(async () => {
    let allCalls = 0;
    const restore = mockArjum(async (ticker, _date, flow) => {
      if (!isAllFlow(flow)) {
        // Foreign fetch for a completed ticker: never counted by the ALL breaker.
        return { ok: true, data: { flow: 'F', stock_code: String(ticker || 'T').toUpperCase(), brokers: [{ broker_code: 'YU', bval: 1 }] } };
      }
      allCalls++;
      // all-calls 5..30 fail (26/50 = 52%); first 20 are NOT all-failed.
      if (allCalls >= 5 && allCalls <= 30) return { ok: false, status: 503, error: 'service unavailable' };
      return validAll(ticker);
    });
    try {
      const result = await dailyUpdate.run(['--tickers', tickers(120), '--date', '2026-09-07', '--delay', '0']);
      assert.equal(process.exitCode, 5);
      assert.equal(result && result.circuitTripped, true);
      assert.match(result.circuitReason, /50pct_failed_in_first_50/);
    } finally {
      restore();
    }
  });
});

test('B2: a healthy run never trips the circuit', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum(async (ticker) => validAll(ticker));
    try {
      await dailyUpdate.run(['--tickers', tickers(30), '--date', '2026-09-07', '--delay', '0']);
      assert.notEqual(process.exitCode, 5);
    } finally {
      restore();
    }
  });
});
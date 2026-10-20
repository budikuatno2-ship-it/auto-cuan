'use strict';

/**
 * B7 (2026-10-20): a day may only be marked "complete" when the data REALLY
 * landed on disk. Counting successes is not enough — a day can be counted as
 * done while the dated cache file is missing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const dailyUpdate = require('../tools/run-daily-broker-update');

test.afterEach(() => { process.exitCode = undefined; });

function withTempDataDir(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-integrity-'));
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

function mockArjum(overrides) {
  const intel = require('../lib/bandarmologi-intel-service');
  const originalCompute = intel.computeAndSaveIntel;
  intel.computeAndSaveIntel = () => {};
  const orig = {
    hasArjumApiKey: arjumClient.hasArjumApiKey,
    fetchBrokerSummary: arjumClient.fetchBrokerSummary,
    fetchBrokerAccumulation: arjumClient.fetchBrokerAccumulation,
    fetchInsiders: arjumClient.fetchInsiders
  };
  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = overrides.fetchBrokerSummary;
  arjumClient.fetchBrokerAccumulation = overrides.fetchBrokerAccumulation || (async () => ({ ok: true, data: { series: [] } }));
  arjumClient.fetchInsiders = overrides.fetchInsiders || (async () => ({ ok: true, data: [] }));
  return () => { Object.assign(arjumClient, orig); intel.computeAndSaveIntel = originalCompute; };
}

test('B7: marker is NOT complete when the dated file never reached disk', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({
        ok: true,
        data: { flow: 'all', stock_code: 'BBCA', top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }], top_sellers: [] }
      })
    });
    // Simulate a silent disk-write failure: the API says OK, nothing is stored.
    const origWrite = bandarmologiService.writeDiskCache;
    bandarmologiService.writeDiskCache = () => {};
    try {
      // The worker must fail closed (either by throwing or by refusing to
      // complete) — it must NEVER leave a "complete" marker for a day whose
      // data is not on disk.
      let threw = false;
      try {
        await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      } catch (_) {
        threw = true;
      }
      const marker = dailyUpdate.readMarker('2026-09-07');
      if (!marker) {
        assert.equal(threw, true, 'no marker may be written when the data never landed');
      } else {
        assert.equal(marker.complete, false, 'a day whose data never landed on disk must NOT be marked complete');
      }
    } finally {
      bandarmologiService.writeDiskCache = origWrite;
      restore();
    }
  });
});

test('B7: marker IS complete when the data really landed on disk', async () => {
  await withTempDataDir(async () => {
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({
        ok: true,
        data: { flow: 'all', stock_code: 'BBCA', top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }], top_sellers: [] }
      }),
      fetchBrokerAccumulation: async () => ({ ok: true, data: { series: [] } }),
      fetchInsiders: async () => ({ ok: true, data: [] })
    });
    try {
      await dailyUpdate.run(['--tickers', 'BBCA', '--date', '2026-09-07', '--delay', '0']);
      const marker = dailyUpdate.readMarker('2026-09-07');
      assert.equal(marker.complete, true, 'a fully persisted day must still be marked complete');
      assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'BBCA', '2026-09-07'), true);
    } finally {
      restore();
    }
  });
});
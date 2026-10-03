'use strict';

/**
 * Wave 2 — Quota savings evidence (W2-30).
 *
 * Reproduces the historical 2026-10-01 shape (134 zero-volume + 1 traded
 * broker-empty) with mocked providers and a temp candle dir, and asserts the
 * BEFORE/AFTER request counts. No real API quota is consumed.
 *
 * BEFORE policy (pre-Wave-2): every ticker got broker + accumulation + insider
 * requests (3 × 135 = 405) and terminal rows were re-requested every firing.
 * AFTER policy: zero-volume rows are terminal before any request; only the
 * traded-but-empty row costs one broker request (retryable, no auxiliary).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const dailyUpdate = require('../tools/run-daily-broker-update');

test.afterEach(() => { process.exitCode = undefined; });

test('W2-05/W2-30: 134 zero-volume + 1 traded-empty costs 1 request instead of 405, and retries cost 0', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-quota-'));
  const candleDir = path.join(tmpBase, 'candles');
  fs.mkdirSync(candleDir, { recursive: true });

  const orig = {
    ARJUM_DATA_DIR: process.env.ARJUM_DATA_DIR,
    AUTO_CUAN_EOD_TEST_TODAY: process.env.AUTO_CUAN_EOD_TEST_TODAY,
    INTEL_INDEX_DIR: process.env.INTEL_INDEX_DIR,
    INTEL_CACHE_DIR: process.env.INTEL_CACHE_DIR,
    BROKER_HUNTER_INDEX_DIR: process.env.BROKER_HUNTER_INDEX_DIR,
    CANDLE_CACHE_DIR: process.env.CANDLE_CACHE_DIR
  };
  process.env.ARJUM_DATA_DIR = path.join(tmpBase, 'arjum-data');
  process.env.AUTO_CUAN_EOD_TEST_TODAY = '2026-10-01';
  process.env.INTEL_INDEX_DIR = path.join(tmpBase, 'indexes');
  process.env.INTEL_CACHE_DIR = path.join(tmpBase, 'intel-cache');
  process.env.BROKER_HUNTER_INDEX_DIR = path.join(tmpBase, 'hunter');
  process.env.CANDLE_CACHE_DIR = candleDir;

  const intel = require('../lib/bandarmologi-intel-service');
  const originalCompute = intel.computeAndSaveIntel;
  intel.computeAndSaveIntel = () => {};
  const origClient = {
    hasArjumApiKey: arjumClient.hasArjumApiKey,
    fetchBrokerSummary: arjumClient.fetchBrokerSummary,
    fetchBrokerAccumulation: arjumClient.fetchBrokerAccumulation,
    fetchInsiders: arjumClient.fetchInsiders
  };

  const counts = { broker: 0, accumulation: 0, insider: 0 };
  const tickers = [];
  for (let i = 0; i < 134; i++) {
    const t = `Z${String(i).padStart(3, '0')}`;
    tickers.push(t);
    fs.writeFileSync(path.join(candleDir, `${t}.json`), JSON.stringify({
      ticker: t, candles: [{ date: '2026-10-01', open: 100, high: 100, low: 100, close: 100, volume: 0 }]
    }));
  }
  tickers.push('TCID');
  fs.writeFileSync(path.join(candleDir, 'TCID.json'), JSON.stringify({
    ticker: 'TCID', candles: [{ date: '2026-10-01', open: 2600, high: 2600, low: 2600, close: 2600, volume: 200 }]
  }));

  arjumClient.hasArjumApiKey = () => true;
  arjumClient.fetchBrokerSummary = async () => {
    counts.broker++;
    return { ok: true, data: { top_buyers: [], top_sellers: [] } };
  };
  arjumClient.fetchBrokerAccumulation = async () => { counts.accumulation++; return { ok: true, data: { series: [] } }; };
  arjumClient.fetchInsiders = async () => { counts.insider++; return { ok: true, data: [] }; };

  try {
    const args = ['--tickers', tickers.join(','), '--date', '2026-10-01', '--delay', '0'];
    await dailyUpdate.run(args);
    process.exitCode = undefined;

    // AFTER policy: exactly ONE broker request (TCID), zero auxiliary.
    assert.equal(counts.broker, 1, 'only the traded-but-empty ticker may spend a broker request');
    assert.equal(counts.accumulation, 0, 'zero-volume rows must never spend accumulation quota');
    assert.equal(counts.insider, 0, 'zero-volume rows must never spend insider quota');
    const before = 135 * 3;
    const after = counts.broker + counts.accumulation + counts.insider;
    assert.equal(before - after, 404, `saved requests: expected 404, got ${before - after}`);

    // Repeated retry firings: only the genuinely pending row (TCID, traded but
    // provider-empty before the final pass) may be retried — once per firing.
    // The 134 terminal NO_TRADE rows must never be re-requested.
    process.exitCode = undefined;
    await dailyUpdate.run(args);
    process.exitCode = undefined;
    await dailyUpdate.run(args);
    assert.equal(counts.broker, 3, 'exactly one pending row retried once per firing (1 initial + 2 retries)');
    assert.equal(counts.accumulation, 0);
    assert.equal(counts.insider, 0);

    // Terminal --final pass converts the pending row to BROKER_DATA_UNAVAILABLE,
    // after which even it is never requested again.
    process.exitCode = undefined;
    await dailyUpdate.run([...args, '--final']);
    process.exitCode = undefined;
    assert.equal(counts.broker, 4, 'the final pass spends exactly one last broker request');
    await dailyUpdate.run(args);
    process.exitCode = undefined;
    assert.equal(counts.broker, 4, 'after the terminal final pass no ticker is re-requested');
  } finally {
    Object.assign(arjumClient, origClient);
    intel.computeAndSaveIntel = originalCompute;
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

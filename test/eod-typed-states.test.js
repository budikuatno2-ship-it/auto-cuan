'use strict';

/**
 * Wave 2 — Worker integration for typed EOD states (W2-04/W2-05/W2-06/W2-09)
 * plus PR #835 regression invariants (W2-07).
 *
 * All provider calls are mocked; no real API quota is consumed. Candle
 * fixtures are written into a temp CANDLE_CACHE_DIR so the NO_TRADE proof is
 * hermetic and never touches committed data.
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

function withTempEnv(fn) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eod-states-'));
  const orig = {
    ARJUM_DATA_DIR: process.env.ARJUM_DATA_DIR,
    AUTO_CUAN_EOD_TEST_TODAY: process.env.AUTO_CUAN_EOD_TEST_TODAY,
    INTEL_INDEX_DIR: process.env.INTEL_INDEX_DIR,
    INTEL_CACHE_DIR: process.env.INTEL_CACHE_DIR,
    BROKER_HUNTER_INDEX_DIR: process.env.BROKER_HUNTER_INDEX_DIR,
    CANDLE_CACHE_DIR: process.env.CANDLE_CACHE_DIR,
    DAYTRADE_OHLCV_DIR: process.env.INTEL_OHLCV_DIR
  };
  process.env.ARJUM_DATA_DIR = path.join(tmpBase, 'arjum-data');
  process.env.AUTO_CUAN_EOD_TEST_TODAY = '2026-10-02';
  process.env.INTEL_INDEX_DIR = path.join(tmpBase, 'intel-indexes');
  process.env.INTEL_CACHE_DIR = path.join(tmpBase, 'intel-cache');
  process.env.BROKER_HUNTER_INDEX_DIR = path.join(tmpBase, 'hunter');
  process.env.CANDLE_CACHE_DIR = path.join(tmpBase, 'candles');
  fs.mkdirSync(process.env.CANDLE_CACHE_DIR, { recursive: true });
  return Promise.resolve()
    .then(() => fn(tmpBase))
    .finally(() => {
      for (const [key, value] of Object.entries(orig)) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    });
}

function writeCandle(ticker, date, volume, close) {
  const payload = {
    ticker,
    candles: [
      { date, open: close, high: close, low: close, close, volume }
    ]
  };
  fs.writeFileSync(path.join(process.env.CANDLE_CACHE_DIR, `${ticker}.json`), JSON.stringify(payload));
}

function mockArjum(overrides = {}) {
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
  arjumClient.fetchBrokerSummary = overrides.fetchBrokerSummary || (async () => ({ ok: true, data: { top_buyers: [], top_sellers: [] } }));
  arjumClient.fetchBrokerAccumulation = overrides.fetchBrokerAccumulation || (async () => ({ ok: true, data: { series: [] } }));
  arjumClient.fetchInsiders = overrides.fetchInsiders || (async () => ({ ok: true, data: [] }));
  return () => { Object.assign(arjumClient, orig); intel.computeAndSaveIntel = originalCompute; };
}

test('W2-04/W2-05: zero-volume candle -> NO_TRADE, zero broker/aux requests, marker typed', async () => {
  await withTempEnv(async () => {
    writeCandle('NOTRD', '2026-09-30', 0, 2500);
    let brokerCalls = 0, accCalls = 0, insCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { brokerCalls++; return { ok: true, data: { top_buyers: [], top_sellers: [] } }; },
      fetchBrokerAccumulation: async () => { accCalls++; return { ok: true, data: { series: [] } }; },
      fetchInsiders: async () => { insCalls++; return { ok: true, data: [] }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'NOTRD', '--date', '2026-09-30', '--delay', '0']);
      assert.equal(brokerCalls, 0, 'proven no-trade must not spend a broker request');
      assert.equal(accCalls, 0, 'proven no-trade must not spend an accumulation request');
      assert.equal(insCalls, 0, 'proven no-trade must not spend an insider request');
      const marker = dailyUpdate.readMarker('2026-09-30');
      assert.equal(marker.complete, true);
      assert.equal(marker.no_trade_count, 1);
      assert.equal(marker.broker_summary_rows, 0);
      assert.deepEqual(marker.no_trade_tickers, ['NOTRD']);
      assert.equal(marker.trade_date, '2026-09-30');
    } finally { restore(); }
  });
});

test('W2-04: TCID fixture — volume 200 + empty broker summary is NEVER NO_TRADE', async () => {
  await withTempEnv(async () => {
    writeCandle('TCID', '2026-10-01', 200, 2600);
    let brokerCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { brokerCalls++; return { ok: true, data: { top_buyers: [], top_sellers: [] } }; }
    });
    try {
      // Non-final pass: traded-but-empty must stay PENDING (retryable).
      await dailyUpdate.run(['--tickers', 'TCID', '--date', '2026-10-01', '--delay', '0']);
      let marker = dailyUpdate.readMarker('2026-10-01');
      assert.equal(marker.complete, false);
      assert.equal(marker.pending, 1, 'traded-but-empty stays pending before the final pass');
      assert.equal(marker.no_trade_count, 0, 'traded ticker must never be counted NO_TRADE');
      assert.deepEqual(marker.no_trade_tickers || [], []);

      // Final pass: terminal as BROKER_DATA_UNAVAILABLE — still NOT NO_TRADE.
      process.exitCode = undefined;
      await dailyUpdate.run(['--tickers', 'TCID', '--date', '2026-10-01', '--delay', '0', '--final']);
      marker = dailyUpdate.readMarker('2026-10-01');
      assert.equal(marker.complete, true);
      assert.equal(marker.no_trade_count, 0);
      assert.deepEqual(marker.no_trade_tickers || [], [], 'TCID must never appear as NO_TRADE');
      assert.deepEqual(marker.broker_data_unavailable_tickers, ['TCID']);
      assert.equal(marker.broker_data_unavailable_count, 1);
      assert.equal(brokerCalls, 2, 'one request per pass, both consumed by the provider (not skipped as NO_TRADE)');
    } finally { restore(); }
  });
});

test('W2-06: terminal NO_TRADE rows are absent from every subsequent retry firing', async () => {
  await withTempEnv(async () => {
    writeCandle('NOTRD2', '2026-09-30', 0, 1000);
    let brokerCalls = 0, accCalls = 0, insCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { brokerCalls++; return { ok: true, data: { top_buyers: [{ broker: 'YU', bval: 1, bvol: 1 }], top_sellers: [] } }; },
      fetchBrokerAccumulation: async () => { accCalls++; return { ok: true, data: { series: [] } }; },
      fetchInsiders: async () => { insCalls++; return { ok: true, data: [] }; }
    });
    try {
      const args = ['--tickers', 'NOTRD2', '--date', '2026-09-30', '--delay', '0'];
      await dailyUpdate.run(args);
      process.exitCode = undefined;
      await dailyUpdate.run(args);
      process.exitCode = undefined;
      await dailyUpdate.run(args);
      assert.equal(brokerCalls, 0, 'repeated firings must not re-request a terminal NO_TRADE row');
      assert.equal(accCalls, 0);
      assert.equal(insCalls, 0);
      const marker = dailyUpdate.readMarker('2026-09-30');
      assert.equal(marker.complete, true);
      assert.equal(marker.no_trade_count, 1);
    } finally { restore(); }
  });
});

test('W2-06: terminal BROKER_DATA_UNAVAILABLE rows are absent from subsequent retry firings', async () => {
  await withTempEnv(async () => {
    writeCandle('TRADED', '2026-10-01', 500, 3000);
    let brokerCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => { brokerCalls++; return { ok: true, data: { top_buyers: [], top_sellers: [] } }; }
    });
    try {
      await dailyUpdate.run(['--tickers', 'TRADED', '--date', '2026-10-01', '--delay', '0', '--final']);
      assert.equal(brokerCalls, 1);
      process.exitCode = undefined;
      await dailyUpdate.run(['--tickers', 'TRADED', '--date', '2026-10-01', '--delay', '0']);
      assert.equal(brokerCalls, 1, 'a terminal row must not be re-requested by later firings');
      const marker = dailyUpdate.readMarker('2026-10-01');
      assert.equal(marker.complete, true);
    } finally { restore(); }
  });
});

test('W2-09: complete marker carries typed quality metadata and legacy fields stay intact', async () => {
  await withTempEnv(async () => {
    // Same-day target so the auxiliary stage runs (historical targets skip it).
    process.env.AUTO_CUAN_EOD_TEST_TODAY = '2026-09-30';
    writeCandle('META', '2026-09-30', 100, 1200);
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'META', '--date', '2026-09-30', '--delay', '0']);
      const marker = dailyUpdate.readMarker('2026-09-30');
      assert.equal(marker.complete, true);
      // Legacy compatibility fields
      assert.ok('no_data_tickers' in marker, 'legacy no_data_tickers must remain');
      assert.ok('broker_summary_rows' in marker);
      assert.ok('total_tickers' in marker);
      assert.ok('auxiliary_mode' in marker);
      // Typed quality metadata
      assert.equal(marker.trade_date, '2026-09-30');
      assert.equal(marker.master_universe_count, 1);
      assert.equal(marker.effective_universe_count, 1);
      assert.equal(marker.no_trade_count, 0);
      assert.equal(marker.broker_data_unavailable_count, 0);
      assert.equal(marker.pending_provider_count, 0);
      assert.equal(marker.upstream_error_count, 0);
      assert.equal(marker.broker_complete, true);
      assert.equal(marker.accumulation_count, 1);
      assert.equal(marker.insider_count, 1);
    } finally { restore(); }
  });
});

test('W2-04: transport error is UPSTREAM_ERROR — the date stays incomplete and the ticker retryable', async () => {
  await withTempEnv(async () => {
    writeCandle('ERRT', '2026-09-30', 100, 500);
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: false, status: 500, error: 'upstream failure' })
    });
    try {
      await dailyUpdate.run(['--tickers', 'ERRT', '--date', '2026-09-30', '--delay', '0']);
      const marker = dailyUpdate.readMarker('2026-09-30');
      assert.equal(marker.complete, false);
      assert.equal(marker.errors, 1);
      assert.equal(marker.upstream_error_count, 1);
      assert.equal(marker.no_trade_count, 0, 'transport error must never become NO_TRADE');
      assert.equal(marker.pending_provider_count, 0, 'transport error is not provider-pending');
    } finally { restore(); }
  });
});

test('W2-07: historical target never backfills auxiliary and cannot contaminate latest markers', async () => {
  await withTempEnv(async () => {
    let accCalls = 0, insCalls = 0;
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({
        ok: true,
        data: {
          broker_start_date: '2026-09-29', broker_end_date: '2026-09-29',
          top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }], top_sellers: []
        }
      }),
      fetchBrokerAccumulation: async () => { accCalls++; return { ok: true, data: { series: [] } }; },
      fetchInsiders: async () => { insCalls++; return { ok: true, data: [] }; }
    });
    try {
      // AUTO_CUAN_EOD_TEST_TODAY=2026-10-02, so 2026-09-29 is historical.
      await dailyUpdate.run(['--tickers', 'HIST1', '--date', '2026-09-29', '--delay', '0']);
      assert.equal(accCalls, 0, 'historical target must not call the current-only accumulation endpoint');
      assert.equal(insCalls, 0, 'historical target must not call the current-only insiders endpoint');
      const marker = dailyUpdate.readMarker('2026-09-29');
      assert.equal(marker.auxiliary_mode, 'historical_snapshot_not_backfillable');
      assert.equal(bandarmologiService.hasDiskCache('broker-accumulation', 'HIST1', '2026-09-29'), false);
      assert.equal(bandarmologiService.hasDiskCache('insiders', 'HIST1', '2026-09-29'), false);
    } finally { restore(); }
  });
});

test('W2-07: coordinator backlog invariant — only today + H-1, never older gaps', () => {
  const market = require('../tools/run-daily-market-update');
  const broker = require('../tools/run-daily-broker-update');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eod-backlog-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;
  try {
    broker.writeMarker('2026-09-25', { complete: false });
    broker.writeMarker('2026-09-28', { complete: false });
    broker.writeMarker('2026-09-29', { complete: false });
    broker.writeMarker('2026-09-30', { complete: false });
    const dates = market.pendingDates(new Date('2026-10-01T18:00:00+07:00'));
    assert.deepEqual(dates, ['2026-10-01', '2026-09-30'], 'older incomplete markers must never be auto-swept');
  } finally {
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('W2 review: --fresh clears prior terminal claims when a ticker now has real rows', async () => {
  await withTempEnv(async () => {
    // Prior marker claims NOTRD3 was NO_TRADE on this date.
    dailyUpdate.writeMarker('2026-09-30', {
      version: 2, date: '2026-09-30', complete: true,
      no_trade_tickers: ['NOTRD3'], no_data_tickers: ['NOTRD3'], no_data: 1, total_tickers: 1
    });
    writeCandle('NOTRD3', '2026-09-30', 100, 500);
    const restore = mockArjum({
      fetchBrokerSummary: async () => ({ ok: true, data: { top_buyers: [{ broker: 'YU', bval: 100, bvol: 10 }], top_sellers: [] } })
    });
    try {
      await dailyUpdate.run(['--tickers', 'NOTRD3', '--date', '2026-09-30', '--delay', '0', '--fresh']);
      const marker = dailyUpdate.readMarker('2026-09-30');
      assert.equal(marker.complete, true);
      assert.deepEqual(marker.no_trade_tickers, [], '--fresh must drop the stale NO_TRADE claim');
      assert.deepEqual(marker.no_data_tickers, [], 'legacy union must be cleared too');
      assert.equal(marker.no_trade_count, 0);
    } finally { restore(); }
  });
});

test('W2-10: runtime schedule text consistently describes the 23:30 WIB final window', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeFiles = [
    'tools/run-daily-broker-update.js',
    'deploy/vps/run-daily-broker-update.sh',
    'deploy/vps/final-schedule.cron'
  ];
  for (const rel of runtimeFiles) {
    const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.equal(/18:00-22:00|20:00-22:00|--final at 22:00|22:00 --final/.test(source), false, `${rel} must not describe a 22:00 final pass`);
  }
  const cron = fs.readFileSync(path.join(repoRoot, 'deploy/vps/final-schedule.cron'), 'utf8');
  assert.ok(cron.includes('23:30'), 'cron source must state the 23:30 WIB final pass');
  assert.ok(cron.includes('CRON_TZ=Asia/Jakarta'), 'cron source must pin Asia/Jakarta');
});

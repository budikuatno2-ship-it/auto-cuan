const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const vpsFetcher = require('../lib/vps-data-fetcher');
const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('VPS Bridge: exports required constants and fetchers', () => {
  assert.equal(typeof vpsFetcher.VPS_DATA_API_BASE, 'string');
  assert.ok(vpsFetcher.VPS_DATA_API_BASE.startsWith('http'));
  assert.equal(typeof vpsFetcher.fetchAvailableDatesFromVps, 'function');
  assert.equal(typeof vpsFetcher.fetchAvailableDatesFromVpsSync, 'function');
  assert.equal(typeof vpsFetcher.fetchBrokerSummaryFromVps, 'function');
  assert.equal(typeof vpsFetcher.fetchBrokerSummaryFromVpsSync, 'function');

  assert.equal(typeof bandarmologiService.getAvailableDates, 'function');

  assert.equal(typeof bandarmologiRuntime.VPS_DATA_API_BASE, 'string');
  assert.equal(typeof bandarmologiRuntime.fetchVpsAvailableDates, 'function');
  assert.equal(typeof bandarmologiRuntime.fetchVpsBrokerSummary, 'function');
  assert.equal(typeof bandarmologiRuntime.normalizeClientBrokerSummary, 'function');
});

test('VPS Bridge: normalizeClientBrokerSummary correctly formats raw Arjum brokers', () => {
  const mockRaw = {
    stock_code: 'BBCA',
    broker_start_date: '2026-09-10',
    brokers: [
      { broker_code: 'YU', bval: 1000000000, sval: 200000000, bvol: 100000, svol: 20000 },
      { broker_code: 'AK', bval: 500000000, sval: 100000000, bvol: 50000, svol: 10000 },
      { broker_code: 'CC', bval: 100000000, sval: 800000000, bvol: 10000, svol: 80000 }
    ]
  };

  const norm = bandarmologiRuntime.normalizeClientBrokerSummary(mockRaw, '2026-09-10');
  assert.ok(norm);
  assert.equal(norm.stock_code, 'BBCA');
  assert.equal(norm.date, '2026-09-10');
  assert.ok(Array.isArray(norm.gross_buyers));
  assert.ok(Array.isArray(norm.gross_sellers));
  assert.ok(Array.isArray(norm.net_buyers));
  assert.ok(Array.isArray(norm.net_sellers));
  assert.equal(norm.gross_buyers.length, 3);
  assert.equal(norm.gross_sellers.length, 3);
  assert.equal(norm.net_buyers.length, 2);
  assert.equal(norm.net_sellers.length, 1);
  assert.equal(norm.net_buyers[0].broker, 'YU');
  assert.equal(norm.net_sellers[0].broker, 'CC');
  assert.ok(norm.net_flow > 0);
  assert.equal(norm.net_status, 'BIG_ACCUMULATION');
});

test('VPS Bridge: 0-byte local disk guarantee', async () => {
  const testTicker = 'XYZTEST0BYTE';
  const targetDir = path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary', testTicker);
  assert.equal(fs.existsSync(targetDir), false, 'Target dir should not exist before fetch');

  await vpsFetcher.fetchBrokerSummaryFromVps(testTicker, '2026-09-10');
  assert.equal(fs.existsSync(targetDir), false, 'Target dir should still not exist on local disk (0-byte local)');
});

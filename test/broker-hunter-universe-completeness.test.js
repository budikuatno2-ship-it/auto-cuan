'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const brokerHunterService = require('../lib/broker-hunter-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('PR #3 DX Broker: Bahana Sekuritas name resolution', () => {
  assert.equal(brokerHunterService.getBrokerFullName('DX'), 'Bahana Sekuritas');
  assert.equal(brokerHunterService.BROKER_NAMES['DX'], 'Bahana Sekuritas');
  assert.equal(bandarmologiRuntime.BROKER_NAMES['DX'], 'Bahana Sekuritas');
  assert.equal(bandarmologiRuntime.getBrokerSecurityName('DX'), 'Bahana Sekuritas');
});

test('PR #3 Universe Completeness: Broker dictionaries match and contain 60+ IDX brokers', () => {
  const serviceKeys = Object.keys(brokerHunterService.BROKER_NAMES);
  const runtimeKeys = Object.keys(bandarmologiRuntime.BROKER_NAMES);

  assert.ok(serviceKeys.length >= 60, `Service should have at least 60 brokers, got ${serviceKeys.length}`);
  assert.ok(runtimeKeys.length >= 60, `Runtime should have at least 60 brokers, got ${runtimeKeys.length}`);

  // Parity check: all service brokers must be in runtime and vice versa
  for (const key of serviceKeys) {
    assert.ok(bandarmologiRuntime.BROKER_NAMES[key], `Broker ${key} in service must be present in runtime`);
    assert.equal(brokerHunterService.BROKER_NAMES[key], bandarmologiRuntime.BROKER_NAMES[key], `Broker name for ${key} must match`);
  }
});

test('PR #3 DX Broker Hunter: Returns active stocks > 0 across 1d, 7d, and 30d ranges', async () => {
  const ranges = ['1d', '7d', '30d'];

  for (const range of ranges) {
    const res = await brokerHunterService.getBrokerHunterData('DX', { range });
    assert.equal(res.success, true, `Query for DX ${range} must succeed`);
    assert.equal(res.broker, 'DX');
    assert.equal(res.broker_name, 'Bahana Sekuritas');
    assert.ok(res.total_stocks_active > 0, `DX ${range} must have total_stocks_active > 0, got ${res.total_stocks_active}`);
    assert.ok(res.top_accumulated.length > 0, `DX ${range} must have top_accumulated`);
    assert.ok(res.top_distributed.length > 0, `DX ${range} must have top_distributed`);

    // Top accumulated item assertions
    const topAcc = res.top_accumulated[0];
    assert.ok(topAcc.ticker, 'Accumulated item must have ticker');
    assert.ok(topAcc.net_val > 0, 'Accumulated item must have positive net_val');
    assert.ok(topAcc.buy_val > 0, 'Accumulated item must have positive buy_val');
    assert.ok(topAcc.avg_buy_price > 0, 'Accumulated item must have avg_buy_price');
    assert.ok(typeof topAcc.net_lot === 'number', 'Accumulated item must have net_lot');

    // Top distributed item assertions
    const topDist = res.top_distributed[0];
    assert.ok(topDist.ticker, 'Distributed item must have ticker');
    assert.ok(topDist.net_val < 0, 'Distributed item must have negative net_val');
    assert.ok(topDist.sell_val > 0, 'Distributed item must have positive sell_val');
    assert.ok(topDist.avg_sell_price > 0, 'Distributed item must have avg_sell_price');
    assert.ok(typeof topDist.net_lot === 'number', 'Distributed item must have net_lot');
  }
});

test('PR #3 DX Pre-computed Persistence: Files exist in data/broker-hunter-indexes and load via fast-path', async () => {
  const indexDir = path.join(__dirname, '..', 'data', 'broker-hunter-indexes');

  // Both underscore and hyphen formats must exist for DX
  assert.ok(fs.existsSync(path.join(indexDir, 'DX_1d.json')), 'DX_1d.json must exist');
  assert.ok(fs.existsSync(path.join(indexDir, 'DX_7d.json')), 'DX_7d.json must exist');
  assert.ok(fs.existsSync(path.join(indexDir, 'DX_30d.json')), 'DX_30d.json must exist');
  assert.ok(fs.existsSync(path.join(indexDir, 'DX-1d.json')), 'DX-1d.json must exist');
  assert.ok(fs.existsSync(path.join(indexDir, 'DX-7d.json')), 'DX-7d.json must exist');
  assert.ok(fs.existsSync(path.join(indexDir, 'DX-30d.json')), 'DX-30d.json must exist');

  // Fast path verification
  const fastRes = await brokerHunterService.getBrokerHunterData('DX', { range: '1d' });
  assert.equal(fastRes.success, true);
  assert.equal(fastRes.from_cache, true, 'DX query should load from pre-computed cache');
  assert.ok(fastRes.total_stocks_active > 0, 'Cached data must have active stocks > 0');
});

test('PR #3 API Handler Integration: /api/sector-hot?action=broker-hunter&broker=DX returns valid payload', async () => {
  const handler = require('../api/sector-hot');
  let responseStatus = null;
  let responseData = null;

  const req = {
    method: 'GET',
    query: {
      action: 'broker-hunter',
      broker: 'DX',
      range: '1d'
    }
  };

  const res = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    }
  };

  await handler(req, res);
  assert.equal(responseStatus, 200);
  assert.equal(responseData.success, true);
  assert.equal(responseData.broker, 'DX');
  assert.equal(responseData.broker_name, 'Bahana Sekuritas');
  assert.ok(responseData.total_stocks_active > 0, 'API response must have total_stocks_active > 0');
  assert.ok(responseData.top_accumulated.length > 0, 'API response must have top_accumulated');
});

test('PR #3 Frontend UI: Broker Hunter renders DX chip and dropdown option', () => {
  const mockContainer = { innerHTML: '' };
  bandarmologiRuntime.renderBrokerHunterUI(mockContainer);

  assert.ok(mockContainer.innerHTML.includes('>DX</button>'), 'Quick broker chips must include DX');
  assert.ok(mockContainer.innerHTML.includes('DX - Bahana Sekuritas'), 'Dropdown select must include DX - Bahana Sekuritas');
});

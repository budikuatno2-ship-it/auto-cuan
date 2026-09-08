'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const brokerHunterService = require('../lib/broker-hunter-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('Broker Hunter: getBrokerFullName resolves correctly', () => {
  assert.equal(brokerHunterService.getBrokerFullName('AK'), 'UBS Sekuritas Indonesia');
  assert.equal(brokerHunterService.getBrokerFullName('BK'), 'J.P. Morgan Sekuritas Indonesia');
  assert.equal(brokerHunterService.getBrokerFullName('YP'), 'Mirae Asset Sekuritas Indonesia');
  assert.equal(brokerHunterService.getBrokerFullName('CC'), 'Mandiri Sekuritas');
  assert.equal(brokerHunterService.getBrokerFullName('UNKNOWN'), 'Broker UNKNOWN');
  assert.equal(brokerHunterService.getBrokerFullName(''), 'Unknown Broker');
});

test('Broker Hunter: getBrokerHunterData returns valid schema structure', async () => {
  const result = await brokerHunterService.getBrokerHunterData('AK', { range: '1d' });
  assert.equal(result.success, true);
  assert.equal(result.broker, 'AK');
  assert.equal(result.broker_name, 'UBS Sekuritas Indonesia');
  assert.equal(result.range, '1d');
  assert.ok(Array.isArray(result.top_accumulated));
  assert.ok(Array.isArray(result.top_distributed));
  assert.ok(typeof result.total_stocks_active === 'number');
});

test('Broker Hunter: AK and YP return completely distinct, non-identical stock lists (No fake uniform data)', async () => {
  const ak1d = await brokerHunterService.getBrokerHunterData('AK', { range: '1d' });
  const yp1d = await brokerHunterService.getBrokerHunterData('YP', { range: '1d' });

  assert.equal(ak1d.success, true);
  assert.equal(yp1d.success, true);
  assert.equal(ak1d.broker, 'AK');
  assert.equal(yp1d.broker, 'YP');

  const akTickers = ak1d.top_accumulated.map(s => s.ticker);
  const ypTickers = yp1d.top_accumulated.map(s => s.ticker);

  assert.ok(akTickers.length > 0, 'AK must have accumulated tickers');
  assert.ok(ypTickers.length > 0, 'YP must have accumulated tickers');

  // Verify they are NOT identical
  assert.notDeepEqual(akTickers, ypTickers, 'AK and YP accumulated stock lists must not be identical');
  assert.notEqual(akTickers[0], ypTickers[0], 'AK top stock must differ from YP top stock');

  // Also verify date is up to date (2026-09-07)
  assert.ok(ak1d.date_range_label.includes('2026-09-07'), 'Date must reflect latest 2026-09-07 session');
});


test('Broker Hunter: getBrokerHunterData fast-path reads cached index file if present', async () => {
  const fakeCacheDir = brokerHunterService.HUNTER_CACHE_DIR;
  fs.mkdirSync(fakeCacheDir, { recursive: true });
  const mockCachePath = path.join(fakeCacheDir, 'TEST_1d.json');

  const mockPayload = {
    success: true,
    from_cache: false,
    broker: 'TEST',
    broker_name: 'Test Sekuritas',
    range: '1d',
    top_accumulated: [{ ticker: 'BBCA', net_val: 1000000000, net_lot: 1000, avg_buy_price: 10000 }],
    top_distributed: [{ ticker: 'BBRI', net_val: -500000000, net_lot: -500, avg_sell_price: 5000 }],
    total_stocks_active: 2
  };
  fs.writeFileSync(mockCachePath, JSON.stringify(mockPayload), 'utf8');

  try {
    const res = await brokerHunterService.getBrokerHunterData('TEST', { range: '1d' });
    assert.equal(res.success, true);
    assert.equal(res.from_cache, true);
    assert.equal(res.broker, 'TEST');
    assert.equal(res.top_accumulated.length, 1);
    assert.equal(res.top_accumulated[0].ticker, 'BBCA');
    assert.equal(res.top_distributed[0].ticker, 'BBRI');
  } finally {
    if (fs.existsSync(mockCachePath)) {
      fs.unlinkSync(mockCachePath);
    }
  }
});

test('Broker Hunter: generateBrokerHunterIndex creates valid index files', async () => {
  const res = await brokerHunterService.generateBrokerHunterIndex({
    ranges: ['1d'],
    brokers: ['AK', 'BK']
  });

  assert.equal(res.brokers_indexed, 2);
  assert.equal(res.files_written, 2);

  const akPath = path.join(brokerHunterService.HUNTER_CACHE_DIR, 'AK_1d.json');
  const bkPath = path.join(brokerHunterService.HUNTER_CACHE_DIR, 'BK_1d.json');
  assert.ok(fs.existsSync(akPath), 'AK_1d.json must exist');
  assert.ok(fs.existsSync(bkPath), 'BK_1d.json must exist');

  const akData = JSON.parse(fs.readFileSync(akPath, 'utf8'));
  assert.equal(akData.broker, 'AK');
  assert.equal(akData.range, '1d');
});

test('Broker Hunter Frontend: runtime exports functions and handles render container', () => {
  assert.equal(typeof bandarmologiRuntime.setHunterBroker, 'function');
  assert.equal(typeof bandarmologiRuntime.setHunterRange, 'function');
  assert.equal(typeof bandarmologiRuntime.applyCustomHunterRange, 'function');
  assert.equal(typeof bandarmologiRuntime.renderBrokerHunterUI, 'function');

  // Simulate minimal DOM container
  const mockContainer = {
    innerHTML: ''
  };

  bandarmologiRuntime.renderBrokerHunterUI(mockContainer);
  assert.ok(mockContainer.innerHTML.includes('Broker Hunter — Top 10 Saham per Broker'));
  assert.ok(mockContainer.innerHTML.includes('Pilih Broker Cepat:'));
  assert.ok(mockContainer.innerHTML.includes('Semua Broker:'));
  assert.ok(mockContainer.innerHTML.includes('Rentang:'));
});

test('Broker Hunter API: /api/sector-hot?action=broker-hunter invokes handler', async () => {
  const handler = require('../api/sector-hot');
  let responseStatus = null;
  let responseData = null;

  const req = {
    method: 'GET',
    query: {
      action: 'broker-hunter',
      broker: 'AK',
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
  assert.equal(responseData.broker, 'AK');
  assert.equal(responseData.range, '1d');
});

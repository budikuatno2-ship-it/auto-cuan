'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const sectorHot = require('../api/sector-hot');

test('arjumClient: cleanTicker cleans non-alphanumerics and normalizes to uppercase', () => {
  assert.equal(arjumClient.cleanTicker('bbca'), 'BBCA');
  assert.equal(arjumClient.cleanTicker(' BBRI.JK '), 'BBRIJK');
  assert.equal(arjumClient.cleanTicker(null), '');
});

test('arjumClient: hasArjumApiKey checks environment variable safely without leaking', () => {
  const isConfigured = arjumClient.hasArjumApiKey();
  assert.equal(typeof isConfigured, 'boolean');
});

test('bandarmologiService: generateDemoData produces complete structure for UI', () => {
  const data = bandarmologiService.generateDemoData('BBCA', '2026-09-04');
  assert.equal(data.ticker, 'BBCA');
  assert.equal(data.date, '2026-09-04');
  assert.equal(data.is_demo, true);
  assert.ok(data.broker_summary);
  assert.ok(data.broker_summary.top_buyers.length >= 5);
  assert.ok(data.broker_summary.top_sellers.length >= 5);
  assert.ok(data.broker_accumulation);
  assert.ok(Array.isArray(data.broker_accumulation.series));
  assert.ok(Array.isArray(data.insiders));
});

test('bandarmologiService: getBandarmologiData returns demo fallback gracefully when key is unset', async () => {
  const res = await bandarmologiService.getBandarmologiData('BBRI');
  assert.equal(res.success, true);
  assert.equal(res.ticker, 'BBRI');
  assert.ok(res.broker_summary);
  assert.ok(res.broker_accumulation);
  assert.ok(res.insiders);
});

test('sectorHot: handleBandarmologi responds with status 200 and payload', async () => {
  const handler = sectorHot.__test.handleBandarmologi;
  assert.equal(typeof handler, 'function');

  let statusCode = 0;
  let responseData = null;

  const req = {
    query: { ticker: 'TLKM' }
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    }
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  assert.equal(responseData.success, true);
  assert.equal(responseData.ticker, 'TLKM');
});

test('bandarmologiService: normalizeBrokerSummary converts raw broker_levels to top_buyers/sellers', () => {
  const raw = {
    stock_code: 'BBCA',
    broker_start_date: '2026-09-04',
    broker_end_date: '2026-09-04',
    broker_levels: [
      {
        buy: { broker_code: 'YU', broker_name: 'CGS', bval: 154000000, bvol: 22000, bavg: 7000 },
        sell: { broker_code: 'AK', broker_name: 'UBS', sval: 120000000, svol: 17000, savg: 7050 }
      }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(raw, '2026-09-04');
  assert.equal(norm.date, '2026-09-04');
  assert.equal(norm.top_buyers[0].broker, 'YU');
  assert.equal(norm.top_sellers[0].broker, 'AK');
  assert.equal(norm.net_status, 'BIG_ACCUMULATION');
});

test('bandarmologiService: normalizeBrokerAccumulation builds daily series per date', () => {
  const raw = {
    code: 'BBCA',
    series: [
      {
        broker_code: 'AK',
        points: [
          { date: '2026-09-03', nval: 10000000 },
          { date: '2026-09-04', nval: -5000000 }
        ]
      },
      {
        broker_code: 'YU',
        points: [
          { date: '2026-09-03', nval: 20000000 },
          { date: '2026-09-04', nval: 15000000 }
        ]
      }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerAccumulation(raw, 'BBCA');
  assert.equal(norm.series.length, 2);
  assert.equal(norm.series[0].date, '2026-09-03');
  assert.equal(norm.series[0].net_val, 30000000);
  assert.equal(norm.series[1].date, '2026-09-04');
  assert.equal(norm.series[1].net_val, 10000000);
});

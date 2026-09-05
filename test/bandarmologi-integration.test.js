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

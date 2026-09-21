'use strict';

const test = require('node:test');
const assert = require('node:assert');

const handler = require('../lib/analyze-legacy');

test('BUG-AL-01: Greeting "halo" must not be routed to ticker_only', async () => {
  process.env.CODECRAFTERS_API_KEY = 'dummy-test-key';
  const req = {
    method: 'POST',
    body: {
      source: 'chat_mode',
      chatMessage: 'halo'
    }
  };
  let resJson = null;
  const res = {
    status() { return this; },
    json(data) { resJson = data; return this; }
  };

  await handler(req, res);
  assert.ok(resJson, 'Response json must be returned');
  assert.notStrictEqual(resJson.intent, 'ticker_only', 'Greeting "halo" must not be routed to ticker_only');
});

test('BUG-AL-02: ARA/ARB should be computed when prevClose is present in market data', () => {
  const { buildStockFixedTemplate } = handler.__test;
  const d = {
    last: 5000,
    prevClose: 4800,
    priceChange1D: 4.17,
    rsi14: 60,
    high: 5100,
    low: 4800,
    support1: 4900,
    resistance1: 5200
  };
  const html = buildStockFixedTemplate(d, 'BBCA', '');
  const hasComputedAraArb = !html.includes('ARA/ARB: Belum tersedia') && html.includes('ARA/ARB:');
  assert.strictEqual(hasComputedAraArb, true, 'ARA/ARB should be computed when prevClose is present in market data');
});

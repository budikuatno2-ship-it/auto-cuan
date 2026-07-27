'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PatternMap = require('../public/pattern-map');

const enabled = process.env.RUN_QUICKCHART_INTEGRATION === '1';
test('real QuickChart v4 response is a non-empty 1200x700 PNG', { skip: !enabled }, async () => {
  const candles = [20, 21, 22, 23, 24, 25, 26].map((day, index) => ({
    time: `2026-07-${day}`, open: 9000 + index * 25, high: 9150 + index * 25,
    low: 8900 + index * 25, close: 9050 + index * 25
  }));
  const candidate = {
    id: 'quickchart-integration-fixture', ruleVersion: 'audit-v1', name: 'Non-production ABCD fixture', status: 'confirmed',
    provenance: 'test/pattern-map-quickchart.integration.test.js', ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles,
    points: {
      X: { time: candles[0].time, value: candles[0].low, candleIndex: 0, priceField: 'low' }, A: { time: candles[1].time, value: candles[1].high, candleIndex: 1, priceField: 'high' },
      B: { time: candles[2].time, value: candles[2].low, candleIndex: 2, priceField: 'low' }, C: { time: candles[3].time, value: candles[3].high, candleIndex: 3, priceField: 'high' },
      D: { time: candles[4].time, value: candles[4].low, candleIndex: 4, priceField: 'low' }
    }, prz: { low: 9075, high: 9150 }, confirmation: 9300, invalidation: 9000, tp1: 9500, tp2: 9700,
    currentPrice: candles.at(-1).close, confirmationEvidence: { type: 'daily-close', date: '2026-07-26' }
  };
  const context = { ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles: JSON.parse(JSON.stringify(candles)) };
  let contentType;
  const manager = new PatternMap.RequestManager(async (url, options) => {
    const response = await fetch(url, options); contentType = response.headers.get('content-type'); return response;
  });
  const result = await manager.render(candidate, context);
  assert.equal(result.error, undefined);
  assert.match(contentType || '', /^image\/png(?:;|$)/i);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  assert.ok(bytes.length > 1000);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 700);
});

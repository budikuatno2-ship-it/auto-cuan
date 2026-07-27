'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PatternMap = require('../public/pattern-map');

function fixture() {
  const candles = [20, 21, 22, 23, 24, 25, 26].map((day, index) => ({
    time: `2026-07-${day}`, open: 9000 + index * 25, high: 9150 + index * 25,
    low: 8900 + index * 25, close: 9050 + index * 25
  }));
  const point = (index, priceField) => ({
    time: candles[index].time, value: candles[index][priceField], candleIndex: index, priceField
  });
  const candidate = {
    id: 'quickchart-request-fixture', ruleVersion: 'audit-v1', name: 'Trusted ABCD', status: 'confirmed',
    provenance: 'test:pattern-map-render-request', ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles,
    points: { X: point(0, 'low'), A: point(1, 'high'), B: point(2, 'low'), C: point(3, 'high'), D: point(4, 'low') },
    prz: { low: 9075, high: 9150 }, confirmation: 9300, invalidation: 9000, tp1: 9500, tp2: 9700,
    currentPrice: candles.at(-1).close, confirmationEvidence: { type: 'daily-close', date: '2026-07-26' }
  };
  return { candidate, context: { ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles: JSON.parse(JSON.stringify(candles)) } };
}

test('QuickChart request fixes devicePixelRatio at one for an exact 1200x700 PNG', async () => {
  const value = fixture();
  let body;
  const manager = new PatternMap.RequestManager(async (url, options) => {
    assert.equal(url, 'https://quickchart.io/chart');
    body = JSON.parse(options.body);
    return { ok: true, blob: async () => ({}) };
  });
  await manager.render(value.candidate, value.context);
  assert.equal(body.version, '4');
  assert.equal(body.width, 1200);
  assert.equal(body.height, 700);
  assert.equal(body.devicePixelRatio, 1);
  assert.equal(body.format, 'png');
});

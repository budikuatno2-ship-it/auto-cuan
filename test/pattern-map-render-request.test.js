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

function capture() {
  let body;
  const manager = new PatternMap.RequestManager(async (url, options) => {
    assert.equal(url, 'https://quickchart.io/chart');
    body = JSON.parse(options.body);
    return { ok: true, blob: async () => ({}) };
  });
  return { manager, read: () => body };
}

test('QuickChart request renders a desktop PNG at retina scale', async () => {
  const value = fixture();
  const { manager, read } = capture();
  await manager.render(value.candidate, value.context, { viewportWidth: 1440 });
  const body = read();
  assert.equal(body.version, '4');
  assert.equal(body.width, 1200);
  assert.equal(body.height, 700);
  assert.equal(body.devicePixelRatio, 2);
  assert.equal(body.format, 'png');
});

// A phone downscales a 1200px canvas by ~3.4x, which turns 13px axis labels into
// unreadable smudges. The narrow spec keeps the same labels legible.
test('QuickChart request narrows the logical canvas for phone viewports', async () => {
  const value = fixture();
  const { manager, read } = capture();
  await manager.render(value.candidate, value.context, { viewportWidth: 390 });
  const body = read();
  assert.equal(body.width, 600);
  assert.equal(body.height, 480);
  assert.equal(body.devicePixelRatio, 2);
  assert.ok(body.chart.options.plugins.title.font.size >= 16);
  assert.equal(body.chart.options.scales.x.ticks.maxTicksLimit, 5);
});

test('a cached render is not reused across viewport classes', async () => {
  const value = fixture();
  let calls = 0;
  const manager = new PatternMap.RequestManager(async () => {
    calls += 1;
    return { ok: true, blob: async () => ({}) };
  });
  await manager.render(value.candidate, value.context, { viewportWidth: 1440 });
  await manager.render(value.candidate, value.context, { viewportWidth: 390 });
  assert.equal(calls, 2);
  assert.notEqual(
    PatternMap.cacheKey(value.candidate, PatternMap.patternImageSpec(1440)),
    PatternMap.cacheKey(value.candidate, PatternMap.patternImageSpec(390))
  );
});

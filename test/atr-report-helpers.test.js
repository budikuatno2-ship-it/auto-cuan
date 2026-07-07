'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const atr = require('../lib/atr-report-helpers');
const script = require('../tools/report-atr-validation');

function candles(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ high: 110 + i, low: 100 + i, close: 105 + i });
  return out;
}

test('calculateAtr computes ATR(14) from daily true ranges', () => {
  assert.equal(atr.calculateAtr(candles(15), 14), 10);
});

test('distance-to-ATR multiple calculation uses absolute entry-level distance', () => {
  assert.equal(atr.distanceAtrMultiple(100, 95, 5), 1);
  assert.equal(atr.distanceAtrMultiple(100, 115, 5), 3);
});

test('SL and TP classifications follow report thresholds', () => {
  assert.equal(atr.classifySl(0.99), 'SL_TOO_TIGHT');
  assert.equal(atr.classifySl(1), 'SL_OK');
  assert.equal(atr.classifySl(2.5), 'SL_OK');
  assert.equal(atr.classifySl(2.51), 'SL_TOO_WIDE');
  assert.equal(atr.classifyTp1(2.5), 'TP1_REALISTIC');
  assert.equal(atr.classifyTp1(2.51), 'TP1_STRETCHED');
  assert.equal(atr.classifyTp2(4), 'TP2_NOT_STRETCHED');
  assert.equal(atr.classifyTp2(4.01), 'TP2_STRETCHED');
});

test('buildSummary groups by source and aggregates ATR classifications', () => {
  const summary = atr.buildSummary([
    { source: 'daytrade', slAtrMultiple: 0.5, tp1AtrMultiple: 3, tp2AtrMultiple: 5, slClass: 'SL_TOO_TIGHT', tp1Class: 'TP1_STRETCHED', outcome: 'SL_HIT' },
    { source: 'daytrade', slAtrMultiple: 2, tp1AtrMultiple: 2, tp2AtrMultiple: 3, slClass: 'SL_OK', tp1Class: 'TP1_REALISTIC', outcome: 'WAITING' },
    { source: 'swing', slAtrMultiple: 3, tp1AtrMultiple: 4, tp2AtrMultiple: 6, slClass: 'SL_TOO_WIDE', tp1Class: 'TP1_STRETCHED', outcome: 'TP1_HIT' }
  ]);
  assert.equal(summary.bySource.daytrade.count, 2);
  assert.equal(summary.bySource.daytrade.slTooTight, 1);
  assert.equal(summary.bySource.daytrade.slTooTightSlHit, 1);
  assert.equal(summary.bySource.swing.tp1StretchedTpHit, 1);
});

test('validatePick handles missing OHLCV and missing levels gracefully', () => {
  const row = atr.validatePick({ ticker: 'BBCA', entry1: 100, raw_payload: { monitor_source: 'daytrade' } }, null);
  assert.equal(row.reason, 'missing_ohlcv');
  assert.equal(row.slClass, 'SL_UNKNOWN');
  assert.equal(row.tp1Class, 'TP1_UNKNOWN');
});

test('validatePicks performs read-only validation through injected provider without writes', async () => {
  let fetches = 0;
  const provider = { fetchWithCache: async () => { fetches++; return candles(15); }, getStats: () => ({}) };
  const result = await script.validatePicks([{ ticker: 'BBCA', entry1: 100, sl: 95, tp1: 110, tp2: 125, raw_payload: { monitor_source: 'daytrade' } }], { provider });
  assert.equal(fetches, 1);
  assert.equal(result.rows[0].slClass, 'SL_TOO_TIGHT');
  assert.equal(typeof provider.writeCache, 'undefined');
});

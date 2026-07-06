'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveDataQualityStatus } = require('../lib/daytrade-screener-engine');

function candles(count, override) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(Object.assign({ time: 1700000000 + i * 86400, open: 100, high: 105, low: 95, close: 101, volume: 1000000 }, override || {}));
  }
  return rows;
}

function assertPublicSafeShape(result, status, valid) {
  assert.equal(result.data_quality_status, status);
  assert.equal(typeof result.data_quality_label, 'string');
  assert.equal(typeof result.data_quality_note, 'string');
  assert.equal(result.data_quality_valid, valid);
  assert.equal(result.data_quality_needs_revalidation, !valid);
  assert.equal(result.data_quality_note.includes('[object Object]'), false);
}

test('deriveDataQualityStatus returns OK for valid candle data', () => {
  const result = deriveDataQualityStatus({ candles: candles(25), previous_close: 100 });
  assertPublicSafeShape(result, 'OK', true);
  assert.equal(result.data_quality_label, 'Data valid');
});

test('deriveDataQualityStatus flags missing previous close/reference price', () => {
  const result = deriveDataQualityStatus({ candles: candles(25), previous_close: null });
  assertPublicSafeShape(result, 'MISSING_REFERENCE', false);
  assert.equal(result.data_quality_label, 'Butuh reference price');
});

test('deriveDataQualityStatus flags short history', () => {
  const result = deriveDataQualityStatus({ candles: candles(10), previous_close: 100 });
  assertPublicSafeShape(result, 'SHORT_HISTORY', false);
  assert.equal(result.data_quality_label, 'Riwayat data pendek');
});

test('deriveDataQualityStatus flags sparse trading days', () => {
  const sparse = candles(25).map((c, i) => Object.assign({}, c, { volume: i < 12 ? 0 : c.volume }));
  const result = deriveDataQualityStatus({ candles: sparse, previous_close: 100, sparseWindow: 20, minTradingDays: 18 });
  assertPublicSafeShape(result, 'SPARSE_TRADING_DAYS', false);
});

test('deriveDataQualityStatus flags invalid OHLC geometry', () => {
  const bad = candles(25);
  bad[12] = Object.assign({}, bad[12], { high: 90, low: 95 });
  const result = deriveDataQualityStatus({ candles: bad, previous_close: 100 });
  assertPublicSafeShape(result, 'INVALID_CANDLE', false);
});

test('deriveDataQualityStatus flags invalid volume', () => {
  const bad = candles(25);
  bad[12] = Object.assign({}, bad[12], { volume: -1 });
  const result = deriveDataQualityStatus({ candles: bad, previous_close: 100 });
  assertPublicSafeShape(result, 'INVALID_CANDLE', false);
});

test('deriveDataQualityStatus flags corporate-action-like extreme gap conservatively', () => {
  const gap = candles(25);
  gap[24] = { time: 1700000000 + 24 * 86400, open: 140, high: 145, low: 135, close: 142, volume: 1000000 };
  const result = deriveDataQualityStatus({ candles: gap, previous_close: 100, extremeGapPct: 25 });
  assertPublicSafeShape(result, 'CORPORATE_ACTION_RISK', false);
  assert.match(result.data_quality_note, /validasi corporate action/i);
});

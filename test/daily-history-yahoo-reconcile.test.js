'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileMissingCloseFromMeta,
  candlesToHistoryRows
} = require('../lib/daily-history-collector');

function baseArgs(overrides) {
  return Object.assign({
    isLastRow: true,
    rowDate: '2026-08-11',
    metaDate: '2026-08-11',
    open: 6375,
    high: 6400,
    low: 6200,
    volume: 112490800,
    metaPrice: 6300,
    metaVolume: 112490800
  }, overrides || {});
}

test('reconciles missing close only when all same-session guards pass', () => {
  assert.equal(reconcileMissingCloseFromMeta(baseArgs()), 6300);
});

test('rejects reconciliation when raw row is not the last chart row', () => {
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ isLastRow: false })), null);
});

test('rejects reconciliation when row date and metadata date differ', () => {
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ metaDate: '2026-08-10' })), null);
});

test('rejects reconciliation when metadata volume does not exactly match row volume', () => {
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ metaVolume: 112490799 })), null);
});

test('rejects reconciliation when metadata price is outside row low/high range', () => {
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ metaPrice: 6500 })), null);
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ metaPrice: 6100 })), null);
});

test('rejects reconciliation when any required OHLCV/meta value is missing or non-finite', () => {
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ open: null })), null);
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ high: undefined })), null);
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ low: NaN })), null);
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ volume: Infinity })), null);
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ metaPrice: null })), null);
  assert.equal(reconcileMissingCloseFromMeta(baseArgs({ metaVolume: null })), null);
});

test('candlesToHistoryRows preserves yahoo_meta_reconciled + estimated for a completed prior session', () => {
  const rows = candlesToHistoryRows('BBCA', [
    {
      date: '2026-08-10', open: 6400, high: 6450, low: 6350, close: 6375, volume: 88666100,
      data_source: 'yahoo', data_quality_status: 'ok'
    },
    {
      date: '2026-08-11', open: 6375, high: 6400, low: 6200, close: 6300, volume: 112490800,
      data_source: 'yahoo_meta_reconciled', data_quality_status: 'estimated'
    }
  ], {
    retentionSessions: 120,
    now: new Date('2026-08-12T03:30:00+07:00'),
    sourceTimestamp: '2026-08-11T20:30:00.000Z'
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[1].ticker, 'BBCA');
  assert.equal(rows[1].trade_date, '2026-08-11');
  assert.equal(rows[1].close, 6300);
  assert.equal(rows[1].previous_close, 6375);
  assert.equal(rows[1].data_source, 'yahoo_meta_reconciled');
  assert.equal(rows[1].data_quality_status, 'estimated');
});

test('candlesToHistoryRows marks reconciled current-session row partial before 16:00 WIB', () => {
  const rows = candlesToHistoryRows('BBCA', [
    {
      date: '2026-08-12', open: 6300, high: 6350, low: 6250, close: 6325, volume: 1000,
      data_source: 'yahoo_meta_reconciled', data_quality_status: 'estimated'
    }
  ], {
    now: new Date('2026-08-12T10:00:00+07:00')
  });

  assert.equal(rows[0].data_source, 'yahoo_meta_reconciled');
  assert.equal(rows[0].data_quality_status, 'partial');
});

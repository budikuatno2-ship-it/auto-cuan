'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isValidIhsgCandle } = require('../lib/ihsg-validation');
const { buildChartResponse } = require('../api/chart');

test('R13: IHSG candle validation accepts positive closes independent of date-era range', () => {
  for (const candle of [
    { date: '2024-01-01', close: 6000 },
    { date: '2024-05-15', close: 7250 },
    { date: '2026-11-13', close: 8500 },
    { date: '2024-08-01', close: 5266.13 },
    { date: '2026-03-10', close: 5999.99 },
    { date: '2026-03-10', close: 8500.01 },
    { date: '2020-03-24', close: 3937.63 },
    { date: '2015-09-28', close: 4120.50 },
    { date: '2008-10-28', close: 1111.45 },
    { close: 6500 },
    { close: 2500 },
    { close: 800 }
  ]) {
    assert.equal(isValidIhsgCandle(candle), true, `positive finite close should be retained: ${JSON.stringify(candle)}`);
  }

  for (const candle of [null, {}, { close: null }, { close: '' }, { close: NaN }, { close: Infinity }, { close: -100 }, { close: 0 }]) {
    assert.equal(isValidIhsgCandle(candle), false, `invalid close should be rejected: ${JSON.stringify(candle)}`);
  }
});

test('R13: api/chart retains IHSG rows by date and source provenance, not close range', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ihsg-chart-test-'));
  const ohlcvDir = path.join(tmp, 'data', 'ohlcv');
  fs.mkdirSync(ohlcvDir, { recursive: true });

  const fixtureData = {
    ticker: 'IHSG',
    candles: [
      { date: '2024-06-10', open: 5300, high: 5350, low: 5200, close: 5266.13, volume: 150000000,
        source: 'fixture-yahoo', source_sha256: 'fixture-row-digest', source_as_of: '2024-06-10' },
      { date: '2026-11-13', open: 7200, high: 7300, low: 7180, close: 7250, volume: 200000000,
        source: 'fixture-yahoo', source_sha256: 'fixture-latest-digest', source_as_of: '2026-11-13' },
      { date: '2026-11-14', open: 7250, high: 7260, low: 7240, close: 7400, volume: 200000000,
        source: 'fixture-yahoo', source_sha256: 'fixture-invalid-ohlc-digest', source_as_of: '2026-11-14' }
    ]
  };

  fs.writeFileSync(path.join(ohlcvDir, 'IHSG.json'), JSON.stringify(fixtureData));

  try {
    const res = buildChartResponse('IHSG', new Date('2026-11-16T17:00:00+07:00'), { root: tmp });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.ticker, 'IHSG');
    assert.equal(res.payload.source, 'daily_candles_flat_file');
    assert.equal(res.payload.as_of, '2026-11-13');
    assert.equal(res.payload.actual_data_date, '2026-11-13');
    assert.deepEqual(res.payload.candles.map(c => c.time), ['2024-06-10', '2026-11-13']);
    assert.deepEqual(res.payload.candles[0].provenance, {
      storage: 'daily_candles_flat_file', row_key: null, trade_date: '2024-06-10', source: 'fixture-yahoo',
      source_sha256: 'fixture-row-digest', source_as_of: '2024-06-10', source_bar_timestamp: null,
      source_published_at: null, received_at: null, ingested_at: null, price_adjustment: null,
      volume_status: 'OBSERVED'
    });
    assert.equal(res.payload.candles[0].close, 5266.13);
    assert.equal(res.payload.candles[1].close, 7250);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

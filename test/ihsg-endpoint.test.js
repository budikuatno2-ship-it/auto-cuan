'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const candles = require('../api/candles');
const marketRegime = require('../lib/market-regime');

test('Langkah 1: /api/candles?ticker=IHSG reads disk cache when available', async () => {
  const req = { method: 'GET', query: { ticker: 'IHSG' } };
  let jsonOutput = null;
  const res = {
    statusCode: 200,
    setHeader: () => {},
    status: function(code) { this.statusCode = code; return this; },
    json: function(data) { jsonOutput = data; return this; }
  };

  await candles(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(jsonOutput.success, true);
  assert.equal(jsonOutput.ticker, 'IHSG');
  assert.equal(jsonOutput.source, 'Data Historis T-1');
  assert.equal(jsonOutput.totalCandles >= 500, true);
  assert.equal(jsonOutput.latest.date, '2026-10-16');
  assert.equal(jsonOutput.latest.last, 5185.1);
  assert.equal(jsonOutput.latest.volume, 64872651800);
});

test('Langkah 1: marketRegime.fetchIhsgDailyCandles reads disk cache', async () => {
  const daily = await marketRegime.fetchIhsgDailyCandles();
  assert.equal(Array.isArray(daily), true);
  assert.equal(daily.length >= 500, true);
  const last = daily[daily.length - 1];
  assert.equal(last.date, '2026-10-16');
  assert.equal(Math.round(last.close * 10) / 10, 5185.1);
});

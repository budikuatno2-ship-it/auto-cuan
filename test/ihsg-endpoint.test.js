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
  const daily = await marketRegime.fetchIhsgDailyCandles({ skipLive: true });
  assert.equal(Array.isArray(daily), true);
  assert.equal(daily.length >= 500, true);
  const last = daily[daily.length - 1];
  assert.equal(last.date, '2026-10-16');
  assert.equal(Math.round(last.close * 10) / 10, 5185.1);
});

test('C3 [BUG FIX]: marketRegime.fetchIhsgDailyCandles appends live intraday bar to historical disk series', async () => {
  // Mock global fetch to return an intraday bar for Monday 2026-10-19 at 10:00 WIB
  const origFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      if (String(url).includes('%5EJKSE')) {
        return {
          ok: true,
          json: async () => ({
            chart: {
              result: [{
                timestamp: [Math.floor(new Date('2026-10-19T03:00:00Z').getTime() / 1000)], // 10:00 WIB
                indicators: {
                  quote: [{
                    close: [5250.75]
                  }]
                }
              }]
            }
          })
        };
      }
      return origFetch(url);
    };

    const candlesWithLive = await marketRegime.fetchIhsgDailyCandles();
    assert.equal(Array.isArray(candlesWithLive), true);
    // Preserves all historical bars
    assert.equal(candlesWithLive.length >= 501, true);

    // Latest bar is today's live intraday price from Yahoo
    const liveBar = candlesWithLive[candlesWithLive.length - 1];
    assert.equal(liveBar.date, '2026-10-19');
    assert.equal(liveBar.close, 5250.75);

    // Previous bar remains Friday 2026-10-16 from disk
    const prevBar = candlesWithLive[candlesWithLive.length - 2];
    assert.equal(prevBar.date, '2026-10-16');
    assert.equal(Math.round(prevBar.close * 10) / 10, 5185.1);

    // Market regime is evaluated using live 5250.75 instead of Friday's 5185.1
    const regime = await marketRegime.getMarketRegime();
    assert.ok(regime);
    assert.ok(regime.market_regime_label);
  } finally {
    global.fetch = origFetch;
  }
});

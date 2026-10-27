'use strict';
const candles = require('../../api/candles');

async function test() {
  const req = { method: 'GET', query: { ticker: 'IHSG' } };
  const res = {
    statusCode: 200,
    setHeader: () => {},
    status: function(code) { this.statusCode = code; return this; },
    json: function(data) {
      console.log('Status:', this.statusCode);
      console.log('Source:', data.source);
      console.log('Ticker:', data.ticker);
      console.log('Total candles:', data.totalCandles);
      console.log('Latest:', data.latest);
      console.log('Sample candle:', data.candles ? data.candles[data.candles.length - 1] : null);
    }
  };
  await candles(req, res);
}

test().catch(console.error);

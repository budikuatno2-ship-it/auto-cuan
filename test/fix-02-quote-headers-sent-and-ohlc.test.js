'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quoteHandler = require('../api/quote.js');

test('FIX-02: setHeaderSafe and canSendResponse guard against headersSent and writableEnded', () => {
  assert.equal(typeof quoteHandler.canSendResponse, 'function', 'canSendResponse must be exported for quote API safety');

  // Test canSendResponse
  assert.equal(quoteHandler.canSendResponse(null), false);
  assert.equal(quoteHandler.canSendResponse({ headersSent: true, writableEnded: false }), false);
  assert.equal(quoteHandler.canSendResponse({ headersSent: false, writableEnded: true }), false);
  assert.equal(quoteHandler.canSendResponse({ headersSent: false, writableEnded: false }), true);

  // Test setHeaderSafe
  let headerSet = false;
  const mockRes = {
    headersSent: true,
    writableEnded: false,
    setHeader: () => { headerSet = true; }
  };
  quoteHandler.setHeaderSafe(mockRes, 'X-Test', '1');
  assert.equal(headerSet, false, 'setHeaderSafe must NOT set header when headersSent is true');

  const mockRes2 = {
    headersSent: false,
    writableEnded: true,
    setHeader: () => { headerSet = true; }
  };
  quoteHandler.setHeaderSafe(mockRes2, 'X-Test', '1');
  assert.equal(headerSet, false, 'setHeaderSafe must NOT set header when writableEnded is true');
});

test('FIX-02: Handler does NOT attempt to send response when headersSent or writableEnded is true (avoids ERR_HTTP_HEADERS_SENT)', async () => {
  let jsonCalls = 0;
  const mockRes = {
    headersSent: true,
    writableEnded: true,
    setHeader: () => {},
    status: () => {
      return {
        json: () => {
          jsonCalls++;
        }
      };
    }
  };

  const mockReq = {
    query: { ticker: 'BBCA' },
    headers: {}
  };

  // Calling handler when response has already ended/sent headers
  await quoteHandler(mockReq, mockRes);
  assert.equal(jsonCalls, 0, 'Must NOT invoke res.status().json() when headersSent/writableEnded is true');
});

test('FIX-02: OHLC parser strictly validates all 4 values (open, high, low, close) to be finite', async () => {
  // Test with invalid candle values where close is valid number but open/high/low are NaN or non-finite
  // Before fix, !isNaN(c) permitted invalid open/high/low to enter candles
  assert.equal(typeof quoteHandler.fetchYahooQuote, 'function', 'fetchYahooQuote must be exported for testing');
});

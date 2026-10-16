'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const candleFetcher = require('../lib/chart-engine/candle-fetcher.js');

test('FIX-10: readScreenerCandles falls back to local SQLite store when file cache is missing', async () => {
  // Reset circuit first
  candleFetcher.resetScreenerCandleCircuit();

  // Pick a ticker that has data in local-market-subset-store (e.g. BBCA) but no JSON file
  const candles = candleFetcher.readScreenerCandles('BBCA', 20);
  assert.ok(candles, 'Must return candles from SQLite fallback when disk JSON is missing or insufficient');
  assert.ok(candles.length >= 20, 'Must have at least 20 candles');
  assert.ok(Number.isFinite(candles[0].close));
  assert.ok(Number.isFinite(candles[0].open));
});

test('FIX-10: fetchScreenerCandles returns SQLite candles when circuit breaker is OPEN', async () => {
  // Trip the breaker with 3 failures
  candleFetcher.resetScreenerCandleCircuit();
  candleFetcher.noteScreenerRemoteResult(false);
  candleFetcher.noteScreenerRemoteResult(false);
  candleFetcher.noteScreenerRemoteResult(false);
  assert.equal(candleFetcher.screenerRemoteCircuitOpen(), true, 'Circuit breaker must be OPEN');

  // fetchScreenerCandles for BBCA
  const candles = await candleFetcher.fetchScreenerCandles('BBCA', { minCandles: 20 });
  assert.ok(candles, 'Must not return null when SQLite store has candles, even if circuit is OPEN');
  assert.ok(candles.length >= 20);

  candleFetcher.resetScreenerCandleCircuit();
});

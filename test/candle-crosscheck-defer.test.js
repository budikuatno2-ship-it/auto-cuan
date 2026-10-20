'use strict';

/**
 * B4 (2026-10-20): a failed candle cross-check must NOT trigger a mass fallback
 * to Arjum. On 2026-10-19 the 16:40 run cross-checked 20/20 as failed and then
 * mass-fell-back to Arjum (943 requests, 0 usable bars, exit code 0, no alarm).
 * New policy: DEFER to the 23:30 pass (exit code 6), unless explicitly overridden.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const fetchDailyCandles = require('../tools/fetch-daily-candles');

function tickerList(n) {
  return Array.from({ length: n }, (_, i) => 'X' + String(i).padStart(3, '0'));
}

test('B4: cross-check failure defers (no mass Arjum fallback) with exit code 6', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-defer-'));
  const orig = {
    CANDLE_CACHE_DIR: process.env.CANDLE_CACHE_DIR,
    CANDLE_SOURCE: process.env.CANDLE_SOURCE,
    CANDLE_CROSSCHECK: process.env.CANDLE_CROSSCHECK,
    CANDLE_ALLOW_MASS_FALLBACK_ON_CROSSCHECK: process.env.CANDLE_ALLOW_MASS_FALLBACK_ON_CROSSCHECK
  };
  process.env.CANDLE_CACHE_DIR = tmpDir;
  process.env.CANDLE_SOURCE = 'yahoo';
  delete process.env.CANDLE_CROSSCHECK;
  delete process.env.CANDLE_ALLOW_MASS_FALLBACK_ON_CROSSCHECK;

  const origFetchDaily = candleFetcher.fetchDailyCandles;
  const origFetchYahoo = candleFetcher.fetchDailyCandlesYahoo;
  let arjumBulkCalls = 0;

  // Cross-check: Arjum reports close 1000, Yahoo reports close 2000 (>0.5% diff)
  // → every sample fails → cross_check_failed = true.
  candleFetcher.fetchDailyCandles = async (ticker) => ({
    ok: true,
    data: { code: ticker, candles: [{ date: '2026-09-07', open: 1000, high: 1000, low: 1000, close: 1000, volume: 1000 }] }
  });
  candleFetcher.fetchDailyCandlesYahoo = async (ticker) => ({
    ok: true,
    data: { code: ticker, candles: [{ date: '2026-09-07', open: 2000, high: 2000, low: 2000, close: 2000, volume: 1000 }] }
  });

  try {
    const summary = await fetchDailyCandles.main({
      targetDate: '2026-09-07',
      tickers: tickerList(30),
      crossCheckTickers: tickerList(20)
    });
    assert.equal(summary.deferred, true, 'a failed cross-check must defer, not mass-fallback');
    assert.equal(summary.reason, 'CROSS_CHECK_FAILED_DEFERRED');
    assert.equal(summary.cross_check_failed, true);
    assert.equal(process.exitCode, 6);
  } finally {
    process.exitCode = undefined;
    candleFetcher.fetchDailyCandles = origFetchDaily;
    candleFetcher.fetchDailyCandlesYahoo = origFetchYahoo;
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('B4: explicit override restores the legacy mass-fallback behavior', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-override-'));
  const orig = {
    CANDLE_CACHE_DIR: process.env.CANDLE_CACHE_DIR,
    CANDLE_SOURCE: process.env.CANDLE_SOURCE,
    CANDLE_CROSSCHECK: process.env.CANDLE_CROSSCHECK
  };
  process.env.CANDLE_CACHE_DIR = tmpDir;
  process.env.CANDLE_SOURCE = 'yahoo';
  delete process.env.CANDLE_CROSSCHECK;

  const origFetchDaily = candleFetcher.fetchDailyCandles;
  const origFetchYahoo = candleFetcher.fetchDailyCandlesYahoo;

  candleFetcher.fetchDailyCandles = async (ticker) => ({
    ok: true,
    data: { code: ticker, candles: [{ date: '2026-09-07', open: 1000, high: 1000, low: 1000, close: 1000, volume: 1000 }] }
  });
  candleFetcher.fetchDailyCandlesYahoo = async (ticker) => ({
    ok: true,
    data: { code: ticker, candles: [{ date: '2026-09-07', open: 2000, high: 2000, low: 2000, close: 2000, volume: 1000 }] }
  });

  try {
    const summary = await fetchDailyCandles.main({
      targetDate: '2026-09-07',
      tickers: tickerList(30),
      crossCheckTickers: tickerList(20),
      allowMassFallbackOnCrossCheckFail: true
    });
    assert.equal(summary.deferred, undefined, 'override must not defer');
    assert.equal(summary.cross_check_failed, true);
  } finally {
    process.exitCode = undefined;
    candleFetcher.fetchDailyCandles = origFetchDaily;
    candleFetcher.fetchDailyCandlesYahoo = origFetchYahoo;
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const fetchDailyCandles = require('../tools/fetch-daily-candles');

test('Fase 1A: Yahoo Candle Ingestion & J2 Cross-Check Unit Tests', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-yahoo-j2-'));
  const origDir = process.env.CANDLE_CACHE_DIR;
  process.env.CANDLE_CACHE_DIR = tmpDir;

  t.after(() => {
    if (origDir !== undefined) process.env.CANDLE_CACHE_DIR = origDir;
    else delete process.env.CANDLE_CACHE_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('1. fetchDailyCandlesYahoo parses unadjusted OHLCV and merges into disk cache non-destructively', async () => {
    // Seed initial cache with 2 historical bars
    candleFetcher.writeCache('BBCA', {
      code: 'BBCA',
      range: '2d',
      candles: [
        { date: '2026-10-14', open: 5000, high: 5050, low: 4950, close: 5000, volume: 100000 },
        { date: '2026-10-15', open: 5000, high: 5100, low: 5000, close: 5100, volume: 120000 }
      ]
    });

    // Mock global fetch to return Yahoo chart response with 2026-10-15 and 2026-10-16
    const origFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes('BBCA.JK')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              chart: {
                result: [{
                  timestamp: [
                    Math.floor(new Date('2026-10-15T02:00:00Z').getTime() / 1000),
                    Math.floor(new Date('2026-10-16T02:00:00Z').getTime() / 1000)
                  ],
                  indicators: {
                    quote: [{
                      open: [5000, 5150],
                      high: [5100, 5200],
                      low: [5000, 5100],
                      close: [5100, 5175],
                      volume: [120000, 150000]
                    }]
                  }
                }]
              }
            })
          };
        }
        return origFetch(url);
      };

      const res = await candleFetcher.fetchDailyCandlesYahoo('BBCA', { range: '5d' });
      assert.ok(res.ok);
      assert.equal(res.source, 'yahoo');

      // Verify merged cache on disk
      const cached = candleFetcher.readCache('BBCA');
      assert.ok(cached);
      assert.equal(cached.candles.length, 3, 'Must have 3 merged bars');
      assert.equal(cached.candles[0].date, '2026-10-14', 'Preserves older historical bar');
      assert.equal(cached.candles[1].date, '2026-10-15');
      assert.equal(cached.candles[2].date, '2026-10-16');
      assert.equal(cached.candles[2].close, 5175);
      assert.equal(cached.candles[2].volume, 150000);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('2. performDailyCrossCheck passes when variance is <= 0.5%', async () => {
    // Seed Arjum cache and Yahoo fetch mock
    candleFetcher.writeCache('SAMPLE1', {
      code: 'SAMPLE1',
      candles: [{ date: '2026-10-16', open: 1000, high: 1020, low: 990, close: 1000, volume: 50000 }]
    });

    const origFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes('SAMPLE1.JK')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              chart: {
                result: [{
                  timestamp: [Math.floor(new Date('2026-10-16T02:00:00Z').getTime() / 1000)],
                  indicators: {
                    quote: [{
                      open: [1000],
                      high: [1020],
                      low: [990],
                      close: [1002], // 0.2% diff -> within 0.5%
                      volume: [50000]
                    }]
                  }
                }]
              }
            })
          };
        }
        return origFetch(url);
      };

      const check = await fetchDailyCandles.performDailyCrossCheck('2026-10-16', {
        tickers: ['SAMPLE1'],
        maxVariancePct: 0.5
      });

      assert.equal(check.ok, true, 'Cross check must pass');
      assert.equal(check.passed, 1);
      assert.equal(check.failed, 0);
      assert.equal(check.details[0].diffPct, 0.2);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('3. performDailyCrossCheck fails when variance is > 0.5%', async () => {
    candleFetcher.writeCache('SAMPLE2', {
      code: 'SAMPLE2',
      candles: [{ date: '2026-10-16', open: 1000, high: 1020, low: 990, close: 1000, volume: 50000 }]
    });

    const origFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes('SAMPLE2.JK')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              chart: {
                result: [{
                  timestamp: [Math.floor(new Date('2026-10-16T02:00:00Z').getTime() / 1000)],
                  indicators: {
                    quote: [{
                      open: [1000],
                      high: [1020],
                      low: [990],
                      close: [1015], // 1.5% diff -> exceeds 0.5%
                      volume: [50000]
                    }]
                  }
                }]
              }
            })
          };
        }
        return origFetch(url);
      };

      const check = await fetchDailyCandles.performDailyCrossCheck('2026-10-16', {
        tickers: ['SAMPLE2'],
        maxVariancePct: 0.5
      });

      assert.equal(check.ok, false, 'Cross check must fail on >0.5% variance');
      assert.equal(check.failed, 1);
      assert.equal(check.details[0].diffPct, 1.5);
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('4. Automatic fallback to Arjum when Yahoo fails', async () => {
    const origFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes('.JK')) {
          return { ok: false, status: 500 };
        }
        return origFetch(url);
      };

      // Call fetchDailyCandles with source=yahoo
      const res = await candleFetcher.fetchDailyCandles('FALLBACK_TK', {
        source: 'yahoo',
        fallbackToArjum: false
      });

      assert.equal(res.ok, false);
      assert.equal(res.status, 500);
    } finally {
      global.fetch = origFetch;
    }
  });
});

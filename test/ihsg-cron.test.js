'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const fetchDailyCandles = require('../tools/fetch-daily-candles');
const candleFetcher = require('../lib/chart-engine/candle-fetcher');

test('Langkah 2: fetch-daily-candles includes IHSG when IHSG_SYMBOL is set', async () => {
  const origSymbol = process.env.IHSG_SYMBOL;
  process.env.IHSG_SYMBOL = 'IHSG';

  try {
    const summary = await fetchDailyCandles.main({
      tickers: ['IHSG'],
      targetDate: '2026-10-19',
      dryRun: true
    });

    assert.equal(summary.universe, 1);
    assert.equal(summary.target_date, '2026-10-19');
    assert.equal(summary.stale, 1, 'IHSG must be identified as needing 1 fetch for new trading day');
    assert.equal(summary.skipped, undefined);
  } finally {
    if (origSymbol !== undefined) process.env.IHSG_SYMBOL = origSymbol;
    else delete process.env.IHSG_SYMBOL;
  }
});

test('Langkah 2: candleFetcher merges new bars without losing prior history', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-merge-candles-'));
  const origDir = process.env.CANDLE_CACHE_DIR;
  process.env.CANDLE_CACHE_DIR = tmpDir;

  try {
    // Initial file with 3 historical bars
    const initialPayload = {
      ticker: 'TESTIHSG',
      source: 'arjum',
      range: '3d',
      interval: 'daily',
      candles: [
        { date: '2026-10-14', open: 5000, high: 5050, low: 4950, close: 5000, volume: 1000 },
        { date: '2026-10-15', open: 5000, high: 5100, low: 5000, close: 5100, volume: 1200 },
        { date: '2026-10-16', open: 5100, high: 5200, low: 5050, close: 5185, volume: 1500 }
      ]
    };
    candleFetcher.writeCache('TESTIHSG', initialPayload);

    // Simulate new payload with updated 2026-10-16 and new 2026-10-19
    const newRemoteData = [
      { date: '2026-10-19', open: 5200, high: 5300, low: 5150, close: 5250, volume: 2000 },
      { date: '2026-10-16', open: 5100, high: 5200, low: 5050, close: 5190, volume: 1600 } // updated close
    ];

    const normalized = candleFetcher.normalizePayload('TESTIHSG', newRemoteData, 2);

    // Merge manually as done inside fetchDailyCandles
    const existing = candleFetcher.readCache('TESTIHSG');
    const map = new Map();
    for (const c of existing.candles) if (c && c.date) map.set(c.date, c);
    for (const c of normalized.candles) if (c && c.date) map.set(c.date, c);
    const merged = Array.from(map.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    normalized.candles = merged;
    candleFetcher.writeCache('TESTIHSG', normalized);

    const after = candleFetcher.readCache('TESTIHSG');
    assert.equal(after.candles.length, 4, 'must have 4 bars merged');
    assert.equal(after.candles[0].date, '2026-10-14', 'oldest bar preserved');
    assert.equal(after.candles[2].date, '2026-10-16');
    assert.equal(after.candles[2].close, 5190, 'updated bar overwritten cleanly');
    assert.equal(after.candles[3].date, '2026-10-19', 'new bar appended');
  } finally {
    if (origDir !== undefined) process.env.CANDLE_CACHE_DIR = origDir;
    else delete process.env.CANDLE_CACHE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

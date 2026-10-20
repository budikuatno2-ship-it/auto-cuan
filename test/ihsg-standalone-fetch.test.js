'use strict';

/**
 * B5 (2026-10-20): standalone IHSG benchmark fetch.
 *
 * The index bar must be obtainable independently of the 962-stock candle pass
 * and the tool must ALERT (not fail silently) when today's bar is still missing
 * at/after 17:30 WIB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const candleFetcher = require('../lib/chart-engine/candle-fetcher');
const ihsg = require('../tools/fetch-ihsg-candle');

function withCacheDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihsg-'));
  const orig = process.env.CANDLE_CACHE_DIR;
  process.env.CANDLE_CACHE_DIR = tmpDir;
  return Promise.resolve().then(() => fn(tmpDir)).finally(() => {
    if (orig !== undefined) process.env.CANDLE_CACHE_DIR = orig; else delete process.env.CANDLE_CACHE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

test('B5: fetches the IHSG bar and reports it present', async () => {
  await withCacheDir(async () => {
    const origFetch = candleFetcher.fetchDailyCandles;
    let calls = 0;
    candleFetcher.fetchDailyCandles = async (ticker, opts) => {
      calls++;
      assert.equal(ticker, 'IHSG');
      assert.equal(opts.force, true);
      candleFetcher.writeCache('IHSG', {
        code: 'IHSG',
        candles: [{ date: '2026-09-07', open: 100, high: 110, low: 99, close: 105, volume: 1000 }]
      });
      return { ok: true, data: { code: 'IHSG', candles: [] } };
    };
    try {
      const res = await ihsg.run({ argv: ['--date=2026-09-07'], now: new Date('2026-09-07T10:00:00Z') });
      assert.equal(res.fetched, true);
      assert.equal(res.has_bar, true);
      assert.equal(res.alert_required, false, 'no alert when the bar is present');
      assert.equal(calls, 1, 'exactly one Arjum request');
    } finally {
      candleFetcher.fetchDailyCandles = origFetch;
    }
  });
});

test('B5: alerts (exit 7) when the bar is still missing after 17:30 WIB', async () => {
  await withCacheDir(async () => {
    const origFetch = candleFetcher.fetchDailyCandles;
    candleFetcher.fetchDailyCandles = async () => ({ ok: false, status: 502, error: 'origin overloaded' });
    try {
      // 18:00 WIB = 11:00 UTC
      const res = await ihsg.run({ argv: ['--date=2026-09-07'], now: new Date('2026-09-07T11:00:00Z') });
      assert.equal(res.has_bar, false);
      assert.equal(res.alert_required, true, 'must alert after the 17:30 WIB window');
      assert.equal(res.fetch_error, 'origin overloaded');
      assert.equal(process.exitCode, 7, 'missing IHSG bar must exit non-zero');
    } finally {
      process.exitCode = undefined;
      candleFetcher.fetchDailyCandles = origFetch;
    }
  });
});

test('B5: no alert before the 17:30 WIB window', async () => {
  await withCacheDir(async () => {
    const origFetch = candleFetcher.fetchDailyCandles;
    candleFetcher.fetchDailyCandles = async () => ({ ok: false, status: 502, error: 'origin overloaded' });
    try {
      // 16:00 WIB = 09:00 UTC
      const res = await ihsg.run({ argv: ['--date=2026-09-07'], now: new Date('2026-09-07T09:00:00Z') });
      assert.equal(res.alert_required, false, 'must not alert before 17:30 WIB');
    } finally {
      process.exitCode = undefined;
      candleFetcher.fetchDailyCandles = origFetch;
    }
  });
});

test('B5: check-only mode performs no request', async () => {
  await withCacheDir(async () => {
    const origFetch = candleFetcher.fetchDailyCandles;
    let calls = 0;
    candleFetcher.fetchDailyCandles = async () => { calls++; return { ok: false, status: 500 }; };
    try {
      const res = await ihsg.run({ argv: ['--date=2026-09-07', '--check-only'], now: new Date('2026-09-07T11:00:00Z') });
      assert.equal(calls, 0, 'check-only must not spend quota');
      assert.equal(res.fetched, false);
    } finally {
      process.exitCode = undefined;
      candleFetcher.fetchDailyCandles = origFetch;
    }
  });
});

test('B5: an existing bar is not re-fetched', async () => {
  await withCacheDir(async () => {
    const origFetch = candleFetcher.fetchDailyCandles;
    let calls = 0;
    candleFetcher.writeCache('IHSG', {
      code: 'IHSG',
      candles: [{ date: '2026-09-07', open: 100, high: 110, low: 99, close: 105, volume: 1000 }]
    });
    candleFetcher.fetchDailyCandles = async () => { calls++; return { ok: false, status: 500 }; };
    try {
      const res = await ihsg.run({ argv: ['--date=2026-09-07'], now: new Date('2026-09-07T11:00:00Z') });
      assert.equal(calls, 0, 'must not re-fetch a bar that already exists');
      assert.equal(res.has_bar, true);
    } finally {
      process.exitCode = undefined;
      candleFetcher.fetchDailyCandles = origFetch;
    }
  });
});
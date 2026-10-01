'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fetcher = require('../lib/chart-engine/candle-fetcher');
const daily = require('../tools/fetch-daily-candles');
test('dated retries reuse an older complete candle and reject missing volume without inventing zero',async()=>{
 const read=fetcher.readCache,fetch=fetcher.fetchDailyCandles;let calls=0;
 let row={date:'2026-09-30',open:100,high:101,low:99,close:100,volume:0};
 fetcher.readCache=()=>({candles:[row,{...row,date:'2026-10-01'}]});
 fetcher.fetchDailyCandles=async()=>{calls++;return {ok:false,rateLimited:false}};
 try{
  const options={argv:['node','worker'],tickers:['BBCA'],targetDate:'2026-09-30',calendarClient:null};
  let result=await daily.main(options);assert.equal(result.cached,1);assert.equal(calls,0);
  for(const volume of [null,'']){row={...row,volume};result=await daily.main(options);assert.equal(result.failed,1);assert.equal(result.cached,0);}
  assert.equal(calls,2);
 }finally{fetcher.readCache=read;fetcher.fetchDailyCandles=fetch;}
});

test('daily candle worker does not count HTTP success when target-date candle is still missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-candle-freshness-'));
  const oldDir = process.env.CANDLE_CACHE_DIR;
  process.env.CANDLE_CACHE_DIR = dir;

  const originalFetch = fetcher.fetchDailyCandles;
  fetcher.fetchDailyCandles = async (ticker) => {
    fetcher.writeCache(ticker, {
      ticker,
      source: 'fixture',
      candles: [
        { date: '2026-09-30', open: 100, high: 101, low: 99, close: 100, volume: 1 }
      ]
    });
    return { ok: true, data: {}, from_cache: false, rateLimited: false, status: 200 };
  };

  try {
    const out = await daily.main({
      argv: ['node', 'fetch-daily-candles.js'],
      tickers: ['BBCA'],
      now: new Date('2026-10-01T11:30:00+07:00'),
      calendarClient: null
    });
    assert.equal(out.target_date, '2026-10-01');
    assert.equal(out.fetched, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.stale_after_fetch, 1);
  } finally {
    fetcher.fetchDailyCandles = originalFetch;
    if (oldDir == null) delete process.env.CANDLE_CACHE_DIR;
    else process.env.CANDLE_CACHE_DIR = oldDir;
  }
});

test('daily candle worker counts fresh only after cache reaches target date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-candle-current-'));
  const oldDir = process.env.CANDLE_CACHE_DIR;
  process.env.CANDLE_CACHE_DIR = dir;

  const originalFetch = fetcher.fetchDailyCandles;
  fetcher.fetchDailyCandles = async (ticker) => {
    fetcher.writeCache(ticker, {
      ticker,
      source: 'fixture',
      candles: [
        { date: '2026-10-01', open: 100, high: 101, low: 99, close: 100, volume: 1 }
      ]
    });
    return { ok: true, data: {}, from_cache: false, rateLimited: false, status: 200 };
  };

  try {
    const out = await daily.main({
      argv: ['node', 'fetch-daily-candles.js'],
      tickers: ['BBCA'],
      now: new Date('2026-10-01T11:30:00+07:00'),
      calendarClient: null
    });
    assert.equal(out.fetched, 1);
    assert.equal(out.failed, 0);
    assert.equal(out.stale_after_fetch, 0);
  } finally {
    fetcher.fetchDailyCandles = originalFetch;
    if (oldDir == null) delete process.env.CANDLE_CACHE_DIR;
    else process.env.CANDLE_CACHE_DIR = oldDir;
  }
});

test('daily candle worker skips known exchange holiday before spending quota', async () => {
  const out = await daily.main({
    argv: ['node', 'fetch-daily-candles.js'],
    tickers: ['BBCA'],
    now: new Date('2026-08-17T11:30:00+07:00'),
    calendarClient: null
  });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'MARKET_CLOSED');
});

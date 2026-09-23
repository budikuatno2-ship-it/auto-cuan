'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// We will require lib/backtest-engine.js
// Before implementation, this will fail or functions will be missing.
let backtestEngine;
try {
  backtestEngine = require('../lib/backtest-engine');
} catch (e) {
  // If module not found, define a stub so test runner starts and fails cleanly on assertions
  backtestEngine = null;
}

const daytradeEngine = require('../lib/daytrade-screener-engine');
const swingEngine = require('../lib/swing-screener-engine');

/**
 * Helper to generate synthetic daily candles
 * @param {number} count 
 * @param {object} baseCandle 
 * @param {string} startDate 
 */
function generateSyntheticCandles(count, baseCandle = {}, startDate = '2025-01-01') {
  const candles = [];
  let basePrice = baseCandle.close || 1000;
  const start = new Date(startDate);

  for (let i = 0; i < count; i++) {
    const curDate = new Date(start);
    curDate.setDate(start.getDate() + i);
    const dateStr = curDate.toISOString().slice(0, 10);
    const timeSec = Math.floor(curDate.getTime() / 1000);

    const open = Math.round(basePrice * (1 + (Math.sin(i) * 0.01)));
    const high = Math.round(open * 1.03);
    const low = Math.round(open * 0.98);
    const close = Math.round(open * 1.01);
    const volume = 2000000 + Math.round(Math.cos(i) * 500000);

    candles.push({
      time: timeSec,
      date: dateStr,
      open,
      high,
      low,
      close,
      volume,
      ...baseCandle
    });
    basePrice = close;
  }
  return candles;
}

test('Backtest Engine TDD Suite - 6 Kasus Wajib', async (t) => {
  assert.ok(backtestEngine, 'lib/backtest-engine.js must be implemented and exported');

  await t.test('a. Anti-look-ahead: data candle T+1 tidak boleh bocor ke evaluasi sinyal hari T', async () => {
    // Generate 35 candles
    const baseCandles = generateSyntheticCandles(35);
    const evalIndexT = 25;

    // Run backtest or signal evaluation at index T with real future
    const candlesNormal = JSON.parse(JSON.stringify(baseCandles));
    const signal1 = backtestEngine.evaluateSignalAtDay({
      ticker: 'TEST',
      candles: candlesNormal,
      dayIndex: evalIndexT,
      strategy: 'daytrade'
    });

    // Now corrupt candle T+1 with an extreme outlier (e.g., massive pump or crash)
    const candlesCorrupted = JSON.parse(JSON.stringify(baseCandles));
    candlesCorrupted[evalIndexT + 1].open = 999999;
    candlesCorrupted[evalIndexT + 1].high = 999999;
    candlesCorrupted[evalIndexT + 1].low = 1;
    candlesCorrupted[evalIndexT + 1].close = 999999;
    candlesCorrupted[evalIndexT + 1].volume = 999999999;

    const signal2 = backtestEngine.evaluateSignalAtDay({
      ticker: 'TEST',
      candles: candlesCorrupted,
      dayIndex: evalIndexT,
      strategy: 'daytrade'
    });

    // Signal at day T must be completely identical regardless of changes in T+1
    assert.deepEqual(signal1, signal2, 'Signal at day T must not be affected by candle T+1 or future candles');
  });

  await t.test('b. Entry price: harga entry harus persis sama dengan Open candle T+1', async () => {
    const candles = generateSyntheticCandles(40);
    const evalIndexT = 25;
    // Set a known open price for candle T+1
    const expectedOpenT1 = 1575;
    candles[evalIndexT + 1].open = expectedOpenT1;

    // Simulate trade execution for signal generated at day T
    const trade = backtestEngine.simulateTradeExecution({
      ticker: 'TEST',
      candles,
      signalIndex: evalIndexT,
      strategy: 'daytrade',
      signal: {
        ticker: 'TEST',
        signal: 'BUY',
        score: 85,
        stop_loss: 1400,
        tp1: 1750,
        tp2: 1900
      }
    });

    assert.ok(trade, 'Trade must be simulated');
    assert.equal(trade.entry_price, expectedOpenT1, 'Entry price must strictly equal Open of candle T+1');
    assert.notEqual(trade.entry_price, candles[evalIndexT].close, 'Entry price must NOT use Close of candle T');
  });

  await t.test('c. Urutan TP/SL: hari yang sama kena TP dan SL, pastikan fallback konservatif (SL_HIT)', async () => {
    const candles = generateSyntheticCandles(35);
    const evalIndexT = 25;
    const entryPrice = 1000;
    const sl = 950;
    const tp = 1100;

    // Candle T+1 Open = entryPrice
    candles[evalIndexT + 1].open = entryPrice;
    candles[evalIndexT + 1].high = 1050;
    candles[evalIndexT + 1].low = 980;
    candles[evalIndexT + 1].close = 1010;

    // Candle T+2 swings wild: hits BOTH TP (1100) and SL (950)
    candles[evalIndexT + 2].open = 1000;
    candles[evalIndexT + 2].high = 1150; // hits TP (1150 >= 1100)
    candles[evalIndexT + 2].low = 920;  // hits SL (920 <= 950)
    candles[evalIndexT + 2].close = 1120;

    const trade = backtestEngine.simulateTradeExecution({
      ticker: 'TEST',
      candles,
      signalIndex: evalIndexT,
      strategy: 'daytrade',
      signal: {
        ticker: 'TEST',
        signal: 'BUY',
        score: 80,
        stop_loss: sl,
        tp1: tp
      }
    });

    assert.ok(trade, 'Trade must be returned');
    assert.equal(trade.outcome, 'SL_HIT', 'When both TP and SL are touched on the same candle, conservative rule dictates SL_HIT');
    assert.equal(trade.exit_price, sl, 'Exit price must be the SL price');
  });

  await t.test('d. Spy/mock reuse kode scoring: pastikan fungsi scoring live benar-benar dipanggil', async () => {
    let daytradeScoringCalled = false;
    let swingScoringCalled = false;

    // Temporarily wrap or spy live functions
    const origAnalyzeDayTrade = daytradeEngine.analyzeDayTrade;
    const origVerifySwing = swingEngine.verifySwingHighConviction;

    try {
      daytradeEngine.analyzeDayTrade = function(...args) {
        daytradeScoringCalled = true;
        return origAnalyzeDayTrade.apply(this, args);
      };

      swingEngine.verifySwingHighConviction = function(...args) {
        swingScoringCalled = true;
        return origVerifySwing.apply(this, args);
      };

      const candles = generateSyntheticCandles(30);

      // Run daytrade backtest slice
      backtestEngine.evaluateSignalAtDay({
        ticker: 'TEST_DT',
        candles,
        dayIndex: 25,
        strategy: 'daytrade'
      });
      assert.equal(daytradeScoringCalled, true, 'Live analyzeDayTrade / scoreDayTrade must be called directly');

      // Run swing backtest slice
      backtestEngine.evaluateSignalAtDay({
        ticker: 'TEST_SWING',
        candles,
        dayIndex: 25,
        strategy: 'swing'
      });
      assert.equal(swingScoringCalled, true, 'Live verifySwingHighConviction must be called directly');
    } finally {
      // Restore originals
      daytradeEngine.analyzeDayTrade = origAnalyzeDayTrade;
      swingEngine.verifySwingHighConviction = origVerifySwing;
    }
  });

  await t.test('e. In-sample / Out-of-sample split: verifikasi rasio 70/30 dan rentang tanggal tidak overlap', async () => {
    const dates = [];
    for (let i = 1; i <= 100; i++) {
      const d = new Date('2025-01-01');
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const split = backtestEngine.splitWalkForward(dates, 0.7);
    assert.ok(split.inSample, 'inSample partition must exist');
    assert.ok(split.outOfSample, 'outOfSample partition must exist');

    assert.equal(split.inSample.length, 70, 'In-sample count should be 70% of 100');
    assert.equal(split.outOfSample.length, 30, 'Out-of-sample count should be 30% of 100');

    const maxInSampleDate = split.inSample[split.inSample.length - 1];
    const minOutOfSampleDate = split.outOfSample[0];

    assert.ok(
      maxInSampleDate < minOutOfSampleDate,
      `In-sample max date (${maxInSampleDate}) must be strictly earlier than Out-of-sample min date (${minOutOfSampleDate})`
    );

    // Verify set intersection is completely empty
    const inSet = new Set(split.inSample);
    for (const d of split.outOfSample) {
      assert.equal(inSet.has(d), false, `Date ${d} must not appear in both In-Sample and Out-of-Sample`);
    }
  });

  await t.test('f. Flag sample size: assert munculnya flag warning saat sampel N < 30', async () => {
    const smallTrades = [
      { pnl_pct: 2.5, r_multiple: 1.2, outcome: 'TP_HIT', holding_days: 2 },
      { pnl_pct: -1.5, r_multiple: -1.0, outcome: 'SL_HIT', holding_days: 1 }
    ];

    const smallMetrics = backtestEngine.computeMetrics(smallTrades);
    assert.equal(smallMetrics.sample_size, 2);
    assert.ok(
      smallMetrics.warning === 'SAMPLE_TOO_SMALL' ||
      (Array.isArray(smallMetrics.flags) && smallMetrics.flags.includes('SAMPLE_TOO_SMALL')) ||
      smallMetrics.sample_size_warning === 'SAMPLE_TOO_SMALL',
      'SAMPLE_TOO_SMALL warning flag must be present when N < 30'
    );

    // Now test with N = 35 trades
    const sufficientTrades = [];
    for (let i = 0; i < 35; i++) {
      sufficientTrades.push({
        pnl_pct: i % 2 === 0 ? 3.0 : -1.5,
        r_multiple: i % 2 === 0 ? 1.5 : -1.0,
        outcome: i % 2 === 0 ? 'TP_HIT' : 'SL_HIT',
        holding_days: 2
      });
    }

    const sufficientMetrics = backtestEngine.computeMetrics(sufficientTrades);
    assert.equal(sufficientMetrics.sample_size, 35);
    const hasSmallWarning =
      sufficientMetrics.warning === 'SAMPLE_TOO_SMALL' ||
      (Array.isArray(sufficientMetrics.flags) && sufficientMetrics.flags.includes('SAMPLE_TOO_SMALL')) ||
      sufficientMetrics.sample_size_warning === 'SAMPLE_TOO_SMALL';
    assert.equal(hasSmallWarning, false, 'SAMPLE_TOO_SMALL warning flag must NOT be present when N >= 30');
  });
});

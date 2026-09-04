'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const candleEngine = require('../lib/candle-pattern-engine');
const dtEngine = require('../lib/daytrade-screener-engine');

test('BUG-042: red candle with long lower shadow at support is classified as Hammer (bullish), not Hanging Man', () => {
  // Red candle: open 1010, high 1012, low 950, close 1000
  // range = 62, body = 10, bodyRatio = 10/62 = 0.161 (>= 0.1 && < 0.4)
  // upperShadow = 2 (upperR = 2/62 = 0.032 < 0.15)
  // lowerShadow = 50 (>= 2 * body = 20)
  // c0.close (1000) < c0.open (1010) -> red candle
  const redHammer = { open: 1010, high: 1012, low: 950, close: 1000, volume: 100000 };
  const priorCandle = { open: 1020, high: 1025, low: 1005, close: 1010, volume: 80000 };
  const candles = [priorCandle, redHammer];

  // At support 990 (lastPrice 1000 <= 990 * 1.03 = 1019.7)
  const ctxAtSupport = {
    support: 990,
    resistance: 1100,
    lastPrice: 1000,
    changePct: -0.5
  };

  const result = candleEngine.detectPattern(candles, ctxAtSupport);
  assert.equal(result.pattern, 'Hammer', 'Red hammer at support should be named Hammer, not Hanging Man');
  assert.equal(result.bias, 'Bullish');
});

test('BUG-042: red candle with long lower shadow in an extended uptrend is still classified as Hanging Man (bearish)', () => {
  const redHangingMan = { open: 1210, high: 1212, low: 1150, close: 1200, volume: 100000 };
  const priorCandle = { open: 1150, high: 1190, low: 1140, close: 1180, volume: 80000 };
  const candles = [priorCandle, redHangingMan];

  // Far above support 1000, strong uptrend +5%
  const ctxUptrend = {
    support: 1000,
    resistance: 1250,
    lastPrice: 1200,
    changePct: 5.0
  };

  const result = candleEngine.detectPattern(candles, ctxUptrend);
  assert.equal(result.pattern, 'Hanging Man', 'Red hanging man in extended uptrend should remain Hanging Man');
  assert.equal(result.bias, 'Bearish');
});

test('BUG-042: green candle with long lower shadow is always classified as Hammer (bullish)', () => {
  // Green hammer: open 1000, high 1012, low 950, close 1010
  // range = 62, body = 10, bodyRatio = 0.161
  const greenHammer = { open: 1000, high: 1012, low: 950, close: 1010, volume: 100000 };
  const candles = [greenHammer];

  const result = candleEngine.detectPattern(candles, {});
  assert.equal(result.pattern, 'Hammer');
  assert.equal(result.bias, 'Bullish');
});

test('BUG-042: red inverted hammer at support is classified as Inverted Hammer, not Shooting Star', () => {
  // Red inverted hammer: open 1010, high 1060, low 998, close 1000
  // range = 62, body = 10, bodyRatio = 0.161
  // upperShadow = high - open = 1060 - 1010 = 50 (>= 2 * body = 20)
  // lowerShadow = close - low = 1000 - 998 = 2 (lowerR = 2/62 = 0.032 < 0.15)
  const redInvHammer = { open: 1010, high: 1060, low: 998, close: 1000, volume: 100000 };
  const candles = [redInvHammer];

  const ctxAtSupport = {
    support: 990,
    lastPrice: 1000,
    changePct: -1.0
  };

  const result = candleEngine.detectPattern(candles, ctxAtSupport);
  assert.equal(result.pattern, 'Inverted Hammer');
  assert.equal(result.bias, 'Bullish');
});

test('BUG-042: Day Trade screener engine does not penalize red hammer at support as Hanging Man', () => {
  const redHammer = { open: 1010, high: 1012, low: 950, close: 1000, volume: 100000 };
  const candles = [
    { open: 1020, high: 1025, low: 1005, close: 1010, volume: 80000 },
    redHammer
  ];
  const candleCtx = {
    support: 990,
    lastPrice: 1000,
    changePct: -0.5
  };
  const candleResult = candleEngine.detectPattern(candles, candleCtx);

  const data = {
    ticker: 'TEST',
    last_price: 1000,
    support: 990,
    resistance: 1080,
    change_pct: -0.5,
    volume_ratio_20d: 1.5,
    risk_reward: 2.0,
    breakout_price: 1020,
    distance_to_breakout_pct: 2.0,
    _priceAboveOpen: true
  };

  const scored = dtEngine.scoreDayTrade(data, 'NORMAL', 'REGULER', candleResult);
  assert.ok(scored.candle_score >= 0, 'candle score should not be negative for hammer at support, got ' + scored.candle_score);
});

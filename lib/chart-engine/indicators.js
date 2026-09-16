'use strict';

/**
 * Chart Engine — Indicators
 *
 * Pure OHLCV math for the Swing trend classifier. No I/O, no network.
 * Consumed by lib/chart-engine/candle-fetcher.js and the Swing screener path.
 */

/**
 * Exponential moving average over a close series.
 * @param {number[]} closes oldest-first
 * @param {number} period
 * @returns {number|null} last EMA value
 */
function ema(closes, period) {
  if (!Array.isArray(closes) || closes.length < period || period <= 0) return null;
  var k = 2 / (period + 1);
  var value = Number(closes[0]);
  for (var i = 1; i < closes.length; i += 1) {
    var c = Number(closes[i]);
    if (!Number.isFinite(c)) return null;
    value = c * k + value * (1 - k);
  }
  return value;
}

/**
 * Full EMA series aligned to the input length (oldest-first, nulls until warm).
 * @param {number[]} closes
 * @param {number} period
 * @returns {Array<number|null>}
 */
function emaSeries(closes, period) {
  if (!Array.isArray(closes) || period <= 0) return [];
  var k = 2 / (period + 1);
  var out = [];
  var prev = null;
  for (var i = 0; i < closes.length; i += 1) {
    var c = Number(closes[i]);
    if (!Number.isFinite(c)) { out.push(null); continue; }
    prev = prev == null ? c : (c * k + prev * (1 - k));
    out.push(i + 1 >= period ? prev : null);
  }
  return out;
}

/**
 * Simple confirmed pivot highs/lows over the last `window` candles.
 * A pivot is confirmed only when strictly above/below both neighbors.
 * @param {Array<{high:number,low:number}>} candles
 * @param {number} window
 * @returns {{highs:number[], lows:number[]}}
 */
function pivotSwing(candles, window) {
  var slice = Array.isArray(candles) ? candles.slice(-(window || 20)) : [];
  var highs = [], lows = [];
  for (var i = 1; i < slice.length - 1; i += 1) {
    var prev = slice[i - 1], cur = slice[i], next = slice[i + 1];
    if (Number(cur.high) > Number(prev.high) && Number(cur.high) >= Number(next.high)) highs.push(Number(cur.high));
    if (Number(cur.low) < Number(prev.low) && Number(cur.low) <= Number(next.low)) lows.push(Number(cur.low));
  }
  return { highs: highs, lows: lows };
}

/**
 * Classify swing structure from daily OHLCV candles.
 * Uses EMA20/EMA50 plus simple confirmed highs/lows in the last 20 candles.
 * @param {Array<{open,high,low,close,volume}>} candles oldest-first
 * @returns {{status:string, close:number|null, ema20:number|null, ema50:number|null, higher_high:boolean, higher_low:boolean}}
 */
function classifySwingTrend(candles) {
  if (!Array.isArray(candles) || candles.length < 50) {
    return { status: 'INSUFFICIENT_DATA', close: null, ema20: null, ema50: null, higher_high: false, higher_low: false };
  }
  var closes = candles.map(function (c) { return Number(c && c.close); });
  if (closes.some(function (v) { return !Number.isFinite(v) || v <= 0; })) {
    return { status: 'INVALID_DATA', close: null, ema20: null, ema50: null, higher_high: false, higher_low: false };
  }
  var ema20 = ema(closes, 20);
  var ema50 = ema(closes, 50);
  var swings = pivotSwing(candles, 20);
  var higherHigh = swings.highs.length >= 2 && swings.highs[swings.highs.length - 1] > swings.highs[swings.highs.length - 2];
  var higherLow = swings.lows.length >= 2 && swings.lows[swings.lows.length - 1] > swings.lows[swings.lows.length - 2];
  var close = closes[closes.length - 1];
  var status = (close > ema20 && ema20 > ema50 && higherLow) ? 'UPTREND' : (close < ema50 ? 'DOWNTREND' : 'SIDEWAYS');
  return { status: status, close: close, ema20: ema20, ema50: ema50, higher_high: higherHigh, higher_low: higherLow };
}

module.exports = { ema, emaSeries, pivotSwing, classifySwingTrend };

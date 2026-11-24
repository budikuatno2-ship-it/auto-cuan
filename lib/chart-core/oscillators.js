'use strict';

// F1 core detector: standard oscillators — RSI(14), MACD(12,26,9), OBV.
// Pure, deterministic, standard formulas. Insufficient period => null (never 0).
// OBV volume units are preserved exactly as provided (shares for IDX daily
// OHLCV from the provider; NOT converted to lots).

const VERSION = 'chart-core-oscillators-v1';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Wilder RSI.
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {(number|null)[]} aligned to input; null until enough data.
 */
function rsi(closes, period) {
  var p = isNum(period) ? Math.max(1, Math.floor(period)) : 14;
  var out = new Array(Array.isArray(closes) ? closes.length : 0).fill(null);
  if (!Array.isArray(closes) || closes.length < p + 1) return out;

  var gains = 0, losses = 0;
  for (var i = 1; i <= p; i += 1) {
    var d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  var avgGain = gains / p;
  var avgLoss = losses / p;
  out[p] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (var t = p + 1; t < closes.length; t += 1) {
    var delta = closes[t] - closes[t - 1];
    var g = delta > 0 ? delta : 0;
    var l = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[t] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function emaSeries(values, period) {
  var out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  var sum = 0;
  for (var i = 0; i < period; i += 1) sum += values[i];
  var prev = sum / period;
  out[period - 1] = prev;
  var mult = 2 / (period + 1);
  for (var t = period; t < values.length; t += 1) {
    prev = (values[t] - prev) * mult + prev;
    out[t] = prev;
  }
  return out;
}

/**
 * MACD(12,26,9): EMA12 - EMA26, signal = EMA9 of MACD line, hist = macd - signal.
 * @returns {{macd:(number|null)[], signal:(number|null)[], histogram:(number|null)[]}}
 */
function macd(closes, fastPeriod, slowPeriod, signalPeriod) {
  var fast = isNum(fastPeriod) ? fastPeriod : 12;
  var slow = isNum(slowPeriod) ? slowPeriod : 26;
  var sig = isNum(signalPeriod) ? signalPeriod : 9;
  var n = Array.isArray(closes) ? closes.length : 0;
  var macdLine = new Array(n).fill(null);
  var signalLine = new Array(n).fill(null);
  var histogram = new Array(n).fill(null);
  if (n < slow) return { macd: macdLine, signal: signalLine, histogram: histogram };

  var emaFast = emaSeries(closes, fast);
  var emaSlow = emaSeries(closes, slow);
  var raw = [];
  var firstIdx = slow - 1;
  for (var i = firstIdx; i < n; i += 1) raw.push(emaFast[i] - emaSlow[i]);

  var sigRaw = emaSeries(raw, sig);
  for (var j = 0; j < raw.length; j += 1) {
    var idx = firstIdx + j;
    macdLine[idx] = raw[j];
    if (sigRaw[j] != null) {
      signalLine[idx] = sigRaw[j];
      histogram[idx] = raw[j] - sigRaw[j];
    }
  }
  return { macd: macdLine, signal: signalLine, histogram: histogram };
}

/**
 * On-Balance Volume. Volume units preserved as given (shares for IDX daily data).
 * @param {Array<{close:number, volume:number}>} bars
 * @returns {(number|null)[]} null for the first bar (no prior close).
 */
function obv(bars) {
  var arr = Array.isArray(bars) ? bars : [];
  var out = new Array(arr.length).fill(null);
  if (arr.length === 0) return out;
  var running = 0;
  for (var i = 1; i < arr.length; i += 1) {
    var prev = arr[i - 1], cur = arr[i];
    if (!isNum(cur.close) || !isNum(prev.close) || !isNum(cur.volume)) { out[i] = null; continue; }
    if (cur.close > prev.close) running += cur.volume;
    else if (cur.close < prev.close) running -= cur.volume;
    out[i] = running;
  }
  return out;
}

module.exports = { VERSION: VERSION, rsi: rsi, macd: macd, obv: obv, emaSeries: emaSeries };

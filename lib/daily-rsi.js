/**
 * Daily RSI (Wilder-style) — computed from trading-session closes only.
 *
 * Standard Wilder RSI14:
 *   1. delta[i] = close[i] - close[i-1] for each consecutive pair
 *   2. gain[i] = max(delta[i], 0); loss[i] = max(-delta[i], 0)
 *   3. First avgGain/avgLoss = simple mean of the first `period` gains/losses
 *   4. Subsequent avgGain/avgLoss = Wilder smoothing:
 *        avgGain = (prevAvgGain * (period - 1) + gain) / period
 *   5. RS = avgGain / avgLoss; RSI = 100 - (100 / (1 + RS))
 *      RSI = 100 when avgLoss is 0 and avgGain > 0; RSI = 50 when both are 0.
 *
 * Input MUST be an ordered array of trading-session closes only (oldest
 * first). Callers are responsible for excluding weekends/holidays before
 * calling this — this module does not know about the calendar.
 */

'use strict';

const { RSI_PERIOD, RSI_OVERSOLD_MAX, RSI_OVERBOUGHT_MIN } = require('./daily-market-context-constants');

function rsiState(rsi, options) {
  options = options || {};
  var oversoldMax = options.oversoldMax != null ? options.oversoldMax : RSI_OVERSOLD_MAX;
  var overboughtMin = options.overboughtMin != null ? options.overboughtMin : RSI_OVERBOUGHT_MIN;
  if (rsi == null || !Number.isFinite(rsi)) return null;
  if (rsi < oversoldMax) return 'OVERSOLD';
  if (rsi > overboughtMin) return 'OVERBOUGHT';
  return 'NEUTRAL';
}

/**
 * Compute the full Wilder RSI series for a close-price array.
 * Returns an array the same length as `closes`, with `null` for indices
 * that don't yet have enough history (< period + 1 closes).
 */
function computeRsiSeries(closes, period) {
  period = period || RSI_PERIOD;
  var series = new Array(closes.length).fill(null);
  if (!Array.isArray(closes) || closes.length < period + 1) return series;

  var gains = [];
  var losses = [];
  for (var i = 1; i < closes.length; i++) {
    var delta = closes[i] - closes[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }

  var avgGain = 0;
  var avgLoss = 0;
  for (var j = 0; j < period; j++) {
    avgGain += gains[j];
    avgLoss += losses[j];
  }
  avgGain /= period;
  avgLoss /= period;

  series[period] = rsiFromAverages(avgGain, avgLoss);

  for (var k = period; k < gains.length; k++) {
    avgGain = (avgGain * (period - 1) + gains[k]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[k]) / period;
    series[k + 1] = rsiFromAverages(avgGain, avgLoss);
  }

  return series;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Compute the latest RSI value + state for a close-price array (oldest
 * first). Returns { rsi_14, rsi_state, as_of_trade_date, insufficient_history }.
 * `tradeDates` (optional) must be the same length as `closes`, used only to
 * label the as_of date.
 */
function computeLatestRsi(closes, tradeDates, options) {
  options = options || {};
  var period = options.period || RSI_PERIOD;

  if (!Array.isArray(closes) || closes.length < period + 1) {
    return {
      rsi_14: null,
      rsi_state: null,
      as_of_trade_date: tradeDates && tradeDates.length ? tradeDates[tradeDates.length - 1] : null,
      insufficient_history: true,
      history_length: Array.isArray(closes) ? closes.length : 0,
      required_length: period + 1
    };
  }

  var series = computeRsiSeries(closes, period);
  var latest = series[series.length - 1];
  var rounded = latest == null ? null : Math.round(latest * 100) / 100;

  return {
    rsi_14: rounded,
    rsi_state: rsiState(rounded, options),
    as_of_trade_date: tradeDates && tradeDates.length ? tradeDates[tradeDates.length - 1] : null,
    insufficient_history: false,
    history_length: closes.length,
    required_length: period + 1
  };
}

module.exports = {
  computeRsiSeries,
  computeLatestRsi,
  rsiState,
  RSI_PERIOD
};

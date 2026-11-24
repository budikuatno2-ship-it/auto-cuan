'use strict';

// F1 core detector: confirmed swing pivots (fractal-based, configurable lookback k).
// A pivot high at bar i is CONFIRMED only after k bars have closed on the right
// side (bars i+1..i+k all have high < pivot high). No lookahead: detection at
// bar t only uses data up to t.

const VERSION = 'chart-core-pivots-v1';

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizeSeries(series) {
  return (Array.isArray(series) ? series : []).map(function (bar, index) {
    if (!bar || typeof bar !== 'object') return null;
    var high = isNum(bar.high) ? bar.high : (isNum(bar.price) ? bar.price : null);
    var low = isNum(bar.low) ? bar.low : (isNum(bar.price) ? bar.price : null);
    if (high == null || low == null) return null;
    return {
      index: index,
      time: bar.time !== undefined ? bar.time : (bar.date !== undefined ? bar.date : index),
      high: high,
      low: low
    };
  }).filter(Boolean);
}

/**
 * Detect confirmed swing pivots.
 * @param {Array<{high:number, low:number, time?:any}>} series
 * @param {object} [options]
 * @param {number} [options.k=3] lookback bars required on each side to confirm.
 * @returns {Array<{index:number, time:any, price:number, type:'high'|'low', confirmed_at_index:number}>}
 */
function detectPivots(series, options) {
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var bars = normalizeSeries(series);
  var out = [];
  if (bars.length < 2 * k + 1) return out;

  for (var i = k; i < bars.length - k; i += 1) {
    var bar = bars[i];
    var isHigh = true;
    var isLow = true;
    for (var j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (bars[j].high >= bar.high) isHigh = false;
      if (bars[j].low <= bar.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    // Flat/equal highs: strict inequality above rejects ties, so a pivot is
    // only emitted when strictly extreme within the window.
    if (isHigh) {
      out.push({ index: i, time: bar.time, price: bar.high, type: 'high', confirmed_at_index: i + k });
    }
    if (isLow) {
      out.push({ index: i, time: bar.time, price: bar.low, type: 'low', confirmed_at_index: i + k });
    }
  }
  return out;
}

/**
 * Lookahead guard helper: given full data, return pivots that would be known
 * as of bar `asOfIndex` (inclusive). A pivot at i is known only when
 * confirmed_at_index <= asOfIndex.
 */
function pivotsAsOf(series, asOfIndex, options) {
  var all = detectPivots(series, options);
  return all.filter(function (p) { return p.confirmed_at_index <= asOfIndex; });
}

module.exports = { VERSION: VERSION, detectPivots: detectPivots, pivotsAsOf: pivotsAsOf };

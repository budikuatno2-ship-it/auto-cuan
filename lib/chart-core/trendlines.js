'use strict';

// F1 core detector: auto trendlines and channels from confirmed pivots.
// Resistance line connects >=2 pivot highs; support line connects >=2 pivot
// lows. Channel = parallel support + resistance. Lines through noise are
// rejected via slope sanity and max-deviation validation.

const VERSION = 'chart-core-trendlines-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function lineFromPoints(p1, p2) {
  var dx = p2.index - p1.index;
  var slope = dx === 0 ? 0 : (p2.price - p1.price) / dx;
  return { slope: slope, intercept: p1.price - slope * p1.index, p1: p1, p2: p2 };
}

function lineValueAt(line, index) {
  return line.slope * index + line.intercept;
}

/**
 * Build candidate lines from pivots of one type, validate touches.
 * A pivot "touches" the line if |price - lineValue| <= tolerance.
 * @returns {Array<{type:'resistance'|'support', slope, intercept, touches, touch_indices, p1, p2}>}
 */
function buildLines(pivots, type, bars, options) {
  var minTouches = options && isNum(options.minTouches) ? Math.max(2, options.minTouches) : 2;
  var maxSlopePct = options && isNum(options.maxSlopePct) ? options.maxSlopePct : 10;
  var tolPct = options && isNum(options.tolerancePct) ? options.tolerancePct : 0.5;
  var out = [];

  for (var i = 0; i < pivots.length; i += 1) {
    for (var j = i + 1; j < pivots.length; j += 1) {
      var a = pivots[i], b = pivots[j];
      if (b.index === a.index) continue;
      var line = lineFromPoints(a, b);
      // Slope sanity: |slope| as % of mean price per bar.
      var meanPrice = (a.price + b.price) / 2;
      if (meanPrice <= 0) continue;
      var slopePct = Math.abs(line.slope) / meanPrice * 100;
      if (slopePct > maxSlopePct) continue;

      var tol = tolPct / 100 * meanPrice;
      var touchIndices = [];
      for (var t = 0; t < pivots.length; t += 1) {
        var pv = pivots[t];
        if (Math.abs(pv.price - lineValueAt(line, pv.index)) <= tol) touchIndices.push(pv.index);
      }
      if (touchIndices.length < minTouches) continue;
      out.push({
        type: type,
        slope: line.slope,
        intercept: line.intercept,
        touches: touchIndices.length,
        touch_indices: touchIndices,
        p1: { index: a.index, price: a.price },
        p2: { index: b.index, price: b.price }
      });
    }
  }
  // Deduplicate by (slope, intercept) rounded; keep max touches.
  var seen = {};
  out.sort(function (x, y) { return y.touches - x.touches; });
  return out.filter(function (l) {
    var key = l.type + ':' + l.slope.toFixed(6) + ':' + l.intercept.toFixed(6);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

/**
 * Detect trendlines and channels.
 * @param {Array<{high:number, low:number, time?:any}>} series
 * @param {object} [options] { k, minTouches, maxSlopePct, tolerancePct }
 * @returns {{resistance:Array, support:Array, channels:Array}}
 *          channel: {resistance, support, parallel:true, width_at_last}
 */
function detectTrendlines(series, options) {
  var bars = (Array.isArray(series) ? series : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  if (bars.length === 0) return { resistance: [], support: [], channels: [] };

  var highs = detectPivots(bars, { k: options && options.k }).filter(function (p) { return p.type === 'high'; });
  var lows = detectPivots(bars, { k: options && options.k }).filter(function (p) { return p.type === 'low'; });

  var resistance = buildLines(highs, 'resistance', bars, options);
  var support = buildLines(lows, 'support', bars, options);

  // Channels: pair a resistance and support line with near-parallel slopes.
  var channels = [];
  var lastIdx = bars.length - 1;
  for (var r = 0; r < resistance.length; r += 1) {
    for (var s = 0; s < support.length; s += 1) {
      var rl = resistance[r], sl = support[s];
      var meanPrice = (lineValueAt(rl, lastIdx) + lineValueAt(sl, lastIdx)) / 2;
      if (meanPrice <= 0) continue;
      var slopeDiff = Math.abs(rl.slope - sl.slope) / meanPrice * 100;
      if (slopeDiff <= (options && isNum(options.channelSlopeTolerancePct) ? options.channelSlopeTolerancePct : 1)) {
        channels.push({
          resistance: rl,
          support: sl,
          parallel: true,
          width_at_last: lineValueAt(rl, lastIdx) - lineValueAt(sl, lastIdx)
        });
      }
    }
  }
  return { resistance: resistance, support: support, channels: channels };
}

module.exports = {
  VERSION: VERSION,
  detectTrendlines: detectTrendlines,
  lineFromPoints: lineFromPoints,
  lineValueAt: lineValueAt
};

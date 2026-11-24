'use strict';

// F1 core detector: support/resistance clustering from confirmed pivots.
// Cluster pivot prices within tolerance (ATR-based or %), rank by touch count
// + recency. Output zones: {price_low, price_high, touches, last_touch_index, strength}.

const VERSION = 'chart-core-support-resistance-v1';
const { detectPivots } = require('./pivots');
const { atrOf } = require('./zigzag');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function resolveTolerance(bars, options) {
  var mode = options && options.mode === 'atr' ? 'atr' : 'percent';
  if (mode === 'atr') {
    var atr = atrOf(bars, options && options.atrPeriod);
    var mult = isNum(options && options.atrMultiplier) ? options.atrMultiplier : 0.5;
    if (atr != null && atr > 0) return { value: atr * mult, mode: 'atr' };
    return { value: 0, mode: 'atr' };
  }
  var pct = isNum(options && options.percent) ? options.percent : 1;
  return { value: pct / 100, mode: 'percent' };
}

/**
 * Cluster pivots into S/R zones.
 * @param {Array<{high:number, low:number, close?:number, time?:any}>} series
 * @param {object} [options] { k, mode, percent, atrPeriod, atrMultiplier, minTouches }
 * @returns {Array<{price_low, price_high, touches, last_touch_index, strength}>}
 *          strength: 1..5 ranked by touch count then recency.
 */
function detectSupportResistance(series, options) {
  var bars = (Array.isArray(series) ? series : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  if (bars.length === 0) return [];

  var pivots = detectPivots(bars, { k: options && options.k });
  if (pivots.length === 0) return [];

  var tol = resolveTolerance(bars, options);
  var minTouches = options && isNum(options.minTouches) ? Math.max(1, options.minTouches) : 1;

  // Sort pivot prices ascending, single-pass clustering.
  var sorted = pivots.slice().sort(function (a, b) { return a.price - b.price; });
  var clusters = [];
  var current = [sorted[0]];
  for (var i = 1; i < sorted.length; i += 1) {
    var anchor = current[0].price;
    var dev = tol.mode === 'percent'
      ? Math.abs(sorted[i].price - anchor) / anchor
      : Math.abs(sorted[i].price - anchor);
    if (dev <= tol.value) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  var zones = clusters.map(function (cluster) {
    var prices = cluster.map(function (p) { return p.price; });
    var lastTouch = cluster.reduce(function (m, p) { return Math.max(m, p.confirmed_at_index); }, 0);
    return {
      price_low: Math.min.apply(null, prices),
      price_high: Math.max.apply(null, prices),
      touches: cluster.length,
      last_touch_index: lastTouch,
      strength: 0
    };
  }).filter(function (z) { return z.touches >= minTouches; });

  // Rank: touch count (weight 2) + recency (weight 1, normalized by max index).
  var maxIdx = zones.reduce(function (m, z) { return Math.max(m, z.last_touch_index); }, 1);
  zones.forEach(function (z) {
    var recency = z.last_touch_index / maxIdx;
    var raw = (z.touches * 2 + recency * 3) / (Math.max.apply(null, zones.map(function (x) { return x.touches; })) * 2 + 3);
    z.strength = Math.max(1, Math.min(5, Math.ceil(raw * 5)));
  });

  zones.sort(function (a, b) { return b.touches - a.touches || b.last_touch_index - a.last_touch_index; });
  return zones;
}

module.exports = { VERSION: VERSION, detectSupportResistance: detectSupportResistance };

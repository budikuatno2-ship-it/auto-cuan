'use strict';

// F1 core detector: ZigZag built from confirmed pivots with configurable
// deviation threshold (% or ATR-based). Time-price anchored legs.

const VERSION = 'chart-core-zigzag-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function atrOf(bars, period) {
  var p = isNum(period) ? Math.max(1, Math.floor(period)) : 14;
  var trs = [];
  for (var i = 1; i < bars.length; i += 1) {
    var prevClose = isNum(bars[i - 1].close) ? bars[i - 1].close : bars[i].low;
    var tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return null;
  var slice = trs.slice(-p);
  return slice.reduce(function (a, b) { return a + b; }, 0) / slice.length;
}

function resolveMinDeviation(bars, options) {
  var mode = options && options.mode === 'atr' ? 'atr' : 'percent';
  if (mode === 'atr') {
    var atr = atrOf(bars, options && options.atrPeriod);
    var mult = isNum(options && options.atrMultiplier) ? options.atrMultiplier : 1;
    if (atr != null && atr > 0) return { value: atr * mult, mode: 'atr' };
    return { value: 0, mode: 'atr' };
  }
  var pct = isNum(options && options.percent) ? options.percent : 2;
  return { value: pct / 100, mode: 'percent' };
}

/**
 * Build ZigZag legs from confirmed pivots.
 * @param {Array<{high:number, low:number, close?:number, time?:any}>} series
 * @param {object} [options] { k, mode:'percent'|'atr', percent, atrPeriod, atrMultiplier }
 * @returns {Array<{from_index,from_time,from_price,to_index,to_time,to_price,direction:'up'|'down'}>}
 */
function buildZigZag(series, options) {
  var bars = (Array.isArray(series) ? series : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  if (bars.length === 0) return [];

  var pivots = detectPivots(bars, { k: options && options.k });
  if (pivots.length === 0) return [];

  var thr = resolveMinDeviation(bars, options);

  // Alternate pivots: keep the most extreme when consecutive same-type.
  var alternating = [];
  for (var i = 0; i < pivots.length; i += 1) {
    var p = pivots[i];
    var last = alternating[alternating.length - 1];
    if (!last) { alternating.push(p); continue; }
    if (last.type === p.type) {
      if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) {
        alternating[alternating.length - 1] = p;
      }
      continue;
    }
    // Enforce deviation threshold between opposite pivots.
    var dev = thr.mode === 'percent'
      ? Math.abs(p.price - last.price) / last.price
      : Math.abs(p.price - last.price);
    if (dev < thr.value) {
      // Leg too small: drop the less significant pivot (keep the extreme one).
      // If the new pivot is more extreme than the last opposite, replace last.
      if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) {
        alternating[alternating.length - 1] = p;
      }
      continue;
    }
    alternating.push(p);
  }

  var legs = [];
  for (var j = 1; j < alternating.length; j += 1) {
    var a = alternating[j - 1], b = alternating[j];
    legs.push({
      from_index: a.index, from_time: a.time, from_price: a.price,
      to_index: b.index, to_time: b.time, to_price: b.price,
      direction: b.type === 'high' ? 'up' : 'down'
    });
  }
  return legs;
}

module.exports = { VERSION: VERSION, buildZigZag: buildZigZag, atrOf: atrOf };

'use strict';

// F1 core detector: auto Fibonacci retracement + extension from the last
// confirmed swing. Levels 0/0.236/0.382/0.5/0.618/0.786/1.0 and extensions
// 1.272/1.618. Only emitted when the swing is confirmed; otherwise PROVISIONAL.

const VERSION = 'chart-core-fibonacci-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

var RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
var EXTENSION_RATIOS = [1.272, 1.618];

/**
 * Detect auto Fibonacci from the last confirmed swing.
 * @param {Array<{high:number, low:number, time?:any}>} series
 * @param {object} [options] { k, asOfIndex } — asOfIndex limits lookahead.
 * @returns {{status:'confirmed'|'provisional'|'none', direction:'uptrend'|'downtrend',
 *            swing:{from:{index,time,price}, to:{index,time,price}},
 *            levels:Array<{ratio, price}>, extensions:Array<{ratio, price}>}|null}
 */
function detectFibonacci(series, options) {
  var bars = (Array.isArray(series) ? series : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  if (bars.length === 0) return null;

  var asOf = options && isNum(options.asOfIndex)
    ? Math.min(options.asOfIndex, bars.length - 1)
    : bars.length - 1;

  var pivots = detectPivots(bars, { k: options && options.k });
  var confirmed = pivots.filter(function (p) { return p.confirmed_at_index <= asOf; });

  if (confirmed.length < 2) {
    // Provisional: use running extreme within data up to asOf.
    var hiIdx = -1, loIdx = -1, hi = -Infinity, lo = Infinity;
    for (var i = 0; i <= asOf; i += 1) {
      if (bars[i].high > hi) { hi = bars[i].high; hiIdx = i; }
      if (bars[i].low < lo) { lo = bars[i].low; loIdx = i; }
    }
    if (hiIdx < 0 || loIdx < 0) return null;
    var dir = loIdx < hiIdx ? 'uptrend' : 'downtrend';
    return {
      status: 'provisional',
      direction: dir,
      swing: {
        from: { index: dir === 'uptrend' ? loIdx : hiIdx, time: bars[dir === 'uptrend' ? loIdx : hiIdx].time, price: dir === 'uptrend' ? lo : hi },
        to: { index: dir === 'uptrend' ? hiIdx : loIdx, time: bars[dir === 'uptrend' ? hiIdx : loIdx].time, price: dir === 'uptrend' ? hi : lo }
      },
      levels: [],
      extensions: []
    };
  }

  // Last confirmed swing: last two alternating confirmed pivots.
  // Uptrend: swing low -> swing high (last confirmed pivot is the high).
  // Downtrend: swing high -> swing low (last confirmed pivot is the low).
  var last = confirmed[confirmed.length - 1];
  var prev = null;
  for (var j = confirmed.length - 2; j >= 0; j -= 1) {
    if (confirmed[j].type !== last.type) { prev = confirmed[j]; break; }
  }
  if (!prev) return null;

  var from, to, direction;
  if (last.type === 'high') {
    from = prev; to = last; direction = 'uptrend';
  } else {
    from = prev; to = last; direction = 'downtrend';
  }
  // Normalize: from = swing origin (low for uptrend, high for downtrend).
  if (direction === 'uptrend' && from.price > to.price) { var tmp = from; from = to; to = tmp; }
  if (direction === 'downtrend' && from.price < to.price) { var tmp2 = from; from = to; to = tmp2; }

  var range = to.price - from.price; // positive
  var levels = RETRACEMENT_RATIOS.map(function (ratio) {
    return { ratio: ratio, price: to.price - range * ratio };
  });
  var extensions = EXTENSION_RATIOS.map(function (ratio) {
    return { ratio: ratio, price: from.price + range * ratio };
  });

  return {
    status: 'confirmed',
    direction: direction,
    swing: {
      from: { index: from.index, time: from.time, price: from.price },
      to: { index: to.index, time: to.time, price: to.price }
    },
    levels: levels,
    extensions: extensions
  };
}

module.exports = {
  VERSION: VERSION,
  detectFibonacci: detectFibonacci,
  RETRACEMENT_RATIOS: RETRACEMENT_RATIOS,
  EXTENSION_RATIOS: EXTENSION_RATIOS
};

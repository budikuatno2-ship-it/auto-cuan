'use strict';

// F2 advanced detector: SMC market structure — BOS / CHoCH + HH/HL/LH/LL
// swing labels, built from confirmed fractal pivots (F1 pivots.js).
// BOS  (Break of Structure): close beyond last swing high in an uptrend
//      (continuation) or close below last swing low in a downtrend.
// CHoCH (Change of Character): close beyond last swing high in a downtrend
//      (first bullish reversal signal) or close below last swing low in an
//      uptrend (first bearish reversal signal).
// Breaks are CLOSE-based: a wick piercing the level without closing beyond
// it does NOT produce an event.
// No lookahead: a pivot is only usable after its confirmed_at_index; a break
// at bar t uses only candles <= t.

const VERSION = 'chart-core-smc-structure-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Analyze market structure.
 * @param {Array<{open:number,high:number,low:number,close:number,time?:any}>} candles
 * @param {object} [options] { k:number } pivot confirmation lookback.
 * @returns {{
 *   swings: Array<{index,time,price,type:'high'|'low',label:'HH'|'HL'|'LH'|'LL'|'H'|'L',confirmed_at_index}>,
 *   trend: 'up'|'down'|'range',
 *   events: Array<{type:'BOS'|'CHoCH', direction:'bullish'|'bearish',
 *                  broken_level:number, break_index:number, break_time:any, confirmed:boolean}>
 * }}
 */
function analyzeStructure(candles, options) {
  var bars = (Array.isArray(candles) ? candles : []).filter(function (c) {
    return c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close);
  });
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;

  var allPivots = detectPivots(bars, { k: k });

  // Replay bar-by-bar: at bar t, use only pivots with confirmed_at_index <= t.
  var swings = [];
  var events = [];
  var trend = 'range';
  var lastSwingHigh = null; // {index, price, time}
  var lastSwingLow = null;

  function labelSwing(p) {
    var prev = null;
    for (var s = swings.length - 1; s >= 0; s -= 1) {
      if (swings[s].type === p.type) { prev = swings[s]; break; }
    }
    var label;
    if (!prev) {
      label = p.type === 'high' ? 'H' : 'L';
    } else if (p.type === 'high') {
      label = p.price > prev.price ? 'HH' : 'LH';
    } else {
      label = p.price < prev.price ? 'LL' : 'HL';
    }
    var entry = {
      index: p.index, time: p.time, price: p.price, type: p.type,
      label: label, confirmed_at_index: p.confirmed_at_index
    };
    swings.push(entry);
    if (p.type === 'high') lastSwingHigh = entry;
    else lastSwingLow = entry;
    return entry;
  }

  for (var t = 0; t < bars.length; t += 1) {
    // Confirm any pivots whose confirmation completes at this bar.
    for (var p = 0; p < allPivots.length; p += 1) {
      if (allPivots[p].confirmed_at_index === t) labelSwing(allPivots[p]);
    }

    var bar = bars[t];
    var close = bar.close;

    if (lastSwingHigh && close > lastSwingHigh.price) {
      var evHigh = {
        type: trend === 'down' ? 'CHoCH' : 'BOS',
        direction: 'bullish',
        broken_level: lastSwingHigh.price,
        break_index: t,
        break_time: bar.time !== undefined ? bar.time : t,
        confirmed: true
      };
      events.push(evHigh);
      trend = 'up';
      // Consumed level: avoid duplicate events on the same swing high.
      lastSwingHigh = null;
    } else if (lastSwingLow && close < lastSwingLow.price) {
      var evLow = {
        type: trend === 'up' ? 'CHoCH' : 'BOS',
        direction: 'bearish',
        broken_level: lastSwingLow.price,
        break_index: t,
        break_time: bar.time !== undefined ? bar.time : t,
        confirmed: true
      };
      events.push(evLow);
      trend = 'down';
      lastSwingLow = null;
    }
  }

  return { swings: swings, trend: trend, events: events };
}

/**
 * Lookahead guard: structure computed on data truncated to asOfIndex must
 * equal the prefix of the full-data structure (events with break_index <= asOf).
 */
function structureAsOf(candles, asOfIndex, options) {
  var truncated = (Array.isArray(candles) ? candles : []).slice(0, asOfIndex + 1);
  return analyzeStructure(truncated, options);
}

module.exports = {
  VERSION: VERSION,
  analyzeStructure: analyzeStructure,
  structureAsOf: structureAsOf
};

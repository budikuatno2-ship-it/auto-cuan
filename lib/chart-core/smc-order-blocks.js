'use strict';

// F2 advanced detector: SMC order blocks + liquidity sweeps.
// Bullish OB: last down candle (close < open) before a strong up impulse that
//   breaks structure (close above a prior confirmed swing high).
// Bearish OB: last up candle (close > open) before a strong down impulse that
//   breaks structure (close below a prior confirmed swing low).
// Zone = candle open-close (default) or high-low (configurable zone:'wick').
// Liquidity sweep: wick pierces a prior confirmed pivot high/low but the
//   close returns inside (below the pivot high / above the pivot low).
//   A close BEYOND the level is a break (BOS), not a sweep.
// No lookahead: OB at impulse bar i uses pivots confirmed at <= i and
//   candles <= i; mitigation scan uses bars > i.

const VERSION = 'chart-core-smc-order-blocks-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function normalize(candles) {
  return (Array.isArray(candles) ? candles : []).filter(function (c) {
    return c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close);
  });
}

/**
 * Detect order blocks with mitigation tracking.
 * @param {Array<{open:number,high:number,low:number,close:number,time?:any}>} candles
 * @param {object} [options] { k, impulseFactor (min impulse range / ATR-ish
 *        avg range, default 1.5), zone:'body'|'wick' }
 * @returns {Array<{type:'bullish'|'bearish', zone:{top,bottom},
 *                    created_index, created_time, impulse_index,
 *                    mitigated_index:number|null, mitigated_time:any}>}
 */
function detectOrderBlocks(candles, options) {
  var bars = normalize(candles);
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var impulseFactor = options && isNum(options.impulseFactor) ? options.impulseFactor : 1.5;
  var zoneMode = options && options.zone === 'wick' ? 'wick' : 'body';
  var out = [];

  if (bars.length < 2 * k + 2) return out;

  var pivots = detectPivots(bars, { k: k });

  // Average candle range for impulse strength.
  var ranges = bars.map(function (b) { return b.high - b.low; });
  var avgRange = ranges.reduce(function (a, b) { return a + b; }, 0) / ranges.length;

  for (var i = 1; i < bars.length; i += 1) {
    var impulse = bars[i];
    var impulseRange = impulse.high - impulse.low;
    if (impulseRange < impulseFactor * avgRange) continue;

    var bullish = impulse.close > impulse.open;
    var bearish = impulse.close < impulse.open;
    if (!bullish && !bearish) continue;

    // Structure break requirement: close beyond a prior confirmed pivot.
    var brokenPivot = null;
    for (var p = 0; p < pivots.length; p += 1) {
      var pv = pivots[p];
      if (pv.confirmed_at_index > i) continue;
      if (bullish && pv.type === 'high' && impulse.close > pv.price) { brokenPivot = pv; break; }
      if (bearish && pv.type === 'low' && impulse.close < pv.price) { brokenPivot = pv; break; }
    }
    if (!brokenPivot) continue;

    // Find last opposite candle before the impulse (search back up to 5 bars).
    var obBar = null, obIndex = null;
    for (var j = i - 1; j >= Math.max(0, i - 5); j -= 1) {
      var c = bars[j];
      if (bullish && c.close < c.open) { obBar = c; obIndex = j; break; }
      if (bearish && c.close > c.open) { obBar = c; obIndex = j; break; }
    }
    if (!obBar) continue;

    var zone = zoneMode === 'wick'
      ? { top: obBar.high, bottom: obBar.low }
      : { top: Math.max(obBar.open, obBar.close), bottom: Math.min(obBar.open, obBar.close) };

    // Mitigation: price closes back through the zone in the adverse direction.
    var mitIndex = null, mitTime = null;
    for (var m = i + 1; m < bars.length; m += 1) {
      var b = bars[m];
      var mitigated = bullish
        ? b.close < zone.bottom
        : b.close > zone.top;
      if (mitigated) { mitIndex = m; mitTime = b.time !== undefined ? b.time : m; break; }
    }

    out.push({
      type: bullish ? 'bullish' : 'bearish',
      zone: zone,
      created_index: obIndex,
      created_time: obBar.time !== undefined ? obBar.time : obIndex,
      impulse_index: i,
      mitigated_index: mitIndex,
      mitigated_time: mitTime
    });
  }
  return out;
}

/**
 * Detect liquidity sweeps: wick pierces a prior confirmed pivot level but
 * close returns inside. Close beyond => break (not a sweep) => excluded.
 * @returns {Array<{type:'high'|'low', swept_level:number, sweep_index,
 *                    sweep_time, pivot_index}>}
 */
function detectLiquiditySweeps(candles, options) {
  var bars = normalize(candles);
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var pivots = detectPivots(bars, { k: k });
  var out = [];

  for (var t = 0; t < bars.length; t += 1) {
    var bar = bars[t];
    for (var p = 0; p < pivots.length; p += 1) {
      var pv = pivots[p];
      if (pv.confirmed_at_index > t || pv.index >= t) continue;
      if (pv.type === 'high' && bar.high > pv.price && bar.close <= pv.price) {
        out.push({
          type: 'high',
          swept_level: pv.price,
          sweep_index: t,
          sweep_time: bar.time !== undefined ? bar.time : t,
          pivot_index: pv.index
        });
      } else if (pv.type === 'low' && bar.low < pv.price && bar.close >= pv.price) {
        out.push({
          type: 'low',
          swept_level: pv.price,
          sweep_index: t,
          sweep_time: bar.time !== undefined ? bar.time : t,
          pivot_index: pv.index
        });
      }
    }
  }
  return out;
}

module.exports = {
  VERSION: VERSION,
  detectOrderBlocks: detectOrderBlocks,
  detectLiquiditySweeps: detectLiquiditySweeps
};

'use strict';

// F1 core detector: divergence between price pivots and an oscillator series.
// Works for RSI, MACD histogram, OBV given the series + confirmed pivots.
// Bullish = price lower low + oscillator higher low (two aligned confirmed
// pivot lows). Bearish = price higher high + oscillator lower high.

const VERSION = 'chart-core-divergence-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Detect divergences.
 * @param {Array<{high:number, low:number, time?:any}>} series price bars
 * @param {(number|null)[]} oscillator oscillator values aligned to series
 * @param {object} [options] { k, maxLookback, asOfIndex }
 *   maxLookback: max bars between the two pivots (default 60).
 * @returns {{bullish:Array, bearish:Array, provisional:boolean}}
 *          each item: {type, pivot1:{index,price,osc}, pivot2:{index,price,osc}}
 */
function detectDivergence(series, oscillator, options) {
  var bars = (Array.isArray(series) ? series : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  var osc = Array.isArray(oscillator) ? oscillator : [];
  var maxLookback = options && isNum(options.maxLookback) ? options.maxLookback : 60;
  var asOf = options && isNum(options.asOfIndex) ? Math.min(options.asOfIndex, bars.length - 1) : bars.length - 1;

  var result = { bullish: [], bearish: [], provisional: false };
  if (bars.length === 0) return result;

  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var pivots = detectPivots(bars, { k: k });
  var confirmed = pivots.filter(function (p) { return p.confirmed_at_index <= asOf; });

  // Tentative right-edge pivots: a bar within the last k bars that is a strict
  // extreme vs all available surrounding bars but not yet confirmed.
  var start = Math.max(0, bars.length - k);
  for (var e = bars.length - 1; e >= start; e -= 1) {
    var leftOk = e >= k;
    if (!leftOk) continue;
    var isHighT = true, isLowT = true;
    for (var w = Math.max(0, e - k); w <= Math.min(bars.length - 1, e + k); w += 1) {
      if (w === e) continue;
      if (bars[w].high >= bars[e].high) isHighT = false;
      if (bars[w].low <= bars[e].low) isLowT = false;
    }
    if (isHighT || isLowT) { result.provisional = true; break; }
  }

  var lows = confirmed.filter(function (p) { return p.type === 'low'; });
  var highs = confirmed.filter(function (p) { return p.type === 'high'; });

  function oscAt(idx) {
    return isNum(osc[idx]) ? osc[idx] : null;
  }

  for (var i = 1; i < lows.length; i += 1) {
    var a = lows[i - 1], b = lows[i];
    if (b.index - a.index > maxLookback) continue;
    var oa = oscAt(a.index), ob = oscAt(b.index);
    if (oa == null || ob == null) continue;
    if (b.price < a.price && ob > oa) {
      result.bullish.push({
        type: 'bullish',
        pivot1: { index: a.index, price: a.price, osc: oa },
        pivot2: { index: b.index, price: b.price, osc: ob }
      });
    }
  }

  for (var j = 1; j < highs.length; j += 1) {
    var ha = highs[j - 1], hb = highs[j];
    if (hb.index - ha.index > maxLookback) continue;
    var oha = oscAt(ha.index), ohb = oscAt(hb.index);
    if (oha == null || ohb == null) continue;
    if (hb.price > ha.price && ohb < oha) {
      result.bearish.push({
        type: 'bearish',
        pivot1: { index: ha.index, price: ha.price, osc: oha },
        pivot2: { index: hb.index, price: hb.price, osc: ohb }
      });
    }
  }
  return result;
}

module.exports = { VERSION: VERSION, detectDivergence: detectDivergence };

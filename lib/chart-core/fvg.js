'use strict';

// F2 advanced detector: SMC Fair Value Gap (FVG), canonical 3-candle definition.
// Bullish FVG at bar i: candle[i].low > candle[i-2].high
//   => gap zone = [candle[i-2].high, candle[i].low]
// Bearish FVG at bar i: candle[i].low < candle[i-2].high is NOT the definition;
//   bearish FVG: candle[i].high < candle[i-2].low
//   => gap zone = [candle[i].high, candle[i-2].low]
// Mitigation: price trading back into the zone after creation.
//   unmitigated -> partially-mitigated (price enters zone but not through
//   midpoint) -> fully-mitigated (price crosses zone midpoint).
// No lookahead: FVG at i uses candles <= i; mitigation scan uses bars > i.

const VERSION = 'chart-core-fvg-v1';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function normalize(candles) {
  return (Array.isArray(candles) ? candles : []).filter(function (c) {
    return c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close);
  });
}

/**
 * Detect FVGs with mitigation state.
 * @param {Array<{open:number,high:number,low:number,close:number,time?:any}>} candles
 * @param {object} [options] { requireDisplacement:boolean } - if true, the
 *        middle candle must be a displacement candle (body > 60% of range).
 * @returns {Array<{type:'bullish'|'bearish', index, time, zone:{top,bottom},
 *                    midpoint, state:'unmitigated'|'partially-mitigated'|'fully-mitigated',
 *                    mitigation_index:number|null, mitigation_time:any}>}
 */
function detectFVGs(candles, options) {
  var bars = normalize(candles);
  var requireDisplacement = !!(options && options.requireDisplacement);
  var out = [];

  for (var i = 2; i < bars.length; i += 1) {
    var c0 = bars[i - 2], c1 = bars[i - 1], c2 = bars[i];
    if (requireDisplacement) {
      var range = c1.high - c1.low;
      var body = Math.abs(c1.close - c1.open);
      if (!(range > 0 && body / range > 0.6)) continue;
    }

    var type = null, top = null, bottom = null;
    if (c2.low > c0.high) {
      type = 'bullish';
      bottom = c0.high;
      top = c2.low;
    } else if (c2.high < c0.low) {
      type = 'bearish';
      bottom = c2.high;
      top = c0.low;
    }
    if (!type) continue;

    var midpoint = (top + bottom) / 2;
    var state = 'unmitigated';
    var firstIdx = null, firstTime = null;
    var crossIdx = null, crossTime = null;

    for (var j = i + 1; j < bars.length; j += 1) {
      var b = bars[j];
      var entered = b.low <= top && b.high >= bottom;
      if (!entered) continue;
      if (firstIdx === null) {
        firstIdx = j;
        firstTime = b.time !== undefined ? b.time : j;
        state = 'partially-mitigated';
      }
      var crossedMid = type === 'bullish'
        ? b.low <= midpoint
        : b.high >= midpoint;
      if (crossedMid) {
        state = 'fully-mitigated';
        crossIdx = j;
        crossTime = b.time !== undefined ? b.time : j;
        break;
      }
    }

    out.push({
      type: type,
      index: i,
      time: c2.time !== undefined ? c2.time : i,
      zone: { top: top, bottom: bottom },
      midpoint: midpoint,
      state: state,
      mitigation_index: firstIdx,
      mitigation_time: firstTime,
      mitigation_cross_index: crossIdx,
      mitigation_cross_time: crossTime
    });
  }
  return out;
}

/**
 * Lookahead guard: FVGs known as of bar asOfIndex (inclusive). An FVG at i is
 * known at i (3-candle form complete); mitigation known only if
 * mitigation_index <= asOfIndex.
 */
function fvgsAsOf(candles, asOfIndex, options) {
  var all = detectFVGs(candles, options);
  return all
    .filter(function (f) { return f.index <= asOfIndex; })
    .map(function (f) {
      // Full mitigation is only known once the midpoint-cross bar has closed.
      if (f.state === 'fully-mitigated' &&
          f.mitigation_cross_index !== null &&
          f.mitigation_cross_index > asOfIndex) {
        if (f.mitigation_index !== null && f.mitigation_index <= asOfIndex) {
          return Object.assign({}, f, {
            state: 'partially-mitigated',
            mitigation_cross_index: null,
            mitigation_cross_time: null
          });
        }
        return Object.assign({}, f, {
          state: 'unmitigated',
          mitigation_index: null,
          mitigation_time: null,
          mitigation_cross_index: null,
          mitigation_cross_time: null
        });
      }
      // First entry not yet known at asOfIndex.
      if (f.mitigation_index !== null && f.mitigation_index > asOfIndex) {
        return Object.assign({}, f, {
          state: 'unmitigated',
          mitigation_index: null,
          mitigation_time: null,
          mitigation_cross_index: null,
          mitigation_cross_time: null
        });
      }
      return f;
    });
}

module.exports = { VERSION: VERSION, detectFVGs: detectFVGs, fvgsAsOf: fvgsAsOf };

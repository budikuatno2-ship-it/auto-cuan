'use strict';

// F1 core detector: session GAP detector (today's open > yesterday's high =
// gap up; < yesterday's low = gap down) with fill/mitigation state.
// Distinct from FVG (fair value gap, F2 scope).

const VERSION = 'chart-core-gaps-v1';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Detect session gaps and their fill state.
 * @param {Array<{open:number, high:number, low:number, close:number, time?:any}>} candles
 * @returns {Array<{type:'up'|'down', gap_index, gap_time, gap_top, gap_bottom,
 *                    size, state:'unfilled'|'partially-filled'|'filled', fill_index|null, fill_time|null}>}
 */
function detectGaps(candles) {
  var bars = (Array.isArray(candles) ? candles : []).filter(function (c) {
    return c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close);
  });
  var out = [];
  for (var i = 1; i < bars.length; i += 1) {
    var prev = bars[i - 1], cur = bars[i];
    var gap = null;
    if (cur.open > prev.high) {
      gap = { type: 'up', gap_top: cur.open, gap_bottom: prev.high };
    } else if (cur.open < prev.low) {
      gap = { type: 'down', gap_top: prev.low, gap_bottom: cur.open };
    }
    if (!gap) continue;

    gap.gap_index = i;
    gap.gap_time = cur.time !== undefined ? cur.time : i;
    gap.size = gap.gap_top - gap.gap_bottom;

    // Fill scan: subsequent bars only (no lookahead beyond scan itself).
    var state = 'unfilled', fillIndex = null, fillTime = null;
    for (var j = i + 1; j < bars.length; j += 1) {
      var b = bars[j];
      if (gap.type === 'up') {
        if (b.low <= gap.gap_bottom) { state = 'filled'; fillIndex = j; fillTime = b.time !== undefined ? b.time : j; break; }
        if (b.low < gap.gap_top) { state = 'partially-filled'; }
      } else {
        if (b.high >= gap.gap_top) { state = 'filled'; fillIndex = j; fillTime = b.time !== undefined ? b.time : j; break; }
        if (b.high > gap.gap_bottom) { state = 'partially-filled'; }
      }
    }
    gap.state = state;
    gap.fill_index = fillIndex;
    gap.fill_time = fillTime;
    out.push(gap);
  }
  return out;
}

module.exports = { VERSION: VERSION, detectGaps: detectGaps };

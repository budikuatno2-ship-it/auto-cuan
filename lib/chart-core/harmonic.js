'use strict';

// F2 advanced detector: harmonic XABCD patterns (Gartley, Bat, Butterfly,
// Crab) from confirmed pivots with ratio tolerance and PRZ.
//
// Canonical ratios (XA retracements/extensions):
//   Gartley:   B = 0.618 XA, D = 0.786 XA
//   Bat:       B = 0.382-0.5 XA, D = 0.886 XA
//   Butterfly: B = 0.786 XA, D = 1.272 XA
//   Crab:      B = 0.382-0.618 XA, D = 1.618 XA
// C leg: 0.382-0.886 retracement of AB (guidance for all patterns).
// Tolerance default ±5% (relative to the ideal ratio).
// PRZ = zone around D computed from the ideal D ratio applied to XA.
// Status: D confirmed only after `confirmBars` bars past the D pivot
// (default = pivot k), otherwise PROVISIONAL.
// No lookahead: pivots used only after confirmed_at_index; D confirmation
// requires bars after D.

const VERSION = 'chart-core-harmonic-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

var PATTERNS = {
  gartley:   { B: [0.618, 0.618], D: [0.786, 0.786] },
  bat:       { B: [0.382, 0.5],   D: [0.886, 0.886] },
  butterfly: { B: [0.786, 0.786], D: [1.272, 1.272] },
  crab:      { B: [0.382, 0.618], D: [1.618, 1.618] }
};

function ratioToleranceOk(ratio, idealRange, tolerance) {
  var lo = idealRange[0] * (1 - tolerance);
  var hi = idealRange[1] * (1 + tolerance);
  return ratio >= lo && ratio <= hi;
}

/**
 * Detect harmonic patterns.
 * @param {Array<{high:number,low:number,close?:number,time?:any}>} candles
 * @param {object} [options] { k, tolerance (default 0.05), confirmBars }
 * @returns {Array<{pattern, direction:'bullish'|'bearish',
 *                    points:{X,A,B,C,D}, ratios:{B, C, D},
 *                    tolerance, prz:{top,bottom},
 *                    status:'PROVISIONAL'|'CONFIRMED'}>}
 */
function detectHarmonics(candles, options) {
  var bars = (Array.isArray(candles) ? candles : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var tolerance = options && isNum(options.tolerance) ? options.tolerance : 0.05;
  var confirmBars = options && isNum(options.confirmBars) ? options.confirmBars : k;

  var pivots = detectPivots(bars, { k: k });
  var out = [];
  var last = bars.length - 1;

  // Try every window of 5 alternating pivots.
  for (var s = 0; s + 4 < pivots.length; s += 1) {
    var p = pivots.slice(s, s + 5);
    // Must alternate high/low.
    var alt = true;
    for (var q = 1; q < 5; q += 1) {
      if (p[q].type === p[q - 1].type) { alt = false; break; }
    }
    if (!alt) continue;

    // Two shapes: X low (bullish: X low, A high, B low, C high, D low) or
    // X high (bearish: X high, A low, B high, C low, D high).
    var bullish = p[0].type === 'low';
    var X = p[0], A = p[1], B = p[2], C = p[3], D = p[4];

    var xa = Math.abs(A.price - X.price);
    if (!(xa > 0)) continue;

    var rB = Math.abs(A.price - B.price) / xa;
    var ab = Math.abs(A.price - B.price);
    var rC = ab > 0 ? Math.abs(B.price - C.price) / ab : 0;
    var rD = Math.abs(A.price - D.price) / xa;

    if (!(rC >= 0.382 * (1 - tolerance) && rC <= 0.886 * (1 + tolerance))) continue;

    for (var name in PATTERNS) {
      if (!Object.prototype.hasOwnProperty.call(PATTERNS, name)) continue;
      var spec = PATTERNS[name];
      if (!ratioToleranceOk(rB, spec.B, tolerance)) continue;
      if (!ratioToleranceOk(rD, spec.D, tolerance)) continue;

      // PRZ around ideal D level applied to XA.
      var idealD = xa * spec.D[0];
      var dLevel = bullish ? A.price - idealD : A.price + idealD;
      var przPad = xa * 0.05;
      var prz = bullish
        ? { top: dLevel + przPad, bottom: dLevel - przPad }
        : { top: dLevel + przPad, bottom: dLevel - przPad };

      var dConfirmed = D.confirmed_at_index !== undefined &&
        D.confirmed_at_index <= last &&
        (last - D.index) >= confirmBars;

      out.push({
        pattern: name,
        direction: bullish ? 'bullish' : 'bearish',
        points: { X: X, A: A, B: B, C: C, D: D },
        ratios: { B: Number(rB.toFixed(4)), C: Number(rC.toFixed(4)), D: Number(rD.toFixed(4)) },
        tolerance: tolerance,
        prz: prz,
        status: dConfirmed ? 'CONFIRMED' : 'PROVISIONAL'
      });
    }
  }
  return out;
}

/**
 * Lookahead guard: harmonics known as of bar asOfIndex (data truncated).
 */
function harmonicsAsOf(candles, asOfIndex, options) {
  var truncated = (Array.isArray(candles) ? candles : []).slice(0, asOfIndex + 1);
  return detectHarmonics(truncated, options);
}

module.exports = {
  VERSION: VERSION,
  PATTERNS: PATTERNS,
  detectHarmonics: detectHarmonics,
  harmonicsAsOf: harmonicsAsOf
};

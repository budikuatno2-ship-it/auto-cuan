'use strict';

// F2 advanced detector: Elliott Wave impulse (1-5) + ABC correction with
// rule checks and alternative counts.
//
// Impulse rules (checked, configurable strictness):
//   R1: wave 2 never retraces more than 100% of wave 1.
//   R2: wave 3 is never the shortest among waves 1, 3, 5.
//   R3: wave 4 does not overlap wave 1 price territory (strict mode; in
//       lenient mode overlap is flagged but not invalidating).
// ABC correction: A=B or C=1.618A as guidance (reported, not hard rule).
// Alternatives: if the 5-segment sequence fails a rule, an alternate count
// (e.g. first three legs read as A-B of a correction) is offered.
// No lookahead: pivots used only after confirmed_at_index; wave count at
// bar t uses only pivots confirmed at <= t.

const VERSION = 'chart-core-elliott-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Detect Elliott impulse / ABC from confirmed pivots.
 * @param {Array<{high:number,low:number,close?:number,time?:any}>} candles
 * @param {object} [options] { k, strict (default true), confirmBars }
 * @returns {Array<{kind:'impulse'|'abc',
 *                    direction:'bullish'|'bearish',
 *                    waves:Array<{n, from_pivot, to_pivot}>,
 *                    rules_checked:Array<{rule, pass}>,
 *                    status:'PROVISIONAL'|'CONFIRMED'|'INVALIDATED',
 *                    alternatives:Array<{kind, note}>}>}
 */
function detectElliott(candles, options) {
  var bars = (Array.isArray(candles) ? candles : []).filter(function (b) {
    return b && isNum(b.high) && isNum(b.low);
  });
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var strict = !(options && options.strict === false);
  var confirmBars = options && isNum(options.confirmBars) ? options.confirmBars : k;

  var pivots = detectPivots(bars, { k: k });
  var out = [];
  var last = bars.length - 1;

  for (var s = 0; s + 5 < pivots.length; s += 1) {
    var p = pivots.slice(s, s + 6);
    var alt = true;
    for (var q = 1; q < 6; q += 1) {
      if (p[q].type === p[q - 1].type) { alt = false; break; }
    }
    if (!alt) continue;

    // Bullish impulse: P0 low (wave 0 origin), P1 high, P2 low, P3 high,
    // P4 low, P5 high. Bearish is the mirror.
    var bullish = p[0].type === 'low';
    var pts = bullish ? p : p.slice().reverse().map(function (x) { return x; });
    // For bearish, reverse so wave 1 is a down leg: p = [high, low, high, low, high, low]
    if (!bullish) pts = p;

    var w = [];
    for (var i = 0; i < 5; i += 1) {
      w.push({ n: i + 1, from_pivot: pts[i], to_pivot: pts[i + 1] });
    }

    function legLen(idx) {
      return Math.abs(pts[idx + 1].price - pts[idx].price);
    }

    var rules = [];
    // R1: wave 2 retrace <= 100% of wave 1.
    var w1 = legLen(0), w2 = legLen(1), w3 = legLen(2), w4 = legLen(3), w5 = legLen(4);
    var r1 = w2 <= w1;
    rules.push({ rule: 'wave2_max_100pct_retrace_of_wave1', pass: r1 });

    // R2: wave 3 never the shortest.
    var r2 = !(w3 < w1 && w3 < w5);
    rules.push({ rule: 'wave3_not_shortest', pass: r2 });

    // R3: wave 4 does not overlap wave 1 price territory.
    var w1Start = pts[0].price, w1End = pts[1].price;
    var w4End = pts[4].price;
    var overlap = bullish
      ? w4End < w1End // wave 4 low dips below wave 1 high
      : w4End > w1End; // wave 4 high rises above wave 1 low
    var r3 = !overlap;
    rules.push({ rule: 'wave4_no_overlap_wave1', pass: r3 });

    var failed = rules.some(function (r) { return !r.pass; });
    var status;
    if (failed && strict) {
      status = 'INVALIDATED';
    } else {
      var lastPivot = pts[5];
      var confirmed = lastPivot.confirmed_at_index !== undefined &&
        lastPivot.confirmed_at_index <= last &&
        (last - lastPivot.index) >= confirmBars;
      status = confirmed ? 'CONFIRMED' : 'PROVISIONAL';
    }

    var alternatives = [];
    if (failed) {
      alternatives.push({
        kind: 'abc',
        note: 'Failed impulse rules; first three legs may read as A-B of a correction.'
      });
    }
    if (status === 'CONFIRMED' || status === 'PROVISIONAL') {
      alternatives.push({
        kind: 'abc',
        note: 'Waves 1-2 may alternatively read as A-B of an ABC correction.'
      });
    }

    out.push({
      kind: 'impulse',
      direction: bullish ? 'bullish' : 'bearish',
      waves: w,
      rules_checked: rules,
      status: status,
      alternatives: alternatives
    });
  }

  // ---- ABC correction: 3 alternating pivots after an impulse-ish leg ----
  for (var a = 0; a + 2 < pivots.length; a += 1) {
    var pp = pivots.slice(a, a + 3);
    var alt2 = pp[1].type !== pp[0].type && pp[2].type !== pp[1].type;
    if (!alt2) continue;
    var legA = Math.abs(pp[1].price - pp[0].price);
    var legB = Math.abs(pp[2].price - pp[1].price);
    if (!(legA > 0)) continue;
    var ratio = legB / legA;
    // Guidance: A=B (ratio ~1) or C=1.618A — accept 0.8-1.2 or 1.5-1.75.
    var guidance = (ratio >= 0.8 && ratio <= 1.2) || (ratio >= 1.5 && ratio <= 1.75);
    if (!guidance) continue;
    var lastP = pp[2];
    var confirmed = lastP.confirmed_at_index !== undefined &&
      lastP.confirmed_at_index <= last &&
      (last - lastP.index) >= confirmBars;
    out.push({
      kind: 'abc',
      direction: pp[1].price > pp[0].price ? 'bearish' : 'bullish',
      waves: [
        { n: 'A', from_pivot: pp[0], to_pivot: pp[1] },
        { n: 'B', from_pivot: pp[1], to_pivot: pp[2] }
      ],
      rules_checked: [{ rule: 'abc_ratio_guidance_A_eq_B_or_C_1618A', pass: true }],
      status: confirmed ? 'CONFIRMED' : 'PROVISIONAL',
      alternatives: []
    });
  }

  return out;
}

/**
 * Lookahead guard: Elliott counts known as of bar asOfIndex (data truncated).
 */
function elliottAsOf(candles, asOfIndex, options) {
  var truncated = (Array.isArray(candles) ? candles : []).slice(0, asOfIndex + 1);
  return detectElliott(truncated, options);
}

module.exports = { VERSION: VERSION, detectElliott: detectElliott, elliottAsOf: elliottAsOf };

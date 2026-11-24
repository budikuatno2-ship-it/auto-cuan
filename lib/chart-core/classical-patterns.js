'use strict';

// F2 advanced detector: classical chart patterns with neckline-break
// confirmation semantics. Pure, deterministic, no lookahead: a pattern is
// only reported as known at its confirmation bar; provisional patterns use
// only pivots confirmed at the evaluation bar.
//
// Patterns: double top / double bottom (neckline confirmation), head &
// shoulders + inverse, rounding base (U-shape via pivot curvature),
// triangles (symmetric / ascending / descending), flags / pennants,
// wedges (rising / falling).
//
// Reuse note: lib/classic-chart-patterns.js is a T-1 scoring context with a
// different (score-based, last-120-bars) API and its own heuristics. This
// module is a standalone deterministic detector with explicit pivot anchors
// and confirmation semantics; it does not duplicate that file's scoring
// behavior and does not modify it.

const VERSION = 'chart-core-classical-patterns-v1';
const { detectPivots } = require('./pivots');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function normalize(candles) {
  return (Array.isArray(candles) ? candles : []).filter(function (c) {
    return c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close);
  });
}

function relDiff(a, b) {
  var m = (Math.abs(a) + Math.abs(b)) / 2;
  return m > 0 ? Math.abs(a - b) / m : 0;
}

function makeResult(pattern, direction, anchors, boundary, confirmed, confirmedIndex, provisional) {
  return {
    pattern: pattern,
    direction: direction,
    anchors: anchors,
    neckline_or_boundary: boundary,
    confirmed: confirmed,
    confirmed_index: confirmed ? confirmedIndex : null,
    provisional: provisional
  };
}

function pivotRef(p) {
  return { index: p.index, time: p.time, price: p.price, type: p.type };
}

/**
 * Detect classical patterns.
 * @param {Array<{open:number,high:number,low:number,close:number,time?:any}>} candles
 * @param {object} [options] { k, equalTolerance (default 0.03),
 *        roundingMinBars (default 10), poleMinMove (default 0.08) }
 * @returns {Array} results as makeResult()
 */
function detectClassicalPatterns(candles, options) {
  var bars = normalize(candles);
  var k = options && isNum(options.k) ? Math.max(1, Math.floor(options.k)) : 3;
  var tol = options && isNum(options.equalTolerance) ? options.equalTolerance : 0.03;
  var roundingMinBars = options && isNum(options.roundingMinBars) ? options.roundingMinBars : 10;
  var poleMinMove = options && isNum(options.poleMinMove) ? options.poleMinMove : 0.08;

  var pivots = detectPivots(bars, { k: k });
  var highs = pivots.filter(function (p) { return p.type === 'high'; });
  var lows = pivots.filter(function (p) { return p.type === 'low'; });
  var out = [];
  var last = bars.length - 1;
  if (last < 0) return out;

  // ---- Double top / bottom (neckline confirmation) ----
  if (highs.length >= 2) {
    var h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
    if (h2.index - h1.index >= 3 && relDiff(h1.price, h2.price) <= tol) {
      var valley = null;
      for (var v = 0; v < lows.length; v += 1) {
        if (lows[v].index > h1.index && lows[v].index < h2.index) {
          if (!valley || lows[v].price < valley.price) valley = lows[v];
        }
      }
      if (valley) {
        var depth = (Math.min(h1.price, h2.price) - valley.price) / valley.price;
        if (depth >= 0.03) {
          var confirmedTop = false, confIdx = null;
          for (var t = h2.index + 1; t <= last; t += 1) {
            if (bars[t].close < valley.price) { confirmedTop = true; confIdx = t; break; }
          }
          out.push(makeResult('double-top', 'bearish',
            [pivotRef(h1), pivotRef(valley), pivotRef(h2)],
            { kind: 'neckline', level: valley.price },
            confirmedTop, confIdx, !confirmedTop));
        }
      }
    }
  }
  if (lows.length >= 2) {
    var l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
    if (l2.index - l1.index >= 3 && relDiff(l1.price, l2.price) <= tol) {
      var peak = null;
      for (var w = 0; w < highs.length; w += 1) {
        if (highs[w].index > l1.index && highs[w].index < l2.index) {
          if (!peak || highs[w].price > peak.price) peak = highs[w];
        }
      }
      if (peak) {
        var rise = (peak.price - Math.max(l1.price, l2.price)) / Math.max(l1.price, l2.price);
        if (rise >= 0.03) {
          var confirmedBottom = false, confIdx2 = null;
          for (var t2 = l2.index + 1; t2 <= last; t2 += 1) {
            if (bars[t2].close > peak.price) { confirmedBottom = true; confIdx2 = t2; break; }
          }
          out.push(makeResult('double-bottom', 'bullish',
            [pivotRef(l1), pivotRef(peak), pivotRef(l2)],
            { kind: 'neckline', level: peak.price },
            confirmedBottom, confIdx2, !confirmedBottom));
        }
      }
    }
  }

  // ---- Head & shoulders + inverse (3 pivots, neckline break confirms) ----
  if (highs.length >= 3) {
    var ls = highs[highs.length - 3], hd = highs[highs.length - 2], rs = highs[highs.length - 1];
    var shouldersLevel = Math.min(ls.price, rs.price);
    if (hd.price > ls.price && hd.price > rs.price &&
        relDiff(ls.price, rs.price) <= tol * 1.5) {
      var neckLow = null;
      for (var nl = 0; nl < lows.length; nl += 1) {
        if (lows[nl].index > ls.index && lows[nl].index < rs.index) {
          if (!neckLow || lows[nl].price < neckLow.price) neckLow = lows[nl];
        }
      }
      if (neckLow) {
        var hsConfirmed = false, hsIdx = null;
        for (var t3 = rs.index + 1; t3 <= last; t3 += 1) {
          if (bars[t3].close < neckLow.price) { hsConfirmed = true; hsIdx = t3; break; }
        }
        out.push(makeResult('head-and-shoulders', 'bearish',
          [pivotRef(ls), pivotRef(neckLow), pivotRef(hd), pivotRef(rs)],
          { kind: 'neckline', level: neckLow.price },
          hsConfirmed, hsIdx, !hsConfirmed));
      }
    }
  }
  if (lows.length >= 3) {
    var ll = lows[lows.length - 3], ld = lows[lows.length - 2], rl = lows[lows.length - 1];
    if (ld.price < ll.price && ld.price < rl.price &&
        relDiff(ll.price, rl.price) <= tol * 1.5) {
      var neckHigh = null;
      for (var nh = 0; nh < highs.length; nh += 1) {
        if (highs[nh].index > ll.index && highs[nh].index < rl.index) {
          if (!neckHigh || highs[nh].price > neckHigh.price) neckHigh = highs[nh];
        }
      }
      if (neckHigh) {
        var invConfirmed = false, invIdx = null;
        for (var t4 = rl.index + 1; t4 <= last; t4 += 1) {
          if (bars[t4].close > neckHigh.price) { invConfirmed = true; invIdx = t4; break; }
        }
        out.push(makeResult('inverse-head-and-shoulders', 'bullish',
          [pivotRef(ll), pivotRef(neckHigh), pivotRef(ld), pivotRef(rl)],
          { kind: 'neckline', level: neckHigh.price },
          invConfirmed, invIdx, !invConfirmed));
      }
    }
  }

  // ---- Rounding base: approximate U-shape via pivot curvature ----
  if (lows.length >= 3) {
    var first = lows[0], mid = null, lastL = lows[lows.length - 1];
    // middle low must be the lowest and roughly centered
    for (var ml = 1; ml < lows.length - 1; ml += 1) {
      if (lows[ml].price < first.price && lows[ml].price < lastL.price) { mid = lows[ml]; break; }
    }
    if (mid && mid.index - first.index >= roundingMinBars / 2 &&
        lastL.index - mid.index >= roundingMinBars / 2 &&
        mid.price < first.price && mid.price < lastL.price &&
        relDiff(first.price, lastL.price) <= tol * 2) {
      var rim = Math.max(first.price, lastL.price);
      var rbConfirmed = false, rbIdx = null;
      for (var t5 = lastL.index + 1; t5 <= last; t5 += 1) {
        if (bars[t5].close > rim) { rbConfirmed = true; rbIdx = t5; break; }
      }
      out.push(makeResult('rounding-base', 'bullish',
        [pivotRef(first), pivotRef(mid), pivotRef(lastL)],
        { kind: 'rim', level: rim },
        rbConfirmed, rbIdx, !rbConfirmed));
    }
  }

  // ---- Triangles from converging trendlines over recent pivots ----
  if (highs.length >= 2 && lows.length >= 2) {
    var hs1 = highs[highs.length - 2], hs2 = highs[highs.length - 1];
    var ls1 = lows[lows.length - 2], ls2 = lows[lows.length - 1];
    var upperSlope = (hs2.price - hs1.price) / Math.max(1, hs2.index - hs1.index);
    var lowerSlope = (ls2.price - ls1.price) / Math.max(1, ls2.index - ls1.index);
    var ref = bars[last].close;
    var flat = 0.001, directional = 0.0005;
    var upperPct = upperSlope / ref, lowerPct = lowerSlope / ref;
    var converging = upperSlope < 0 && lowerSlope > 0;

    if (converging) {
      out.push(makeResult('symmetric-triangle', 'neutral',
        [pivotRef(hs1), pivotRef(hs2), pivotRef(ls1), pivotRef(ls2)],
        { kind: 'trendlines', upper: { slope: upperSlope }, lower: { slope: lowerSlope } },
        false, null, true));
    } else if (Math.abs(upperPct) <= flat && lowerPct >= directional) {
      out.push(makeResult('ascending-triangle', 'bullish',
        [pivotRef(hs1), pivotRef(hs2), pivotRef(ls1), pivotRef(ls2)],
        { kind: 'resistance', level: Math.max(hs1.price, hs2.price) },
        false, null, true));
    } else if (Math.abs(lowerPct) <= flat && upperPct <= -directional) {
      out.push(makeResult('descending-triangle', 'bearish',
        [pivotRef(hs1), pivotRef(hs2), pivotRef(ls1), pivotRef(ls2)],
        { kind: 'support', level: Math.min(ls1.price, ls2.price) },
        false, null, true));
    } else if (upperPct > directional && lowerPct > directional && lowerSlope > upperSlope) {
      out.push(makeResult('rising-wedge', 'bearish',
        [pivotRef(hs1), pivotRef(hs2), pivotRef(ls1), pivotRef(ls2)],
        { kind: 'trendlines', upper: { slope: upperSlope }, lower: { slope: lowerSlope } },
        false, null, true));
    } else if (upperPct < -directional && lowerPct < -directional && upperSlope < lowerSlope) {
      out.push(makeResult('falling-wedge', 'bullish',
        [pivotRef(hs1), pivotRef(hs2), pivotRef(ls1), pivotRef(ls2)],
        { kind: 'trendlines', upper: { slope: upperSlope }, lower: { slope: lowerSlope } },
        false, null, true));
    }
  }

  // ---- Flags / pennants: sharp pole + small consolidation ----
  if (bars.length >= 15) {
    var consLen = 6;
    var poleLen = 8;
    var cons = bars.slice(-consLen);
    var pole = bars.slice(-(consLen + poleLen), -consLen);
    var poleMove = (pole[pole.length - 1].close - pole[0].close) / pole[0].close;
    var consHigh = Math.max.apply(null, cons.map(function (c) { return c.high; }));
    var consLow = Math.min.apply(null, cons.map(function (c) { return c.low; }));
    var poleSize = Math.abs(pole[pole.length - 1].close - pole[0].close);
    var compact = poleSize > 0 && (consHigh - consLow) / poleSize <= 0.6;
    if (compact && Math.abs(poleMove) >= poleMinMove) {
      var convergingCons = false;
      var firstHalf = cons.slice(0, 3), secondHalf = cons.slice(3);
      var h1c = Math.max.apply(null, firstHalf.map(function (c) { return c.high; }));
      var h2c = Math.max.apply(null, secondHalf.map(function (c) { return c.high; }));
      var l1c = Math.min.apply(null, firstHalf.map(function (c) { return c.low; }));
      var l2c = Math.min.apply(null, secondHalf.map(function (c) { return c.low; }));
      convergingCons = h2c < h1c && l2c > l1c;
      var kind = convergingCons ? 'pennant' : 'flag';
      var dir = poleMove > 0 ? 'bullish' : 'bearish';
      var name = (dir === 'bullish' ? 'bull-' : 'bear-') + kind;
      out.push(makeResult(name, dir,
        [{ index: pole[0].index, time: pole[0].time, price: pole[0].close, type: 'pole-start' },
         { index: cons[0].index, time: cons[0].time, price: consHigh, type: 'cons-high' },
         { index: cons[cons.length - 1].index, time: cons[cons.length - 1].time, price: consLow, type: 'cons-low' }],
        { kind: kind, high: consHigh, low: consLow },
        false, null, true));
    }
  }

  return out;
}

/**
 * Lookahead guard: patterns known as of bar asOfIndex. A pattern is included
 * only if all its anchors and its confirmation event (if any) occur at or
 * before asOfIndex. Computed by truncating data — deterministic prefix.
 */
function patternsAsOf(candles, asOfIndex, options) {
  var truncated = (Array.isArray(candles) ? candles : []).slice(0, asOfIndex + 1);
  return detectClassicalPatterns(truncated, options);
}

module.exports = {
  VERSION: VERSION,
  detectClassicalPatterns: detectClassicalPatterns,
  patternsAsOf: patternsAsOf
};

'use strict';

// Deterministic T-1 chart-pattern context for completed daily candles.
// The detector is intentionally conservative: it emits bounded context and a
// small score adjustment, but never creates an action, entry, target, or order.

const VERSION = 'classic-chart-patterns-v1';
const MAX_PATTERNS = 3;
const MAX_SCORE_ADJUSTMENT = 4;
const MIN_SCORE_ADJUSTMENT = -4;

function n(value) {
  value = Number(value);
  return Number.isFinite(value) ? value : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce(function(sum, value) { return sum + value; }, 0) / values.length : null;
}

function normalizeCandles(input) {
  return (Array.isArray(input) ? input : []).map(function(candle, index) {
    if (!candle || typeof candle !== 'object') return null;
    var open = n(candle.open), high = n(candle.high), low = n(candle.low), close = n(candle.close);
    if (open == null || high == null || low == null || close == null || high < low || high <= 0 || low <= 0) return null;
    return {
      index: index,
      time: candle.time || candle.date || null,
      open: open,
      high: high,
      low: low,
      close: close,
      volume: Math.max(0, n(candle.volume) || 0)
    };
  }).filter(Boolean).slice(-120).map(function(candle, index) {
    candle.index = index;
    return candle;
  });
}

function regression(points) {
  if (!Array.isArray(points) || points.length < 2) return { slope: 0, intercept: points && points[0] ? points[0].y : 0 };
  var sx = 0, sy = 0, sxx = 0, sxy = 0;
  points.forEach(function(point) {
    sx += point.x; sy += point.y; sxx += point.x * point.x; sxy += point.x * point.y;
  });
  var count = points.length;
  var denominator = count * sxx - sx * sx;
  var slope = denominator === 0 ? 0 : (count * sxy - sx * sy) / denominator;
  return { slope: slope, intercept: (sy - slope * sx) / count };
}

function bucketExtremes(candles, bucketCount) {
  if (candles.length < bucketCount * 2) return null;
  var highs = [], lows = [];
  for (var bucket = 0; bucket < bucketCount; bucket += 1) {
    var start = Math.floor(bucket * candles.length / bucketCount);
    var end = Math.max(start + 1, Math.floor((bucket + 1) * candles.length / bucketCount));
    var slice = candles.slice(start, end);
    var high = slice.reduce(function(best, candle) { return !best || candle.high > best.high ? candle : best; }, null);
    var low = slice.reduce(function(best, candle) { return !best || candle.low < best.low ? candle : best; }, null);
    highs.push({ x: high.index - candles[0].index, y: high.high });
    lows.push({ x: low.index - candles[0].index, y: low.low });
  }
  return { highs: highs, lows: lows };
}

function localPivots(candles, window) {
  var highs = [], lows = [];
  for (var index = window; index < candles.length - window; index += 1) {
    var candle = candles[index];
    var isHigh = true, isLow = true;
    for (var offset = 1; offset <= window; offset += 1) {
      if (candle.high < candles[index - offset].high || candle.high < candles[index + offset].high) isHigh = false;
      if (candle.low > candles[index - offset].low || candle.low > candles[index + offset].low) isLow = false;
    }
    if (isHigh) highs.push({ index:index, value:candle.high, time:candle.time });
    if (isLow) lows.push({ index:index, value:candle.low, time:candle.time });
  }
  return { highs:highs, lows:lows };
}

function addPattern(list, pattern) {
  if (!pattern || !pattern.type || !pattern.label) return;
  if (list.some(function(existing) { return existing.type === pattern.type; })) return;
  pattern.confidence = clamp(Number(pattern.confidence) || 0, 0, 1);
  pattern.score_adjustment = clamp(Math.round(Number(pattern.score_adjustment) || 0), MIN_SCORE_ADJUSTMENT, MAX_SCORE_ADJUSTMENT);
  pattern.status = pattern.status || 'candidate';
  pattern.rule_version = VERSION;
  list.push(pattern);
}

function trendlinePatterns(candles, patterns) {
  var sample = candles.slice(-36);
  if (sample.length < 20) return;
  var points = bucketExtremes(sample, 5);
  if (!points) return;
  var upper = regression(points.highs), lower = regression(points.lows);
  var reference = sample[sample.length - 1].close;
  var bars = sample.length - 1;
  var startUpper = upper.intercept, startLower = lower.intercept;
  var endUpper = upper.intercept + upper.slope * bars;
  var endLower = lower.intercept + lower.slope * bars;
  var startWidth = startUpper - startLower;
  var endWidth = endUpper - endLower;
  if (!(reference > 0 && startWidth > 0 && endWidth > 0)) return;

  var upperPct = upper.slope / reference;
  var lowerPct = lower.slope / reference;
  var contraction = endWidth / startWidth;
  var flat = 0.0008;
  var directional = 0.00045;
  var close = sample[sample.length - 1].close;
  var nearUpper = Math.abs(close - endUpper) / reference <= 0.035;
  var nearLower = Math.abs(close - endLower) / reference <= 0.035;

  if (contraction <= 0.82 && Math.abs(upperPct) <= flat && lowerPct >= directional) {
    addPattern(patterns, { type:'ASCENDING_TRIANGLE', label:'Ascending Triangle', category:'continuation', bias:'Bullish', confidence:nearUpper ? 0.86 : 0.74, score_adjustment:nearUpper ? 3 : 2, status:nearUpper ? 'near_breakout' : 'candidate', reason:'Resistance relatif datar sementara higher low mengerucut ke atas.' });
  }
  if (contraction <= 0.82 && Math.abs(lowerPct) <= flat && upperPct <= -directional) {
    addPattern(patterns, { type:'DESCENDING_TRIANGLE', label:'Descending Triangle', category:'continuation', bias:'Bearish', confidence:nearLower ? 0.86 : 0.74, score_adjustment:nearLower ? -3 : -2, status:nearLower ? 'near_breakdown' : 'candidate', reason:'Support relatif datar sementara lower high mengerucut ke bawah.' });
  }
  if (contraction <= 0.72 && upperPct <= -directional && lowerPct >= directional) {
    var breakoutBias = close > endUpper ? 'Bullish' : (close < endLower ? 'Bearish' : 'Bilateral');
    addPattern(patterns, { type:'SYMMETRICAL_TRIANGLE', label:'Symmetrical Triangle', category:'bilateral', bias:breakoutBias, confidence:0.78, score_adjustment:breakoutBias === 'Bullish' ? 2 : (breakoutBias === 'Bearish' ? -2 : 0), status:breakoutBias === 'Bilateral' ? 'compression' : 'breakout', reason:'Lower high dan higher low membentuk kompresi simetris.' });
  }
  if (contraction <= 0.82 && upperPct > directional && lowerPct > directional && lowerPct > upperPct * 1.2) {
    addPattern(patterns, { type:'RISING_WEDGE', label:'Rising Wedge', category:'reversal', bias:'Bearish', confidence:0.79, score_adjustment:-3, reason:'Dua trendline naik mengerucut; dorongan bawah naik lebih cepat daripada batas atas.' });
  }
  if (contraction <= 0.82 && upperPct < -directional && lowerPct < -directional && Math.abs(upperPct) > Math.abs(lowerPct) * 1.2) {
    addPattern(patterns, { type:'FALLING_WEDGE', label:'Falling Wedge', category:'reversal', bias:'Bullish', confidence:0.79, score_adjustment:3, reason:'Dua trendline turun mengerucut; tekanan pada batas atas melemah lebih cepat.' });
  }
}

function flagAndPennantPatterns(candles, patterns) {
  if (candles.length < 24) return;
  var consolidation = candles.slice(-9);
  var pole = candles.slice(-21, -9);
  if (pole.length < 10) return;
  var poleStart = pole[0].close, poleEnd = pole[pole.length - 1].close;
  var poleMove = (poleEnd - poleStart) / poleStart;
  var poleSize = Math.abs(poleEnd - poleStart);
  if (!(poleSize > 0)) return;
  var consHigh = Math.max.apply(null, consolidation.map(function(c) { return c.high; }));
  var consLow = Math.min.apply(null, consolidation.map(function(c) { return c.low; }));
  var compact = (consHigh - consLow) / poleSize <= 0.58;
  if (!compact) return;

  var closeLine = regression(consolidation.map(function(c, index) { return { x:index, y:c.close }; }));
  var slopePct = closeLine.slope / consolidation[consolidation.length - 1].close;
  var extremes = bucketExtremes(consolidation, 3);
  var converging = false;
  if (extremes) {
    var upper = regression(extremes.highs), lower = regression(extremes.lows);
    converging = upper.slope < 0 && lower.slope > 0;
  }

  if (poleMove >= 0.08) {
    if (converging) addPattern(patterns, { type:'BULL_PENNANT', label:'Bull Pennant', category:'continuation', bias:'Bullish', confidence:0.82, score_adjustment:3, reason:'Kenaikan kuat diikuti konsolidasi pendek yang mengerucut.' });
    else if (slopePct <= 0.0015 && slopePct >= -0.008) addPattern(patterns, { type:'BULL_FLAG', label:'Bull Flag', category:'continuation', bias:'Bullish', confidence:0.8, score_adjustment:3, reason:'Tiang naik kuat diikuti channel konsolidasi turun atau mendatar.' });
  }
  if (poleMove <= -0.08) {
    if (converging) addPattern(patterns, { type:'BEAR_PENNANT', label:'Bear Pennant', category:'continuation', bias:'Bearish', confidence:0.82, score_adjustment:-3, reason:'Penurunan kuat diikuti konsolidasi pendek yang mengerucut.' });
    else if (slopePct >= -0.0015 && slopePct <= 0.008) addPattern(patterns, { type:'BEAR_FLAG', label:'Bear Flag', category:'continuation', bias:'Bearish', confidence:0.8, score_adjustment:-3, reason:'Tiang turun kuat diikuti channel konsolidasi naik atau mendatar.' });
  }
}

function reversalPatterns(candles, patterns) {
  if (candles.length < 30) return;
  var pivots = localPivots(candles.slice(-90), 2);
  var highs = pivots.highs, lows = pivots.lows;
  var latest = candles[candles.length - 1].close;

  if (highs.length >= 2) {
    var h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
    if (h2.index - h1.index >= 5 && Math.abs(h1.value - h2.value) / mean([h1.value, h2.value]) <= 0.035) {
      var valleyCandles = candles.slice(h1.index + 1, h2.index);
      if (valleyCandles.length) {
        var valley = Math.min.apply(null, valleyCandles.map(function(c) { return c.low; }));
        var depth = (mean([h1.value, h2.value]) - valley) / mean([h1.value, h2.value]);
        if (depth >= 0.045) {
          var confirmedTop = latest < valley;
          addPattern(patterns, { type:'DOUBLE_TOP', label:'Double Top', category:'reversal', bias:'Bearish', confidence:confirmedTop ? 0.92 : 0.76, score_adjustment:confirmedTop ? -4 : -2, status:confirmedTop ? 'confirmed' : 'candidate', reason:'Dua puncak selevel dipisahkan lembah yang cukup dalam.' });
        }
      }
    }
  }

  if (lows.length >= 2) {
    var l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
    if (l2.index - l1.index >= 5 && Math.abs(l1.value - l2.value) / mean([l1.value, l2.value]) <= 0.035) {
      var peakCandles = candles.slice(l1.index + 1, l2.index);
      if (peakCandles.length) {
        var peak = Math.max.apply(null, peakCandles.map(function(c) { return c.high; }));
        var rise = (peak - mean([l1.value, l2.value])) / mean([l1.value, l2.value]);
        if (rise >= 0.045) {
          var confirmedBottom = latest > peak;
          addPattern(patterns, { type:'DOUBLE_BOTTOM', label:'Double Bottom', category:'reversal', bias:'Bullish', confidence:confirmedBottom ? 0.92 : 0.76, score_adjustment:confirmedBottom ? 4 : 2, status:confirmedBottom ? 'confirmed' : 'candidate', reason:'Dua lembah selevel dipisahkan pantulan yang cukup tinggi.' });
        }
      }
    }
  }

  if (highs.length >= 3) {
    var hs = highs.slice(-3), shoulders = mean([hs[0].value, hs[2].value]);
    if (hs[1].value >= shoulders * 1.045 && Math.abs(hs[0].value - hs[2].value) / shoulders <= 0.05) {
      var neck1 = candles.slice(hs[0].index + 1, hs[1].index).reduce(function(best, c) { return !best || c.low < best.low ? c : best; }, null);
      var neck2 = candles.slice(hs[1].index + 1, hs[2].index).reduce(function(best, c) { return !best || c.low < best.low ? c : best; }, null);
      if (neck1 && neck2) {
        var neckline = mean([neck1.low, neck2.low]);
        var confirmedHs = latest < neckline;
        addPattern(patterns, { type:'HEAD_AND_SHOULDERS', label:'Head and Shoulders', category:'reversal', bias:'Bearish', confidence:confirmedHs ? 0.94 : 0.8, score_adjustment:confirmedHs ? -4 : -3, status:confirmedHs ? 'confirmed' : 'candidate', reason:'Tiga puncak membentuk bahu–kepala–bahu dengan neckline terukur.' });
      }
    }
  }

  if (lows.length >= 3) {
    var ihs = lows.slice(-3), invShoulders = mean([ihs[0].value, ihs[2].value]);
    if (ihs[1].value <= invShoulders * 0.955 && Math.abs(ihs[0].value - ihs[2].value) / invShoulders <= 0.05) {
      var invNeck1 = candles.slice(ihs[0].index + 1, ihs[1].index).reduce(function(best, c) { return !best || c.high > best.high ? c : best; }, null);
      var invNeck2 = candles.slice(ihs[1].index + 1, ihs[2].index).reduce(function(best, c) { return !best || c.high > best.high ? c : best; }, null);
      if (invNeck1 && invNeck2) {
        var invNeckline = mean([invNeck1.high, invNeck2.high]);
        var confirmedIhs = latest > invNeckline;
        addPattern(patterns, { type:'INVERSE_HEAD_AND_SHOULDERS', label:'Inverse Head and Shoulders', category:'reversal', bias:'Bullish', confidence:confirmedIhs ? 0.94 : 0.8, score_adjustment:confirmedIhs ? 4 : 3, status:confirmedIhs ? 'confirmed' : 'candidate', reason:'Tiga lembah membentuk inverse shoulder–head–shoulder dengan neckline terukur.' });
      }
    }
  }
}

function cupAndHandlePatterns(candles, patterns) {
  var sample = candles.slice(-90);
  if (sample.length < 45) return;
  var length = sample.length;
  var leftEnd = Math.floor(length * 0.3);
  var rightStart = Math.floor(length * 0.55);
  var rightEnd = Math.floor(length * 0.86);
  var left = sample.slice(0, leftEnd).reduce(function(best, c) { return !best || c.high > best.high ? c : best; }, null);
  var bottomSlice = sample.slice(Math.max(1, left.index + 3), rightStart);
  var bottom = bottomSlice.reduce(function(best, c) { return !best || c.low < best.low ? c : best; }, null);
  var right = sample.slice(rightStart, rightEnd).reduce(function(best, c) { return !best || c.high > best.high ? c : best; }, null);
  if (left && bottom && right && bottom.index > left.index && right.index > bottom.index) {
    var rim = mean([left.high, right.high]);
    var rimDiff = Math.abs(left.high - right.high) / rim;
    var depth = (rim - bottom.low) / rim;
    var handle = sample.slice(right.index + 1);
    if (handle.length >= 4) {
      var handleLow = Math.min.apply(null, handle.map(function(c) { return c.low; }));
      var handleDepth = (right.high - handleLow) / right.high;
      var latest = sample[sample.length - 1].close;
      if (rimDiff <= 0.055 && depth >= 0.1 && depth <= 0.38 && handleDepth >= 0.015 && handleDepth <= 0.13 && handleLow > bottom.low + (rim - bottom.low) * 0.45) {
        var confirmed = latest > rim;
        addPattern(patterns, { type:'CUP_AND_HANDLE', label:'Cup and Handle', category:'continuation', bias:'Bullish', confidence:confirmed ? 0.94 : 0.82, score_adjustment:confirmed ? 4 : 3, status:confirmed ? 'confirmed' : 'candidate', reason:'Rim kiri dan kanan selevel, dasar membulat, lalu handle dangkal terbentuk.' });
      }
    }
  }

  var leftLow = sample.slice(0, leftEnd).reduce(function(best, c) { return !best || c.low < best.low ? c : best; }, null);
  var topSlice = sample.slice(Math.max(1, leftLow.index + 3), rightStart);
  var top = topSlice.reduce(function(best, c) { return !best || c.high > best.high ? c : best; }, null);
  var rightLow = sample.slice(rightStart, rightEnd).reduce(function(best, c) { return !best || c.low < best.low ? c : best; }, null);
  if (leftLow && top && rightLow && top.index > leftLow.index && rightLow.index > top.index) {
    var inverseRim = mean([leftLow.low, rightLow.low]);
    var inverseDiff = Math.abs(leftLow.low - rightLow.low) / inverseRim;
    var inverseDepth = (top.high - inverseRim) / inverseRim;
    var inverseHandle = sample.slice(rightLow.index + 1);
    if (inverseHandle.length >= 4) {
      var handleHigh = Math.max.apply(null, inverseHandle.map(function(c) { return c.high; }));
      var handleRise = (handleHigh - rightLow.low) / rightLow.low;
      var latestInverse = sample[sample.length - 1].close;
      if (inverseDiff <= 0.055 && inverseDepth >= 0.1 && inverseDepth <= 0.38 && handleRise >= 0.015 && handleRise <= 0.13 && handleHigh < top.high - (top.high - inverseRim) * 0.45) {
        var confirmedInverse = latestInverse < inverseRim;
        addPattern(patterns, { type:'INVERTED_CUP_AND_HANDLE', label:'Inverted Cup and Handle', category:'continuation', bias:'Bearish', confidence:confirmedInverse ? 0.94 : 0.82, score_adjustment:confirmedInverse ? -4 : -3, status:confirmedInverse ? 'confirmed' : 'candidate', reason:'Rim bawah selevel, puncak membulat, lalu handle naik dangkal terbentuk.' });
      }
    }
  }
}

function gapPatterns(candles, patterns) {
  if (candles.length < 2) return;
  var previous = candles[candles.length - 2], latest = candles[candles.length - 1];
  var previousRange = Math.max(1e-9, previous.high - previous.low);
  if (latest.low > previous.high * 1.008) {
    var gapUpPct = (latest.low - previous.high) / previous.close;
    addPattern(patterns, { type:'GAP_UP', label:'Gap Up', category:'gap', bias:'Bullish', confidence:clamp(0.65 + gapUpPct * 4, 0.65, 0.88), score_adjustment:gapUpPct >= 0.03 ? 2 : 1, reason:'Low candle terbaru berada di atas high candle sebelumnya.' });
  }
  if (latest.high < previous.low * 0.992) {
    var gapDownPct = (previous.low - latest.high) / previous.close;
    addPattern(patterns, { type:'GAP_DOWN', label:'Gap Down', category:'gap', bias:'Bearish', confidence:clamp(0.65 + gapDownPct * 4, 0.65, 0.88), score_adjustment:gapDownPct >= 0.03 ? -2 : -1, reason:'High candle terbaru berada di bawah low candle sebelumnya.' });
  }
  void previousRange;
}

function detectClassicChartPatterns(input, options) {
  var candles = normalizeCandles(input);
  var patterns = [];
  var diagnostics = [];
  if (candles.length < 20) {
    return { rule_version:VERSION, patterns:[], primary_pattern:null, score_adjustment:0, diagnostics:['history_insufficient'] };
  }

  trendlinePatterns(candles, patterns);
  flagAndPennantPatterns(candles, patterns);
  reversalPatterns(candles, patterns);
  cupAndHandlePatterns(candles, patterns);
  gapPatterns(candles, patterns);

  patterns.sort(function(a, b) {
    var confirmed = (b.status === 'confirmed') - (a.status === 'confirmed');
    if (confirmed) return confirmed;
    var confidence = b.confidence - a.confidence;
    if (confidence) return confidence;
    return Math.abs(b.score_adjustment) - Math.abs(a.score_adjustment);
  });
  patterns = patterns.slice(0, MAX_PATTERNS);

  var positive = patterns.filter(function(pattern) { return pattern.score_adjustment > 0; }).reduce(function(best, pattern) { return Math.max(best, pattern.score_adjustment); }, 0);
  var negative = patterns.filter(function(pattern) { return pattern.score_adjustment < 0; }).reduce(function(worst, pattern) { return Math.min(worst, pattern.score_adjustment); }, 0);
  var scoreAdjustment = Math.abs(negative) > positive ? negative : positive;
  scoreAdjustment = clamp(scoreAdjustment, MIN_SCORE_ADJUSTMENT, MAX_SCORE_ADJUSTMENT);

  if (!patterns.length) diagnostics.push('no_conservative_classic_pattern');
  if (options && options.ticker) diagnostics.push('ticker:' + String(options.ticker).toUpperCase());
  return {
    rule_version:VERSION,
    patterns:patterns,
    primary_pattern:patterns[0] || null,
    score_adjustment:scoreAdjustment,
    diagnostics:diagnostics
  };
}

module.exports = {
  VERSION: VERSION,
  MAX_PATTERNS: MAX_PATTERNS,
  MAX_SCORE_ADJUSTMENT: MAX_SCORE_ADJUSTMENT,
  MIN_SCORE_ADJUSTMENT: MIN_SCORE_ADJUSTMENT,
  detectClassicChartPatterns: detectClassicChartPatterns,
  normalizeCandles: normalizeCandles,
  localPivots: localPivots
};

'use strict';

// F1 core detector: auto candlestick patterns — doji, hammer, shooting star,
// bullish/bearish engulfing, morning/evening star. Body/wick ratio thresholds
// configurable. Output per bar: {index, time, pattern, direction, confidence}.

const VERSION = 'chart-core-candlestick-patterns-v1';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

var DEFAULTS = {
  dojiBodyRatio: 0.1,        // body <= 10% of total range
  hammerBodyRatio: 0.35,     // body <= 35% of range
  hammerLowerWickRatio: 2,   // lower wick >= 2x body
  starBodyRatio: 0.35,       // engulfing body >= 35% of prior body? no: body vs range
  engulfingBodyRatio: 0.5    // engulfing body >= 50% of prior body
};

function body(c) { return Math.abs(c.close - c.open); }
function range(c) { return c.high - c.low; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function isBull(c) { return c.close > c.open; }
function isBear(c) { return c.close < c.open; }

function conf(ratio, ideal) {
  // Simple deterministic confidence: closer ratio to ideal => higher.
  return Math.max(0, Math.min(1, 1 - Math.abs(ratio - ideal)));
}

/**
 * Detect candlestick patterns per bar.
 * @param {Array<{open,high,low,close,time?}>} candles
 * @param {object} [thresholds] overrides of DEFAULTS
 * @returns {Array<{index, time, pattern, direction:'bullish'|'bearish'|'neutral', confidence}>}
 */
function detectCandlestickPatterns(candles, thresholds) {
  var t = Object.assign({}, DEFAULTS, thresholds || {});
  var bars = (Array.isArray(candles) ? candles : []).filter(function (c) {
    return c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close);
  });
  var out = [];

  function emit(index, pattern, direction, confidence) {
    var c = bars[index];
    out.push({
      index: index,
      time: c.time !== undefined ? c.time : index,
      pattern: pattern,
      direction: direction,
      confidence: Math.round(confidence * 1000) / 1000
    });
  }

  for (var i = 0; i < bars.length; i += 1) {
    var c = bars[i];
    var r = range(c);
    if (r <= 0) continue;
    var b = body(c);
    var bodyRatio = b / r;

    // Doji: tiny body relative to range.
    if (bodyRatio <= t.dojiBodyRatio) {
      emit(i, 'doji', 'neutral', conf(bodyRatio, 0));
      continue;
    }

    // Hammer: small body top, long lower wick (single-bar; context-free).
    if (bodyRatio <= t.hammerBodyRatio && lowerWick(c) >= t.hammerLowerWickRatio * b && upperWick(c) <= b) {
      emit(i, 'hammer', 'bullish', conf(bodyRatio, 0.2));
      continue;
    }

    // Shooting star: small body bottom, long upper wick.
    if (bodyRatio <= t.hammerBodyRatio && upperWick(c) >= t.hammerLowerWickRatio * b && lowerWick(c) <= b) {
      emit(i, 'shooting-star', 'bearish', conf(bodyRatio, 0.2));
      continue;
    }

    // Engulfing (needs prior bar).
    if (i >= 1) {
      var p = bars[i - 1];
      var pb = body(p);
      if (pb > 0) {
        if (isBear(p) && isBull(c) && c.close >= p.open && c.open <= p.close && b >= t.engulfingBodyRatio * pb) {
          emit(i, 'bullish-engulfing', 'bullish', conf(b / pb, 1.5));
          continue;
        }
        if (isBull(p) && isBear(c) && c.close <= p.open && c.open >= p.close && b >= t.engulfingBodyRatio * pb) {
          emit(i, 'bearish-engulfing', 'bearish', conf(b / pb, 1.5));
          continue;
        }
      }
    }

    // Morning / evening star (3 bars).
    if (i >= 2) {
      var b1 = bars[i - 2], b2 = bars[i - 1], b3 = bars[i];
      var b2r = range(b2);
      var b2body = b2r > 0 ? body(b2) / b2r : 1;
      if (isBear(b1) && b2body <= t.dojiBodyRatio * 2 && isBull(b3) && b3.close > (b1.open + b1.close) / 2) {
        emit(i, 'morning-star', 'bullish', conf(b2body, 0));
        continue;
      }
      if (isBull(b1) && b2body <= t.dojiBodyRatio * 2 && isBear(b3) && b3.close < (b1.open + b1.close) / 2) {
        emit(i, 'evening-star', 'bearish', conf(b2body, 0));
        continue;
      }
    }
  }
  return out;
}

module.exports = { VERSION: VERSION, detectCandlestickPatterns: detectCandlestickPatterns, DEFAULTS: DEFAULTS };

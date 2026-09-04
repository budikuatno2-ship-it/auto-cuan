/**
 * Candle Pattern Engine V1
 * 
 * Detects practical candlestick patterns from OHLCV data.
 * Used as confirmation layer for existing screeners:
 *   - Day Trade Screener
 *   - Konglo Swing Screener
 *   - Non-Konglo Swing Screener
 *
 * Input: array of candles [{open, high, low, close, volume}] (oldest first)
 * Output: { pattern, bias, strength, confirmation, risk, note }
 *
 * No AI. No DB. No new columns. Pure runtime detection.
 */

'use strict';

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Detect candle pattern from last 3 candles + context.
 * @param {Array} candles - [{open, high, low, close, volume}] oldest first, min 1
 * @param {Object} ctx - Optional context: { volumeAvg20, support, resistance, ma20, rsi14, changePct }
 * @returns {Object} { pattern, bias, strength, confirmation, risk, note }
 */
function detectPattern(candles, ctx) {
  if (!candles || !Array.isArray(candles) || candles.length < 1) return empty();
  ctx = ctx || {};

  var len = candles.length;
  var c0 = candles[len - 1]; // latest
  var c1 = len >= 2 ? candles[len - 2] : null;
  var c2 = len >= 3 ? candles[len - 3] : null;

  if (!c0 || c0.open == null || c0.close == null || c0.high == null || c0.low == null) return empty();

  // Volume ratio for strength/confirmation
  var volAvg = ctx.volumeAvg20 || null;
  var volRatio = (volAvg && volAvg > 0 && c0.volume > 0) ? c0.volume / volAvg : null;

  // Try multi-candle first (higher priority), then single
  var pat = null;
  if (c2 && c1) pat = detectThreeCandle(c2, c1, c0);
  if (!pat && c1) pat = detectTwoCandle(c1, c0);
  if (!pat && c1) pat = detectContinuation(c1, c0, ctx, volRatio);
  if (!pat) pat = detectSingle(c0, ctx, c1);

  if (!pat) return empty();

  var strength = calcStrength(pat, volRatio);
  var confirmation = calcConfirmation(pat, ctx, volRatio);
  var risk = calcRisk(pat, ctx);
  var note = buildNote(pat, volRatio, risk);

  return {
    pattern: pat.name,
    bias: pat.bias,
    strength: strength,
    confirmation: confirmation,
    risk: risk,
    note: note
  };
}

// ============================================================
// THREE-CANDLE PATTERNS
// ============================================================

function detectThreeCandle(c2, c1, c0) {
  var body2 = bodySize(c2), body1 = bodySize(c1), body0 = bodySize(c0);
  var range2 = c2.high - c2.low, range1 = c1.high - c1.low, range0 = c0.high - c0.low;
  var bull2 = c2.close > c2.open, bull1 = c1.close > c1.open, bull0 = c0.close > c0.open;

  // Morning Star: red + small + green, 3rd recovers past midpoint of 1st
  if (!bull2 && bull0 && body2 > 0 && body0 > 0) {
    var small1 = body1 < body2 * 0.4 && body1 < body0 * 0.4;
    var midC2 = (c2.open + c2.close) / 2;
    if (small1 && c0.close > midC2) {
      return { name: 'Morning Star', bias: 'Bullish', weight: 3 };
    }
  }

  // Evening Star: green + small + red, 3rd drops past midpoint of 1st
  if (bull2 && !bull0 && body2 > 0 && body0 > 0) {
    var small1e = body1 < body2 * 0.4 && body1 < body0 * 0.4;
    var midC2e = (c2.open + c2.close) / 2;
    if (small1e && c0.close < midC2e) {
      return { name: 'Evening Star', bias: 'Bearish', weight: 3 };
    }
  }

  // Three White Soldiers: 3 consecutive strong green, each closing higher
  if (bull2 && bull1 && bull0) {
    var bigBodies = body2 > range2 * 0.5 && body1 > range1 * 0.5 && body0 > range0 * 0.5;
    var ascending = c1.close > c2.close && c0.close > c1.close;
    var opensInBody = c1.open >= c2.open && c1.open <= c2.close && c0.open >= c1.open && c0.open <= c1.close;
    if (bigBodies && ascending && opensInBody) {
      return { name: 'Three White Soldiers', bias: 'Bullish', weight: 3 };
    }
  }

  // Three Black Crows: 3 consecutive strong red, each closing lower
  if (!bull2 && !bull1 && !bull0) {
    var bigB = body2 > range2 * 0.5 && body1 > range1 * 0.5 && body0 > range0 * 0.5;
    var desc = c1.close < c2.close && c0.close < c1.close;
    var oInBody = c1.open <= c2.open && c1.open >= c2.close && c0.open <= c1.open && c0.open >= c1.close;
    if (bigB && desc && oInBody) {
      return { name: 'Three Black Crows', bias: 'Bearish', weight: 3 };
    }
  }

  return null;
}

// ============================================================
// TWO-CANDLE PATTERNS
// ============================================================

function detectTwoCandle(c1, c0) {
  var body1 = bodySize(c1), body0 = bodySize(c0);
  var range1 = c1.high - c1.low, range0 = c0.high - c0.low;
  var bull1 = c1.close > c1.open, bull0 = c0.close > c0.open;

  // Bullish Engulfing: prev red, current green engulfs prev body
  if (!bull1 && bull0 && body0 > body1 && c0.open <= c1.close && c0.close >= c1.open) {
    return { name: 'Bullish Engulfing', bias: 'Bullish', weight: 2.5 };
  }

  // Bearish Engulfing: prev green, current red engulfs prev body
  if (bull1 && !bull0 && body0 > body1 && c0.open >= c1.close && c0.close <= c1.open) {
    return { name: 'Bearish Engulfing', bias: 'Bearish', weight: 2.5 };
  }

  // Bullish Harami: prev large red, current small green inside
  if (!bull1 && bull0 && body1 > 0 && body0 < body1 * 0.6 && c0.open >= c1.close && c0.close <= c1.open) {
    return { name: 'Bullish Harami', bias: 'Bullish', weight: 1.5 };
  }

  // Bearish Harami: prev large green, current small red inside
  if (bull1 && !bull0 && body1 > 0 && body0 < body1 * 0.6 && c0.open <= c1.close && c0.close >= c1.open) {
    return { name: 'Bearish Harami', bias: 'Bearish', weight: 1.5 };
  }

  // Tweezer Bottom: similar lows, first red second green
  if (!bull1 && bull0 && range1 > 0 && range0 > 0) {
    var lowDiff = Math.abs(c1.low - c0.low);
    var avgR = (range1 + range0) / 2;
    if (avgR > 0 && lowDiff / avgR < 0.05) {
      return { name: 'Tweezer Bottom', bias: 'Bullish', weight: 1.5 };
    }
  }

  // Tweezer Top: similar highs, first green second red
  if (bull1 && !bull0 && range1 > 0 && range0 > 0) {
    var highDiff = Math.abs(c1.high - c0.high);
    var avgRT = (range1 + range0) / 2;
    if (avgRT > 0 && highDiff / avgRT < 0.05) {
      return { name: 'Tweezer Top', bias: 'Bearish', weight: 1.5 };
    }
  }

  return null;
}

// ============================================================
// CONTINUATION / CONTEXT PATTERNS
// ============================================================

function detectContinuation(c1, c0, ctx, volRatio) {
  var body0 = bodySize(c0);
  var range0 = c0.high - c0.low;
  var bull0 = c0.close > c0.open;
  var bodyRatio = range0 > 0 ? body0 / range0 : 0;
  var upperShadow = c0.high - Math.max(c0.open, c0.close);

  // Strong breakout candle: large green + volume + close near high
  if (bull0 && bodyRatio > 0.7 && volRatio != null && volRatio >= 1.5) {
    var closeNearHigh = range0 > 0 ? (c0.high - c0.close) / range0 < 0.1 : false;
    if (closeNearHigh) {
      return { name: 'Strong breakout candle', bias: 'Bullish', weight: 2.5 };
    }
  }

  // Rejection candle: long upper shadow, body in lower portion
  if (range0 > 0 && upperShadow > body0 * 1.8 && upperShadow > range0 * 0.5) {
    var bodyInLower = (Math.max(c0.open, c0.close) - c0.low) < range0 * 0.4;
    if (bodyInLower) {
      return { name: 'Rejection candle', bias: 'Bearish', weight: 2 };
    }
  }

  // Failed breakout candle: makes new high but closes near low (red)
  if (!bull0 && range0 > 0 && c0.high > c1.high) {
    var openNearHigh = (c0.high - c0.open) / range0 < 0.2;
    var closeNearLow = (c0.close - c0.low) / range0 < 0.25;
    if (openNearHigh && closeNearLow && bodyRatio > 0.5) {
      return { name: 'Failed breakout candle', bias: 'Bearish', weight: 2 };
    }
  }

  // Distribution candle: red + high volume after green prev
  if (!bull0 && volRatio != null && volRatio >= 1.5 && bodyRatio > 0.5) {
    var prevGreen = c1.close > c1.open;
    if (prevGreen && c0.close < c1.open) {
      return { name: 'Distribution candle', bias: 'Bearish', weight: 2.5 };
    }
  }

  return null;
}

// ============================================================
// SINGLE-CANDLE PATTERNS
// ============================================================

function detectSingle(c0, ctx, c1) {
  var body = bodySize(c0);
  var range = c0.high - c0.low;
  if (range === 0) return { name: 'Doji', bias: 'Neutral', weight: 0.5 };

  var bodyRatio = body / range;
  var upperShadow = c0.high - Math.max(c0.open, c0.close);
  var lowerShadow = Math.min(c0.open, c0.close) - c0.low;
  var upperR = upperShadow / range;
  var lowerR = lowerShadow / range;
  var bull = c0.close > c0.open;

  // Doji variants (body < 10% of range)
  if (bodyRatio < 0.1) {
    if (lowerR > 0.6 && upperR < 0.15) return { name: 'Dragonfly Doji', bias: 'Bullish', weight: 1.5 };
    if (upperR > 0.6 && lowerR < 0.15) return { name: 'Gravestone Doji', bias: 'Bearish', weight: 1.5 };
    return { name: 'Doji', bias: 'Neutral', weight: 0.5 };
  }

  // Spinning Top (small body, both shadows)
  if (bodyRatio < 0.3 && upperR > 0.2 && lowerR > 0.2) {
    return { name: 'Spinning Top', bias: 'Neutral', weight: 0.5 };
  }

  // Marubozu (body > 85% of range)
  if (bodyRatio > 0.85) {
    if (bull) return { name: 'Bullish Marubozu', bias: 'Bullish', weight: 2 };
    return { name: 'Bearish Marubozu', bias: 'Bearish', weight: 2 };
  }

  // Context-aware trend helper for Hammer vs Hanging Man and Inverted Hammer vs Shooting Star (BUG-042)
  var isAtSupportOrPullback = false;
  if (ctx) {
    var lastP = ctx.lastPrice != null ? ctx.lastPrice : c0.close;
    if (ctx.support && (c0.low <= ctx.support * 1.03 || lastP <= ctx.support * 1.03)) {
      isAtSupportOrPullback = true;
    } else if (ctx.changePct != null && ctx.changePct <= 0) {
      isAtSupportOrPullback = true;
    } else if (c1 && c0.close <= c1.close) {
      isAtSupportOrPullback = true;
    }
  }

  // Hammer / Hanging Man: long lower shadow, small body near top
  if (lowerShadow >= body * 2 && upperR < 0.15 && bodyRatio < 0.4) {
    if (bull || isAtSupportOrPullback) return { name: 'Hammer', bias: 'Bullish', weight: 1.5 };
    return { name: 'Hanging Man', bias: 'Bearish', weight: 1.5 };
  }

  // Inverted Hammer / Shooting Star: long upper shadow, small body near bottom
  if (upperShadow >= body * 2 && lowerR < 0.15 && bodyRatio < 0.4) {
    if (bull || isAtSupportOrPullback) return { name: 'Inverted Hammer', bias: 'Bullish', weight: 1 };
    return { name: 'Shooting Star', bias: 'Bearish', weight: 1.5 };
  }

  // Fallback: basic candle
  if (bull) return { name: 'Bullish candle', bias: 'Bullish', weight: 1 };
  return { name: 'Bearish candle', bias: 'Bearish', weight: 1 };
}

// ============================================================
// STRENGTH, CONFIRMATION, RISK
// ============================================================

function calcStrength(pat, volRatio) {
  var s = pat.weight || 1;
  if (volRatio != null) {
    if (volRatio >= 2.0) s += 1.5;
    else if (volRatio >= 1.5) s += 1;
    else if (volRatio >= 1.2) s += 0.5;
    else if (volRatio < 0.5) s -= 1;
  }
  if (s >= 3.5) return 'Strong';
  if (s >= 2.0) return 'Medium';
  return 'Weak';
}

function calcConfirmation(pat, ctx, volRatio) {
  if (pat.bias === 'Neutral') return 'No confirmation';
  if (pat.bias === 'Bearish') return 'No confirmation';

  var hasVol = volRatio != null && volRatio >= 1.2;
  var nearSupport = isNear(ctx.lastPrice, ctx.support, 0.03) || isNear(ctx.lastPrice, ctx.ma20, 0.03);

  if (pat.name === 'Strong breakout candle' || (pat.name === 'Bullish Marubozu' && hasVol)) {
    return 'Breakout confirmation';
  }
  if (nearSupport && (pat.name === 'Hammer' || pat.name === 'Dragonfly Doji' || pat.name === 'Bullish Engulfing' || pat.name === 'Morning Star' || pat.name === 'Tweezer Bottom')) {
    return 'Rebound confirmation';
  }
  if ((pat.name === 'Three White Soldiers') && hasVol) {
    return 'Continuation confirmation';
  }
  if (hasVol || nearSupport) return 'Bullish confirmation';
  return 'Bullish confirmation';
}

function calcRisk(pat, ctx) {
  if (pat.bias === 'Neutral') return 'Indecision';
  if (pat.bias === 'Bearish') {
    if (pat.name === 'Shooting Star' || pat.name === 'Gravestone Doji' || pat.name === 'Rejection candle' || pat.name === 'Failed breakout candle') return 'Rejection';
    if (pat.name === 'Distribution candle') return 'Distribution';
    return 'Rejection';
  }
  // Bullish: check overextended
  if (ctx.rsi14 != null && ctx.rsi14 > 75) return 'Overextended';
  if (ctx.changePct != null && ctx.changePct > 7) return 'Overextended';
  return 'None';
}

// ============================================================
// NOTE GENERATION (Indonesian, cautious language)
// ============================================================

function buildNote(pat, volRatio, risk) {
  var n = pat.name;
  var volDesc = '';
  if (volRatio != null) {
    if (volRatio >= 2.0) volDesc = 'volume sangat tinggi';
    else if (volRatio >= 1.5) volDesc = 'volume naik';
    else if (volRatio >= 1.2) volDesc = 'volume cukup';
    else if (volRatio < 0.5) volDesc = 'volume sangat lemah';
  }

  if (n === 'Bullish Engulfing') return volDesc ? 'Bullish Engulfing + ' + volDesc + ', konfirmasi entry lebih kuat.' : 'Bullish Engulfing, potensi reversal butuh konfirmasi volume.';
  if (n === 'Bearish Engulfing') return volDesc && volRatio >= 1.2 ? 'Bearish Engulfing + ' + volDesc + ', tekanan jual dominan.' : 'Bearish Engulfing, rawan koreksi lanjutan.';
  if (n === 'Hammer') return 'Hammer dekat support, potensi rebound butuh konfirmasi.';
  if (n === 'Dragonfly Doji') return 'Dragonfly Doji dekat support, potensi rebound butuh konfirmasi.';
  if (n === 'Shooting Star') return 'Shooting Star setelah kenaikan, rawan pullback.';
  if (n === 'Gravestone Doji') return 'Gravestone Doji setelah kenaikan, rawan pullback.';
  if (n === 'Morning Star') return 'Morning Star, sinyal reversal bullish cukup kuat.';
  if (n === 'Evening Star') return 'Evening Star, sinyal reversal bearish, rawan koreksi.';
  if (n === 'Three White Soldiers') return risk === 'Overextended' ? 'Three White Soldiers tapi sudah extended, rawan profit taking.' : 'Three White Soldiers, momentum bullish kuat.';
  if (n === 'Three Black Crows') return 'Three Black Crows, tekanan jual berlanjut, hindari chase.';
  if (n === 'Bullish Marubozu') return volDesc ? 'Bullish Marubozu + ' + volDesc + ', buyer dominan.' : 'Bullish Marubozu, buyer dominan.';
  if (n === 'Bearish Marubozu') return volDesc ? 'Bearish Marubozu + ' + volDesc + ', seller dominan.' : 'Bearish Marubozu, seller dominan.';
  if (n === 'Strong breakout candle') return 'Strong breakout candle + volume konfirmasi, momentum kuat.';
  if (n === 'Rejection candle') return 'Rejection candle shadow panjang atas, tekanan jual di atas.';
  if (n === 'Distribution candle') return 'Distribution candle ' + (volDesc || 'volume besar') + ', hindari chase.';
  if (n === 'Failed breakout candle') return 'Failed breakout, harga gagal sustain di high, rawan reversal.';
  if (n === 'Doji') return 'Doji setelah pergerakan, momentum belum tegas.';
  if (n === 'Spinning Top') return 'Spinning Top, momentum lemah, tunggu arah jelas.';
  if (n === 'Tweezer Bottom') return 'Tweezer Bottom, potensi double bottom butuh konfirmasi.';
  if (n === 'Tweezer Top') return 'Tweezer Top, potensi double top, rawan koreksi.';
  if (n === 'Bullish Harami') return 'Bullish Harami, tekanan jual mereda.';
  if (n === 'Bearish Harami') return 'Bearish Harami, tekanan beli melemah.';
  if (n === 'Hanging Man') return 'Hanging Man setelah uptrend, waspada reversal.';
  if (n === 'Inverted Hammer') return 'Inverted Hammer, potensi rebound butuh konfirmasi.';
  if (pat.bias === 'Bullish') return 'Candle bullish, butuh konfirmasi lanjutan.';
  if (pat.bias === 'Bearish') return 'Candle bearish, waspada tekanan jual.';
  return 'Momentum belum jelas, tunggu sinyal lebih kuat.';
}

// ============================================================
// HELPERS
// ============================================================

function bodySize(c) { return Math.abs(c.close - c.open); }

function isNear(price, level, pct) {
  if (price == null || level == null || level <= 0) return false;
  return Math.abs(price - level) / level <= (pct || 0.03);
}

function empty() {
  return { pattern: null, bias: null, strength: null, confirmation: 'No confirmation', risk: 'None', note: null };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  detectPattern: detectPattern
};

'use strict';

/**
 * Trade Plan V2 — Candle Body / Wick Structure Diagnostics (OBSERVABLE only)
 * ==========================================================================
 *
 * ADDITIVE extension of the Trade Plan V2 shadow engine. This module computes
 * normalized, observable candle-structure diagnostics from EXISTING OHLC fields
 * and classifies common observable patterns. It NEVER invents OHLC values — when
 * high/low/open are unavailable it returns `available: false` and classifies
 * nothing.
 *
 * It does NOT replace or weaken any candle body/wick logic already used by the
 * screeners; it is a separate, read-only diagnostic consumed only by the shared
 * trade_plan_v2 object.
 *
 * Pure + deterministic: no wall-clock, no IO, no mutation.
 */

// Observable candle-structure classifications.
const CANDLE_PATTERN = Object.freeze({
  STRONG_BODY_CONTINUATION: 'STRONG_BODY_CONTINUATION',
  LOWER_WICK_RECLAIM: 'LOWER_WICK_RECLAIM',
  UPPER_WICK_REJECTION: 'UPPER_WICK_REJECTION',
  INDECISION: 'INDECISION',
  FULL_BODY_BREAKOUT: 'FULL_BODY_BREAKOUT',
  FAILED_BREAKOUT_WICK: 'FAILED_BREAKOUT_WICK',
  FAILED_BREAKDOWN_WICK: 'FAILED_BREAKDOWN_WICK',
  NEUTRAL: 'NEUTRAL',
  NO_OHLC: 'NO_OHLC'
});

// Classification thresholds (documented, deterministic).
const THRESH = Object.freeze({
  STRONG_BODY_RATIO: 0.60,     // body/range for a strong-bodied candle
  FULL_BODY_RATIO: 0.80,       // body/range for a marubozu-like full body
  FULL_BODY_CLOSE_LOC: 0.85,   // close in the top of range for a full-body breakout
  LONG_WICK_TO_BODY: 1.00,     // wick >= body => "long" wick
  INDECISION_BODY_RATIO: 0.30, // body/range at/under which the bar is indecisive
  CLOSE_UPPER_HALF: 0.50,      // close location marking the upper/lower half
  RECLAIM_CLOSE_LOC: 0.50      // close location required for a lower-wick reclaim
});

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNum(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const n = num(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/**
 * Compute normalized candle-structure diagnostics for a single bar.
 *
 * Requires observable OHLC. A bar carrying only a close is `available: false`
 * (no OHLC invented). When high === low (zero range) ratios that need a range
 * are returned as null rather than fabricated.
 *
 * @param {object|number} bar { open, high, low, close } (aliases o/h/l/c accepted)
 * @returns {object} diagnostics
 */
function analyzeCandleStructure(bar) {
  if (bar == null || typeof bar === 'number') {
    return { available: false, reason: 'NO_OHLC' };
  }
  const close = firstNum(bar, ['close', 'c', 'last', 'price']);
  const open = firstNum(bar, ['open', 'o']);
  const high = firstNum(bar, ['high', 'h']);
  const low = firstNum(bar, ['low', 'l']);

  // Genuine OHLC required — do not invent from a lone close.
  if (close === null || open === null || high === null || low === null) {
    return { available: false, reason: 'NO_OHLC' };
  }
  if (high < low || high < close || high < open || low > close || low > open) {
    return { available: false, reason: 'INVALID_OHLC' };
  }

  const range = high - low;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const direction = close > open ? 'up' : (close < open ? 'down' : 'flat');

  return {
    available: true,
    open, high, low, close,
    range: round4(range),
    body: round4(body),
    upper_wick: round4(upperWick),
    lower_wick: round4(lowerWick),
    body_to_range_ratio: range > 0 ? round4(body / range) : null,
    lower_wick_to_body_ratio: body > 0 ? round4(lowerWick / body) : null,
    upper_wick_to_body_ratio: body > 0 ? round4(upperWick / body) : null,
    close_location: range > 0 ? round4((close - low) / range) : null,
    direction
  };
}

/**
 * Classify a candle into one observable pattern.
 *
 * Context levels are OPTIONAL and used only when present:
 *   resistance      — for FULL_BODY_BREAKOUT / FAILED_BREAKOUT_WICK
 *   referenceLevel  — support / trailing reference for FAILED_BREAKDOWN_WICK
 *
 * @param {object|number} bar
 * @param {object} opts { resistance, referenceLevel }
 * @returns {object} { pattern, diagnostics, reason }
 */
function classifyCandle(bar, opts) {
  opts = opts || {};
  const d = analyzeCandleStructure(bar);
  if (!d.available) {
    return { pattern: CANDLE_PATTERN.NO_OHLC, diagnostics: d, reason: d.reason };
  }

  const resistance = num(opts.resistance);
  const reference = num(opts.referenceLevel);
  const bodyRatio = d.body_to_range_ratio;
  const closeLoc = d.close_location;
  const lowerToBody = d.lower_wick_to_body_ratio;
  const upperToBody = d.upper_wick_to_body_ratio;

  // Long wick relative to body — treat a zero-body (doji) with a real wick as
  // "long" so indecision/reclaim logic still fires.
  const longLowerWick = (lowerToBody !== null && lowerToBody >= THRESH.LONG_WICK_TO_BODY) ||
    (d.body === 0 && d.lower_wick > 0 && d.lower_wick >= d.upper_wick);
  const longUpperWick = (upperToBody !== null && upperToBody >= THRESH.LONG_WICK_TO_BODY) ||
    (d.body === 0 && d.upper_wick > 0 && d.upper_wick > d.lower_wick);

  let pattern;
  let reason;

  // 1. Failed breakout: pierced above resistance but closed back below it.
  if (resistance !== null && d.high > resistance && d.close <= resistance && longUpperWick) {
    pattern = CANDLE_PATTERN.FAILED_BREAKOUT_WICK;
    reason = 'high pierced resistance (' + resistance + ') but closed back below with a long upper wick';
  // 2. Failed breakdown: pierced below reference but closed back above it.
  } else if (reference !== null && d.low < reference && d.close >= reference && longLowerWick) {
    pattern = CANDLE_PATTERN.FAILED_BREAKDOWN_WICK;
    reason = 'low pierced reference (' + reference + ') but closed back above with a long lower wick';
  // 3. Full-body breakout: strong body closing above resistance / at the top.
  } else if (resistance !== null && d.close > resistance && bodyRatio !== null && bodyRatio >= THRESH.STRONG_BODY_RATIO) {
    pattern = CANDLE_PATTERN.FULL_BODY_BREAKOUT;
    reason = 'strong body closing above resistance (' + resistance + ')';
  } else if (bodyRatio !== null && bodyRatio >= THRESH.FULL_BODY_RATIO && closeLoc !== null && closeLoc >= THRESH.FULL_BODY_CLOSE_LOC) {
    pattern = CANDLE_PATTERN.FULL_BODY_BREAKOUT;
    reason = 'marubozu-like full body closing near the high';
  // 4. Lower-wick reclaim: long lower wick, closed in the upper half.
  } else if (longLowerWick && closeLoc !== null && closeLoc >= THRESH.RECLAIM_CLOSE_LOC) {
    pattern = CANDLE_PATTERN.LOWER_WICK_RECLAIM;
    reason = 'long lower wick with a close in the upper half of the range (reclaim)';
  // 5. Upper-wick rejection: long upper wick, closed in the lower half.
  } else if (longUpperWick && closeLoc !== null && closeLoc <= THRESH.CLOSE_UPPER_HALF) {
    pattern = CANDLE_PATTERN.UPPER_WICK_REJECTION;
    reason = 'long upper wick with a close in the lower half of the range (rejection)';
  // 6. Indecision: small body relative to range.
  } else if (bodyRatio !== null && bodyRatio <= THRESH.INDECISION_BODY_RATIO) {
    pattern = CANDLE_PATTERN.INDECISION;
    reason = 'small body relative to range (indecision)';
  // 7. Strong-body continuation: strong up body.
  } else if (bodyRatio !== null && bodyRatio >= THRESH.STRONG_BODY_RATIO && d.direction === 'up') {
    pattern = CANDLE_PATTERN.STRONG_BODY_CONTINUATION;
    reason = 'strong up body (continuation)';
  } else {
    pattern = CANDLE_PATTERN.NEUTRAL;
    reason = 'no dominant observable candle pattern';
  }

  return {
    pattern,
    reason,
    // The diagnostics are embedded so downstream consumers read (never recompute).
    open: d.open, high: d.high, low: d.low, close: d.close,
    range: d.range,
    body: d.body,
    upper_wick: d.upper_wick,
    lower_wick: d.lower_wick,
    body_to_range_ratio: d.body_to_range_ratio,
    lower_wick_to_body_ratio: d.lower_wick_to_body_ratio,
    upper_wick_to_body_ratio: d.upper_wick_to_body_ratio,
    close_location: d.close_location,
    direction: d.direction
  };
}

module.exports = {
  CANDLE_PATTERN,
  THRESH,
  analyzeCandleStructure,
  classifyCandle
};

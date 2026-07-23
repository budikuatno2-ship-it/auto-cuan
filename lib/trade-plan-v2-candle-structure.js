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

// Confirmed pivot lookback limit for Swing (40 completed daily candles).
const CONFIRMED_PIVOT_LOOKBACK = 40;

/**
 * Normalize a candle object to { open, high, low, close }.
 * Returns null if OHLC cannot be determined.
 */
function normalizeCandle(c) {
  if (c == null) return null;
  if (typeof c === 'number') {
    const n = num(c);
    return n !== null ? { open: n, high: n, low: n, close: n } : null;
  }
  const close = firstNum(c, ['close', 'c', 'last', 'price']);
  if (close === null) return null;
  const open = firstNum(c, ['open', 'o']);
  const high = firstNum(c, ['high', 'h']);
  const low = firstNum(c, ['low', 'l']);
  return {
    open: open !== null ? open : close,
    high: high !== null ? high : close,
    low: low !== null ? low : close,
    close
  };
}

/**
 * Find confirmed pivot lows from recent completed daily candles.
 *
 * A confirmed pivot low requires:
 * - two completed candles on its left
 * - two completed candles on its right
 * - pivot low <= both left lows and both right lows
 * - at least two later completed candles (current unconfirmed bar cannot become pivot)
 *
 * @param {Array} candles - Array of candle objects with OHLC
 * @param {number} lookback - Max candles to scan (default 40)
 * @returns {Array} Array of { index, low, confirmed: true }
 */
function findConfirmedPivotLows(candles, lookback) {
  const normalized = (candles || []).map(normalizeCandle).filter(Boolean);
  // Need at least 5 candles: 2 left + pivot + 2 right
  if (normalized.length < 5) return [];

  // Search from index 2 to length-3 (inclusive), but bounded by lookback
  // This ensures we have 2 candles on left and 2 on right
  const maxCandleIdx = normalized.length - 3;
  const maxIdx = Math.min(lookback || CONFIRMED_PIVOT_LOOKBACK, maxCandleIdx);
  const pivots = [];

  // Start from index 2 (need 2 candles on left) and end 2 before the end (need 2 on right)
  for (let i = 2; i <= maxIdx; i++) {
    const pivot = normalized[i];
    const left1 = normalized[i - 1];
    const left2 = normalized[i - 2];
    const right1 = normalized[i + 1];
    const right2 = normalized[i + 2];

    // Must have at least 2 future completed candles (not including current)
    if (!right1 || !right2) continue;

    // Pivot low must be <= both left lows and both right lows
    if (pivot.low <= left1.low && pivot.low <= left2.low &&
        pivot.low <= right1.low && pivot.low <= right2.low) {
      pivots.push({ index: i, low: pivot.low, high: pivot.high, close: pivot.close });
    }
  }

  return pivots;
}

/**
 * Find confirmed pivot highs from recent completed daily candles.
 *
 * A confirmed pivot high requires:
 * - two completed candles on its left
 * - two completed candles on its right
 * - pivot high >= both left highs and both right highs
 * - at least two later completed candles
 *
 * @param {Array} candles - Array of candle objects with OHLC
 * @param {number} lookback - Max candles to scan (default 40)
 * @returns {Array} Array of { index, high, confirmed: true }
 */
function findConfirmedPivotHighs(candles, lookback) {
  const normalized = (candles || []).map(normalizeCandle).filter(Boolean);
  if (normalized.length < 5) return [];

  const maxCandleIdx = normalized.length - 3;
  const maxIdx = Math.min(lookback || CONFIRMED_PIVOT_LOOKBACK, maxCandleIdx);
  const pivots = [];

  for (let i = 2; i <= maxIdx; i++) {
    const pivot = normalized[i];
    const left1 = normalized[i - 1];
    const left2 = normalized[i - 2];
    const right1 = normalized[i + 1];
    const right2 = normalized[i + 2];

    if (!right1 || !right2) continue;

    // Pivot high must be >= both left highs and both right highs
    if (pivot.high >= left1.high && pivot.high >= left2.high &&
        pivot.high >= right1.high && pivot.high >= right2.high) {
      pivots.push({ index: i, high: pivot.high, low: pivot.low, close: pivot.close });
    }
  }

  return pivots;
}

/**
 * Get the latest confirmed pivot low that is at or below a reference price.
 * Returns null if no valid pivot exists.
 *
 * @param {Array} candles - Array of candle objects with OHLC
 * @param {number} entryZoneLow - The entry zone low price
 * @param {number} lookback - Max candles to scan
 * @returns {object|null} { pivot_low, pivot_index } or null
 */
function getLatestConfirmedSwingLow(candles, entryZoneLow, lookback) {
  const pivots = findConfirmedPivotLows(candles, lookback);
  if (!pivots.length) return null;

  // Find the latest pivot (highest index) that is at or below entryZoneLow
  let latest = null;
  for (let i = pivots.length - 1; i >= 0; i--) {
    if (pivots[i].low <= entryZoneLow) {
      latest = pivots[i];
      break;
    }
  }
  return latest ? { pivot_low: latest.low, pivot_index: latest.index } : null;
}

/**
 * Get the nearest confirmed pivot high that is strictly above a reference price.
 * Returns null if no valid pivot exists.
 *
 * @param {Array} candles - Array of candle objects with OHLC
 * @param {number} entryZoneHigh - The entry zone high price
 * @param {number} lookback - Max candles to scan
 * @returns {object|null} { local_resistance, pivot_index } or null
 */
function getNearestConfirmedResistance(candles, entryZoneHigh, lookback) {
  const pivots = findConfirmedPivotHighs(candles, lookback);
  if (!pivots.length) return null;

  // Find the nearest pivot (lowest index) strictly above entryZoneHigh
  let nearest = null;
  for (const pivot of pivots) {
    if (pivot.high > entryZoneHigh) {
      if (!nearest || pivot.index < nearest.index) {
        nearest = pivot;
      }
    }
  }
  return nearest ? { local_resistance: nearest.high, pivot_index: nearest.index } : null;
}

/**
 * Get the next confirmed pivot high above a given resistance level.
 * Returns null if no valid pivot exists.
 *
 * @param {Array} candles - Array of candle objects with OHLC
 * @param {number} baseResistance - The reference resistance level
 * @param {number} lookback - Max candles to scan
 * @returns {object|null} { next_resistance, pivot_index } or null
 */
function getNextConfirmedResistance(candles, baseResistance, lookback) {
  const pivots = findConfirmedPivotHighs(candles, lookback);
  if (!pivots.length) return null;

  // Find the next pivot above baseResistance
  let next = null;
  for (const pivot of pivots) {
    if (pivot.high > baseResistance) {
      if (!next || pivot.high < next.high) {
        next = pivot;
      }
    }
  }
  return next ? { next_resistance: next.high, pivot_index: next.index } : null;
}

module.exports = {
  CANDLE_PATTERN,
  THRESH,
  CONFIRMED_PIVOT_LOOKBACK,
  analyzeCandleStructure,
  classifyCandle,
  findConfirmedPivotLows,
  findConfirmedPivotHighs,
  getLatestConfirmedSwingLow,
  getNearestConfirmedResistance,
  getNextConfirmedResistance,
  normalizeCandle
};

/**
 * Fibonacci Confluence Calculator for Swing Konglo
 * Deterministic helper. No AI, no SQL, no cron.
 *
 * Calculates Fibonacci retracement levels from recent swing high/low,
 * then evaluates whether the candidate's entry/price area aligns with
 * healthy Fib retracement zones (38.2% - 61.8%).
 *
 * This is a SOFT informational signal only — never blocks candidates.
 */

'use strict';

var idxTick = require('./idx-tick-normalization');

// ============================================================
// HELPERS
// ============================================================

function toNum(v, fallback) {
  if (fallback == null) fallback = 0;
  if (v == null || v === '') return fallback;
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(toNum(n, 0) * 100) / 100;
}

// ============================================================
// SWING HIGH / LOW DETECTION
// ============================================================

/**
 * Find the most recent swing high from OHLCV candles.
 * A swing high is a candle whose high is higher than the N candles on both sides.
 * We look back up to `lookback` candles, requiring `wingSize` candles on each side.
 */
function findSwingHigh(candles, lookback, wingSize) {
  lookback = lookback || 60;
  wingSize = wingSize || 3;
  if (!candles || candles.length < wingSize * 2 + 1) return null;

  var startIdx = Math.max(wingSize, candles.length - lookback);
  var endIdx = candles.length - 1 - wingSize;

  for (var i = endIdx; i >= startIdx; i--) {
    var high = candles[i].high;
    var isSwingHigh = true;
    for (var j = 1; j <= wingSize; j++) {
      if (candles[i - j].high >= high || candles[i + j].high >= high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) return { price: high, index: i };
  }
  return null;
}

/**
 * Find the most recent swing low from OHLCV candles.
 * A swing low is a candle whose low is lower than the N candles on both sides.
 */
function findSwingLow(candles, lookback, wingSize) {
  lookback = lookback || 60;
  wingSize = wingSize || 3;
  if (!candles || candles.length < wingSize * 2 + 1) return null;

  var startIdx = Math.max(wingSize, candles.length - lookback);
  var endIdx = candles.length - 1 - wingSize;

  for (var i = endIdx; i >= startIdx; i--) {
    var low = candles[i].low;
    var isSwingLow = true;
    for (var j = 1; j <= wingSize; j++) {
      if (candles[i - j].low <= low || candles[i + j].low <= low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) return { price: low, index: i };
  }
  return null;
}

// ============================================================
// FIBONACCI LEVEL CALCULATION
// ============================================================

/**
 * Calculate Fibonacci retracement levels given swing high and swing low.
 * Assumes uptrend retracement: swing low is the start, swing high is the end.
 * Retracement levels measure pullback FROM swing high TOWARD swing low.
 *
 * Fib 0% = swing high (no pullback)
 * Fib 38.2% = pulled back 38.2% of the move
 * Fib 50% = pulled back half the move
 * Fib 61.8% = golden ratio pullback
 * Fib 78.6% = deep pullback
 * Fib 100% = full retrace back to swing low
 */
function calculateFibLevels(swingHigh, swingLow) {
  if (!swingHigh || !swingLow || swingHigh <= swingLow || swingLow <= 0) return null;

  var range = swingHigh - swingLow;

  var raw = {
    fib_0: swingHigh,
    fib_236: swingHigh - range * 0.236,
    fib_382: swingHigh - range * 0.382,
    fib_500: swingHigh - range * 0.500,
    fib_618: swingHigh - range * 0.618,
    fib_786: swingHigh - range * 0.786,
    fib_100: swingLow
  };

  // Round all levels to valid IDX tick sizes
  var rounded = {};
  var keys = Object.keys(raw);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var tickRounded = idxTick.roundToIdxTick(raw[key], 'nearest');
    rounded[key] = tickRounded != null ? tickRounded : Math.round(raw[key]);
  }

  return {
    swing_high: swingHigh,
    swing_low: swingLow,
    range: round2(range),
    levels: rounded
  };
}

// ============================================================
// FIBONACCI CONFLUENCE EVALUATION
// ============================================================

/**
 * Evaluate Fibonacci confluence for a Swing Konglo candidate.
 *
 * @param {Array} candles - OHLCV candle array (at least 20 candles recommended)
 * @param {Object} candidate - Candidate with last_price, entry_low, entry_high, support
 * @returns {Object} Fibonacci confluence result with public-safe fields
 */
function evaluateFibConfluence(candles, candidate) {
  // Default safe output for insufficient data
  var insufficientResult = {
    fib_confluence_status: 'insufficient_data',
    fib_confluence_label: 'Fib belum cukup data',
    fib_confluence_note: 'Data candle belum cukup untuk membaca Fib confluence.',
    fib_nearest_label: null,
    fib_nearest_level: null,
    fib_levels: null
  };

  if (!candles || !Array.isArray(candles) || candles.length < 20) {
    return insufficientResult;
  }

  if (!candidate || !candidate.last_price || candidate.last_price <= 0) {
    return insufficientResult;
  }

  // Find swing high and swing low
  var swingHigh = findSwingHigh(candles, 60, 3);
  var swingLow = findSwingLow(candles, 60, 3);

  // Fallback: if no clear swing points, use recent high/low
  if (!swingHigh) {
    var highs = candles.slice(-40).map(function(c) { return c.high; });
    var maxHigh = Math.max.apply(null, highs);
    if (maxHigh > 0) swingHigh = { price: maxHigh, index: -1 };
  }
  if (!swingLow) {
    var lows = candles.slice(-40).map(function(c) { return c.low; });
    var minLow = Math.min.apply(null, lows);
    if (minLow > 0) swingLow = { price: minLow, index: -1 };
  }

  if (!swingHigh || !swingLow || swingHigh.price <= swingLow.price) {
    return insufficientResult;
  }

  // Ensure meaningful range (at least 3% between swing high and low)
  var rangePct = (swingHigh.price - swingLow.price) / swingLow.price;
  if (rangePct < 0.03) {
    return insufficientResult;
  }

  // Calculate Fib levels
  var fibData = calculateFibLevels(swingHigh.price, swingLow.price);
  if (!fibData || !fibData.levels) {
    return insufficientResult;
  }

  var levels = fibData.levels;
  var lastPrice = toNum(candidate.last_price);
  var entryLow = toNum(candidate.entry_low || candidate.entry1);
  var entryHigh = toNum(candidate.entry_high || candidate.entry2);
  var entryMid = (entryLow > 0 && entryHigh > 0) ? (entryLow + entryHigh) / 2 : lastPrice;

  // Determine where price/entry is relative to Fib levels
  var referencePrice = entryMid > 0 ? entryMid : lastPrice;

  // Find nearest Fib level
  var fibLabels = [
    { key: 'fib_236', label: '23.6%', pct: 0.236 },
    { key: 'fib_382', label: '38.2%', pct: 0.382 },
    { key: 'fib_500', label: '50%', pct: 0.500 },
    { key: 'fib_618', label: '61.8%', pct: 0.618 },
    { key: 'fib_786', label: '78.6%', pct: 0.786 }
  ];

  var nearestDist = Infinity;
  var nearestFib = null;
  for (var i = 0; i < fibLabels.length; i++) {
    var fibLevel = levels[fibLabels[i].key];
    var dist = Math.abs(referencePrice - fibLevel);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestFib = fibLabels[i];
    }
  }

  // Proximity threshold: within 2% of a Fib level counts as "near"
  var proximityPct = fibData.range > 0 ? (nearestDist / fibData.range) : 1;
  var isNearFib = proximityPct <= 0.05; // within 5% of the fib range

  // Classify confluence status
  var status, label, note;

  // Check if price is in the healthy Fib zone (38.2% to 61.8%)
  var isInHealthyZone = referencePrice <= levels.fib_382 && referencePrice >= levels.fib_618;
  // Check if entry area overlaps with healthy Fib zone
  var entryOverlapsHealthy = (entryLow > 0 && entryHigh > 0) &&
    (entryLow <= levels.fib_382 && entryHigh >= levels.fib_618);
  // Near healthy zone (within 2% range of zone boundaries)
  var nearHealthyZone = isInHealthyZone || entryOverlapsHealthy ||
    (referencePrice >= levels.fib_618 * 0.98 && referencePrice <= levels.fib_382 * 1.02);

  // Check support alignment with Fib level (if support is near a Fib level)
  var support = toNum(candidate.support);
  var supportNearFib = false;
  if (support > 0) {
    for (var si = 0; si < fibLabels.length; si++) {
      var sFibLevel = levels[fibLabels[si].key];
      if (Math.abs(support - sFibLevel) / support <= 0.02) {
        supportNearFib = true;
        break;
      }
    }
  }

  if (nearHealthyZone && (isNearFib || supportNearFib)) {
    // Price/entry is near Fib 38.2-61.8 area AND aligns with support/entry
    status = 'confluence_sehat';
    label = 'Fib confluence sehat';
    note = 'Entry/pullback dekat area Fib 38.2\u201361.8.';
  } else if (nearHealthyZone) {
    // In healthy zone but no strong alignment
    status = 'confluence_sehat';
    label = 'Fib confluence sehat';
    note = 'Entry/pullback dekat area Fib 38.2\u201361.8.';
  } else if (referencePrice > levels.fib_382) {
    // Price is above the ideal Fib area (hasn't pulled back enough)
    status = 'di_atas_fib';
    label = 'Di atas area Fib';
    note = 'Harga sudah di atas area retracement ideal, tunggu pullback.';
  } else if (referencePrice < levels.fib_618) {
    // Price is below Fib 61.8% — losing structure
    if (referencePrice < levels.fib_786) {
      // Deep below — structure clearly weak
      status = 'fib_structure_lemah';
      label = 'Fib structure lemah';
      note = 'Harga melemah di bawah area Fib sehat, perlu konfirmasi ulang.';
    } else {
      // Between 61.8% and 78.6% — borderline
      status = 'fib_structure_lemah';
      label = 'Fib structure lemah';
      note = 'Harga melemah di bawah area Fib sehat, perlu konfirmasi ulang.';
    }
  } else {
    // Fallback — shouldn't normally reach here
    status = 'di_atas_fib';
    label = 'Di atas area Fib';
    note = 'Harga sudah di atas area retracement ideal, tunggu pullback.';
  }

  // Build public-safe Fib levels (only key levels, no raw arrays)
  var publicLevels = {
    fib_382: levels.fib_382,
    fib_500: levels.fib_500,
    fib_618: levels.fib_618
  };

  return {
    fib_confluence_status: status,
    fib_confluence_label: label,
    fib_confluence_note: note,
    fib_nearest_label: nearestFib ? nearestFib.label : null,
    fib_nearest_level: nearestFib ? levels[nearestFib.key] : null,
    fib_levels: publicLevels
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  evaluateFibConfluence: evaluateFibConfluence,
  calculateFibLevels: calculateFibLevels,
  findSwingHigh: findSwingHigh,
  findSwingLow: findSwingLow
};

'use strict';

/**
 * Day Trade Scan-to-Scan Comparison Module
 *
 * Lightweight comparison of current scan vs previous scan/baseline per ticker.
 * Used as an additional positive signal, NOT a hard blocker.
 *
 * Stores previous scan snapshots in memory (process lifetime).
 * For VPS worker: can optionally persist to disk via external caller.
 *
 * Comparison metrics:
 *   - price change (vs previous scan)
 *   - volume/value change
 *   - distance to entry (improving or worsening)
 *   - distance to TP (remaining upside)
 *   - entry zone touched
 *   - breakout/reclaim proximity
 *
 * Returns: acceleration_score (-10 to +15) and acceleration_label
 * This is additive — never blocks a candidate.
 */

// In-memory baseline store (ticker -> last scan snapshot)
var _baselineStore = {};

/**
 * Get stored baseline for a ticker.
 * @param {string} ticker
 * @returns {object|null}
 */
function getBaseline(ticker) {
  if (!ticker) return null;
  return _baselineStore[ticker.toUpperCase()] || null;
}

/**
 * Store current scan as baseline for next comparison.
 * @param {string} ticker
 * @param {object} scan - Current scan result (must have last_price, volume_ratio_20d, value_today, entry_low, entry_high, tp1, stop_loss, resistance, status)
 */
function storeBaseline(ticker, scan) {
  if (!ticker || !scan) return;
  _baselineStore[ticker.toUpperCase()] = {
    timestamp: Date.now(),
    last_price: scan.last_price,
    volume_ratio_20d: scan.volume_ratio_20d,
    value_today: scan.value_today,
    avg_value_7d: scan.avg_value_7d,
    entry_low: scan.entry_low,
    entry_high: scan.entry_high,
    tp1: scan.tp1,
    tp2: scan.tp2,
    stop_loss: scan.stop_loss,
    resistance: scan.resistance,
    status: scan.status,
    daytrade_score: scan.daytrade_score,
    change_pct: scan.change_pct,
    distance_to_breakout_pct: scan.distance_to_breakout_pct,
    risk_reward: scan.risk_reward
  };
}

/**
 * Store multiple baselines from a batch result.
 * @param {object[]} results - Array of scored candidates
 */
function storeBatchBaselines(results) {
  if (!Array.isArray(results)) return;
  for (var i = 0; i < results.length; i++) {
    if (results[i] && results[i].ticker) {
      storeBaseline(results[i].ticker, results[i]);
    }
  }
}

/**
 * Clear all baselines (useful for testing or new day).
 */
function clearBaselines() {
  _baselineStore = {};
}

/**
 * Get baseline count (for diagnostics).
 */
function getBaselineCount() {
  return Object.keys(_baselineStore).length;
}

/**
 * Export all baselines as JSON-serializable object (for disk persistence).
 */
function exportBaselines() {
  return JSON.parse(JSON.stringify(_baselineStore));
}

/**
 * Import baselines from persisted data.
 * @param {object} data - { TICKER: { ... baseline ... }, ... }
 */
function importBaselines(data) {
  if (!data || typeof data !== 'object') return;
  Object.keys(data).forEach(function(key) {
    _baselineStore[key.toUpperCase()] = data[key];
  });
}

// ============================================================
// COMPARISON LOGIC
// ============================================================

/**
 * Compare current scan against previous baseline for a ticker.
 * Returns an acceleration assessment (positive signal, not a blocker).
 *
 * @param {object} current - Current scan result
 * @param {object|null} baseline - Previous scan result (null = first scan)
 * @returns {object} { acceleration_score, acceleration_label, acceleration_factors, is_first_scan }
 */
function compareScan(current, baseline) {
  if (!current) return { acceleration_score: 0, acceleration_label: 'No data', acceleration_factors: [], is_first_scan: true };
  if (!baseline) return { acceleration_score: 0, acceleration_label: 'First scan', acceleration_factors: [], is_first_scan: true };

  var score = 0;
  var factors = [];
  var curPrice = current.last_price || 0;
  var prevPrice = baseline.last_price || 0;
  var curVol = current.volume_ratio_20d || 0;
  var prevVol = baseline.volume_ratio_20d || 0;
  var curValue = current.value_today || 0;
  var prevValue = baseline.value_today || 0;
  var curEntryHigh = current.entry_high || current.entry_low || 0;
  var curTp1 = current.tp1 || 0;
  var curSl = current.stop_loss || 0;
  var curResistance = current.resistance || 0;
  var curDistBreakout = current.distance_to_breakout_pct;
  var prevDistBreakout = baseline.distance_to_breakout_pct;

  // === 1. Price movement toward entry (positive if improving) ===
  if (prevPrice > 0 && curPrice > 0 && curEntryHigh > 0) {
    var prevDistToEntry = prevPrice > curEntryHigh ? ((prevPrice - curEntryHigh) / curEntryHigh * 100) : 0;
    var curDistToEntry = curPrice > curEntryHigh ? ((curPrice - curEntryHigh) / curEntryHigh * 100) : 0;

    if (curDistToEntry < prevDistToEntry && curDistToEntry <= 3) {
      // Price moved closer to entry area — good sign
      score += 3;
      factors.push('price improving toward entry');
    } else if (curDistToEntry > prevDistToEntry + 2 && curDistToEntry > 5) {
      // Price moved further away from entry — mild negative
      score -= 2;
      factors.push('price moved away from entry');
    }

    // Price in or near entry zone
    if (curPrice >= (current.entry_low || 0) && curPrice <= curEntryHigh * 1.02) {
      score += 3;
      factors.push('entry zone touched');
    }
  }

  // === 2. Volume/Value increasing (positive signal) ===
  if (prevVol > 0 && curVol > 0) {
    var volChange = curVol - prevVol;
    if (volChange >= 0.3 && curVol >= 1.2) {
      score += 3;
      factors.push('volume increasing meaningfully');
    } else if (volChange >= 0.15 && curVol >= 1.0) {
      score += 1;
      factors.push('volume slightly improving');
    }
    // Independent check: volume high but value tiny — suspicious regardless
    if (curVol >= 2.0 && curValue > 0 && curValue < 500000000) {
      score -= 2;
      factors.push('volume spike but value tiny');
    }
  }

  if (prevValue > 0 && curValue > 0) {
    var valueRatio = curValue / prevValue;
    if (valueRatio >= 1.3 && curValue >= 1000000000) {
      score += 2;
      factors.push('transaction value increasing');
    }
  }

  // === 3. Breakout/reclaim proximity improving ===
  if (curDistBreakout != null && prevDistBreakout != null) {
    if (curDistBreakout < prevDistBreakout && curDistBreakout <= 2.0) {
      score += 3;
      factors.push('approaching breakout');
    } else if (curDistBreakout < prevDistBreakout && curDistBreakout <= 4.0) {
      score += 1;
      factors.push('closer to resistance');
    }
  }

  // === 4. Not too far above entry (avoid chase) ===
  if (curPrice > 0 && curEntryHigh > 0) {
    var aboveEntryPct = ((curPrice - curEntryHigh) / curEntryHigh) * 100;
    if (aboveEntryPct > 6) {
      score -= 3;
      factors.push('too far above entry (chase risk)');
    }
  }

  // === 5. Not already near TP with poor remaining RR ===
  if (curPrice > 0 && curTp1 > 0 && curSl > 0) {
    var remainingUpside = ((curTp1 - curPrice) / curPrice) * 100;
    var remainingDownside = ((curPrice - curSl) / curPrice) * 100;
    if (remainingUpside < 1.5 && remainingDownside > 2) {
      score -= 3;
      factors.push('near TP with poor remaining RR');
    }
  }

  // === 6. Score improving between scans ===
  if (baseline.daytrade_score && current.daytrade_score) {
    var scoreDelta = current.daytrade_score - baseline.daytrade_score;
    if (scoreDelta >= 5) {
      score += 2;
      factors.push('score improving');
    } else if (scoreDelta <= -8) {
      score -= 2;
      factors.push('score deteriorating');
    }
  }

  // === 7. Stale baseline check ===
  if (baseline.timestamp) {
    var ageMs = Date.now() - baseline.timestamp;
    if (ageMs > 60 * 60 * 1000) {
      // Baseline older than 1 hour — less reliable comparison
      score = Math.round(score * 0.6);
      factors.push('stale baseline (>' + Math.round(ageMs / 60000) + 'min)');
    }
  }

  // Clamp score
  score = Math.max(-10, Math.min(15, score));

  // Label
  var label = 'Neutral';
  if (score >= 8) label = 'Strong acceleration';
  else if (score >= 4) label = 'Accelerating';
  else if (score >= 1) label = 'Slight improvement';
  else if (score <= -5) label = 'Decelerating';
  else if (score <= -2) label = 'Slight weakening';

  return {
    acceleration_score: score,
    acceleration_label: label,
    acceleration_factors: factors,
    is_first_scan: false
  };
}

/**
 * Compare and store in one call (convenience for batch processing).
 * @param {object} current - Current scan result (must have .ticker)
 * @returns {object} Comparison result
 */
function compareAndStore(current) {
  if (!current || !current.ticker) return { acceleration_score: 0, acceleration_label: 'No data', acceleration_factors: [], is_first_scan: true };
  var baseline = getBaseline(current.ticker);
  var result = compareScan(current, baseline);
  storeBaseline(current.ticker, current);
  return result;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getBaseline: getBaseline,
  storeBaseline: storeBaseline,
  storeBatchBaselines: storeBatchBaselines,
  clearBaselines: clearBaselines,
  getBaselineCount: getBaselineCount,
  exportBaselines: exportBaselines,
  importBaselines: importBaselines,
  compareScan: compareScan,
  compareAndStore: compareAndStore
};

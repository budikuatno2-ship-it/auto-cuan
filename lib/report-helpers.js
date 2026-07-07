/**
 * Report Helper Functions for Telegram Daily Picks Outcome Analysis
 * 
 * Pure functions for:
 * - Bucket calculation for scores
 * - Outcome classification
 * - Rate calculation with missing field fallback
 * - Data normalization
 */

'use strict';

/**
 * Get score bucket from raw_payload.score or row.score
 * Returns bucket label or null if not available
 */
function getScoreBucket(row) {
  if (!row) return null;
  const raw = row.raw_payload || {};
  const score = row.score !== undefined ? row.score : raw.score;
  if (score === undefined || score === null || isNaN(score)) return null;
  if (score < 50) return '<50';
  if (score < 60) return '50-59';
  if (score < 70) return '60-69';
  if (score < 80) return '70-79';
  return '80+';
}

/**
 * Calculate hit rate (count / total)
 * Returns percentage string with 1 decimal, or null if invalid
 */
function calculateRate(count, total) {
  if (total === 0) return null;  // Avoid division by zero
  if (count === null || count === undefined || isNaN(count)) return null;  // Check count first
  if (!total || isNaN(total)) return null;
  const rate = (count / total) * 100;
  return (Math.round(rate * 10) / 10).toFixed(1) + '%';
}

/**
 * Classify outcome based on hit timestamps and status
 * Returns: 'WAITING', 'RUNNING', 'ENTRY_HIT', 'TP1_HIT', 'TP2_HIT', 'SL_HIT', 'EXPIRED', 'UNKNOWN'
 */
function classifyOutcome(row) {
  if (!row) return 'UNKNOWN';
  
  const status = String(row.status || '').toUpperCase();
  const hitTp2 = row.hit_tp2_at;
  const hitTp1 = row.hit_tp1_at;
  const hitSl = row.hit_sl_at;
  const hitEntry = row.hit_entry_at;
  
  // Check final outcomes first
  if (hitTp2) return 'TP2_HIT';
  if (hitSl) return 'SL_HIT';
  if (status === 'TP2_HIT') return 'TP2_HIT';
  if (status === 'SL_HIT') return 'SL_HIT';
  if (status === 'TP1_HIT') return 'TP1_HIT';
  
  // Check TP1
  if (hitTp1 || status === 'TP1_HIT') return 'TP1_HIT';
  
  // Check entry
  if (hitEntry) return 'ENTRY_HIT';
  
  // Check running states
  if (status === 'RUNNING' || status === 'ACTIVE') return 'RUNNING';
  
  // Check waiting
  if (status === 'WAITING') return 'WAITING';
  
  // Check expired
  if (status === 'EXPIRED' || status === 'NEEDS_REVALIDATION') return 'EXPIRED';
  
  return 'UNKNOWN';
}

/**
 * Get monitor source from raw_payload.monitor_source or row.category
 * Returns: 'daytrade', 'swing_konglo', 'swing_nk', 'top5', 'watchlist', or null
 */
function getMonitorSource(row) {
  if (!row) return null;
  const raw = row.raw_payload || {};
  const source = raw.monitor_source;
  
  if (source) {
    const s = String(source).toLowerCase();
    if (s === 'daytrade' || s === 'daytrade_signal') return 'daytrade';
    if (s === 'swing_konglo') return 'swing_konglo';
    if (s === 'swing_nk') return 'swing_nk';
    if (s === 'top5' || s === 'top_5') return 'top5';
    if (s === 'watchlist') return 'watchlist';
  }
  
  // Fallback to category
  const category = row.category || raw.category;
  if (category) {
    const c = String(category).toLowerCase();
    if (c.includes('day trade') || c === 'daytrade') return 'daytrade';
    if (c.includes('swing konglo')) return 'swing_konglo';  // Check 'konglo' first before 'swing'
    if (c.includes('swing') && (c.includes('non') || c.includes('nk'))) return 'swing_nk';
    if (c.includes('swing')) return 'swing_konglo';  // Generic swing fallback
    if (c.includes('top5') || c.includes('top 5')) return 'top5';
    if (c.includes('watchlist')) return 'watchlist';
  }
  
  return null;
}

/**
 * Calculate time difference in hours between two timestamps
 * Returns hours as number or null if invalid
 */
function calculateTimeDiffHours(timestamp1, timestamp2) {
  if (!timestamp1 || !timestamp2) return null;
  
  try {
    const t1 = new Date(timestamp1);
    const t2 = new Date(timestamp2);
    
    if (isNaN(t1.getTime()) || isNaN(t2.getTime())) return null;
    
    const diffMs = Math.abs(t2.getTime() - t1.getTime());
    const diffHours = diffMs / (1000 * 60 * 60);
    return Math.round(diffHours * 10) / 10; // 1 decimal
  } catch (e) {
    return null;
  }
}

/**
 * Calculate average from array of numbers
 * Returns average or null if empty/invalid
 */
function calculateAverage(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  
  const valid = numbers.filter(n => n !== null && !isNaN(n));
  if (valid.length === 0) return null;
  
  const sum = valid.reduce((a, b) => a + b, 0);
  return Math.round((sum / valid.length) * 10) / 10;
}

/**
 * Group array of items by a key getter function
 * Returns object with keys mapped to arrays
 */
function groupBy(items, keyGetter) {
  if (!Array.isArray(items)) return {};
  
  const result = {};
  for (const item of items) {
    const key = keyGetter(item) || 'unknown';
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

/**
 * Count items matching a predicate
 */
function countWhere(items, predicate) {
  if (!Array.isArray(items)) return 0;
  return items.filter(predicate).length;
}

/**
 * Safe field accessor - returns value or null if not available
 */
function safeGet(obj, path) {
  if (!obj || !path) return null;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  return current !== undefined ? current : null;
}

/**
 * Generate observations from report data
 * Returns array of observation strings
 */
function generateObservations(stats) {
  const observations = [];
  
  // Entry rate observation - check if rate > 0
  const entryRateNum = parseFloat(stats.entryRate);
  if (stats.entryRate != null && !isNaN(entryRateNum) && entryRateNum > 0) {
    const rate = parseFloat(stats.entryRate);
    if (rate >= 80) {
      observations.push('Entry hit rate sangat tinggi (' + stats.entryRate + ') - strategi entry efektif');
    } else if (rate >= 50) {
      observations.push('Entry hit rate moderate (' + stats.entryRate + ') - perlu monitoring lebih lanjut');
    } else {
      observations.push('Entry hit rate rendah (' + stats.entryRate + ') - pertimbangkan adjust entry level');
    }
  }
  
  // TP1 vs TP2
  if (stats.tp1Count > 0 && stats.tp2Count > 0) {
    const tpCompletion = (stats.tp2Count / stats.tp1Count * 100).toFixed(1);
    observations.push('TP2 completion rate dari TP1: ' + tpCompletion + '%');
  }
  
  // SL rate observation
  if (stats.slRate && parseFloat(stats.slRate) > 0) {
    const rate = parseFloat(stats.slRate);
    if (rate > 30) {
      observations.push('SL hit rate tinggi (' + stats.slRate + ') - perlu review risk management');
    } else if (rate < 10) {
      observations.push('SL hit rate rendah (' + stats.slRate + ') - good risk control');
    }
  }
  
  // Still running
  if (stats.waitingCount > 0 || stats.runningCount > 0) {
    const pending = stats.waitingCount + stats.runningCount;
    observations.push(pending + ' picks masih pending (waiting/running)');
  }
  
  // Score bucket observations
  if (stats.scoreBuckets && Object.keys(stats.scoreBuckets).length > 0) {
    const buckets = stats.scoreBuckets;
    const highScoreCount = (buckets['80+'] || []).length;
    const lowScoreCount = (buckets['<50'] || []).length;
    
    if (highScoreCount > 0 && lowScoreCount > 0) {
      observations.push('Terdapat picks dengan score berbeda - high score (' + highScoreCount + ') vs low score (' + lowScoreCount + ')');
    }
  }
  
  // Average time observations
  if (stats.avgTimeToTp2 != null) {
    observations.push('Rata-rata waktu ke TP2: ' + stats.avgTimeToTp2 + ' jam');
  }
  
  if (observations.length === 0) {
    // Even for empty stats, we should indicate data unavailability
    observations.push('data tidak tersedia untuk observasi');
  }
  
  return observations;
}

module.exports = {
  getScoreBucket,
  calculateRate,
  classifyOutcome,
  getMonitorSource,
  calculateTimeDiffHours,
  calculateAverage,
  groupBy,
  countWhere,
  safeGet,
  generateObservations
};
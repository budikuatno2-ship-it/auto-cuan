'use strict';

// Reject stale trading levels after a split/reverse-split instead of guessing an adjustment.
const LATEST_PRICE_FIELDS = ['latest_price', 'current_price', 'last_price', 'price', 'close_price', 'close'];
const ACTIONABLE_PRICE_FIELDS = [
  'price', 'latest_price', 'current_price', 'close', 'close_price',
  'entry', 'entry_price', 'entry_low', 'entry_high', 'entry1', 'entry2',
  'stop_loss', 'sl', 'tp1', 'tp2', 'tp3', 'target_price',
  'support', 'support1', 'support2', 'resistance', 'resistance1', 'resistance2',
  'breakout_trigger', 'reclaim_level', 'demand_low', 'demand_high', 'supply_low', 'supply_high'
];
const CRITICAL_FIELDS = { entry: true, entry_price: true, entry_low: true, entry_high: true, entry1: true, entry2: true, stop_loss: true, sl: true };
const COMMON_FACTORS = [2, 3, 4, 5, 10, 20];

function positiveNumber(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
function median(values) { const sorted = values.slice().sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function nearSplitFactor(ratio) {
  return COMMON_FACTORS.some((factor) => Math.abs(ratio - factor) / factor <= 0.18 || Math.abs(ratio - (1 / factor)) / (1 / factor) <= 0.18);
}

function resolveLatestPrice(candidate, latestPrice) {
  const explicit = positiveNumber(latestPrice);
  if (explicit) return explicit;
  for (const field of LATEST_PRICE_FIELDS) {
    const value = positiveNumber(candidate && candidate[field]);
    if (value) return value;
  }
  return null;
}

function detectPriceScaleMismatch(candidate, latestPrice, options) {
  const row = candidate || {};
  const trustedLatest = resolveLatestPrice(row, latestPrice);
  if (!trustedLatest) return { blocked: false, reason: 'latest_price_missing', latest_price_used: null, actionable_level_count: 0 };

  const levels = ACTIONABLE_PRICE_FIELDS.map((field) => ({ field, value: positiveNumber(row[field]) })).filter((item) => item.value);
  // Current-price aliases establish the reference and must not outweigh the actual plan.
  const actionable = levels.filter((item) => LATEST_PRICE_FIELDS.indexOf(item.field) < 0);
  const ratioValues = actionable.map((item) => item.value / trustedLatest);
  if (!ratioValues.length) return { blocked: false, reason: 'insufficient_actionable_levels', latest_price_used: trustedLatest, actionable_level_count: 0 };

  const ratio = median(ratioValues);
  const farMedian = ratio > 1.8 || ratio < 0.55;
  const commonScale = nearSplitFactor(ratio);
  const criticalFar = actionable.some((item) => CRITICAL_FIELDS[item.field] && (item.value / trustedLatest > 3 || item.value / trustedLatest < (1 / 3)));
  const enoughEvidence = actionable.length >= 2;
  const blocked = (enoughEvidence && farMedian && (commonScale || ratio > 2.2 || ratio < 0.45)) || criticalFar;
  const sample = actionable.slice(0, 5).map((item) => ({ field: item.field, value: item.value }));
  return {
    blocked,
    reason: blocked ? 'price_scale_mismatch' : null,
    latest_price_used: trustedLatest,
    suspected_price_scale_ratio: Math.round(ratio * 1000) / 1000,
    actionable_level_count: actionable.length,
    stale_level_sample: sample,
    common_split_factor: commonScale
  };
}

function applyCorporateActionPriceScaleGuard(candidate, context) {
  const row = candidate || {};
  const result = detectPriceScaleMismatch(row, context && context.latestPrice, context);
  row.corporate_action_guard = result.blocked ? 'BLOCKED' : (result.reason === 'latest_price_missing' ? 'NOT_EVALUATED' : 'PASSED');
  row.latest_price_used = result.latest_price_used;
  if (result.suspected_price_scale_ratio != null) row.suspected_price_scale_ratio = result.suspected_price_scale_ratio;
  if (result.stale_level_sample) row.stale_level_sample = result.stale_level_sample;
  if (!result.blocked) {
    if (result.reason === 'latest_price_missing') row.corporate_action_reason = 'latest_price_missing';
    return row;
  }
  row.corporate_action_reason = 'price_scale_mismatch';
  row.status = 'NEEDS_REVALIDATION';
  row.final_status = 'NEEDS_REVALIDATION';
  row.display_status = 'STALE_LEVEL';
  row.data_quality_status = 'NEEDS_REVALIDATION';
  row.data_quality_needs_revalidation = true;
  row.is_stale = true;
  row.excluded_reason = 'price_scale_mismatch';
  // Never preserve a buy/action label once a stale scale is detected.
  row.action = 'NEEDS_REVALIDATION';
  row.signal_action = 'NEEDS_REVALIDATION';
  row.action_label = 'NEEDS_REVALIDATION';
  row.signal_action_label = 'NEEDS_REVALIDATION';
  row.telegram_action_label = 'NEEDS_REVALIDATION';
  return row;
}

module.exports = { ACTIONABLE_PRICE_FIELDS, detectPriceScaleMismatch, applyCorporateActionPriceScaleGuard };

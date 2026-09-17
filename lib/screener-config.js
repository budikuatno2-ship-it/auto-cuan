'use strict';

/**
 * Centralized Screener Configuration & Risk/Reward Filters — Auto-Cuan
 *
 * Core Risk/Reward thresholds applied across Day Trade & Swing Screener pipelines.
 */

const MIN_RR_RATIO = 1.5;
const IDEAL_RR_RATIO = 2.0;
// Batch 9: Minimum volume ratio required for breakout/revalidation confirmation.
const MIN_BREAKOUT_VOLUME_RATIO = 1.2;

/**
 * Evaluates whether candidate meets minimum Risk/Reward ratio threshold.
 * Safely extracts R/R from various property naming variants across the codebase
 * (e.g. rr, rr_ratio, risk_reward, riskReward, levels.risk_reward, levels.riskReward).
 *
 * @param {Object} [candidate] - Candidate object or levels container
 * @param {number} [minRatio=MIN_RR_RATIO] - Minimum acceptable R/R ratio threshold
 * @returns {boolean} True if candidate has valid numerical R/R >= minRatio, false otherwise
 */
function passesRiskRewardFilter(candidate, minRatio = MIN_RR_RATIO) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const threshold = (typeof minRatio === 'number' && !Number.isNaN(minRatio))
    ? minRatio
    : MIN_RR_RATIO;

  let rawVal = null;

  if (candidate.levels && typeof candidate.levels === 'object') {
    if (candidate.levels.risk_reward != null) rawVal = candidate.levels.risk_reward;
    else if (candidate.levels.riskReward != null) rawVal = candidate.levels.riskReward;
    else if (candidate.levels.rr != null) rawVal = candidate.levels.rr;
    else if (candidate.levels.rr_ratio != null) rawVal = candidate.levels.rr_ratio;
  }

  if (rawVal == null) {
    if (candidate.risk_reward != null) rawVal = candidate.risk_reward;
    else if (candidate.riskReward != null) rawVal = candidate.riskReward;
    else if (candidate.rr_ratio != null) rawVal = candidate.rr_ratio;
    else if (candidate.rrRatio != null) rawVal = candidate.rrRatio;
    else if (candidate.rr != null) rawVal = candidate.rr;
  }

  if (rawVal == null) {
    return false;
  }

  const numVal = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim());

  if (!Number.isFinite(numVal) || numVal < 0) {
    return false;
  }

  return numVal >= threshold;
}

/**
 * Batch 9: Evaluates whether candidate meets minimum volume breakout confirmation threshold.
 * Safely extracts Volume Ratio from various property naming variants
 * (e.g. volume_ratio, volume_ratio_20d, volumeRatio, volume_ratio_avg20, vr, vol_ratio).
 *
 * @param {Object} [candidate] - Candidate object or metrics container
 * @param {number} [minRatio=MIN_BREAKOUT_VOLUME_RATIO] - Minimum acceptable volume ratio
 * @returns {boolean} True if candidate has valid numerical volume ratio >= minRatio, false otherwise
 */
function passesVolumeBreakoutConfirmation(candidate, minRatio = MIN_BREAKOUT_VOLUME_RATIO) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const threshold = (typeof minRatio === 'number' && !Number.isNaN(minRatio))
    ? minRatio
    : MIN_BREAKOUT_VOLUME_RATIO;

  let rawVal = null;

  if (candidate.volume_ratio != null) rawVal = candidate.volume_ratio;
  else if (candidate.volume_ratio_20d != null) rawVal = candidate.volume_ratio_20d;
  else if (candidate.volume_ratio_avg20 != null) rawVal = candidate.volume_ratio_avg20;
  else if (candidate.volumeRatio != null) rawVal = candidate.volumeRatio;
  else if (candidate.vr != null) rawVal = candidate.vr;
  else if (candidate.vol_ratio != null) rawVal = candidate.vol_ratio;

  if (rawVal == null) {
    return false;
  }

  const numVal = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim());

  if (!Number.isFinite(numVal) || numVal < 0) {
    return false;
  }

  return numVal >= threshold;
}

// Batch 11: Live/intraday price sources that indicate a still-forming (unclosed) bar.
const LIVE_PRICE_SOURCE_PATTERN = /(^|[_\s])live([_\s]|$)|intraday|realtime|real_time|_tick/i;

/**
 * Batch 11: Determines whether the candidate's price reflects a CONFIRMED candle close
 * rather than an intraday tick of a still-forming bar (wick).
 *
 * Backward-compatible: absent any explicit still-forming signal, returns true so legacy
 * daily-close flows are unaffected. Returns false when the candidate explicitly marks the
 * bar as unclosed (candle_closed/bar_closed === false, candle_forming === true,
 * is_intraday_live === true) or carries a live/intraday price_source.
 *
 * @param {Object} [candidate]
 * @returns {boolean} True if the bar is confirmed closed (or no signal says otherwise)
 */
function isCandleCloseConfirmed(candidate) {
  if (!candidate || typeof candidate !== 'object') return true;
  if (candidate.candle_closed === false) return false;
  if (candidate.bar_closed === false) return false;
  if (candidate.candle_forming === true) return false;
  if (candidate.is_intraday_live === true) return false;
  const src = candidate.price_source;
  if (src != null && LIVE_PRICE_SOURCE_PATTERN.test(String(src))) return false;
  return true;
}

/**
 * Batch 9: Evaluates whether a candidate requiring revalidation can be safely confirmed.
 * Requires:
 * 1. Fresh data (not stale / expired)
 * 2. Minimum Risk/Reward ratio >= MIN_RR_RATIO
 * 3. Volume confirmation >= MIN_BREAKOUT_VOLUME_RATIO if candidate is in breakout / entry state
 *
 * @param {Object} [candidate]
 * @param {Object} [options]
 * @param {number} [options.min_rr] - Override minimum R/R ratio (default MIN_RR_RATIO)
 * @param {number} [options.min_volume_ratio] - Override minimum volume ratio (default MIN_BREAKOUT_VOLUME_RATIO)
 * @param {boolean} [options.require_volume] - Force volume confirmation check regardless of status
 * @returns {{ pass: boolean, reason: string|null }}
 */
function validateRevalidationSignal(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return { pass: false, reason: 'missing_candidate' };
  }

  if (candidate.is_stale === true || candidate.data_stale === true || candidate.freshness_is_stale === true) {
    return { pass: false, reason: 'stale_data' };
  }

  const minRR = (typeof options.min_rr === 'number') ? options.min_rr : MIN_RR_RATIO;
  if (!passesRiskRewardFilter(candidate, minRR)) {
    return { pass: false, reason: 'poor_risk_reward' };
  }

  const minVR = (typeof options.min_volume_ratio === 'number') ? options.min_volume_ratio : MIN_BREAKOUT_VOLUME_RATIO;
  const isBreakoutOrEntry = options.require_volume === true ||
    ['BREAKOUT_CONFIRMED', 'READY_BREAKOUT', 'A_PLUS_SETUP', 'IN_ENTRY_AREA', 'TRADE_CANDIDATE'].includes(
      String(candidate.entry_status || candidate.status || candidate.breakout_confirmation_status || '').toUpperCase()
    );

  if (isBreakoutOrEntry && !passesVolumeBreakoutConfirmation(candidate, minVR)) {
    return { pass: false, reason: 'insufficient_breakout_volume' };
  }

  return { pass: true, reason: null };
}

module.exports = {
  MIN_RR_RATIO,
  IDEAL_RR_RATIO,
  MIN_BREAKOUT_VOLUME_RATIO,
  passesRiskRewardFilter,
  passesVolumeBreakoutConfirmation,
  isCandleCloseConfirmed,
  validateRevalidationSignal
};

'use strict';

/**
 * Centralized Screener Configuration & Risk/Reward Filters — Auto-Cuan
 *
 * Core Risk/Reward thresholds applied across Day Trade & Swing Screener pipelines.
 */

const MIN_RR_RATIO = 1.5;
const IDEAL_RR_RATIO = 2.0;

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

module.exports = {
  MIN_RR_RATIO,
  IDEAL_RR_RATIO,
  passesRiskRewardFilter
};

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
function extractCandidateLevels(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const sources = [
    candidate.levels,
    candidate,
    candidate.observation && candidate.observation.metrics,
    candidate.observation,
    candidate.metrics,
    candidate.trade_plan_v2
  ].filter(src => src && typeof src === 'object');

  function findVal(keys) {
    for (const src of sources) {
      for (const k of keys) {
        if (src[k] != null && src[k] !== '') {
          const num = Number(src[k]);
          if (Number.isFinite(num)) return num;
        }
      }
    }
    return null;
  }

  // Conservative upper entry boundary / fill reference
  let entry = findVal(['entry_high', 'entry_zone_high', 'buy_high']);
  const e1 = findVal(['entry1', 'entry_low', 'entry_zone_low', 'buy_low']);
  const e2 = findVal(['entry2']);
  if (entry == null) {
    if (e1 != null && e2 != null) entry = Math.max(e1, e2);
    else if (e2 != null) entry = e2;
    else if (e1 != null) entry = e1;
    else entry = findVal(['entry', 'entry_price', 'current_price', 'last_price', 'close']);
  }

  const sl = findVal(['stop_loss', 'sl', 'stop', 'invalidation']);
  const tp1 = findVal(['tp1', 'tp1n', 'target_1', 'target1']);

  return { entry, sl, tp1 };
}

function recalculateRiskReward(candidate) {
  const levels = extractCandidateLevels(candidate);
  if (!levels || levels.entry == null || levels.sl == null || levels.tp1 == null) return null;
  const { entry, sl, tp1 } = levels;
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp1)) return null;
  if (entry <= sl || tp1 <= entry || sl <= 0) return null;
  const rr = (tp1 - entry) / (entry - sl);
  return Number.isFinite(rr) && rr >= 0 ? Math.round(rr * 100) / 100 : null;
}

function passesRiskRewardFilter(candidate, minRatio = MIN_RR_RATIO, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const threshold = (typeof minRatio === 'number' && !Number.isNaN(minRatio))
    ? minRatio
    : MIN_RR_RATIO;

  const RR_EPSILON = 1e-12;

  // Fail-closed jika level struktural tidak valid (SL >= entry, TP1 <= entry, SL <= 0)
  const levels = extractCandidateLevels(candidate);
  if (levels && levels.entry != null && levels.sl != null && levels.tp1 != null) {
    if (levels.entry <= levels.sl || levels.tp1 <= levels.entry || levels.sl <= 0) {
      return false;
    }
  }

  let rawVal = null;

  const sources = [
    candidate.levels,
    candidate,
    candidate.observation && candidate.observation.metrics,
    candidate.observation,
    candidate.metrics,
    candidate.trade_plan_v2
  ].filter(src => src && typeof src === 'object');

  for (const src of sources) {
    for (const k of ['risk_reward', 'riskReward', 'rr', 'rr_ratio', 'rrRatio', 'rr_to_tp1']) {
      if (src[k] != null && src[k] !== '') {
        const n = Number(src[k]);
        if (Number.isFinite(n)) {
          rawVal = n;
          break;
        }
      }
    }
    if (rawVal != null) break;
  }

  // Audit Tahap 1B / SAFE-1 s/d SAFE-7:
  // Jika options.recalculate true, candidate.recalculate_rr true, atau rawVal belum ada:
  // hitung ulang R/R langsung dari level struktural final.
  if (rawVal == null || options.recalculate === true || candidate.recalculate_rr === true) {
    const recalculated = recalculateRiskReward(candidate);
    if (recalculated != null) {
      rawVal = recalculated;
    }
  }

  if (rawVal == null) {
    return false;
  }

  const numVal = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim());

  if (!Number.isFinite(numVal) || numVal < 0) {
    return false;
  }

  return numVal + RR_EPSILON >= threshold;
}

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

  // Fase 3 / BUG-F3-01: setup yang harganya sudah menembus stop loss tidak boleh
  // direvalidasi sebagai entry baru — strukturnya sudah gagal.
  if (candidate.last_price != null && candidate.stop_loss != null &&
      Number.isFinite(Number(candidate.last_price)) && Number.isFinite(Number(candidate.stop_loss)) &&
      Number(candidate.last_price) <= Number(candidate.stop_loss)) {
    return { pass: false, reason: 'stop_loss_breached' };
  }

  // Fase 3 / BUG-F3-02: setup yang harganya sudah mencapai/melampaui TP1 tidak
  // boleh direvalidasi sebagai entry baru (anti-chasing di pucuk).
  if (candidate.last_price != null && candidate.tp1 != null &&
      Number.isFinite(Number(candidate.last_price)) && Number.isFinite(Number(candidate.tp1)) &&
      Number(candidate.last_price) >= Number(candidate.tp1)) {
    return { pass: false, reason: 'tp1_already_hit' };
  }

  const minRR = (typeof options.min_rr === 'number') ? options.min_rr : MIN_RR_RATIO;
  if (!passesRiskRewardFilter(candidate, minRR)) {
    return { pass: false, reason: 'poor_risk_reward' };
  }

  const minVR = (typeof options.min_volume_ratio === 'number') ? options.min_volume_ratio : MIN_BREAKOUT_VOLUME_RATIO;
  // Fase 3 / BUG-F3-04: evaluasi SETIAP field status secara independen. Rantai
  // short-circuit sebelumnya membuat entry_status truthy (mis. 'EXTENDED')
  // menutupi status breakout (mis. 'READY_BREAKOUT') sehingga gate volume lolos.
  const isBreakoutOrEntry = options.require_volume === true ||
    [candidate.entry_status, candidate.status, candidate.breakout_confirmation_status].some((raw) =>
      raw != null && ['BREAKOUT_CONFIRMED', 'READY_BREAKOUT', 'A_PLUS_SETUP', 'IN_ENTRY_AREA', 'TRADE_CANDIDATE']
        .includes(String(raw).toUpperCase())
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
  recalculateRiskReward,
  passesVolumeBreakoutConfirmation,
  isCandleCloseConfirmed,
  validateRevalidationSignal
};

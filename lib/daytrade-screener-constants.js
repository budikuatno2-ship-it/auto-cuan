'use strict';

// One immutable source for thresholds consumed by initial classification and
// the inactive evaluation adapter. Changing these values changes decisions.
const INITIAL_CLASSIFICATION_THRESHOLDS = Object.freeze({
  persistence_score: 50,
  avoid_score: 40,
  early_building_score: 58,
  momentum_score: 60,
  early_radar_score: 62,
  near_breakout_score: 65,
  prespike_score: 70,
  ready_score: 75,
  trade_candidate_score: 78,
  a_plus_score: 88,
  ready_risk_reward: 1.5,
  max_ready_risk_distance_pct: 5,
  prespike_volume_ratio: 1.2,
  a_plus_volume_ratio: 1.5,
  distribution_volume_ratio: 1.5,
  overheat_change_pct: 8.5,
  rsi_overbought: 80
});
const { SWING_NK_HIGH_RR_WARNING_THRESHOLD } = require('./swing-nk-rr-warning');

const BASE_SCORE = 25;
// V3-F03: parameter konfluensi pemenang backtest 964 riil (config/v3-f03-winning-params.json).
// Loader fail-safe: fallback = nilai pemenang bila file config hilang.
var v3f03Params = null;
try { v3f03Params = require('./v3-f03-winning-params'); } catch (_) { v3f03Params = null; }
const TRADEABLE_SCORE_THRESHOLD = 65;

module.exports = {
  INITIAL_CLASSIFICATION_THRESHOLDS,
  SWING_NK_HIGH_RR_WARNING_THRESHOLD,
  BASE_SCORE,
  TRADEABLE_SCORE_THRESHOLD
};

'use strict';

function isIntradayScoreEnabled(env) {
  env = env || process.env;
  return String(env.DAYTRADE_INTRADAY_SCORE_ENABLED || '').trim() === '1';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

// Fase 3 / BUG-F3-16: ambang batas skor agar status entry-grade tetap layak.
// Di bawah ENTRY_GRADE_MIN_SCORE, sinyal tidak lagi layak disebut A+ / entry.
var ENTRY_GRADE_MIN_SCORE = 75;
var RADAR_MIN_SCORE = 60;

function normalizeReasons(value) {
  if (Array.isArray(value)) return value.slice();
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

function applyIntradayScoreAdjustment(candidate, options) {
  options = options || {};
  var env = options.env || process.env;
  if (!candidate || typeof candidate !== 'object' || !isIntradayScoreEnabled(env)) return candidate;

  var adjustment = finiteNumber(candidate.intraday_score_adjustment_preview);
  if (adjustment === null) return candidate;

  var baseScore = finiteNumber(candidate.daytrade_score);
  var scoreField = 'daytrade_score';
  if (baseScore === null) {
    baseScore = finiteNumber(candidate.score);
    scoreField = 'score';
  }
  if (baseScore === null) return candidate;

  var adjustedScore = clampScore(baseScore + adjustment);
  var output = Object.assign({}, candidate);
  output[scoreField] = adjustedScore;
  output.base_daytrade_score = baseScore;
  output.intraday_score_adjustment_applied = adjustment;
  output.intraday_score_adjustment_reasons = normalizeReasons(candidate.intraday_score_adjustment_reasons);

  // Fase 3 / BUG-F3-16: penalti intraday yang menjatuhkan skor di bawah ambang
  // tradeable tidak boleh menyisakan label status/confidence lama (mis. tetap
  // "A_PLUS_SETUP" + "A+" padahal skor sudah 55). Turunkan secara proporsional.
  var statusRaw = candidate.status != null ? String(candidate.status).trim().toUpperCase() : '';
  var confidenceRaw = candidate.confidence != null ? String(candidate.confidence).trim().toUpperCase() : '';
  var wasEntryGrade = /^(A_PLUS_SETUP|A_PLUS|TRADE_CANDIDATE|ENTRY_READY)$/.test(statusRaw) ||
    /^A\+?$/.test(confidenceRaw);
  if (wasEntryGrade && adjustedScore < ENTRY_GRADE_MIN_SCORE) {
    output.status = adjustedScore >= RADAR_MIN_SCORE ? 'WAIT_PULLBACK' : 'AVOID';
    if (confidenceRaw) {
      output.confidence = adjustedScore >= RADAR_MIN_SCORE ? 'B' : 'C';
    }
    output.intraday_status_downgrade_reason = 'intraday_score_below_entry_grade';
  }
  if (candidate.intraday_priority_label !== undefined && candidate.intraday_priority_label !== null && candidate.intraday_priority_label !== '') {
    output.intraday_priority_label = candidate.intraday_priority_label;
  }
  return output;
}

function applyIntradayScoreAdjustmentToList(candidates, options) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map(function(candidate) {
    return applyIntradayScoreAdjustment(candidate, options);
  });
}

module.exports = {
  isIntradayScoreEnabled: isIntradayScoreEnabled,
  applyIntradayScoreAdjustment: applyIntradayScoreAdjustment,
  applyIntradayScoreAdjustmentToList: applyIntradayScoreAdjustmentToList
};

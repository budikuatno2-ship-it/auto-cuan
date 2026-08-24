'use strict';

/**
 * Day Trade execution ranking
 * ===========================
 *
 * Keeps the raw technical score separate from whether the current trade plan is
 * actually executable. A strong momentum score must not outrank a valid trade
 * solely because the candidate has poor RR, is already in a blocked status, or
 * is only a radar/watch setup.
 *
 * This module is pure: no DB, time, network, or mutation.
 */

const READY_STATUSES = new Set([
  'A_PLUS_SETUP',
  'TRADE_CANDIDATE',
  'READY_BREAKOUT'
]);

const BLOCKED_STATUSES = new Set([
  'AVOID',
  'INVALID',
  'INVALID_BELOW_SL'
]);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function rrBand(rr) {
  if (rr == null) return 'UNKNOWN';
  if (rr < 1.0) return 'BELOW_MINIMUM';
  if (rr < 1.2) return 'MARGINAL';
  if (rr < 1.5) return 'ADEQUATE';
  if (rr < 2.0) return 'GOOD';
  return 'STRONG';
}

function deriveDayTradeExecutionQuality(row) {
  row = row || {};

  const rawScore = finite(row.daytrade_score) ?? 0;
  const rr = finite(row.risk_reward);
  const status = normalizeStatus(row.status);
  const band = rrBand(rr);

  let executionQualityStatus;
  let executionQualityLabel;
  let executionRankBucket;
  let adjustment;
  let reason;

  if (rr == null) {
    executionQualityStatus = 'BLOCKED';
    executionQualityLabel = 'Blocked — RR tidak tersedia';
    executionRankBucket = 4;
    adjustment = -100;
    reason = 'RR tidak tersedia sehingga kelayakan eksekusi tidak dapat diverifikasi.';
  } else if (rr < 1.0) {
    executionQualityStatus = 'BLOCKED';
    executionQualityLabel = 'Blocked — RR < 1.0';
    executionRankBucket = 4;
    adjustment = -100;
    reason = 'Reward lebih kecil dari risk; kandidat tidak boleh masuk ranking executable.';
  } else if (BLOCKED_STATUSES.has(status)) {
    executionQualityStatus = 'BLOCKED';
    executionQualityLabel = 'Blocked — status ' + (status || 'INVALID');
    executionRankBucket = 4;
    adjustment = -100;
    reason = 'Status screener memblokir entry baru meskipun raw score/RR terlihat baik.';
  } else if (READY_STATUSES.has(status)) {
    if (rr < 1.2) {
      executionQualityStatus = 'EXECUTABLE_MARGINAL';
      executionQualityLabel = 'Executable — RR marginal';
      executionRankBucket = 2;
      adjustment = -10;
      reason = 'Setup siap dieksekusi tetapi RR berada di band 1.00–1.19 dan diberi penalti ranking.';
    } else if (rr < 1.5) {
      executionQualityStatus = 'EXECUTABLE_ADEQUATE';
      executionQualityLabel = 'Executable — RR cukup';
      executionRankBucket = 1;
      adjustment = -4;
      reason = 'Setup siap dieksekusi; RR cukup tetapi belum masuk band kuat.';
    } else {
      executionQualityStatus = 'EXECUTABLE';
      executionQualityLabel = rr >= 2.0 ? 'Executable — RR kuat' : 'Executable';
      executionRankBucket = 0;
      adjustment = rr >= 2.0 ? 4 : 0;
      reason = 'Setup siap dieksekusi dengan RR memenuhi band kuat.';
    }
  } else {
    executionQualityStatus = 'RADAR_ONLY';
    executionQualityLabel = 'Radar only — belum executable';
    executionRankBucket = 3;
    adjustment = -15;
    reason = 'Raw score tetap disimpan sebagai informasi radar, tetapi status saat ini belum layak diprioritaskan sebagai entry executable.';
  }

  return {
    daytrade_raw_score: rawScore,
    final_executable_score: clamp(rawScore + adjustment, 0, 100),
    execution_score_adjustment: adjustment,
    execution_rank_bucket: executionRankBucket,
    execution_quality_status: executionQualityStatus,
    execution_quality_label: executionQualityLabel,
    execution_blocked: executionQualityStatus === 'BLOCKED',
    execution_rank_reason: reason,
    execution_rr_band: band,
    execution_rr: rr
  };
}

function compareDayTradeExecution(a, b) {
  const qa = deriveDayTradeExecutionQuality(a);
  const qb = deriveDayTradeExecutionQuality(b);

  if (qa.execution_rank_bucket !== qb.execution_rank_bucket) {
    return qa.execution_rank_bucket - qb.execution_rank_bucket;
  }
  if (qb.final_executable_score !== qa.final_executable_score) {
    return qb.final_executable_score - qa.final_executable_score;
  }
  const rrA = qa.execution_rr ?? -Infinity;
  const rrB = qb.execution_rr ?? -Infinity;
  if (rrB !== rrA) return rrB - rrA;
  if (qb.daytrade_raw_score !== qa.daytrade_raw_score) {
    return qb.daytrade_raw_score - qa.daytrade_raw_score;
  }
  return String(a && a.ticker || '').localeCompare(String(b && b.ticker || ''));
}

function decorateDayTradeExecution(row) {
  return Object.assign({}, row || {}, deriveDayTradeExecutionQuality(row));
}

function sortDayTradeByExecution(rows) {
  return (Array.isArray(rows) ? rows.slice() : [])
    .sort(compareDayTradeExecution);
}

module.exports = {
  READY_STATUSES,
  BLOCKED_STATUSES,
  rrBand,
  deriveDayTradeExecutionQuality,
  compareDayTradeExecution,
  decorateDayTradeExecution,
  sortDayTradeByExecution
};

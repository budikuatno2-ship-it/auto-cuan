'use strict';

/**
 * Intraday Production-Eligibility Policy (pure helper)
 *
 * Classifies a candidate's data-quality status consistently with the
 * production recommendation filter used for public output.
 *
 * This module is deliberately PURE and dependency-free:
 *   - no I/O, no network, no API-handler imports, no Supabase, no Telegram.
 *   - research code (lifecycle/summary) can import it safely.
 *
 * The exclusion set mirrors the effective production filter in
 * api/sector-hot.js (candidatePassesDayTradeRecommendation gate):
 *   excluded when data_quality_valid === false
 *              OR data_quality_needs_revalidation === true
 *              OR data_quality_status in the risk set below.
 *
 * IMPORTANT: eligibility is a DATA-QUALITY decision only. It must NOT be
 * derived from `execution_grade === 'Avoid'` (execution_grade maps to the
 * engine `confidence` field, which is a separate axis and would misclassify
 * otherwise-clean candidates).
 */

// Canonical data-quality-risk statuses (upper-cased). Kept aligned with
// DATA_QUALITY_LABELS in lib/daytrade-screener-engine.js and the exclusion
// object in api/sector-hot.js.
const DATA_QUALITY_RISK_STATUSES = Object.freeze([
  'CORPORATE_ACTION_RISK',
  'INVALID_CANDLE',
  'SHORT_HISTORY',
  'MISSING_REFERENCE',
  'SPARSE_TRADING_DAYS',
  'NEEDS_REVALIDATION'
]);

const RISK_STATUS_SET = Object.freeze(
  DATA_QUALITY_RISK_STATUSES.reduce((acc, s) => { acc[s] = true; return acc; }, {})
);

function normalizeStatus(status) {
  if (status == null) return '';
  return String(status).trim().toUpperCase();
}

/**
 * True when the given data-quality status string is a production-excluding
 * risk status. OK / null / unknown statuses return false.
 */
function isDataQualityRiskStatus(status) {
  const s = normalizeStatus(status);
  if (!s) return false;
  return RISK_STATUS_SET[s] === true;
}

/**
 * Classify a candidate/record for production eligibility.
 *
 * Recognized (all optional) fields on `record`:
 *   - data_quality_status            (string)
 *   - data_quality_valid             (boolean)
 *   - data_quality_needs_revalidation(boolean)
 *
 * @returns {{ eligible: boolean, reason: string, risk_status: (string|null) }}
 *   reason is a stable machine-readable token:
 *     'ok'
 *     'data_quality_invalid'          (data_quality_valid === false)
 *     'needs_revalidation'            (data_quality_needs_revalidation === true)
 *     'data_quality_risk:<STATUS>'    (status in risk set)
 */
function classifyProductionEligibility(record) {
  const r = record || {};
  const status = normalizeStatus(r.data_quality_status);

  if (r.data_quality_valid === false) {
    return { eligible: false, reason: 'data_quality_invalid', risk_status: status || null };
  }
  if (r.data_quality_needs_revalidation === true) {
    return { eligible: false, reason: 'needs_revalidation', risk_status: status || 'NEEDS_REVALIDATION' };
  }
  if (status && RISK_STATUS_SET[status] === true) {
    return { eligible: false, reason: 'data_quality_risk:' + status, risk_status: status };
  }
  return { eligible: true, reason: 'ok', risk_status: null };
}

module.exports = {
  DATA_QUALITY_RISK_STATUSES,
  isDataQualityRiskStatus,
  classifyProductionEligibility
};

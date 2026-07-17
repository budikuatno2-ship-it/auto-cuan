'use strict';

function count(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function asArray(value) { return Array.isArray(value) ? value : []; }

function coverageFromObserve(report, requestedLimit) {
  const rows = asArray(report && report.rows);
  const source = report && report.source || {};
  const coverage = report && report.coverage || {};
  const hasCoverage = Object.prototype.hasOwnProperty.call(coverage, 'universe_count') && Object.prototype.hasOwnProperty.call(coverage, 'evaluated_universe_count') && Object.prototype.hasOwnProperty.call(coverage, 'provider_checked_count');
  const requested = count(coverage.requested_limit ?? requestedLimit);
  const universeCount = hasCoverage ? count(coverage.universe_count) : 0;
  const evaluated = hasCoverage ? count(coverage.evaluated_universe_count) : 0;
  const providerChecked = hasCoverage ? count(coverage.provider_checked_count) : 0;
  const providerMissing = count(coverage.provider_missing_count ?? rows.filter((row) => row && row.data_quality === 'NO_INTRADAY_DATA').length);
  const providerMatched = count(coverage.provider_matched_count ?? Math.max(0, providerChecked - providerMissing));
  return {
    requested_limit: requested,
    universe_source: coverage.universe_source || source.candidates || 'unknown',
    full_universe_loaded: coverage.full_universe_loaded === true,
    universe_count: universeCount,
    evaluated_universe_count: evaluated,
    provider_checked_count: providerChecked,
    provider_matched_count: providerMatched,
    provider_missing_count: providerMissing,
    sampled_evidence_tickers: asArray(coverage.sampled_evidence_tickers).length ? coverage.sampled_evidence_tickers : rows.slice(0, 20).map((row) => row && row.ticker).filter(Boolean),
    excluded_count: count(coverage.excluded_count),
    exclusion_reason_counts: coverage.exclusion_reason_counts || {},
    quarantined_count: count(coverage.quarantined_count),
    candidate_count: count(coverage.candidate_count ?? rows.length)
  };
}

function evidenceScope(coverage) {
  const requested = count(coverage && coverage.requested_limit);
  const universe = count(coverage && coverage.universe_count);
  const evaluated = count(coverage && coverage.evaluated_universe_count);
  const checked = count(coverage && coverage.provider_checked_count);
  if (!universe || !evaluated || !checked) return 'candidate_level';
  // requested_limit is an operator hint. Full coverage is measured against the
  // loaded official universe, which can legitimately be below an old limit.
  if (!coverage || coverage.full_universe_loaded !== true) return requested ? 'partial_universe' : 'candidate_level';
  if (evaluated < universe || checked < universe) return 'partial_universe';
  return 'full_universe';
}

function finalGate({ evidence_scope, gate_status, gate_block_reasons, coverage, quarantine_tickers, daily_score_only_tickers }) {
  const reasons = asArray(gate_block_reasons).slice();
  const c = coverage || {};
  if (evidence_scope !== 'full_universe') reasons.push(`evidence_scope is ${evidence_scope}, not full_universe`);
  if (count(c.provider_matched_count) + asArray(quarantine_tickers).length < count(c.evaluated_universe_count)) reasons.push(`provider coverage incomplete: matched ${count(c.provider_matched_count)} plus quarantined ${asArray(quarantine_tickers).length}/${count(c.evaluated_universe_count)}`);
  const quarantinesIsolated = asArray(quarantine_tickers).every((ticker) => asArray(daily_score_only_tickers).includes(ticker));
  if (asArray(quarantine_tickers).length && !quarantinesIsolated) reasons.push('quarantined tickers are not all explicitly DAILY_SCORE_ONLY');
  if (reasons.length) return { dry_run_gate: 'BLOCK', block_reasons: [...new Set(reasons)] };
  return { dry_run_gate: asArray(quarantine_tickers).length ? 'PASS_WITH_QUARANTINE' : (gate_status === 'PASS_WITH_QUARANTINE' ? 'PASS_WITH_QUARANTINE' : 'PASS'), block_reasons: [] };
}

module.exports = { coverageFromObserve, evidenceScope, finalGate };

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coverage = require('../lib/daytrade-intraday-validation-coverage');

function full(overrides = {}) {
  return Object.assign({ requested_limit: 12, universe_count: 12, evaluated_universe_count: 12, provider_checked_count: 12, provider_matched_count: 12, provider_missing_count: 0, candidate_count: 3, full_universe_loaded: true }, overrides);
}

test('candidate-only evidence remains BLOCK', () => {
  const c = coverage.coverageFromObserve({ rows: [{ ticker: 'AAA' }] }, 957);
  assert.equal(coverage.evidenceScope(c), 'candidate_level');
  assert.equal(coverage.finalGate({ evidence_scope: 'candidate_level', coverage: c }).dry_run_gate, 'BLOCK');
});

test('session bundle top-level coverage propagates without using the old requested limit', () => {
  const c = coverage.coverageFromObserve({
    requested_limit: 772,
    universe_source: 'full_daytrade_eligible_universe',
    universe_count: 772,
    evaluated_universe_count: 772,
    provider_checked_count: 772,
    provider_matched_count: 771,
    provider_missing_count: 1,
    candidate_count: 18,
    rows: [{ ticker: 'AAA' }]
  }, 957);
  assert.equal(c.requested_limit, 772);
  assert.equal(c.universe_source, 'full_daytrade_eligible_universe');
  assert.equal(c.universe_count, 772);
  assert.equal(c.candidate_count, 18);
  assert.equal(coverage.evidenceScope(c), 'full_universe');
  const result = coverage.finalGate({ evidence_scope: coverage.evidenceScope(c), gate_status: 'BLOCK', gate_block_reasons: ['provider/data quality failed'], coverage: c });
  assert.equal(result.dry_run_gate, 'BLOCK');
  assert.match(result.block_reasons.join('; '), /provider\/data quality failed/);
});

test('nested coverage takes precedence over flattened session bundle fields', () => {
  const c = coverage.coverageFromObserve({
    requested_limit: 957,
    universe_source: 'unknown',
    universe_count: 0,
    evaluated_universe_count: 0,
    provider_checked_count: 0,
    coverage: full({ requested_limit: 772, universe_source: 'full_daytrade_eligible_universe', candidate_count: 18 })
  }, 957);
  assert.equal(c.requested_limit, 772);
  assert.equal(c.universe_source, 'full_daytrade_eligible_universe');
  assert.equal(c.universe_count, 12);
  assert.equal(c.candidate_count, 18);
});

test('partial universe evidence remains BLOCK', () => {
  const c = full({ universe_count: 7, evaluated_universe_count: 7, provider_checked_count: 7, provider_matched_count: 7, full_universe_loaded: false });
  assert.equal(coverage.evidenceScope(c), 'partial_universe');
  assert.equal(coverage.finalGate({ evidence_scope: 'partial_universe', coverage: c }).dry_run_gate, 'BLOCK');
});

test('clean full-universe evidence can pass dry-run reporting', () => {
  const c = full();
  assert.equal(coverage.evidenceScope(c), 'full_universe');
  assert.deepEqual(coverage.finalGate({ evidence_scope: 'full_universe', gate_status: 'PASS', coverage: c }), { dry_run_gate: 'PASS', block_reasons: [] });
});

test('isolated DAILY_SCORE_ONLY quarantine can pass dry-run reporting only', () => {
  const c = full({ provider_matched_count: 11, provider_missing_count: 1 });
  const result = coverage.finalGate({ evidence_scope: 'full_universe', gate_status: 'PASS_WITH_QUARANTINE', coverage: c, quarantine_tickers: ['LPGI'], daily_score_only_tickers: ['LPGI'] });
  assert.equal(result.dry_run_gate, 'PASS_WITH_QUARANTINE');
  assert.deepEqual(result.block_reasons, []);
});

test('old requested limit does not block a fully covered loaded official universe', () => {
  const c = full({ requested_limit: 957, universe_count: 772, evaluated_universe_count: 772, provider_checked_count: 772, provider_matched_count: 772, full_universe_loaded: true });
  assert.equal(coverage.evidenceScope(c), 'full_universe');
});

test('incomplete provider row blocks unless explicitly quarantined DAILY_SCORE_ONLY', () => {
  const c = full({ full_universe_loaded: true, provider_matched_count: 11, provider_missing_count: 1 });
  const result = coverage.finalGate({ evidence_scope: 'full_universe', gate_status: 'PASS', coverage: c });
  assert.equal(result.dry_run_gate, 'BLOCK');
  assert.match(result.block_reasons.join('; '), /provider coverage incomplete/);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coverage = require('../lib/daytrade-intraday-validation-coverage');

function full(overrides = {}) {
  return Object.assign({ requested_limit: 12, universe_count: 12, evaluated_universe_count: 12, provider_checked_count: 12, provider_matched_count: 12, provider_missing_count: 0, candidate_count: 3 }, overrides);
}

test('candidate-only evidence remains BLOCK', () => {
  const c = coverage.coverageFromObserve({ rows: [{ ticker: 'AAA' }] }, 957);
  assert.equal(coverage.evidenceScope(c), 'candidate_level');
  assert.equal(coverage.finalGate({ evidence_scope: 'candidate_level', coverage: c }).dry_run_gate, 'BLOCK');
});

test('partial universe evidence remains BLOCK', () => {
  const c = full({ universe_count: 7, evaluated_universe_count: 7, provider_checked_count: 7, provider_matched_count: 7 });
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

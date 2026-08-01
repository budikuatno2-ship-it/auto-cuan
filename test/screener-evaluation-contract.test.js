'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalConfig, normalizeGateTrace, normalizeEvaluationRecord } = require('../lib/screener-evaluation-contract');

function gate() { return { schema_version: 1, rule_set_version: 'daytrade-v1', gates: { liquidity: { value: 1500000000, threshold: 1000000000, operator: '>=', passed: true, rule_version: '1' } } }; }
test('canonical config recursively sorts keys, preserves arrays, and hashes exact UTF-8 bytes', () => {
  const a = canonicalConfig({ z: [3, 2], a: { y: '✓', x: 1 } });
  const b = canonicalConfig({ a: { x: 1, y: '✓' }, z: [3, 2] });
  assert.deepEqual(a, b); assert.equal(a.json, '{"a":{"x":1,"y":"✓"},"z":[3,2]}'); assert.match(a.hash, /^[a-f0-9]{64}$/);
});
test('gate trace is versioned, typed, and bounded', () => {
  assert.equal(normalizeGateTrace(gate()).gates.liquidity.passed, true);
  assert.throws(() => normalizeGateTrace({ ...gate(), schema_version: 2 }), /supported/);
  assert.throws(() => normalizeGateTrace({ ...gate(), gates: { bad: { value: 1, threshold: 2, operator: 'DROP', passed: false, rule_version: '1' } } }), /invalid gate/);
});
test('rejected candidate stays rejected and raw/capped scores remain distinct', () => {
  const record = normalizeEvaluationRecord({ schema_version: 1, strategy: 'DAY_TRADE', run_id: 'synthetic-run', ticker: 'TEST', candidate_revision: 1, observed_at: '2026-08-01T03:00:00.000Z', passed: false, rejection_codes: ['LIQUIDITY_BELOW_MIN'], score_components_raw: { momentum: 72 }, score_raw: 112, score_display: 100, status: 'REJECTED', rank: null, rvol_raw: 0.7, rvol_seasonal: null, gate_trace: gate() });
  assert.equal(record.score_raw, 112); assert.equal(record.score_display, 100); assert.equal(record.status, 'REJECTED'); assert.equal(record.rank, null);
});
test('secret-like and account fields are rejected recursively', () => {
  assert.throws(() => canonicalConfig({ nested: { authorization: 'Bearer synthetic' } }), /forbidden sensitive/);
  assert.throws(() => canonicalConfig({ user_id: '123' }), /forbidden sensitive/);
});

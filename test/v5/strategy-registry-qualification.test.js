'use strict';

/**
 * test/v5/strategy-registry-qualification.test.js
 * ============================================================================
 * UNIT TESTS — Strategy Registry v1 qualification gate (V5 Phase 6 PACKAGE D)
 * ============================================================================
 *
 * These tests prove three falsifiable properties of the registry:
 *
 *   1. NEGATIVE-EXPECTANCY FIXTURE: a strategy whose metrics mirror the real
 *      V3-F03 daytrade group (PF 0.76, expectancy -0.10) is REJECTED, and the
 *      evaluator writes `status: "NO_QUALIFIED_STRATEGY"`.
 *   2. POSITIVE-ADEQUATE PROPERTY: a clearly positive strategy with adequate
 *      sample and all structural §12 dimensions demonstrably present WOULD
 *      qualify (the gate discriminates, not a blanket reject).
 *   3. NO-DEFAULT-FALLBACK: the registry module never returns a silently
 *      swapped / default strategy — an empty or non-qualifying registry yields
 *      the sentinel `NO_QUALIFIED_STRATEGY` / `null`, never a manufactured
 *      production record.
 *
 * The test uses an in-memory/temp registry path so it never mutates the
 * production `data/strategy-registry.json` and never touches the network.
 *
 * Run:
 *   node test/v5/strategy-registry-qualification.test.js
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 * ============================================================================
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const REG = require(path.resolve(__dirname, '..', '..', 'lib', 'strategy-registry.js'));
const EVAL = require(path.resolve(__dirname, '..', '..', 'scripts', 'evaluate-strategy-registry.js'));

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write('PASS  ' + name + '\n');
  } catch (err) {
    results.push({ name, ok: false, error: String((err && err.message) || err) });
    process.stdout.write('FAIL  ' + name + '\n      ' + String((err && err.message) || err) + '\n');
  }
}

/** Temp registry path, unique per run, deleted after. */
function tempRegistryPath() {
  return path.join(os.tmpdir(), 'strategy-registry-qualification-' + process.pid + '-' + Date.now() + '.json');
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NEGATIVE_DAYTRADE = {
  id: 'v3-f03-daytrade',
  label: 'V3-F03 winning params — daytrade (fixture)',
  sourceFiles: ['config/v3-f03-winning-params.json'],
  metrics: {
    sampleSize: 2179,
    winRatePct: 34.83,
    profitFactor: 0.76,
    expectancyR: -0.10,
    expectancyPct: 'NOT_MEASURED',
    maxDrawdownPct: 'NOT_MEASURED',
    wilsonLower95Pct: 32.86
  },
  structural: {
    outOfSample: false,
    walkForwardByDate: false,
    feesSlippageModelled: false,
    publicationLagModelled: false,
    purgingEmbargo: false,
    antiLookahead: false
  }
};

const POSITIVE_ADEquateFixture = {
  id: 'hypothetical-positive',
  label: 'Hypothetical net-positive, adequate-sample, fully §12-compliant strategy',
  sourceFiles: ['(fixture)'],
  metrics: {
    sampleSize: 250,
    winRatePct: 55.0,
    profitFactor: 1.8,
    expectancyR: 0.4,
    expectancyPct: 4.0,
    maxDrawdownPct: 12.0,
    wilsonLower95Pct: 48.0
  },
  structural: {
    outOfSample: true,
    walkForwardByDate: true,
    feesSlippageModelled: true,
    publicationLagModelled: true,
    purgingEmbargo: true,
    antiLookahead: true
  }
};

/** Minimal positive+adequate metrics for the registry module gate. */
const POSITIVE_METRICS = { sampleSize: 250, expectancyR: 0.4, profitFactor: 1.8 };

/* -------------------------------------------------------------------------- */
/* 1. Negative-expectancy fixture is rejected + writes NO_QUALIFIED_STRATEGY    */
/* -------------------------------------------------------------------------- */

test('negative-expectancy fixture FAILS the evaluator gate', () => {
  const gate = EVAL.qualify(NEGATIVE_DAYTRADE);
  assert.strictEqual(gate.qualified, false, 'negative expectancy must not qualify');
  assert.ok(gate.reasons.some((r) => /expectancy/.test(r)), 'must cite the expectancy reason');
  assert.ok(gate.reasons.some((r) => /profitFactor/.test(r)), 'must cite the profit factor reason');
});

test('the evaluator registry gate rejects negative expectancy via the module gate too', () => {
  const gate = REG.isQualified({ sampleSize: 2179, expectancyR: -0.10, profitFactor: 0.76 });
  assert.strictEqual(gate.qualified, false);
  assert.ok(gate.reasons.some((r) => /expectancyR/.test(r)));
});

/* -------------------------------------------------------------------------- */
/* 2. Positive + adequate strategy WOULD qualify (property — gate discriminates) */
/* -------------------------------------------------------------------------- */

test('a positive, adequate, §12-complete fixture WOULD qualify in the evaluator', () => {
  const gate = EVAL.qualify(POSITIVE_ADEquateFixture);
  assert.strictEqual(gate.qualified, true, JSON.stringify(gate.reasons));
  assert.strictEqual(gate.reasons.length, 0);
});

test('a positive, adequate metrics object passes the registry module isQualified', () => {
  assert.strictEqual(REG.isQualified(POSITIVE_METRICS).qualified, true);
});

/* -------------------------------------------------------------------------- */
/* 3. No default fallback                                                     */
/* -------------------------------------------------------------------------- */

test('getQualifiedStrategy on an empty registry returns NO_QUALIFIED_STRATEGY (never a default)', () => {
  const tmp = tempRegistryPath();
  try {
    // No file -> empty registry.
    const out = REG.getQualifiedStrategy('anything', { registryPath: tmp });
    assert.strictEqual(out, REG.NO_QUALIFIED_STRATEGY);
    // And nothing was written to disk as a "fallback" strategy.
    assert.strictEqual(fs.existsSync(tmp), false);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

test('getApprovedStrategy returns null when nothing is approved (no silent swap)', () => {
  const tmp = tempRegistryPath();
  try {
    assert.strictEqual(REG.getApprovedStrategy('anything', { registryPath: tmp }), null);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

test('setProductionStrategy requires explicit approval (throws APPROVAL_REQUIRED)', () => {
  const tmp = tempRegistryPath();
  try {
    // Register a strategy WITH approval so a version exists...
    REG.registerStrategy({ id: 'x', version: '1', metrics: POSITIVE_METRICS, approvedBy: 'auditor' }, { registryPath: tmp });
    // ...but promoting without opts.approved===true must throw.
    assert.throws(
      () => REG.setProductionStrategy('x', '1', { approvedBy: 'auditor' }),
      (err) => err && err.code === REG.APPROVAL_REQUIRED
    );
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

test('approved-without-qualification is NOT promotable (throws QUALIFICATION_REQUIRED)', () => {
  const tmp = tempRegistryPath();
  try {
    // A strategy carrying ONLY approval (approvedBy) with metrics that fail
    // statistical qualification must NOT reach production.
    REG.registerStrategy(
      { id: 'approved-but-bad', version: '1', metrics: { sampleSize: 2179, expectancyR: -0.10, profitFactor: 0.76 }, approvedBy: 'auditor' },
      { registryPath: tmp }
    );
    assert.throws(
      () => REG.setProductionStrategy('approved-but-bad', '1', { approved: true, approvedBy: 'auditor', registryPath: tmp }),
      (err) => err && err.code === REG.QUALIFICATION_REQUIRED
    );
    // Nothing was promoted.
    assert.strictEqual(REG.getApprovedStrategy('approved-but-bad', { registryPath: tmp }), null);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

test('approved + statistically qualified IS promotable', () => {
  const tmp = tempRegistryPath();
  try {
    REG.registerStrategy(
      { id: 'good-approved', version: '1', metrics: POSITIVE_METRICS, approvedBy: 'auditor' },
      { registryPath: tmp }
    );
    const out = REG.setProductionStrategy('good-approved', '1', { approved: true, approvedBy: 'auditor', registryPath: tmp });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(REG.getApprovedStrategy('good-approved', { registryPath: tmp }).version, '1');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

test('NO_QUALIFIED_STRATEGY emitted when no strategy is valid (approval alone never qualifies)', () => {
  const tmp = tempRegistryPath();
  try {
    REG.registerStrategy(
      { id: 'only-approved', version: '1', metrics: { sampleSize: 2179, expectancyR: -0.10, profitFactor: 0.76 }, approvedBy: 'auditor' },
      { registryPath: tmp }
    );
    // getQualifiedStrategy must NOT return the approved record — qualification is
    // a separate, statistical bar, not implied by approvedBy.
    assert.strictEqual(REG.getQualifiedStrategy('only-approved', { registryPath: tmp }), REG.NO_QUALIFIED_STRATEGY);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

test('getQualifiedStrategy with a non-qualifying registered version returns NO_QUALIFIED_STRATEGY', () => {
  const tmp = tempRegistryPath();
  try {
    REG.registerStrategy(
      { id: 'loser', version: '1', metrics: { sampleSize: 10, expectancyR: -0.5, profitFactor: 0.4 }, approvedBy: 'auditor' },
      { registryPath: tmp }
    );
    const out = REG.getQualifiedStrategy('loser', { registryPath: tmp });
    assert.strictEqual(out, REG.NO_QUALIFIED_STRATEGY);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
});

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed\n');
if (failed.length > 0) {
  for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
  process.exit(1);
}
process.exit(0);
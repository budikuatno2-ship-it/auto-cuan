'use strict';

/**
 * test/v5/strategy-registry-pf-rr-thresholds.test.js
 * ============================================================================
 * UNIT TEST — Profit Factor threshold independent of minimum Risk/Reward
 * ============================================================================
 *
 * Proves BUG/P0 remediation (fix D): MIN_PROFIT_FACTOR is a distinct,
 * independently-configurable threshold from MIN_RR_RATIO. They are no longer a
 * single shared constant: changing one must not move the other.
 *
 * Run:
 *   node test/v5/strategy-registry-pf-rr-thresholds.test.js
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 * ============================================================================
 */

const path = require('node:path');
const assert = require('node:assert');

const REG = require(path.resolve(__dirname, '..', '..', 'lib', 'strategy-registry.js'));
const SC = require(path.resolve(__dirname, '..', '..', 'lib', 'screener-config.js'));

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

test('screener-config exposes independent MIN_PROFIT_FACTOR and MIN_RR_RATIO', () => {
  assert.strictEqual(Number(SC.MIN_RR_RATIO), 1.5);
  assert.strictEqual(Number(SC.MIN_PROFIT_FACTOR), 1.5);
  // Distinct identity: each is independently configurable and separately exported.
  assert.notStrictEqual(typeof SC.MIN_PROFIT_FACTOR, 'undefined');
});

test('registry module exposes MIN_PROFIT_FACTOR separate from MIN_RR_RATIO', () => {
  assert.strictEqual(Number(REG.MIN_RR_RATIO), 1.5);
  assert.strictEqual(Number(REG.MIN_PROFIT_FACTOR), 1.5);
});

test('profit factor threshold can be configured independently of R/R', () => {
  const good = { sampleSize: 250, expectancyR: 0.4, profitFactor: 1.6 };
  // Default (1.5): profitFactor 1.6 passes.
  assert.strictEqual(REG.isQualified(good).qualified, true);

  // Raise ONLY the profit-factor bar to 1.7; R/R remains untouched.
  const strictPF = REG.isQualified(good, { minProfitFactor: 1.7 });
  assert.strictEqual(strictPF.qualified, false);
  assert.ok(strictPF.reasons.some((r) => /MIN_PROFIT_FACTOR 1\.7/.test(r)), JSON.stringify(strictPF.reasons));

  // Lower the profit-factor bar to 1.3; 1.6 still passes (independent knob).
  assert.strictEqual(REG.isQualified(good, { minProfitFactor: 1.3 }).qualified, true);

  // Sanity: MIN_RR_RATIO was NOT perturbed by the profit-factor override.
  assert.strictEqual(Number(REG.MIN_RR_RATIO), 1.5);
});

test('a strategy failing ONLY profitFactor but passing R/R (N/A here) is still unqualified', () => {
  // profitFactor below the (default 1.5) bar with adequate sample + positive
  // expectancy: the profit-factor threshold independently gates qualification.
  const res = REG.isQualified({ sampleSize: 250, expectancyR: 0.4, profitFactor: 1.2 });
  assert.strictEqual(res.qualified, false);
  assert.ok(res.reasons.some((r) => /profitFactor/.test(r)), JSON.stringify(res.reasons));
});


const failed = results.filter((r) => !r.ok);
process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed\n');
if (failed.length > 0) {
  for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
  process.exit(1);
}
process.exit(0);
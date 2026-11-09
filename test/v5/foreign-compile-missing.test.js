'use strict';

/**
 * test/v5/foreign-compile-missing.test.js
 * ============================================================================
 * UNIT TEST — scripts/foreign-compile.js missing-flow semantics (BUG-V5-P0-011)
 * ============================================================================
 *
 * Proves a MISSING foreign-flow value stays missing (null) and is never
 * fabricated into a measured zero. `applySanityCap` delegates to
 * `checkNetForeign()`, whose `.value` is null for a non-numeric/absent input
 * and `0` only for a genuine measured zero.
 *
 * Run:
 *   node test/v5/foreign-compile-missing.test.js
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 * ============================================================================
 */

const path = require('node:path');
const assert = require('node:assert');

const FC = require(path.resolve(__dirname, '..', '..', 'scripts', 'foreign-compile.js'));

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

test('missing foreign flow (null/undefined) stays null via applySanityCap', () => {
  assert.strictEqual(FC.applySanityCap('TICK', null, 1000, 1000000), null);
  assert.strictEqual(FC.applySanityCap('TICK', undefined, 1000, 1000000), null);
  assert.strictEqual(FC.applySanityCap('TICK', '', 1000, 1000000), null);
  assert.strictEqual(FC.applySanityCap('TICK', 'bukan-angka', 1000, 1000000), null);
});

test('a genuine measured zero survives as zero (not confused with missing)', () => {
  // 0 is a real market fact when turnover is positive; it must NOT be coerced
  // to null by the `|| 0` anti-pattern.
  assert.strictEqual(FC.applySanityCap('TICK', 0, 1000, 1000000), 0);
});

test('a non-numeric net foreign is NOT published (never becomes 0)', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.strictEqual(FC.applySanityCap('TICK', bad, 1000, 1000000), null, String(bad));
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
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Build script uses modular test suite runner in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'node tools/run-build-test-suite.js');
});

test('tools/run-build-test-suite.js exists and contains all required pre-build validators', () => {
  const runnerPath = path.join(ROOT_DIR, 'tools', 'run-build-test-suite.js');
  assert.equal(fs.existsSync(runnerPath), true, 'tools/run-build-test-suite.js must exist');

  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.ok(source.includes('tools/apply-production-hotfixes.js'));
  assert.ok(source.includes('tools/apply-desktop-header-center.js'));
  assert.ok(source.includes('tools/apply-ui-bugfix-pack-v1.js'));
  assert.ok(source.includes('tools/apply-screener-lifecycle-ui.js'));
  assert.ok(source.includes('tools/validate-auth-recovery-v2.js'));
  assert.ok(source.includes('tools/validate-ai-eval-once.js'));
});

test('tools/curated-build-tests.json exists and defines a non-empty list of curated tests', () => {
  const jsonPath = path.join(ROOT_DIR, 'tools', 'curated-build-tests.json');
  assert.equal(fs.existsSync(jsonPath), true, 'tools/curated-build-tests.json must exist');
  const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 250, 'Curated list should contain at least 250 test files');
});

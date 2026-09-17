'use strict';

/**
 * Batch 17 — Validasi Penuh Sintaks & Full Regression Test Suite
 *
 * Membuktikan:
 *   1. Seluruh file .js repo (lib/tools/api/test/scripts/public/server.js)
 *      lolos parse tanpa error sintaks.
 *   2. Setiap entri di curated-build-tests.json menunjuk file yang benar-benar ada.
 *   3. Validator mendeteksi file yang rusak (self-check).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectJsFiles,
  checkFile,
  checkSyntax,
  checkCuratedTestList,
  SCAN_ROOTS
} = require('../tools/validate-full-syntax');

const ROOT = path.resolve(__dirname, '..');

test('Batch 17: every repository .js file parses without syntax errors', () => {
  const files = collectJsFiles(ROOT, SCAN_ROOTS);
  assert.ok(files.length > 100, 'expected a substantial number of .js files, got ' + files.length);
  const { checked, failures } = checkSyntax(files);
  assert.equal(checked, files.length);
  assert.equal(failures.length, 0,
    'syntax failures:\n' + failures.map((f) => f.file + ': ' + f.error).join('\n'));
});

test('Batch 17: every curated-build-tests.json entry exists on disk', () => {
  const { listed, missing } = checkCuratedTestList(ROOT);
  assert.ok(listed > 100, 'expected a substantial curated list, got ' + listed);
  assert.equal(missing.length, 0, 'missing curated test files: ' + missing.join(', '));
});

test('Batch 17: the validator detects a broken file (self-check)', () => {
  const tmp = path.join(os.tmpdir(), 'auto-cuan-broken-' + process.pid + '.js');
  fs.writeFileSync(tmp, 'function broken( { return 1; }\n');
  try {
    const r = checkFile(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('Batch 17: the validator accepts a valid file (self-check)', () => {
  const tmp = path.join(os.tmpdir(), 'auto-cuan-valid-' + process.pid + '.js');
  fs.writeFileSync(tmp, "'use strict';\nmodule.exports = { ok: true };\n");
  try {
    const r = checkFile(tmp);
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
  } finally {
    fs.unlinkSync(tmp);
  }
});

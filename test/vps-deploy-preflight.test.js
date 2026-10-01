'use strict';

/**
 * Batch 18 — Deploy Penuh ke VPS dengan PM2
 *
 * Membuktikan preflight deploy VPS:
 *   1. ecosystem.config.js memuat & berisi app yang diharapkan; setiap script ada.
 *   2. Pengecekan versi Node menghormati engines.node.
 *   3. Pengecekan env file gagal bila file hilang.
 *   4. runPreflight() menyusun hasil terstruktur dan gagal bila salah satu check gagal.
 *   5. Bundle deploy nyata (preflight di root repo, tanpa pm2) SIAP.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const preflight = require('../tools/vps-deploy-preflight');

const ROOT = path.resolve(__dirname, '..');

test('Batch 18: real repo ecosystem passes the ecosystem check', () => {
  const r = preflight.checkEcosystem(ROOT);
  assert.equal(r.ok, true, 'ecosystem problems: ' + r.problems.join(', '));
  assert.equal(r.problems.length, 0);
});

test('Batch 18: ecosystem check fails on a missing ecosystem file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  try {
    const r = preflight.checkEcosystem(tmp);
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('missing_ecosystem'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Batch 18: node version check honours engines.node major', () => {
  assert.equal(preflight.checkNodeVersion('v22.11.0', '22.x').ok, true);
  assert.equal(preflight.checkNodeVersion('v20.0.0', '22.x').ok, false);
  assert.equal(preflight.checkNodeVersion('v18.0.0', '').ok, true, 'no requirement -> ok');
});

test('Batch 18: env file check reports missing required files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  try {
    const r = preflight.checkEnvFiles(tmp, ['.env.missing']);
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('missing_env_file:.env.missing'));
    // No required files -> always ok.
    assert.equal(preflight.checkEnvFiles(tmp, []).ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Batch 18: runPreflight reports ready and skips pm2 in test context', () => {
  // Inject a Node version matching engines.node so the assertion does not depend
  // on whatever Node the CI/host happens to run.
  const result = preflight.runPreflight({ root: ROOT, skipPm2: true, nodeVersion: 'v22.11.0' });
  assert.equal(result.ready, true, 'failed: ' + result.failed.join(', '));
  assert.equal(result.failed.length, 0);
  assert.equal(result.checks.ecosystem.ok, true);
  assert.equal(result.checks.node_version.ok, true);
  assert.equal(result.checks.env_files.ok, true);
});

test('Batch 18: runPreflight fails when the node version does not match', () => {
  const result = preflight.runPreflight({ root: ROOT, skipPm2: true, nodeVersion: 'v18.0.0', requiredNode: '22.x' });
  assert.equal(result.ready, false);
  assert.ok(result.failed.includes('node_version'));
});

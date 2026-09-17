'use strict';

/**
 * Batch 20 — Laporan Akhir Konsolidasi & Cleanup (Sign-Off)
 *
 * Memverifikasi bukti konsolidasi dokumentasi 20 batch:
 *   1. SCREENER_BUGFIX_LOG.md menandai SELURUH batch 0–20 sebagai [x] SELESAI.
 *   2. SCREENER_ARCHITECTURE_AUDIT.md memuat §7 Status Penyelesaian Temuan.
 *   3. curated-build-tests.json berisi >= 394 entri dan semuanya ada di disk.
 *   4. Bukti guard utama (screener-config, market-hours-guard, ecosystem, atomic-deploy) ada.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('Batch 20: every batch 0-20 is marked SELESAI in SCREENER_BUGFIX_LOG.md', () => {
  const log = read('SCREENER_BUGFIX_LOG.md');
  for (let b = 0; b <= 20; b++) {
    const re = new RegExp('^- \\[x\\] \\*\\*Batch ' + b + '\\*\\*', 'm');
    assert.ok(re.test(log), 'Batch ' + b + ' is not marked [x] in Progres Batch');
  }
  // No unchecked batch may remain.
  assert.equal(/^- \[ \] \*\*Batch /m.test(log), false, 'there is still an unchecked batch');
});

test('Batch 20: the audit document records resolution of all findings', () => {
  const audit = read('SCREENER_ARCHITECTURE_AUDIT.md');
  assert.match(audit, /## 7\. STATUS PENYELESAIAN TEMUAN/, 'missing §7 resolution section');
  for (const f of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']) {
    assert.ok(audit.includes('**' + f + '**'), 'finding ' + f + ' not referenced');
  }
  assert.match(audit, /SELESAI/, 'resolution status placeholder missing');
});

test('Batch 20: curated test list has >= 394 entries and they all exist', () => {
  const list = JSON.parse(read('tools/curated-build-tests.json'));
  assert.ok(list.length >= 394, 'expected >= 394 curated tests, got ' + list.length);
  const missing = list.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assert.equal(missing.length, 0, 'missing curated test files: ' + missing.join(', '));
});

test('Batch 20: the core guard artifacts referenced by the audit exist', () => {
  for (const rel of [
    'lib/market-hours-guard.js',
    'lib/screener-config.js',
    'ecosystem.config.js',
    'tools/atomic-deploy.js',
    'tools/vps-deploy-preflight.js',
    'tools/live-session-monitor.js',
    'tools/validate-full-syntax.js',
    'deploy/vps/README.md'
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), 'missing guard artifact: ' + rel);
  }
});
'use strict';

/**
 * Batch 16 — Audit Ketikan Nyasar & Integritas Kode
 *
 * Membuktikan integritas kode pada modul guard/screener:
 *   1. Tidak ada deklarasi fungsi top-level yang DUPLIKAT dalam satu file
 *      (definisi kedua men-shadow yang pertama secara diam-diam — hazard).
 *   2. Dua modul yang sebelumnya punya duplikat tetap mengekspor
 *      `recommendationForStatus` yang berfungsi.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

// Files that carried a real duplicate definition (fixed in Batch 16).
const GUARDED_FILES = [
  'lib/daytrade-intraday-dry-run-gate.js',
  'lib/daytrade-intraday-staged-enable-runbook.js',
  'lib/screener-config.js',
  'lib/idx-tick-normalization.js',
  'lib/daytrade-screener-engine.js',
  'lib/market-hours-guard.js',
  'lib/telegram-notifier.js'
];

function topLevelFunctionNames(source) {
  const names = [];
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

test('Batch 16: no guarded module declares the same top-level function twice', () => {
  for (const rel of GUARDED_FILES) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const names = topLevelFunctionNames(source);
    const seen = new Set();
    const dupes = new Set();
    for (const n of names) {
      if (seen.has(n)) dupes.add(n);
      seen.add(n);
    }
    assert.equal(dupes.size, 0,
      rel + ' has duplicate top-level function definition(s): ' + Array.from(dupes).join(', '));
  }
});

test('Batch 16: dry-run gate exports a working recommendationForStatus', () => {
  const gate = require('../lib/daytrade-intraday-dry-run-gate');
  assert.equal(typeof gate.recommendationForStatus, 'function');
  assert.match(gate.recommendationForStatus('BLOCK'), /do not enable/i);
  assert.equal(gate.recommendationForStatus('UNKNOWN_X'), 'Unknown gate status.');
});

test('Batch 16: staged-enable runbook exports a working recommendationForStatus', () => {
  const runbook = require('../lib/daytrade-intraday-staged-enable-runbook');
  assert.equal(typeof runbook.recommendationForStatus, 'function');
  assert.match(runbook.recommendationForStatus('NOT_READY'), /do not enable/i);
  assert.equal(runbook.recommendationForStatus('UNKNOWN_X'), 'Unknown runbook status.');
});

test('Batch 16: the typo that was fixed stays fixed', () => {
  const guardTest = fs.readFileSync(path.join(ROOT, 'test/guard-pipeline-integration.test.js'), 'utf8');
  assert.equal(guardTest.includes('weakenning'), false, 'stray typo "weakenning" is back');
});
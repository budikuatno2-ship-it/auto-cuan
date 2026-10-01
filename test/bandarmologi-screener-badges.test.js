'use strict';

// Regression tests for two bugs found while wiring the Bagian 5 bandarmologi
// confluence badge into public/index.html's four screener card renderers.
// Both bugs were latent/pre-existing (not introduced by the badge work) but
// were only exposed once a truthy badge line reached these code paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunctionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature + ' in public/index.html');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

test('renderNkCardGrid never references the undefined _badgeLine (it must use its own _nBadgeLine)', () => {
  // Bug: a copy-paste from renderDtCardGrid left one line reading the
  // Day Trade variable name `_badgeLine` instead of `_nBadgeLine`, which
  // threw "ReferenceError: _badgeLine is not defined" and crashed the whole
  // Non-Konglo card grid render for ANY row with a truthy badge line
  // (grade/risk/pattern/foreign/bandar) — i.e. most real rows.
  const fn = extractFunctionSource(html, 'function renderNkCardGrid(');
  // Every bare `_badgeLine` token (not part of `_nBadgeLine`/`_kBadgeLine`/etc)
  // is the bug.
  const bareRefs = fn.match(/(?<![A-Za-z0-9_])_badgeLine(?![A-Za-z0-9_])/g) || [];
  assert.deepEqual(bareRefs, [], 'renderNkCardGrid must not reference the Day Trade-only _badgeLine variable');
});

test('normalizeDashboardPick copies bandar_label/bandar_consistent_windows onto the row it returns', () => {
  // Bug: buildDashboardPickRow sets bandar_* fields on the TOP-LEVEL pick
  // object (never inside raw_payload), but normalizeDashboardPick only
  // copies an explicit whitelist of fields from the top-level pick into the
  // row it builds — silently dropping any field not on that list. The
  // Top 5 bandarmologi badge would render as if the data never existed.
  const fn = extractFunctionSource(html, 'function normalizeDashboardPick(');
  assert.match(fn, /r\.bandar_label\s*=\s*p\.bandar_label/, 'bandar_label must be copied from the top-level pick object');
  assert.match(fn, /r\.bandar_consistent_windows\s*=/, 'bandar_consistent_windows must be copied from the top-level pick object');
});

test('bandarBadgeText/bandarBadgeColor: Swing tone is plain, Day Trade/Top 5 tone adds a "(konteks)" qualifier', () => {
  const helperSrc = extractFunctionSource(html, 'function bandarBadgeText(') + '\n' +
    extractFunctionSource(html, 'function bandarBadgeColor(');
  const dictStart = html.indexOf('var BANDAR_LABEL_ID');
  const dictEnd = html.indexOf(';', dictStart) + 1;
  const dict = html.slice(dictStart, dictEnd);

  const vm = require('node:vm');
  const sandbox = { Array: Array };
  vm.createContext(sandbox);
  vm.runInContext(dict + '\n' + helperSrc, sandbox);

  const row = { bandar_label: 'Accumulation', bandar_consistent_windows: ['7D', '1M'] };
  const swingText = sandbox.bandarBadgeText(row, false);
  const contextText = sandbox.bandarBadgeText(row, true);
  assert.equal(swingText, 'Bandar 7D&1M: Akumulasi');
  assert.equal(contextText, 'Bandar 7D&1M: Akumulasi (konteks)');
  assert.doesNotMatch(swingText, /konteks/, 'Swing badge must read as a plain supporting signal, matching the existing Foreign-flow badge tone');

  assert.equal(sandbox.bandarBadgeText({ bandar_label: 'Bandar Data Unavailable' }, false), '', 'no data must render no badge, never a fabricated one');
  assert.equal(sandbox.bandarBadgeColor({ bandar_label: 'Distribution' }), '#fca5a5');
  assert.equal(sandbox.bandarBadgeColor({ bandar_label: 'Accumulation' }), '#6ee7b7');
});

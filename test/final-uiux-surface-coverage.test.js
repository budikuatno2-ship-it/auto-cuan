'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const css = read('public/ui-theme.css');
const html = read('public/index.html');

test('final polish covers all primary workspace surfaces without business logic', () => {
  [
    '#page-dashboard', '#page-analisis', '#page-screener', '#page-watchlist',
    '#page-sektor', '#page-portofolio',
    '#page-trackrecord', '#acAccountCenter'
  ].forEach((selector) => assert.ok(css.includes(selector), selector + ' must be covered'));
  assert.doesNotMatch(css, /fetch\(|localStorage|recommendation\s*=|score\s*=/i);
});

test('legacy dark-heavy research surfaces are remapped only in light mode', () => {
  assert.match(css, /html\.light :is\(#page-screener,#page-watchlist,#page-sektor,#page-trackrecord\) \[class\*="bg-dark-"\]/);
  assert.match(css, /html\.light #portofolioPartialMount/);
  assert.match(css, /html\.light #acAccountCenter/);
});

test('mobile polish keeps page content contained and touch-friendly', () => {
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /overscroll-behavior-inline:\s*contain/);
  assert.match(css, /@media \(max-width: 600px\)/);
});

test('core page ids still exist after visual-only changes', () => {
  [
    'page-dashboard', 'page-analisis', 'page-screener', 'page-watchlist',
    'page-sektor', 'page-portofolio', 'page-trackrecord'
  ].forEach((id) => assert.ok(html.includes('id="' + id + '"'), id + ' must remain in index.html'));
  assert.equal(html.includes('id="page-money-management"'), false, 'page-money-management must be decommissioned');
});

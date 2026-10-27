'use strict';

// HANDOFF 5a performance rules that were measured to matter (hover profile,
// CPU 4x): number formatters built once, overlays written after the chart's
// own frame, and no :has() rule that is re-checked on every DOM change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const runtime = read('public/market-feature-runtime.js');

test('axis and series formatters do not build an Intl formatter per call', () => {
  assert.match(runtime, /priceFormatter: function\(p\) \{ return _axisFmt\.format\(p\); \}/);
  assert.match(runtime, /function acNumFmt\(min, max\) \{/);
  assert.match(runtime, /return 'Rp ' \+ acNumFmt\(0, 0\)\.format\(Math\.round\(price\)\);/);
  assert.match(runtime, /return sign \+ acNumFmt\(0, 0\)\.format\(Math\.round\(abs\)\);/);
});

test('legend, cursor box and high/low labels are written after the frame', () => {
  assert.match(runtime, /function acAfterPaint\(fn\) \{/);
  assert.match(runtime, /var schedule = function\(\) \{ if \(!raf\) raf = acAfterPaint\(place\); \};/);
  assert.match(runtime, /if \(!raf\) raf = acAfterPaint\(draw\);/);
  assert.match(runtime, /_hdrRaf = acAfterPaint\(function\(\) \{/);
});

test('no :has() rule that every DOM change re-checks', () => {
  const css = ['public/ac-v2.css', 'public/ui-theme.css'].map(read).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\bdiv:has\(/, 'a div:has() subject matches every div');
  // body-level checks only look at body's own children
  const bodyHas = css.match(/body:(?:not\(:)?has\([^{]*/g) || [];
  assert.ok(bodyHas.length >= 3);
  bodyHas.forEach((sel) => {
    const args = sel.replace(/^body:(?:not\(:)?has\(/, '').split(/,\s*(?![^()]*\))/);
    args.forEach((a) => assert.match(a.trim(), /^>/, 'child combinator in ' + sel.slice(0, 80)));
  });
});

'use strict';

// The lines fetchQuoteContext() builds are grounding: the model reads them as
// facts about the stock. Two blocks in that function disagreed about missing
// data — the technical block guarded every field with `!= null`, while the
// Volume Intelligence block below it used `|| 0` and the pivot block used bare
// concatenation. So the same absent field could be stated as a real reading:
//
//   Volume vs Avg 20D: 0x        (no 20-day average was available)
//   Price Change 1D: 0%          (no daily change was available)
//   Support 1: undefined         (no pivot was available)
//
// A model given "Volume vs Avg 20D: 0x" has been told volume collapsed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function sliceFunction(name) {
  const start = html.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

const source = sliceFunction('fetchQuoteContext');

test('no volume or price-change line can default a missing value to zero', () => {
  const fabricated = [
    /volumeVsAvg3 \|\| 0/,
    /volumeVsAvg7 \|\| 0/,
    /volumeVsAvg20 \|\| 0/,
    /volumeAvg20 \|\| 0/,
    /priceChange1D \|\| 0/,
    /q\.volume \|\| 0/
  ];
  fabricated.forEach(pattern => {
    assert.doesNotMatch(source, pattern, 'a missing value is defaulted to 0: ' + pattern);
  });
});

test('every Volume Intelligence reading is emitted only when it exists', () => {
  const block = source.slice(source.indexOf('[Auto-Cuan Volume Intelligence]'));
  [
    ['Volume Terakhir', /if \(q\.volume != null\) lines\.push\('Volume Terakhir/],
    ['Rata-rata 20 Hari', /if \(q\.volumeAvg20 != null\) lines\.push\('Rata-rata 20 Hari/],
    ['Volume vs Avg 3D', /if \(q\.volumeVsAvg3 != null\)/],
    ['Volume vs Avg 7D', /if \(q\.volumeVsAvg7 != null\)/],
    ['Volume vs Avg 20D', /if \(q\.volumeVsAvg20 != null\)/],
    ['Price Change 1D', /if \(q\.priceChange1D != null\)/],
    ['Volume Trend', /if \(q\.volumeTrend\) lines\.push\('Volume Trend/]
  ].forEach(([label, pattern]) => {
    assert.match(block, pattern, label + ' is not guarded');
  });
});

test('an absent pivot is omitted rather than written as the string "undefined"', () => {
  assert.doesNotMatch(source, /lines\.push\('Support 1: ' \+ q\.pivot\.support1\)/);
  assert.match(source, /entry\[1\] != null && entry\[1\] !== ''/);
});

test('a reading that genuinely is zero is still allowed through', () => {
  // The guards test for null/undefined, never for falsiness, so a real 0%
  // change or a real 0 volume is still reported.
  assert.doesNotMatch(source, /if \(q\.priceChange1D\) lines\.push/);
  assert.doesNotMatch(source, /if \(q\.volume\) lines\.push\('Volume Terakhir/);
  assert.doesNotMatch(source, /if \(q\.volumeVsAvg20\) lines\.push/);
});

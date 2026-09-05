'use strict';

// UI/UX audit request: the Track Record signal list was a dense multi-column
// table (10 columns) that was hard to scan quickly and had no internal
// scroll of its own (the whole page had to be scrolled to see more than a
// screenful of rows). Redesigned into a card list with a clear visual
// hierarchy — ticker/category/status up top, entry/TP/SL levels in the
// middle, gain/duration as secondary footer info — bounded to its own
// scrollable region so the summary cards and filters above stay in view.
// Functionality (filtering, search, CSV export) is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(ROOT, 'public', 'track-record-runtime.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'premium-workstation-v11.css'), 'utf8');

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

test('renderTrackRecordTable emits scannable cards, not <tr>/<td> rows', () => {
  const body = functionBody(runtimeSource, 'function renderTrackRecordTable(');
  assert.doesNotMatch(body, /<tr[\s>]/);
  assert.doesNotMatch(body, /<td[\s>]/);
  assert.match(body, /tr-signal-card/);
  assert.match(body, /tr-signal-row-top/);
  assert.match(body, /tr-signal-levels/);
  assert.match(body, /tr-signal-footer/);
  // Status stays the most visually prominent element (top row, still styled
  // with its dynamic tone/bg/border), and entry/TP/SL stay grouped together
  // as secondary detail rather than spread across ten table columns.
  assert.match(body, /s\.status_label/);
  assert.match(body, /s\.tp1/);
  assert.match(body, /s\.sl/);
});

test('the skeleton and error states no longer emit table markup', () => {
  assert.doesNotMatch(runtimeSource, /<tr><td colspan/);
});

test('#trTableBody in index.html is a plain scrollable list container, not a <table>', () => {
  const idx = html.indexOf('id="trTableBody"');
  assert.ok(idx >= 0, 'expected #trTableBody in index.html');
  const context = html.slice(Math.max(0, idx - 400), idx + 50);
  assert.doesNotMatch(context, /<table/);
  assert.doesNotMatch(context, /<thead/);
  assert.match(html.slice(idx - 20, idx + 60), /tr-card-list/);
});

test('.tr-card-list has a bounded, internally-scrollable height', () => {
  assert.match(css, /\.tr-card-list\s*\{[^}]*max-height:\s*min\(70vh,\s*900px\)/);
  assert.match(css, /\.tr-card-list\s*\{[^}]*overflow-y:\s*auto/);
});

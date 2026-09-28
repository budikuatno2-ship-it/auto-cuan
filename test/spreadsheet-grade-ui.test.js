'use strict';

// ===========================================================================
// Guards for the spreadsheet-grade surface pass (public/spreadsheet-grade.css).
//
// The brief asked for four things and this file protects each one so a later
// edit cannot quietly undo it:
//
//   1. no grid-of-boxes background anywhere
//   2. sticky headers + hairline zebra striping on the data tables
//   3. monospaced, right-aligned currency figures
//   4. micro-motion that is fully suppressed under reduced-motion, and a
//      keep-alive rule set that cannot produce layout shift on a tab switch
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const sheet = read('public/spreadsheet-grade.css');
const html = read('public/index.html');
const analisis = read('public/analisis-saham.html');
const workstation = read('public/premium-workstation-core.css');
const theme = read('public/ui-theme.css');

// Comments carry the reasoning, so a naive grep for "grid" hits the prose that
// explains why the grid was removed. Strip them before asserting.
const declarations = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
const reduced = declarations.slice(declarations.indexOf('@media (prefers-reduced-motion'));

// ---------------------------------------------------------------------------
// 1. Load order and delivery
// ---------------------------------------------------------------------------

test('the sheet is loaded by both app shells, last', () => {
  const inIndex = html.indexOf('/spreadsheet-grade.css?v=');
  const inAnalisis = analisis.indexOf('/spreadsheet-grade.css?v=');
  assert.ok(inIndex > 0, 'index.html must load the sheet');
  assert.ok(inAnalisis > 0, 'analisis-saham.html must load the sheet');

  // It refines what the earlier sheets established, so it has to come after them.
  assert.ok(inIndex > html.indexOf('/unified-cockpit.css?v='), 'it must load after unified-cockpit.css');
  assert.ok(inAnalisis > analisis.indexOf('/ui-theme.css?v='), 'it must load after ui-theme.css');
});

test('the sheet is cache-busted and served no-store like its sibling theme sheet', () => {
  assert.match(html, /href="\/spreadsheet-grade\.css\?v=[0-9a-z-]+"/);
  const headers = JSON.parse(read('vercel.json')).headers || [];
  const entry = headers.find((row) => row.source === '/spreadsheet-grade.css');
  assert.ok(entry, 'the sheet needs a cache header entry');
  assert.match(entry.headers[0].value, /no-store/);
});

// ---------------------------------------------------------------------------
// 2. No grid of boxes
// ---------------------------------------------------------------------------

test('the background is a soft mesh, not a tiled grid', () => {
  assert.match(declarations, /radial-gradient\(/, 'a radial mesh must be present');
  assert.doesNotMatch(
    declarations,
    /repeating-linear-gradient/,
    'no repeating gradient may reintroduce a grid'
  );
  assert.doesNotMatch(
    declarations,
    /linear-gradient\([^)]*1px\s*,\s*transparent/i,
    'the 1px-line grid trick must stay gone'
  );
  assert.doesNotMatch(declarations, /background-size:\s*\d+px\s+\d+px/, 'no tiled background-size');
});

test('the workstation core no longer paints a grid over the page', () => {
  // The heavy 40px tile lived here; it is the element that read as "boxes".
  assert.doesNotMatch(
    workstation,
    /linear-gradient\(var\(--pw-grid\)\s*1px,\s*transparent\s*1px\)/,
    'the 40px grid must be removed from the core sheet'
  );
  assert.doesNotMatch(
    workstation,
    /background-size:\s*40px\s+40px/,
    'and its tiling removed with it'
  );
});

test('the mesh uses one light source and stays fixed while content scrolls', () => {
  assert.match(declarations, /background-attachment:\s*fixed/);
  const pools = (declarations.match(/radial-gradient\(/g) || []).length;
  assert.ok(pools >= 3, 'a mesh needs a few pools; found ' + pools);
});

test('dark mode is slate, not pure black, and light mode is off-white', () => {
  assert.match(declarations, /--sp-bg-deep:\s*#090d16/);
  assert.match(declarations, /--sp-bg-mid:\s*#0b0f19/);
  assert.match(declarations, /html\.light\s*\{[\s\S]*--sp-bg-deep:\s*#f8fafc/);
});

test('dark-mode cards carry a 1px border at 8% white', () => {
  assert.match(declarations, /border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.08\)/);
});

// ---------------------------------------------------------------------------
// 3. Spreadsheet-grade tables
// ---------------------------------------------------------------------------

test('the data tables get sticky headers', () => {
  assert.match(declarations, /#page-money-management[\s\S]{0,200}thead th[\s\S]{0,120}position:\s*sticky/);
  assert.match(declarations, /top:\s*0/);
});

test('the data tables get hairline zebra striping', () => {
  assert.match(declarations, /tbody tr:nth-child\(even\)/);
  assert.match(declarations, /--sp-zebra:\s*rgba\(148,\s*163,\s*184,\s*0\.030\)/);
  assert.match(declarations, /--sp-zebra-hover:/, 'a hover must exist so the stripe is not a dead end');
});

test('the stripe covers the three tables the brief names', () => {
  // Kelola Keuangan (cashflow + journal), Jurnal Portofolio (track record) and
  // Broker Summary all have to be in the selector list.
  assert.match(declarations, /#page-money-management/);
  assert.match(declarations, /#page-trackrecord/);
  assert.match(declarations, /broker-summary-table/);
});

test('currency figures are monospaced and right-aligned', () => {
  assert.match(declarations, /font-family:\s*var\(--ac-font-mono/);
  assert.match(declarations, /font-variant-numeric:\s*tabular-nums/);
  assert.match(declarations, /text-align:\s*right/);
  // JetBrains Mono is the brief's first choice and is already the token value.
  assert.match(theme, /--ac-font-mono:\s*'JetBrains Mono'/);
});

test('status badges are slim pills', () => {
  assert.match(declarations, /--sp-pill-radius:\s*999px/);
  assert.match(declarations, /border-radius:\s*var\(--sp-pill-radius\)/);
  assert.match(declarations, /font-size:\s*10px/, 'a pill is smaller than body text');
});

test('profit and loss tone is never the only cue', () => {
  // The class only sets colour; the sign stays in the rendered string, which is
  // what makes the meaning survive a greyscale print.
  for (const cls of ['.sp-up', '.sp-down', '.sp-flat']) {
    assert.match(declarations, new RegExp('\\' + cls + '\\s*\\{'));
  }
  assert.match(declarations, /\.sp-up\s*\{\s*color:\s*#34d399/);
  assert.match(declarations, /\.sp-down\s*\{\s*color:\s*#fb7185/);
});

// ---------------------------------------------------------------------------
// 4. Micro-motion and zero CLS
// ---------------------------------------------------------------------------

test('cards and buttons carry micro-interaction', () => {
  assert.match(declarations, /\.dashboard-pick-card:hover[\s\S]{0,200}transform:\s*scale\(1\.01\)/);
  assert.match(declarations, /\.sidebar-item/);
  assert.match(declarations, /\.nav-btn/);
});

test('the card transition is a deliberate easing, not a default linear', () => {
  assert.match(declarations, /cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/);
});

test('reduced motion suppresses every transition this sheet adds', () => {
  assert.match(reduced, /transition:\s*none\s*!important/);
  assert.match(reduced, /transform:\s*none/);
  for (const cls of ['dashboard-pick-card', 'screener-card', 'sektor-group-card']) {
    // Escaped literal: a `.` in a regex is "any character", which would pass on
    // an unrelated class name.
    assert.match(reduced, new RegExp('\\.' + cls + '(?![\\w-])'), cls + ' must be suppressed');
  }
});

test('the keep-alive rule set cannot produce layout shift', () => {
  // A hidden page must be out of flow, and the viewport must reserve its
  // scrollbar gutter, or toggling a page shifts every centred column.
  assert.match(declarations, /\.page-content\.hidden\s*\{\s*display:\s*none/);
  assert.match(declarations, /scrollbar-gutter:\s*stable/);
});

test('content-visibility is not applied to the hidden pages', () => {
  // It would defer their layout and pay it back as a visible shift when shown.
  assert.doesNotMatch(declarations, /content-visibility:\s*(auto|hidden)/);
});

// ---------------------------------------------------------------------------
// 5. Specificity discipline — same rules as the sibling theme sheets
// ---------------------------------------------------------------------------

test('the sheet never shouts with !important outside reduced motion', () => {
  const body = declarations.slice(0, declarations.indexOf('@media (prefers-reduced-motion'));
  const shouts = body.match(/!important/g) || [];
  assert.equal(
    shouts.length,
    0,
    'the sheet must win on specificity; found ' + shouts.length + ' !important declaration(s)'
  );
});

test('no bare utility-class override is declared', () => {
  const utilityTargets = declarations.match(/^\s*\.(text|bg|border|grid|rounded)-[^\s,{]*\s*\{/gm) || [];
  assert.equal(
    utilityTargets.length,
    0,
    'found an unscoped utility-class override: ' + utilityTargets.join(', ')
  );
});

test('the light-mode overrides are scoped under html.light', () => {
  const lightRules = declarations.match(/html\.light[^{]*\{/g) || [];
  assert.ok(lightRules.length >= 4, 'light mode needs explicit scoped overrides');
});

test('the collapsed sidebar tooltip is drawn only when the rail is collapsed', () => {
  assert.match(declarations, /\.app-sidebar\.is-collapsed \.sidebar-item::after/);
  assert.match(declarations, /content:\s*attr\(title\)/);
  // It must not be reachable while expanded, or every item shows a duplicate.
  assert.doesNotMatch(declarations, /^\.sidebar-item::after/m);
});

test('the tooltip is keyboard reachable, not hover-only', () => {
  assert.match(declarations, /:focus-visible::after/);
});

'use strict';

// ===========================================================================
// Tests for the UI theme layer (public/ui-theme.css) and the dashboard
// grouping that goes with it.
//
// The theme layer is a restyle of component classes that already exist, so the
// contract worth protecting is structural: it must load after the inline styles
// it overrides, it must keep touch targets and safe areas usable on phones, and
// it must not change behaviour or navigation.
//
// LOCAL / STATIC ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = read('public/index.html');
const theme = read('public/ui-theme.css');

// ---------------------------------------------------------------------------
// 1. Load order and delivery
// ---------------------------------------------------------------------------
test('the theme layer loads after the inline styles it overrides', () => {
  const link = html.indexOf('/ui-theme.css?v=');
  assert.ok(link > 0, 'theme stylesheet must be linked');
  assert.ok(link > html.indexOf('</style>'), 'a later sheet wins without !important');
  assert.ok(link < html.indexOf('</head>'), 'styles belong in <head>');
});

test('the theme is cache-busted and served no-store like its siblings', () => {
  assert.match(html, /href="\/ui-theme\.css\?v=[0-9a-z-]+"/);
  const headers = JSON.parse(read('vercel.json')).headers || [];
  const entry = headers.find(row => row.source === '/ui-theme.css');
  assert.ok(entry, 'theme stylesheet needs a cache header entry');
  assert.match(entry.headers[0].value, /no-store/);
});

test('the theme layer wins on merit, not with !important overrides', () => {
  // Two deliberate exceptions: the mobile nav strip must beat the Tailwind
  // display utilities already on that element, and reduced-motion overrides are
  // required by WCAG 2.3.3 to defeat any later transition.
  const rules = theme.replace(/\/\*[\s\S]*?\*\//g, '');
  const reducedMotion = rules.slice(rules.indexOf('@media (prefers-reduced-motion: reduce)'));
  const body = rules.slice(0, rules.indexOf('@media (prefers-reduced-motion: reduce)'));
  const shouts = body.match(/!important/g) || [];
  assert.equal(shouts.length, 1, 'expected exactly one !important outside reduced motion');
  assert.match(theme, /\.mobile-nav-row \{ display: none !important; \}/);
  assert.match(reducedMotion, /transition: none !important/);
});

// ---------------------------------------------------------------------------
// 2. Design tokens
// ---------------------------------------------------------------------------
test('one radius, shadow, and spacing scale replaces the ad-hoc mix', () => {
  ['--ac-radius-sm', '--ac-radius-md', '--ac-radius-lg', '--ac-radius-xl',
    '--ac-shadow-1', '--ac-shadow-2',
    '--ac-space-1', '--ac-space-2', '--ac-space-3', '--ac-space-4', '--ac-space-5',
    '--ac-text', '--ac-text-muted', '--ac-text-dim', '--ac-accent', '--ac-line'
  ].forEach(token => assert.ok(theme.includes(token + ':'), 'missing token ' + token));
});

test('the shared surfaces are all restyled through the token scale', () => {
  ['.panel', '.panel-title', '.panel-subtitle', '.dashboard-hero', '.dashboard-card',
    '.action-card', '.empty-state', '.chart-shell', '.feature-card', '.app-header', '.nav-btn'
  ].forEach(selector => assert.ok(theme.includes(selector), 'missing restyle for ' + selector));
});

test('the Pattern page picks up the same tokens with safe fallbacks', () => {
  const patternStable = read('public/pattern-stable-runtime.js');
  assert.match(patternStable, /var\(--ac-radius-lg,/);
  assert.match(patternStable, /var\(--ac-surface-2,/);
  assert.match(patternStable, /var\(--ac-shadow-1,/);
});

// ---------------------------------------------------------------------------
// 3. Mobile usability
// ---------------------------------------------------------------------------
test('the bottom nav respects the safe area and stays under the modals', () => {
  assert.match(theme, /env\(safe-area-inset-bottom\)/);
  assert.match(theme, /\.ac-mobilenav \{[\s\S]*?z-index: 40;/);
  // The app's dialogs sit at 60 / 9998 / 9999; the nav and its sheet stay below.
  assert.match(theme, /\.ac-sheet \{ position: fixed; inset: 0; z-index: 41;/);
  assert.ok(html.includes('z-[9999]'), 'login modal keeps its stacking context');
});

test('fixed navigation never covers page content', () => {
  assert.match(theme, /body\.has-mobile-nav \{ padding-bottom: calc\(var\(--ac-nav-height\)/);
  assert.match(theme, /--ac-nav-height:/);
});

test('bar and sheet targets stay finger-sized', () => {
  const barItem = /\.ac-mobilenav-item \{[\s\S]*?\}/.exec(theme);
  assert.ok(barItem && /min-height: 50px/.test(barItem[0]), 'bar items need a comfortable target');
  const sheetItem = /\.ac-sheet-item \{[\s\S]*?\}/.exec(theme);
  assert.ok(sheetItem && /min-height: 52px/.test(sheetItem[0]), 'sheet items need a comfortable target');
});

test('reduced motion is honoured by the new components', () => {
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
});

// ---------------------------------------------------------------------------
// 4. Dashboard grouping (markup only — no behaviour touched)
// ---------------------------------------------------------------------------
test('the dashboard is grouped into labelled, scannable bands', () => {
  ['dashQuickAccessTitle', 'dashRadarTitle', 'dashHistoryTitle'].forEach(id => {
    assert.ok(html.includes('id="' + id + '"'), 'missing section heading ' + id);
    assert.ok(html.includes('aria-labelledby="' + id + '"'), id + ' must label its section');
  });
  assert.match(theme, /\.ac-section-head \{/);
  assert.match(theme, /\.ac-section-title \{/);
});

test('every dashboard destination and control survives the regrouping', () => {
  [
    "navigateTo('analisis')", "navigateTo('sektor')", "navigateTo('screener')",
    "navigateTo('chart')", "navigateTo('portofolio')",
    'id="dashboardTop5List"', 'id="dashboardMonitorList"', 'id="top5HistoryList"',
    'id="ihsgSummaryCard"', 'loadTop5History(true)', "setTop5HistoryTab('active')", "setTop5HistoryTab('tp')"
  ].forEach(marker => assert.ok(html.includes(marker), 'lost dashboard element: ' + marker));
});

test('approval-gated dashboard cards keep their premium markers', () => {
  assert.ok((html.match(/data-premium-nav="true"/g) || []).length >= 9);
  assert.ok((html.match(/data-premium-page="true"/g) || []).length >= 3);
});

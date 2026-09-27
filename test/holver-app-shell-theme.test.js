'use strict';

// ===========================================================================
// Single-shell theme contract (HolverAI dark-only).
//
// The product ships ONE theme: institutional dark. There is no light mode and
// no theme switch — the old `html.light` / [data-theme="light"] blocks were
// removed wholesale, so the assertions below pin the dark tokens and the
// structural rules that make the two-column shell behave.
//
// The active navigation pill is asserted as the emerald wash, NOT the solid
// white block that used to detonate the dark surface.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const html = read('public/index.html');
const theme = read('public/ui-theme.css');

test('dashboard greeting is controlled by the semantic text token', () => {
  const greeting = html.match(/<h2[^>]*id="dashGreeting"[^>]*>/);
  assert.ok(greeting, 'dashGreeting heading must exist');
  assert.doesNotMatch(greeting[0], /\btext-white\b/, 'dashGreeting must not hardcode a white utility');
  assert.match(theme, /#page-dashboard #dashGreeting\s*\{[^}]*color:\s*var\(--color-text-primary\)/s);
});

test('analysis, portfolio, and watchlist stay inside the shared app-main shell', () => {
  const mainOpen = html.search(/<main\s+class="app-main"[^>]*id="appMain"[^>]*>/);
  const mainClose = html.indexOf('</main>', mainOpen);
  assert.ok(mainOpen >= 0 && mainClose > mainOpen, 'shared app-main must be structurally complete');

  ['page-analisis', 'page-portofolio', 'page-watchlist'].forEach((id) => {
    const index = html.indexOf('id="' + id + '"');
    assert.ok(index > mainOpen && index < mainClose, id + ' must remain inside app-main');
  });

  const navigateStart = html.indexOf('function navigateTo(page)');
  const navigateEnd = html.indexOf('// =====', navigateStart + 1);
  const navigateSource = html.slice(navigateStart, navigateEnd > navigateStart ? navigateEnd : navigateStart + 12000);
  assert.doesNotMatch(navigateSource, /window\.location\.assign\('\/analisis-saham'\)/);
  assert.doesNotMatch(navigateSource, /window\.location\.assign\('\/portfolio-planner'\)/);
});

test('financial workspace uses neutral Holver-style structural surfaces', () => {
  assert.match(theme, /--ac-bg:\s*#090d16;/);
  assert.match(theme, /--ac-surface-1:\s*#0f1420;/);
  assert.match(theme, /\.app-sidebar\s*\{[^}]*width:\s*240px;/s);
  assert.match(theme, /\.dashboard-hero\s*\{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.08\);[^}]*box-shadow:\s*none;/s);
});

test('the active sidebar pill is an emerald wash, never a solid white block', () => {
  assert.match(theme, /\.sidebar-item\.active\s*\{[^}]*background-color:\s*rgba\(16,\s*185,\s*129,\s*0\.12\);/s);
  assert.match(theme, /\.sidebar-item\.active\s*\{[^}]*color:\s*#10b981;/s);
  assert.match(theme, /\.sidebar-item\.active\s*\{[^}]*border-color:\s*rgba\(16,\s*185,\s*129,\s*0\.25\);/s);
  assert.doesNotMatch(theme, /\.sidebar-item\.active\s*\{[^}]*background-color:\s*#ffffff;/s,
    'the active pill must not paint a white background');
});

test('dark mode is the only theme: no light-mode selectors survive', () => {
  assert.doesNotMatch(theme, /html\.light/);
  assert.doesNotMatch(theme, /\[data-theme="light"\]/);
  assert.doesNotMatch(theme, /body\.light/);
  assert.doesNotMatch(theme, /prefers-color-scheme:\s*light/);
});

test('the sidebar rail is fixed and the content column is offset by its width', () => {
  assert.match(theme, /\.app-sidebar\s*\{[^}]*position:\s*fixed;/s);
  assert.match(theme, /\.app-main\s*\{[^}]*margin-left:\s*240px;/s);
  assert.match(theme, /\.app-layout\s*\{[^}]*display:\s*block;/s);
});

test('the document is the single scroll container', () => {
  assert.match(theme, /html\s*\{[^}]*overflow-y:\s*auto\s*!important;/s);
  assert.doesNotMatch(theme, /html\s*\{[^}]*overflow-y:\s*scroll\s*!important;/s);
});

test('the floating AI launcher is anchored once, above the recaptcha badge', () => {
  assert.match(theme, /#aiFloatingBtn\s*\{[^}]*bottom:\s*24px\s*!important;[^}]*right:\s*24px\s*!important;/s);
  assert.match(theme, /#aiFloatingBtn\s*\{[^}]*z-index:\s*50\s*!important;/s);
  assert.match(theme, /\.grecaptcha-badge\s*\{[^}]*z-index:\s*40\s*!important;/s);
});

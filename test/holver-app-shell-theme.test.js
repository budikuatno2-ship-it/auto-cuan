'use strict';

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
  assert.match(theme, /html\.light, body\.light\s*\{[^}]*--color-text-primary:\s*#0f172a !important;/s);
});

test('analysis, portfolio, and watchlist stay inside the shared app-main shell', () => {
  const mainOpen = html.indexOf('<main class="app-main">');
  const mainClose = html.indexOf('</main>', mainOpen);
  assert.ok(mainOpen >= 0 && mainClose > mainOpen, 'shared app-main must be structurally complete');

  ['page-analisis', 'page-portofolio', 'page-watchlist'].forEach((id) => {
    const index = html.indexOf('id="' + id + '"');
    assert.ok(index > mainOpen && index < mainClose, id + ' must remain inside app-main');
  });

  const navigateStart = html.indexOf('function navigateTo(page)');
  const navigateEnd = html.indexOf('// =====', navigateStart + 1);
  const navigateSource = html.slice(navigateStart, navigateEnd > navigateStart ? navigateEnd : navigateStart + 12000);
  assert.doesNotMatch(navigateSource, /window\.location\.assign\('\/analisis-saham/);
  assert.doesNotMatch(navigateSource, /window\.location\.assign\('\/portfolio-planner/);
});

test('financial workspace uses neutral Holver-style structural surfaces', () => {
  assert.match(theme, /--ac-bg:\s*#090d16;/);
  assert.match(theme, /--ac-surface-1:\s*#0f1420;/);
  assert.match(theme, /\.app-sidebar\s*\{[^}]*width:\s*240px;/s);
  assert.match(theme, /\.dashboard-hero\s*\{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.08\);[^}]*box-shadow:\s*none;/s);
  assert.match(theme, /\.sidebar-item\.active\s*\{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.08\);/s);
});

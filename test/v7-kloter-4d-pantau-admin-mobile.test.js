'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Kloter 4D: Landing / uses Asymmetric Split Hero, Live Proof Ledger, Bento 4 Pillars, and 3-Step Workflow without eager heavy vendors', () => {
  const html = read('public/index.html');
  const landingStart = html.indexOf('<section id="landingPage"');
  const landingEnd = html.indexOf('<!-- AUTH CHOICE MODAL -->');
  const landing = html.slice(landingStart, landingEnd);

  assert.match(landing, /class="[^"]*\bv7-hero-split\b/);
  assert.match(landing, /class="[^"]*\bv7-hero-workstation\b/);
  assert.match(landing, /id="v7HeroHorizonTable"/);
  assert.match(landing, /id="v7HeroLedgerBody"/);
  assert.match(landing, /class="[^"]*\bv7-bento-grid\b/);
  assert.match(landing, /class="[^"]*\bv7-workflow-steps\b/);
  assert.match(landing, /@AutoCuanVerificationBot/);
  assert.equal(landing.match(/—/g), null, 'Landing section must contain zero raw em-dashes');
  assert.doesNotMatch(landing, /echarts|cytoscape/i, 'Landing / must not reference heavy charting/graph libs inline');

  assert.match(html, /function\s+loadLandingShowcase|acRenderLandingHorizon/);
});

test('Kloter 4D: Full-viewport Split-Screen Auth wraps all 4 dialogs outside #dashboardScreen with @AutoCuanVerificationBot CTA', () => {
  const html = read('public/index.html');
  const dashIdx = html.indexOf('id="dashboardScreen"');
  for (const id of ['authChoiceModal', 'loginModal', 'registerModal', 'selfResetModal']) {
    const idx = html.indexOf('id="' + id + '"');
    assert.ok(idx !== -1 && idx < dashIdx, id + ' must appear before #dashboardScreen');
  }
  const authSlice = html.slice(html.indexOf('id="authChoiceModal"'), dashIdx);
  const splitMatches = authSlice.match(/class="[^"]*\bv7-auth-screen\b/g) || [];
  assert.equal(splitMatches.length, 4, 'All 4 auth modals must use .v7-auth-screen');
  assert.match(authSlice, /https:\/\/t\.me\/AutoCuanVerificationBot/);
  assert.match(authSlice, /Kembali ke Halaman Utama/);
  assert.match(authSlice, /AUTO-CUAN V7 &middot; SECURE WORKSPACE/);
});

test('Kloter 4D: Struktur Pasar sticky first-column Light/Dark override, Chart Mobile collapsible toolbar, and Pantau/Admin CSS contracts', () => {
  const css = read('public/v7-shell.css');
  assert.doesNotMatch(css, /#000000/, 'v7-shell.css must never contain #000000');

  assert.match(css, /#panel-tab-market-structure #marketStructureTable tbody td:first-child/);
  assert.match(css, /#panel-tab-market-structure #marketStructureTable \.ac-ticker-sticky-cell/);
  assert.match(css, /\.ac-draw-mobile-toggle/);
  assert.match(css, /\.ac-draw-toolbar:not\(\.is-open\) \.ac-draw-tools-rack/);
  assert.match(css, /#page-portofolio #portofolioPartialMount \.tab-strip/);
  assert.match(css, /#page-admin-console \.utabs/);

  const drawJs = read('public/chart-drawing-tools.js');
  assert.doesNotThrow(() => new vm.Script(drawJs, { filename: 'public/chart-drawing-tools.js' }));
  assert.match(drawJs, /ac-draw-mobile-toggle/);
  assert.match(drawJs, /ac-draw-tools-rack/);
  assert.match(drawJs, /toggle-drawer/);

  const motionJs = read('public/v7-motion-shell.js');
  assert.doesNotThrow(() => new vm.Script(motionJs, { filename: 'public/v7-motion-shell.js' }));
  assert.match(motionJs, /#adminNavTabs/);
  assert.match(motionJs, /openAuthChoiceModal/);
});

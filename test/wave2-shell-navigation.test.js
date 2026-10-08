'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

const INDEX_HTML = read('public/index.html');
const THEME_CSS = read('public/ui-theme.css');
const SHELL_CSS = read('public/index-shell.css');
const MOBILE_NAV_JS = read('public/mobile-nav.js');
const ACCOUNT_CENTER_JS = read('public/account-center-v1.js');
const SUB_GATE_JS = read('public/subscription-access-gate-v1.js');

test('Wave 2: Sidebar IA matches direct navigation simplification per Wave 6B', () => {
  const sidebarNavMatch = INDEX_HTML.match(/<nav class="sidebar-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(sidebarNavMatch, 'Sidebar <nav class="sidebar-nav"> must exist in index.html');
  const sidebarHtml = sidebarNavMatch[1];

  // Verify visible category headers have been removed per Wave 6B direct navigation list simplification
  const groupHeaders = [...sidebarHtml.matchAll(/<h2 class="sidebar-group-label">([^<]+)<\/h2>/g)].map(m => m[1].trim().toUpperCase());
  assert.equal(
    groupHeaders.length,
    0,
    'Sidebar visible group headers must be removed in favor of direct navigation per Wave 6B'
  );

  // Verify semantic sections exist in order
  const sectionAriaLabels = [...sidebarHtml.matchAll(/<section class="sidebar-nav-group" aria-label="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(
    sectionAriaLabels,
    ['Overview', 'Discover', 'Research', 'Monitor'],
    'Sidebar semantic sections must retain accessible group labels'
  );

  // Group 1: OVERVIEW -> Dashboard
  assert.ok(sidebarHtml.includes('data-sidebar-page="dashboard"'), 'OVERVIEW must contain Dashboard');

  // Group 2: DISCOVER -> Screener, Sektor Hot
  assert.ok(sidebarHtml.includes('data-sidebar-page="screener"'), 'DISCOVER must contain Screener');
  assert.ok(sidebarHtml.includes('data-sidebar-page="sektor"'), 'DISCOVER must contain Sektor Hot');

  // Group 3: RESEARCH -> Analisis & Chart, Bandarmologi, Hunter, Intel, Insider, Financial, Struktur Pasar, Ranking
  assert.ok(sidebarHtml.includes('data-sidebar-page="analisis"'), 'RESEARCH must contain Analisis & Chart');
  assert.ok(sidebarHtml.includes('data-sidebar-page="bandarmologi"'), 'RESEARCH must contain Bandarmologi');
  assert.ok(sidebarHtml.includes('data-sidebar-page="hunter"'), 'RESEARCH must contain Broker Hunter');
  assert.ok(sidebarHtml.includes('data-sidebar-page="intel"'), 'RESEARCH must contain Sinyal Intelijen');
  assert.ok(sidebarHtml.includes('data-sidebar-page="insider"'), 'RESEARCH must contain Insider');
  assert.ok(sidebarHtml.includes('data-sidebar-page="financial"'), 'RESEARCH must contain Financial');
  assert.ok(sidebarHtml.includes('data-sidebar-page="market-structure"'), 'RESEARCH must contain Struktur Pasar');
  assert.ok(sidebarHtml.includes('data-sidebar-page="ranking"'), 'RESEARCH must contain Ranking');

  // Pattern Radar must be admin-only and start hidden
  assert.ok(
    sidebarHtml.includes('id="tabAnalisisPattern"') && sidebarHtml.includes('data-sidebar-page="pattern"'),
    'RESEARCH must contain admin Pattern Radar'
  );
  assert.match(
    sidebarHtml,
    /<button[^>]*id="tabAnalisisPattern"[^>]*class="[^"]*hidden[^"]*"/,
    'Pattern Radar must be marked hidden by default to avoid showing inaccessible admin clutter'
  );

  // Group 4: MONITOR -> Watchlist, Portfolio, Track Record
  assert.ok(sidebarHtml.includes('data-sidebar-page="watchlist"'), 'MONITOR must contain Watchlist');
  assert.ok(sidebarHtml.includes('data-sidebar-page="portofolio"'), 'MONITOR must contain Portfolio');
  assert.ok(sidebarHtml.includes('data-sidebar-page="trackrecord"'), 'MONITOR must contain Track Record');

  // Decommissioned & dormant features must NOT be in the sidebar navigation
  assert.ok(!sidebarHtml.includes('data-sidebar-page="money-management"'), 'Money Management must NOT be in sidebar');
  assert.ok(!sidebarHtml.includes('data-sidebar-page="kelola-keuangan"'), 'Kelola Keuangan must NOT be in sidebar');
  assert.ok(!sidebarHtml.includes('data-sidebar-page="deepscan"'), 'DeepScan must NOT be in sidebar');
  assert.ok(!sidebarHtml.includes('data-sidebar-page="subscription"'), 'Standalone /subscription must NOT be in sidebar');
});

test('Wave 2: Single primary signed-in account identity in sidebar footer per DESIGN.md §76.16', () => {
  const sidebarMatch = INDEX_HTML.match(/<aside id="appSidebar"[\s\S]*?<\/aside>/);
  assert.ok(sidebarMatch, 'appSidebar must exist');
  const footerStart = sidebarMatch[0].indexOf('<div class="sidebar-footer">');
  assert.ok(footerStart !== -1, 'Sidebar footer must exist inside appSidebar');
  const footerHtml = sidebarMatch[0].slice(footerStart);

  // Target: avatar/initial + username + plan/role summary + chevron
  assert.ok(footerHtml.includes('class="user-avatar"'), 'Must contain user avatar element');
  assert.ok(footerHtml.includes('id="sidebarUserName"'), 'Must contain sidebar username element');
  assert.ok(footerHtml.includes('class="user-role"'), 'Must contain plan/role summary element');
  assert.ok(footerHtml.includes('class="sidebar-profile-chevron'), 'Must contain chevron element');

  // Account profile button
  assert.ok(footerHtml.includes('class="user-profile-badge sidebar-profile-button"'), 'Must have sidebar profile button');
  assert.ok(footerHtml.includes('openAccountProfile'), 'Clicking profile button must open Account Center');

  // Single sidebar logout action available
  assert.ok(footerHtml.includes('id="sidebarLogoutBtn"'), 'Must provide clear sidebar logout button');
});

test('Wave 2: Quiet topbar suppresses duplicated permanent account controls per DESIGN.md §84.3', () => {
  // Desktop shell hides duplicate headerAccountSection at >=1024px
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*min-width:\s*1024px\s*\)\s*\{[\s\S]*?\.app-shell\s+\.app-header\s+#headerAccountSection\s*\{[\s\S]*?display:\s*none\s*!important/i,
    'ui-theme.css must hide #headerAccountSection on desktop shell to prevent duplicating sidebar account identity'
  );

  // Permanent subscription and logout controls inside topbar are suppressed
  assert.match(
    THEME_CSS,
    /\.app-header\s+#headerAccountSection\s+\.account-subscription-control[\s\S]*?display:\s*none\s*!important/i,
    'TopBar must not contain permanent subscription button'
  );
  assert.match(
    THEME_CSS,
    /\.app-header\s+#headerAccountSection\s+#logoutBtn[\s\S]*?display:\s*none\s*!important/i,
    'TopBar must not contain permanent logout button'
  );

  // Topbar keeps freshness/clock and status chips
  assert.ok(INDEX_HTML.includes('id="wibClock"'), 'Topbar preserves WIB clock for freshness');
  assert.ok(INDEX_HTML.includes('class="desktop-header-chips'), 'Topbar preserves status chips');
});

test('Wave 2: Account Center triggers wired to sidebar account controls', () => {
  assert.match(
    ACCOUNT_CENTER_JS,
    /#appSidebar\s+\.sidebar-profile-button/,
    'account-center-v1.js must directly wire sidebar profile button to Account Center'
  );
  assert.match(
    ACCOUNT_CENTER_JS,
    /sidebarSubscriptionBtn/,
    'account-center-v1.js must wire sidebar subscription button to Account Center'
  );
});

test('Wave 2: Deterministic access-aware Screener and navigation visibility', () => {
  // Screener is gated by data-premium-nav="true"
  assert.match(
    INDEX_HTML,
    /data-sidebar-page="screener"[^>]*data-premium-nav="true"/,
    'Screener sidebar item must be gated with data-premium-nav="true"'
  );

  // Gated items start hidden
  assert.match(
    INDEX_HTML,
    /<button[^>]*class="[^"]*hidden[^"]*"[^>]*data-sidebar-page="screener"|<button[^>]*data-sidebar-page="screener"[^>]*class="[^"]*hidden[^"]*"/,
    'Screener starts hidden until confirmed server entitlement is ready'
  );

  // Runtime applies access deterministically
  assert.ok(
    INDEX_HTML.includes('function applyPremiumAccessUi()'),
    'index.html defines applyPremiumAccessUi'
  );
  assert.ok(
    INDEX_HTML.includes('function updateSidebarGroupVisibility()'),
    'index.html defines updateSidebarGroupVisibility to collapse empty groups'
  );

  // Subscription access gate is active
  assert.match(
    SUB_GATE_JS,
    /window\.premiumAccessState\s*=/,
    'subscription-access-gate-v1.js updates premiumAccessState from signed server session'
  );
});

test('Wave 2: Safe mobile navigation architecture retains operational launcher', () => {
  // mobile-nav.js retains launcher with edge-snapping and buildNavModel
  assert.match(MOBILE_NAV_JS, /function\s+buildNavModel/);
  assert.match(MOBILE_NAV_JS, /function\s+snapPosition/);

  // mobile-nav.js is loaded dynamically via production loader
  const fcaLoader = read('public/assets/fca-stocks.js');
  assert.ok(fcaLoader.includes('/mobile-nav.js?v='), 'mobile-nav.js is loaded via fca loader');

  // Mobile hamburger toggle exists
  assert.ok(INDEX_HTML.includes('id="workspaceSidebarToggle"'), 'Workspace sidebar hamburger toggle exists');
  assert.ok(INDEX_HTML.includes('toggleSidebarCollapse()'), 'Toggle function is wired');
});

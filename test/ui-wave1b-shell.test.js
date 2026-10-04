'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'public', 'index.html');
const UI_THEME_CSS_PATH = path.join(ROOT, 'public', 'ui-theme.css');
const POLISH_CSS_PATH = path.join(ROOT, 'public', 'final-uiux-polish.css');
const ANALISIS_RUNTIME_PATH = path.join(ROOT, 'public', 'analisis-saham-runtime.js');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const uiThemeCss = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');
const polishCss = fs.readFileSync(POLISH_CSS_PATH, 'utf8');
const analisisRuntimeJs = fs.readFileSync(ANALISIS_RUNTIME_PATH, 'utf8');

// ---------------------------------------------------------------------------
// SUITE 1: CANONICAL DESKTOP NAVIGATION IA (WAVE 1B)
// ---------------------------------------------------------------------------
test('WAVE-1B-01: Canonical desktop navigation groups and hierarchy', () => {
  // Extract #appSidebar HTML
  const appSidebarMatch = indexHtml.match(/<aside id="appSidebar"[^>]*>([\s\S]*?)<\/aside>/);
  assert.ok(appSidebarMatch, '#appSidebar element must exist');
  const appSidebar = appSidebarMatch[1];

  // Extract sidebar nav HTML
  const sidebarNavMatch = appSidebar.match(/<nav class="sidebar-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(sidebarNavMatch, 'Sidebar nav element must exist');
  const sidebarNav = sidebarNavMatch[1];

  // 1. OVERVIEW group
  assert.match(sidebarNav, /aria-label="Overview"[^>]*>[\s\S]*?<h2 class="sidebar-group-label">Overview<\/h2>/);
  assert.match(sidebarNav, /data-sidebar-page="dashboard"/, 'Overview must contain Dashboard');

  // 2. DISCOVER group
  assert.match(sidebarNav, /aria-label="Discover"[^>]*>[\s\S]*?<h2 class="sidebar-group-label">Discover<\/h2>/);
  assert.match(sidebarNav, /data-sidebar-page="screener"[^>]*data-premium-nav="true"/, 'Discover must contain Screener with premium nav');
  assert.match(sidebarNav, /id="tabSektorHot"[^>]*data-sidebar-page="sektor"[^>]*data-premium-nav="true"/, 'Discover must contain Sektor Hot with premium nav');

  // 3. RESEARCH group with canonical flat hierarchy (DESIGN.md §10.2)
  assert.match(sidebarNav, /aria-label="Research"[^>]*>[\s\S]*?<h2 class="sidebar-group-label">Research<\/h2>/);
  const subgroups = ['Teknikal', 'Arus Bandar', 'Intel & Relasi', 'Struktur & Valuasi', 'Peringkat & Sektor'];
  subgroups.forEach(label => {
    assert.equal(
      sidebarNav.includes(`<div class="sidebar-subgroup-label">${label}</div>`),
      false,
      `Canonical v2 sidebarNav must NOT contain subgroup label "${label}"`
    );
  });

  // Verify canonical flat research tools in DESIGN.md §10.2 order
  const researchGroupMatch = sidebarNav.match(/<section class="sidebar-nav-group" aria-label="Research">([\s\S]*?)<\/section>/);
  assert.ok(researchGroupMatch, 'Research group must exist in sidebar');
  const researchHtml = researchGroupMatch[1];

  const posChart = researchHtml.indexOf('id="tabAnalisisChart"');
  const posBandar = researchHtml.indexOf('id="tabBandarmologi"');
  const posIntel = researchHtml.indexOf('id="tabSinyalIntelijen"');
  const posHunter = researchHtml.indexOf('id="tabBrokerHunter"');
  const posInsider = researchHtml.indexOf('id="tabJejaringInsider"');
  const posRanking = researchHtml.indexOf('id="tabRankingHarian"');
  const posFinancial = researchHtml.indexOf('id="tabFinancial"');
  const posStruktur = researchHtml.indexOf('id="tabMarketStructure"');
  const posPattern = researchHtml.indexOf('id="tabAnalisisPattern"');

  assert.ok(posChart > -1 && posBandar > posChart, 'Analisis & Chart -> Bandarmologi');
  assert.ok(posIntel > posBandar, 'Bandarmologi -> Sinyal Intelijen');
  assert.ok(posHunter > posIntel, 'Sinyal Intelijen -> Broker Hunter');
  assert.ok(posInsider > posHunter, 'Broker Hunter -> Insider');
  assert.ok(posRanking > posInsider, 'Insider -> Ranking');
  assert.ok(posFinancial > posRanking, 'Ranking -> Financial');
  assert.ok(posStruktur > posFinancial, 'Financial -> Struktur Pasar');
  assert.ok(posPattern > posStruktur, 'Struktur Pasar -> Pattern Radar');

  // 4. MONITOR group
  assert.match(sidebarNav, /aria-label="Monitor"[^>]*>[\s\S]*?<h2 class="sidebar-group-label">Monitor<\/h2>/);
  assert.match(sidebarNav, /data-sidebar-page="watchlist"[^>]*data-premium-nav="true"/, 'Monitor must contain Watchlist');
  assert.match(sidebarNav, /data-sidebar-page="portofolio"[^>]*data-premium-nav="true"/, 'Monitor must contain Portfolio');
  assert.match(sidebarNav, /data-sidebar-page="trackrecord"[^>]*data-premium-nav="true"/, 'Monitor must contain Track Record');

  // 5. Deprecated/dormant items must NOT be in sidebar nav
  assert.equal(sidebarNav.includes('data-sidebar-page="money-management"'), false, 'Money Management must not be in sidebar');
  assert.equal(sidebarNav.includes('data-sidebar-page="deepscan"'), false, 'DeepScan must not be in sidebar');
  assert.equal(sidebarNav.includes('data-sidebar-page="subscription"'), false, 'Standalone subscription must not be in sidebar');
});

// ---------------------------------------------------------------------------
// SUITE 2: SINGLE ACCOUNT IDENTITY SURFACE (WAVE 1B)
// ---------------------------------------------------------------------------
test('WAVE-1B-02: Single primary account identity surface in sidebar footer', () => {
  const appSidebarMatch = indexHtml.match(/<aside id="appSidebar"[^>]*>([\s\S]*?)<\/aside>/);
  assert.ok(appSidebarMatch, '#appSidebar element must exist');
  const appSidebar = appSidebarMatch[1];

  const footerStart = appSidebar.indexOf('<div class="sidebar-footer">');
  assert.ok(footerStart > -1, 'Sidebar footer must exist');
  const footerHtml = appSidebar.slice(footerStart);

  // Primary account button exists with avatar, username, role, chevron
  assert.match(footerHtml, /id="sidebarAccountBtn"/, 'Sidebar footer must contain #sidebarAccountBtn');
  assert.match(footerHtml, /class="[^"]*user-profile-badge[^"]*sidebar-profile-button[^"]*"/);
  assert.match(footerHtml, /<div class="user-avatar"/);
  assert.match(footerHtml, /id="sidebarUserName"/);
  assert.match(footerHtml, /class="user-role"/);
  assert.match(footerHtml, /class="[^"]*sidebar-profile-chevron[^"]*"/);

  // Theme toggle and logout remain present
  assert.match(footerHtml, /id="themeToggleCompact"/);
  assert.match(footerHtml, /id="sidebarLogoutBtn"/);

  // Duplicated subscription button removed from sidebar footer
  assert.equal(footerHtml.includes('id="sidebarSubscriptionBtn"'), false, 'Duplicate subscription button must be removed from footer');

  // Topbar duplicates hidden in v2 CSS
  assert.match(
    uiThemeCss,
    /\.app-header\[data-ui-version="v2"\]\s+#headerAccountSection\s*\{[^}]*display:\s*none;/,
    'Topbar duplicated account controls must be hidden under v2 scope'
  );
});

// ---------------------------------------------------------------------------
// SUITE 3: V2 SCOPE ACTIVATION & DOM ATTRIBUTES
// ---------------------------------------------------------------------------
test('WAVE-1B-03: Scoped v2 activation on workspace shell surfaces', () => {
  assert.match(indexHtml, /<aside\s+id="appSidebar"[^>]*data-ui-version="v2"/, 'Sidebar must have data-ui-version="v2"');
  assert.match(indexHtml, /<header\s+class="app-header[^"]*"[^>]*data-ui-version="v2"/, 'Topbar must have data-ui-version="v2"');

  // Verify feature pages do not have premature global v2 activation
  assert.doesNotMatch(indexHtml, /<div\s+id="page-dashboard"[^>]*data-ui-version="v2"/, 'Dashboard page content must not have premature v2');
  assert.doesNotMatch(indexHtml, /<div\s+id="page-screener"[^>]*data-ui-version="v2"/, 'Screener page content must not have premature v2');
});

// ---------------------------------------------------------------------------
// SUITE 4: SHELL CSS CONTRACT & ACTIVE STATE
// ---------------------------------------------------------------------------
test('WAVE-1B-04: Workspace shell CSS tokens, active destination, and topbar height', () => {
  // Topbar height rule
  assert.match(
    uiThemeCss,
    /\.app-header\[data-ui-version="v2"\]\s*\{[^}]*height:\s*var\(--ac-topbar-height\);/,
    'v2 header must use --ac-topbar-height'
  );

  // Sidebar width rules
  assert.match(
    uiThemeCss,
    /#appSidebar\[data-ui-version="v2"\]\s*\{[^}]*width:\s*var\(--ac-sidebar-width\);/,
    'v2 sidebar must use --ac-sidebar-width'
  );
  assert.match(
    uiThemeCss,
    /#appSidebar\[data-ui-version="v2"\]\.is-collapsed[^}]*\{[^}]*width:\s*var\(--ac-sidebar-rail\);/,
    'v2 collapsed sidebar must use --ac-sidebar-rail'
  );

  // Active destination treatment
  assert.match(
    uiThemeCss,
    /#appSidebar\[data-ui-version="v2"\]\s+\.sidebar-item\.active\s*\{[^}]*background-color:\s*var\(--ac-brand-soft\);/,
    'Active sidebar item must use brand-soft background'
  );
  assert.match(
    uiThemeCss,
    /#appSidebar\[data-ui-version="v2"\]\s+\.sidebar-item\.active\s*\{[^}]*color:\s*var\(--ac-ink\);/,
    'Active sidebar item must use ink text'
  );
  assert.match(
    uiThemeCss,
    /#appSidebar\[data-ui-version="v2"\]\s+\.sidebar-item\.active::before\s*\{[^}]*width:\s*3px;[^}]*background-color:\s*var\(--ac-brand\);/,
    'Active sidebar item must have 3px brand edge indicator'
  );

  // No !important in v2 section
  const v2Index = uiThemeCss.indexOf('/* =========================================================================\n   9. Auto-Cuan v2 Foundation Contract');
  assert.ok(v2Index > -1);
  const v2Section = uiThemeCss.slice(v2Index);
  assert.doesNotMatch(v2Section, /!important/, 'Wave 1B additions must not contain !important');
});

// ---------------------------------------------------------------------------
// SUITE 5: MOBILE PARITY & RESPONSIVE BEHAVIOR
// ---------------------------------------------------------------------------
test('WAVE-1B-05: Mobile navigation launcher source preserved and responsive hooks intact', () => {
  // #mainNav preserved for mobile launcher MutationObserver
  assert.match(indexHtml, /<div[^>]*id="mainNav"/, '#mainNav must remain in DOM');

  // Sidebar collapse toggle and drawer trigger
  assert.match(indexHtml, /id="workspaceSidebarToggle"[^>]*aria-controls="appSidebar"/);
  assert.match(indexHtml, /id="sidebarScrim"/);

  // Focus visible rings defined in v2
  assert.match(uiThemeCss, /#appSidebar\[data-ui-version="v2"\]\s+\.sidebar-item:focus-visible/);
  assert.match(uiThemeCss, /#appSidebar\[data-ui-version="v2"\]\s+\.user-profile-badge:focus-visible/);

  // Touch target on mobile
  assert.match(uiThemeCss, /min-width:\s*var\(--ac-touch-target\);/);
});

// ---------------------------------------------------------------------------
// SUITE 6: ACCESS-AWARE NAVIGATION & GROUP VISIBILITY SYNCHRONIZATION
// ---------------------------------------------------------------------------
test('WAVE-1B-06: Screener access-aware navigation and group visibility synchronization', () => {
  // Verify updateSidebarGroupVisibility helper exists and operates on .sidebar-nav-group
  assert.match(indexHtml, /function updateSidebarGroupVisibility\(\)\s*\{/);
  assert.match(indexHtml, /group\.classList\.toggle\('hidden',\s*visibleItems\.length\s*===\s*0\)/);

  // In applyPremiumAccessUi, both data-premium-nav toggling and updateSidebarGroupVisibility occur
  const applyStart = indexHtml.indexOf('function applyPremiumAccessUi()');
  assert.ok(applyStart > -1, 'applyPremiumAccessUi must exist');
  const applyEnd = indexHtml.indexOf('function cancelPremiumAccessRequest()', applyStart);
  assert.ok(applyEnd > applyStart);
  const applyBody = indexHtml.slice(applyStart, applyEnd);

  assert.match(applyBody, /document\.querySelectorAll\('\[data-premium-nav="true"\]'\)/);
  assert.match(applyBody, /updateSidebarGroupVisibility\(\)/);

  // Both Discover items (screener, sektor) have data-premium-nav="true"
  assert.match(indexHtml, /data-sidebar-page="screener"[^>]*data-premium-nav="true"/);
  assert.match(indexHtml, /data-sidebar-page="sektor"[^>]*data-premium-nav="true"/);

  // All three Monitor items (watchlist, portofolio, trackrecord) have data-premium-nav="true"
  assert.match(indexHtml, /data-sidebar-page="watchlist"[^>]*data-premium-nav="true"/);
  assert.match(indexHtml, /data-sidebar-page="portofolio"[^>]*data-premium-nav="true"/);
  assert.match(indexHtml, /data-sidebar-page="trackrecord"[^>]*data-premium-nav="true"/);

  // Overview and Research remain accessible without premium gate
  assert.doesNotMatch(indexHtml, /data-sidebar-page="dashboard"[^>]*data-premium-nav="true"/);
  assert.doesNotMatch(indexHtml, /data-analysis-tab="analisis-chart"[^>]*data-premium-nav="true"/);
});

// ---------------------------------------------------------------------------
// SUITE 7: TRUTHFUL RADAR STATUS SEMANTICS (NO TIMESTAMP-ONLY "LIVE" CLAIM)
// ---------------------------------------------------------------------------
test('WAVE-1B-07: Radar status helper emits truthful neutral status and never claims "Live" from recency alone', () => {
  // Static HTML must not contain hardcoded "Live Radar"
  assert.equal(indexHtml.includes('>Live Radar<'), false, 'Static HTML must not contain hardcoded "Live Radar"');
  assert.match(indexHtml, /id="globalLiveRadarText">Radar<\/span>/, 'Initial topbar radar text must be neutral "Radar"');
  assert.match(indexHtml, /id="heroLiveRadarText">Radar<\/span>/, 'Initial hero radar text must be neutral "Radar"');

  // updateGlobalLiveRadarStatus function inspection
  const funcStart = indexHtml.indexOf('function updateGlobalLiveRadarStatus(');
  assert.ok(funcStart > -1, 'updateGlobalLiveRadarStatus must exist');
  const funcEnd = indexHtml.indexOf('function updateDashGreeting()', funcStart);
  assert.ok(funcEnd > funcStart);
  const funcBody = indexHtml.slice(funcStart, funcEnd);

  // Must not assign "Live Radar" or status 'live' from recency
  assert.equal(funcBody.includes("'Live Radar'"), false, 'Must not emit "Live Radar" from recency alone');
  assert.equal(funcBody.includes('"Live Radar"'), false, 'Must not emit "Live Radar" string');
  assert.equal(funcBody.includes("status = 'live'"), false, 'Must not set status to live from recency alone');

  // Allowed neutral labels
  assert.match(funcBody, /label\s*=\s*'Radar:\s*Updated'/);
  assert.match(funcBody, /label\s*=\s*'Radar:\s*EOD Close'/);
  assert.match(funcBody, /label\s*=\s*'Radar:\s*Stale/);
  assert.match(funcBody, /label\s*=\s*'Radar:\s*Scanning'/);
});

// ---------------------------------------------------------------------------
// SUITE 8: LEGACY LIGHT ACTIVE ITEM ISOLATION (WAVE 1A/1B REPAIR)
// ---------------------------------------------------------------------------
test('WAVE-1B-08: Legacy light active item styling is scoped away from v2 shell', () => {
  // Verify public/final-uiux-polish.css scopes sidebar items away from v2
  assert.match(
    polishCss,
    /html\.light\s+\.sidebar-item(?:\.active:not|:not\([^)]+\)\.active)/,
    'final-uiux-polish.css must scope legacy light active sidebar items away from v2'
  );

  // Verify public/ui-theme.css scopes legacy light active sidebar items away from v2
  assert.match(
    uiThemeCss,
    /html\.light\s+\.sidebar-item(?:\.active:not|:not\([^)]+\)\.active)/,
    'ui-theme.css must scope legacy light active sidebar items away from v2'
  );

  // Verify v2 sidebar item active styles preserve canonical design contract:
  // Brand-soft background, ink color, 8px radius, no box-shadow
  const v2ActiveMatch = uiThemeCss.match(/\[data-ui-version=["']v2["']\]\s+\.sidebar-item\.active[^\{]*\{([\s\S]*?)\}/);
  assert.ok(v2ActiveMatch, 'Must find scoped v2 sidebar-item.active rule');
  const v2ActiveBody = v2ActiveMatch[1];

  assert.match(v2ActiveBody, /background-color:\s*var\(--ac-brand-soft\)/i, 'Active item background must be var(--ac-brand-soft)');
  assert.match(v2ActiveBody, /color:\s*var\(--ac-ink\)/i, 'Active item text color must be var(--ac-ink)');
  assert.match(v2ActiveBody, /box-shadow:\s*none/i, 'Active item must have box-shadow: none');

  const v2ItemMatch = uiThemeCss.match(/\[data-ui-version=["']v2["']\]\s+\.sidebar-item\s*\{([\s\S]*?)\}/);
  assert.ok(v2ItemMatch, 'Must find scoped v2 sidebar-item rule');
  assert.match(v2ItemMatch[1], /border-radius:\s*var\(--ac-radius-md\)/i, 'Sidebar item must have canonical radius');
});

// ---------------------------------------------------------------------------
// SUITE 9: LEGACY SIDEBAR/HEADER SURFACE ISOLATION (WAVE 1A/1B REPAIR)
// ---------------------------------------------------------------------------
test('WAVE-1B-09: Legacy light sidebar and header surface rules are scoped away from v2 shell', () => {
  // In final-uiux-polish.css, legacy html.light .app-sidebar and .app-header must not match v2
  assert.match(
    polishCss,
    /html\.light\s+\.app-sidebar:not\(\[data-ui-version=["']v2["']\]\)/,
    'final-uiux-polish.css must scope legacy light .app-sidebar away from v2'
  );
  assert.match(
    polishCss,
    /html\.light\s+\.app-header:not\(\[data-ui-version=["']v2["']\]\)/,
    'final-uiux-polish.css must scope legacy light .app-header away from v2'
  );

  // In ui-theme.css, legacy html.light .app-sidebar and .app-header must not match v2
  assert.match(
    uiThemeCss,
    /html\.light\s+\.app-sidebar:not\(\[data-ui-version=["']v2["']\]\)/,
    'ui-theme.css must scope legacy light .app-sidebar away from v2'
  );
  assert.match(
    uiThemeCss,
    /html\.light\s+\.app-header:not\(\[data-ui-version=["']v2["']\]\)/,
    'ui-theme.css must scope legacy light .app-header away from v2'
  );

  // Verify v2 shell consumes semantic tokens
  const v2SidebarMatch = uiThemeCss.match(/(?:#appSidebar|\.app-sidebar)\[data-ui-version=["']v2["']\][^\{]*\{([\s\S]*?)\}/);
  assert.ok(v2SidebarMatch, 'Must find v2 sidebar rule');
  assert.match(v2SidebarMatch[1], /background:\s*var\(--ac-surface\)/i, 'v2 sidebar must consume var(--ac-surface)');

  const v2HeaderMatch = uiThemeCss.match(/(?:#appHeader|\.app-header)\[data-ui-version=["']v2["']\][^\{]*\{([\s\S]*?)\}/);
  assert.ok(v2HeaderMatch, 'Must find v2 .app-header rule');
  assert.match(v2HeaderMatch[1], /background:\s*var\(--ac-surface\)/i, 'v2 .app-header must consume var(--ac-surface)');
});

// ---------------------------------------------------------------------------
// SUITE 10: TOPBAR ACCOUNT CLUSTER SUPPRESSION IN V2 (WAVE 1A/1B REPAIR)
// ---------------------------------------------------------------------------
test('WAVE-1B-10: syncHeaderUsername preserves hidden topbar account cluster in v2 shell', () => {
  const syncFuncMatch = indexHtml.match(/function syncHeaderUsername\(\)\s*\{([\s\S]*?)\n\}\s*\nwindow\.syncHeaderUsername/);
  assert.ok(syncFuncMatch, 'syncHeaderUsername function must exist');
  const syncFuncBody = syncFuncMatch[1];

  // Must detect v2 header
  assert.match(
    syncFuncBody,
    /accountSection\.closest\('\.app-header\[data-ui-version="v2"\]'\)/,
    'syncHeaderUsername must check if accountSection is within .app-header[data-ui-version="v2"]'
  );

  // Must suppress display inside v2 header while allowing inline-flex for legacy header
  assert.match(
    syncFuncBody,
    /if\s*\(\s*isV2Header\s*\)\s*\{[\s\S]*?accountSection\.style\.display\s*=\s*'none'[\s\S]*?\}\s*else\s*\{[\s\S]*?accountSection\.style\.display\s*=\s*'inline-flex'/,
    'syncHeaderUsername must keep accountSection hidden in v2 header and preserve legacy display in unmigrated header'
  );

  // Also verify analisis-saham-runtime.js enforces the identical v2 scoping contract
  assert.match(
    analisisRuntimeJs,
    /accountSection\.closest\('\.app-header\[data-ui-version="v2"\]'\)/,
    'analisis-saham-runtime.js must check if accountSection is within .app-header[data-ui-version="v2"]'
  );
  assert.match(
    analisisRuntimeJs,
    /if\s*\(\s*isV2Header\s*\)\s*\{[\s\S]*?accountSection\.style\.display\s*=\s*'none'[\s\S]*?\}\s*else\s*\{[\s\S]*?accountSection\.style\.display\s*=\s*'inline-flex'/,
    'analisis-saham-runtime.js must keep accountSection hidden in v2 header and preserve legacy display in unmigrated header'
  );
});


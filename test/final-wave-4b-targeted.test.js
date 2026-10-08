'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../public/analysis-tools-registry.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STANDALONE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'analisis-saham.html'), 'utf8');
const COCKPIT_JS = fs.readFileSync(path.join(ROOT, 'public', 'unified-cockpit-runtime.js'), 'utf8');
const POLISH_CSS = fs.readFileSync(path.join(ROOT, 'public', 'final-uiux-polish.css'), 'utf8');

// ----------------------------------------------------------------------------
// SUITE 1: CANONICAL ANALYSIS TOOL REGISTRY (FINAL-RISK-003, FINAL-RISK-004)
// ----------------------------------------------------------------------------
test('FINAL-RISK-004: Canonical registry defines identity, routeKey, and icons with parity', () => {
  const allTools = registry.getAll();
  assert.equal(allTools.length, 10, 'Registry contains exactly 10 canonical analysis tools');

  // Verify non-admin active set excludes pattern
  const guestActive = registry.getActive(false);
  assert.equal(guestActive.some(t => t.id === 'pattern'), false, 'Guest active set excludes admin-only Pattern Radar');

  // Verify admin active set includes pattern
  const adminActive = registry.getActive(true);
  assert.equal(adminActive.some(t => t.id === 'pattern'), true, 'Admin active set includes Pattern Radar');

  // Check required fields
  allTools.forEach(tool => {
    assert.ok(tool.id, 'Tool has ID');
    assert.ok(tool.label, 'Tool has Label');
    assert.ok(tool.routeKey, 'Tool has RouteKey');
    assert.ok(tool.subgroup, 'Tool has Subgroup');
    assert.ok(tool.iconSvg, 'Tool has SVG Icon');
    assert.ok(tool.description, 'Tool has Description');
  });

  // Verify standalone HTML contains all tools from registry (except admin if hidden)
  const standaloneTools = ['analisis-chart', 'bandarmologi', 'hunter', 'intel', 'insider', 'financial', 'market-structure', 'ranking', 'pattern'];
  standaloneTools.forEach(tab => {
    assert.ok(
      STANDALONE_HTML.includes(`data-tab="${tab}"`),
      `Standalone HTML must have button with data-tab="${tab}"`
    );
  });

  // Verify sidebar contains all tools
  allTools.forEach(tool => {
    assert.ok(
      INDEX_HTML.includes(`data-sidebar-page="${tool.routeKey}"`) || INDEX_HTML.includes(`data-analysis-tab="${tool.routeKey}"`) || INDEX_HTML.includes(`onclick="navigateTo('${tool.routeKey}')"`),
      `Sidebar must contain link for ${tool.label} (${tool.routeKey})`
    );
  });
});

// ----------------------------------------------------------------------------
// SUITE 2: REDUCE COGNITIVE LOAD VIA SUBGROUPING (FINAL-RISK-003)
// ----------------------------------------------------------------------------
test('FINAL-RISK-003: Riset Pasar sidebar organizes tools into direct navigation list without visible subgroup labels (Wave 6B)', () => {
  // Wave 6B simplification: visible subgroup text labels removed from HTML
  const expectedSubgroups = ['Teknikal', 'Arus Bandar', 'Intel & Relasi', 'Struktur & Valuasi', 'Peringkat & Sektor'];
  expectedSubgroups.forEach(label => {
    assert.ok(
      !INDEX_HTML.includes(`<div class="sidebar-subgroup-label">${label}</div>`),
      `Sidebar must NOT contain visible subgroup header "${label}" after Wave 6B simplification`
    );
  });

  // Verify all research tools remain present and ordered in the Research group
  const researchGroupMatch = INDEX_HTML.match(/<section class="sidebar-nav-group" aria-label="Research">([\s\S]*?)<\/section>/);
  assert.ok(researchGroupMatch, 'Research section must exist in sidebar');
  const researchHtml = researchGroupMatch[1];
  const expectedTools = [
    'tabAnalisisChart',
    'tabBandarmologi',
    'tabBrokerHunter',
    'tabSinyalIntelijen',
    'tabJejaringInsider',
    'tabFinancial',
    'tabMarketStructure',
    'tabRankingHarian',
    'tabAnalisisPattern'
  ];
  expectedTools.forEach(toolId => {
    assert.ok(researchHtml.includes(`id="${toolId}"`), `Research tool ${toolId} must be present`);
  });

  // Check CSS rule for subgroup labels and collapsed behavior remains intact
  assert.ok(
    POLISH_CSS.includes('.sidebar-subgroup-label'),
    'Polish CSS must style .sidebar-subgroup-label'
  );
  assert.ok(
    POLISH_CSS.includes('#appSidebar.is-collapsed .sidebar-subgroup-label'),
    'Collapsed sidebar must hide subgroup labels'
  );
});

// ----------------------------------------------------------------------------
// SUITE 3: EMOJI ICONS REMOVED & SVG PARITY (FINAL-POLISH-003)
// ----------------------------------------------------------------------------
test('FINAL-POLISH-003: Standalone analysis navigation uses monochromatic SVG icons, zero raw emoji', () => {
  // Check tab strip in standalone HTML
  const tabStripMatch = STANDALONE_HTML.match(/<nav class="analisis-tab-strip[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(tabStripMatch, 'Tab strip must exist');
  const stripHtml = tabStripMatch[1];

  // No raw emojis in tab strip
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
  assert.equal(emojiRegex.test(stripHtml), false, 'Tab strip must not contain any raw emoji characters');

  // Monochromatic SVG icons present
  const svgCount = (stripHtml.match(/<svg/g) || []).length;
  assert.equal(svgCount, 9, 'All 9 tabs in tab strip must have SVG icons');

  // No emojis in header navigation
  const headerActionsMatch = STANDALONE_HTML.match(/<div class="header-actions">([\s\S]*?)<\/header>/);
  assert.ok(headerActionsMatch, 'Header actions must exist');
  assert.equal(emojiRegex.test(headerActionsMatch[1]), false, 'Header actions must not contain raw emojis');
});

// ----------------------------------------------------------------------------
// SUITE 4: SHARED TICKER CONTEXT CONTRACT (FINAL-RISK-005)
// ----------------------------------------------------------------------------
test('FINAL-RISK-005: Shared ticker context synchronizes primary analysis inputs without loop', () => {
  // Verify syncActiveTicker synchronizes all primary inputs
  assert.ok(
    COCKPIT_JS.includes("var primaryInputs = ['analisisInput', 'chartTickerInput', 'newsTickerInput', 'financialTickerInput', 'marketStructureTickerInput'];"),
    'syncActiveTicker must target all primary analysis inputs'
  );

  // Value check to prevent loop: if (inp && inp.value !== ticker) inp.value = ticker;
  assert.ok(
    COCKPIT_JS.includes('if (inp && inp.value !== ticker)'),
    'Input update must be conditional on value difference to prevent change event feedback loops'
  );

  // URL sync via history.replaceState
  assert.ok(
    COCKPIT_JS.includes('window.history.replaceState'),
    'syncActiveTicker must use replaceState to avoid duplicate history stack entries'
  );

  // Navigation syncs active ticker into newly opened page
  assert.ok(
    INDEX_HTML.includes('window.UnifiedCockpit.syncActiveTicker(currentActiveTicker, { skipUrlSync: true });'),
    'navigateTo must propagate current active ticker to newly mounted view'
  );

  // Table search filters remain local (kgTickerSearch, nkTickerSearch, dtTickerSearch not in primaryInputs)
  assert.equal(COCKPIT_JS.includes("'kgTickerSearch'"), false, 'Screener filter kgTickerSearch must remain local');
  assert.equal(COCKPIT_JS.includes("'nkTickerSearch'"), false, 'Screener filter nkTickerSearch must remain local');
  assert.equal(COCKPIT_JS.includes("'dtTickerSearch'"), false, 'Screener filter dtTickerSearch must remain local');
});

// ----------------------------------------------------------------------------
// SUITE 5: DETERMINISTIC MOTION & REDUCED MOTION (FINAL-POLISH-001)
// ----------------------------------------------------------------------------
test('FINAL-POLISH-001: Workspace navigation transitions are restrained, cancelable, and honor reduced-motion', () => {
  // In-flight transitions canceled on page switch
  assert.ok(
    INDEX_HTML.includes('if (el._workspaceFade)'),
    'navigateTo must cancel previous in-flight fade animations'
  );
  assert.ok(
    INDEX_HTML.includes('el._workspaceFade.cancel()'),
    'Fade animation cancel must be called'
  );

  // Honors prefers-reduced-motion
  assert.ok(
    INDEX_HTML.includes("window.matchMedia('(prefers-reduced-motion: reduce)')"),
    'navigateTo must respect prefers-reduced-motion'
  );

  // Fast duration budget: --motion-fast (140-180ms)
  assert.ok(
    INDEX_HTML.includes("tokens.getPropertyValue('--motion-fast')"),
    'Transition duration must be bound to --motion-fast token'
  );
});

// ----------------------------------------------------------------------------
// SUITE 6: MOBILE TOUCH ERGONOMICS (FINAL-POLISH-002)
// ----------------------------------------------------------------------------
test('FINAL-POLISH-002: Key mobile interactive controls target >= 44px effective touch height', () => {
  assert.ok(
    POLISH_CSS.includes('@media (max-width: 768px)'),
    'final-uiux-polish.css must include mobile responsive rule'
  );
  assert.ok(
    POLISH_CSS.includes('min-height: 44px !important;'),
    'Touch ergonomics rule must set min-height: 44px'
  );
});

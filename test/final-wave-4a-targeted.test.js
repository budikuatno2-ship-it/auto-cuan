'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const THEME_CSS = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const POLISH_CSS = fs.readFileSync(path.join(ROOT, 'public', 'final-uiux-polish.css'), 'utf8');
const LANDING_CSS = fs.readFileSync(path.join(ROOT, 'public', 'landing-experience.css'), 'utf8');

function relativeLuminance(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const a = [r, g, b].map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ----------------------------------------------------------------------------
// SUITE 1: DECOMMISSIONED FEATURE CLEANUP (FINAL-BUG-004)
// ----------------------------------------------------------------------------
test('FINAL-BUG-004: Money Management is permanently decommissioned from runtime web shell', () => {
  // 1. Sidebar button absent
  assert.equal(INDEX_HTML.includes('data-sidebar-page="money-management"'), false, 'money-management sidebar button must not exist');
  assert.equal(INDEX_HTML.includes('title="Kelola Keuangan"'), false, 'Kelola Keuangan sidebar title must not exist');

  // 2. Mobile nav button absent
  assert.equal(INDEX_HTML.includes('data-page="money-management"'), false, 'money-management mobile nav button must not exist');

  // 3. Worksheet container absent
  assert.equal(INDEX_HTML.includes('id="page-money-management"'), false, 'page-money-management section must not exist in DOM');
  assert.equal(INDEX_HTML.includes('id="mmCashflowSpreadsheetTable"'), false, 'spreadsheet table must not exist');

  // 4. Lazy loader script removed
  assert.equal(INDEX_HTML.includes('money-sheet-lazy-loader.js'), false, 'lazy loader script must not be included');

  // 5. isPremiumFeaturePage does not include money-management
  const premMatch = INDEX_HTML.match(/function isPremiumFeaturePage\(page\)\s*\{\s*return\s*(\[[^\]]+\])/);
  assert.ok(premMatch, 'isPremiumFeaturePage must be defined');
  assert.equal(premMatch[1].includes('money-management'), false, 'money-management must not be listed as premium feature page');

  // 6. Navigation router has no money-management loader
  assert.equal(INDEX_HTML.includes("if (page === 'money-management')"), false, 'router must not contain money-management loader');
});

// ----------------------------------------------------------------------------
// SUITE 2: LANDING MARKETING COPY CLEANUP (FINAL-RISK-001)
// ----------------------------------------------------------------------------
test('FINAL-RISK-001: Landing page markets only verified active capabilities (zero Lembar Keuangan)', () => {
  assert.equal(INDEX_HTML.toLowerCase().includes('lembar keuangan'), false, 'No mention of Lembar Keuangan on landing page');
  assert.equal(INDEX_HTML.includes('Finance Sheet'), false, 'No mention of Finance Sheet in workspace map');
  assert.equal(INDEX_HTML.includes('arus keuangan pribadi'), false, 'Lead copy must not market personal cashflow/budgeting');

  // Active verified capability replacement: Struktur Pasar is present on card 05
  assert.ok(INDEX_HTML.includes('<h3>Struktur pasar</h3>'), 'Card 05 is replaced with active verified capability: Struktur pasar');
  assert.ok(INDEX_HTML.includes('relasi emiten'), 'Card 05 copy accurately describes market structure');

  // The workspace-map module 05 must not retain the stale cashflow/budget subtitle.
  assert.equal(INDEX_HTML.includes('Cashflow & budget'), false, 'Module 05 must not advertise the decommissioned cashflow/budget capability');

  // Active verified intelligence & signal capability representation in Wave 9 research story
  assert.ok(INDEX_HTML.includes('<h3>Track Record Sinyal</h3>'), 'Landing markets verified systemic signal audit capability rather than decommissioned personal finance');
  assert.ok(INDEX_HTML.includes('sinyal sistemik Auto-Cuan'), 'Landing copy accurately describes systemic signal outputs');

  // The approved research workflow structure is present in the landing story
  const expectedStory = ['#landingMarket', '#landingScan', '#landingInvestigate', '#landingValidate', '#landingAI', '#landingMonitor'];
  for (const sectionId of expectedStory) {
    assert.ok(INDEX_HTML.includes(`href="${sectionId}"`) && INDEX_HTML.includes(`id="${sectionId.slice(1)}"`), `Landing presents active research workflow section ${sectionId}`);
  }
});

// ----------------------------------------------------------------------------
// SUITE 3: SIDEBAR EMPTY GROUP COLLAPSE (FINAL-BUG-007)
// ----------------------------------------------------------------------------
test('FINAL-BUG-007: Sidebar groups with 0 visible children collapse; nonempty groups remain', () => {
  // CSS rule exists for generic collapse
  assert.ok(
    POLISH_CSS.includes('.sidebar-nav-group:not(:has('),
    'final-uiux-polish.css must contain CSS :has() selector to collapse empty sidebar groups'
  );

  // JS helper exists to ensure programmatic visibility sync
  assert.ok(
    INDEX_HTML.includes('function updateSidebarGroupVisibility()'),
    'index.html must define updateSidebarGroupVisibility helper'
  );
  assert.ok(
    INDEX_HTML.includes('updateSidebarGroupVisibility();'),
    'applyPremiumAccessUi must invoke updateSidebarGroupVisibility'
  );
});

// ----------------------------------------------------------------------------
// SUITE 4: AUTH MODALS THEME SURFACE (FINAL-BUG-005)
// ----------------------------------------------------------------------------
test('FINAL-BUG-005: Auth modals inherit theme tokens consistently across all variants', () => {
  // All auth modal IDs are covered by landing-experience.css
  const modalSelector = ':is(#loginModal,#registerModal,#selfResetModal,#resetPasswordModal,#authChoiceModal) > div';
  assert.ok(LANDING_CSS.includes(modalSelector), 'modal card selector must cover all 5 modal IDs');
  assert.ok(LANDING_CSS.includes('background: var(--surface) !important;'), 'modal card background must use var(--surface)');

  // Fallback dark tokens exist in :root
  assert.ok(POLISH_CSS.includes('--surface: #10151F;'), ':root has dark surface token');
  assert.ok(POLISH_CSS.includes('--canvas: #090D16;'), ':root has dark canvas token');

  // Light tokens exist in html.light
  assert.ok(POLISH_CSS.includes('--surface: #ffffff;'), 'html.light has light surface token');
  assert.ok(POLISH_CSS.includes('--canvas: #f3f5f4;') || POLISH_CSS.includes('--canvas: #F7F8FA;'), 'html.light has light canvas token');
});

// ----------------------------------------------------------------------------
// SUITE 5: WARNING BADGE VISUAL AFFORDANCE (FINAL-BUG-006)
// ----------------------------------------------------------------------------
test('FINAL-BUG-006: Warning badge retains amber alert hierarchy in light mode', () => {
  assert.ok(
    POLISH_CSS.includes('.dash-badge:is([class*="amber"], .dash-badge-warning)'),
    'final-uiux-polish.css must preserve amber alert variant for warning badges'
  );
  assert.ok(
    POLISH_CSS.includes('background: #fef3c7 !important;'),
    'Amber warning badge must have distinct amber background in light mode'
  );
  assert.ok(
    POLISH_CSS.includes('color: #92400e !important;'),
    'Amber warning badge must have dark amber text for contrast in light mode'
  );

  // Contrast check: #92400e text on #fef3c7 background
  const ratio = contrastRatio('#92400e', '#fef3c7');
  assert.ok(ratio >= 4.5, `Warning badge text contrast must be >= 4.5:1 (measured ${ratio.toFixed(2)}:1)`);
});

// ----------------------------------------------------------------------------
// SUITE 6: LIGHT THEME CONTRAST TOKENS (FINAL-A11Y-005)
// ----------------------------------------------------------------------------
test('FINAL-A11Y-005: Secondary/muted text and sidebar group labels pass WCAG AA contrast (>= 4.5:1)', () => {
  // Test #475569 against white #FFFFFF and canvas #F8FAFC
  const ratioWhite = contrastRatio('#475569', '#FFFFFF');
  const ratioCanvas = contrastRatio('#475569', '#F8FAFC');

  assert.ok(ratioWhite >= 4.5, `Contrast against #FFFFFF must be >= 4.5:1 (measured ${ratioWhite.toFixed(2)}:1)`);
  assert.ok(ratioCanvas >= 4.5, `Contrast against #F8FAFC must be >= 4.5:1 (measured ${ratioCanvas.toFixed(2)}:1)`);

  // Verify CSS tokens
  assert.ok(
    POLISH_CSS.includes('--text-muted: #475569;'),
    'final-uiux-polish.css defines --text-muted as #475569 in light mode'
  );
  assert.ok(
    POLISH_CSS.includes('html.light .sidebar-group-label {\n  color: #475569 !important;'),
    'final-uiux-polish.css styles sidebar-group-label with #475569 in light mode'
  );
  assert.ok(
    THEME_CSS.includes('--text-muted: #475569;'),
    'ui-theme.css defines --text-muted as #475569 in light mode'
  );

  // Dark-mode subgroup labels must also clear AA: the sidebar-subgroup-label rule
  // must not fall back to the low-contrast tertiary token (~3.5:1).
  assert.ok(
    POLISH_CSS.includes('color: var(--text-secondary, #9AA4B2);'),
    'sidebar-subgroup-label must use the AA-safe secondary token in dark mode'
  );
  const darkRatioSurface = contrastRatio('#9AA4B2', '#0D1320');
  const darkRatioFlat = contrastRatio('#9AA4B2', '#10151F');
  assert.ok(darkRatioSurface >= 4.5, `Dark subgroup label contrast on #0D1320 must be >= 4.5:1 (measured ${darkRatioSurface.toFixed(2)}:1)`);
  assert.ok(darkRatioFlat >= 4.5, `Dark subgroup label contrast on #10151F must be >= 4.5:1 (measured ${darkRatioFlat.toFixed(2)}:1)`);
});

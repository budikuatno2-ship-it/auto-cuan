'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const themeCss = read('public/ui-theme.css');
const landingCss = read('public/landing-experience.css');
const landingJs = read('public/landing-experience.js');
const accountCenterCss = read('public/account-center-v1.css');

test('Wave 10: motion token ramp is declared and respects duration scale (§50)', () => {
  assert.match(themeCss, /--motion-press:\s*90ms;/);
  assert.match(themeCss, /--motion-hover:\s*140ms;/);
  assert.match(themeCss, /--motion-state:\s*190ms;/);
  assert.match(themeCss, /--motion-panel:\s*260ms;/);
  assert.match(themeCss, /--motion-story:\s*420ms;/);
  assert.match(themeCss, /--motion-hero-max:\s*560ms;/);
});

test('Wave 10: SPA navigation transitions are restrained and cancel in-flight transitions', () => {
  // navigateTo must cancel any active fade before switching
  assert.match(html, /if\s*\(el\._workspaceFade\)\s*\{\s*try\s*\{\s*el\._workspaceFade\.cancel\(\);\s*\}\s*catch\s*\(.*?\)\s*\{\}\s*el\._workspaceFade\s*=\s*null;\s*\}/);
  // navigateTo must check prefers-reduced-motion before starting an animation
  assert.match(html, /matchMedia\('\(prefers-reduced-motion:\s*reduce\)'\)/);
  // transition magnitude must be subtle (<= 4px) and fast
  assert.match(html, /translate3d\(0,\s*4px,\s*0\)/);
});

test('Wave 10: prefers-reduced-motion strictly disables motion and never leaves content stuck at opacity 0 (§54)', () => {
  // ui-theme.css reduced motion
  assert.match(themeCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(themeCss, /\.action-card:hover\s*\{\s*transform:\s*none;/);
  assert.match(themeCss, /\[data-ac-ui="v2"\]\s*\.fade-in[\s\S]*opacity:\s*1\s*!important/);

  // account-center-v1.css reduced motion
  assert.match(accountCenterCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(accountCenterCss, /\.ac-loading::before\s*\{\s*animation:\s*none\s*!important;\s*\}/);

  // landing experience reduced motion
  assert.match(landingCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(landingJs, /matchMedia\('\(prefers-reduced-motion:\s*reduce\)'\)/);
});

test('Wave 10: direct sidebar navigation preserves flat layout without deleted category headers (§22, §57)', () => {
  const sidebarStart = html.indexOf('id="appSidebar"');
  const sidebarEnd = html.indexOf('</aside>', sidebarStart);
  const sidebarHtml = html.slice(sidebarStart, sidebarEnd);

  // Direct items must be present
  assert.ok(sidebarHtml.includes('data-sidebar-page="dashboard"'));
  assert.ok(sidebarHtml.includes('data-sidebar-page="screener"'));
  assert.ok(sidebarHtml.includes('data-sidebar-page="analisis"'));
  assert.ok(sidebarHtml.includes('data-sidebar-page="portofolio"'));

  // Obsolete headers must not be re-introduced
  assert.doesNotMatch(sidebarHtml, /<span class="sidebar-category-header">OVERVIEW<\/span>/i);
  assert.doesNotMatch(sidebarHtml, /<span class="sidebar-category-header">DISCOVER<\/span>/i);
  assert.doesNotMatch(sidebarHtml, /<span class="sidebar-category-header">RESEARCH<\/span>/i);
});

test('Wave 10: desktop vs mobile account control placement strictly adheres to geometry contract (§82)', () => {
  // Desktop hides .app-header from top flow; footer owns identity and logout
  assert.match(themeCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*?#appMain\s*>\s*\.app-header\s*\{\s*display:\s*none\s*!important;/);
  // Mobile displays .app-header and headerAccountSection
  assert.match(themeCss, /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?#appMain\s*>\s*\.app-header\s*\{\s*display:\s*block\s*!important;/);
});

test('Wave 10: all 15 workstation routes exist in DOM with proper IDs and container classes', () => {
  const expectedRoutes = [
    'dashboard',
    'screener',
    'sektor',
    'analisis',
    'portofolio',
    'trackrecord',
    'watchlist',
    'chart',
    'news'
  ];

  expectedRoutes.forEach((route) => {
    assert.match(html, new RegExp(`id="page-${route}"`), `route page-${route} must exist in index.html`);
  });

  // Verify subtab destinations
  assert.match(html, /id="tabMarketStructure"/);
  assert.match(html, /id="tabSinyalIntelijen"/);
  assert.match(html, /id="tabFinancial"/);
});

test('Wave 10: trust and risk disclosure is clean and unambiguous (§105)', () => {
  assert.match(html, /<p class="landing-hero-note">Alat bantu analisis, bukan rekomendasi beli\/jual\. Keputusan tetap milik Anda\.<\/p>/);
  assert.match(html, /DATA CONTOH MEJA KERJA/);
  assert.match(html, /Pratinjau statis komponen antarmuka Auto-Cuan/);
});

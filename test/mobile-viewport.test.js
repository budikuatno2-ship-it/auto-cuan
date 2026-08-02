'use strict';

// ===========================================================================
// Regression tests for the mobile layout artifact.
//
// ROOT CAUSE
// Tailwind puts `min-height:100vh` on <body> (min-h-screen) and preflight sets
// `box-sizing:border-box`. The first pass then added
//     body.has-mobile-nav { padding-bottom: calc(var(--ac-nav-height) + safe-area) }
// to reserve room for a fixed bottom bar. With border-box that padding eats into
// the 100vh, so the body CONTENT box became 100vh − 62px — while #dashboardScreen
// is itself min-h-screen (100vh). The shell was permanently ~62px taller than its
// container, so every page was scrollable by the bar's height even when empty, and
// the `mt-auto` <footer> disclaimer ended up stranded in that dead band directly
// above the bar.
//
// Compounding it, 100vh on iOS Safari and Android Chrome measures the viewport with
// the URL bar COLLAPSED, so the shell overshoots the visible area and shifts as the
// bar hides and shows.
//
// LOCAL / STATIC ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const theme = read('public/ui-theme.css');
const html = read('public/index.html');
const nav = read('public/mobile-nav.js');
const portfolioCss = read('public/portfolio-command-center.css');

// Strip comments so prose describing the old bug cannot satisfy an assertion.
const themeRules = theme.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------------------
// 1. The dead band cannot come back
// ---------------------------------------------------------------------------
test('nothing pads <body> to reserve space for a fixed nav bar', () => {
  assert.doesNotMatch(themeRules, /has-mobile-nav/);
  assert.doesNotMatch(nav, /has-mobile-nav/);
  // No rule may add bottom padding to the body: with border-box that is exactly
  // what shrinks the 100vh content box below the 100vh shell.
  assert.doesNotMatch(themeRules, /\bbody[^{}]*\{[^}]*padding-bottom/);
});

test('the floating launcher is out of flow, so it reserves no layout space', () => {
  assert.match(themeRules, /\.ac-launcher \{[\s\S]*?position: fixed;/);
  assert.doesNotMatch(themeRules, /\.ac-mobilenav/);
});

test('the app footer clears the home indicator without shifting layout', () => {
  assert.match(themeRules, /#dashboardScreen > footer \{ padding-bottom: var\(--ac-safe-bottom\); \}/);
  assert.match(themeRules, /--ac-safe-bottom: env\(safe-area-inset-bottom, 0px\);/);
});

// ---------------------------------------------------------------------------
// 2. Dynamic viewport height, with a fallback
// ---------------------------------------------------------------------------
test('every full-height shell uses dvh with a vh fallback', () => {
  const fallback = themeRules.slice(0, themeRules.indexOf('@supports (height: 100dvh)'));
  const dynamic = themeRules.slice(themeRules.indexOf('@supports (height: 100dvh)'));

  ['body', '#dashboardScreen', '.landing-shell'].forEach(selector => {
    assert.ok(fallback.includes(selector), 'missing vh fallback for ' + selector);
  });
  assert.match(fallback, /min-height: 100vh;/);
  assert.match(dynamic, /min-height: 100dvh;/);
  assert.match(dynamic, /\.sidebar \{ height: 100dvh; \}/);
  assert.match(dynamic, /#page-analisis \{ min-height: calc\(100dvh - 120px\); \}/);
  assert.match(dynamic, /#aiSection \{ min-height: calc\(100dvh - 64px\); \}/);
});

test('the inline 100vh heights were moved out of the markup, not duplicated', () => {
  // Inline styles can only be beaten with !important; moving them into the theme
  // keeps the override honest.
  assert.doesNotMatch(html, /style="min-height:calc\(100vh/);
  assert.match(html, /id="page-analisis"/);
  assert.match(html, /id="aiSection"/);
});

test('the theme layer still wins on merit rather than !important', () => {
  const reduced = themeRules.slice(themeRules.indexOf('@media (prefers-reduced-motion: reduce)'));
  const body = themeRules.slice(0, themeRules.indexOf('@media (prefers-reduced-motion: reduce)'));
  const shouts = body.match(/!important/g) || [];
  assert.equal(shouts.length, 1, 'expected exactly one !important outside reduced motion');
  assert.match(themeRules, /\.mobile-nav-row \{ display: none !important; \}/);
  assert.match(reduced, /!important/);
});

// ---------------------------------------------------------------------------
// 3. Safe areas and overlay behaviour, Android + iOS
// ---------------------------------------------------------------------------
test('fixed and sticky chrome respects the safe area', () => {
  assert.match(themeRules, /\.app-header \{ padding-top: env\(safe-area-inset-top, 0px\); \}/);
  assert.match(themeRules, /\.ac-viewer \{[\s\S]*?padding-top: env\(safe-area-inset-top\);/);
  assert.match(themeRules, /\[role="dialog"\] \{ padding-bottom: env\(safe-area-inset-bottom, 0px\); \}/);
  assert.match(themeRules, /padding-left: max\(12px, env\(safe-area-inset-left\)\)/);
});

test('the launcher is clamped inside the safe area rather than the raw viewport', () => {
  const source = require('../public/mobile-nav');
  const pos = source.snapPosition({ x: 9999, y: 9999 },
    { width: 390, height: 780, size: 56, insets: { top: 59, right: 0, bottom: 34, left: 0 } });
  assert.ok(pos.y <= 780 - 56 - source.EDGE_GAP - 34);
  assert.match(nav, /readInset\(root, 'safe-area-inset-top'\)/);
});

test('scroll containers keep their overscroll to themselves', () => {
  // Without this an Android sideways swipe on a wide screener table triggers
  // back-navigation, and iOS rubber-bands the whole document.
  assert.match(themeRules, /\.overflow-x-auto, \.overflow-y-auto, \.nav-scroll-container \{[\s\S]*?overscroll-behavior: contain;/);
  assert.match(themeRules, /\.ac-viewer-imageframe \{[\s\S]*?overscroll-behavior: contain;/);
  assert.match(themeRules, /\.ac-navpanel-card \{[\s\S]*?overscroll-behavior: contain;/);
});

test('the fullscreen viewer owns every touch gesture inside its image frame', () => {
  assert.match(themeRules, /\.ac-viewer-imageframe \{[\s\S]*?touch-action: none;/);
  assert.match(themeRules, /\.ac-launcher \{[\s\S]*?touch-action: none;/);
});

// ---------------------------------------------------------------------------
// 4. Touch targets
// ---------------------------------------------------------------------------
test('interactive controls stay finger-sized on phones', () => {
  const launcher = /\.ac-launcher \{[\s\S]*?\}/.exec(themeRules);
  assert.ok(launcher && /width: var\(--ac-fab-size\)/.test(launcher[0]));
  assert.match(themeRules, /--ac-fab-size: 56px;/);
  const item = /\.ac-navpanel-item \{[\s\S]*?\}/.exec(themeRules);
  assert.ok(item && /min-height: 48px/.test(item[0]));
  const viewerBtn = /\.ac-viewer-btn \{[\s\S]*?\}/.exec(themeRules);
  assert.ok(viewerBtn && /min-height: 40px/.test(viewerBtn[0]));
  assert.match(themeRules, /\.nav-btn, \.screener-tab, \.nk-screener-tab, \.dt-screener-tab \{ min-height: 40px; \}/);
});

// ---------------------------------------------------------------------------
// 5. Portfolio Command Center (separate page, targeted fixes only)
// ---------------------------------------------------------------------------
test('the Portfolio page gets dvh and safe-area treatment too', () => {
  assert.match(portfolioCss, /min-height:100vh;min-height:100dvh/);
  assert.match(portfolioCss, /\.tab-strip\{position:sticky;top:env\(safe-area-inset-top,0px\)/);
  assert.match(portfolioCss, /\.app-shell\{padding:max\(12px,env\(safe-area-inset-top,0px\)\)/);
  assert.match(portfolioCss, /calc\(90px \+ env\(safe-area-inset-bottom,0px\)\)/);
});

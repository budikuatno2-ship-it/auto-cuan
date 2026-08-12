'use strict';

// ===========================================================================
// Two things that must survive the Tailwind Play CDN being unreachable.
//
// 1. `.hidden`
// ------------
// public/index.html drives its entire show/hide behaviour through this one
// class: which top-level screen is up (loader / blocked / maintenance / landing
// / app), which page is up, which nav items an unapproved account sees, and
// every modal. It was supplied ONLY by the Tailwind CDN.
//
// Measured in Chromium at 390px with that CDN aborted:
//
//   before   visibleScreens: [initialLoader, blockedScreen, maintenanceScreen,
//                             landingPage, dashboardScreen]
//            openModals: 7      docHeight: 24386px   overflowX: 630px
//   after    visibleScreens: [landingPage]
//            openModals: 0      docHeight:  8383px   overflowX:  14px
//
// The rule must NOT be !important. `class="hidden md:flex"` is used for the
// desktop landing menu, and Tailwind's .md\:flex wins purely on source order;
// !important here would pin that menu shut. Verified with Tailwind present:
// .landing-menu computes to `flex` at 1440px and `none` at 390px.
//
// 2. The maintenance screen
// -------------------------
// It is the screen most likely to be shown when something is already wrong, so
// it must not depend on the app's JS, the API, the webfont, or the CDN. Its
// styles live in the inline stylesheet for that reason.
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const inlineStyle = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

// ---------------------------------------------------------------------------
// .hidden
// ---------------------------------------------------------------------------

test('.hidden is defined without the Tailwind CDN', () => {
  assert.match(
    inlineStyle,
    /\.hidden\s*\{\s*display:\s*none;?\s*\}/,
    'the app cannot hide a screen, page or modal if this class only exists on a third-party CDN'
  );
});

test('.hidden is not !important, so responsive display utilities still win', () => {
  const rule = inlineStyle.match(/\.hidden\s*\{[^}]*\}/);
  assert.ok(rule, '.hidden rule must exist');
  assert.doesNotMatch(
    rule[0],
    /!important/,
    'class="hidden md:flex" is used for the desktop landing menu; !important pins it shut'
  );
});

test('the class the app actually toggles is the one defined', () => {
  // Guards against someone "fixing" this by renaming rather than defining.
  assert.ok(html.includes("classList.add('hidden')"), 'the app toggles .hidden');
  assert.ok(html.includes("classList.remove('hidden')"), 'the app toggles .hidden');
});

test('the hidden-plus-responsive pattern this protects is still in use', () => {
  assert.match(html, /class="landing-menu hidden md:flex/, 'the pattern the non-important rule protects');
});

// ---------------------------------------------------------------------------
// Maintenance screen
// ---------------------------------------------------------------------------

const maintenance = (() => {
  const start = html.indexOf('<div id="maintenanceScreen"');
  assert.ok(start > 0, 'the maintenance screen must exist');
  return html.slice(start, html.indexOf('<!-- ===== ', start + 10));
})();

test('the maintenance screen announces itself to assistive technology', () => {
  assert.match(maintenance, /role="status"/);
  assert.match(maintenance, /aria-live="polite"/);
});

test('the maintenance screen carries the product identity, not an emoji', () => {
  assert.match(maintenance, /Auto-Cuan/, 'it must be recognisably this product');
  assert.match(maintenance, /<svg/, 'the mark is inline SVG, so it needs no network');
  assert.doesNotMatch(
    maintenance,
    /&#x1F6E0;|\u{1F6E0}/u,
    'a hammer emoji reads as a crash, not as a deliberate pause'
  );
});

test('the maintenance screen gives the user something to do', () => {
  assert.match(maintenance, /window\.location\.reload\(\)/, 'a retry affordance');
  assert.match(maintenance, /Muat ulang halaman/);
});

test('the maintenance screen says what is and is not affected', () => {
  // The questions a user actually has: is my data safe, is an order stuck.
  assert.match(maintenance, /tersimpan dan tidak terpengaruh/);
  assert.match(maintenance, /tidak pernah mengeksekusi transaksi/);
});

test('the maintenance message stays server-driven', () => {
  // The admin-set message from app_settings still lands here.
  assert.match(maintenance, /id="maintenanceMessage"/);
  const setter = html.indexOf("getElementById('maintenanceMessage')");
  assert.ok(setter > 0, 'the admin message must still be applied to it');
});

test('the maintenance styles do not depend on the CDN or the webfont', () => {
  // Every class the screen uses must resolve from the inline stylesheet.
  const classes = [...maintenance.matchAll(/class="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((c) => c.startsWith('maintenance-'));
  assert.ok(classes.length >= 8, 'the screen should be built from its own classes');
  [...new Set(classes)].forEach((cls) => {
    assert.ok(
      inlineStyle.includes('.' + cls),
      '.' + cls + ' must be defined in the inline stylesheet, not on a CDN'
    );
  });
});

test('the maintenance screen owns its box model and gutter', () => {
  // Tailwind's preflight supplies border-box globally and the wrapper's px-4
  // supplies the gutter. Both come from the CDN. Leaning on them overflowed a
  // 390px viewport by 42px; owning them brings it to 0.
  assert.match(inlineStyle, /#maintenanceScreen\s*\{[^}]*box-sizing:\s*border-box/);
  assert.match(inlineStyle, /#maintenanceScreen\s*\{[^}]*padding-left/);
  assert.match(inlineStyle, /\.maintenance-card,\s*\.maintenance-card \*\s*\{\s*box-sizing:\s*border-box/);
});

test('the maintenance retry button meets the touch-target minimum', () => {
  const rule = inlineStyle.match(/\.maintenance-btn\s*\{[^}]*\}/);
  assert.ok(rule, '.maintenance-btn must be styled');
  assert.match(rule[0], /min-height:\s*44px/, 'a primary action on a phone needs a real target');
});

test('the maintenance screen has a visible focus state', () => {
  assert.match(inlineStyle, /\.maintenance-btn:focus-visible\s*\{[^}]*outline/);
});

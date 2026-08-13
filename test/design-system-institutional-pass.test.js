'use strict';

// ===========================================================================
// Guards for the institutional design pass (section 8 of public/ui-theme.css).
//
// The pass deliberately restyles component classes and element selectors that
// already exist, so that none of it requires an HTML change and none of it can
// alter behaviour. These tests protect the properties that make it work:
//
//   - it stays a single design system (it extends the section 1 tokens rather
//     than declaring a rival palette)
//   - it wins over Tailwind utilities on specificity, not on source order,
//     because the Play CDN's injection point is not guaranteed
//   - it never reaches for !important, so an individual element can still opt out
//   - it keeps the invariants the build patchers assert
//   - financial colour is always reinforced by a second cue
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const theme = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const portfolioCss = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-command-center.css'), 'utf8');
const portfolioJs = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-command-center.js'), 'utf8');

// Slice from the section banner. The banner itself is a comment, and the slice
// lands inside it, so drop the dangling fragment up to its terminator — otherwise
// a comment-stripper downstream cannot see where that comment began.
const section8 = (() => {
  const at = theme.indexOf('8. Institutional pass');
  assert.ok(at > 0, 'section 8 must exist in public/ui-theme.css');
  const rest = theme.slice(at);
  return rest.slice(rest.indexOf('*/') + 2);
})();

// ---------------------------------------------------------------------------
// One design system, not two
// ---------------------------------------------------------------------------

test('the pass extends the existing token layer', () => {
  // Section 1 owns the base ramp; section 8 may add to it but must build on it.
  assert.match(theme, /--ac-radius-lg:/, 'the original radius scale must survive');
  assert.match(theme, /--ac-space-4:/, 'the original spacing scale must survive');
  assert.match(section8, /var\(--ac-radius-/, 'new rules reuse the radius scale');
  assert.match(section8, /var\(--ac-text-/, 'new rules reuse the type ramp');
});

test('the type ramp is declared as tokens rather than scattered literals', () => {
  for (const token of ['--ac-text-micro', '--ac-text-caption', '--ac-text-body', '--ac-text-lead', '--ac-text-metric']) {
    assert.match(section8, new RegExp(token + ':'), token + ' must be defined');
  }
});

test('financial semantics are named by meaning, not by hue', () => {
  for (const token of ['--ac-bull', '--ac-bear', '--ac-flat', '--ac-warn', '--ac-info']) {
    assert.match(section8, new RegExp('\\' + token + ':'), token + ' must be defined');
  }
});

test('there is one focus treatment for the whole product', () => {
  assert.match(section8, /--ac-focus:/, 'a focus token must exist');
  const usages = (section8.match(/var\(--ac-focus\)/g) || []).length;
  assert.ok(usages >= 2, 'the focus token should drive both controls and interactive elements');
});

// ---------------------------------------------------------------------------
// It must win on specificity, not source order, and never on !important
// ---------------------------------------------------------------------------

test('the pass never uses !important', () => {
  // Comments are stripped first — the section documents this rule in prose, and
  // the prose must not satisfy or trip its own guard. The reduced-motion block
  // is the documented exception: it has to be able to stop an animation that an
  // element opted into.
  const declarations = section8
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media \(prefers-reduced-motion[\s\S]*$/, '');
  assert.doesNotMatch(
    declarations,
    /!important/,
    'an element must always be able to opt out with a deliberate utility'
  );
});

test('rules that override a Tailwind utility carry enough specificity', () => {
  // A bare `.text-right { ... }` would tie with Tailwind and lose whenever the
  // CDN injects after this sheet. Anything targeting a utility must be scoped.
  const utilityTargets = section8.match(/^\s*\.(text|bg|border|grid|rounded)-[^\s,{]*\s*\{/gm) || [];
  assert.equal(
    utilityTargets.length,
    0,
    'found an unscoped utility-class override: ' + utilityTargets.join(', ')
  );
});

test('the table treatment is scoped to real containers', () => {
  assert.match(section8, /\.panel table thead th/, 'header styling is scoped to a panel table');
  assert.doesNotMatch(section8, /^\s*table\s*\{/m, 'a bare element selector would leak to every table');
});

// ---------------------------------------------------------------------------
// Invariants the build patchers assert
// ---------------------------------------------------------------------------

test('the build-patcher invariants still hold', () => {
  assert.ok(!/has-mobile-nav/.test(theme), 'the body padding-bottom nav hack must stay gone');
  assert.ok(!theme.includes('.ac-mobilenav-item'), 'the replaced bottom-bar styles must stay gone');
  assert.ok(theme.includes('.ac-launcher'), 'the floating launcher styles must survive');
  assert.ok(theme.includes('.ac-navpanel'), 'the launcher panel styles must survive');
  assert.ok(theme.includes('@supports (height: 100dvh)'), 'dynamic viewport height must survive');
  assert.ok(theme.includes('min-height: 100vh'), 'the vh fallback must survive');
});

test('reduced motion still disables the transitions the pass adds', () => {
  const reduced = theme.slice(theme.lastIndexOf('@media (prefers-reduced-motion'));
  assert.match(reduced, /\.action-card:hover \{ transform: none/, 'the new card lift must be suppressed');
  assert.match(reduced, /\.panel table tbody tr \{ transition: none/, 'the new row hover must be suppressed');
});

// ---------------------------------------------------------------------------
// Financial legibility
// ---------------------------------------------------------------------------

test('figures are tabular so columns line up as values change', () => {
  assert.match(section8, /font-variant-numeric: tabular-nums/);
  assert.match(section8, /table td,/, 'every table cell, not just a few classes');
});

test('profit and loss carries a tone, reinforced by the sign', () => {
  assert.match(portfolioJs, /function pnlClass\(/, 'the portfolio must classify P/L by sign');
  for (const cls of ['pnl-up', 'pnl-down', 'pnl-flat', 'pnl-unknown']) {
    assert.match(portfolioCss, new RegExp('\\.' + cls + '\\s*\\{'), '.' + cls + ' must be styled');
  }
  // money() keeps the minus in the text, so colour is never the only cue.
  assert.match(portfolioJs, /toLocaleString\('id-ID'\)/, 'the sign stays in the rendered string');
  assert.match(portfolioCss, /\.pnl \{ font-variant-numeric: tabular-nums/);
});

test('P/L tone is applied at every place P/L is rendered', () => {
  const renders = (portfolioJs.match(/money\((?:summary\.totalPnlIdr|row\.pnl|pnl)\)/g) || []).length;
  const toned = (portfolioJs.match(/pnlClass\(/g) || []).length;
  assert.ok(renders >= 3, 'expected the summary, card and drawer P/L renders');
  assert.ok(toned >= 4, 'each render site plus the helper definition should reference pnlClass');
});

// ---------------------------------------------------------------------------
// Density and hierarchy decisions worth keeping
// ---------------------------------------------------------------------------

test('the screener notice bars are demoted, not deleted', () => {
  // They are reference material; nothing may be hidden, it just stops
  // outranking the candidates underneath it.
  assert.match(section8, /\.page-content \.scr-info-bar/);
  assert.doesNotMatch(section8, /\.scr-info-bar[^{]*\{[^}]*display:\s*none/, 'the disclaimer must stay visible');
});

test('the stat strip hugs its content instead of stretching', () => {
  assert.match(section8, /#screenerStats[^{]*\{[\s\S]*?width: max-content/);
});

test('wide screens widen only the data surfaces', () => {
  const wide = section8.slice(section8.indexOf('@media (min-width: 1536px)'));
  assert.match(wide, /#page-screener\.page-content/);
  assert.match(wide, /#page-sektor\.page-content/);
  assert.doesNotMatch(wide, /#page-analisis/, 'prose-width surfaces should keep their measure');
});

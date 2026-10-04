'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const DESIGN_MD_PATH = path.join(ROOT_DIR, 'DESIGN.md');
const UI_THEME_CSS_PATH = path.join(ROOT_DIR, 'public', 'ui-theme.css');
const INDEX_HTML_PATH = path.join(ROOT_DIR, 'public', 'index.html');

test('WAVE-1A-01: DESIGN.md exists in worktree root and matches canonical SHA-256', () => {
  assert.ok(fs.existsSync(DESIGN_MD_PATH), 'DESIGN.md must exist in the root of the worktree');
  const content = fs.readFileSync(DESIGN_MD_PATH);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const EXPECTED_HASH = '4750e34fd2d03c9d64e2c760ca6b1451695a4cc093db0639a915c828ab5e5f3d';
  assert.equal(hash.toLowerCase(), EXPECTED_HASH.toLowerCase(), 'DESIGN.md SHA-256 must match authoritative freeze hash');
});

test('WAVE-1A-02: Scoped rollout is deterministic and NOT globally active in production shell', () => {
  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.doesNotMatch(indexHtml, /<html[^>]*data-ui-version=["']v2["']/, '<html> must NOT have data-ui-version="v2" globally activated in Wave 1A');
  assert.doesNotMatch(indexHtml, /<body[^>]*data-ui-version=["']v2["']/, '<body> must NOT have data-ui-version="v2" globally activated in Wave 1A');

  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');
  assert.match(css, /\[data-ui-version=["']v2["']\]/, 'public/ui-theme.css must declare scoped v2 foundation selector');
});

test('WAVE-1A-03: Canonical v2 color tokens match DESIGN.md specifications', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');
  const v2Section = css.slice(css.indexOf('[data-ui-version="v2"]'));

  // Surfaces
  assert.match(v2Section, /--ac-canvas:\s*#F3F5F4/i, 'Canvas must be #F3F5F4');
  assert.match(v2Section, /--ac-surface:\s*#FFFFFF/i, 'Surface must be #FFFFFF');
  assert.match(v2Section, /--ac-surface-raised:\s*#F8FAF9/i, 'Raised surface must be #F8FAF9');
  assert.match(v2Section, /--ac-surface-hover:\s*#EEF2F0/i, 'Hover surface must be #EEF2F0');

  // Ink & text
  assert.match(v2Section, /--ac-ink:\s*#17211E/i, 'Primary ink must be #17211E');
  assert.match(v2Section, /--ac-text-secondary:\s*#52605B/i, 'Secondary text must be #52605B');
  assert.match(v2Section, /--ac-text-muted:\s*#5F6C66/i, 'Muted text must be #5F6C66');
  assert.match(v2Section, /--ac-text-tertiary:\s*var\(--ac-text-muted\)/i, 'Tertiary text must alias to muted token');

  // Brand emerald
  assert.match(v2Section, /--ac-brand:\s*#0F7458/i, 'Brand emerald must be #0F7458');
  assert.match(v2Section, /--ac-brand-hover:\s*#0B6049/i, 'Brand hover must be #0B6049');
  assert.match(v2Section, /--ac-brand-soft:\s*#E8F3EE/i, 'Brand soft must be #E8F3EE');

  // Financial semantics
  assert.match(v2Section, /--ac-positive:\s*#247A43/i, 'Financial positive must be #247A43');
  assert.match(v2Section, /--ac-negative:\s*#C13F4D/i, 'Financial negative must be #C13F4D');
  assert.match(v2Section, /--ac-warning-text:\s*#96610F/i, 'Warning text must be #96610F');
  assert.match(v2Section, /--ac-info:\s*#315F9A/i, 'Info must be #315F9A');
});

test('WAVE-1A-04: Brand emerald and financial positive are strictly differentiated without legacy slop', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');
  const v2Section = css.slice(css.indexOf('[data-ui-version="v2"]'));

  const brandMatch = v2Section.match(/--ac-brand:\s*([^;]+);/);
  const posMatch = v2Section.match(/--ac-positive:\s*([^;]+);/);

  assert.ok(brandMatch && posMatch, 'Both brand and positive must be defined');
  assert.notEqual(brandMatch[1].trim(), posMatch[1].trim(), 'Brand emerald and positive green must be distinct');

  // Verify old positive (#167A59) is not reintroduced in v2 tokens
  assert.doesNotMatch(v2Section, /--ac-positive:\s*#167A59/i, 'Old positive #167A59 must not be reintroduced in v2 tokens');
  assert.doesNotMatch(v2Section, /--ac-text-tertiary:\s*#65726C/i, 'Old tertiary #65726C must not be used as literal in tertiary text token');
});

test('WAVE-1A-05: Shared sizing tokens conform to DESIGN.md §103.3', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');

  assert.match(css, /--ac-row-dense:\s*38px;/i, 'Dense row height must be 38px');
  assert.match(css, /--ac-row-comfort:\s*42px;/i, 'Comfort row height must be 42px');
  assert.match(css, /--ac-control-sm:\s*36px;/i, 'Small control height must be 36px');
  assert.match(css, /--ac-control-md:\s*42px;/i, 'Medium control height must be 42px');
  assert.match(css, /--ac-touch-target:\s*44px;/i, 'Minimum touch target must be 44px');
  assert.match(css, /--ac-topbar-height:\s*52px;/i, 'Topbar height must be 52px');
  assert.match(css, /--ac-sidebar-width:\s*240px;/i, 'Sidebar width must be 240px');
  assert.match(css, /--ac-sidebar-rail:\s*68px;/i, 'Sidebar rail must be 68px');
});

test('WAVE-1A-06: Semantic z-index tokens conform to DESIGN.md §103.2', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');

  assert.match(css, /--ac-z-base:\s*0;/i, 'z-base must be 0');
  assert.match(css, /--ac-z-sticky:\s*20;/i, 'z-sticky must be 20');
  assert.match(css, /--ac-z-shell:\s*40;/i, 'z-shell must be 40');
  assert.match(css, /--ac-z-popover:\s*60;/i, 'z-popover must be 60');
  assert.match(css, /--ac-z-drawer:\s*80;/i, 'z-drawer must be 80');
  assert.match(css, /--ac-z-modal:\s*100;/i, 'z-modal must be 100');
  assert.match(css, /--ac-z-toast:\s*120;/i, 'z-toast must be 120');
  assert.match(css, /--ac-z-critical-gate:\s*140;/i, 'z-critical-gate must be 140');
});

test('WAVE-1A-07: Categorical chart palette tokens conform to DESIGN.md §103.1', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');

  // Light chart categorical
  assert.match(css, /--ac-chart-cat-1:\s*#315F9A;/i, 'cat-1 light must be #315F9A');
  assert.match(css, /--ac-chart-cat-2:\s*#7357A6;/i, 'cat-2 light must be #7357A6');
  assert.match(css, /--ac-chart-cat-3:\s*#94602B;/i, 'cat-3 light must be #94602B');
  assert.match(css, /--ac-chart-cat-4:\s*#2F6F86;/i, 'cat-4 light must be #2F6F86');
  assert.match(css, /--ac-chart-cat-5:\s*#8C4F73;/i, 'cat-5 light must be #8C4F73');
  assert.match(css, /--ac-chart-cat-6:\s*#536A7C;/i, 'cat-6 light must be #536A7C');

  // Dark chart categorical
  assert.match(css, /--ac-chart-cat-1-dark:\s*#8BB2E8;/i, 'cat-1 dark must be #8BB2E8');
  assert.match(css, /--ac-chart-cat-2-dark:\s*#B9A0E3;/i, 'cat-2 dark must be #B9A0E3');
  assert.match(css, /--ac-chart-cat-3-dark:\s*#DFB277;/i, 'cat-3 dark must be #DFB277');
  assert.match(css, /--ac-chart-cat-4-dark:\s*#7FB7CF;/i, 'cat-4 dark must be #7FB7CF');
  assert.match(css, /--ac-chart-cat-5-dark:\s*#D995B7;/i, 'cat-5 dark must be #D995B7');
  assert.match(css, /--ac-chart-cat-6-dark:\s*#A9BDCF;/i, 'cat-6 dark must be #A9BDCF');
});

test('WAVE-1A-08: Accessibility & Focus Primitives adhere to anti-slop and WCAG standards', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');
  const v2Section = css.slice(css.indexOf('[data-ui-version="v2"]'));

  // Focus visible with physical offset separation
  assert.match(v2Section, /outline-offset:\s*2px;/, 'Focus ring must provide physical outline separation');

  // Control border contrast >= 3:1 against white surface (#7D8683 on #FFFFFF is 3.52:1)
  assert.match(v2Section, /--ac-control-border:\s*#7D8683;/i, 'Control border must meet >= 3:1 contrast against surface');

  // Selection indicator must not be color-only
  assert.match(v2Section, /\[data-ui-version=["']v2["']\]\s+\.ac-table\s+tr\[aria-selected=["']true["']\]\s+td:first-child::before/, 'Table row selection must include a non-color-only indicator bar');

  // Evidence metadata font size must be >= 12px (0.75rem) and secondary contrast
  assert.match(v2Section, /\.ac-evidence-meta\s*\{[^}]*font-size:\s*0\.75rem;/, 'Evidence metadata must be >= 12px (0.75rem)');
  assert.match(v2Section, /\.ac-evidence-meta\s*\{[^}]*color:\s*var\(--ac-text-secondary\);/, 'Evidence metadata must use secondary text contrast');
});

test('WAVE-1A-09: No !important rules introduced in Wave 1A scoped CSS additions', () => {
  const css = fs.readFileSync(UI_THEME_CSS_PATH, 'utf8');
  const v2Index = css.indexOf('/* =========================================================================\n   9. Auto-Cuan v2 Foundation Contract');
  assert.ok(v2Index > -1, 'v2 Foundation section must exist in ui-theme.css');

  const v2Section = css.slice(v2Index);
  assert.doesNotMatch(v2Section, /!important/, 'Wave 1A scoped CSS additions must not contain !important');
});

function sRGBtoLin(c) {
  c = c / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function getLuminance(hex) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
}

function contrastRatio(hex1, hex2) {
  const L1 = getLuminance(hex1);
  const L2 = getLuminance(hex2);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

test('WAVE-1A-10: Light mode contrast ratios meet WCAG standards via deterministic formula', () => {
  const white = '#FFFFFF';
  assert.ok(contrastRatio(white, '#17211E') >= 4.5, '#17211E on #FFFFFF must be >= 4.5:1');
  assert.ok(contrastRatio(white, '#52605B') >= 4.5, '#52605B on #FFFFFF must be >= 4.5:1');
  assert.ok(contrastRatio(white, '#5F6C66') >= 4.5, '#5F6C66 on #FFFFFF must be >= 4.5:1');
  assert.ok(contrastRatio(white, '#247A43') >= 4.5, '#247A43 on #FFFFFF must be >= 4.5:1');
  assert.ok(contrastRatio(white, '#C13F4D') >= 4.5, '#C13F4D on #FFFFFF must be >= 4.5:1');
  assert.ok(contrastRatio(white, '#96610F') >= 4.5, '#96610F on #FFFFFF must be >= 4.5:1');
  assert.ok(contrastRatio(white, '#7D8683') >= 3.0, '#7D8683 control border on #FFFFFF must be >= 3.0:1');
  assert.ok(contrastRatio(white, '#0F7458') >= 3.0, '#0F7458 brand on #FFFFFF must be >= 3.0:1');
});

test('WAVE-1A-11: Dark mode implementation-parity tokens meet WCAG standards via deterministic formula', () => {
  const surface = '#121820';
  const raised = '#18202A';

  // Surface (#121820) checks
  assert.ok(contrastRatio(surface, '#E6EDF3') >= 4.5, '#E6EDF3 on dark surface must be >= 4.5:1');
  assert.ok(contrastRatio(surface, '#9AA7B4') >= 4.5, '#9AA7B4 on dark surface must be >= 4.5:1');
  assert.ok(contrastRatio(surface, '#788999') >= 4.5, '#788999 on dark surface must be >= 4.5:1');
  assert.ok(contrastRatio(surface, '#5E6F7E') >= 3.0, '#5E6F7E control border on dark surface must be >= 3.0:1');
  assert.ok(contrastRatio(surface, '#1FAF82') >= 3.0, '#1FAF82 brand on dark surface must be >= 3.0:1');
  assert.ok(contrastRatio(surface, '#34A853') >= 4.5, '#34A853 positive on dark surface must be >= 4.5:1');
  assert.ok(contrastRatio(surface, '#E86371') >= 4.5, '#E86371 negative on dark surface must be >= 4.5:1');
  assert.ok(contrastRatio(surface, '#E5A338') >= 4.5, '#E5A338 warning on dark surface must be >= 4.5:1');
  assert.ok(contrastRatio(surface, '#5B8CFF') >= 4.5, '#5B8CFF info on dark surface must be >= 4.5:1');

  // Raised (#18202A) checks
  assert.ok(contrastRatio(raised, '#788999') >= 4.5, '#788999 on raised surface must be >= 4.5:1');
  assert.ok(contrastRatio(raised, '#5E6F7E') >= 3.0, '#5E6F7E control border on raised surface must be >= 3.0:1');
  assert.ok(contrastRatio(raised, '#E86371') >= 4.5, '#E86371 negative on raised surface must be >= 4.5:1');
});


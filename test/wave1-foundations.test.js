'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const uiThemeCss = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const spreadsheetGradeCss = fs.readFileSync(path.join(ROOT, 'public', 'spreadsheet-grade.css'), 'utf8');
const numberFlowCss = fs.readFileSync(path.join(ROOT, 'public', 'number-flow.css'), 'utf8');
const numberFlowJs = fs.readFileSync(path.join(ROOT, 'public', 'number-flow-runtime.js'), 'utf8');
const viewportCss = fs.readFileSync(path.join(ROOT, 'public', 'viewport.css'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Canonical Tokens (§4.1, §6-§9, §50, §103)
// ---------------------------------------------------------------------------
test('Wave 1: Canonical light tokens match DESIGN.md §4.1 exactly', () => {
  const lightTokens = [
    ['--ac-canvas', '#F3F5F4'],
    ['--ac-surface', '#FFFFFF'],
    ['--ac-surface-raised', '#F8FAF9'],
    ['--ac-surface-hover', '#EEF2F0'],
    ['--ac-ink', '#17211E'],
    ['--ac-text-secondary', '#52605B'],
    ['--ac-text-muted', '#5F6C66'],
    ['--ac-line-hairline', '#E2E7E4'],
    ['--ac-control-border', '#7D8683'],
    ['--ac-control-border-hover', '#65726C'],
    ['--ac-brand', '#0F7458'],
    ['--ac-brand-hover', '#0B6049'],
    ['--ac-brand-soft', '#E8F3EE'],
    ['--ac-focus', '#0F7458'],
    ['--ac-positive', '#247A43'],
    ['--ac-negative', '#C13F4D'],
    ['--ac-warning', '#A96D13'],
    ['--ac-warning-text', '#96610F'],
    ['--ac-info', '#315F9A'],
    ['--ac-success', '#247A43'],
    ['--ac-danger', '#C13F4D']
  ];

  for (const [token, value] of lightTokens) {
    const rx = new RegExp(token + ':\\s*' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    assert.match(uiThemeCss, rx, 'missing or mismatched canonical token ' + token);
  }
});

test('Wave 1: Canonical spacing scale matches DESIGN.md §7', () => {
  ['4px', '8px', '12px', '16px', '20px', '24px', '32px', '40px', '48px', '64px', '80px', '96px', '128px'].forEach(val => {
    assert.match(uiThemeCss, new RegExp('--ac-space-[0-9]+:\\s*' + val), 'missing space step for ' + val);
  });
});

test('Wave 1: Canonical radius scale matches DESIGN.md §8', () => {
  ['--ac-radius-xs:\\s*4px', '--ac-radius-sm:\\s*6px', '--ac-radius-md:\\s*8px', '--ac-radius-lg:\\s*12px', '--ac-radius-xl:\\s*16px', '--ac-radius-full:\\s*999px'].forEach(pat => {
    assert.match(uiThemeCss, new RegExp(pat));
  });
});

test('Wave 1: Shared sizing tokens match DESIGN.md §103.3', () => {
  assert.match(uiThemeCss, /--ac-row-dense:\s*38px/);
  assert.match(uiThemeCss, /--ac-row-comfort:\s*42px/);
  assert.match(uiThemeCss, /--ac-control-sm:\s*36px/);
  assert.match(uiThemeCss, /--ac-control-md:\s*42px/);
  assert.match(uiThemeCss, /--ac-touch-target:\s*44px/);
  assert.match(uiThemeCss, /--ac-topbar-height:\s*52px/);
  assert.match(uiThemeCss, /--ac-sidebar-width:\s*240px/);
  assert.match(uiThemeCss, /--ac-sidebar-rail:\s*68px/);
});

test('Wave 1: Motion tokens match DESIGN.md §50', () => {
  assert.match(uiThemeCss, /--motion-press:\s*90ms/);
  assert.match(uiThemeCss, /--motion-hover:\s*140ms/);
  assert.match(uiThemeCss, /--motion-state:\s*190ms/);
  assert.match(uiThemeCss, /--motion-panel:\s*260ms/);
  assert.match(uiThemeCss, /--motion-story:\s*420ms/);
  assert.match(uiThemeCss, /--motion-hero-max:\s*560ms/);
  assert.match(uiThemeCss, /--motion-stagger-tight:\s*28ms/);
  assert.match(uiThemeCss, /--motion-stagger-story:\s*64ms/);
  assert.match(uiThemeCss, /--ease-standard:\s*cubic-bezier\(\s*\.2,\s*\.8,\s*\.2,\s*1\s*\)/);
  assert.match(uiThemeCss, /--ease-emphasized:\s*cubic-bezier\(\s*\.16,\s*1,\s*\.3,\s*1\s*\)/);
  assert.match(uiThemeCss, /--ease-exit:\s*cubic-bezier\(\s*\.4,\s*0,\s*1,\s*1\s*\)/);
});

test('Wave 1: Semantic Z-Index tokens match DESIGN.md §103.2', () => {
  assert.match(uiThemeCss, /--ac-z-base:\s*0/);
  assert.match(uiThemeCss, /--ac-z-sticky:\s*20/);
  assert.match(uiThemeCss, /--ac-z-shell:\s*40/);
  assert.match(uiThemeCss, /--ac-z-popover:\s*60/);
  assert.match(uiThemeCss, /--ac-z-drawer:\s*80/);
  assert.match(uiThemeCss, /--ac-z-modal:\s*100/);
  assert.match(uiThemeCss, /--ac-z-toast:\s*120/);
  assert.match(uiThemeCss, /--ac-z-critical-gate:\s*140/);
});

test('Wave 1: Categorical chart palette matches DESIGN.md §103.1', () => {
  ['--ac-chart-cat-1:\\s*#315F9A', '--ac-chart-cat-2:\\s*#7357A6', '--ac-chart-cat-3:\\s*#94602B',
   '--ac-chart-cat-4:\\s*#2F6F86', '--ac-chart-cat-5:\\s*#8C4F73', '--ac-chart-cat-6:\\s*#536A7C',
   '--ac-chart-cat-1-dark:\\s*#8BB2E8', '--ac-chart-cat-2-dark:\\s*#B9A0E3', '--ac-chart-cat-3-dark:\\s*#DFB277',
   '--ac-chart-cat-4-dark:\\s*#7FB7CF', '--ac-chart-cat-5-dark:\\s*#D995B7', '--ac-chart-cat-6-dark:\\s*#A9BDCF'
  ].forEach(pat => assert.match(uiThemeCss, new RegExp(pat, 'i')));
});

// ---------------------------------------------------------------------------
// 2. Dark Mode Safety & Theme Remapping (§4.2, §103)
// ---------------------------------------------------------------------------
test('Wave 1: Dark theme remapping supports Night Research Mode without broken styles', () => {
  assert.match(uiThemeCss, /html:not\(\.light\),[\s\S]*?\[data-theme="dark"\]/);
  assert.match(uiThemeCss, /\[data-theme="dark"\][\s\S]*?--ac-canvas:\s*#090D16/i);
  assert.match(uiThemeCss, /\[data-theme="dark"\][\s\S]*?--ac-surface:\s*#10151F/i);
  assert.match(uiThemeCss, /\[data-theme="dark"\][\s\S]*?--ac-ink:\s*#F4F6F8/i);
  assert.match(uiThemeCss, /\[data-theme="dark"\][\s\S]*?--ac-positive:\s*#34D399/i);
});

// ---------------------------------------------------------------------------
// 3. Scoped V2 Rollout Mechanism & Component Primitives (§14, §16, §76)
// ---------------------------------------------------------------------------
test('Wave 1: Deterministic scope [data-ac-ui="v2"] owns new primitives', () => {
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]/);
  assert.match(uiThemeCss, /\.ac-ui-v2/);
});

test('Wave 1: Typography roles exist in scoped v2 layer', () => {
  ['.ac-title-page', '.ac-title-section', '.ac-title-component', '.ac-body',
   '.ac-dense-ui', '.ac-table-text', '.ac-meta-evidence', '.ac-meta-auxiliary'].forEach(sel => {
    assert.match(uiThemeCss, new RegExp('\\[data-ac-ui="v2"\\]\\s+' + sel.replace('.', '\\.')));
  });
});

test('Wave 1: Financial numerals enforce tabular-nums and lining-nums', () => {
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-num[\s\S]*?font-variant-numeric:\s*tabular-nums lining-nums/);
  assert.match(spreadsheetGradeCss, /font-variant-numeric:\s*tabular-nums lining-nums/);
  assert.match(numberFlowCss, /font-variant-numeric:\s*tabular-nums lining-nums/);
});

test('Wave 1: Button primitives define canonical variants and visible focus gap', () => {
  ['.ac-btn-primary', '.ac-btn-secondary', '.ac-btn-quiet', '.ac-btn-danger', '.ac-btn-icon'].forEach(variant => {
    assert.match(uiThemeCss, new RegExp(variant.replace('.', '\\.')));
  });
  assert.match(uiThemeCss, /\.ac-btn-primary:focus-visible[\s\S]*?outline-offset:\s*2px/);
});

test('Wave 1: Input and form primitives enforce resting border and accessible focus', () => {
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-input[\s\S]*?border:\s*1px solid var\(--ac-control-border\)/);
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-input:focus-visible[\s\S]*?border-color:\s*var\(--ac-focus\)/);
});

test('Wave 1: Table primitives define sticky header, dense rows, and non-color selected indicator', () => {
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-table-wrap/);
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-table th[\s\S]*?position:\s*sticky/);
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-table tbody tr\.is-selected[\s\S]*?box-shadow:\s*inset 3px 0 0 var\(--ac-brand\)/);
});

test('Wave 1: Surface hierarchy distinguishes bounded and floating elevations', () => {
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-surface-bounded/);
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-surface-floating[\s\S]*?box-shadow:\s*var\(--ac-shadow-level-2\)/);
  assert.match(uiThemeCss, /\[data-ac-ui="v2"\]\s+\.ac-metric-strip/);
});

test('Wave 1: Touch target accommodation reaches 44px on coarse pointers', () => {
  assert.match(uiThemeCss, /@media\s*\(pointer:\s*coarse\)[\s\S]*?min-height:\s*var\(--ac-touch-target,\s*44px\)/);
});

test('Wave 1: Reduced motion safety prevents hidden content at opacity: 0', () => {
  assert.match(uiThemeCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\[data-ac-ui="v2"\][\s\S]*?opacity:\s*1 !important/);
});

test('Wave 1: Invariant protection for viewport.css', () => {
  assert.match(viewportCss, /html\.ac-keyboard-open/);
  assert.match(viewportCss, /max\(16px,1em\)!important/);
});

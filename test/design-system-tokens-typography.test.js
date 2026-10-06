'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const theme = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');

test('PR 3: Monospace font token --ac-font-mono is defined in :root with JetBrains Mono', () => {
  assert.match(theme, /--ac-font-mono:\s*['"]?JetBrains Mono['"]?/);
  assert.match(theme, /--ac-font-sans:\s*['"]?Inter['"]?/);
});

test('PR 3: Google Fonts in index.html loads both Inter and JetBrains Mono', () => {
  assert.match(html, /fonts\.googleapis\.com\/css2\?[^"']*family=Inter[^"']*&family=JetBrains\+Mono/);
});

test('PR 3: Financial typography tabular-nums and mono utilities are present', () => {
  assert.match(theme, /\.ac-font-mono,\s*\.font-mono,\s*\.ac-num/);
  assert.match(theme, /table td\.text-right[\s\S]*?font-family:\s*var\(--ac-font-mono\)/);
  assert.match(theme, /font-variant-numeric:\s*tabular-nums/);
});

test('PR 3: WCAG 2.1 AA contrast tokens and accessible overrides are defined', () => {
  assert.match(theme, /--ac-bull:\s*#34d399/);
  assert.match(theme, /--ac-bear:\s*#f87171/);
  assert.match(theme, /--ac-text-muted:\s*#9[34]a[13]b[58]/);
  assert.match(theme, /\.panel \.text-slate-500/);
  assert.match(theme, /\.badge-bull/);
  assert.match(theme, /\.badge-bear/);
});

test('PR 3: No raw AI-slop generic gradients on card backgrounds in theme layer', () => {
  assert.doesNotMatch(theme, /\.panel\s*\{[^}]*linear-gradient\(135deg,\s*#6366f1/);
});

// ---------------------------------------------------------------------------
// Wave 1 / Wave 1S — Canonical Design System Foundations & V2 Scope Isolation
// ---------------------------------------------------------------------------

test('Wave 1S: Baseline global contract in :root is strictly preserved without collision', () => {
  const rootBlockMatch = theme.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlockMatch, ':root block must exist');
  const rootBlock = rootBlockMatch[1];

  // Baseline radii in :root (legacy Tailwind alignment 6/8/12/16/20px)
  assert.match(rootBlock, /--ac-radius-xs:\s*6px/);
  assert.match(rootBlock, /--ac-radius-sm:\s*8px/);
  assert.match(rootBlock, /--ac-radius-md:\s*12px/);
  assert.match(rootBlock, /--ac-radius-lg:\s*16px/);
  assert.match(rootBlock, /--ac-radius-xl:\s*20px/);

  // Canonical motion and compatibility aliases in :root
  assert.match(rootBlock, /--motion-press:\s*90ms/);
  assert.match(rootBlock, /--motion-hover:\s*140ms/);
  assert.match(rootBlock, /--motion-panel:\s*260ms/);
  assert.match(rootBlock, /--ease-standard:\s*cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\)/);
  assert.match(rootBlock, /--ease-emphasized:\s*cubic-bezier\(\.16,\s*1,\s*\.3,\s*1\)/);
  assert.match(rootBlock, /--motion-instant:\s*var\(--motion-press\)/);
  assert.match(rootBlock, /--motion-fast:\s*var\(--motion-state\)/);
  assert.match(rootBlock, /--motion-base:\s*var\(--motion-panel\)/);
  assert.match(rootBlock, /--motion-slow:\s*var\(--motion-story\)/);
  assert.match(rootBlock, /--motion-stagger:\s*var\(--motion-stagger-story\)/);

  // Baseline surfaces and semantics in :root
  assert.match(rootBlock, /--ac-surface-hover:\s*#19202e/);
  assert.match(rootBlock, /--ac-line-strong:\s*rgba\(148,\s*163,\s*184,\s*0\.22\)/);
  assert.match(rootBlock, /--ac-border:\s*var\(--ac-line\)/);
  assert.match(rootBlock, /--ac-text-muted:\s*#93a1b5/);
  assert.match(rootBlock, /--ac-brand:\s*var\(--ac-accent-strong\)/);
  assert.match(rootBlock, /--ac-info:\s*#60a5fa/);
  assert.match(rootBlock, /--ac-danger:\s*#f87171/);
  assert.match(rootBlock, /--ac-focus-ring:\s*0 0 0 2px rgba\(9,\s*12,\s*18,\s*1\),\s*0 0 0 4px rgba\(52,\s*211,\s*153,\s*0\.62\)/);

  // Canonical tokens must NOT exist in global :root
  assert.doesNotMatch(rootBlock, /--ac-canvas:/);
  assert.doesNotMatch(rootBlock, /--ac-ink:/);
  assert.doesNotMatch(rootBlock, /--ac-positive:/);
  assert.doesNotMatch(rootBlock, /--ac-negative:/);
});

test('Wave 1T: Canonical v2 tokens are scoped strictly under :where([data-ac-ui="v2"], .ac-ui-v2)', () => {
  const v2Match = theme.match(/:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(v2Match, 'Scoped v2 token block must exist');
  const v2Block = v2Match[1];

  // Ground & Surface (§4.1)
  assert.match(v2Block, /--ac-canvas:\s*#F3F5F4/i);
  assert.match(v2Block, /--ac-surface:\s*#FFFFFF/i);
  assert.match(v2Block, /--ac-surface-raised:\s*#F8FAF9/i);
  assert.match(v2Block, /--ac-surface-hover:\s*#EEF2F0/i);

  // Typography / Ink (§4.1)
  assert.match(v2Block, /--ac-ink:\s*#17211E/i);
  assert.match(v2Block, /--ac-text-secondary:\s*#52605B/i);
  assert.match(v2Block, /--ac-text-muted:\s*#5F6C66/i);

  // Lines & Control Borders (§4.1)
  assert.match(v2Block, /--ac-line-hairline:\s*#E2E7E4/i);
  assert.match(v2Block, /--ac-line-default:\s*rgba\(18,\s*35,\s*29,\s*0?\.14\)/i);
  assert.match(v2Block, /--ac-line-strong:\s*rgba\(18,\s*35,\s*29,\s*0?\.20?\)/i);
  assert.match(v2Block, /--ac-control-border:\s*#7D8683/i);
  assert.match(v2Block, /--ac-control-border-hover:\s*#65726C/i);

  // Brand Emerald vs Financial Semantics Separation (§4.1)
  assert.match(v2Block, /--ac-brand:\s*#0F7458/i);
  assert.match(v2Block, /--ac-brand-hover:\s*#0B6049/i);
  assert.match(v2Block, /--ac-brand-soft:\s*#E8F3EE/i);
  assert.match(v2Block, /--ac-focus:\s*#0F7458/i);
  assert.match(v2Block, /--ac-positive:\s*#247A43/i);
  assert.match(v2Block, /--ac-negative:\s*#C13F4D/i);
  assert.match(v2Block, /--ac-warning:\s*#A96D13/i);
  assert.match(v2Block, /--ac-warning-text:\s*#96610F/i);
  assert.match(v2Block, /--ac-info:\s*#315F9A/i);

  const brandMatch = v2Block.match(/--ac-brand:\s*(#[0-9a-fA-F]{6})/i);
  const positiveMatch = v2Block.match(/--ac-positive:\s*(#[0-9a-fA-F]{6})/i);
  assert.ok(brandMatch && positiveMatch);
  assert.notEqual(brandMatch[1].toUpperCase(), positiveMatch[1].toUpperCase(), 'Brand Emerald must NOT equal Financial Positive');

  // Spacing Scale (4px base, §7)
  assert.match(v2Block, /--ac-space-1:\s*4px/);
  assert.match(v2Block, /--ac-space-2:\s*8px/);
  assert.match(v2Block, /--ac-space-3:\s*12px/);
  assert.match(v2Block, /--ac-space-4:\s*16px/);
  assert.match(v2Block, /--ac-space-5:\s*20px/);
  assert.match(v2Block, /--ac-space-6:\s*24px/);
  assert.match(v2Block, /--ac-space-8:\s*32px/);
  assert.match(v2Block, /--ac-space-10:\s*40px/);
  assert.match(v2Block, /--ac-space-12:\s*48px/);
  assert.match(v2Block, /--ac-space-16:\s*64px/);
  assert.match(v2Block, /--ac-space-20:\s*80px/);
  assert.match(v2Block, /--ac-space-24:\s*96px/);
  assert.match(v2Block, /--ac-space-32:\s*128px/);

  // Canonical Radius Scale in v2 scope (§8)
  assert.match(v2Block, /--ac-radius-xs:\s*4px/);
  assert.match(v2Block, /--ac-radius-sm:\s*6px/);
  assert.match(v2Block, /--ac-radius-md:\s*8px/);
  assert.match(v2Block, /--ac-radius-lg:\s*12px/);
  assert.match(v2Block, /--ac-radius-xl:\s*16px/);
  assert.match(v2Block, /--ac-radius-full:\s*999px/);

  // Shared Sizing Tokens (§103.3)
  assert.match(v2Block, /--ac-row-dense:\s*38px/);
  assert.match(v2Block, /--ac-row-comfort:\s*42px/);
  assert.match(v2Block, /--ac-control-sm:\s*36px/);
  assert.match(v2Block, /--ac-control-md:\s*42px/);
  assert.match(v2Block, /--ac-touch-target:\s*44px/);
  assert.match(v2Block, /--ac-topbar-height:\s*52px/);
  assert.match(v2Block, /--ac-sidebar-width:\s*240px/);
  assert.match(v2Block, /--ac-sidebar-rail:\s*68px/);

  // Stacking z-index hierarchy (§9, §103.2)
  assert.match(v2Block, /--ac-z-base:\s*0/);
  assert.match(v2Block, /--ac-z-sticky:\s*20/);
  assert.match(v2Block, /--ac-z-shell:\s*40/);
  assert.match(v2Block, /--ac-z-popover:\s*60/);
  assert.match(v2Block, /--ac-z-drawer:\s*80/);
  assert.match(v2Block, /--ac-z-modal:\s*100/);
  assert.match(v2Block, /--ac-z-toast:\s*120/);
  assert.match(v2Block, /--ac-z-critical-gate:\s*140/);

  // Canonical Motion Tokens (§50 exact names)
  assert.match(v2Block, /--motion-press:\s*90ms/);
  assert.match(v2Block, /--motion-hover:\s*140ms/);
  assert.match(v2Block, /--motion-state:\s*190ms/);
  assert.match(v2Block, /--motion-panel:\s*260ms/);
  assert.match(v2Block, /--motion-story:\s*420ms/);
  assert.match(v2Block, /--motion-hero-max:\s*560ms/);
  assert.match(v2Block, /--motion-stagger-tight:\s*28ms/);
  assert.match(v2Block, /--motion-stagger-story:\s*64ms/);
  assert.match(v2Block, /--ease-standard:\s*cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\)/);
  assert.match(v2Block, /--ease-emphasized:\s*cubic-bezier\(\.16,\s*1,\s*\.3,\s*1\)/);
  assert.match(v2Block, /--ease-exit:\s*cubic-bezier\(\.4,\s*0,\s*1,\s*1\)/);

  // Guard against non-canonical --ac-motion- and --ac-ease- namespaces
  assert.doesNotMatch(v2Block, /--ac-motion-/);
  assert.doesNotMatch(v2Block, /--ac-ease-/);
  assert.doesNotMatch(v2Block, /--ac-motion-hero\b/);
  assert.doesNotMatch(v2Block, /--motion-hero:\s/);
});

test('Wave 1T: Dark mode canonical tokens are scoped under v2 dark selectors', () => {
  assert.match(theme, /html:not\(\.light\)\s+:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)/);
  assert.match(theme, /\[data-theme="dark"\]\s+:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)/);

  const darkV2Match = theme.match(/html:not\(\.light\)\s+:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)[\s\S]*?\{([\s\S]*?)\n\}/);
  assert.ok(darkV2Match, 'Dark v2 block must exist');
  const darkV2Block = darkV2Match[1];

  assert.match(darkV2Block, /--ac-canvas:\s*#090D16/i);
  assert.match(darkV2Block, /--ac-surface:\s*#10151F/i);
  assert.match(darkV2Block, /--ac-ink:\s*#F4F6F8/i);
  assert.match(darkV2Block, /--ac-positive:\s*#34D399/i);
  assert.match(darkV2Block, /--ac-negative:\s*#FB7185/i);
  assert.match(darkV2Block, /--ac-warning:\s*#F59E0B/i);
  assert.match(darkV2Block, /--ac-info:\s*#60A5FA/i);
});

test('Wave 1W: DESIGN.md §103.1 Categorical chart palette defines exact light and dark tokens and mappings', () => {
  // Scoped V2 base block
  const v2Match = theme.match(/:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(v2Match, 'Scoped v2 token block must exist');
  const v2Block = v2Match[1];

  // Light tokens names and values
  assert.match(v2Block, /--ac-chart-cat-1:\s*#315F9A/i);
  assert.match(v2Block, /--ac-chart-cat-2:\s*#7357A6/i);
  assert.match(v2Block, /--ac-chart-cat-3:\s*#94602B/i);
  assert.match(v2Block, /--ac-chart-cat-4:\s*#2F6F86/i);
  assert.match(v2Block, /--ac-chart-cat-5:\s*#8C4F73/i);
  assert.match(v2Block, /--ac-chart-cat-6:\s*#536A7C/i);

  // Canonical -dark tokens names and values in base V2 block
  assert.match(v2Block, /--ac-chart-cat-1-dark:\s*#8BB2E8/i);
  assert.match(v2Block, /--ac-chart-cat-2-dark:\s*#B9A0E3/i);
  assert.match(v2Block, /--ac-chart-cat-3-dark:\s*#DFB277/i);
  assert.match(v2Block, /--ac-chart-cat-4-dark:\s*#7FB7CF/i);
  assert.match(v2Block, /--ac-chart-cat-5-dark:\s*#D995B7/i);
  assert.match(v2Block, /--ac-chart-cat-6-dark:\s*#A9BDCF/i);

  // Dark V2 theme block
  const darkV2Match = theme.match(/html:not\(\.light\)\s+:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)[\s\S]*?\{([\s\S]*?)\n\}/);
  assert.ok(darkV2Match, 'Dark v2 block must exist');
  const darkV2Block = darkV2Match[1];

  // Exact dark token names and values in dark block
  assert.match(darkV2Block, /--ac-chart-cat-1-dark:\s*#8BB2E8/i);
  assert.match(darkV2Block, /--ac-chart-cat-2-dark:\s*#B9A0E3/i);
  assert.match(darkV2Block, /--ac-chart-cat-3-dark:\s*#DFB277/i);
  assert.match(darkV2Block, /--ac-chart-cat-4-dark:\s*#7FB7CF/i);
  assert.match(darkV2Block, /--ac-chart-cat-5-dark:\s*#D995B7/i);
  assert.match(darkV2Block, /--ac-chart-cat-6-dark:\s*#A9BDCF/i);

  // Mappings for dark mode consumers
  assert.match(darkV2Block, /--ac-chart-cat-1:\s*var\(--ac-chart-cat-1-dark\)/);
  assert.match(darkV2Block, /--ac-chart-cat-2:\s*var\(--ac-chart-cat-2-dark\)/);
  assert.match(darkV2Block, /--ac-chart-cat-3:\s*var\(--ac-chart-cat-3-dark\)/);
  assert.match(darkV2Block, /--ac-chart-cat-4:\s*var\(--ac-chart-cat-4-dark\)/);
  assert.match(darkV2Block, /--ac-chart-cat-5:\s*var\(--ac-chart-cat-5-dark\)/);
  assert.match(darkV2Block, /--ac-chart-cat-6:\s*var\(--ac-chart-cat-6-dark\)/);
});

test('Wave 1U: All v2 UI component primitives are strictly scoped under :is([data-ac-ui="v2"], .ac-ui-v2)', () => {
  // Numerics & tabular primitives
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-tabular/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-num-positive/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-num-negative/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-num-warning/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-num-info/);

  // Button primitives
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn\s*\{/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn-primary/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn-secondary/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn-quiet/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn-danger/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn:focus-visible/);
  assert.match(theme, /@media\s*\(pointer:\s*coarse\)[\s\S]*?:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn/);

  // Form field primitives
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-field\s*\{/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-label\s*\{/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-input,\s*:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-select/);
  assert.match(theme, /@media\s*\(max-width:\s*1023px\)[\s\S]*?:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-input/);

  // Table primitives
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-table-container/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-table\s*\{/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-table-dense/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-table-comfort/);

  // Status and badge primitives
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge,\s*:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-status/);

  // Surface and divider primitives
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-surface-card/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-divider/);

  // Negative check: Component primitives must NOT regress to specificity-zero :where scope
  const v2SectionMatch = theme.match(/\/\* ---- 1c\. Scoped V2 Rollout Foundation[\s\S]*?\/\* ---- 2\. Base \+ typography/);
  assert.ok(v2SectionMatch);
  const v2Section = v2SectionMatch[0];
  assert.doesNotMatch(v2Section, /:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn/);
  assert.doesNotMatch(v2Section, /:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-input/);
  assert.doesNotMatch(v2Section, /:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-table/);
  assert.doesNotMatch(v2Section, /:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge/);
  assert.doesNotMatch(v2Section, /:where\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-surface-card/);
});

test('Wave 1U: Transitional legacy button compatibility is supported in V2 scope', () => {
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn\[data-variant="primary"\]/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn\[data-variant="secondary"\]/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn\[data-variant="ghost"\]/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn\[data-variant="danger"\]/);
});

test('Wave 1U: Negative isolation guard verifies no new primitive in Section 1c is bare/global', () => {
  const v2SectionMatch = theme.match(/\/\* ---- 1c\. Scoped V2 Rollout Foundation[\s\S]*?\/\* ---- 2\. Base \+ typography/);
  assert.ok(v2SectionMatch, 'Section 1c foundation must exist');
  const v2Section = v2SectionMatch[0];

  const guardedClasses = [
    'ac-btn',
    'ac-btn-primary',
    'ac-input',
    'ac-select',
    'ac-textarea',
    'ac-table',
    'ac-table-container',
    'ac-badge',
    'ac-status',
    'ac-surface-card'
  ];

  const cleanSection = v2Section.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleMatches = cleanSection.match(/([^{}]+)\{/g) || [];
  let guardedRuleCount = 0;
  for (const match of ruleMatches) {
    const selectorBlock = match.replace(/\{$/, '').trim();
    if (!selectorBlock || selectorBlock.startsWith('@media')) continue;
    // Split on commas that are not nested within parentheses or brackets
    const selectors = [];
    let cur = '';
    let depth = 0;
    for (let i = 0; i < selectorBlock.length; i++) {
      const ch = selectorBlock[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        selectors.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur) selectors.push(cur);

    for (const sel of selectors) {
      const trimmed = sel.trim();
      for (const cls of guardedClasses) {
        if (new RegExp(`\\.${cls}\\b`).test(trimmed)) {
          guardedRuleCount++;
          assert.ok(
            trimmed.includes(':is([data-ac-ui="v2"], .ac-ui-v2)'),
            `Selector "${trimmed}" in Section 1c containing .${cls} must be scoped under :is([data-ac-ui="v2"], .ac-ui-v2)`
          );
        }
      }
    }
  }
  assert.ok(guardedRuleCount >= 15, `Expected multiple guarded selectors in Section 1c, found ${guardedRuleCount}`);
});

test('Wave 1U: V2 primitives consume canonical motion tokens and avoid --ac-motion-*', () => {
  const v2SectionMatch = theme.match(/\/\* ---- 1c\. Scoped V2 Rollout Foundation[\s\S]*?\/\* ---- 2\. Base \+ typography/);
  assert.ok(v2SectionMatch);
  const v2Section = v2SectionMatch[0];

  // No obsolete aliases consumed
  assert.doesNotMatch(v2Section, /var\(--ac-motion-/);
  assert.doesNotMatch(v2Section, /var\(--ac-ease-/);

  // Exact canonical tokens consumed
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn[\s\S]*?var\(--motion-hover/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn[\s\S]*?var\(--motion-press/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn[\s\S]*?var\(--ease-standard/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-input[\s\S]*?var\(--motion-hover/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-table tbody tr[\s\S]*?var\(--motion-hover/);
});

test('Wave 1U: Semantic badge borders adaptively derive from semantic tokens via color-mix', () => {
  // Theme-adaptive borders derived from semantic variables
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-positive[\s\S]*?border-color:\s*color-mix\(in srgb,\s*var\(--ac-positive\)\s*25%,\s*transparent\)/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-negative[\s\S]*?border-color:\s*color-mix\(in srgb,\s*var\(--ac-negative\)\s*25%,\s*transparent\)/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-warning[\s\S]*?border-color:\s*color-mix\(in srgb,\s*var\(--ac-warning\)\s*25%,\s*transparent\)/);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-info[\s\S]*?border-color:\s*color-mix\(in srgb,\s*var\(--ac-info\)\s*25%,\s*transparent\)/);

  // Neutral badge retains canonical line token
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-neutral[\s\S]*?border-color:\s*var\(--ac-line-default\)/);

  // Ensure no hardcoded light-palette RGB values on V2 badges
  assert.doesNotMatch(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-positive[\s\S]*?rgba\(36,\s*122,\s*67/);
  assert.doesNotMatch(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-badge-negative[\s\S]*?rgba\(193,\s*63,\s*77/);
});

test('Wave 1U: Danger button hover avoids raw hardcoded hex in favor of color-mix', () => {
  assert.doesNotMatch(theme, /\.ac-btn-danger:hover[^{]*\{[^}]*#A93340/i);
  assert.match(theme, /:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn-danger:hover[\s\S]*?color-mix\(/);
});

test('Wave 1U: Reduced motion query scopes v2 primitives properly', () => {
  assert.match(theme, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-btn/);
  assert.match(theme, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?:is\(\[data-ac-ui="v2"\],\s*\.ac-ui-v2\)\s+\.ac-input/);
});

test('Wave 2: index.html scopes v2 marker to shell elements without contaminating unmigrated body', () => {
  assert.match(html, /data-ac-ui="v2"/);
  assert.doesNotMatch(html, /<body[^>]*data-ac-ui="v2"/);
  assert.doesNotMatch(html, /<html[^>]*data-ac-ui="v2"/);
});

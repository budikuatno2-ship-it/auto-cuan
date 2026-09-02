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

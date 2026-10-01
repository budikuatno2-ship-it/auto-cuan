'use strict';

// Regression coverage for the Ranking Pasar Harian scroll-ownership bug
// (nested #rankingTableWrap trapping mouse wheel/touchpad/page scrolling —
// the same category of bug fixed for Analisis Saham in PR #359).
//
// This repo has no DOM engine in its test toolchain, so — matching the
// existing house pattern in test/ui-bugfix-pack-v1.test.js — these tests
// assert directly against the shipped source text rather than rendering
// the page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const stockAnalysisAiJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-analysis-ai.js'), 'utf8');

function extractFunctionBody(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'expected to find function ' + name);
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i);
    }
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

test('rankingTableWrap markup has no vertical overflow clamp in its base markup', () => {
  const match = indexHtml.match(/<div id="rankingTableWrap" class="([^"]*)">/);
  assert.ok(match, 'expected to find #rankingTableWrap in public/index.html');
  const classes = match[1];

  // Horizontal overflow (for narrow viewports with many columns) is fine and expected.
  assert.match(classes, /\boverflow-x-auto\b/);

  // Anything that establishes a bounded, independently-scrolling vertical region
  // re-introduces the nested-scroll trap and must not come back.
  assert.doesNotMatch(classes, /\boverflow-auto\b/);
  assert.doesNotMatch(classes, /\boverflow-y-auto\b/);
  assert.doesNotMatch(classes, /\bmax-h-/);
  assert.doesNotMatch(classes, /\bh-screen\b/);
});

test('mountRankingCardOnOwnPage never re-imposes a vertical max-height on the table wrap', () => {
  const body = extractFunctionBody(stockAnalysisAiJs, 'mountRankingCardOnOwnPage');

  // The wrap must stay free to grow to its natural (full 771-row) height so the
  // document remains the single vertical scroll owner. A fixed/calculated
  // maxHeight here is exactly what caused the inner scrollbar trap.
  assert.doesNotMatch(body, /tableWrap\.style\.maxHeight/);
  assert.doesNotMatch(body, /tableWrap\.style\.overflowY/);
  assert.doesNotMatch(body, /tableWrap\.style\.overflow\s*=/);
});

test('the dedicated ranking page shell has no fixed-height / vertical-overflow classes', () => {
  const body = extractFunctionBody(stockAnalysisAiJs, 'ensureRankingPageShell');
  assert.doesNotMatch(body, /overflow-y-auto/);
  assert.doesNotMatch(body, /overflow-hidden/);
  assert.doesNotMatch(body, /\bh-screen\b/);
  assert.doesNotMatch(body, /max-h-\[/);
});

test('document/body containers stay unclipped so the page can be the scroll owner', () => {
  // #dashboardScreen (ancestor of #page-ranking) must never gain an overflow
  // that would stop it from growing to fit the full ranking table.
  assert.doesNotMatch(indexHtml, /#dashboardScreen\s*\{[^}]*overflow:\s*hidden/);
  const bodyRuleMatch = indexHtml.match(/\bbody\s*\{([^}]*)\}/);
  if (bodyRuleMatch) {
    assert.doesNotMatch(bodyRuleMatch[1], /overflow-y:\s*hidden/);
    assert.doesNotMatch(bodyRuleMatch[1], /overflow:\s*hidden(?!\s*;?\s*$)/);
  }
});

test('the horizontal-only wrap gets overscroll containment so it cannot hijack page scroll', () => {
  // ui-theme.css scopes `.overflow-x-auto { overscroll-behavior: contain }` to stop a
  // horizontal-scroll table from rubber-banding/back-navigating the whole document —
  // #rankingTableWrap must keep using that exact utility class to inherit it.
  const themeCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui-theme.css'), 'utf8');
  assert.match(themeCss, /\.overflow-x-auto[^{]*\{[^}]*overscroll-behavior:\s*contain/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const coreCss = read('public/premium-workstation-core.css');
const spreadsheetCss = read('public/spreadsheet-grade.css');
const portfolioCss = read('public/portfolio-command-center.css');
const indexHtml = read('public/index.html');
const moneyRuntime = read('public/money-management-runtime.js');
const portfolioRuntime = read('public/portfolio-command-center.js');

// Dark-only policy: the product ships ONE theme. The semantic tokens still
// exist (components must consume roles, not hardcoded colours) but there is no
// light counterpart any more — the old html.light blocks were removed.
test('semantic dark tokens keep canvas, surface, text, and borders paired', () => {
  assert.match(coreCss, /:root\s*\{[\s\S]*--bg-canvas:\s*#090d16;/);
  assert.match(coreCss, /:root\s*\{[\s\S]*--bg-surface:\s*#0d1320;/);
  assert.match(coreCss, /:root\s*\{[\s\S]*--text-primary:\s*#f4f7fb;/);
  assert.match(coreCss, /:root\s*\{[\s\S]*--border-subtle:\s*rgba\(148,\s*163,\s*184,\s*\.12\);/);
});

test('the theme is dark-only: no light-mode override survives any sheet', () => {
  for (const [name, css] of [['premium-workstation-core.css', coreCss],
    ['spreadsheet-grade.css', spreadsheetCss],
    ['portfolio-command-center.css', portfolioCss]]) {
    assert.doesNotMatch(css, /html\.light/, name + ' must not declare light-mode overrides');
    assert.doesNotMatch(css, /\[data-theme="light"\]/, name + ' must not declare a light theme attribute block');
  }
});

test('dashboard greeting consumes semantic foreground instead of a fixed dark-theme color', () => {
  assert.match(coreCss, /#dashGreeting\s*\{[\s\S]*color:\s*var\(--text-primary\)\s*!important;/);
  assert.doesNotMatch(coreCss, /#dashGreeting\s*\{[\s\S]{0,180}color:\s*#f6f9fb\s*!important;/);
});

test('money-management and dashboard holdings use the compact spreadsheet contract', () => {
  assert.match(spreadsheetCss, /#mmCashflowSpreadsheetTable,[\s\S]*#mmJournalSpreadsheetTable,[\s\S]*#portTableWrap\s*>\s*table\s*\{[\s\S]*border-collapse:\s*separate;/);
  assert.match(spreadsheetCss, /#mmCashflowSpreadsheetTable thead th,[\s\S]*height:\s*34px;/);
  assert.match(spreadsheetCss, /#mmCashflowSpreadsheetTable tbody td,[\s\S]*height:\s*36px;/);
  assert.match(spreadsheetCss, /font-variant-numeric:\s*tabular-nums lining-nums;/);
  assert.match(spreadsheetCss, /border-bottom:\s*1px solid var\(--border-subtle\);/);
});

test('standalone portfolio holdings use neutral compact table chrome', () => {
  assert.match(portfolioCss, /#watchTable table\s*\{[\s\S]*border-collapse:\s*separate;/);
  assert.match(portfolioCss, /#watchTable thead th\s*\{[\s\S]*height:\s*34px;/);
  assert.match(portfolioCss, /#watchTable tbody td\s*\{[\s\S]*height:\s*36px;/);
  assert.match(portfolioCss, /#watchTable \.pill\s*\{[\s\S]*min-height:\s*20px;/);
});

test('financial runtime IDs, calculations, and render entry points remain intact', () => {
  for (const id of ['mmCashflowSpreadsheetTable', 'mmCashflowSpreadsheetBody', 'mmJournalSpreadsheetTable', 'mmJournalTableBody', 'portTableWrap', 'portTableBody']) {
    assert.match(indexHtml, new RegExp('id="' + id + '"'));
  }
  for (const fn of ['recalculateCashflow', 'renderCashflowSpreadsheetRows', 'renderJournalTable']) {
    assert.match(moneyRuntime, new RegExp('function\\s+' + fn + '|window\\.' + fn + '\\s*='));
  }
  assert.match(portfolioRuntime, /function\s+renderWatch\s*\(/);
  assert.match(portfolioRuntime, /\$\('watchBody'\)\.innerHTML/);
});

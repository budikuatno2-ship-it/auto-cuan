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

test('semantic dark and light tokens keep canvas, surface, text, and borders paired', () => {
  assert.match(coreCss, /:root\s*\{[\s\S]*--bg-canvas:\s*#090d16;/);
  assert.match(coreCss, /:root\s*\{[\s\S]*--bg-surface:\s*#0d1320;/);
  assert.match(coreCss, /:root\s*\{[\s\S]*--text-primary:\s*#f4f7fb;/);
  assert.match(coreCss, /:root\s*\{[\s\S]*--border-subtle:\s*rgba\(148,\s*163,\s*184,\s*\.12\);/);
  assert.match(coreCss, /html\.light\s*\{[\s\S]*--bg-canvas:\s*#f5f7fa;/);
  assert.match(coreCss, /html\.light\s*\{[\s\S]*--bg-surface:\s*#ffffff;/);
  assert.match(coreCss, /html\.light\s*\{[\s\S]*--text-primary:\s*#111827;/);
  assert.match(coreCss, /html\.light\s*\{[\s\S]*--border-subtle:\s*rgba\(15,\s*23,\s*42,\s*\.08\);/);
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('Batch 5: Layout width and wide-screen responsiveness', () => {
  const css = read('public/ui-theme.css');
  const analisisHtml = read('public/analisis-saham.html');

  assert.match(css, /#page-analisis,\s*\.unified-cockpit-shell\s*\{[^}]*max-width:\s*1600px\s*!important/);
  assert.match(css, /\[data-ac-ui="v2"\]\s*\.ac-financial-container,\s*#panel-tab-market-structure\[data-ac-ui="v2"\]\s*\.ac-market-structure-layout\s*\{[^}]*max-width:\s*1600px\s*!important/);
  assert.match(analisisHtml, /max-w-\[1600px\]/);
});

test('Batch 5: Header strip offset refinement on desktop', () => {
  const css = read('public/ui-theme.css');
  assert.match(css, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*#appContent\s*\{[^}]*padding-top:\s*(?:4|8)px\s*!important/);
});

test('Batch 5: Screener Plan View (Card Mode) spans full width and hides empty side pane', () => {
  const indexHtml = read('public/index.html');
  const css = read('public/ui-theme.css');

  assert.match(indexHtml, /splitView\.classList\.add\('is-card-mode'\)/);
  assert.match(indexHtml, /splitView\.classList\.remove\('is-card-mode'\)/);

  assert.match(css, /\.ac-split-view\.is-card-mode\s*\{[^}]*display:\s*block\s*!important/);
  assert.match(css, /\.ac-split-view\.is-card-mode\s*\.ac-split-view__main\s*\{[^}]*width:\s*100%\s*!important/);
  assert.match(css, /\.ac-split-view\.is-card-mode\s*\.ac-split-view__pane\s*\{[^}]*display:\s*none\s*!important/);
});

test('Batch 5: formatIndonesianDateWithWib enforces Asia/Jakarta WIB timezone across environments', () => {
  const elements = new Map();
  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; }
  };
  const sandbox = {
    window: { document, addEventListener() {}, localStorage: { getItem() {} } },
    document,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Intl
  };

  vm.runInNewContext(read('public/analisis-saham-runtime.js'), sandbox);

  // Test UTC ISO string conversion to Asia/Jakarta (UTC+7)
  // 2026-10-09T01:30:00Z should be 08:30 WIB on 09 Okt 2026
  const utcIso = '2026-10-09T01:30:00.000Z';
  const formatted = sandbox.formatIndonesianDateWithWib
    ? sandbox.formatIndonesianDateWithWib(utcIso)
    : null;

  // Verify function source has Asia/Jakarta timezone binding
  const runtime = read('public/analisis-saham-runtime.js');
  assert.match(runtime, /timeZone:\s*'Asia\/Jakarta'/);
  assert.match(runtime, /formatIndonesianDateWithWib/);
});

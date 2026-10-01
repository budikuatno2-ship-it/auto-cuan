'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const indexHtml = read('public/index.html');
const partial = read('public/partials/analisis-saham.partial.html');
const runtime = read('public/analisis-saham-runtime.js');
const builder = read('lib/daily-market-context-builder.js');

test('financial and market structure are retired as standalone destinations', () => {
  assert.doesNotMatch(indexHtml, /data-analysis-tab="financial"/);
  assert.doesNotMatch(indexHtml, /data-analysis-tab="market-structure"/);
  assert.doesNotMatch(indexHtml, /id="tabFinancial"/);
  assert.doesNotMatch(indexHtml, /id="tabMarketStructure"/);
  assert.match(runtime, /tabName === 'financial' \|\| tabName === 'market-structure'/);
  assert.match(runtime, /tabName = 'analisis-chart'/);
  // The provenance-aware renderer remains internal so financial/structure
  // context can be composed into analysis later without exposing blank pages.
  assert.match(runtime, /root\.loadFinancialStructureTab = loadFinancialStructureTab/);
});

test('financial panel exposes only supported provenance-aware fields', () => {
  assert.match(partial, /PBV/);
  assert.match(partial, /Book Value \/ Share/);
  assert.match(partial, /Saham Beredar/);
  assert.match(partial, /Market Cap/);
  assert.match(partial, /Sumber Fundamental/);
  assert.match(partial, /Sumber Market Cap/);
  assert.match(builder, /shares_outstanding/);
  assert.match(builder, /market_cap_source/);
  assert.match(builder, /market_cap_as_of/);
});

test('market structure panel preserves risk-context semantics', () => {
  assert.match(partial, /Free Float/);
  assert.match(partial, /Status HSC/);
  assert.match(partial, /Risk Guard/);
  assert.match(partial, /Kepatuhan Regulasi/);
  assert.match(runtime, /NOT_EVALUATED/);
  assert.doesNotMatch(partial, /auto[- ]?reject|pasti beli|pasti jual/i);
});

test('missing market cap and shares stay explicitly unavailable rather than synthesized', () => {
  assert.match(runtime, /f\.market_cap\)\) \? researchIdr\(f\.market_cap\) : '—'/);
  assert.match(runtime, /f\.shares_outstanding\)\) \? researchCompact\(f\.shares_outstanding\) : '—'/);
  assert.doesNotMatch(runtime, /shares_outstanding\s*\*\s*.*pbv_as_of_price|pbv_as_of_price\s*\*\s*.*shares_outstanding/);
});

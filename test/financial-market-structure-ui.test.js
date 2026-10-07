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

test('financial and market structure are first-class research destinations', () => {
  assert.match(indexHtml, /data-analysis-tab="financial"/);
  assert.match(indexHtml, /data-analysis-tab="market-structure"/);
  assert.match(partial, /id="panel-tab-financial"/);
  assert.match(partial, /id="panel-tab-market-structure"/);
  assert.match(runtime, /'financial', 'market-structure'/);
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
  assert.match(runtime, /researchHasNumber\(f\.market_cap\) \? researchIdr\(f\.market_cap\) : '—'/);
  assert.match(runtime, /researchHasNumber\(f\.shares_outstanding\) \? researchCompact\(f\.shares_outstanding\) : '—'/);
  assert.doesNotMatch(runtime, /shares_outstanding\s*\*\s*.*pbv_as_of_price|pbv_as_of_price\s*\*\s*.*shares_outstanding/);
});

test('market structure runtime consumes canonical data / rows and does not depend on items', () => {
  assert.match(runtime, /payload\.data/);
  assert.match(runtime, /payload\.rows/);
  assert.doesNotMatch(runtime, /payload\.items/);
});

test('raw enum codes are not emitted as user labels in markup or runtime detail mappings', () => {
  assert.doesNotMatch(partial, />\s*(NOT_EVALUATED|DATA_INCOMPLETE|UNKNOWN)\s*</);
  assert.match(runtime, /'NOT_EVALUATED': 'Tidak dievaluasi'/);
  assert.match(runtime, /'DATA_INCOMPLETE': 'Data belum lengkap'/);
  assert.match(runtime, /'UNKNOWN': 'Belum diketahui'/);
});

test('financial panel is quiet and verified without canvas, orbit, or giant hero grammar', () => {
  assert.doesNotMatch(partial, /Financial Canvas/i);
  assert.doesNotMatch(partial, /orbit|ac-financial-focus-card/i);
});

test('frontend low free float reference matches backend authoritative constant', () => {
  const riskLib = read('lib/market-structure-risk.js');
  const match = riskLib.match(/LOW_FREE_FLOAT_REFERENCE_PCT\s*=\s*(\d+)/);
  assert.ok(match, 'backend must export LOW_FREE_FLOAT_REFERENCE_PCT');
  const backendVal = Number(match[1]);
  assert.match(runtime, /MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT\s*=\s*(\d+)/);
  const feMatch = runtime.match(/MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT\s*=\s*(\d+)/);
  assert.equal(Number(feMatch[1]), backendVal);
});

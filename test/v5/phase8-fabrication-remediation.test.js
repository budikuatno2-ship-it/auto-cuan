'use strict';

/**
 * test/v5/phase8-fabrication-remediation.test.js
 * ============================================================================
 * PHASE 8 — negative control for foreign-flow & sector-hot fabrication
 * removals (in-scope F4 surfaces).
 *
 * In-scope assertions:
 *   (a) scripts/foreign-compile.js no longer hardcodes a broker set, no longer
 *       derives 7d as `5d * 1.4`, and the headline is no longer a partial
 *       fBuyTotal - fSellTotal gross spread.
 *   (b) lib/sector-radar.js no longer emits `volume_ratio_30d: 1.45`,
 *       `avg_volume_ratio: 1.65`, or a fallback quote `{price:1000,
 *       change_pct: 1.5, volume: 5000000}`.
 *
 * The `bandarmologi-service.js` 100x value-rewrite is recorded as a RESIDUAL
 * (pre-existing) divergence in the F4 report, NOT asserted here since it is
 * outside the 6 diverged items listed in the F0 audit.
 * Run: node test/v5/phase8-fabrication-remediation.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('P8 (a) foreign-compile: hardcoded broker table removed', () => {
  const src = read('scripts/foreign-compile.js');
  assert.equal(/MAJOR_STOCK_FOREIGN_BROKERS\s*=/.test(src), false, 'MAJOR_STOCK_FOREIGN_BROKERS assignment removed');
});

test('P8 (a) foreign-compile: 7d no longer derived via x1.4 multiplier', () => {
  const src = read('scripts/foreign-compile.js');
  assert.equal(/net5op\.value \* 1\.4/.test(src), false, 'x1.4 7d derivation removed');
  assert.ok(src.indexOf('foreign_net_7d: null') !== -1, 'honest 7d null fallback missing');
  assert.ok(src.indexOf("foreign_net_7d_status: 'NOT_PUBLISHED'") !== -1, 'honest 7d status missing');
});

test('P8 (a) foreign-compile: headline net no longer a partial gross spread', () => {
  const src = read('scripts/foreign-compile.js');
  assert.equal(/const netForeignVal = fBuyTotal - fSellTotal/.test(src), false, 'partial gross spread headline removed');
});

test('P8 (b) sector-radar: fabricated volume ratios and quote fallback removed', () => {
  const src = read('lib/sector-radar.js');
  assert.equal(/volume_ratio_30d:\s*1\.45/.test(src), false, 'volume_ratio_30d 1.45 removed');
  assert.equal(/avgVolRatio\s*=\s*1\.65/.test(src), false, 'avg_volume_ratio 1.65 removed');
  assert.equal(/price:\s*1000/.test(src), false, 'fallback price 1000 removed');
  assert.equal(/change_pct:\s*1\.5/.test(src), false, 'fallback change_pct 1.5 removed');
  assert.ok(src.indexOf('return { price: unknown(), change_pct: unknown(), volume: unknown(), data_status: DATA_STATUS.NOT_PUBLISHED };') !== -1,
    'honest null + NOT_PUBLISHED fallback missing');
});
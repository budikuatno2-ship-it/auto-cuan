'use strict';

// Batch 9 regression tests — removal of fabricated numbers in the
// bandarmologi / publisher cluster (F-002, F-066, F-067, F-070, F-071).
// Runtime assertions where the function accepts injectable data; static
// source assertions (comments stripped) where the path needs disk fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readCode = (rel) => read(rel).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const publisher = require('../lib/intraday-fast-watcher-publisher');
const intelService = require('../lib/bandarmologi-intel-service');
const bandarmologiService = require('../lib/bandarmologi-service');

// ---------------------------------------------------------------------------
// F-066: buildDbRow must never fabricate daytrade_score (no default 70, no
// clamp floor 50). Missing score -> key absent (NULL in DB); low real score
// passes through unclamped.
// ---------------------------------------------------------------------------
test('F-066: buildDbRow omits daytrade_score when no real score exists', () => {
  const row = publisher.buildDbRow({ ticker: 'TEST', observation: {} }, '2026-09-18', '10:00');
  assert.ok(!('daytrade_score' in row), 'missing score must not materialize as a fabricated number');
});

test('F-066: buildDbRow does not clamp a real low score up to 50', () => {
  const row = publisher.buildDbRow({ ticker: 'TEST', publish_score: 32, observation: {} }, '2026-09-18', '10:00');
  assert.equal(row.daytrade_score, 32, 'real score 32 must not be forced to 50');
});

test('F-066: buildDbRow keeps a real high score (capped at 100 only)', () => {
  const row = publisher.buildDbRow({ ticker: 'TEST', publish_score: 140, observation: {} }, '2026-09-18', '10:00');
  assert.equal(row.daytrade_score, 100);
});

test('F-066: publisher source contains no fabricated score fallback', () => {
  const code = readCode('lib/intraday-fast-watcher-publisher.js');
  assert.ok(!/Math\.max\(\s*50\s*,/.test(code), 'clamp floor Math.max(50,...) must be gone');
  assert.ok(!/\?\?\s*70\)?/.test(code), 'default ?? 70 must be gone');
});

// ---------------------------------------------------------------------------
// F-002: enrichConfluenceRows must forward the row's real category to
// deriveConfidenceTier, not the hardcoded string 'Swing'.
// ---------------------------------------------------------------------------
test('F-002: enrichConfluenceRows passes r.category (not literal Swing) to deriveConfidenceTier', () => {
  const src = read('api/sector-hot.js');
  const idx = src.indexOf('confAfterForeign = deriveConfidenceTier(');
  assert.ok(idx >= 0, 'call site must exist');
  const call = src.slice(idx, idx + 120);
  assert.ok(!call.includes("'Swing'"), 'hardcoded Swing category must be gone');
  assert.ok(call.includes('r.category'), 'real row category must be forwarded');
});

// ---------------------------------------------------------------------------
// F-070: CR denominator must never be fabricated. When neither value turnover
// nor volume data exists, cr3/cr5 are null with reason TURNOVER_UNAVAILABLE.
// ---------------------------------------------------------------------------
test('F-070: computeConcentrationRatios returns null CR + TURNOVER_UNAVAILABLE when no denominator exists', () => {
  // 5 brokers, values only (no volume) -> allBroker sum == top5Val, no
  // total_turnover, no OHLCV cache for a fake ticker.
  const buyers = [5, 4, 3, 2, 1].map((i) => ({ broker: `B${i}`, bval: 100 * i }));
  const result = intelService.computeConcentrationRatios('ZZZ_NO_SUCH_TICKER', {
    brokerSummary: { gross_buyers: buyers, top_buyers: buyers }
  });
  assert.equal(result.cr3, null, 'cr3 must be null, not scaled by a fabricated denominator');
  assert.equal(result.cr5, null, 'cr5 must be null, not the constant 57.14');
  assert.equal(result.reason, 'TURNOVER_UNAVAILABLE');
  assert.equal(result.triggered, false);
});

test('F-070: computeConcentrationRatios computes real value-based CR when turnover is present', () => {
  const buyers = [5, 4, 3, 2, 1].map((i) => ({ broker: `B${i}`, bval: 100 * i }));
  const result = intelService.computeConcentrationRatios('ZZZ_NO_SUCH_TICKER', {
    brokerSummary: { gross_buyers: buyers, top_buyers: buyers, total_turnover: 3000 }
  });
  assert.equal(result.cr5, 50, 'top5 = 1500 / 3000 = 50%');
  assert.equal(result.cr3, 40, 'top3 = 1200 / 3000 = 40%');
  assert.equal(result.reason, undefined);
  assert.equal(result.cr_basis, 'VALUE');
});

test('F-070: volume-based CR fallback still works on real volume data', () => {
  const buyers = [5, 4, 3, 2, 1].map((i) => ({ broker: `B${i}`, bval: 100 * i, bvol: 10 * i }));
  const result = intelService.computeConcentrationRatios('ZZZ_NO_SUCH_TICKER', {
    brokerSummary: { gross_buyers: buyers, top_buyers: buyers }
  });
  assert.equal(result.cr_basis, 'VOLUME');
  assert.ok(result.cr5 != null, 'volume CR is real data and must be computed');
});

test('F-070: intel service source contains no fabricated CR denominator', () => {
  const code = readCode('lib/bandarmologi-intel-service.js');
  assert.ok(!/top5Val\s*\*\s*1\.75/.test(code), 'fabricated denominator must be gone');
});

// ---------------------------------------------------------------------------
// F-067: accumulation_score must come from real metrics or be null — never
// the sign-only constants 70/30 or the fallback 75.
// ---------------------------------------------------------------------------
test('F-067: synthesizeAccumulationFromSummary computes score from real metrics', () => {
  const summary = {
    date: '2026-09-18',
    net_flow: 500,
    top_buyers: [{ broker: 'BB', bval: 1000, sval: 100 }],
    top_sellers: [{ broker: 'SS', sval: 500, bval: 50 }]
  };
  const out = bandarmologiService.synthesizeAccumulationFromSummary(summary, 'TEST');
  assert.notEqual(out.accumulation_score, 70, 'sign-only constant 70 must be gone');
  assert.notEqual(out.accumulation_score, 30, 'sign-only constant 30 must be gone');
  assert.ok(typeof out.accumulation_score === 'number', 'score must be computed from real metrics');
  assert.ok(out.accumulation_score > 50, 'positive net flow must score above neutral');
});

test('F-067: synthesizeAccumulationFromSummary returns null score when data insufficient', () => {
  const out = bandarmologiService.synthesizeAccumulationFromSummary(
    { date: '2026-09-18', net_flow: 0, top_buyers: [], top_sellers: [] }, 'TEST');
  assert.equal(out.accumulation_score, null, 'no gross value + no series -> null, not a constant');
});

test('F-067: normalizeBrokerAccumulation no longer falls back to constant 75', () => {
  const out = bandarmologiService.normalizeBrokerAccumulation({ code: 'TEST', series: [] }, 'TEST');
  assert.notEqual(out.accumulation_score, 75, 'fallback constant 75 must be gone');
  assert.equal(out.accumulation_score, null);
});

// ---------------------------------------------------------------------------
// F-071: hunter fallback must never claim a daily "Silent Foreign
// Accumulation" streak from aggregate range data.
// ---------------------------------------------------------------------------
test('F-071: hunter fallback returns triggered:false with DAILY_SERIES_UNAVAILABLE', () => {
  const code = readCode('lib/bandarmologi-intel-service.js');
  assert.ok(code.includes("reason: 'DAILY_SERIES_UNAVAILABLE'"), 'explicit reason must be present');
  assert.ok(!/price_change_pct:\s*0\.8/.test(code), 'fabricated price_change_pct 0.8 must be gone');
  assert.ok(!/is_sideways:\s*true/.test(code), 'fabricated is_sideways:true must be gone');
  assert.ok(!/totalForeignNet\s*\/\s*days/.test(code), 'evenly-divided daily_breakdown fabrication must be gone');
});

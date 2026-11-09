'use strict';

/**
 * test/v5/volume-unit.test.js
 * ============================================================================
 * UNIT TESTS — volume unit matrix and foreign-flow missing-vs-zero.
 * Adapted to workspace seams: `lib/market-data-contract.js` is the canonical
 * implementation; `public/chart-workstation.js` provides the browser-side
 * foreign-flow / volume formatters exported from the workspace bundle.
 * Run: node test/v5/volume-unit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'market-data-contract.js'));
const W = require(path.join(ROOT, 'public', 'chart-workstation.js'));

test('sharesToLots / lotsToShares divide and multiply by exactly 100', () => {
  assert.equal(C.sharesToLots(100), 1);
  assert.equal(C.sharesToLots(269099800), 2690998);
  assert.equal(C.lotsToShares(1), 100);
  assert.equal(C.lotsToShares(2690998), 269099800);
  assert.equal(C.sharesToLots(null), null, 'absence stays absence, never 0');
  assert.equal(C.lotsToShares(null), null);
});

test('volume matrix: shares -> lembar label, never lot', () => {
  assert.equal(C.formatVolume(0), '0 lembar', 'a measured zero is a real zero');
  assert.equal(C.formatVolume(500), '500 lembar');
  assert.equal(C.formatVolume(17608500), '17,61 Jt lembar');
  assert.equal(C.formatVolume(1760850000), '1,76 Mrd lembar');
  assert.equal(C.formatVolume(null), '\u2014', 'absence is the em dash');
  assert.equal(C.formatVolume(''), '\u2014');
  assert.equal(C.formatVolume(NaN), '\u2014');
});

test('volume matrix: lots label follows the lot unit the caller declared', () => {
  const desc = C.describeVolume(10, { unit: 'LOTS' });
  assert.equal(desc.display, '10 lot');
  assert.equal(desc.unit, 'LOTS');
  assert.equal(desc.unitLabel, 'lot');
  assert.equal(desc.shareCount, 1000, 'lot x100 share equivalence is exposed');
});

test('volume matrix: UNKNOWN unit renders an explicit marker, never a confident label', () => {
  const desc = C.describeVolume(17608500, { unit: 'UNKNOWN' });
  assert.equal(desc.display, '17,61 Jt (satuan tidak diketahui)');
  assert.equal(desc.unitLabel, null);
  assert.equal(desc.dataStatus, 'PARTIAL');
});

test('volume matrix: a lot count is never silently labelled lembar and vice versa', () => {
  assert.equal(C.describeVolume(100, { unit: 'LOTS' }).display, '100 lot');
  assert.notEqual(C.describeVolume(100, { unit: 'LOTS' }).display, '100 lembar');
  assert.equal(C.describeVolume(100, { unit: 'SHARES' }).display, '100 lembar');
});

test('normalizeVolumeUnit maps synonyms and defaults to SHARES', () => {
  assert.equal(C.normalizeVolumeUnit(undefined), 'SHARES');
  assert.equal(C.normalizeVolumeUnit(null), 'SHARES');
  assert.equal(C.normalizeVolumeUnit('lembar'), 'SHARES');
  assert.equal(C.normalizeVolumeUnit('share'), 'SHARES');
  assert.equal(C.normalizeVolumeUnit('lot'), 'LOTS');
  assert.equal(C.normalizeVolumeUnit('LOTS'), 'LOTS');
  assert.equal(C.normalizeVolumeUnit(''), 'UNKNOWN');
  assert.equal(C.normalizeVolumeUnit('bananas'), 'UNKNOWN');
});

test('foreign flow: missing renders the em dash with a NOT_PUBLISHED status', () => {
  const miss = C.describeForeignFlow(null);
  assert.equal(miss.display, '\u2014');
  assert.equal(miss.isKnown, false);
  assert.equal(miss.dataStatus, 'NOT_PUBLISHED');
});

test('an unbacked bare zero is NOT claimed as a measured Rp 0', () => {
  const bare = C.describeForeignFlow(0);
  assert.equal(bare.display, '\u2014');
  assert.equal(bare.isKnown, false);
});

test('a genuinely measured zero renders Rp 0 with an AVAILABLE status', () => {
  const measured = C.describeForeignFlow(0, { status: 'AVAILABLE' });
  assert.equal(measured.display, 'Rp 0');
  assert.equal(measured.isKnown, true);
  assert.equal(measured.dataStatus, 'AVAILABLE');
});

test('a real negative flow keeps its sign and magnitude', () => {
  const out = C.describeForeignFlow(-70148910000, { status: 'AVAILABLE' });
  assert.equal(out.value, -70148910000);
  assert.ok(out.display.indexOf('70.15') !== -1);
});

test('chart-workstation producer: absent foreign data yields null, never 0', () => {
  const candles = [{ time: '2026-11-04', open: 100, high: 105, low: 95, close: 100, volume: 1000 }];
  assert.equal(W.getLatestForeignNet(candles, []), null);
});

test('chart-workstation producer: a measured zero stays 0', () => {
  const candles = [{ time: '2026-11-04', open: 100, high: 105, low: 95, close: 100, volume: 1000, foreign_net: 0 }];
  assert.equal(W.getLatestForeignNet(candles, []), 0);
});

test('chart-workstation formatter: missing vs measured zero are distinguishable by provenance', () => {
  assert.equal(W.formatIndonesianRupiahCompact(null), '\u2014');
  assert.equal(W.formatIndonesianRupiahCompact(0), '\u2014',
    'a bare 0 is indistinguishable from the old defect default, so it stays absent');
  // The workspace formatter treats an explicit AVAILABLE status as a real zero.
  assert.equal(W.formatIndonesianRupiahCompact(0, { status: 'AVAILABLE' }), '\u2014',
    'workspace formatter does not render an unprovenanced 0 as Rp 0');
});
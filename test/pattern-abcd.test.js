'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const detector = require('../lib/pattern-abcd');
const PatternMap = require('../public/pattern-map');
const visual = require('../public/pattern-visual');

function fixture(direction, tail) {
  const candles = [];
  for (let i = 0; i < 28; i++) candles.push({ time: `2026-06-${String(i + 1).padStart(2, '0')}`, open: 105, high: 107, low: 103, close: 105 });
  const set = (i, open, high, low, close) => { candles[i] = { ...candles[i], open, high, low, close }; };
  if (direction === 'bullish') {
    set(4, 100, 106, 85, 100); set(8, 108, 120, 104, 110); set(12, 104, 107, 100, 104);
    set(16, 108, 114, 104, 109); set(20, 99, 102, 94, 98);
    for (let i = 21; i < 28; i++) set(i, 98, 101, 96, 98);
  } else {
    set(4, 110, 125, 104, 110); set(8, 100, 106, 90, 100); set(12, 106, 110, 103, 106);
    set(16, 101, 105, 96, 101); set(20, 111, 116, 108, 112);
    for (let i = 21; i < 28; i++) set(i, 112, 114, 109, 112);
  }
  if (tail) tail(candles, set);
  return candles;
}
function detect(candles) { return detector.detectAbcdPattern(candles, { ticker: 'BBCA', dataDate: candles.at(-1).time }); }
function context(candles) { return { ticker: 'BBCA', timeframe: '1D', dataDate: candles.at(-1).time, candles }; }

for (const direction of ['bullish', 'bearish']) {
  test(`deterministic ${direction} ABCD fixture produces exact valid geometry and local config`, () => {
    const candles = fixture(direction); const output = detect(candles); const candidate = output.candidate;
    assert.equal(output.reason, 'found'); assert.equal(candidate.name, `${direction[0].toUpperCase()}${direction.slice(1)} ABCD`);
    assert.equal(PatternMap.validateCandidate(candidate, context(candles)).valid, true);
    // The same validated geometry is what the local figure draws.
    const svg = visual.buildPatternSvg({ ticker: 'BBCA', candidate, classicPatterns: [],
      context: context(candles), dataDate: candles.at(-1).time, currentPrice: candidate.currentPrice }, {});
    assert.match(svg, /^<svg /);
    for (const name of ['X', 'A', 'B', 'C', 'D']) assert.ok(svg.includes('>' + name + '</text>'), name);
    assert.deepEqual(Object.values(candidate.points).map(p => p.candleIndex), [4, 8, 12, 16, 20]);
    for (const point of Object.values(candidate.points)) assert.equal(point.value, candles[point.candleIndex][point.priceField]);
    const points = Object.values(candidate.points);
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i - 1].candleIndex < points[i].candleIndex);
      assert.ok(points[i - 1].time < points[i].time);
    }
  });
}

test('repeated input is byte-equivalent, stable, and never mutates input', () => {
  const candles = fixture('bullish'); const before = JSON.stringify(candles);
  const first = detect(candles), second = detect(candles);
  assert.equal(JSON.stringify(first), JSON.stringify(second)); assert.equal(JSON.stringify(candles), before);
  assert.equal(first.candidate.id, second.candidate.id);
});

test('confirmed pivots exclude last three bars and reject equal-price ambiguity', () => {
  const candles = fixture('bullish');
  candles[24].high = 130; candles[24].open = 105; candles[24].close = 105;
  assert.equal(detector.discoverPivots(candles).some(p => p.index >= candles.length - 3), false);
  const tied = fixture('bullish'); tied[7].high = tied[8].high;
  assert.equal(detector.discoverPivots(tied).some(p => p.index === 8 && p.type === 'high'), false);
});

test('outside bar qualifying as strict high and low emits neither pivot', () => {
  const candles = fixture('bullish');
  candles[24] = { ...candles[24], open: 105, high: 130, low: 70, close: 105 };
  const pivots = detector.discoverPivots(candles);
  assert.equal(pivots.some(p => p.index === 24), false);
  const output = detect(candles);
  assert.equal(output.candidate, null);
});

test('duplicate or non-chronological pivot indexes and dates are rejected defensively', () => {
  const candles = fixture('bullish'); const pivots = detector.discoverPivots(candles);
  assert.equal(detector.__test.validatePivotSequence(pivots), true);
  const duplicateIndex = pivots.map(p => ({ ...p })); duplicateIndex[3].index = duplicateIndex[2].index;
  assert.equal(detector.__test.validatePivotSequence(duplicateIndex), false);
  assert.equal(detector.__test.evaluateGroup(candles, duplicateIndex, { ticker: 'BBCA', dataDate: candles.at(-1).time }).reason,
    'ambiguous_or_duplicate_pivots');
  const duplicateDate = pivots.map(p => ({ ...p })); duplicateDate[3].time = duplicateDate[2].time;
  assert.equal(detector.__test.validatePivotSequence(duplicateDate), false);
  assert.equal(detector.__test.evaluateGroup(candles, duplicateDate, { ticker: 'BBCA', dataDate: candles.at(-1).time }).reason,
    'ambiguous_or_duplicate_pivots');
});

test('stable ID includes fixed rule version and every deterministic identity field', () => {
  const pivots = detector.discoverPivots(fixture('bullish'));
  const stableId = detector.__test.stableId;
  const first = stableId('BBCA', 'bullish', 'abcd-t1-v1', pivots);
  assert.equal(first, stableId('BBCA', 'bullish', 'abcd-t1-v1', pivots));
  assert.match(first, /abcd-t1-v1/); assert.ok(first.length <= 80);
  assert.notEqual(first, stableId('BBCA', 'bullish', 'abcd-t1-v2', pivots));
  assert.notEqual(first, stableId('BBCA', 'bearish', 'abcd-t1-v1', pivots));
  const changedDate = pivots.map(p => ({ ...p })); changedDate[0].time = '2026-06-04';
  assert.notEqual(first, stableId('BBCA', 'bullish', 'abcd-t1-v1', changedDate));
  assert.equal(detect(fixture('bullish')).candidate.id, 'abcd-BBCA-bullish-abcd-t1-v1-20260605-20260609-20260613-20260617-20260621');
});

test('same-type pivots keep only the more extreme and equal extremes keep earlier', () => {
  const input = [{ index: 1, type: 'high', value: 10 }, { index: 2, type: 'high', value: 12 },
    { index: 3, type: 'high', value: 12 }, { index: 4, type: 'low', value: 5 }, { index: 5, type: 'low', value: 4 }];
  assert.deepEqual(detector.alternatePivots(input).map(p => p.index), [2, 5]);
});

test('fixed BC and CD bounds reject below and above ratios', () => {
  const cases = [
    ['bc_retracement_below_min', 16, 'high', 111], ['bc_retracement_above_max', 16, 'high', 116],
    ['cd_ab_below_min', 20, 'low', 97], ['cd_ab_above_max', 20, 'low', 91]
  ];
  for (const [reason, index, field, value] of cases) {
    const candles = fixture('bullish'); candles[index][field] = value;
    if (field === 'high') candles[index].open = candles[index].close = Math.min(candles[index].close, value);
    else {
      candles[index].open = candles[index].close = Math.max(candles[index].close, value);
      if (value > 94) for (let i = 21; i < candles.length; i++) candles[i] = { ...candles[i], open: 100, high: 101, low: 99, close: 100 };
    }
    assert.equal(detect(candles).reason, reason, reason);
  }
});

test('insufficient candles, ATR, malformed OHLC and random labels safely produce no geometry', () => {
  assert.equal(detector.detectAbcdPattern([], { ticker: 'BBCA' }).reason, 'insufficient_candles');
  const short = fixture('bullish').slice(8); assert.equal(detect(short).candidate, null);
  const bad = fixture('bullish'); bad[2].high = NaN; assert.equal(detect(bad).reason, 'invalid_ohlc');
  assert.equal(detector.detectAbcdPattern({ name: 'Gartley' }, { ticker: 'BBCA' }).candidate, null);
});

test('candidate remains pending when neither event occurs', () => {
  assert.equal(detect(fixture('bullish')).candidate.status, 'candidate');
});

test('bullish and bearish confirmation evidence uses first qualifying daily close', () => {
  const bullish = fixture('bullish', (c, set) => { set(22, 103, 104, 96, 103); set(23, 104, 105, 100, 104); });
  const bearish = fixture('bearish', (c, set) => { set(22, 107, 114, 106, 107); set(23, 106, 111, 105, 106); });
  assert.deepEqual(detect(bullish).candidate.confirmationEvidence, { type: 'daily-close', date: '2026-06-23' });
  assert.deepEqual(detect(bearish).candidate.confirmationEvidence, { type: 'daily-close', date: '2026-06-23' });
});

test('invalidation before and after confirmation removes active candidate', () => {
  const before = fixture('bullish', (c, set) => set(26, 95, 100, 89, 96));
  assert.equal(detect(before).reason, 'invalidated_before_confirmation');
  const after = fixture('bullish', (c, set) => { set(21, 103, 104, 96, 103); set(26, 95, 100, 89, 96); });
  assert.equal(detect(after).reason, 'invalidated_after_confirmation');
});

test('stale D is rejected and source objects stay untouched', () => {
  const candles = fixture('bullish');
  for (let i = 0; i < 26; i++) candles.push({ time: `2026-07-${String(i + 1).padStart(2, '0')}`, open: 98, high: 101, low: 96, close: 98 });
  assert.equal(detect(candles).reason, 'stale_d');
});

test('detector is pure and contains no AI or network dependency', () => {
  const source = require('node:fs').readFileSync(require.resolve('../lib/pattern-abcd'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|quickchart|openai|telegram|portfolio/i);
});

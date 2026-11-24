'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectPivots, pivotsAsOf } = require('../../lib/chart-core/pivots');
const { buildZigZag } = require('../../lib/chart-core/zigzag');
const { detectSupportResistance } = require('../../lib/chart-core/support-resistance');
const { detectTrendlines, lineValueAt } = require('../../lib/chart-core/trendlines');
const { detectFibonacci } = require('../../lib/chart-core/fibonacci');

function barsFromPrices(prices, highExtra, lowExtra) {
  var he = highExtra || 0, le = lowExtra || 0;
  return prices.map(function (p, i) {
    return { index: i, time: i, high: p + he, low: p - le, close: p, open: p };
  });
}

// ---------- pivots ----------
test('pivots: synthetic series with known pivots', function () {
  // Zig-zag: peaks at 3, 9; troughs at 6, 12
  var prices = [10, 11, 12, 15, 12, 11, 8, 9, 12, 16, 14, 12, 7, 8, 9, 10, 11];
  var bars = barsFromPrices(prices, 0, 0);
  var pivots = detectPivots(bars, { k: 3 });
  var highs = pivots.filter(function (p) { return p.type === 'high'; });
  var lows = pivots.filter(function (p) { return p.type === 'low'; });
  assert.ok(highs.some(function (p) { return p.index === 9 && p.price === 16; }));
  assert.ok(lows.some(function (p) { return p.index === 12 && p.price === 7; }));
  highs.forEach(function (p) { assert.strictEqual(p.confirmed_at_index, p.index + 3); });
});

test('pivots: lookahead guard — pivot at i not detectable using data > i+k', function () {
  var prices = [10, 11, 12, 15, 12, 11, 8, 9, 12, 16, 14, 12, 7, 8, 9, 10, 11];
  var bars = barsFromPrices(prices, 0, 0);
  var k = 3;
  // Pivot high at index 9 confirmed at 12. As of bar 11 it must NOT be known.
  var asOf11 = pivotsAsOf(bars, 11, { k: k });
  assert.ok(!asOf11.some(function (p) { return p.index === 9; }));
  var asOf12 = pivotsAsOf(bars, 12, { k: k });
  assert.ok(asOf12.some(function (p) { return p.index === 9; }));
  // Truncating data at 11 must also not yield the pivot (equivalent proof).
  var truncated = detectPivots(bars.slice(0, 12), { k: k });
  assert.ok(!truncated.some(function (p) { return p.index === 9; }));
});

test('pivots: flat/equal highs produce no pivot (strict inequality)', function () {
  var prices = [10, 15, 15, 15, 15, 15, 10];
  var bars = barsFromPrices(prices, 0, 0);
  var pivots = detectPivots(bars, { k: 3 });
  assert.strictEqual(pivots.filter(function (p) { return p.type === 'high'; }).length, 0);
});

test('pivots: insufficient data => empty', function () {
  assert.deepStrictEqual(detectPivots(barsFromPrices([1, 2, 3], 0, 0), { k: 3 }), []);
  assert.deepStrictEqual(detectPivots([], { k: 3 }), []);
  assert.deepStrictEqual(detectPivots(null, { k: 3 }), []);
});

// ---------- zigzag ----------
test('zigzag: monotonic trend => minimal legs', function () {
  var prices = [];
  for (var i = 0; i < 30; i += 1) prices.push(10 + i);
  var legs = buildZigZag(barsFromPrices(prices, 0, 0), { k: 3, percent: 2 });
  assert.ok(legs.length <= 1, 'monotonic trend should have at most 1 leg, got ' + legs.length);
});

test('zigzag: deviation threshold respected', function () {
  // Small wiggles below 2% must be filtered out.
  var prices = [100, 100.5, 100, 100.5, 100, 100.5, 100];
  var legs = buildZigZag(barsFromPrices(prices, 0, 0), { k: 1, percent: 2 });
  assert.strictEqual(legs.length, 0);
  // Large swing above threshold must produce a leg.
  var big = [100, 95, 100, 95, 100, 95, 100];
  var legs2 = buildZigZag(barsFromPrices(big, 0, 0), { k: 1, percent: 2 });
  assert.ok(legs2.length >= 1);
});

test('zigzag: no lookahead — legs only reference confirmed pivots', function () {
  var prices = [10, 11, 12, 15, 12, 11, 8, 9, 12, 16, 14, 12, 7, 8, 9, 10, 11];
  var bars = barsFromPrices(prices, 0, 0);
  var legs = buildZigZag(bars, { k: 3, percent: 1 });
  legs.forEach(function (leg) {
    assert.ok(leg.to_index <= bars.length - 1 - 3, 'leg endpoint must be confirmed');
  });
});

test('zigzag: empty/flat data', function () {
  assert.deepStrictEqual(buildZigZag([], {}), []);
  assert.deepStrictEqual(buildZigZag(null, {}), []);
  var flat = barsFromPrices([5, 5, 5, 5, 5, 5, 5], 0, 0);
  assert.deepStrictEqual(buildZigZag(flat, { k: 2, percent: 1 }), []);
});

// ---------- support/resistance ----------
test('S/R: known clusters merge', function () {
  // Lows cluster near 100 (three touches), highs cluster near 120 (two touches).
  var prices = [110, 100, 111, 100.5, 112, 101, 115, 120, 119, 120.5, 118, 119.5, 121];
  var bars = barsFromPrices(prices, 0.5, 0.5);
  var zones = detectSupportResistance(bars, { k: 1, percent: 3 });
  assert.ok(zones.length >= 2, 'zones: ' + JSON.stringify(zones));
  var near100 = zones.find(function (z) { return z.price_low <= 100 && z.price_high >= 100; });
  assert.ok(near100, 'zone around 100 expected');
  assert.ok(near100.touches >= 3);
});

test('S/R: distinct levels stay separate', function () {
  var prices = [100, 90, 101, 89, 102, 88, 130, 140, 129, 141, 128, 135];
  var bars = barsFromPrices(prices, 0.5, 0.5);
  var zones = detectSupportResistance(bars, { k: 2, percent: 2 });
  var z100 = zones.find(function (z) { return z.price_high < 105; });
  var z130 = zones.find(function (z) { return z.price_low > 125; });
  assert.ok(z100 && z130, 'two distinct zones expected: ' + JSON.stringify(zones));
  assert.ok(z100.price_high < z130.price_low);
});

test('S/R: tolerance edge + empty pivots', function () {
  assert.deepStrictEqual(detectSupportResistance([], { k: 2 }), []);
  assert.deepStrictEqual(detectSupportResistance(null, {}), []);
  var flat = barsFromPrices([5, 5, 5, 5, 5, 5, 5], 0, 0);
  assert.deepStrictEqual(detectSupportResistance(flat, { k: 2, percent: 1 }), []);
});

// ---------- trendlines ----------
test('trendlines: synthetic uptrend => rising support line through pivot lows', function () {
  var prices = [];
  for (var i = 0; i < 24; i += 1) {
    // Rising with oscillation: troughs at 4, 10, 16 rising.
    var base = 10 + i * 0.5;
    var osc = (i % 6 === 0) ? -2 : (i % 6 === 3 ? 2 : 0);
    prices.push(base + osc);
  }
  var bars = barsFromPrices(prices, 0.2, 0.2);
  var res = detectTrendlines(bars, { k: 2, minTouches: 2, tolerancePct: 1 });
  assert.ok(res.support.length >= 1, 'expected at least one support line');
  var line = res.support[0];
  assert.ok(line.slope > 0, 'support slope must be rising in uptrend');
  assert.ok(line.touches >= 2);
});

test('trendlines: >=2 touches required; noise rejected', function () {
  // Random-ish noise: no clean 2-touch line with tight tolerance.
  var prices = [10, 12, 9, 13, 8, 14, 7, 15, 6, 16];
  var bars = barsFromPrices(prices, 0.1, 0.1);
  var res = detectTrendlines(bars, { k: 2, minTouches: 3, tolerancePct: 0.1, maxSlopePct: 1 });
  assert.strictEqual(res.support.length, 0);
  assert.strictEqual(res.resistance.length, 0);
});

test('trendlines: parallel channel construction', function () {
  // Perfect channel: price oscillates between rising lines y = 10 + 0.5x and y = 14 + 0.5x.
  var bars = [];
  for (var i = 0; i < 21; i += 1) {
    var lo = 10 + 0.5 * i;
    var hi = 14 + 0.5 * i;
    var mid = (lo + hi) / 2;
    var isTrough = i % 4 === 0;
    var isPeak = i % 4 === 2;
    var close = isTrough ? lo : (isPeak ? hi : mid);
    bars.push({ index: i, time: i, open: close, high: isPeak ? hi : close + 0.05, low: isTrough ? lo : close - 0.05, close: close });
  }
  var res = detectTrendlines(bars, { k: 2, minTouches: 2, tolerancePct: 0.5, channelSlopeTolerancePct: 0.5 });
  assert.ok(res.channels.length >= 1, 'expected a parallel channel');
  var ch = res.channels[0];
  assert.strictEqual(ch.parallel, true);
  assert.ok(ch.width_at_last > 0);
  assert.ok(Math.abs(ch.resistance.slope - ch.support.slope) < 0.01);
});

test('trendlines: empty input', function () {
  assert.deepStrictEqual(detectTrendlines([], {}), { resistance: [], support: [], channels: [] });
});

// ---------- fibonacci ----------
test('fibonacci: known swing => exact level prices (1e-6)', function () {
  // Uptrend swing: low 100 at index 2 (after a dip), high 200 at index 10 (confirmed).
  var bars = [];
  for (var i = 0; i < 16; i += 1) {
    var p = i === 0 ? 110 : (i === 1 ? 105 : (i <= 10 ? 100 + (i - 2) * 12.5 : 200 - (i - 10) * 5));
    bars.push({ index: i, time: i, open: p, high: p, low: p, close: p });
  }
  var fib = detectFibonacci(bars, { k: 2 });
  assert.ok(fib, 'fibonacci expected');
  assert.strictEqual(fib.status, 'confirmed');
  assert.strictEqual(fib.direction, 'uptrend');
  var byRatio = {};
  fib.levels.forEach(function (l) { byRatio[l.ratio] = l.price; });
  assert.ok(Math.abs(byRatio[0] - 200) < 1e-6);
  assert.ok(Math.abs(byRatio[0.236] - (200 - 100 * 0.236)) < 1e-6);
  assert.ok(Math.abs(byRatio[0.5] - 150) < 1e-6);
  assert.ok(Math.abs(byRatio[0.618] - (200 - 100 * 0.618)) < 1e-6);
  assert.ok(Math.abs(byRatio[1.0] - 100) < 1e-6);
  var ext = {};
  fib.extensions.forEach(function (l) { ext[l.ratio] = l.price; });
  assert.ok(Math.abs(ext[1.272] - (100 + 100 * 1.272)) < 1e-6);
  assert.ok(Math.abs(ext[1.618] - (100 + 100 * 1.618)) < 1e-6);
});

test('fibonacci: downtrend direction handling', function () {
  var bars = [];
  for (var i = 0; i < 16; i += 1) {
    var p = i === 0 ? 190 : (i === 1 ? 195 : (i <= 10 ? 200 - (i - 2) * 10 : 120 + (i - 10) * 4));
    bars.push({ index: i, time: i, open: p, high: p, low: p, close: p });
  }
  var fib = detectFibonacci(bars, { k: 2 });
  assert.strictEqual(fib.direction, 'downtrend');
  var byRatio = {};
  fib.levels.forEach(function (l) { byRatio[l.ratio] = l.price; });
  assert.ok(Math.abs(byRatio[0] - 120) < 1e-6, 'ratio 0 at swing end (low)');
  assert.ok(Math.abs(byRatio[1.0] - 200) < 1e-6, 'ratio 1.0 at swing origin (high)');
});

test('fibonacci: unconfirmed swing => PROVISIONAL', function () {
  // Only 3 bars with k=3: no confirmed pivots possible.
  var bars = [
    { index: 0, time: 0, open: 100, high: 100.5, low: 99.5, close: 100 },
    { index: 1, time: 1, open: 110, high: 110.5, low: 109.5, close: 110 },
    { index: 2, time: 2, open: 120, high: 120.5, low: 119.5, close: 120 }
  ];
  var fib = detectFibonacci(bars, { k: 3 });
  assert.ok(fib);
  assert.strictEqual(fib.status, 'provisional');
  assert.strictEqual(fib.levels.length, 0);
  assert.strictEqual(fib.extensions.length, 0);
});

test('fibonacci: asOfIndex lookahead guard', function () {
  var bars = [];
  for (var i = 0; i < 16; i += 1) {
    var p = i === 0 ? 110 : (i === 1 ? 105 : (i <= 10 ? 100 + (i - 2) * 12.5 : 200 - (i - 10) * 5));
    bars.push({ index: i, time: i, open: p, high: p, low: p, close: p });
  }
  // Swing high at index 10 confirmed at 12 with k=2. As of 11 => provisional.
  var fib = detectFibonacci(bars, { k: 2, asOfIndex: 11 });
  assert.strictEqual(fib.status, 'provisional');
  var fib2 = detectFibonacci(bars, { k: 2, asOfIndex: 12 });
  assert.strictEqual(fib2.status, 'confirmed');
});

test('fibonacci: empty input => null', function () {
  assert.strictEqual(detectFibonacci([], {}), null);
  assert.strictEqual(detectFibonacci(null, {}), null);
});

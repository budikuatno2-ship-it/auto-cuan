'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectGaps } = require('../../lib/chart-core/gaps');
const { detectDivergence } = require('../../lib/chart-core/divergence');
const { rsi, macd, obv } = require('../../lib/chart-core/oscillators');
const { detectCandlestickPatterns } = require('../../lib/chart-core/candlestick-patterns');
const { validateCandles } = require('../../lib/chart-core/index');

// ---------- gaps ----------
test('gaps: synthetic OHLC with known gap up and gap down', function () {
  var candles = [
    { time: 1, open: 100, high: 105, low: 98, close: 102 },
    { time: 2, open: 110, high: 115, low: 108, close: 112 },  // gap up: 110 > 105
    { time: 3, open: 90, high: 95, low: 88, close: 92 }       // gap down: 90 < 108
  ];
  var gaps = detectGaps(candles);
  assert.strictEqual(gaps.length, 2);
  assert.strictEqual(gaps[0].type, 'up');
  assert.strictEqual(gaps[0].gap_index, 1);
  assert.strictEqual(gaps[0].gap_bottom, 105);
  assert.strictEqual(gaps[0].gap_top, 110);
  assert.strictEqual(gaps[1].type, 'down');
  assert.strictEqual(gaps[1].gap_top, 108);
  assert.strictEqual(gaps[1].gap_bottom, 90);
});

test('gaps: fill detection', function () {
  var candles = [
    { time: 1, open: 100, high: 105, low: 98, close: 102 },
    { time: 2, open: 110, high: 115, low: 108, close: 112 },  // gap up 105-110
    { time: 3, open: 111, high: 114, low: 104, close: 106 }   // low 104 <= 105 => filled
  ];
  var gaps = detectGaps(candles);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].state, 'filled');
  assert.strictEqual(gaps[0].fill_index, 2);
});

test('gaps: partial fill', function () {
  var candles = [
    { time: 1, open: 100, high: 105, low: 98, close: 102 },
    { time: 2, open: 110, high: 115, low: 108, close: 112 },  // gap up 105-110
    { time: 3, open: 111, high: 114, low: 107, close: 109 }   // low 107 < 110 but > 105 => partial
  ];
  var gaps = detectGaps(candles);
  assert.strictEqual(gaps[0].state, 'partially-filled');
  assert.strictEqual(gaps[0].fill_index, null);
});

test('gaps: no gap => empty', function () {
  var candles = [
    { time: 1, open: 100, high: 105, low: 98, close: 102 },
    { time: 2, open: 103, high: 106, low: 100, close: 104 }
  ];
  assert.deepStrictEqual(detectGaps(candles), []);
  assert.deepStrictEqual(detectGaps([]), []);
  assert.deepStrictEqual(detectGaps(null), []);
});

// ---------- oscillators ----------
test('RSI: known-input expected values (1e-6)', function () {
  // Constant gains: RSI = 100. Constant losses: RSI = 0.
  var up = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  var r = rsi(up, 14);
  assert.ok(Math.abs(r[14] - 100) < 1e-6, 'all-gain series => RSI 100, got ' + r[14]);
  var down = up.slice().reverse();
  var r2 = rsi(down, 14);
  assert.ok(Math.abs(r2[14] - 0) < 1e-6, 'all-loss series => RSI 0, got ' + r2[14]);

  // Hand-computed: 14 changes: 13 up by 1, 1 down by 1 => avgGain=13/14, avgLoss=1/14.
  var closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 22];
  var r3 = rsi(closes, 14);
  var expected = 100 - 100 / (1 + (13 / 14) / (1 / 14));
  assert.ok(Math.abs(r3[14] - expected) < 1e-6, 'RSI mismatch: ' + r3[14] + ' vs ' + expected);
});

test('RSI: insufficient period => null not 0', function () {
  var r = rsi([1, 2, 3], 14);
  assert.strictEqual(r.length, 3);
  r.forEach(function (v) { assert.strictEqual(v, null); });
  assert.deepStrictEqual(rsi([], 14), []);
});

test('MACD: known-input expected values (1e-6)', function () {
  // Linear ramp: EMA of linear ramp converges; verify first MACD value = EMA12-EMA26 at index 25.
  var closes = [];
  for (var i = 0; i < 60; i += 1) closes.push(100 + i);
  var m = macd(closes, 12, 26, 9);
  // EMA12 at index 11 = mean of first 12 = 105.5; EMA26 at index 25 = mean of first 26 = 112.5.
  // MACD at index 25 = ema12[25] - 112.5. ema12[25] computed recursively; verify determinism:
  var ema12 = 105.5, mult12 = 2 / 13;
  for (var t = 12; t <= 25; t += 1) ema12 = (closes[t] - ema12) * mult12 + ema12;
  assert.ok(Math.abs(m.macd[25] - (ema12 - 112.5)) < 1e-6);
  assert.strictEqual(m.macd[24], null, 'MACD null before slow period');
  assert.strictEqual(m.signal[25], null, 'signal null until 9 MACD values');
  assert.ok(m.signal[33] !== null, 'signal available at index 33');
  assert.ok(Math.abs(m.histogram[33] - (m.macd[33] - m.signal[33])) < 1e-6);
});

test('MACD: insufficient data => all null', function () {
  var m = macd([1, 2, 3], 12, 26, 9);
  assert.ok(m.macd.every(function (v) { return v === null; }));
});

test('OBV: volume units preserved (shares, not lots)', function () {
  var bars = [
    { close: 10, volume: 1000 },
    { close: 11, volume: 500 },   // up => +500
    { close: 10, volume: 300 },   // down => -300
    { close: 10, volume: 200 },   // flat => unchanged
    { close: 12, volume: 700 }    // up => +700
  ];
  var o = obv(bars);
  assert.strictEqual(o[0], null, 'first bar has no prior close');
  assert.strictEqual(o[1], 500);
  assert.strictEqual(o[2], 200);
  assert.strictEqual(o[3], 200, 'flat close leaves OBV unchanged');
  assert.strictEqual(o[4], 900);
  // Units: raw share counts preserved (e.g. 1,500,000 shares stays shares).
  var shares = obv([{ close: 10, volume: 1500000 }, { close: 11, volume: 2500000 }]);
  assert.strictEqual(shares[1], 2500000, 'OBV must preserve share units, not convert to lots');
});

// ---------- divergence ----------
test('divergence: synthetic bullish divergence detected', function () {
  // Price lower lows at 5 and 15; oscillator higher lows.
  var bars = [];
  var osc = [];
  for (var i = 0; i < 22; i += 1) {
    var p;
    if (i <= 5) p = 100 - i * 2;          // down to 90 at i=5
    else if (i <= 10) p = 90 + (i - 5) * 2;
    else if (i <= 15) p = 100 - (i - 10) * 2.5; // down to 87.5 at i=15 (lower low)
    else p = 87.5 + (i - 15) * 2;
    bars.push({ index: i, time: i, open: p, high: p + 0.5, low: p - 0.5, close: p });
    osc.push(null);
  }
  osc[5] = 30;   // oscillator low at first price low
  osc[15] = 35;  // higher oscillator low at lower price low => bullish
  var res = detectDivergence(bars, osc, { k: 2, maxLookback: 20 });
  assert.strictEqual(res.bullish.length, 1);
  assert.strictEqual(res.bearish.length, 0);
  assert.strictEqual(res.bullish[0].pivot1.index, 5);
  assert.strictEqual(res.bullish[0].pivot2.index, 15);
});

test('divergence: bearish divergence detected', function () {
  var bars = [];
  var osc = [];
  for (var i = 0; i < 22; i += 1) {
    var p;
    if (i <= 5) p = 100 + i * 2;           // high 110 at i=5
    else if (i <= 10) p = 110 - (i - 5) * 2;
    else if (i <= 15) p = 100 + (i - 10) * 2.5; // high 112.5 at i=15 (higher high)
    else p = 112.5 - (i - 15) * 2;
    bars.push({ index: i, time: i, open: p, high: p + 0.5, low: p - 0.5, close: p });
    osc.push(null);
  }
  osc[5] = 70;
  osc[15] = 62; // lower oscillator high at higher price high => bearish
  var res = detectDivergence(bars, osc, { k: 2, maxLookback: 20 });
  assert.strictEqual(res.bearish.length, 1);
  assert.strictEqual(res.bullish.length, 0);
});

test('divergence: aligned highs/lows => none', function () {
  var bars = [];
  var osc = [];
  for (var i = 0; i < 22; i += 1) {
    var p;
    if (i <= 5) p = 100 - i * 2;
    else if (i <= 10) p = 90 + (i - 5) * 2;
    else if (i <= 15) p = 100 - (i - 10) * 2.5;
    else p = 87.5 + (i - 15) * 2;
    bars.push({ index: i, time: i, open: p, high: p + 0.5, low: p - 0.5, close: p });
    osc.push(null);
  }
  osc[5] = 30;
  osc[15] = 28; // oscillator also lower low => aligned, no divergence
  var res = detectDivergence(bars, osc, { k: 2, maxLookback: 20 });
  assert.strictEqual(res.bullish.length, 0);
  assert.strictEqual(res.bearish.length, 0);
});

test('divergence: unconfirmed pivots => PROVISIONAL flag', function () {
  // 10 bars, k=3: pivot low at index 3 confirmed at 6; pivot low at index 7
  // would confirm at 10 > last index 9 => unconfirmed => provisional.
  var bars = [];
  for (var i = 0; i < 10; i += 1) {
    var p = i <= 3 ? 100 - i * 2 : (i <= 6 ? 94 + (i - 3) * 2 : 100 - (i - 6) * 2);
    bars.push({ index: i, time: i, open: p, high: p + 0.5, low: p - 0.5, close: p });
  }
  var osc = bars.map(function (_, i) { return i <= 3 ? 40 - i * 2 : (i <= 6 ? 34 + (i - 3) * 2 : 40 - (i - 6) * 2); });
  var res = detectDivergence(bars, osc, { k: 3 });
  assert.strictEqual(res.provisional, true, 'pivot at index 7 not yet confirmed with k=3');
});

test('divergence: insufficient data => empty', function () {
  var res = detectDivergence([], [], {});
  assert.strictEqual(res.bullish.length, 0);
  assert.strictEqual(res.bearish.length, 0);
  assert.strictEqual(detectDivergence(null, null, {}).bullish.length, 0);
});

// ---------- candlestick patterns ----------
test('candlestick: doji exact match and threshold boundary', function () {
  var doji = { open: 100, high: 102, low: 98, close: 100.05 }; // body 0.05 / range 4 = 1.25%
  var nearMiss = { open: 100, high: 102, low: 98, close: 100.6 }; // body 0.6/4 = 15%
  var res = detectCandlestickPatterns([doji, nearMiss]);
  assert.ok(res.some(function (p) { return p.index === 0 && p.pattern === 'doji'; }));
  assert.ok(!res.some(function (p) { return p.index === 1 && p.pattern === 'doji'; }));
  // Boundary: body exactly at threshold (10%) => detected (<=).
  var boundary = { open: 100, high: 105, low: 95, close: 100.5 }; // 0.5/10 = 5%... use exact 10%
  var exact = { open: 100, high: 110, low: 90, close: 101 }; // body 1 / range 20 = 5%
  var res2 = detectCandlestickPatterns([exact], { dojiBodyRatio: 0.05 });
  assert.ok(res2.some(function (p) { return p.pattern === 'doji'; }));
  assert.ok(boundary.high > 0);
});

test('candlestick: hammer exact match; near-miss not detected', function () {
  // Body 2, range 12 => 16.7% (above doji 10%, below hammer 35%).
  // Lower wick 8 >= 2*2; upper wick 0.5 <= 2.
  var hammer = { open: 100, high: 100.5, low: 90, close: 102 };
  var res = detectCandlestickPatterns([hammer]);
  assert.ok(res.some(function (p) { return p.pattern === 'hammer' && p.direction === 'bullish'; }),
    'got: ' + JSON.stringify(res));
  // Near-miss: long upper wick disqualifies hammer.
  var notHammer = { open: 100, high: 105, low: 90, close: 102 };
  var res2 = detectCandlestickPatterns([notHammer]);
  assert.ok(!res2.some(function (p) { return p.pattern === 'hammer'; }));
});

test('candlestick: shooting star', function () {
  // Body 2, range 12 => 16.7%; upper wick 8 >= 2*2; lower wick 0.5 <= 2.
  var star = { open: 100, high: 110, low: 99.5, close: 98 };
  var res = detectCandlestickPatterns([star]);
  assert.ok(res.some(function (p) { return p.pattern === 'shooting-star' && p.direction === 'bearish'; }),
    'got: ' + JSON.stringify(res));
});

test('candlestick: bullish and bearish engulfing', function () {
  var bull = [
    { open: 102, high: 103, low: 99, close: 100 },   // bearish
    { open: 99.5, high: 104, low: 99, close: 102.5 } // bullish engulfing
  ];
  var resBull = detectCandlestickPatterns(bull);
  assert.ok(resBull.some(function (p) { return p.index === 1 && p.pattern === 'bullish-engulfing'; }));

  var bear = [
    { open: 100, high: 103, low: 99, close: 102 },   // bullish
    { open: 102.5, high: 103, low: 98, close: 99.5 } // bearish engulfing
  ];
  var resBear = detectCandlestickPatterns(bear);
  assert.ok(resBear.some(function (p) { return p.index === 1 && p.pattern === 'bearish-engulfing'; }));
});

test('candlestick: morning star and evening star (3 bars)', function () {
  var morning = [
    { open: 110, high: 111, low: 105, close: 106 },  // big bearish
    { open: 105, high: 105.6, low: 104.4, close: 105 }, // small body doji-ish
    { open: 106, high: 112, low: 105.5, close: 111 } // big bullish, close > mid of bar1
  ];
  var resM = detectCandlestickPatterns(morning);
  assert.ok(resM.some(function (p) { return p.index === 2 && p.pattern === 'morning-star'; }));

  var evening = [
    { open: 100, high: 106, low: 99, close: 105 },   // big bullish
    { open: 105, high: 105.6, low: 104.4, close: 105 }, // small body
    { open: 104, high: 104.5, low: 98, close: 99 }   // big bearish, close < mid of bar1
  ];
  var resE = detectCandlestickPatterns(evening);
  assert.ok(resE.some(function (p) { return p.index === 2 && p.pattern === 'evening-star'; }));
});

test('candlestick: near-miss multi-candle not detected', function () {
  // Third bar fails to close above midpoint of first bar => no morning star.
  var nearMiss = [
    { open: 110, high: 111, low: 105, close: 106 },
    { open: 105, high: 105.6, low: 104.4, close: 105 },
    { open: 105, high: 106, low: 104.5, close: 107 } // close 107 > mid 108? no: mid=(110+106)/2=108, 107<108 => fail
  ];
  var res = detectCandlestickPatterns(nearMiss);
  assert.ok(!res.some(function (p) { return p.pattern === 'morning-star'; }));
});

test('candlestick: empty input', function () {
  assert.deepStrictEqual(detectCandlestickPatterns([]), []);
  assert.deepStrictEqual(detectCandlestickPatterns(null), []);
});

// ---------- validator ----------
test('validator: valid candles pass', function () {
  var candles = [
    { time: 1, open: 100, high: 105, low: 98, close: 102, volume: 1000 },
    { time: 2, open: 102, high: 106, low: 100, close: 104, volume: 2000 }
  ];
  var v = validateCandles(candles);
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.errors.length, 0);
  assert.strictEqual(v.flags.length, 0);
});

test('validator: OHLC inequality violations', function () {
  var v = validateCandles([
    { open: 100, high: 99, low: 90, close: 95, volume: 1 },   // high < max(open,close)
    { open: 100, high: 105, low: 101, close: 95, volume: 1 }, // low > min(open,close)
    { open: 100, high: 90, low: 105, close: 95, volume: 1 }   // high < low
  ]);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.length >= 3);
});

test('validator: null volume allowed but flagged; negative volume error', function () {
  var v1 = validateCandles([{ open: 1, high: 2, low: 0.5, close: 1.5, volume: null }]);
  assert.strictEqual(v1.valid, true);
  assert.strictEqual(v1.flags.length, 1);
  var v2 = validateCandles([{ open: 1, high: 2, low: 0.5, close: 1.5, volume: -5 }]);
  assert.strictEqual(v2.valid, false);
});

test('validator: time monotonicity', function () {
  var v = validateCandles([
    { time: 2, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }
  ]);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(function (e) { return /monotonic/.test(e); }));
});

test('validator: empty/null input', function () {
  assert.strictEqual(validateCandles([]).valid, true);
  assert.strictEqual(validateCandles(null).valid, true);
});

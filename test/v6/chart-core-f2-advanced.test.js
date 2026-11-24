'use strict';

// F2 advanced detector tests: fvg, smc-structure, smc-order-blocks,
// classical-patterns, harmonic, elliott, lifecycle, multi-tf.
// Each module: positive + negative + edge + no-lookahead tests.

const test = require('node:test');
const assert = require('node:assert');

const { detectFVGs, fvgsAsOf } = require('../../lib/chart-core/fvg');
const { detectGaps } = require('../../lib/chart-core/gaps');
const { analyzeStructure, structureAsOf } = require('../../lib/chart-core/smc-structure');
const { detectOrderBlocks, detectLiquiditySweeps } = require('../../lib/chart-core/smc-order-blocks');
const { detectClassicalPatterns, patternsAsOf } = require('../../lib/chart-core/classical-patterns');
const { detectHarmonics, harmonicsAsOf } = require('../../lib/chart-core/harmonic');
const { detectElliott, elliottAsOf } = require('../../lib/chart-core/elliott');
const lifecycle = require('../../lib/chart-core/lifecycle');
const { computeAlignment } = require('../../lib/chart-core/multi-tf');

function bar(time, o, h, l, c) { return { time: time, open: o, high: h, low: l, close: c }; }

// Interpolated leg builder: strictly monotonic bars => clean junction pivots.
function legBuilder(candles) {
  var t = 0;
  return function legTo(price, from, steps) {
    var n = steps || 6;
    for (var s = 1; s <= n; s += 1) {
      var v = from + (price - from) * s / n;
      candles.push(bar(t++, v, v + 0.4, v - 0.4, v));
    }
  };
}

// ===================== fvg =====================
test('fvg: bullish 3-candle FVG detected with correct zone', function () {
  var candles = [
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 108, 100.5, 107),   // displacement up
    bar(3, 107, 112, 104, 111)      // low 104 > candle1 high 102 => FVG zone [102,104]
  ];
  var fvgs = detectFVGs(candles);
  assert.strictEqual(fvgs.length, 1);
  assert.strictEqual(fvgs[0].type, 'bullish');
  assert.strictEqual(fvgs[0].zone.bottom, 102);
  assert.strictEqual(fvgs[0].zone.top, 104);
  assert.strictEqual(fvgs[0].index, 2);
  assert.strictEqual(fvgs[0].state, 'unmitigated');
});

test('fvg: bearish 3-candle FVG detected', function () {
  var candles = [
    bar(1, 110, 112, 109, 111),
    bar(2, 111, 111.5, 104, 105),   // displacement down
    bar(3, 105, 106, 100, 101)      // high 106 < candle1 low 109 => FVG zone [106,109]
  ];
  var fvgs = detectFVGs(candles);
  assert.strictEqual(fvgs.length, 1);
  assert.strictEqual(fvgs[0].type, 'bearish');
  assert.strictEqual(fvgs[0].zone.top, 109);
  assert.strictEqual(fvgs[0].zone.bottom, 106);
});

test('fvg: mitigation transitions partial then full', function () {
  var candles = [
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 108, 100.5, 107),
    bar(3, 107, 112, 104, 111),     // FVG [102,104], mid 103
    bar(4, 111, 113, 103.5, 110),   // enters zone, not through mid => partial
    bar(5, 110, 111, 102, 103)      // low 102 <= mid 103 => fully mitigated
  ];
  var fvgs = detectFVGs(candles);
  assert.strictEqual(fvgs.length, 1);
  assert.strictEqual(fvgs[0].state, 'fully-mitigated');
  assert.strictEqual(fvgs[0].mitigation_index, 3, 'first entry at bar 4 (index 3)');
  assert.strictEqual(fvgs[0].mitigation_cross_index, 4, 'midpoint cross at bar 5 (index 4)');

  var fvgs2 = detectFVGs(candles.slice(0, 4));
  assert.strictEqual(fvgs2[0].state, 'partially-mitigated');
  assert.strictEqual(fvgs2[0].mitigation_index, 3);
});

test('fvg: FVG is NOT a session gap (no open-vs-prev-high gap)', function () {
  var candles = [
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 108, 100.5, 107),
    bar(3, 106, 112, 104, 111)      // open 106 within candle2 range => no session gap
  ];
  assert.deepStrictEqual(detectGaps(candles), [], 'gaps.js must find no session gap');
  var fvgs = detectFVGs(candles);
  assert.strictEqual(fvgs.length, 1, 'fvg.js must find the FVG');
  assert.strictEqual(fvgs[0].type, 'bullish');
});

test('fvg: session gap is NOT an FVG', function () {
  var candles = [
    bar(1, 100, 102, 99, 101),
    bar(2, 110, 115, 108, 112),     // session gap up 102->110
    bar(3, 111, 113, 101, 102)      // low 101 <= candle1 high 102 => no FVG
  ];
  var gaps = detectGaps(candles);
  assert.strictEqual(gaps.length, 1, 'gaps.js must find the session gap');
  assert.deepStrictEqual(detectFVGs(candles), [], 'fvg.js must find no FVG');
});

test('fvg: no lookahead — mitigation state as-of bar only uses closed bars', function () {
  var candles = [
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 108, 100.5, 107),
    bar(3, 107, 112, 104, 111),
    bar(4, 111, 113, 103.5, 110),
    bar(5, 110, 111, 102, 103)
  ];
  assert.strictEqual(fvgsAsOf(candles, 2)[0].state, 'unmitigated', 'entry bar not closed yet');
  assert.strictEqual(fvgsAsOf(candles, 3)[0].state, 'partially-mitigated');
  assert.strictEqual(fvgsAsOf(candles, 4)[0].state, 'fully-mitigated');
  assert.strictEqual(detectFVGs(candles)[0].state, 'fully-mitigated');
});

test('fvg: edge — empty/null input, fewer than 3 bars', function () {
  assert.deepStrictEqual(detectFVGs([]), []);
  assert.deepStrictEqual(detectFVGs(null), []);
  assert.deepStrictEqual(detectFVGs([bar(1, 1, 2, 0.5, 1.5)]), []);
});

// ===================== smc-structure =====================
test('smc-structure: synthetic uptrend produces BOS events', function () {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 5; i += 1) push(100 + i * 2, 101 + i * 2, 99 + i * 2, 100.5 + i * 2);
  push(108, 110, 107, 109);                       // pivot high 110 @5
  for (var j = 0; j < 3; j += 1) push(109 - j, 109.5 - j, 106 - j, 108 - j);
  for (var m = 0; m < 5; m += 1) push(105 + m * 2, 106 + m * 2, 104 + m * 2, 105.5 + m * 2);
  push(116, 120, 115, 119);                       // pivot high 120 @14
  for (var n = 0; n < 3; n += 1) push(119 - n, 119.5 - n, 116 - n, 118 - n);
  for (var p = 0; p < 5; p += 1) push(115 + p * 2, 116 + p * 2, 114 + p * 2, 115.5 + p * 2);

  var res = analyzeStructure(candles, { k: 3 });
  var bos = res.events.filter(function (e) { return e.type === 'BOS' && e.direction === 'bullish'; });
  assert.ok(bos.length >= 1, 'expected bullish BOS, got ' + JSON.stringify(res.events));
  assert.strictEqual(bos[0].broken_level, 110);
  assert.strictEqual(res.trend, 'up');
  assert.ok(res.swings.length >= 2);
});

test('smc-structure: downtrend-to-uptrend CHoCH', function () {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 5; i += 1) push(120 - i * 2, 121 - i * 2, 119 - i * 2, 119.5 - i * 2);
  push(112, 113, 110, 111);                       // pivot low 110 @5
  for (var j = 0; j < 3; j += 1) push(111 + j, 113 + j, 110.5 + j, 112 + j);
  // bar8 high 115 => pivot high 115
  for (var m = 0; m < 3; m += 1) push(113 - m, 114.5 - m, 111 - m, 112 - m);
  push(110, 111, 108, 109);                       // close 109 < 110 => BOS bearish, trend down
  for (var n = 0; n < 5; n += 1) push(109 + n * 2, 110 + n * 2, 108 + n * 2, 109.5 + n * 2);
  // bar17 close 117.5 > 115 => CHoCH bullish

  var res = analyzeStructure(candles, { k: 3 });
  var choch = res.events.filter(function (e) { return e.type === 'CHoCH' && e.direction === 'bullish'; });
  assert.ok(choch.length >= 1, 'expected bullish CHoCH, got ' + JSON.stringify(res.events));
  assert.strictEqual(choch[0].broken_level, 115);
  assert.strictEqual(res.trend, 'up');
});

test('smc-structure: wick pierce without close beyond => no BOS', function () {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 5; i += 1) push(100 + i, 100.5 + i, 99 + i, 100 + i);
  push(104, 105, 103, 104);                       // pivot high 105 @5
  for (var j = 0; j < 4; j += 1) push(104 - j, 104.5 - j, 102 - j, 103 - j);
  push(103, 106, 102, 103.5);                     // wick 106 > 105, close 103.5 < 105
  push(103, 104, 101, 102);

  var res = analyzeStructure(candles, { k: 3 });
  var breaks = res.events.filter(function (e) { return e.broken_level === 105; });
  assert.strictEqual(breaks.length, 0, 'wick pierce must not produce a break event');
});

test('smc-structure: no break => no events', function () {
  var candles = [];
  for (var i = 0; i < 20; i += 1) candles.push(bar(i, 100, 101, 99, 100));
  var res = analyzeStructure(candles, { k: 3 });
  assert.strictEqual(res.events.length, 0);
});

test('smc-structure: no lookahead — prefix data yields prefix events', function () {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 5; i += 1) push(100 + i * 2, 101 + i * 2, 99 + i * 2, 100.5 + i * 2);
  push(108, 110, 107, 109);
  for (var j = 0; j < 3; j += 1) push(109 - j, 109.5 - j, 106 - j, 108 - j);
  for (var m = 0; m < 5; m += 1) push(105 + m * 2, 106 + m * 2, 104 + m * 2, 105.5 + m * 2);

  var full = analyzeStructure(candles, { k: 3 });
  var asOf = structureAsOf(candles, 8, { k: 3 });
  assert.ok(asOf.events.length <= full.events.length);
  asOf.events.forEach(function (e, idx) {
    assert.deepStrictEqual(e, full.events[idx]);
  });
});

// ===================== smc-order-blocks =====================
function buildObBase() {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 5; i += 1) push(100 + i, 100.5 + i, 99 + i, 100 + i);
  push(104, 105, 103, 104);                       // pivot high 105 @5, confirmed @8
  for (var j = 0; j < 4; j += 1) push(104 - j, 104.5 - j, 102 - j, 103 - j);
  return candles; // bar9 = last down candle (open 101, close 100)
}

test('smc-order-blocks: bullish OB detected with correct zone', function () {
  var candles = buildObBase();
  candles.push(bar(10, 101, 108, 100.5, 107));    // strong up impulse, close > 105
  candles.push(bar(11, 107, 110, 106, 109));

  var obs = detectOrderBlocks(candles, { k: 3 });
  assert.ok(obs.length >= 1, 'expected OB, got ' + JSON.stringify(obs));
  var ob = obs[0];
  assert.strictEqual(ob.type, 'bullish');
  assert.strictEqual(ob.zone.top, 101, 'zone top = last down candle open');
  assert.strictEqual(ob.zone.bottom, 100, 'zone bottom = last down candle close');
  assert.strictEqual(ob.created_index, 9);
  assert.strictEqual(ob.mitigated_index, null);
});

test('smc-order-blocks: liquidity sweep detected (wick beyond, close back)', function () {
  var candles = buildObBase();
  candles.push(bar(10, 103, 106.5, 102, 103.5));  // wick > 105, close back below

  var sweeps = detectLiquiditySweeps(candles, { k: 3 });
  assert.strictEqual(sweeps.length, 1);
  assert.strictEqual(sweeps[0].type, 'high');
  assert.strictEqual(sweeps[0].swept_level, 105);
  assert.strictEqual(sweeps[0].sweep_index, 10);
});

test('smc-order-blocks: close beyond pivot => break, NOT sweep', function () {
  var candles = buildObBase();
  candles.push(bar(10, 103, 107, 102, 106.5));    // close above 105

  var sweeps = detectLiquiditySweeps(candles, { k: 3 });
  assert.strictEqual(sweeps.length, 0, 'close beyond must not be a sweep');
});

test('smc-order-blocks: mitigation tracking (close back through zone)', function () {
  var candles = buildObBase();
  candles.push(bar(10, 101, 108, 100.5, 107));
  candles.push(bar(11, 107, 110, 106, 109));
  candles.push(bar(12, 109, 110, 99, 99.5));      // close 99.5 < zone bottom 100

  var obs = detectOrderBlocks(candles, { k: 3 });
  assert.ok(obs.length >= 1);
  assert.strictEqual(obs[0].mitigated_index, 12);
});

test('smc-order-blocks: edge — no impulse => no OB', function () {
  var candles = [];
  for (var i = 0; i < 20; i += 1) candles.push(bar(i, 100, 100.5, 99.5, 100));
  assert.deepStrictEqual(detectOrderBlocks(candles, { k: 3 }), []);
  assert.deepStrictEqual(detectOrderBlocks([], { k: 3 }), []);
  assert.deepStrictEqual(detectOrderBlocks(null), []);
});

// ===================== classical-patterns =====================
function buildDoubleTop() {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 6; i += 1) push(100 + i, 101 + i, 99 + i, 100.5 + i);
  push(109, 110, 108, 109);                       // peak1 110 @6
  for (var j = 0; j < 5; j += 1) push(109 - j, 109.5 - j, 107.5 - j, 108 - j);
  push(104, 105, 103, 104);                       // valley 103 @12
  for (var m = 0; m < 5; m += 1) push(104 + m, 105 + m, 103.5 + m, 104.5 + m);
  push(109, 110, 108, 109);                       // peak2 110 @18
  for (var n = 0; n < 5; n += 1) push(109 - n, 109.5 - n, 107.5 - n, 108 - n);
  return candles;
}

test('classical-patterns: double top provisional before neckline break', function () {
  var res = detectClassicalPatterns(buildDoubleTop(), { k: 3 });
  var dt = res.filter(function (r) { return r.pattern === 'double-top'; });
  assert.strictEqual(dt.length, 1);
  assert.strictEqual(dt[0].direction, 'bearish');
  assert.strictEqual(dt[0].confirmed, false);
  assert.strictEqual(dt[0].provisional, true);
  assert.strictEqual(dt[0].neckline_or_boundary.level, 103);
  assert.strictEqual(dt[0].anchors.length, 3);
});

test('classical-patterns: double top confirmed after neckline close', function () {
  var candles = buildDoubleTop();
  candles.push(bar(candles.length, 103, 104, 100, 100.5)); // close < neckline 103
  var dt = detectClassicalPatterns(candles, { k: 3 })
    .filter(function (r) { return r.pattern === 'double-top'; })[0];
  assert.strictEqual(dt.confirmed, true);
  assert.strictEqual(dt.provisional, false);
  assert.strictEqual(dt.confirmed_index, candles.length - 1);
});

test('classical-patterns: double bottom with neckline confirmation', function () {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 6; i += 1) push(110 - i, 111 - i, 109 - i, 110 - i);
  push(101, 102, 100, 101);                       // trough1 100 @6
  for (var j = 0; j < 5; j += 1) push(101 + j, 102 + j, 100.5 + j, 101.5 + j);
  push(107, 108, 106, 107);                       // neckline peak 108 @12
  for (var m = 0; m < 5; m += 1) push(106 - m, 107 - m, 105 - m, 106 - m);
  push(101, 102, 100, 101);                       // trough2 100 @18
  for (var n = 0; n < 5; n += 1) push(101 + n, 102 + n, 100.5 + n, 101.5 + n);
  candles.push(bar(candles.length, 107, 109, 106, 108.5)); // close > 108

  var db = detectClassicalPatterns(candles, { k: 3 })
    .filter(function (r) { return r.pattern === 'double-bottom'; })[0];
  assert.ok(db, 'double bottom expected');
  assert.strictEqual(db.confirmed, true);
  assert.strictEqual(db.direction, 'bullish');
  assert.strictEqual(db.neckline_or_boundary.level, 108);
});

test('classical-patterns: head and shoulders detected (provisional)', function () {
  var candles = [];
  var leg = legBuilder(candles);
  leg(109, 100); leg(104, 109); leg(114, 104); leg(108, 114); leg(109, 108); leg(105, 109);
  var res = detectClassicalPatterns(candles, { k: 3 });
  var hs = res.filter(function (r) { return r.pattern === 'head-and-shoulders'; })[0];
  assert.ok(hs, 'H&S expected, got ' + JSON.stringify(res.map(function (r) { return r.pattern; })));
  assert.strictEqual(hs.direction, 'bearish');
  assert.strictEqual(hs.confirmed, false, 'no neckline break yet => provisional');
  assert.ok(Math.abs(hs.neckline_or_boundary.level - 104) < 0.5, 'neckline ~104, got ' + hs.neckline_or_boundary.level);
});

test('classical-patterns: rounding base U-shape detected and confirmed', function () {
  var candles = [];
  var leg = legBuilder(candles);
  // U-shape: three lows 94 -> 90 -> 91 (middle lowest), rims ~97/99.
  leg(94, 100); leg(97, 94); leg(90, 97); leg(93, 90); leg(91, 93); leg(99, 91);
  var res = detectClassicalPatterns(candles, { k: 3 });
  var rb = res.filter(function (r) { return r.pattern === 'rounding-base'; })[0];
  assert.ok(rb, 'rounding base expected, got ' + JSON.stringify(res.map(function (r) { return r.pattern; })));
  assert.strictEqual(rb.direction, 'bullish');
  assert.strictEqual(rb.confirmed, true, 'close 99 > rim');
});

test('classical-patterns: rounding base provisional before rim break', function () {
  var candles = [];
  var leg = legBuilder(candles);
  leg(94, 100); leg(97, 94); leg(90, 97); leg(93, 90); leg(91, 93); leg(99, 91);
  // Truncate before the final rally closes above the rim.
  var truncated = candles.slice(0, candles.length - 4);
  var res = detectClassicalPatterns(truncated, { k: 3 });
  var rb = res.filter(function (r) { return r.pattern === 'rounding-base'; })[0];
  if (rb) {
    assert.strictEqual(rb.confirmed, false);
    assert.strictEqual(rb.provisional, true);
  }
});

test('classical-patterns: symmetric triangle from converging pivots', function () {
  var candles = [];
  var leg = legBuilder(candles);
  leg(110, 95); leg(102, 110); leg(108, 102); leg(104, 108); leg(106, 104); leg(103, 106);
  var res = detectClassicalPatterns(candles, { k: 3 });
  var st = res.filter(function (r) { return r.pattern === 'symmetric-triangle'; })[0];
  assert.ok(st, 'symmetric triangle expected, got ' + JSON.stringify(res.map(function (r) { return r.pattern; })));
  assert.strictEqual(st.provisional, true);
});

test('classical-patterns: ascending triangle (flat top, rising lows)', function () {
  var candles = [];
  var leg = legBuilder(candles);
  leg(110, 100); leg(105, 110); leg(110, 105); leg(107, 110); leg(110, 107); leg(108, 110);
  var res = detectClassicalPatterns(candles, { k: 3 });
  var at = res.filter(function (r) { return r.pattern === 'ascending-triangle'; })[0];
  assert.ok(at, 'ascending triangle expected, got ' + JSON.stringify(res.map(function (r) { return r.pattern; })));
  assert.strictEqual(at.direction, 'bullish');
});

test('classical-patterns: rising and falling wedges', function () {
  var up = [];
  var legUp = legBuilder(up);
  legUp(110, 90); legUp(100, 110); legUp(113, 100); legUp(104, 113); legUp(115, 104); legUp(106, 115);
  var rw = detectClassicalPatterns(up, { k: 3 })
    .filter(function (r) { return r.pattern === 'rising-wedge'; })[0];
  assert.ok(rw, 'rising wedge expected, got ' + JSON.stringify(detectClassicalPatterns(up, { k: 3 }).map(function (r) { return r.pattern; })));
  assert.strictEqual(rw.direction, 'bearish');

  var down = [];
  var legDown = legBuilder(down);
  legDown(112, 130); legDown(120, 112); legDown(110, 120); legDown(116, 110); legDown(108, 116); legDown(110, 108);
  var fw = detectClassicalPatterns(down, { k: 3 })
    .filter(function (r) { return r.pattern === 'falling-wedge'; })[0];
  assert.ok(fw, 'falling wedge expected, got ' + JSON.stringify(detectClassicalPatterns(down, { k: 3 }).map(function (r) { return r.pattern; })));
  assert.strictEqual(fw.direction, 'bullish');
});

test('classical-patterns: bull flag (pole + flat consolidation)', function () {
  var candles = [];
  var t = 0;
  for (var i = 0; i < 6; i += 1) candles.push(bar(t++, 100, 100.5, 99.5, 100));
  for (var p = 0; p < 8; p += 1) {
    var v = 100 + (p + 1) * 1.25;
    candles.push(bar(t++, v, v + 0.3, v - 0.3, v));
  }
  for (var c = 0; c < 6; c += 1) candles.push(bar(t++, 110, 111, 109, 110));

  var res = detectClassicalPatterns(candles, { k: 3 });
  var fl = res.filter(function (r) { return r.pattern === 'bull-flag'; })[0];
  assert.ok(fl, 'bull flag expected, got ' + JSON.stringify(res.map(function (r) { return r.pattern; })));
  assert.strictEqual(fl.direction, 'bullish');
  assert.strictEqual(fl.provisional, true);
});

test('classical-patterns: near-miss double top (peaks 4.5% apart) => not detected', function () {
  var candles = [];
  var t = 0;
  function push(o, h, l, c) { candles.push(bar(t++, o, h, l, c)); }
  for (var i = 0; i < 6; i += 1) push(100 + i, 101 + i, 99 + i, 100.5 + i);
  push(109, 110, 108, 109);                       // peak1 110
  for (var j = 0; j < 5; j += 1) push(109 - j, 109.5 - j, 107.5 - j, 108 - j);
  push(104, 105, 103, 104);
  for (var m = 0; m < 5; m += 1) push(104 + m, 105 + m, 103.5 + m, 104.5 + m);
  push(114, 115, 113, 114);                       // peak2 115 — 4.5% off
  for (var n = 0; n < 5; n += 1) push(114 - n, 114.5 - n, 112.5 - n, 113 - n);

  var dt = detectClassicalPatterns(candles, { k: 3 })
    .filter(function (r) { return r.pattern === 'double-top'; });
  assert.strictEqual(dt.length, 0, 'near-miss must not be detected as double-top');
});

test('classical-patterns: no lookahead — prefix data yields prefix patterns', function () {
  var candles = buildDoubleTop();
  candles.push(bar(candles.length, 103, 104, 100, 100.5));
  var full = detectClassicalPatterns(candles, { k: 3 });
  var asOf = patternsAsOf(candles, 18, { k: 3 }); // up to peak2 only
  asOf.forEach(function (p) {
    var inFull = full.filter(function (f) { return f.pattern === p.pattern; })[0];
    assert.ok(inFull, 'as-of pattern ' + p.pattern + ' must exist in full run');
    if (!p.confirmed) assert.strictEqual(inFull.confirmed, false);
  });
});

// ===================== harmonic =====================
function buildHarmonic(xa, bRatio, dRatio) {
  var X = 100, A = 100 + xa;
  var B = A - bRatio * xa;
  var C = B + 0.618 * (A - B);
  var D = A - dRatio * xa;
  var candles = [];
  var leg = legBuilder(candles);
  leg(X, X + 6);       // lead-in down to X
  leg(A, X); leg(B, A); leg(C, B); leg(D, C);
  var t = candles.length;
  for (var e = 0; e < 5; e += 1) {
    candles.push(bar(t++, D + 0.5 + e * 0.3, D + 0.8 + e * 0.3, D + 0.2 + e * 0.3, D + 0.5 + e * 0.3));
  }
  return candles;
}

test('harmonic: exact Gartley ratios detected', function () {
  var res = detectHarmonics(buildHarmonic(38.2, 0.618, 0.786), { k: 3, tolerance: 0.05 });
  var g = res.filter(function (r) { return r.pattern === 'gartley'; });
  assert.ok(g.length >= 1, 'Gartley expected, got ' + JSON.stringify(res.map(function (r) { return r.pattern + ':' + JSON.stringify(r.ratios); })));
  assert.strictEqual(g[0].direction, 'bullish');
  assert.ok(Math.abs(g[0].ratios.B - 0.618) < 0.05);
  assert.ok(Math.abs(g[0].ratios.D - 0.786) < 0.05);
  assert.ok(g[0].prz.top >= g[0].prz.bottom);
  assert.strictEqual(g[0].status, 'CONFIRMED');
});

test('harmonic: ratio outside tolerance => not detected', function () {
  // D at 0.5 XA retrace — far from every pattern's D ratio.
  var res = detectHarmonics(buildHarmonic(38.2, 0.618, 0.5), { k: 3, tolerance: 0.05 });
  assert.strictEqual(res.length, 0, 'D=0.5 XA must not match any harmonic, got ' + JSON.stringify(res.map(function (r) { return r.pattern; })));
});

test('harmonic: Bat, Butterfly, Crab each have a positive case', function () {
  var bat = detectHarmonics(buildHarmonic(38.2, 0.45, 0.886), { k: 3 });
  assert.ok(bat.some(function (r) { return r.pattern === 'bat'; }), 'Bat expected, got ' + JSON.stringify(bat.map(function (r) { return r.pattern + ':' + JSON.stringify(r.ratios); })));
  var butterfly = detectHarmonics(buildHarmonic(38.2, 0.786, 1.272), { k: 3 });
  assert.ok(butterfly.some(function (r) { return r.pattern === 'butterfly'; }), 'Butterfly expected');
  var crab = detectHarmonics(buildHarmonic(38.2, 0.5, 1.618), { k: 3 });
  assert.ok(crab.some(function (r) { return r.pattern === 'crab'; }), 'Crab expected');
});

test('harmonic: PRZ bounds correct for Gartley', function () {
  var g = detectHarmonics(buildHarmonic(38.2, 0.618, 0.786), { k: 3 })
    .filter(function (r) { return r.pattern === 'gartley'; })[0];
  var idealD = 138.2 - 0.786 * 38.2;   // 108.145
  var pad = 38.2 * 0.05;               // 1.91
  assert.ok(Math.abs(g.prz.top - (idealD + pad)) < 0.5, 'PRZ top ' + g.prz.top);
  assert.ok(Math.abs(g.prz.bottom - (idealD - pad)) < 0.5, 'PRZ bottom ' + g.prz.bottom);
});

test('harmonic: unconfirmed D => PROVISIONAL', function () {
  var candles = buildHarmonic(38.2, 0.618, 0.786);
  var truncated = candles.slice(0, 33); // D @29 known, but only 3 bars after D
  var g = detectHarmonics(truncated, { k: 3, confirmBars: 5 })
    .filter(function (r) { return r.pattern === 'gartley'; })[0];
  assert.ok(g, 'Gartley expected in truncated data');
  assert.strictEqual(g.status, 'PROVISIONAL');
});

test('harmonic: no lookahead — as-of truncation consistent', function () {
  var candles = buildHarmonic(38.2, 0.618, 0.786);
  var full = detectHarmonics(candles, { k: 3 });
  var asOf = harmonicsAsOf(candles, 20, { k: 3 });
  assert.ok(Array.isArray(asOf));
  asOf.forEach(function (h) {
    assert.ok(full.some(function (f) { return f.pattern === h.pattern; }));
  });
});

// ===================== elliott =====================
function buildElliott(marks, lastSteps) {
  var candles = [];
  var leg = legBuilder(candles);
  for (var w = 0; w < marks.length - 1; w += 1) {
    leg(marks[w + 1], marks[w], w === 0 ? 6 : 6);
  }
  var t = candles.length;
  var lastPrice = marks[marks.length - 1];
  var steps = lastSteps || 5;
  for (var e = 0; e < steps; e += 1) {
    var v = lastPrice - 0.5;
    candles.push(bar(t++, v, v + 0.3, v - 0.3, v));
  }
  return candles;
}

test('elliott: synthetic 5-wave impulse detected with all rules pass', function () {
  var res = detectElliott(buildElliott([105, 100, 120, 110, 140, 125, 160]), { k: 3 });
  var imp = res.filter(function (r) { return r.kind === 'impulse' && r.direction === 'bullish'; });
  assert.ok(imp.length >= 1, 'impulse expected, got ' + JSON.stringify(res.map(function (r) { return r.kind + ':' + r.direction + ':' + r.status; })));
  var valid = imp.filter(function (r) { return r.status === 'CONFIRMED' || r.status === 'PROVISIONAL'; })[0];
  assert.ok(valid, 'valid impulse expected');
  assert.strictEqual(valid.waves.length, 5);
  valid.rules_checked.forEach(function (r) {
    assert.strictEqual(r.pass, true, 'rule ' + r.rule + ' must pass');
  });
});

test('elliott: wave-2 >100% retrace => INVALIDATED with alternatives', function () {
  var res = detectElliott(buildElliott([105, 100, 120, 95, 115, 105, 125]), { k: 3, strict: true });
  var imp = res.filter(function (r) { return r.kind === 'impulse' && r.direction === 'bullish'; });
  assert.ok(imp.length >= 1);
  var invalidated = imp.filter(function (r) { return r.status === 'INVALIDATED'; });
  assert.ok(invalidated.length >= 1, 'INVALIDATED expected, got ' + JSON.stringify(imp.map(function (r) { return r.status; })));
  assert.ok(invalidated[0].alternatives.length >= 1, 'alternative count must be offered');
});

test('elliott: wave-3 shortest => INVALIDATED', function () {
  var res = detectElliott(buildElliott([105, 100, 110, 105, 112, 104, 130]), { k: 3, strict: true });
  var imp = res.filter(function (r) { return r.kind === 'impulse' && r.direction === 'bullish'; });
  assert.ok(imp.length >= 1);
  var inv = imp.filter(function (r) { return r.status === 'INVALIDATED'; });
  assert.ok(inv.length >= 1, 'wave3-shortest must invalidate');
  var rule = inv[0].rules_checked.filter(function (r) { return r.rule === 'wave3_not_shortest'; })[0];
  assert.strictEqual(rule.pass, false);
});

test('elliott: wave-4 overlap flagged', function () {
  var res = detectElliott(buildElliott([105, 100, 120, 110, 135, 115, 150]), { k: 3, strict: true });
  var imp = res.filter(function (r) { return r.kind === 'impulse' && r.direction === 'bullish'; });
  assert.ok(imp.length >= 1);
  var overlapRule = imp[0].rules_checked.filter(function (r) { return r.rule === 'wave4_no_overlap_wave1'; })[0];
  assert.strictEqual(overlapRule.pass, false, 'wave4 overlap must be flagged');
});

test('elliott: ABC correction detected', function () {
  var candles = [];
  var leg = legBuilder(candles);
  leg(80, 130, 12); leg(106, 80); leg(85, 106);
  var t = candles.length;
  for (var e = 0; e < 4; e += 1) {
    candles.push(bar(t++, 85.5 + e * 0.3, 85.8 + e * 0.3, 85.2 + e * 0.3, 85.5 + e * 0.3));
  }
  var res = detectElliott(candles, { k: 3 });
  var abc = res.filter(function (r) { return r.kind === 'abc'; });
  assert.ok(abc.length >= 1, 'ABC expected, got ' + JSON.stringify(res.map(function (r) { return r.kind; })));
  assert.strictEqual(abc[0].waves.length, 2);
});

test('elliott: no lookahead — as-of truncation consistent', function () {
  var candles = buildElliott([105, 100, 120, 110, 140, 125, 160]);
  var full = detectElliott(candles, { k: 3 });
  var asOf = elliottAsOf(candles, 20, { k: 3 });
  assert.ok(Array.isArray(asOf));
  asOf.forEach(function (e) {
    assert.ok(full.some(function (f) { return f.kind === e.kind; }));
  });
});

// ===================== lifecycle =====================
test('lifecycle: full lifecycle FORMING -> PROVISIONAL -> CONFIRMED', function () {
  var rec = lifecycle.createLifecycle({
    pattern: 'double-top', direction: 'bearish',
    invalidationLevel: 110, maxAgeBars: 50, detectedAt: 10, source: { a: 1 }
  });
  assert.strictEqual(rec.state, 'FORMING');
  lifecycle.transition(rec, 'PROVISIONAL', { at: 12, reason: 'anchors complete' });
  lifecycle.transition(rec, 'CONFIRMED', { at: 20, reason: 'neckline break' });
  assert.strictEqual(rec.state, 'CONFIRMED');
  assert.strictEqual(rec.confirmed_at, 20);
  assert.strictEqual(rec.history.length, 2);
  assert.ok(rec.source_hash, 'source hash recorded');
  assert.strictEqual(rec.algorithm_version, lifecycle.VERSION);
});

test('lifecycle: invalidation on level breach', function () {
  var rec = lifecycle.createLifecycle({
    pattern: 'double-bottom', direction: 'bullish',
    invalidationLevel: 100, detectedAt: 5
  });
  lifecycle.transition(rec, 'PROVISIONAL', { at: 8 });
  lifecycle.evaluate(rec, { currentBar: 15, currentPrice: 99 });
  assert.strictEqual(rec.state, 'INVALIDATED');
  assert.strictEqual(rec.invalidated_at, 15);
  assert.ok(rec.reason.indexOf('invalidation level') !== -1);
});

test('lifecycle: expiry on age', function () {
  var rec = lifecycle.createLifecycle({
    pattern: 'flag', direction: 'bullish', maxAgeBars: 10, detectedAt: 5
  });
  lifecycle.transition(rec, 'PROVISIONAL', { at: 7 });
  lifecycle.evaluate(rec, { currentBar: 16, currentPrice: 105 });
  assert.strictEqual(rec.state, 'EXPIRED');
  assert.strictEqual(rec.expired_at, 16);
});

test('lifecycle: projection labeled SKENARIO', function () {
  var rec = lifecycle.createLifecycle({ pattern: 'gartley', direction: 'bullish', detectedAt: 1 });
  lifecycle.transition(rec, 'PROJECTION', { at: 5, reason: 'dashed forward scenario' });
  assert.strictEqual(rec.state, 'PROJECTION');
  assert.strictEqual(rec.projection.labeled, 'SKENARIO');
});

test('lifecycle: illegal transitions rejected', function () {
  var rec = lifecycle.createLifecycle({ pattern: 'x', detectedAt: 1 });
  assert.throws(function () { lifecycle.transition(rec, 'CONFIRMED'); }, /Illegal transition/);
  lifecycle.transition(rec, 'INVALIDATED', { at: 2 });
  assert.throws(function () { lifecycle.transition(rec, 'CONFIRMED'); }, /Illegal transition/);
  assert.throws(function () { lifecycle.transition(rec, 'EXPIRED'); }, /Illegal transition/);
  assert.throws(function () { lifecycle.transition(rec, 'BOGUS'); }, /Unknown state/);
});

// ===================== multi-tf =====================
test('multi-tf: aligned uptrend 1D+1W => aligned with agreements', function () {
  var res = computeAlignment({
    timeframes: [
      { tf: '1D', data: { trend: 'up', srZones: [{ top: 105, bottom: 100 }], divergence: 'bullish' } },
      { tf: '1W', data: { trend: 'up', srZones: [{ top: 106, bottom: 101 }], divergence: 'bullish' } }
    ]
  });
  assert.strictEqual(res.aligned, true);
  assert.ok(res.agreements.some(function (a) { return a.kind === 'trend'; }));
  assert.ok(res.agreements.some(function (a) { return a.kind === 'sr-confluence'; }));
  assert.strictEqual(res.conflicts.length, 0);
});

test('multi-tf: conflicting trends => conflicts listed, not aligned', function () {
  var res = computeAlignment({
    timeframes: [
      { tf: '1D', data: { trend: 'up' } },
      { tf: '1W', data: { trend: 'down' } }
    ]
  });
  assert.strictEqual(res.aligned, false);
  assert.ok(res.conflicts.some(function (c) { return c.kind === 'trend'; }));
});

test('multi-tf: missing TF => TIMEFRAME_DATA_UNAVAILABLE, no fabrication', function () {
  var res = computeAlignment({
    timeframes: [
      { tf: '1D', data: { trend: 'up' } },
      { tf: '1W', data: { trend: 'up' } },
      { tf: '1H', data: null }
    ],
    requested: ['1D', '1W', '1H', '15m']
  });
  var un = res.unavailable.map(function (u) { return u.tf; });
  assert.ok(un.indexOf('1H') !== -1);
  assert.ok(un.indexOf('15m') !== -1, 'requested-but-absent TF must be reported');
  res.unavailable.forEach(function (u) {
    assert.strictEqual(u.reason, 'TIMEFRAME_DATA_UNAVAILABLE');
  });
  assert.strictEqual(JSON.stringify(res).indexOf('synth'), -1);
});

test('multi-tf: single TF => insufficient, not aligned', function () {
  var res = computeAlignment({
    timeframes: [{ tf: '1D', data: { trend: 'up' } }]
  });
  assert.strictEqual(res.aligned, false);
  assert.strictEqual(res.note, 'INSUFFICIENT_TIMEFRAMES');
});

test('multi-tf: divergence conflict detected', function () {
  var res = computeAlignment({
    timeframes: [
      { tf: '1D', data: { trend: 'up', divergence: 'bullish' } },
      { tf: '1W', data: { trend: 'up', divergence: 'bearish' } }
    ]
  });
  assert.ok(res.conflicts.some(function (c) { return c.kind === 'divergence'; }));
});

'use strict';

/**
 * test/v6/chart-drawing-tools.test.js
 * ============================================================================
 * V6 (W2b / Feature 13B) — Chart drawing tools, pure-logic tests.
 *
 * The chart engine is TradingView Lightweight Charts v4.1.1 (Apache-2.0). The
 * drawing layer lives in public/chart-drawing-tools.js. This suite exercises
 * the DOM-free geometry / serialisation / collision logic. The pointer-drag
 * interaction itself needs a real browser canvas and is marked NOT_TESTED in
 * docs/v6/V6_W2B_CHART_SCREENER_UX.md with manual steps.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const draw = require(path.join(ROOT, 'public', 'chart-drawing-tools.js'));

/* -------------------------------------------------------------------------- */
/* Trendline                                                                  */
/* -------------------------------------------------------------------------- */

test('13B-(a): trendline slope/intercept from two anchors', () => {
  const line = draw.trendlineFromPoints({ logical: 0, price: 100 }, { logical: 10, price: 200 });
  assert.equal(line.vertical, false);
  assert.equal(line.slope, 10);
  assert.equal(line.intercept, 100);
  // price at logical 5 = 100 + 10*5 = 150
  assert.equal(draw.trendlinePriceAt(line, 5), 150);
});

test('13B-(b): vertical trendline is flagged, not Infinity', () => {
  const line = draw.trendlineFromPoints({ logical: 3, price: 100 }, { logical: 3, price: 200 });
  assert.equal(line.vertical, true);
  assert.equal(line.slope, null);
  assert.equal(draw.trendlinePriceAt(line, 3), null);
});

/* -------------------------------------------------------------------------- */
/* Fibonacci                                                                  */
/* -------------------------------------------------------------------------- */

test('13B-(c): Fibonacci levels 0/0.236/0.382/0.5/0.618/0.786/1', () => {
  const levels = draw.fibLevels({ logical: 0, price: 100 }, { logical: 10, price: 200 });
  assert.equal(levels.length, 7);
  assert.deepEqual(levels.map((l) => l.ratio), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  assert.equal(levels[0].price, 100);
  assert.equal(levels[6].price, 200);
  assert.equal(levels[3].price, 150); // 0.5
  // 0.618 -> 100 + 100*0.618 = 161.8
  assert.ok(Math.abs(levels[4].price - 161.8) < 1e-9);
});

test('13B-(d): Fibonacci works with a descending anchor pair', () => {
  const levels = draw.fibLevels({ logical: 0, price: 200 }, { logical: 10, price: 100 });
  assert.equal(levels[0].price, 200);
  assert.equal(levels[6].price, 100);
  assert.equal(levels[3].price, 150);
});

/* -------------------------------------------------------------------------- */
/* Ruler                                                                      */
/* -------------------------------------------------------------------------- */

test('13B-(e): ruler delta / percent / bars', () => {
  const m = draw.rulerMeasure({ logical: 2, price: 1000 }, { logical: 12, price: 1100 });
  assert.equal(m.priceDelta, 100);
  assert.equal(m.percent, 10);
  assert.equal(m.bars, 10);
  assert.equal(m.direction, 'up');
});

test('13B-(f): ruler handles a zero base price without dividing by zero', () => {
  const m = draw.rulerMeasure({ logical: 0, price: 0 }, { logical: 5, price: 50 });
  assert.equal(m.percent, null);
  assert.equal(m.priceDelta, 50);
});

/* -------------------------------------------------------------------------- */
/* Hit-testing                                                                */
/* -------------------------------------------------------------------------- */

test('13B-(g): hit-test tolerance for a trendline segment', () => {
  const d = draw.createDrawing('trendline', [{ logical: 0, price: 100 }, { logical: 10, price: 200 }]);
  const projector = { toX: (l) => l * 10, toY: (p) => 500 - p };
  const proj = draw.projectDrawing(d, projector);
  // midpoint of the segment in screen space
  const mid = { x: 50, y: 350 };
  assert.equal(draw.hitTest(proj, mid, 6), true);
  // far away
  assert.equal(draw.hitTest(proj, { x: 50, y: 100 }, 6), false);
});

test('13B-(h): hit-test for a horizontal line uses vertical distance only', () => {
  const d = draw.createDrawing('hline', [{ logical: 0, price: 150 }]);
  const projector = { toX: (l) => l * 10, toY: (p) => 500 - p };
  const proj = draw.projectDrawing(d, projector);
  assert.equal(draw.hitTest(proj, { x: 999, y: 350 }, 6), true);
  assert.equal(draw.hitTest(proj, { x: 999, y: 300 }, 6), false);
});

/* -------------------------------------------------------------------------- */
/* Serialisation + per-ticker isolation                                       */
/* -------------------------------------------------------------------------- */

test('13B-(i): serialise/deserialise round-trip preserves drawings', () => {
  const d = draw.createDrawing('fib', [{ logical: 1, price: 100 }, { logical: 9, price: 200 }]);
  const raw = draw.serialize([d], { ticker: 'bbca', timeframe: '1d' });
  const back = draw.deserialize(raw);
  assert.equal(back.drawings.length, 1);
  assert.equal(back.drawings[0].type, 'fib');
  assert.equal(back.drawings[0].anchors.length, 2);
  assert.equal(back.ticker, 'BBCA');
  assert.equal(back.timeframe, '1D');
});

test('13B-(j): deserialise rejects corrupt payloads without throwing', () => {
  assert.deepEqual(draw.deserialize('not json').drawings, []);
  assert.deepEqual(draw.deserialize('{"drawings":"nope"}').drawings, []);
  assert.deepEqual(draw.deserialize(null).drawings, []);
});

test('13B-(k): per-(ticker,timeframe) isolation in the store', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k)
  };
  const store = draw.createStore(storage);
  const d1 = draw.createDrawing('trendline', [{ logical: 0, price: 1 }, { logical: 1, price: 2 }]);
  store.save('BBCA', '1D', [d1]);
  assert.equal(store.load('BBCA', '1D').length, 1);
  // different ticker -> empty
  assert.equal(store.load('BBRI', '1D').length, 0);
  // different timeframe -> empty
  assert.equal(store.load('BBCA', '1W').length, 0);
  // key is normalised to upper-case
  assert.equal(store.key('bbca', '1d'), store.key('BBCA', '1D'));
});

/* -------------------------------------------------------------------------- */
/* Label collision resolver (VIDEO-09)                                        */
/* -------------------------------------------------------------------------- */

test('13B-(l): label collision resolver stacks overlapping labels', () => {
  const labels = [
    { y: 100, text: 'Fib 0' },
    { y: 103, text: 'Fib 23.6' },
    { y: 106, text: 'Fib 38.2' }
  ];
  const out = draw.resolveLabelCollisions(labels, 12);
  assert.equal(out.length, 3);
  // each consecutive pair is at least 12px apart
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].y - out[i - 1].y >= 12, 'labels must not overlap');
  }
  // the first label is unmoved
  assert.equal(out[0].offset, 0);
  // later labels record how far they were pushed
  assert.ok(out[1].offset > 0);
});

test('13B-(m): label collision resolver leaves well-spaced labels untouched', () => {
  const labels = [{ y: 100, text: 'A' }, { y: 200, text: 'B' }];
  const out = draw.resolveLabelCollisions(labels, 12);
  assert.equal(out[0].y, 100);
  assert.equal(out[1].y, 200);
  assert.equal(out[0].offset, 0);
  assert.equal(out[1].offset, 0);
});

test('13B-(n): label collision resolver sorts unsorted input by y', () => {
  const labels = [{ y: 200, text: 'B' }, { y: 100, text: 'A' }];
  const out = draw.resolveLabelCollisions(labels, 12);
  assert.equal(out[0].text, 'A');
  assert.equal(out[1].text, 'B');
});

/* -------------------------------------------------------------------------- */
/* Tool registry                                                              */
/* -------------------------------------------------------------------------- */

test('13B-(o): all required tools are registered', () => {
  ['trendline', 'hline', 'fib', 'ruler', 'freehand'].forEach((t) => {
    assert.ok(draw.TOOLS.indexOf(t) !== -1, 'missing tool ' + t);
  });
  assert.equal(draw.createDrawing('bogus', []), null);
});

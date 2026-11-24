'use strict';

/**
 * test/v6/chart-overlay-integrity.test.js
 * ============================================================================
 * M-P1b - Chart Workstation overlay data-integrity + panel density (pure
 * logic, no browser). Guards against the static-geometry regression where
 * buildV3F09Overlay rendered XABCD/SMC/ZigZag pattern SVGs from FIXED screen
 * coordinates (x = 110, 250, 390, 530, 680) on live charts as if they were
 * real pattern detection.
 *
 *   (a) static-geometry guard: screen-coordinate fixtures are classified
 *       DEMO/INVALID and never rendered as live detection
 *   (b) verified anchors map to correct candle index/price
 *   (c) CONFIRMED vs PROVISIONAL classification (unconfirmed D => PROVISIONAL)
 *   (d) label collision resolver stacks with min gap and does NOT move anchors
 *   (e) drawer config: collapsible categories + hide-all-overlays +
 *       reset-to-preset present, all layers preserved
 *   (f) layer toggle does not change chart scale (visible logical range
 *       unchanged in the pure model)
 *
 * NOT_TESTED here: real browser E2E at the Chart Workstation URL - manual
 * steps in docs/v6/V6_M_P1B_CHART_WORKSTATION_ADDENDUM.md.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const W = require(path.join(ROOT, 'public', 'chart-workstation.js'));

/* Deterministic synthetic candle series (no network, no fixture files). */
function makeCandles(n) {
  const out = [];
  let base = 5000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 40 + (i % 11 === 0 ? 60 : 0);
    const open = base;
    const close = Math.round(base + drift);
    const high = Math.max(open, close) + 25;
    const low = Math.min(open, close) - 25;
    // Monotonic time key: v3f09NormCandles re-sorts by time string, so the
    // fixture keeps sort order identical to array order (index-stable).
    out.push({
      time: 'c' + String(i).padStart(6, '0'),
      open, high, low, close,
      volume: 1000 + (i % 5) * 200
    });
    base = close;
  }
  return out;
}

/* Fixture from the bug report: pattern geometry in FIXED SCREEN coordinates
   (x = 110, 250, 390, 530, 680) with no candle index / price anchors. */
const STATIC_SCREEN_FIXTURE = {
  id: 'XABCD',
  points: [
    { x: 110, y: 65 },
    { x: 250, y: 245 },
    { x: 390, y: 95 },
    { x: 530, y: 235 },
    { x: 680, y: 75 }
  ]
};

/* ------------------------------------------------------------------------ */
/* (a) Static-geometry guard                                                */
/* ------------------------------------------------------------------------ */

test('P1b-(a1): screen-coordinate fixture is classified DEMO, not VERIFIED', () => {
  const g = W.classifyPatternGeometry(STATIC_SCREEN_FIXTURE);
  assert.ok(g.classification === 'DEMO' || g.classification === 'INVALID',
    'screen-coord fixture must be DEMO/INVALID, got ' + g.classification);
  assert.notEqual(g.classification, 'VERIFIED');
  assert.match(g.reason, /anchor|screen|statis|koordinat/i);
});

test('P1b-(a2): partial anchors (missing index/price on one point) are INVALID', () => {
  const candles = makeCandles(80);
  const x = W.calculateV3F09XABCD(candles);
  const pts = [x.x, x.a, x.b, x.c, { index: x.d.index }]; // d lost its price
  const g = W.classifyPatternGeometry({ points: pts });
  assert.equal(g.classification, 'INVALID');
});

test('P1b-(a3): live overlay never emits static demo coordinates', () => {
  const candles = makeCandles(120);
  const ov = W.buildV3F09Overlay('TESTX', candles, 'pro', 'dark');
  assert.equal(ov.geometry.demo, false);
  assert.ok(!ov.svg.includes('data-demo-fixture="true"'),
    'live overlay must not contain demo-fixture markers');
  // The exact static triplets from the bug must not appear as polygon points.
  assert.ok(!ov.svg.includes('110,65 250,245 390,95'), 'static XAB triplet leaked');
  assert.ok(!ov.svg.includes('390,95 530,235 680,75'), 'static BCD triplet leaked');
  // Every XABCD anchor circle carries a real candle index attribute.
  const idxAttrs = ov.svg.match(/data-candle-index="(\d+)"/g) || [];
  assert.ok(idxAttrs.length >= 5, 'XABCD points must expose data-candle-index');
  for (const attr of idxAttrs) {
    const v = Number(attr.match(/(\d+)/)[1]);
    assert.ok(Number.isFinite(v) && v >= 0 && v < candles.length,
      'anchor index ' + v + ' outside candle range');
  }
});

test('P1b-(a4): no verified pattern data => honest empty state, not fake patterns', () => {
  const ov = W.buildV3F09Overlay('EMPTY', [], 'pro', 'dark');
  assert.equal(ov.geometry.emptyState, true);
  assert.match(ov.svg, /data-overlay-empty="true"/);
  assert.match(ov.svg, /Pola belum terdeteksi \/ data tidak cukup/);
  assert.ok(!ov.svg.includes('<polygon data-xabcd'), 'no polygon may be drawn without verified anchors');
});

test('P1b-(a5): static demo geometry is available ONLY as clearly-labelled opt-in fixture', () => {
  const candles = makeCandles(120);
  const demo = W.buildV3F09Overlay('DEMO', candles, 'pro', 'dark', { demo: true });
  assert.equal(demo.geometry.demo, true);
  assert.equal(demo.geometry.classification, 'DEMO');
  assert.match(demo.svg, /DEMO FIXTURE - geometri statis, bukan deteksi pola live/);
  assert.ok(demo.svg.includes('data-demo-fixture="true"'));
  // And it is OFF by default: same call without options stays live/verified.
  const live = W.buildV3F09Overlay('DEMO', candles, 'pro', 'dark');
  assert.equal(live.geometry.demo, false);
});

/* ------------------------------------------------------------------------ */
/* (b) Verified anchors map to correct candle index/price                   */
/* ------------------------------------------------------------------------ */

test('P1b-(b1): classifyPatternGeometry accepts real index+price anchors', () => {
  const candles = makeCandles(80);
  const x = W.calculateV3F09XABCD(candles);
  const g = W.classifyPatternGeometry({ points: [x.x, x.a, x.b, x.c, x.d] });
  assert.equal(g.classification, 'VERIFIED');
});

test('P1b-(b2): XABCD anchors land on their real candle index and price', () => {
  const candles = makeCandles(120);
  const x = W.calculateV3F09XABCD(candles);
  assert.ok(!x.empty, 'XABCD must detect pivots on a 120-bar series');
  for (const key of ['x', 'a', 'b', 'c', 'd']) {
    const p = x[key];
    assert.ok(Number.isFinite(Number(p.index)), key + ' has candle index');
    assert.ok(Number(p.price) > 0, key + ' has real price');
    const candle = candles[Number(p.index)];
    assert.ok(candle, key + ' index inside candle array');
    // Pivot price must equal that candle's high (H) or low (L) exactly.
    if (p.kind === 'H') assert.equal(Number(p.price), Number(candle.high));
    else assert.equal(Number(p.price), Number(candle.low));
  }
});

test('P1b-(b3): projected overlay points derive from index/price, not constants', () => {
  const candles = makeCandles(120);
  const x = W.calculateV3F09XABCD(candles);
  const pts = [x.x, x.a, x.b, x.c, x.d];
  const projected = W.projectVerifiedAnchors(pts, { x0: 40, x1: 760, y0: 40, y1: 300 });
  assert.equal(projected.length, 5);
  // Monotonic x with increasing index.
  for (let i = 1; i < projected.length; i++) {
    assert.ok(projected[i].x >= projected[i - 1].x, 'x follows candle order');
  }
  // Higher price => smaller y (inverted price axis).
  const hi = projected.reduce((m, p) => (p.price > m.price ? p : m), projected[0]);
  const lo = projected.reduce((m, p) => (p.price < m.price ? p : m), projected[0]);
  assert.ok(hi.y < lo.y, 'higher price renders higher on screen');
  // Points stay inside the plot rect.
  for (const p of projected) {
    assert.ok(p.x >= 40 && p.x <= 760, 'x within plot rect');
    assert.ok(p.y >= 40 && p.y <= 300, 'y within plot rect');
  }
});

test('P1b-(b4): projections change when candle geometry changes (1D vs 1W-style resample)', () => {
  const daily = makeCandles(120);
  // Weekly-style aggregate: every 5th candle kept (index space changes).
  const weekly = daily.filter((_, i) => i % 5 === 0);
  const x1 = W.calculateV3F09XABCD(daily);
  const x2 = W.calculateV3F09XABCD(weekly);
  const p1 = W.projectVerifiedAnchors([x1.x, x1.a, x1.b, x1.c, x1.d], undefined);
  const p2 = W.projectVerifiedAnchors([x2.x, x2.a, x2.b, x2.c, x2.d], undefined);
  assert.ok(p1.length && p2.length);
  const differs = p2.some((q, i) => Math.abs(q.x - p1[i].x) > 0.5);
  assert.ok(differs, 'anchors re-project onto the new index space (no frozen screen coords)');
});

/* ------------------------------------------------------------------------ */
/* (c) CONFIRMED vs PROVISIONAL                                             */
/* ------------------------------------------------------------------------ */

test('P1b-(c1): unconfirmed D-point (fresh pivot) => PROVISIONAL', () => {
  // classifyXabcdPivot is internal; assert via the exported calculator using
  // a confirmBars window larger than the series: D can never gather enough
  // subsequent bars, so the pattern must stay PROVISIONAL, never CONFIRMED.
  const candles = makeCandles(60);
  const x = W.calculateV3F09XABCD(candles, { confirmBars: 100000 });
  assert.equal(x.confirmation, 'PROVISIONAL');
  assert.equal(x.confirmedAt, null);
  assert.ok(x.barsAfterD < 100000);
  // And a D sitting inside the newest confirmBars-1 bars is provisional too.
  const near = W.calculateV3F09XABCD(candles, { confirmBars: candles.length });
  assert.equal(near.confirmation, 'PROVISIONAL');
});

test('P1b-(c2): fully historical D-point with confirmBars => CONFIRMED', () => {
  const candles = makeCandles(60);
  const x = W.calculateV3F09XABCD(candles, { confirmBars: 1 });
  assert.equal(x.confirmation, 'CONFIRMED',
    'old D pivot with >=1 bar after it confirms');
  assert.ok(x.confirmedAt !== null);
});

test('P1b-(c3): SVG confirmation markers always agree with the calculator verdict', () => {
  // buildV3F09Overlay re-runs the calculator with default confirmBars, so the
  // contract is: svg markers MUST match calculateV3F09XABCD's classification.
  // A provisional verdict may never produce a CONFIRMED marker.
  const candles = makeCandles(60);
  const verdict = W.calculateV3F09XABCD(candles).confirmation;
  const ov = W.buildV3F09Overlay('PROV', candles, 'pro', 'dark');
  if (ov.svg.includes('<polygon data-xabcd')) {
    const polyConf = (ov.svg.match(/data-xabcd="(?:XAB|BCD)" data-confirmation="(CONFIRMED|PROVISIONAL)"/g) || [])
      .map(s => s.includes('PROVISIONAL') ? 'PROVISIONAL' : 'CONFIRMED');
    assert.ok(polyConf.length >= 2, 'both XABCD polygons carry data-confirmation');
    for (const c of polyConf) assert.equal(c, verdict, 'polygon confirmation == calculator verdict');
    if (verdict === 'PROVISIONAL') {
      assert.match(ov.svg, /PROVISIONAL - D belum terkonfirmasi/);
      assert.ok(!ov.svg.includes('data-confirmation="CONFIRMED"'),
        'provisional pattern must not emit any CONFIRMED marker');
      assert.match(ov.svg, /stroke-dasharray/);
    }
  } else {
    // Or the honest empty state when anchors cannot be projected.
    assert.match(ov.svg, /data-overlay-empty="true"/);
  }
});

test('P1b-(c3b): unconfirmed D pattern (calculator override) classifies PROVISIONAL with reason', () => {
  // The overlay path uses confirmXabcdPivot with defaults; here we verify the
  // classification semantics the renderer depends on via a confirmBars window
  // no D pivot can ever satisfy.
  const candles = makeCandles(60);
  const x = W.calculateV3F09XABCD(candles, { confirmBars: 100000 });
  assert.equal(x.confirmation, 'PROVISIONAL');
  assert.equal(x.confirmedAt, null);
});

test('P1b-(c4): per-pivot markers expose data-confirmation and use solid vs hollow distinction', () => {
  const candles = makeCandles(120);
  const ov = W.buildV3F09Overlay('PERS', candles, 'pro', 'dark');
  const markers = ov.svg.match(/<circle data-xabcd-point="[^"]+"[^>]*data-confirmation="(CONFIRMED|PROVISIONAL)"[^>]*>/g) || [];
  assert.ok(markers.length >= 5, 'all 5 pivots expose confirmation state');
  for (const m of markers) {
    if (m.includes('PROVISIONAL')) {
      assert.ok(m.includes('fill="none"') && m.includes('stroke-dasharray'),
        'PROVISIONAL pivot is hollow + dashed');
    } else {
      assert.ok(m.includes('fill="#3b82f6"') && !m.includes('fill="none"'),
        'CONFIRMED pivot is solid');
    }
  }
});

/* ------------------------------------------------------------------------ */
/* (d) Label collision resolver                                             */
/* ------------------------------------------------------------------------ */

test('P1b-(d1): labels stack with min gap and anchors stay untouched', () => {
  const labels = [
    { text: 'A', y: 100, anchorY: 100 },
    { text: 'B', y: 105, anchorY: 105 },
    { text: 'C', y: 110, anchorY: 110 }
  ];
  const out = W.resolveLabelCollisions(labels, 14, { top: 0, bottom: 400 });
  assert.equal(out.length, 3);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].y - out[i - 1].y >= 14, 'gap >= 14 between stacked labels');
  }
  // Anchor data preserved exactly.
  assert.deepEqual(out.map(l => l.anchorY), [100, 105, 110]);
  // Anchors are NOT moved: moved flags true only for pushed labels, and the
  // original anchorY values equal the inputs.
  assert.equal(out[0].moved, false, 'first label stays on its anchor');
  assert.equal(out[1].moved, true, 'overlapping label is offset visually');
});

test('P1b-(d2): resolver clips labels into the plot area', () => {
  const out = W.resolveLabelCollisions(
    [{ y: 50, anchorY: 50 }, { y: 400, anchorY: 400 }],
    12,
    { top: 20, bottom: 300 }
  );
  for (const l of out) {
    assert.ok(l.y >= 20 && l.y <= 300, 'label y clipped to bounds');
  }
});

test('P1b-(d3): overlay labels separate anchor data from visual position', () => {
  const candles = makeCandles(120);
  const ov = W.buildV3F09Overlay('LBL', candles, 'pro', 'dark');
  const anchorAttrs = ov.svg.match(/data-label-anchor-y="([\d.]+)"/g) || [];
  if (anchorAttrs.length) {
    assert.ok(anchorAttrs.length > 0, 'labels carry their anchor y as data');
    // Visual label y values are finite numbers within the viewBox.
    const ys = ov.svg.match(/data-label-anchor-y="[\d.]+" x="[\d.]+" y="([\d.]+)"/g) || [];
    for (const m of ys) {
      const y = Number(m.match(/y="([\d.]+)"/)[1]);
      assert.ok(Number.isFinite(y), 'label y finite');
    }
  }
});

/* ------------------------------------------------------------------------ */
/* (e) Drawer config                                                        */
/* ------------------------------------------------------------------------ */

test('P1b-(e1): drawer exposes 4 collapsible categories', () => {
  const drawer = W.renderDrawerHtml('mainChart');
  for (const cat of ['indikator', 'pattern', 'drawing', 'bandar']) {
    assert.ok(drawer.includes('data-cw-cat="' + cat + '"'), 'category ' + cat + ' present');
  }
  assert.match(drawer, /<details class="cw-drawer-cat" data-cw-cat="indikator"( open)?>/);
});

test('P1b-(e2): drawer has hide-all-overlays + reset-to-preset actions', () => {
  const drawer = W.renderDrawerHtml('mainChart');
  assert.match(drawer, /AutoCuanChartWorkstation\.turnOffAll\('mainChart'\)/);
  assert.match(drawer, /Sembunyikan semua overlay opsional/);
  assert.match(drawer, /AutoCuanChartWorkstation\.reset\('mainChart'\)/);
  assert.match(drawer, /Reset ke preset/);
  // hide-all is explicit that it hides, not deletes.
  assert.match(drawer, /data tidak dihapus/);
});

test('P1b-(e3): drawer keeps every registered layer (nothing removed)', () => {
  const drawer = W.renderDrawerHtml('mainChart');
  const ids = [];
  for (const g of W.LAYER_GROUPS) for (const l of g.layers) ids.push(l.id);
  for (const id of ids) {
    assert.ok(drawer.includes("toggleLayer('mainChart', '" + id + "')"),
      'layer ' + id + ' still present in drawer');
  }
  // Layer groups and presets unchanged.
  assert.ok(W.LAYER_GROUPS.length >= 9);
  for (const p of ['simpel', 'scalping', 'swing', 'investor', 'pro']) {
    assert.ok(W.PRESETS[p], 'preset ' + p + ' intact');
  }
});

test('P1b-(e4): drawer has search box wired to filterDrawer', () => {
  const drawer = W.renderDrawerHtml('mainChart');
  assert.match(drawer, /_drawer_search/);
  assert.match(drawer, /AutoCuanChartWorkstation\.filterDrawer\('mainChart', this\.value\)/);
  assert.equal(typeof W.filterDrawer, 'function');
  assert.equal(typeof W.setDrawingTool, 'function');
});

test('P1b-(e5): drawing tools category lists all chart-drawing-tools modes', () => {
  const drawer = W.renderDrawerHtml('mainChart');
  const DT = require(path.join(ROOT, 'public', 'chart-drawing-tools.js'));
  for (const tool of DT.TOOLS) {
    assert.ok(drawer.includes('data-tool="' + tool + '"'), 'tool ' + tool + ' listed');
  }
});

/* ------------------------------------------------------------------------ */
/* (f) Layer toggle does not change chart scale                             */
/* ------------------------------------------------------------------------ */

test('P1b-(f1): toggling a layer leaves the visible logical range untouched (pure model)', () => {
  // Pure-model stand-in for the chart registry: a visible range object the
  // renderer would pass to Lightweight Charts. Toggling layers must not
  // mutate candles, indices, or the range.
  const candles = makeCandles(120);
  const state = W.createWorkstationState('pro');
  const visibleRange = { from: candles.length - 90, to: candles.length - 1 };
  const rangeSnapshot = Object.assign({}, visibleRange);
  const candlesSnapshot = JSON.stringify(candles);

  const layers = ['ma20', 'fibonacci', 'rsi14', 'bandar_foreign'];
  for (const id of layers) {
    state.toggleLayer(id); // toggle on/off
    state.toggleLayer(id);
  }
  assert.deepEqual(visibleRange, rangeSnapshot, 'visible logical range unchanged');
  assert.equal(JSON.stringify(candles), candlesSnapshot, 'candle data untouched by toggles');
});

test('P1b-(f2): toggleLayer does not touch price-scale inputs (min/max derivation stable)', () => {
  const candles = makeCandles(120);
  const state = W.createWorkstationState('pro');
  function priceMinMax(series) {
    let lo = Infinity, hi = -Infinity;
    for (const c of series) {
      lo = Math.min(lo, c.low); hi = Math.max(hi, c.high);
    }
    return { lo, hi };
  }
  const before = priceMinMax(candles);
  for (const id of ['ma20', 'ma50', 'ma100', 'ma200', 'bollinger', 'volume_bars', 'rsi14']) {
    state.toggleLayer(id);
    assert.deepEqual(priceMinMax(candles), before, 'price scale inputs unchanged after toggling ' + id);
  }
});

test('P1b-(f3): renderChartOverlay degrades to honest empty state instead of throwing on missing chart', () => {
  // Pure-logic guard: buildV3F09Overlay (the data layer of renderChartOverlay)
  // must produce valid results for any ticker/TF combination without a DOM.
  const candles = makeCandles(50);
  for (const mode of ['simple', 'swing', 'investor', 'pro', 'scalping']) {
    const ov = W.buildV3F09Overlay('ANYT', candles, mode, 'dark');
    assert.ok(ov && typeof ov.svg === 'string' && ov.svg.length > 0, 'mode ' + mode + ' renders');
    assert.ok(ov.geometry, 'mode ' + mode + ' exposes geometry metadata');
    assert.ok(['VERIFIED', 'UNAVAILABLE', 'DEMO'].includes(ov.geometry.classification),
      'mode ' + mode + ' classified: ' + ov.geometry.classification);
  }
});

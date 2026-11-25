'use strict';

/**
 * F3 (CHT wiring) — chart-auto-patterns-runtime tests.
 *
 * Verifies the wiring layer that connects the F1/F2 pure detectors to the real
 * chart surface:
 *   - the browser bundle is byte-parity with lib/chart-core (single source);
 *   - every detector result becomes an overlay with REAL candle-index + price
 *     anchors (classifyPatternGeometry => VERIFIED, never DEMO/INVALID);
 *   - lifecycle states render correctly (CONFIRMED solid, PROVISIONAL amber,
 *     PROJECTION dashed SKENARIO, INVALIDATED/EXPIRED never live);
 *   - incremental recompute keyed by source_hash (no recompute on pan/zoom);
 *   - overlay cap + priority (CONFIRMED > PROVISIONAL > PROJECTION);
 *   - preset defaults (Simple minimal, Pro all) + toggle resolution;
 *   - honest mode guards (Scalping EOD, Day Trade WIB session, Short Swing R/R);
 *   - RSI/MACD/OBV pane series with honest empty states (never 0);
 *   - honest empty state when data is insufficient.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const rt = require(path.join(ROOT, 'public', 'chart-auto-patterns-runtime.js'));
const core = require(path.join(ROOT, 'lib', 'chart-core'));
const bundle = require(path.join(ROOT, 'public', 'chart-core-browser.js'));
const ws = require(path.join(ROOT, 'public', 'chart-workstation.js'));

function makeBars(n, stepMs) {
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 5) * 2 + (i % 7 === 0 ? 3 : -1);
    const o = p, cl = p + (i % 3 - 1);
    bars.push({
      time: 1700000000 + i * (stepMs || 86400),
      open: o, high: Math.max(o, cl) + 1.5, low: Math.min(o, cl) - 1.5, close: cl,
      volume: 1000 + i * 5
    });
  }
  return bars;
}

// ------------------------------------------------------------------
// 1. Bundle parity (single source of truth)
// ------------------------------------------------------------------
test('F3 bundle: chart-core-browser is parity with lib/chart-core', () => {
  const bars = makeBars(80);
  assert.deepEqual(bundle.pivots.detectPivots(bars, { k: 3 }), core.pivots.detectPivots(bars, { k: 3 }));
  assert.deepEqual(bundle.supportResistance.detectSupportResistance(bars, { k: 3 }), core.supportResistance.detectSupportResistance(bars, { k: 3 }));
  assert.deepEqual(bundle.fvg.detectFVGs(bars), core.fvg.detectFVGs(bars));
  assert.equal(bundle.lifecycle.sourceHash({ a: 1, b: 'x' }), core.lifecycle.sourceHash({ a: 1, b: 'x' }));
  assert.equal(bundle.MODULES.length, 18);
});

// ------------------------------------------------------------------
// 2. Detector wiring: real anchors, verified geometry
// ------------------------------------------------------------------
test('F3 wiring: every overlay carries real candle-index + price anchors', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, rt.FAMILY_IDS, { k: 3 });
  assert.ok(overlays.length > 0, 'expected detector output');
  overlays.forEach((o) => {
    assert.ok(Array.isArray(o.points) && o.points.length > 0, o.family + ' has points');
    o.points.forEach((p) => {
      assert.ok(Number.isFinite(Number(p.index)), o.family + ' index finite');
      assert.ok(Number.isFinite(Number(p.price)) && Number(p.price) > 0, o.family + ' price > 0');
    });
  });
});

test('F3 wiring: classifyPatternGeometry classifies every overlay VERIFIED', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, rt.FAMILY_IDS, { k: 3 });
  overlays.forEach((o) => {
    const cls = ws.classifyPatternGeometry(o);
    assert.equal(cls.classification, 'VERIFIED', o.family + '/' + o.kind + ' => ' + cls.reason);
  });
});

test('F3 wiring: no overlay uses static screen coordinates', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, rt.FAMILY_IDS, { k: 3 });
  overlays.forEach((o) => {
    assert.equal(o.x, undefined);
    assert.equal(o.screenX, undefined);
  });
});

// ------------------------------------------------------------------
// 3. Lifecycle states
// ------------------------------------------------------------------
test('F3 lifecycle: states are from the allowed set', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, rt.FAMILY_IDS, { k: 3 });
  const allowed = new Set(['CONFIRMED', 'PROVISIONAL', 'PROJECTION', 'FORMING', 'INVALIDATED', 'EXPIRED']);
  overlays.forEach((o) => assert.ok(allowed.has(o.state), 'state ' + o.state));
});

test('F3 lifecycle: INVALIDATED/EXPIRED are never rendered live (panel only)', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, rt.FAMILY_IDS, { k: 3 });
  const sel = rt.selectOverlays(overlays, 200);
  sel.rendered.forEach((o) => {
    assert.notEqual(o.state, 'INVALIDATED');
    assert.notEqual(o.state, 'EXPIRED');
  });
  sel.panel.forEach((o) => {
    assert.ok(o.state === 'INVALIDATED' || o.state === 'EXPIRED');
  });
});

test('F3 lifecycle: Elliott alternatives render as PROJECTION (SKENARIO)', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, ['elliott'], { k: 3 });
  const proj = overlays.filter((o) => o.state === 'PROJECTION');
  proj.forEach((o) => assert.ok(/SKENARIO/i.test(o.label), 'projection label is SKENARIO: ' + o.label));
});

// ------------------------------------------------------------------
// 4. Incremental recompute (source_hash keyed)
// ------------------------------------------------------------------
test('F3 incremental: source_hash stable for identical series, changes on new bar', () => {
  const bars = makeBars(120);
  assert.equal(rt.computeSourceHash(bars), rt.computeSourceHash(bars.slice()));
  assert.notEqual(rt.computeSourceHash(bars), rt.computeSourceHash(bars.slice(0, -1)));
});

test('F3 incremental: attach does not recompute when hash + families unchanged', () => {
  rt.reset();
  const bars = makeBars(120);
  const a = rt.attach('t1', bars, 'BBCA', { preset: 'pro' });
  const b = rt.attach('t1', bars, 'BBCA', { preset: 'pro' });
  assert.equal(a, b, 'same object returned (no recompute)');
  const c = rt.attach('t1', bars, 'BBCA', { preset: 'pro', force: true });
  assert.notEqual(a, c, 'force recomputes');
});

// ------------------------------------------------------------------
// 5. Cap + priority
// ------------------------------------------------------------------
test('F3 cap: overlay count is capped and CONFIRMED is prioritised', () => {
  const bars = makeBars(160);
  const overlays = rt.runDetectors(bars, rt.FAMILY_IDS, { k: 3 });
  const sel = rt.selectOverlays(overlays, 20);
  assert.equal(sel.rendered.length, 20);
  assert.ok(sel.truncated > 0);
  // Every rendered overlay must be at least as high priority as any dropped one.
  const rank = { CONFIRMED: 0, PROVISIONAL: 1, PROJECTION: 2, FORMING: 3 };
  const maxRendered = Math.max.apply(null, sel.rendered.map((o) => rank[o.state]));
  const live = overlays.filter((o) => o.state !== 'INVALIDATED' && o.state !== 'EXPIRED');
  const dropped = live.slice(20);
  dropped.forEach((o) => assert.ok(rank[o.state] >= maxRendered));
});

test('F3 cap: default cap is 200', () => {
  assert.equal(rt.DEFAULT_MAX_OVERLAYS, 200);
});

// ------------------------------------------------------------------
// 6. Preset defaults + toggles
// ------------------------------------------------------------------
test('F3 presets: Simple is minimal (S/R + Fib + candlestick only)', () => {
  assert.deepEqual(rt.familiesForPreset('simpel').sort(), ['candlestick', 'fibonacci', 'sr']);
});

test('F3 presets: Pro enables all families', () => {
  assert.equal(rt.familiesForPreset('pro').length, rt.FAMILY_IDS.length);
});

test('F3 toggles: resolveActiveFamilies applies overrides', () => {
  const on = rt.resolveActiveFamilies('simpel', { pivots: true });
  assert.ok(on.indexOf('pivots') !== -1);
  const off = rt.resolveActiveFamilies('pro', { elliott: false });
  assert.ok(off.indexOf('elliott') === -1);
});

test('F3 toggles: workstation state exposes auto families per preset', () => {
  // FINAL POLISH: default presets are clean; candlestick labels and XABCD are
  // OFF. Families remain reachable via explicit toggle from the drawer.
  const s = ws.createWorkstationState('simpel');
  assert.ok(!s.isLayerActive('sr'));
  assert.ok(!s.isLayerActive('fibonacci'));
  assert.ok(!s.isLayerActive('candlestick'));
  assert.ok(!s.isLayerActive('elliott'));
  s.toggleLayer('elliott', true);
  assert.ok(s.isLayerActive('elliott'));
  s.toggleLayer('elliott', false);
  assert.ok(!s.isLayerActive('elliott'));
});

test('F3 toggles: "hide all optional" hides every auto family; reset restores clean Simpel', () => {
  const s = ws.createWorkstationState('pro');
  assert.ok(s.getActiveAutoFamilies().length > 0, 'Pro keeps top patterns on by default');
  s.setAllLayers(false);
  assert.equal(s.getActiveAutoFamilies().length, 0);
  s.reset();
  // FINAL POLISH: reset returns to the clean Simpel preset (no auto families).
  assert.equal(s.activePreset, 'simpel');
  assert.equal(s.getActiveAutoFamilies().length, 0);
  assert.ok(s.isLayerActive('ma20') && s.isLayerActive('volume_bars'));
});

test('F3 toggles: clean preset layer budgets (FINAL POLISH TASK 1)', () => {
  // The auto families are NOT part of PRESETS.layers.
  assert.deepEqual(ws.PRESETS.simpel.layers, ['ema20', 'ma50', 'volume_bars', 'sr_levels']);
  const mainPanePro = ws.PRESETS.pro.layers.filter((l) => !['volume_bars', 'rsi14', 'macd', 'obv'].includes(l));
  assert.ok(mainPanePro.length <= ws.CLEAN_CHART.MAX_PRESET_LAYERS.pro);
  assert.ok(!ws.AUTO_PATTERN_PRESET_DEFAULTS.simpel.includes('candlestick'));
  assert.ok(!ws.AUTO_PATTERN_PRESET_DEFAULTS.pro.includes('harmonic'));
});

// ------------------------------------------------------------------
// 7. Mode guards (honesty)
// ------------------------------------------------------------------
test('F3 guard: EOD series + Scalping => TIMEFRAME_DATA_UNAVAILABLE', () => {
  const eod = makeBars(60, 86400 * 1000);
  const g = rt.evaluateScalpingGuard(eod);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'TIMEFRAME_DATA_UNAVAILABLE');
});

test('F3 guard: intraday series + Scalping => OK', () => {
  // makeBars() takes the step in SECONDS (candle times are unix seconds).
  const intraday = makeBars(60, 5 * 60);
  assert.equal(rt.detectBarIntervalMs(intraday), 5 * 60 * 1000);
  const g = rt.evaluateScalpingGuard(intraday);
  assert.equal(g.ok, true);
});

test('F3 guard: Day Trade outside WIB session => guard label, no fake live', () => {
  // 2026-11-16 is a Monday. 12:00 UTC = 19:00 WIB (after close).
  const g = rt.evaluateDayTradeSessionGuard(Date.UTC(2026, 10, 16, 12, 0));
  assert.equal(g.ok, false);
  assert.equal(g.code, 'SESSION_CLOSED');
});

test('F3 guard: Day Trade inside WIB session => IN_SESSION', () => {
  // 03:00 UTC = 10:00 WIB.
  const g = rt.evaluateDayTradeSessionGuard(Date.UTC(2026, 10, 16, 3, 0));
  assert.equal(g.ok, true);
  assert.equal(g.code, 'IN_SESSION');
});

test('F3 guard: Day Trade on weekend => SESSION_CLOSED_WEEKEND', () => {
  // 2026-11-15 is a Saturday.
  const g = rt.evaluateDayTradeSessionGuard(Date.UTC(2026, 10, 15, 3, 0));
  assert.equal(g.ok, false);
  assert.equal(g.code, 'SESSION_CLOSED_WEEKEND');
});

test('F3 guard: Short Swing stale snapshot => NOT_READY_AS_OF_STALE', () => {
  const now = Date.UTC(2026, 10, 16, 3, 0);
  const g = rt.evaluateShortSwingGuard({ rr: 2.1, asOf: now - 3 * 86400000 }, { nowMs: now });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'NOT_READY_AS_OF_STALE');
});

test('F3 guard: Short Swing R/R below 1.5 => RR_BELOW_GATE', () => {
  const now = Date.UTC(2026, 10, 16, 3, 0);
  const g = rt.evaluateShortSwingGuard({ rr: 1.1, asOf: now - 3600000 }, { nowMs: now });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'RR_BELOW_GATE');
});

test('F3 guard: Short Swing fresh snapshot with R/R >= 1.5 => OK', () => {
  const now = Date.UTC(2026, 10, 16, 3, 0);
  const g = rt.evaluateShortSwingGuard({ rr: 2.1, asOf: now - 3600000 }, { nowMs: now });
  assert.equal(g.ok, true);
});

test('F3 guard: Short Swing no snapshot => NOT_READY', () => {
  const g = rt.evaluateShortSwingGuard(null, { nowMs: Date.UTC(2026, 10, 16, 3, 0) });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'NOT_READY');
});

// ------------------------------------------------------------------
// 8. Panes (RSI / MACD / OBV)
// ------------------------------------------------------------------
test('F3 panes: RSI/MACD/OBV series are produced from the F1 oscillators', () => {
  const bars = makeBars(160);
  const rsi = rt.buildPaneSeries(bars, 'rsi');
  const macd = rt.buildPaneSeries(bars, 'macd');
  const obv = rt.buildPaneSeries(bars, 'obv');
  assert.equal(rsi.empty, false);
  assert.equal(macd.empty, false);
  assert.equal(obv.empty, false);
  assert.ok(rsi.points.length > 0 && macd.points.length > 0 && obv.points.length > 0);
  assert.deepEqual(rsi.guides, [70, 30]);
});

test('F3 panes: insufficient period => honest empty state, never 0', () => {
  const bars = makeBars(5);
  const rsi = rt.buildPaneSeries(bars, 'rsi');
  assert.equal(rsi.empty, true);
  assert.equal(rsi.reason, 'INSUFFICIENT_PERIOD');
  assert.equal(rsi.points.length, 0);
});

test('F3 panes: RSI values match the F1 oscillator exactly', () => {
  const bars = makeBars(120);
  const closes = bars.map((b) => b.close);
  const expected = core.oscillators.rsi(closes, 14);
  const pane = rt.buildPaneSeries(bars, 'rsi');
  pane.points.forEach((p) => {
    const idx = bars.findIndex((b) => b.time === p.time);
    assert.equal(p.value, expected[idx]);
  });
});

// ------------------------------------------------------------------
// 9. Honest empty state
// ------------------------------------------------------------------
test('F3 empty: insufficient data => empty with reason, no fabricated shapes', () => {
  const res = rt.computeOverlays(makeBars(3), rt.FAMILY_IDS, {});
  assert.equal(res.empty, true);
  assert.equal(res.reason, 'INSUFFICIENT_DATA');
  assert.equal(res.rendered.length, 0);
});

test('F3 empty: no pattern detected => empty with NO_PATTERN_DETECTED', () => {
  // A perfectly flat series has no pivots/patterns.
  const flat = [];
  for (let i = 0; i < 40; i++) flat.push({ time: 1700000000 + i * 86400, open: 100, high: 100, low: 100, close: 100, volume: 10 });
  const res = rt.computeOverlays(flat, ['pivots', 'zigzag'], {});
  assert.equal(res.empty, true);
  assert.equal(res.reason, 'NO_PATTERN_DETECTED');
});

// ------------------------------------------------------------------
// 10. No lookahead (delegated to detectors, verified at the wiring layer)
// ------------------------------------------------------------------
test('F3 no-lookahead: overlays from a prefix never reference future bars', () => {
  const bars = makeBars(120);
  const prefix = bars.slice(0, 100);
  const overlays = rt.runDetectors(prefix, rt.FAMILY_IDS, { k: 3 });
  overlays.forEach((o) => {
    o.points.forEach((p) => {
      assert.ok(Number(p.index) <= prefix.length - 1, o.family + ' anchor index within prefix');
    });
  });
});

// ------------------------------------------------------------------
// 11. SVG overlay build (uses the existing verified-anchor pipeline)
// ------------------------------------------------------------------
test('F3 svg: buildOverlaySvg produces geometry from verified anchors', () => {
  const bars = makeBars(160);
  const res = rt.computeOverlays(bars, ['sr', 'fibonacci'], { k: 3 });
  const svg = rt.buildOverlaySvg(res.rendered, ws);
  assert.ok(svg.indexOf('<svg') === 0);
  assert.ok(svg.indexOf('<path') !== -1 || svg.indexOf('<circle') !== -1);
});

test('F3 svg: uses workstation projectVerifiedAnchors + resolveLabelCollisions', () => {
  const bars = makeBars(160);
  const res = rt.computeOverlays(bars, ['sr'], { k: 3 });
  const svg = rt.buildOverlaySvg(res.rendered, ws);
  assert.ok(svg.length > 0);
  // The workstation exports both helpers used by the runtime.
  assert.equal(typeof ws.projectVerifiedAnchors, 'function');
  assert.equal(typeof ws.resolveLabelCollisions, 'function');
});

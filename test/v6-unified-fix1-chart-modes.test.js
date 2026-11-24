'use strict';

/**
 * UNIFIED FINAL WAVE / FIX 1 — 5 distinct clean chart modes + visual polish.
 *
 * Pure/static regression contract: no network, no paid provider, no DB writes.
 * Every assertion checks real canonical-data wiring, honest EOD handling,
 * IHSG safety, toolbar geometry and mobile mode-bar readability.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const W = require(path.join(ROOT, 'public', 'chart-workstation.js'));
const A = require(path.join(ROOT, 'public', 'chart-auto-patterns-runtime.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODES = ['simpel', 'scalping', 'swing', 'investor', 'pro'];

/* ------------------------------------------------------------------ */
/* 1. Five distinct mode configs                                       */
/* ------------------------------------------------------------------ */

test('FIX1: exactly 5 distinct clean chart mode configs', () => {
  assert.ok(W.CHART_MODES, 'CHART_MODES contract exported');
  assert.deepEqual(Object.keys(W.CHART_MODES), MODES);
  const signatures = MODES.map((m) => {
    const c = W.CHART_MODES[m];
    return JSON.stringify([c.candleIndicators, c.sr, c.patterns, c.subpanes]);
  });
  assert.equal(new Set(signatures).size, 5, 'all five modes must be visually distinct');
  for (const m of MODES) {
    assert.equal(W.CHART_MODES[m].id, m);
    assert.equal(W.CHART_MODES[m].volumeOnRightAxis, false, m + ': no volume number on right price axis');
  }
});

test('FIX1: Simpel = Candle + EMA20 + MA50 + exactly 1 S/R + Volume', () => {
  const c = W.CHART_MODES.simpel;
  assert.deepEqual([...c.candleIndicators], ['ema20', 'ma50']);
  assert.equal(c.sr.maxLevels, 1);
  assert.equal(c.sr.structural, false);
  assert.deepEqual([...c.subpanes], ['volume']);
  assert.equal(c.patterns.maxMarkers, 0);
});

test('FIX1: Scalping = EMA9/EMA21 + BB(20,2) + <=2 S/R + <=2 markers + Volume/RSI14', () => {
  const c = W.CHART_MODES.scalping;
  assert.deepEqual([...c.candleIndicators], ['ema9', 'ema21', 'bollinger20_2']);
  assert.equal(c.sr.maxLevels, 2);
  assert.equal(c.patterns.maxMarkers, 2);
  assert.deepEqual([...c.subpanes], ['volume', 'rsi14']);
  assert.deepEqual([...c.rsiGuides], [30, 70]);
  assert.equal(c.eodBadge.label, 'Data Harian EOD');
  assert.equal(c.eodBadge.code, 'TIMEFRAME_DATA_UNAVAILABLE');
  assert.deepEqual([...c.intradayTimeframes], ['1m', '3m', '5m']);
});

test('FIX1: Swing = EMA20/MA50/MA200 + 2-3 structural S/R + Fib/zones + Volume/MACD/RSI', () => {
  const c = W.CHART_MODES.swing;
  assert.deepEqual([...c.candleIndicators], ['ema20', 'ma50', 'ma200']);
  assert.equal(c.sr.minLevels, 2);
  assert.equal(c.sr.maxLevels, 3);
  assert.equal(c.sr.structural, true);
  assert.deepEqual([...c.structure.fibonacci], [0.382, 0.5, 0.618]);
  assert.equal(c.structure.mode, 'fibonacci_or_zones');
  assert.deepEqual([...c.subpanes], ['volume', 'macd', 'rsi14']);
  assert.ok(c.patterns.maxMarkers <= 2);
});

test('FIX1: Investor = MA50/100/200 + major S/R + macro trendline + Volume/Foreign/OBV', () => {
  const c = W.CHART_MODES.investor;
  assert.deepEqual([...c.candleIndicators], ['ma50', 'ma100', 'ma200']);
  assert.equal(c.sr.major, true);
  assert.equal(c.structure.macroTrendline, true);
  assert.deepEqual([...c.subpanes], ['volume', 'foreign_flow', 'obv']);
  assert.equal(c.foreignFlowSource, 'arjum_broker_summary_all/foreign');
  assert.equal(c.defaultTimeframe, '1T');
  assert.ok(c.allowedTimeframes.includes('6B'));
});

test('FIX1: Pro = EMA20/MA50/BB + main S/R + <=3 patterns + Volume/RSI/MACD/Bandar/OBV', () => {
  const c = W.CHART_MODES.pro;
  assert.deepEqual([...c.candleIndicators], ['ema20', 'ma50', 'bollinger20_2']);
  assert.ok(c.patterns.maxMarkers >= 1 && c.patterns.maxMarkers <= 3);
  assert.equal(c.patterns.allFamiliesManual, true);
  assert.deepEqual([...c.subpanes], ['volume', 'rsi14', 'macd', 'bandar_foreign', 'obv']);
  assert.equal(c.volumeOnRightAxis, false);
});

test('FIX1: all 14 detector families remain available manually in Pro drawer', () => {
  assert.equal(W.AUTO_PATTERN_FAMILIES.length, 14);
  assert.equal(W.CHART_MODES.pro.patterns.allFamiliesManual, true);
  const drawer = W.renderDrawerHtml('c1');
  for (const f of W.AUTO_PATTERN_FAMILIES) {
    assert.ok(drawer.includes(f), 'drawer exposes family ' + f);
  }
});

/* ------------------------------------------------------------------ */
/* 2. Real canonical data only                                         */
/* ------------------------------------------------------------------ */

test('FIX1: indicators are computed from real OHLCV, no fake volume/price', () => {
  const candles = [];
  for (let i = 0; i < 220; i++) {
    candles.push({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: 5000 + i, high: 5020 + i, low: 4980 + i, close: 5010 + i, volume: 1000000 + i
    });
  }
  const ema9 = W.calculateEMA(candles, 9);
  const ema21 = W.calculateEMA(candles, 21);
  const bb = W.calculateBollinger(candles, 20, 2);
  const rsi = W.calculateRSI(candles, 14);
  const macd = W.calculateMACD(candles, 12, 26, 9);
  assert.ok(ema9.length > ema21.length, 'EMA9 has more points than EMA21');
  assert.ok(bb.upper.length > 0 && bb.lower.length > 0);
  assert.ok(rsi.length > 0 && rsi.every((p) => p.value >= 0 && p.value <= 100));
  assert.ok(macd.macd.length > 0 && macd.signal.length > 0);
  // Every point is anchored to a real candle time and a finite computed value.
  for (const p of ema9.concat(ema21, bb.upper, rsi, macd.macd)) {
    assert.ok(candles.some((c) => c.time === p.time), 'indicator time is a real candle');
    assert.ok(Number.isFinite(p.value), 'indicator value is finite');
  }
  const ff = W.calculateForeignFlowCumulative(candles, [{ date: candles[0].time, foreign_net: 1000 }]);
  assert.ok(ff.length > 0 && ff.every((p) => Number.isFinite(p.value)), 'foreign flow from real series');
});

test('FIX1: no hardcoded fake volume/price literals in chart runtime', () => {
  for (const f of ['public/chart-workstation.js', 'public/market-feature-runtime.js', 'public/chart-auto-patterns-runtime.js']) {
    const src = read(f);
    assert.ok(!/12,35 Jt|12\.35 Jt|Volume 12,35/.test(src), f + ' has no fake volume literal');
  }
});

/* ------------------------------------------------------------------ */
/* 3. Forbidden artifacts / IHSG safety                                */
/* ------------------------------------------------------------------ */

test('FIX1: no forbidden visual artifacts in any mode overlay', () => {
  const candles = [];
  for (let i = 0; i < 120; i++) {
    candles.push({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: 5000 + i, high: 5020 + i, low: 4980 + i, close: 5010 + i, volume: 1000000 + i
    });
  }
  const banned = ['V4-F10', 'Harmonic XABCD & SMC', 'data-hud', '>SELL<', '>BUY<', 'data-ob-badge', 'green carpet', 'random diagonal mesh'];
  for (const mode of MODES) {
    const ov = W.buildV3F09Overlay('BBCA', candles, mode, 'dark');
    for (const term of banned) {
      assert.ok(!ov.svg.includes(term), mode + ' overlay must not contain ' + term);
    }
  }
});

test('FIX1: IHSG/^JKSE remains locked clean macro index', () => {
  const candles = [];
  for (let i = 0; i < 120; i++) {
    candles.push({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: 5000 + i, high: 5020 + i, low: 4980 + i, close: 5010 + i, volume: 1000000 + i
    });
  }
  const banned = ['V4-F10', 'Harmonic XABCD', 'Area Beli', 'Entry', 'SL', 'TP1', 'TP2', 'Lot', 'Profit Calculator', '>SELL<', '>BUY<', 'data-hud', 'data-xabcd'];
  for (const ticker of ['IHSG', '^JKSE', 'JKSE', 'JCI', 'COMPOSITE']) {
    for (const mode of MODES) {
      const ov = W.buildV3F09Overlay(ticker, candles, mode, 'dark');
      assert.equal(ov.mode, 'index', ticker + ' forced to clean index mode');
      for (const term of banned) {
        assert.ok(!ov.svg.includes(term), ticker + '/' + mode + ' must not contain ' + term);
      }
    }
  }
  assert.equal(W.isIndexTicker('IHSG'), true);
  assert.equal(W.isIndexTicker('^JKSE'), true);
  assert.equal(W.isIndexTicker('BBCA'), false);
});

/* ------------------------------------------------------------------ */
/* 4. EOD header / toolbar / swing labels / mobile                     */
/* ------------------------------------------------------------------ */

test('FIX1: EOD header has no fake 00:00 UTC -> 07.00 WIB conversion', () => {
  assert.equal(W.formatEodHeader('2026-11-20'), 'EOD · 20 Nov 2026');
  assert.ok(!W.formatEodHeader('2026-11-20').includes('07.00'));
  assert.ok(!W.formatEodHeader('2026-11-20').includes('00:00'));
  assert.ok(!W.formatEodHeader('2026-11-20').includes('UTC'));
  // Real updated_at may add a real WIB clock time, never from the date alone.
  assert.equal(W.formatEodHeader('2026-11-20', '2026-11-20T10:30:00Z'), 'EOD · 20 Nov 2026 · diperbarui 17.30 WIB');
  const mfr = read('public/market-feature-runtime.js');
  assert.match(mfr, /formatEodHeader/, 'canvas header uses honest EOD formatter');
  assert.ok(!/07\.00 WIB/.test(mfr), 'no fake 07.00 WIB in chart runtime');
});

test('FIX1: drawing toolbar has >=5 separate pill buttons', () => {
  const dt = read('public/chart-drawing-tools.js');
  assert.match(dt, /display:inline-flex/, 'toolbar is inline-flex');
  assert.match(dt, /gap:\s*6px/, '6px pill gap');
  assert.match(dt, /padding:\s*4px 8px/, '4px 8px pill padding');
  assert.match(dt, /border-radius:\s*6px/, '6px pill radius');
  assert.match(dt, /overflow-x:auto/, 'mobile horizontal scroll');
  const css = read('public/ac-v2.css');
  assert.match(css, /\.ac-draw-toolbar\s*\{[^}]*display:\s*inline-flex/, 'CSS inline-flex');
  assert.match(css, /\.ac-draw-toolbar\s*\{[^}]*gap:\s*6px/, 'CSS 6px gap');
  assert.match(css, /\.ac-draw-toolbar\s*\.ac-draw-btn\s*\{[^}]*padding:\s*4px 8px/, 'CSS pill padding');
  // 5 tools (TOOLS array) + Hapus + Bersihkan = 7 rendered pill buttons.
  const DT = require(path.join(ROOT, 'public', 'chart-drawing-tools.js'));
  const toolCount = DT.TOOLS.length + 2;
  assert.ok(toolCount >= 5, 'toolbar has >=5 pill buttons (was ' + toolCount + ')');
  assert.match(dt, /data-action="delete"/, 'Hapus pill rendered');
  assert.match(dt, /data-action="clear"/, 'Bersihkan pill rendered');
});

test('FIX1: swing high/low labels clipped within main candle pane', () => {
  const mfr = read('public/market-feature-runtime.js');
  assert.match(mfr, /FIX 1: swing high\/low labels are clipped to the MAIN CANDLE PANE/, 'clipping contract documented');
  assert.match(mfr, /clipPath\s*=\s*'inset\(0 0 0 0\)'/, 'labels clipped to pane');
  assert.match(mfr, /ty \+ labelH > h/, 'vertical clamp to pane height');
  assert.match(mfr, /'▲ ' \+ fmt/, 'high label retained');
  assert.match(mfr, /'▼ ' \+ fmt/, 'low label retained');
});

test('FIX1: mobile 390x844 mode bar keeps Investor unclipped', () => {
  const css = read('public/ac-v2.css');
  assert.match(css, /@media \(max-width: 430px\)/, '390px breakpoint present');
  assert.match(css, /\.cw-seg button \{ height: 32px; padding: 0 7px; font-size: 11px;/, 'compact mode buttons');
  assert.match(css, /\.cw-seg \{ display: inline-flex; flex-wrap: nowrap; overflow-x: auto;/, 'mode bar scrolls instead of clipping');
  const bar = W.renderToolbarHtml('c1');
  assert.match(bar, />Investor</, 'Investor button present');
  assert.match(bar, />Pro</, 'Pro button present');
  assert.ok(bar.indexOf('>Investor<') < bar.indexOf('>Pro<'), 'Investor precedes Pro');
});

test('FIX1: Scalping intraday TF with EOD-only data shows honest badge', () => {
  const eod = [
    { time: '2026-11-18', open: 1, high: 2, low: 1, close: 2, volume: 100 },
    { time: '2026-11-19', open: 2, high: 3, low: 2, close: 3, volume: 100 }
  ];
  for (const tf of ['1m', '3m', '5m']) {
    const g = A.evaluateScalpingGuard(eod, tf);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'TIMEFRAME_DATA_UNAVAILABLE');
    assert.equal(g.badge, 'Data Harian EOD');
  }
  const ok = A.evaluateScalpingGuard([
    { time: '2026-11-20T09:00:00', close: 1 },
    { time: '2026-11-20T09:05:00', close: 2 }
  ], '5m');
  assert.equal(ok.ok, true);
});

test('FIX1: real numeric legends in pane corners', () => {
  const mfr = read('public/market-feature-runtime.js');
  assert.match(mfr, /RSI14 ' \+ _rsiLast\.toFixed\(2\) \+ ' \(30\/70\)/, 'RSI active value + guides in legend');
  assert.match(mfr, /MACD ' \+ _macdLast\.toFixed\(2\)/, 'MACD real value in legend');
  assert.match(mfr, /Foreign kumulatif/, 'foreign flow real value in legend');
  const apr = read('public/chart-auto-patterns-runtime.js');
  assert.match(apr, /FIX 1: real numeric legend in the pane corner/, 'OBV/RSI/MACD pane legend from real series');
});

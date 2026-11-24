'use strict';

/**
 * LOCAL BATCH 1 of the final V6 sweep.
 * BUG 1: five chart modes share one layout contract; toolbar labels unique;
 *        deterministic right-axis badges; no default scenario projection;
 *        stable chart anchor; mobile 2-line legend.
 * BUG 2: chart plan math is the canonical acCanonicalTradePlan object across
 *        all tick tiers and all five modes; R/R and profit after rounding.
 * BUG 3: Watchlist quotes come from canonical local snapshots only; no mock
 *        prices in the user-visible path; honest unknown state.
 *
 * Pure local tests: no network, no DB writes, no paid provider, no Telegram.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const W = require(path.join(ROOT, 'public', 'chart-workstation.js'));
const idx = require(path.join(ROOT, 'lib', 'idx-tick.js'));
const acPlan = require(path.join(ROOT, 'public', 'ac-trade-plan.js'));
const watchlist = require(path.join(ROOT, 'lib', 'user-watchlist-service.js'));

const MODES = ['simpel', 'scalping', 'swing', 'investor', 'pro'];

function candlesAt(close, n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: close, high: close + 10, low: close - 10, close, volume: 1000000
    });
  }
  return out;
}

/* ---------------- BUG 1 ---------------- */

test('BATCH1 BUG1: all five modes share the CLEAN_CHART layout contract', () => {
  assert.ok(W.CLEAN_CHART.MODE_LAYOUT, 'shared layout contract exported');
  assert.equal(W.CLEAN_CHART.MAX_RIGHT_AXIS_BADGES, 4);
  for (const mode of MODES) {
    const c = W.CHART_MODES[mode];
    const l = c.layout;
    assert.ok(l, mode + ' has layout');
    assert.ok(l.priceDesktop >= 360, mode + ' desktop price >= 360px');
    assert.ok(l.priceMobile >= 360, mode + ' mobile price >= 360px');
    for (const sub of c.subpanes) {
      assert.ok(l.subpanes[sub] > 0, mode + ' declares height for ' + sub);
    }
  }
  assert.equal(W.CHART_MODES.simpel.layout.subpanes.volume, 90);
  assert.equal(W.CHART_MODES.scalping.layout.subpanes.rsi14, 110);
  assert.equal(W.CHART_MODES.investor.defaultTimeframe, '1T');
  assert.ok(W.CHART_MODES.investor.allowedTimeframes.includes('6B'));
});

test('BATCH1 BUG1: chartDims consumes the shared layout and stays mobile-safe', () => {
  const mfr = read('public/market-feature-runtime.js');
  assert.match(mfr, /function chartDims\(variant, viewportWidth, viewportHeight, mode\)/);
  assert.match(mfr, /CLEAN_CHART\.MODE_LAYOUT/);
  assert.match(mfr, /chartDims\(variant,[\s\S]*?_activeMode\)/);
  // Isolated vm copy: no window, so the inline fallback applies.
  const start = mfr.indexOf('function chartDims(');
  const brace = mfr.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = brace; i < mfr.length; i++) {
    if (mfr[i] === '{') depth++;
    else if (mfr[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const sandbox = { Math, Number, String, Object };
  require('node:vm').createContext(sandbox);
  require('node:vm').runInContext(mfr.slice(start, end) + '\nthis.chartDims=chartDims;', sandbox);
  assert.ok(sandbox.chartDims('page', 390).main > 270);
  assert.ok(sandbox.chartDims('page', 390).main <= 390);
  assert.ok(sandbox.chartDims('page', 1440).main >= 360);
});

test('BATCH1 BUG1: toolbar labels are unique and no duplicate Garis', () => {
  const dt = read('public/chart-drawing-tools.js');
  assert.match(dt, /trendline: 'Garis Tren'/);
  assert.match(dt, /hline: 'Garis Datar'/);
  assert.match(dt, /fib: 'Fibonacci'/);
  assert.match(dt, /ruler: 'Penggaris'/);
  assert.match(dt, /freehand: 'Gambar'/);
  assert.match(dt, /var pill = TOOL_LABELS\[t\] \|\| t;/);
  assert.ok(!/trendline: 'Garis', hline: 'Garis'/.test(dt));
  for (const label of ['Garis Tren', 'Garis Datar', 'Fibonacci', 'Penggaris', 'Gambar', 'Hapus', 'Bersihkan']) {
    assert.ok(dt.includes(label), 'toolbar label ' + label);
  }
});

test('BATCH1 BUG1: right-axis badge budget is deterministic, no parity fallback', () => {
  const ws = read('public/chart-workstation.js');
  assert.match(ws, /MAX_RIGHT_AXIS_BADGES: 4/);
  assert.match(ws, /axisLabelVisible: axisLabelVisible/);
  assert.ok(!/axisLabelVisible: !isColliding \|\| \(j % 2 === 0\)/.test(ws));
  const series = { lines: [], createPriceLine(o) { this.lines.push(o); return {}; } };
  W.applyPlanPriceLines(series, { entry: 1000, sl: 950, tp1: 1100, tp2: 1150 });
  const visible = series.lines.filter(l => l.axisLabelVisible);
  assert.ok(visible.length <= 4, 'max 4 right-axis badges, got ' + visible.length);
  assert.ok(!series.lines.some(l => /volume/i.test(String(l.title))), 'no volume number on right axis');
});

test('BATCH1 BUG1: no default Proyeksi Skenario / ZigZag text spam', () => {
  const candles = candlesAt(5000, 120);
  for (const mode of MODES) {
    const ov = W.buildV3F09Overlay('BBCA', candles, mode, 'dark');
    assert.ok(!ov.svg.includes('Proyeksi Skenario'), mode + ' has no default scenario projection');
    assert.ok(!ov.svg.includes('data-projection'), mode + ' has no projection marker');
  }
});

test('BATCH1 BUG1: stable chart anchor id near unifiedChartContainer', () => {
  const html = read('public/index.html');
  assert.match(html, /id="chart-workstation"/);
  assert.match(html, /id="unifiedChartContainer"[^>]*data-chart-anchor="chart-workstation"/);
  assert.match(html, /Chart Interaktif ' \+ ticker/);
});

test('BATCH1 BUG1: mobile legend is compact 2-line with no Vol/Par F collision', () => {
  const mfr = read('public/market-feature-runtime.js');
  assert.match(mfr, /BATCH 1 \/ BUG 1: exactly 2 compact lines/);
  assert.match(mfr, /flex-nowrap justify-between gap-2/);
  assert.match(mfr, /<span>Vol <b/);
  assert.match(mfr, /<span>Par F <b/);
});

/* ---------------- BUG 2 ---------------- */

const TIERS = [
  { price: 150, tick: 1 }, { price: 300, tick: 2 }, { price: 600, tick: 5 },
  { price: 3000, tick: 10 }, { price: 6000, tick: 25 }
];

test('BATCH1 BUG2: canonical tick tiers are exact', () => {
  for (const t of TIERS) {
    assert.equal(idx.idxTickSize(t.price), t.tick, String(t.price));
    assert.equal(W.getIdxTickSize(t.price), t.tick, 'workstation adapter ' + t.price);
  }
  assert.equal(W.getIdxTickSize(6000, null, true), 1, 'FCA tick 1');
  assert.equal(W.getIdxTickSize(6000, 'AKSELERASI'), 1, 'Akselerasi tick 1');
});

test('BATCH1 BUG2: chart plan equals canonical plan across all tiers and modes', () => {
  for (const t of TIERS) {
    for (const mode of MODES) {
      const p = W.calculateTradingPlan(candlesAt(t.price), {
        entry: t.price + 1, sl: t.price - 21, tp1: t.price + 101, tp2: t.price + 201, lots: 10
      }, mode, '1D');
      assert.ok(p, 'plan exists @' + t.price + '/' + mode);
      for (const key of ['entry', 'sl', 'tp1', 'tp2']) {
        assert.ok(idx.isIdxTickValid(p[key]), mode + ' ' + key + ' off-tick @' + t.price + ': ' + p[key]);
      }
      assert.ok(p.sl < p.entry && p.entry < p.tp1 && p.tp1 < p.tp2, 'ordering @' + t.price + '/' + mode);
      assert.equal(p.rrRatio, Number(idx.rrFromLevels(p.entry, p.sl, p.tp1).toFixed(2)), 'R/R from rounded levels @' + t.price + '/' + mode);
      assert.equal(p.canonical.entry_high, p.entry, 'chart plan uses canonical object @' + t.price);
      assert.equal(p.canonical.sl, p.sl);
      assert.equal(p.canonical.tp1, p.tp1);
      assert.equal(p.canonical.tp2, p.tp2);
      const expectedNet = Math.round(
        (p.tp1 - p.entry) * 5 * 100 + (p.tp2 - p.entry) * 5 * 100 -
        (p.entry * 10 * 100 * 0.0015 + p.tp1 * 5 * 100 * 0.0025 + p.tp2 * 5 * 100 * 0.0025)
      );
      assert.equal(p.scaleOut.netProfit, expectedNet, 'profit uses rounded levels @' + t.price + '/' + mode);
    }
  }
});

test('BATCH1 BUG2: R/R >= 1.5 gate is enforced after rounding', () => {
  const p = W.calculateTradingPlan(candlesAt(1000), {
    entry: 1000, sl: 950, tp1: 1050, tp2: 1100, lots: 10
  }, 'swing', '1D');
  assert.ok(p.rrRatio < 1.5);
  assert.equal(p.isSafeRR, false);
  assert.match(p.warningMessage, /STATUS PANTAUAN/);
  const safe = W.calculateTradingPlan(candlesAt(1000), {
    entry: 1000, sl: 950, tp1: 1100, tp2: 1150, lots: 10
  }, 'swing', '1D');
  assert.equal(safe.isSafeRR, true);
  assert.equal(safe.rrRatio, 2);
});

test('BATCH1 BUG2: no duplicate local ladder remains in chart workstation', () => {
  const ws = read('public/chart-workstation.js');
  assert.match(ws, /canonicalPlanApi\(\)/);
  assert.match(ws, /acCanonicalTradePlan\(\{/);
  assert.ok(!/if \(p < 200\) return 1;\s*if \(p < 500\) return 2;/.test(ws), 'no duplicate ladder');
});

/* ---------------- BUG 3 ---------------- */

test('BATCH1 BUG3: Watchlist quotes are canonical, no mock values', async () => {
  const prices = await watchlist.batchFetchPricesForTickers(null, ['BBCA', 'BMRI', 'MEDC', 'ASII', 'UNKNOWNX']);
  assert.equal(prices.BBCA.last_price, 5550);
  assert.equal(prices.BMRI.last_price, 3890);
  assert.equal(prices.MEDC.last_price, 1155);
  assert.equal(prices.ASII.last_price, 5300);
  for (const t of ['BBCA', 'BMRI', 'MEDC', 'ASII']) {
    assert.match(prices[t].price_source, /^canonical_/);
    assert.ok(![10250, 6800, 1420, 5100].includes(prices[t].last_price), t + ' has no mock price');
  }
  assert.equal(prices.UNKNOWNX, undefined, 'unknown ticker stays unknown, no fallback');
});

test('BATCH1 BUG3: user-visible Watchlist shows honest unknown state', () => {
  const rt = read('public/watchlist-runtime.js');
  assert.match(rt, /absent canonical quote is UNKNOWN, never a mock price/);
  assert.match(rt, /hasCanonicalPrice \? Number\(item\.last_price\)\.toLocaleString\('id-ID'\) : '—'/);
  const svc = read('lib/user-watchlist-service.js');
  assert.match(svc, /canonical-daily-history-source\.js/);
  assert.match(svc, /canonical-screener-source\.js/);
  assert.match(svc, /canonical local snapshot \(no mock fallback\)/);
  assert.ok(!/MOCK_WATCHLIST/.test(svc));
});

test('BATCH1 BUG3: mock preview data carries canonical prices only', () => {
  const mock = require(path.join(ROOT, 'lib', 'mock-preview-data.js'));
  const wl = mock.MOCK_WATCHLIST.watchlist;
  const byTicker = Object.fromEntries(wl.map(r => [r.ticker, r.last_price]));
  assert.equal(byTicker.BBCA, 5550);
  assert.equal(byTicker.BMRI, 3890);
  assert.equal(byTicker.MEDC, 1155);
  assert.equal(byTicker.ASII, 5300);
  const snap = mock.MOCK_LANDING_SNAPSHOT.snapshot;
  assert.equal(snap.top5.find(r => r.ticker === 'BMRI').close, 3890);
  assert.equal(snap.top5.find(r => r.ticker === 'ASII').close, 5300);
  assert.equal(snap.dt_signals.find(r => r.ticker === 'MEDC').price, 1155);
});

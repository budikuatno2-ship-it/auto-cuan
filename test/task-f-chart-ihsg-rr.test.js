'use strict';

/**
 * TASK F focused regression coverage (offline, zero network, zero DB writes):
 *  1. Chart audit: 962/963 + IHSG, all detector families finite, ranges, presets.
 *  2. IHSG: no Area Beli/Entry/SL/TP1/TP2/Lot/Profit Calculator in API payload;
 *     index/macro indicator set distinct from stock plan.
 *  3. RR calibration: TP/SL/RR derived from real technical levels (support,
 *     resistance, ATR, swing structure), never a uniform rr=2; R/R >= 1.5 gate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const universe = require(path.join(ROOT, 'lib', 'short-swing-universe'));
const engine = require(path.join(ROOT, 'lib', 'saham-potensial-engine'));
const chartLevelBuilder = require(path.join(ROOT, 'lib', 'chart-level-builder'));
const bridge = require(path.join(ROOT, 'lib', 'b3-adaptive-bridge'));
const autoPatterns = require(path.join(ROOT, 'public', 'chart-auto-patterns-runtime'));

const CANDLE_DIR = path.join(ROOT, 'data', 'daily-candles');
function readBars(ticker) {
  const raw = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, ticker + '.json'), 'utf8'));
  return (raw.candles || []).map((c) => ({
    time: String(c.date).slice(0, 10), open: Number(c.open), high: Number(c.high),
    low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
  }));
}

/* ------------------------- 1. Chart audit invariants ---------------------- */
test('TASK F: all detector families + panes finite on representative tickers', () => {
  for (const ticker of ['BBCA', 'BBRI', 'GOTO', 'IHSG']) {
    const bars = readBars(ticker).slice(-260);
    const out = autoPatterns.runDetectors(bars, autoPatterns.FAMILY_IDS, {});
    assert.ok(Array.isArray(out), ticker + ' detectors returned array');
    for (const o of out) {
      assert.ok(!JSON.stringify(o).includes('null,null'), ticker + ' no NaN/null cascade');
    }
    for (const kind of ['rsi', 'macd', 'obv']) {
      const s = autoPatterns.buildPaneSeries(bars, kind);
      assert.ok(s.points.length > 0, ticker + ' ' + kind + ' has points');
    }
  }
});

test('TASK F: chart modes Simpel/Scalping/Swing/Investor/Pro differ in config', () => {
  const sigs = new Set();
  for (const p of ['simpel', 'scalping', 'swing', 'investor', 'pro']) {
    sigs.add(autoPatterns.familiesForPreset(p).slice().sort().join(','));
  }
  assert.ok(sigs.size >= 4, 'at least 4 distinct preset configurations');
});

/* --------------------------- 2. IHSG rules -------------------------------- */
test('TASK F: IHSG API payload has no Entry/SL/TP/Lot/Profit Calculator', () => {
  const bars = readBars('IHSG');
  const analysis = chartLevelBuilder.buildFullChartAnalysis(bars, 'IHSG', null, null, {});
  const canon = bridge.extractCanonical(analysis);
  assert.equal(analysis.isIndex, true);
  assert.equal(analysis.chartStatus, 'INDEX');
  assert.ok(analysis.ihsgPanel, 'IHSG panel present');
  assert.deepEqual(Object.keys(analysis.ihsgPanel.horizons), ['Harian', 'Mingguan', 'Bulanan']);
  for (const k of ['entry_low', 'entry_high', 'entry_ref', 'sl', 'tp1', 'tp2']) {
    assert.equal(canon[k], null, k + ' must be null in API payload');
  }
  // Scan STRING VALUES only — key names such as `entry_low` are internal
  // field names, never rendered text.
  function stringValues(obj, acc) {
    acc = acc || [];
    if (obj === null || obj === undefined) return acc;
    if (typeof obj === 'string') { acc.push(obj); return acc; }
    if (Array.isArray(obj)) { obj.forEach((v) => stringValues(v, acc)); return acc; }
    if (typeof obj === 'object') { Object.keys(obj).forEach((k) => stringValues(obj[k], acc)); return acc; }
    return acc;
  }
  const text = stringValues(canon).join(' \n ');
  for (const term of ['Area Beli', 'Entry', 'SL', 'TP1', 'TP2', 'Lot', 'Profit Calculator']) {
    assert.ok(!new RegExp('(^|[^A-Za-z])' + term + '([^A-Za-z]|$)', 'i').test(text), 'no ' + term);
  }
  assert.equal(analysis.trade_plan_v2, null);
  assert.equal(analysis.modes, null);
});

test('TASK F: IHSG aliases ^JKSE/JKSE/COMPOSITE normalize to index', () => {
  const chartApi = require(path.join(ROOT, 'api', 'chart'));
  for (const alias of ['IHSG', '^JKSE', 'JKSE', 'JCI', 'COMPOSITE']) {
    assert.equal(chartApi.normalizeTicker(alias), 'IHSG');
  }
});

/* --------------------------- 3. RR calibration ---------------------------- */
test('TASK F: buildPlanFromCandles derives TP/SL from real levels, not uniform rr=2', () => {
  const bars = readBars('BBCA').slice(-260);
  const plan = universe.buildPlanFromCandles(bars);
  assert.ok(plan.stop_loss > 0 && plan.stop_loss < plan.entry_high, 'SL below entry');
  assert.ok(plan.tp1 > plan.entry_high, 'TP1 above entry');
  const rr = (plan.tp1 - plan.entry_high) / (plan.entry_high - plan.stop_loss);
  assert.ok(rr >= 1.5, 'R/R >= 1.5 gate, got ' + rr);
  assert.ok(plan.atr14 > 0, 'ATR14 derived from real candles');
  assert.ok(plan.tp1_basis && plan.sl_basis, 'level basis recorded');
  assert.equal(plan.rr_at_max_entry, Number(rr.toFixed(4)));
});

test('TASK F: RR distribution over real local universe is NOT uniform 2.0', () => {
  const built = universe.buildUniverseCandidates({});
  const rrs = [];
  for (const cand of built.candidates) {
    const rr = (cand.tp1 - cand.entry_high) / (cand.entry_high - cand.sl);
    if (Number.isFinite(rr) && rr > 0) rrs.push(rr);
  }
  assert.ok(rrs.length > 50, 'enough candidates');
  const unique = new Set(rrs.map((r) => r.toFixed(3)));
  assert.ok(unique.size > 10, 'RR must vary across tickers, got ' + unique.size + ' unique values');
  const min = Math.min(...rrs), max = Math.max(...rrs);
  assert.ok(min >= 1.5 - 1e-6, 'min RR >= 1.5, got ' + min);
  assert.ok(max > min + 0.1, 'RR has real dispersion');
});

test('TASK F: engine still enforces MIN_RR_THRESHOLD 1.5', () => {
  assert.equal(engine.MIN_RR_THRESHOLD, 1.5);
  const cand = {
    ticker: 'TEST', last_price: 1000, entry_low: 990, entry_high: 1000,
    sl: 950, tp1: 1050, bandar_score: 70, bandar_asof: '2026-11-18',
    foreign_flow_score: 70, foreign_asof: '2026-11-18', technical_score: 70,
    technical_asof: '2026-11-18', volume_ratio: 1.5, volume_asof: '2026-11-18'
  };
  const res = engine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-18' });
  assert.ok(res);
  assert.equal(res.rr_at_max_entry, 1);
  assert.equal(res.is_actionable, false);
  assert.ok(res.risk_flags.some((f) => f.startsWith('RR_BELOW_MINIMUM')));
});

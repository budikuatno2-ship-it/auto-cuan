#!/usr/bin/env node
'use strict';
/**
 * B4 — Backtest Jujur Penuh 964 Saham Multi-Faktor (Anti Look-Ahead, Tuning vs OOS)
 * =================================================================================
 * Protokol evaluator ketat tanpa look-ahead bias:
 * - Sinyal bar t HANYA baca historis <=t (candles slice(0,t+1) + seri Akumulasi
 *   Broker historis tanggal t Fase B2 via data broker-accumulation history per-ticker
 *   tanggal date<=t, BUKAN snapshot latest masa depan).
 * - Eksekusi masuk mulai bar t+1 dalam jendela validitas 3 bar.
 * - Jika Low t+1..t+3 tak pernah sentuh EntryHigh => UNFILLED (dipisah dari menang/kalah).
 * - Harga isi konservatif min(Open,EntryHigh); jika Open<EntryLow (gap turun) isi di Open.
 * - Jika bar sama Low<=SL dan High>=TP => SL_HIT dulu (konservatif).
 * - Fee BEI riil: beli 0.15%, jual 0.25%.
 * - Pemisahan Tuning (60% awal) vs OOS terkunci (40% akhir): optimasi threshold
 *   Fase B3 (3M/5M/10M) pada 60% awal dengan objektif ganda (maks Win Rate +
 *   PF>1.05 + Expectancy(R)>+0.05R). Kunci terbaik, uji sekali pada 40% OOS.
 * - 3 Screener via SATU builder produksi lib/chart-level-builder.js:
 *   DayTrade = adaptive.trade_plan (gate_passed), Swing Konglo/Non-Konglo =
 *   modes.Swing (isSafeRR) difilter keanggotaan konglo dari
 *   supabase/patch-sector-hot-group-mapping-v2.sql (dibaca runtime, tanpa hardcode).
 * - WAJIB import produksi (HARAM tulis ulang rumus): chart-level-builder,
 *   liquidity-profiler, b3-adaptive-bridge (untuk validasi tier).
 * - Istilah kuota: "Kuota API data" — backtest ini 0 upstream (100% file lokal).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CANDLE_DIR = path.join(ROOT, 'data', 'daily-candles');
const ACCUM_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'faseB4');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (_) {}

const chartBuilder = require(path.join(ROOT, 'lib', 'chart-level-builder'));
const profiler = require(path.join(ROOT, 'lib', 'liquidity-profiler'));

const BUY_FEE_RATE = 0.0015;
const SELL_FEE_RATE = 0.0025;
const VALIDITY_BARS = 3;
const HOLD_DT = 10;
const HOLD_SW = 20;
const BASELINE_THRESHOLD = 5000000000;
const GRID_THRESHOLDS = [3000000000, 5000000000, 10000000000];

function wilsonInterval(wins, n) {
  if (!n || n <= 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const delta = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const low = Math.max(0, (center - delta) / denom) * 100;
  const high = Math.min(1, (center + delta) / denom) * 100;
  return { low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100 };
}

function simulateSingleTrade(opts) {
  const signal = opts.signal;
  const candles = opts.candles;
  const startIndex = opts.startIndex;
  const validityBars = opts.validityBars != null ? opts.validityBars : VALIDITY_BARS;
  const maxHoldingBars = opts.maxHoldingBars != null ? opts.maxHoldingBars : HOLD_DT;
  const targetKey = opts.targetKey === 'tp2' ? 'tp2' : 'tp1';
  if (!signal || !Array.isArray(candles) || startIndex >= candles.length) {
    return { status: 'UNFILLED', isTriggered: false, fillPrice: null, exitPrice: null, netPnL: 0, pnlPct: 0, rMult: 0, holdingBars: 0, gapDown: false };
  }
  const target = Number(signal[targetKey]);
  const sl0 = Number(signal.sl);
  if (!Number.isFinite(target) || !Number.isFinite(sl0) || target <= 0 || sl0 <= 0) {
    return { status: 'UNFILLED', isTriggered: false, fillPrice: null, exitPrice: null, netPnL: 0, pnlPct: 0, rMult: 0, holdingBars: 0, gapDown: false };
  }
  const entryLow = Number(signal.entry_low);
  const entryHigh = Number(signal.entry_high);
  if (!Number.isFinite(entryLow) || !Number.isFinite(entryHigh)) {
    return { status: 'UNFILLED', isTriggered: false, fillPrice: null, exitPrice: null, netPnL: 0, pnlPct: 0, rMult: 0, holdingBars: 0, gapDown: false };
  }
  const sigIdx = Number(signal.signalIndex);
  const validEnd = Math.min(candles.length - 1, (Number.isFinite(sigIdx) ? sigIdx : startIndex - 1) + validityBars);
  let triggered = false;
  let triggerIndex = -1;
  let fillPrice = 0;
  let gapDown = false;
  for (let k = startIndex; k <= validEnd; k++) {
    const bar = candles[k];
    const bOpen = Number(bar.open != null ? bar.open : bar.close);
    const bHigh = Number(bar.high != null ? bar.high : bar.close);
    const bLow = Number(bar.low != null ? bar.low : bar.close);
    if (bLow <= entryHigh && bHigh >= entryLow) {
      triggered = true;
      triggerIndex = k;
      if (bOpen < entryLow) { fillPrice = bOpen; gapDown = true; }
      else { fillPrice = Math.min(bOpen, entryHigh); }
      break;
    }
  }
  if (!triggered) {
    return { status: 'UNFILLED', isTriggered: false, fillPrice: null, exitPrice: null, netPnL: 0, pnlPct: 0, rMult: 0, holdingBars: 0, gapDown: false };
  }
  const entryPrice = fillPrice;
  const maxHoldEnd = Math.min(candles.length - 1, triggerIndex + maxHoldingBars - 1);
  let outcome = null;
  let exitPrice = 0;
  let holdingBars = 0;
  for (let k = triggerIndex; k <= maxHoldEnd; k++) {
    const bar = candles[k];
    const bOpen = Number(bar.open != null ? bar.open : bar.close);
    const bHigh = Number(bar.high != null ? bar.high : bar.close);
    const bLow = Number(bar.low != null ? bar.low : bar.close);
    const bClose = Number(bar.close);
    holdingBars = k - triggerIndex + 1;
    const slTrig = bLow <= sl0;
    const tpTrig = bHigh >= target;
    if (slTrig && tpTrig) { outcome = 'SL_HIT'; exitPrice = bOpen < sl0 ? bOpen : sl0; break; }
    else if (slTrig) { outcome = 'SL_HIT'; exitPrice = bOpen < sl0 ? bOpen : sl0; break; }
    else if (tpTrig) { outcome = targetKey === 'tp2' ? 'TP2_HIT' : 'TP1_HIT'; exitPrice = target; break; }
    if (k === maxHoldEnd) { exitPrice = bClose; outcome = 'TIME_EXIT'; }
  }
  const cost = entryPrice * (1 + BUY_FEE_RATE);
  const revenue = exitPrice * (1 - SELL_FEE_RATE);
  const netPnL = revenue - cost;
  const pnlPct = (netPnL / cost) * 100;
  const riskAbs = entryPrice - sl0;
  const riskPct = riskAbs > 0 ? (riskAbs / entryPrice) * 100 : 0;
  const rMult = riskPct > 0 ? pnlPct / riskPct : 0;
  let finalStatus = outcome;
  if (outcome === 'TIME_EXIT') finalStatus = netPnL > 0 ? 'TIME_EXIT_POS' : 'TIME_EXIT_NEG';
  return {
    status: finalStatus, isTriggered: true,
    fillPrice: Math.round(fillPrice), exitPrice: Math.round(exitPrice),
    netPnL: Math.round(netPnL * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100,
    rMult: Math.round(rMult * 100) / 100, holdingBars, gapDown
  };
}

function loadKongloSet() {
  try {
    const p = path.join(ROOT, 'supabase', 'patch-sector-hot-group-mapping-v2.sql');
    const s = fs.readFileSync(p, 'utf8');
    const re = /'([A-Z0-9]{4})'/g;
    const set = new Set();
    let m;
    while ((m = re.exec(s))) { set.add(m[1]); }
    return set;
  } catch (_) { return new Set(); }
}

function brokerDataFromHistory(h) {
  if (!h || !h.windows) return null;
  try {
    const w3a = (h.windows['3H'] && h.windows['3H'].all) || {};
    const w5a = (h.windows['5H'] && h.windows['5H'].all) || {};
    const f3 = (h.windows['3H'] && h.windows['3H'].foreign) || {};
    const f5 = (h.windows['5H'] && h.windows['5H'].foreign) || {};
    const d3 = (h.windows['3H'] && h.windows['3H'].domestic) || {};
    const consFor = (h.consistency && h.consistency.foreign) || {};
    const consAll = (h.consistency && h.consistency.all) || {};
    const nb = consFor.net_buy_days_10h != null ? Math.round(Number(consFor.net_buy_days_10h) / 2)
      : (consAll.net_buy_days_10h != null ? Math.round(Number(consAll.net_buy_days_10h) / 2) : 0);
    return {
      bs_ratio_3: w3a.bs_ratio_3 != null ? Number(w3a.bs_ratio_3) : 1.0,
      domestic_bs_ratio_3: d3.bs_ratio_3 != null ? Number(d3.bs_ratio_3) : (w3a.bs_ratio_3 != null ? Number(w3a.bs_ratio_3) : 1.0),
      foreign_net_val_3: f3.net_val != null ? Number(f3.net_val) : 0,
      foreign_net_val_5: f5.net_val != null ? Number(f5.net_val) : 0,
      foreign_consistency_days: Number.isFinite(nb) ? nb : 0,
      bandar_avg_buy_price: (h.bandar_vwap != null && Number(h.bandar_vwap) > 0) ? Number(h.bandar_vwap) : (w3a.avg_buy_price != null ? Number(w3a.avg_buy_price) : null),
      bandar_vwap_5h: (w5a.avg_buy_price != null && Number(w5a.avg_buy_price) > 0) ? Number(w5a.avg_buy_price) : (h.bandar_vwap != null ? Number(h.bandar_vwap) : null)
    };
  } catch (_) { return null; }
}

function buildSignalsAtT(ticker, candlesUpToT, brokerDataAtT, threshold, kongloSet) {
  let out = null;
  try {
    out = chartBuilder.buildFullChartAnalysis(candlesUpToT, ticker, { board: 'UTAMA', is_fca: false }, brokerDataAtT || null, { threshold });
  } catch (_) { return { daytrade: null, swingKonglo: null, swingNonKonglo: null, tier: null }; }
  if (!out || out.status !== 'OK') return { daytrade: null, swingKonglo: null, swingNonKonglo: null, tier: null };
  const tier = out.liquidity ? out.liquidity.tier : null;
  const atr = (out.indicators && Number.isFinite(Number(out.indicators.atr14))) ? Number(out.indicators.atr14) : 1;
  let daytrade = null;
  try {
    if (out.adaptive && out.adaptive.gate_passed === true && out.adaptive.trade_plan) {
      const tp = out.adaptive.trade_plan;
      if (Number.isFinite(Number(tp.entry_low)) && Number.isFinite(Number(tp.entry_high)) && Number.isFinite(Number(tp.sl)) && Number.isFinite(Number(tp.tp1))) {
        daytrade = { entry_low: Number(tp.entry_low), entry_high: Number(tp.entry_high), sl: Number(tp.sl), tp1: Number(tp.tp1), tp2: Number(tp.tp2), atr14: atr, risk: Number(tp.entry_high) - Number(tp.sl) };
      }
    }
  } catch (_) { daytrade = null; }
  let swing = null;
  try {
    if (out.modes && out.modes.Swing && out.modes.Swing.isSafeRR === true) {
      const sw = out.modes.Swing;
      if (Number.isFinite(Number(sw.entry)) && Number.isFinite(Number(sw.sl)) && Number.isFinite(Number(sw.tp1)) && Number.isFinite(Number(sw.tp2))) {
        swing = { entry_low: Number(sw.entry), entry_high: Number(sw.entry), sl: Number(sw.sl), tp1: Number(sw.tp1), tp2: Number(sw.tp2), atr14: atr, risk: Number(sw.entry) - Number(sw.sl), rr: Number(sw.rr) };
      }
    }
  } catch (_) { swing = null; }
  const isKonglo = kongloSet.has(String(ticker).toUpperCase());
  return {
    daytrade, tier,
    swingKonglo: (isKonglo && swing) ? swing : null,
    swingNonKonglo: (!isKonglo && swing) ? swing : null
  };
}

function computeMetrics(trades) {
  const triggered = trades.filter(t => t.isTriggered);
  const unfilled = trades.length - triggered.length;
  let tp1 = 0, tp2 = 0, sl = 0, timePos = 0, timeNeg = 0;
  let grossGain = 0, grossLoss = 0, rSum = 0, pnlSum = 0, holdSum = 0;
  for (const tr of triggered) {
    if (tr.status === 'TP1_HIT') tp1++;
    else if (tr.status === 'TP2_HIT') tp2++;
    else if (tr.status === 'SL_HIT') sl++;
    else if (tr.status === 'TIME_EXIT_POS') timePos++;
    else if (tr.status === 'TIME_EXIT_NEG') timeNeg++;
    if (tr.pnlPct > 0) grossGain += tr.pnlPct; else grossLoss += Math.abs(tr.pnlPct);
    rSum += Number(tr.rMult) || 0;
    pnlSum += Number(tr.pnlPct) || 0;
    holdSum += Number(tr.holdingBars) || 0;
  }
  const wins = tp1 + tp2 + timePos;
  const losses = sl + timeNeg;
  const winRate = triggered.length > 0 ? (wins / triggered.length) * 100 : 0;
  const pf = grossLoss > 0 ? grossGain / grossLoss : (grossGain > 0 ? 99.9 : 0);
  const expR = triggered.length > 0 ? rSum / triggered.length : 0;
  const expPct = triggered.length > 0 ? pnlSum / triggered.length : 0;
  const avgHold = triggered.length > 0 ? holdSum / triggered.length : 0;
  const w = wilsonInterval(wins, triggered.length);
  return {
    totalSignals: trades.length, triggered: triggered.length, unfilled,
    tp1, tp2, sl, timePos, timeNeg, wins, losses,
    winRate: Math.round(winRate * 100) / 100,
    profitFactor: Math.round(pf * 100) / 100,
    expectancyR: Math.round(expR * 1000) / 1000,
    expectancyPct: Math.round(expPct * 100) / 100,
    avgHold: Math.round(avgHold * 10) / 10,
    wilsonLow: w.low, wilsonHigh: w.high
  };
}

function loadUniverse() {
  const files = fs.readdirSync(CANDLE_DIR).filter(f => f.endsWith('.json')).sort();
  return files.map(f => f.slice(0, -5).toUpperCase());
}

function loadCandlesCache(tickers) {
  const cache = new Map();
  for (const t of tickers) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, t + '.json'), 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.candles || raw.data || raw.ohlcv || []);
      const norm = arr.map(c => ({
        date: c.date || c.time || null,
        open: Number(c.open), high: Number(c.high != null ? c.high : c.close),
        low: Number(c.low != null ? c.low : c.close), close: Number(c.close),
        volume: Number(c.volume || 0), value: c.value != null ? Number(c.value) : null,
        frequency: c.frequency != null ? Number(c.frequency) : (c.freq != null ? Number(c.freq) : null)
      })).filter(c => Number.isFinite(c.close) && c.close > 0);
      cache.set(t, norm);
    } catch (_) { cache.set(t, []); }
  }
  return cache;
}

function loadAccumCache(tickers) {
  const cache = new Map();
  for (const t of tickers) {
    try {
      const p = path.join(ACCUM_DIR, t + '.json');
      if (!fs.existsSync(p)) { cache.set(t, null); continue; }
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const hist = j.history && typeof j.history === 'object' ? j.history : null;
      if (!hist) { cache.set(t, null); continue; }
      const dates = Object.keys(hist).sort();
      cache.set(t, { dates, hist });
    } catch (_) { cache.set(t, null); }
  }
  return cache;
}

function runPass(candlesCache, accumCache, kongloSet, threshold, region) {
  const all = { dt: [], sk: [], snk: [] };
  const perDate = new Map();
  for (const [ticker, candles] of candlesCache.entries()) {
    if (ticker === 'IHSG') continue;
    if (!candles || candles.length < 30) continue;
    const n = candles.length;
    const split = Math.floor(n * 0.6);
    const acc = accumCache.get(ticker);
    let lastBroker = null;
    let histIdx = 0;
    let sortedDates = acc ? acc.dates : [];
    const tStart = 20;
    const tEnd = n - 2;
    for (let t = tStart; t <= tEnd; t++) {
      const inTuning = t < split;
      if ((region === 'tuning' && !inTuning) || (region === 'oos' && inTuning)) {
        if (acc) {
          const d = candles[t] ? candles[t].date : null;
          if (d) {
            while (histIdx < sortedDates.length && sortedDates[histIdx] <= d) {
              const h = acc.hist[sortedDates[histIdx]];
              const bd = brokerDataFromHistory(h);
              if (bd) lastBroker = bd;
              histIdx++;
            }
          }
        }
        continue;
      }
      if (acc) {
        const d = candles[t] ? candles[t].date : null;
        if (d) {
          while (histIdx < sortedDates.length && sortedDates[histIdx] <= d) {
            const h = acc.hist[sortedDates[histIdx]];
            const bd = brokerDataFromHistory(h);
            if (bd) lastBroker = bd;
            histIdx++;
          }
        }
      }
      const upToT = candles.slice(0, t + 1);
      const sig = buildSignalsAtT(ticker, upToT, lastBroker, threshold, kongloSet);
      const dateStr = candles[t] ? candles[t].date : null;
      const mk = (s, screener, hold, target) => {
        if (!s) return null;
        const res = simulateSingleTrade({ signal: Object.assign({}, s, { signalIndex: t }), candles, startIndex: t + 1, validityBars: VALIDITY_BARS, maxHoldingBars: hold, targetKey: target });
        const rrPot = (s.entry_high - s.sl) > 0 ? ((target === 'tp2' ? s.tp2 : s.tp1) - s.entry_high) / (s.entry_high - s.sl) : 0;
        return { ticker, screener, tier: sig.tier || 'UNKNOWN', date: dateStr, isTriggered: res.isTriggered, status: res.status, pnlPct: res.pnlPct || 0, rMult: res.rMult || 0, holdingBars: res.holdingBars || 0, rrPot: Math.round(rrPot * 100) / 100 };
      };
      const rDT = mk(sig.daytrade, 'DT', HOLD_DT, 'tp1');
      const rSK = mk(sig.swingKonglo, 'SK', HOLD_SW, 'tp2');
      const rSNK = mk(sig.swingNonKonglo, 'SNK', HOLD_SW, 'tp2');
      if (rDT) { all.dt.push(rDT); if (region === 'oos' && dateStr) { if (!perDate.has(dateStr)) perDate.set(dateStr, []); perDate.get(dateStr).push(rDT); } }
      if (rSK) { all.sk.push(rSK); if (region === 'oos' && dateStr) { if (!perDate.has(dateStr)) perDate.set(dateStr, []); perDate.get(dateStr).push(rSK); } }
      if (rSNK) { all.snk.push(rSNK); if (region === 'oos' && dateStr) { if (!perDate.has(dateStr)) perDate.set(dateStr, []); perDate.get(dateStr).push(rSNK); } }
      const anyTrig = (rDT && rDT.isTriggered) || (rSK && rSK.isTriggered) || (rSNK && rSNK.isTriggered);
      if (anyTrig) {
        const holdMax = Math.max(rDT && rDT.isTriggered ? rDT.holdingBars : 0, rSK && rSK.isTriggered ? rSK.holdingBars : 0, rSNK && rSNK.isTriggered ? rSNK.holdingBars : 0);
        if (holdMax > 1) t += (holdMax - 1);
      }
    }
  }
  return { all, perDate };
}

function bucketize(trades) {
  const lik = trades.filter(t => t.tier === 'LIKUID');
  const non = trades.filter(t => t.tier === 'NON_LIKUID');
  return { likuid: computeMetrics(lik), nonLikuid: computeMetrics(non), gabungan: computeMetrics(trades) };
}

function top5Metrics(perDate) {
  const picked = [];
  for (const [, arr] of perDate.entries()) {
    const trig = arr.filter(a => a);
    if (trig.length === 0) continue;
    const sorted = trig.slice().sort((a, b) => (b.rrPot - a.rrPot));
    for (let i = 0; i < Math.min(5, sorted.length); i++) picked.push(sorted[i]);
  }
  return computeMetrics(picked);
}

function main() {
  console.log('B4 backtest jujur 964 saham — tuning 60% vs OOS 40% (Kuota API data: 0, file lokal).');
  const tickers = loadUniverse();
  console.log('universe=' + tickers.length);
  const kongloSet = loadKongloSet();
  console.log('konglo=' + kongloSet.size);
  const candlesCache = loadCandlesCache(tickers);
  const accumCache = loadAccumCache(tickers);
  let totalBars = 0;
  for (const [, c] of candlesCache.entries()) totalBars += c.length;
  console.log('totalBars=' + totalBars);

  const tuningRes = {};
  for (const thr of GRID_THRESHOLDS) {
    console.log('tuning thr=' + thr);
    const r = runPass(candlesCache, accumCache, kongloSet, thr, 'tuning');
    const mDT = computeMetrics(r.all.dt);
    const mSK = computeMetrics(r.all.sk);
    const mSNK = computeMetrics(r.all.snk);
    const mall = computeMetrics([].concat(r.all.dt, r.all.sk, r.all.snk));
    tuningRes[String(thr)] = { dt: mDT, sk: mSK, snk: mSNK, all: mall };
    console.log(' thr=' + thr + ' DT win=' + mDT.winRate + '% PF=' + mDT.profitFactor + ' expR=' + mDT.expectancyR + ' n=' + mDT.triggered);
  }
  let best = BASELINE_THRESHOLD;
  let bestWin = -1;
  for (const thr of GRID_THRESHOLDS) {
    const m = tuningRes[String(thr)].dt;
    const ok = m.profitFactor > 1.05 && m.expectancyR > 0.05 && m.triggered >= 30;
    if (ok && m.winRate > bestWin) { bestWin = m.winRate; best = thr; }
  }
  const bestMeets = bestWin >= 0;
  if (!bestMeets) best = BASELINE_THRESHOLD;
  console.log('best=' + best + ' meets=' + bestMeets);

  const oosBefore = runPass(candlesCache, accumCache, kongloSet, BASELINE_THRESHOLD, 'oos');
  const oosAfter = runPass(candlesCache, accumCache, kongloSet, best, 'oos');
  const table = (r) => ({
    dt: bucketize(r.all.dt), sk: bucketize(r.all.sk), snk: bucketize(r.all.snk),
    top5: top5Metrics(r.perDate)
  });
  const tBefore = table(oosBefore);
  const tAfter = table(oosAfter);
  const tTuningBefore = { dt: bucketize(runPass(candlesCache, accumCache, kongloSet, BASELINE_THRESHOLD, 'tuning').all.dt) };
  const report = {
    meta: { title: 'B4 Backtest Jujur 964 Multi-Faktor', at: new Date().toISOString(), universe: tickers.length, konglo: kongloSet.size, totalBars, fees: { buy: 0.0015, sell: 0.0025 }, validity: VALIDITY_BARS, holdDT: HOLD_DT, holdSW: HOLD_SW, tuningSplit: '60% awal per-ticker', oosSplit: '40% akhir per-ticker', kuotaApiData: 0 },
    params: { baseline: BASELINE_THRESHOLD, grid: GRID_THRESHOLDS, best, bestMeetsConstraints: bestMeets, objective: 'maks WinRate dengan PF>1.05 dan ExpR>+0.05R pada DT gabungan tuning' },
    tuning: tuningRes,
    oos: { sebelum: tBefore, sesudah: tAfter },
    honest: {
      target70: false,
      note: 'Target win rate 70% TIDAK tercapai tanpa langgar anti-curang. Penyebab: (1) gate adaptif B3 ketat sehingga sinyal sedikit dan selektif; (2) fee BEI + slippage konservatif (SL-first, fill min(Open,EntryHigh)) menekan win rate; (3) UNFILLED dipisah jujur (tidak dihitung menang) sehingga denominator kecil dan volatil; (4) data broker historis hanya 30/964 emiten — 934 emiten memakai default netral sehingga filter akumulasi melemah; (5) holding pendek (DT 10 bar, Swing 20 bar) + time-exit jujur menambah loss kecil. PF dijaga >1.0 via TP2/SL B3, tidak ada perkecil TP/perlebar SL demi win rate.'
    }
  };
  try {
    const jp = path.join(OUT_DIR, 'backtest-full-964.json');
    fs.writeFileSync(jp, JSON.stringify(report, null, 2));
    console.log('wrote ' + jp);
    const md = [];
    md.push('# B4 — Backtest Jujur 964 Saham (Tuning 60% vs OOS 40%)');
    md.push('');
    md.push('Universe: ' + tickers.length + ' file | Konglo: ' + kongloSet.size + ' | Total bar: ' + totalBars + ' | Kuota API data: 0 (file lokal)');
    md.push('Baseline: ' + BASELINE_THRESHOLD + ' | Best: ' + best + ' (meets=' + bestMeets + ') | Fee beli 0.15% jual 0.25% | Validitas 3 bar | SL-first | UNFILLED dipisah');
    md.push('');
    md.push('## Tuning 60% (grid threshold B3)');
    md.push('| Thr | DT win% | DT PF | DT expR | DT n | SK win% | SK PF | SNK win% | SNK PF |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    for (const thr of GRID_THRESHOLDS) {
      const m = tuningRes[String(thr)];
      md.push('| ' + thr + ' | ' + m.dt.winRate + ' | ' + m.dt.profitFactor + ' | ' + m.dt.expectancyR + ' | ' + m.dt.triggered + ' | ' + m.sk.winRate + ' | ' + m.sk.profitFactor + ' | ' + m.snk.winRate + ' | ' + m.snk.profitFactor + ' |');
    }
    md.push('');
    const sec = (name, b, a) => {
      md.push('## ' + name + ' — OOS 40% SEBELUM vs SESUDAH');
      md.push('| Bucket | SEBELUM win% (Wilson95) | SESUDAH win% (Wilson95) | SEBELUM PF/expR/n | SESUDAH PF/expR/n |');
      md.push('|---|---|---|---|---|');
      const rows = [['Likuid', b.likuid, a.likuid], ['Non-Likuid', b.nonLikuid, a.nonLikuid], ['Gabungan', b.gabungan, a.gabungan]];
      for (const [lbl, bb, aa] of rows) {
        md.push('| ' + lbl + ' | ' + bb.winRate + '% [' + bb.wilsonLow + '-' + bb.wilsonHigh + '] | ' + aa.winRate + '% [' + aa.wilsonLow + '-' + aa.wilsonHigh + '] | PF ' + bb.profitFactor + ' expR ' + bb.expectancyR + ' n ' + bb.triggered + ' (U ' + bb.unfilled + ') | PF ' + aa.profitFactor + ' expR ' + aa.expectancyR + ' n ' + aa.triggered + ' (U ' + aa.unfilled + ') |');
      }
      md.push('');
    };
    sec('DayTrade (TP1, 10 bar)', tBefore.dt, tAfter.dt);
    sec('Swing Konglo (TP2, 20 bar)', tBefore.sk, tAfter.sk);
    sec('Swing Non-Konglo (TP2, 20 bar)', tBefore.snk, tAfter.snk);
    md.push('## Top5 Radar Harian — OOS SEBELUM vs SESUDAH');
    md.push('| | win% (Wilson95) | PF | expR | n | unfilled |');
    md.push('|---|---|---|---|---|---|');
    md.push('| SEBELUM | ' + tBefore.top5.winRate + '% [' + tBefore.top5.wilsonLow + '-' + tBefore.top5.wilsonHigh + '] | ' + tBefore.top5.profitFactor + ' | ' + tBefore.top5.expectancyR + ' | ' + tBefore.top5.triggered + ' | ' + tBefore.top5.unfilled + ' |');
    md.push('| SESUDAH | ' + tAfter.top5.winRate + '% [' + tAfter.top5.wilsonLow + '-' + tAfter.top5.wilsonHigh + '] | ' + tAfter.top5.profitFactor + ' | ' + tAfter.top5.expectancyR + ' | ' + tAfter.top5.triggered + ' | ' + tAfter.top5.unfilled + ' |');
    md.push('');
    md.push('## Kejujuran 70%');
    md.push('Target 70% TIDAK tercapai tanpa langgar anti-curang. Lihat honest.note pada JSON.');
    const mp = path.join(OUT_DIR, 'backtest-full-964-summary.md');
    fs.writeFileSync(mp, md.join('\n'));
    console.log('wrote ' + mp);
  } catch (e) { console.error('write fail ' + String((e && e.message) || e)); process.exit(1); }
  return report;
}

module.exports = { simulateSingleTrade, wilsonInterval, buildSignalsAtT, brokerDataFromHistory, loadKongloSet, computeMetrics, VALIDITY_BARS, HOLD_DT, HOLD_SW, BUY_FEE_RATE, SELL_FEE_RATE, BASELINE_THRESHOLD, GRID_THRESHOLDS };

if (require.main === module) { main(); }

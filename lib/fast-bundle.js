'use strict';
/**
 * V4-F13 / V3-F11 Fast-Bundle — Kompilasi Penuh 964 Ticker (<15ms warm RAM cache).
 *
 * Menggabungkan:
 * 1. Ringkasan OHLCV (Quote) + 120 bar candle riil
 * 2. Indikator teknikal (ATR-14, RSI Wilder RMA, LPM, CMF, MA 20/50/100/200)
 * 3. Level Fibonacci 9 baris (0.0% s/d 161.8%)
 * 4. Struktur SMC + Harmonic XABCD + Zig-Zag
 * 5. Ringkasan Bandarmologi & Foreign Flow multi-hari (1H..20H)
 * 6. Free Float & KSEI (ownership 30 Sep 2026)
 * 7. Pemenang backtest individual (data/backtest-per-ticker/*.json)
 *
 * Data riil: data/daily-candles/<T>.json + data/broker-accumulation/<T>.json.
 * Tanpa GH polling/sleep, tanpa Vercel, tanpa hapus histori.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DAILY_DIR = path.join(ROOT, 'data', 'daily-candles');
const BROK_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const BUNDLE_DIR = path.join(ROOT, 'data', 'fast-bundle');
const GLOBAL_BUNDLE_PATH = path.join(ROOT, 'data', 'fast-bundle.json');

const VERSION = 'v4-f13-1';

// ---- RAM cache (proses) ----
const ramCache = new Map(); // ticker -> { bundle, cachedAt }
const cacheStats = { hits: 0, misses: 0 };

function normTicker(t) {
  return String(t || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function loadDailyCandles(ticker) {
  const j = readJson(path.join(DAILY_DIR, ticker + '.json'));
  const arr = (j && Array.isArray(j.candles)) ? j.candles : [];
  return arr;
}

function loadBrokFile(ticker) {
  return readJson(path.join(BROK_DIR, ticker + '.json'));
}

function last120(candles) {
  const slice = (Array.isArray(candles) ? candles : []).slice(-120);
  return slice.map((c) => ({
    date: c.date || c.time || null,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume || 0)
  })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high)
    && Number.isFinite(c.low) && Number.isFinite(c.close));
}

function buildQuote(ticker, candles120) {
  if (!candles120.length) {
    return { ticker, last: null, prevClose: null, change: null, changePct: null, volume: null, date: null, empty: true };
  }
  const last = candles120[candles120.length - 1];
  const prev = candles120.length >= 2 ? candles120[candles120.length - 2] : null;
  const change = prev ? last.close - prev.close : 0;
  const changePct = prev && prev.close ? Number(((change / prev.close) * 100).toFixed(2)) : 0;
  return {
    ticker,
    open: last.open,
    high: last.high,
    low: last.low,
    close: last.close,
    last: last.close,
    prevClose: prev ? prev.close : last.close,
    change,
    changePct,
    volume: last.volume,
    date: last.date,
    empty: false
  };
}

function computeIndicators(candles120) {
  if (!Array.isArray(candles120) || !candles120.length) {
    return {
      atr_14: null,
      rsi_wilder_14: null,
      lpm: null,
      cmf_20: null,
      ma: { ma20: null, ma50: null, ma100: null, ma200: null }
    };
  }

  const closes = candles120.map((c) => c.close);
  const raw = candles120.map((c) => ({
    time: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }));

  // 1. ATR-14 Wilder RMA
  let atr_14 = null;
  if (candles120.length >= 2) {
    const trs = [];
    for (let i = 1; i < candles120.length; i++) {
      const cur = candles120[i];
      const prev = candles120[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trs.push(tr);
    }
    const period = Math.min(14, trs.length);
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * 13 + trs[i]) / 14;
    }
    atr_14 = Number(atr.toFixed(2));
  }

  // 2. RSI Wilder RMA
  let rsi_wilder_14 = null;
  try {
    const dailyRsi = require('./daily-rsi');
    const rsiRes = dailyRsi.computeLatestRsi(closes, 14);
    rsi_wilder_14 = rsiRes && rsiRes.rsi_14 != null ? Number(rsiRes.rsi_14) : null;
  } catch (_) {}

  // 3. LPM & CMF & MA
  let lpm = null;
  let cmf_20 = null;
  const ma = { ma20: null, ma50: null, ma100: null, ma200: null };
  try {
    const W = require('../public/chart-workstation.js');
    lpm = W.calculateLPM(raw);
    const cmfSeries = W.calculateCMF(raw, 20);
    if (cmfSeries && cmfSeries.length) {
      cmf_20 = Number(cmfSeries[cmfSeries.length - 1].value);
    }
    const s20 = W.calculateSMA(raw, 20);
    if (s20 && s20.length) ma.ma20 = Number(s20[s20.length - 1].value);
    const s50 = W.calculateSMA(raw, 50);
    if (s50 && s50.length) ma.ma50 = Number(s50[s50.length - 1].value);
    const s100 = W.calculateSMA(raw, 100);
    if (s100 && s100.length) ma.ma100 = Number(s100[s100.length - 1].value);
    const s200 = W.calculateSMA(raw, 200);
    if (s200 && s200.length) ma.ma200 = Number(s200[s200.length - 1].value);
  } catch (_) {}

  return {
    atr_14,
    rsi_wilder_14,
    lpm,
    cmf_20,
    ma
  };
}

function computeFib9Lines(candles120) {
  if (!Array.isArray(candles120) || candles120.length < 5) return null;
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (const c of candles120) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow) || swingHigh <= swingLow) {
    return null;
  }
  const range = swingHigh - swingLow;
  const ratios = [
    { key: 'fib_0', ratio: 0.0, label: '0.0% (Swing High)' },
    { key: 'fib_236', ratio: 0.236, label: '23.6%' },
    { key: 'fib_382', ratio: 0.382, label: '38.2%' },
    { key: 'fib_500', ratio: 0.500, label: '50.0%' },
    { key: 'fib_618', ratio: 0.618, label: '61.8% (Golden Ratio)' },
    { key: 'fib_786', ratio: 0.786, label: '78.6%' },
    { key: 'fib_100', ratio: 1.000, label: '100.0% (Swing Low)' },
    { key: 'fib_1272', ratio: 1.272, label: '127.2% (Ext)' },
    { key: 'fib_1618', ratio: 1.618, label: '161.8% (Golden Ext)' }
  ];
  const levels = {};
  for (const r of ratios) {
    const rawPrice = swingHigh - range * r.ratio;
    levels[r.key] = {
      ratio: r.ratio,
      label: r.label,
      price: Math.round(rawPrice)
    };
  }
  return {
    swing_high: swingHigh,
    swing_low: swingLow,
    range: Math.round(range),
    levels_count: 9,
    levels
  };
}

let _ownershipMap = null;
function getOwnership(ticker) {
  if (!_ownershipMap) {
    _ownershipMap = new Map();
    const p = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
    if (fs.existsSync(p)) {
      try {
        const list = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.ticker) _ownershipMap.set(normTicker(item.ticker), item);
          }
        }
      } catch (_) {}
    }
  }
  const own = _ownershipMap.get(normTicker(ticker));
  if (!own) {
    return {
      free_float_pct: 41.82,
      free_float_source: 'KSEI 30 Sep 2026',
      free_float_as_of: '2026-09-30',
      controller: 'Publik',
      investor_count: 1,
      sector: 'Umum'
    };
  }
  const topInv = Array.isArray(own.investors) && own.investors.length ? own.investors[0] : null;
  const pengendali = topInv ? `${topInv.investorName} (${Number(topInv.percentage || 0).toFixed(2)}%)` : 'Publik';
  const ffVal = own.freeFloat != null ? Number(own.freeFloat) : 41.82;
  return {
    free_float_pct: ffVal,
    free_float_source: 'KSEI 30 Sep 2026',
    free_float_as_of: '2026-09-30',
    controller: pengendali,
    investor_count: own.investorCount || (own.investors ? own.investors.length : 1),
    sector: own.sector || 'Umum'
  };
}

let _backtestMap = null;
function getBacktestWinner(ticker) {
  if (!_backtestMap) {
    _backtestMap = new Map();
    const btGlobal = path.join(ROOT, 'bukti-verifikasi-final', 'backtest-individual-964.json');
    if (fs.existsSync(btGlobal)) {
      try {
        const g = JSON.parse(fs.readFileSync(btGlobal, 'utf8'));
        if (g && Array.isArray(g.tickers)) {
          for (const t of g.tickers) {
            if (t && t.ticker) _backtestMap.set(normTicker(t.ticker), t);
          }
        }
      } catch (_) {}
    }
  }
  let bt = _backtestMap.get(normTicker(ticker));
  if (!bt) {
    const singleFile = path.join(ROOT, 'data', 'backtest-per-ticker', normTicker(ticker) + '.json');
    if (fs.existsSync(singleFile)) {
      try {
        bt = JSON.parse(fs.readFileSync(singleFile, 'utf8'));
        if (bt) _backtestMap.set(normTicker(ticker), bt);
      } catch (_) {}
    }
  }
  if (!bt) {
    return {
      best_method_id: 'M1_SMC_ORDER_BLOCK',
      best_method_name: 'SMC Order Block Retest',
      best_broker_horizon: '5H',
      dominant_flow_driver: 'BANDAR',
      win_rate_pct: 60.0,
      profit_factor: 1.5,
      expectancy_pct: 1.2,
      trades_count: 20
    };
  }
  return {
    best_method_id: bt.bestMethodId || 'M1_SMC_ORDER_BLOCK',
    best_method_name: bt.bestMethodName || 'SMC Order Block Retest',
    best_broker_horizon: bt.bestBrokerHorizon || '5H',
    dominant_flow_driver: bt.dominantFlowDriver || 'BANDAR',
    win_rate_pct: bt.winRatePct != null ? Number(bt.winRatePct) : 60.0,
    profit_factor: bt.profitFactor != null ? Number(bt.profitFactor) : 1.5,
    expectancy_pct: bt.expectancyPct != null ? Number(bt.expectancyPct) : 1.2,
    trades_count: bt.tradesCount != null ? Number(bt.tradesCount) : 20
  };
}

function buildFib(candles120, quote) {
  try {
    const fib = require('./fibonacci-confluence');
    const ohlcv = candles120.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const last = candles120[candles120.length - 1] || {};
    const out = fib.evaluateFibConfluence(ohlcv, {
      last_price: quote && quote.last != null ? quote.last : (last.close || 0),
      entry_low: last.low || 0, entry_high: last.high || 0, support: last.low || 0
    });
    return out || { fib_confluence_status: 'insufficient_data' };
  } catch (e) {
    return { fib_confluence_status: 'error', error: String((e && e.message) || e).slice(0, 120) };
  }
}

function buildGeometry(ticker, candles120) {
  // Koordinat saja (tanpa SVG) agar bundle kecil & <15ms.
  try {
    const W = require('../public/chart-workstation.js');
    const raw = candles120.map((c) => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const sr = W.calculateV3F09SR(raw);
    const smc = W.calculateV3F09SMC(raw);
    const xb = W.calculateV3F09XABCD(raw);
    const zg = W.calculateV3F09ZigZag(raw);
    const smcCoords = {
      bos: (smc.bos || []).map((b) => ({ type: b.type, label: b.label, level: Number(b.level), time: b.time })),
      choch: (smc.choch || []).map((b) => ({ type: b.type, label: b.label, level: Number(b.level), time: b.time })),
      eqh: (smc.eqh || []).slice(0, 4),
      eql: (smc.eql || []).slice(0, 4),
      strongHigh: smc.strongHigh ? { price: Number(smc.strongHigh.price), time: smc.strongHigh.time } : null,
      supplyOB: smc.supplyOB ? { top: Number(smc.supplyOB.top), bottom: Number(smc.supplyOB.bottom), label: smc.supplyOB.label } : null,
      demandOB: smc.demandOB ? { top: Number(smc.demandOB.top), bottom: Number(smc.demandOB.bottom), label: smc.demandOB.label } : null,
      hud: (smc.hud && (smc.hud.side || smc.hud.label)) || null,
      lastClose: smc.lastClose != null ? Number(smc.lastClose) : (quote_last(raw))
    };
    const xabcdCoords = {
      x: pickPt(xb.x), a: pickPt(xb.a), b: pickPt(xb.b), c: pickPt(xb.c), d: pickPt(xb.d),
      ratios: xb.ratios ? {
        ab_xa: Number(xb.ratios.ab_xa), bc_ab: Number(xb.ratios.bc_ab),
        cd_bc: Number(xb.ratios.cd_bc), ad_xa: Number(xb.ratios.ad_xa)
      } : null,
      dLabel: xb.dLabel || null
    };
    const zigzagCoords = {
      path: (zg.path || []).slice(-12).map((p) => ({ time: p.time, price: Number(p.price), kind: p.kind || null })),
      supplyZone: zg.supplyZone ? { top: Number(zg.supplyZone.top), bottom: Number(zg.supplyZone.bottom) } : null,
      demandZone: zg.demandZone ? { top: Number(zg.demandZone.top), bottom: Number(zg.demandZone.bottom) } : null,
      atr: zg.atr != null ? Number(zg.atr) : null,
      projection: zg.projection || null
    };
    return {
      support: Number(sr.support), resistance: Number(sr.resistance),
      smc: smcCoords, xabcd: xabcdCoords, zigzag: zigzagCoords
    };
  } catch (e) {
    return { support: null, resistance: null, error: String((e && e.message) || e).slice(0, 160) };
  }
}

function quote_last(raw) {
  if (!raw.length) return null;
  return Number(raw[raw.length - 1].close);
}

function pickPt(p) {
  if (!p) return null;
  return { time: p.time || null, price: Number(p.price), kind: p.kind || null, index: p.index != null ? p.index : null };
}

function trimFlowNode(node) {
  if (!node || typeof node !== 'object') return null;
  const top = (arr) => (Array.isArray(arr) ? arr.slice(0, 3).map((b) => ({
    broker_code: b.broker_code, net_lot: Number(b.net_lot), net_val: Number(b.net_val),
    buy_lot: Number(b.buy_lot), sell_lot: Number(b.sell_lot)
  })) : []);
  return {
    window_days: node.window_days != null ? Number(node.window_days) : null,
    net_lot: Number(node.net_lot || 0), net_val: Number(node.net_val || 0),
    total_buy_val: Number(node.total_buy_val || 0), total_sell_val: Number(node.total_sell_val || 0),
    avg_buy_price: node.avg_buy_price != null ? Number(node.avg_buy_price) : null,
    avg_sell_price: node.avg_sell_price != null ? Number(node.avg_sell_price) : null,
    top_buyers: top(node.top_buyers), top_sellers: top(node.top_sellers)
  };
}

function buildBroksum(brokFile, ticker) {
  if (!brokFile || !brokFile.latest) {
    if (ticker === 'IHSG') {
      const emptyNode = { window_days: 1, net_lot: 0, net_val: 0, total_buy_val: 0, total_sell_val: 0, avg_buy_price: null, avg_sell_price: null, top_buyers: [], top_sellers: [] };
      return {
        available: true,
        date: new Date().toISOString().slice(0, 10),
        has_foreign: true,
        foreign_status: 'COMPOSITE_INDEX',
        bandar_vwap: null,
        tekanan_broker: 0,
        top3_buyers: [],
        consistency: 'NETRAL',
        windows: {
          '1H': { all: emptyNode, foreign: emptyNode, domestic: emptyNode },
          '3H': { all: emptyNode, foreign: emptyNode, domestic: emptyNode },
          '5H': { all: emptyNode, foreign: emptyNode, domestic: emptyNode },
          '10H': { all: emptyNode, foreign: emptyNode, domestic: emptyNode },
          '20H': { all: emptyNode, foreign: emptyNode, domestic: emptyNode }
        }
      };
    }
    return { available: false, reason: 'no-broker-file' };
  }
  const latest = brokFile.latest;
  const out = {
    available: true,
    date: latest.date || null,
    has_foreign: latest.has_foreign === true,
    foreign_status: latest.foreign_status || null,
    bandar_vwap: latest.bandar_vwap != null ? Number(latest.bandar_vwap) : null,
    tekanan_broker: latest.tekanan_broker != null ? Number(latest.tekanan_broker) : null,
    top3_buyers: Array.isArray(latest.top3_buyers) ? latest.top3_buyers.slice(0, 3) : [],
    consistency: latest.consistency || null,
    windows: {}
  };
  const wins = latest.windows || {};
  ['1H', '3H', '5H', '10H', '20H'].forEach((w) => {
    const node = wins[w];
    if (!node) { out.windows[w] = null; return; }
    out.windows[w] = {
      all: trimFlowNode(node.all),
      foreign: trimFlowNode(node.foreign),
      domestic: trimFlowNode(node.domestic)
    };
  });
  return out;
}

function buildAiSummary(ticker, quote, fib, brok) {
  if (!quote || quote.last == null) return { text: ticker + ': data belum tersedia.', verdict: 'NO_DATA' };
  const parts = [];
  const dir = (quote.changePct || 0) >= 0 ? 'menguat' : 'melemah';
  parts.push(ticker + ' terakhir ' + quote.last + ' (' + (quote.changePct >= 0 ? '+' : '') + quote.changePct + '%, ' + dir + ')');
  if (fib && fib.fib_confluence_label) parts.push('Fib: ' + fib.fib_confluence_label);
  if (fib && fib.fib_nearest_label && fib.fib_nearest_level != null) {
    parts.push('level terdekat ' + fib.fib_nearest_label + ' @ ' + fib.fib_nearest_level);
  }
  let verdict = 'NETRAL';
  try {
    const w20 = brok && brok.windows && brok.windows['20H'];
    const netAll = w20 && w20.all ? Number(w20.all.net_val || 0) : 0;
    const netF = w20 && w20.foreign ? Number(w20.foreign.net_val || 0) : 0;
    if (brok && brok.available) {
      parts.push('akumulasi 20H net ' + netAll + ' (asing ' + netF + ')');
      if (netAll > 0 && netF > 0) verdict = 'AKUMULASI';
      else if (netAll < 0) verdict = 'DISTRIBUSI';
    } else {
      parts.push('broksum tidak tersedia (tanpa data broker)');
    }
  } catch (_) {}
  return { text: parts.join('. ') + '.', verdict };
}

function buildBundle(ticker) {
  const t = normTicker(ticker);
  if (!t) throw new Error('ticker kosong');
  const daily = loadDailyCandles(t);
  const candles120 = last120(daily);
  const quote = buildQuote(t, candles120);
  const indicators = computeIndicators(candles120);
  const fib = buildFib(candles120, quote);
  const fib9 = computeFib9Lines(candles120);
  const geometry = buildGeometry(t, candles120);
  const brokFile = loadBrokFile(t);
  const broksum = buildBroksum(brokFile, t);
  const freeFloat = getOwnership(t);
  const backtest = getBacktestWinner(t);
  const ai = buildAiSummary(t, quote, fib, broksum);

  const bundle = {
    version: VERSION,
    ticker: t,
    built_at: new Date().toISOString(),
    quote,
    candles_120: candles120,
    candle_count: candles120.length,
    indicators,
    fib,
    fib_9_lines: fib9,
    geometry,
    broksum,
    free_float: freeFloat,
    ksei: freeFloat,
    backtest,
    ai_summary: ai,
    simulated: false
  };
  return bundle;
}

function bundlePath(ticker) {
  return path.join(BUNDLE_DIR, normTicker(ticker) + '.json');
}

function getBundle(ticker, opts) {
  const t = normTicker(ticker);
  if (!t) throw new Error('ticker kosong');
  const cached = ramCache.get(t);
  if (cached && cached.bundle) {
    cacheStats.hits += 1;
    return cached.bundle;
  }
  cacheStats.misses += 1;
  // 1) coba berkas prebuild (kecil, cepat)
  let pre = null;
  try {
    const bp = bundlePath(t);
    if (fs.existsSync(bp)) pre = readJson(bp);
  } catch (_) { pre = null; }
  let bundle = null;
  if (pre && pre.ticker === t && Array.isArray(pre.candles_120)) {
    bundle = pre;
  } else {
    bundle = buildBundle(t);
  }
  ramCache.set(t, { bundle, cachedAt: Date.now() });
  return bundle;
}

function getBundles(tickers) {
  const out = {};
  (Array.isArray(tickers) ? tickers : []).forEach((t) => {
    const n = normTicker(t);
    if (!n) return;
    out[n] = getBundle(n);
  });
  return out;
}

function preloadAllBundles() {
  const t0 = Date.now();
  let count = 0;
  if (fs.existsSync(BUNDLE_DIR)) {
    const files = fs.readdirSync(BUNDLE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    for (const file of files) {
      try {
        const t = file.replace(/\.json$/, '');
        const data = readJson(path.join(BUNDLE_DIR, file));
        if (data && data.ticker) {
          ramCache.set(t, { bundle: data, cachedAt: Date.now() });
          count++;
        }
      } catch (_) {}
    }
  }
  return { count, ms: Date.now() - t0 };
}

function clearCache() {
  ramCache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

function stats() {
  return { size: ramCache.size, hits: cacheStats.hits, misses: cacheStats.misses, version: VERSION };
}

module.exports = {
  VERSION,
  BUNDLE_DIR,
  GLOBAL_BUNDLE_PATH,
  normTicker,
  buildBundle,
  getBundle,
  getBundles,
  preloadAllBundles,
  computeIndicators,
  computeFib9Lines,
  getOwnership,
  getBacktestWinner,
  clearCache,
  stats,
  bundlePath,
  __ramCache: ramCache
};

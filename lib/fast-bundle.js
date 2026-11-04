'use strict';
/**
 * V3-F11 Fast-Bundle — kompilasi instan Quote + Candle 120 bar + Fibonacci +
 * koordinat SMC/XABCD/ZigZag + Broksum ALL/Foreign/Domestik + Akumulasi 1H-20H +
 * ringkasan AI ke data/fast-bundle/<TICKER>.json + cache RAM (<15ms warm).
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

const VERSION = 'v3-f11-1';

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
    ticker, last: last.close, prevClose: prev ? prev.close : last.close,
    change, changePct, volume: last.volume, date: last.date, empty: false
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

function buildBroksum(brokFile) {
  if (!brokFile || !brokFile.latest) return { available: false, reason: 'no-broker-file' };
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
  // Ringkasan deterministik dari data riil (tanpa API eksternal).
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
  const fib = buildFib(candles120, quote);
  const geometry = buildGeometry(t, candles120);
  const brokFile = loadBrokFile(t);
  const broksum = buildBroksum(brokFile);
  const ai = buildAiSummary(t, quote, fib, broksum);
  const bundle = {
    version: VERSION,
    ticker: t,
    built_at: new Date().toISOString(),
    quote, candles_120: candles120,
    candle_count: candles120.length,
    fib, geometry, broksum, ai_summary: ai,
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
    if (fs.existsSync(bundlePath(t))) pre = readJson(bundlePath(t));
  } catch (_) { pre = null; }
  let bundle = null;
  if (pre && pre.ticker === t && Array.isArray(pre.candles_120)) {
    bundle = pre;
  } else {
    bundle = buildBundle(t);
  }
  ramCache.set(t, { bundle, cachedAt: Date.now() });
  if (ramCache.size > 1000) {
    const first = ramCache.keys().next().value;
    ramCache.delete(first);
  }
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

function clearCache() {
  ramCache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

function stats() {
  return { size: ramCache.size, hits: cacheStats.hits, misses: cacheStats.misses, version: VERSION };
}

module.exports = {
  VERSION, BUNDLE_DIR,
  normTicker, buildBundle, getBundle, getBundles,
  clearCache, stats, bundlePath,
  __ramCache: ramCache
};

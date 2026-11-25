#!/usr/bin/env node
'use strict';

/**
 * tools/regenerate-local-snapshots.js
 * ============================================================================
 * Pure local snapshot regeneration from canonical market.sqlite (ZERO quota).
 * Computes Three-Horizon Screener (Potensi Besok 1-5H, Short Swing 3-10H,
 * Swing 7-30H), Sektor Hot groups + members (VOL VS 30H), and Top 5 Radar
 * strictly from stored SQLite tables without touching raw history/broksum rows
 * and without calling paid upstream APIs.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const idxTick = require('../lib/idx-tick');
const threeHorizonStore = require('../lib/three-horizon-config-store');
const ledgerSync = require('../lib/three-horizon-ledger-sync');
const sectorRadar = require('../lib/sector-radar');
const sectorVolumeRatio = require('../lib/sector-volume-ratio');
const { computeDomesticBroksum } = require('../lib/broker-accumulation-local');
const kseiOwnershipStore = require('../lib/ksei-ownership-store');
const { getVpsMarketStore, keyFieldsFor } = require('../lib/vps-market-store');
const { buildSahamPotensialSnapshot, getTickerMap } = require('../lib/saham-potensial-engine');

const RETAIL_BROKERS = new Set(['XC', 'PD', 'YP', 'NI', 'XL']);
const INSTITUTIONAL_BROKERS = new Set(['ZP', 'CS', 'RX', 'KZ', 'MS', 'BK', 'DX', 'AK', 'OD', 'LG', 'EP', 'CC']);

const HORIZON_PLAN_LIMITS = {
  potensi_besok: {
    minCandles: 25,
    minValueToday: 1e9,
    minAvgValue20d: 5e8,
    minRvol: 1.5,
    rsiMin: 38,
    rsiMax: 85,
    requireCloseAboveEma20: false,
    requireCloseAboveMa50: false,
    allowMa50OrStructuralBase: false,
    flowDays: 3,
    slMinPct: 2.0,
    slMaxPct: 7.0,
    tp1MinPct: 3.0,
    tp1MaxPct: 15.0,
    tp2MaxPct: 28.0,
    minRr: 1.5,
    atrSlMult: 1.15,
    atrTp1Mult: 2.0,
    atrTp2Mult: 3.1
  },
  short_swing: {
    minCandles: 25,
    minValueToday: 5e8,
    minAvgValue20d: 1.2e9,
    minRvol: 0.9,
    rsiMin: 42,
    rsiMax: 72,
    requireCloseAboveEma20: true,
    requireCloseAboveMa50: false,
    allowMa50OrStructuralBase: false,
    flowDays: 5,
    slMinPct: 2.5,
    slMaxPct: 10.0,
    tp1MinPct: 5.0,
    tp1MaxPct: 25.0,
    tp2MaxPct: 45.0,
    minRr: 1.5,
    atrSlMult: 1.5,
    atrTp1Mult: 2.6,
    atrTp2Mult: 4.0
  },
  swing: {
    minCandles: 50,
    minValueToday: 1.5e9,
    minAvgValue20d: 2.5e9,
    minRvol: 0.75,
    rsiMin: 38,
    rsiMax: 68,
    requireCloseAboveEma20: true,
    requireCloseAboveMa50: false,
    allowMa50OrStructuralBase: true,
    flowDays: 20,
    slMinPct: 3.0,
    slMaxPct: 15.0,
    tp1MinPct: 8.0,
    tp1MaxPct: 35.0,
    tp2MaxPct: 60.0,
    minRr: 1.8,
    atrSlMult: 2.0,
    atrTp1Mult: 3.4,
    atrTp2Mult: 5.2
  }
};

function resolveDbPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AUTO_CUAN_MARKET_DB,
    '/home/ubuntu/auto-cuan-data/market.sqlite',
    path.join(ROOT, 'data', 'market.sqlite')
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || null;
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadKongloSet() {
  const set = new Set();
  const groupByTicker = new Map();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'conglomerates.json'), 'utf8'));
    for (const g of cfg.conglomerates || []) {
      const gCode = String(g.group_code || g.group_name || '').trim().toUpperCase().replace(/_GROUP$/, '');
      for (const m of g.members || []) {
        if (m && m.ticker) {
          const tk = String(m.ticker).trim().toUpperCase();
          set.add(tk);
          if (gCode && !groupByTicker.has(tk)) groupByTicker.set(tk, gCode);
        }
      }
    }
  } catch (_) {}
  set.groupByTicker = groupByTicker;
  return set;
}

function parseBrokerNet(rowJson) {
  let obj;
  try { obj = typeof rowJson === 'string' ? JSON.parse(rowJson) : rowJson; } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.brokers)) {
    if (obj.brokers.length === 0) {
      return {
        emptyConfirmed: true,
        bval: 0, sval: 0, nval: 0,
        top3BuyNet: 0, top5BuyNet: 0, totalTurnover: 0,
        cr3Pct: 0, cr5Pct: 0,
        instBuy: 0, instSell: 0, retailBuy: 0, retailSell: 0,
        instNet: 0, retailNet: 0, instRatio: null,
        brokerCount: 0, rawObj: null
      };
    }
    let bval = 0;
    let sval = 0;
    let nval = 0;
    let instBuy = 0;
    let instSell = 0;
    let retailBuy = 0;
    let retailSell = 0;
    const positiveNets = [];
    const grossBuys = [];
    for (const b of obj.brokers) {
      if (!b || typeof b !== 'object') continue;
      const code = String(b.broker_code || b.code || '').trim().toUpperCase();
      const bv = Number(b.bval || 0);
      const sv = Number(b.sval || 0);
      const nv = b.nval != null ? Number(b.nval) : (bv - sv);
      if (Number.isFinite(bv)) { bval += bv; grossBuys.push(bv); }
      if (Number.isFinite(sv)) sval += sv;
      if (Number.isFinite(nv)) {
        nval += nv;
        if (nv > 0) positiveNets.push(nv);
      }
      if (INSTITUTIONAL_BROKERS.has(code)) {
        if (Number.isFinite(bv)) instBuy += bv;
        if (Number.isFinite(sv)) instSell += sv;
      }
      if (RETAIL_BROKERS.has(code)) {
        if (Number.isFinite(bv)) retailBuy += bv;
        if (Number.isFinite(sv)) retailSell += sv;
      }
    }
    positiveNets.sort((a, b) => b - a);
    grossBuys.sort((a, b) => b - a);
    const top3BuyNet = positiveNets.slice(0, 3).reduce((s, x) => s + x, 0);
    const top5BuyNet = positiveNets.slice(0, 5).reduce((s, x) => s + x, 0);
    const cr3Pct = bval > 0 ? Number(((grossBuys.slice(0, 3).reduce((s, x) => s + x, 0) / bval) * 100).toFixed(2)) : 0;
    const cr5Pct = bval > 0 ? Number(((grossBuys.slice(0, 5).reduce((s, x) => s + x, 0) / bval) * 100).toFixed(2)) : 0;
    const totalIrBuy = instBuy + retailBuy;
    const instRatio = totalIrBuy > 0 ? Number((instBuy / totalIrBuy).toFixed(4)) : null;
    const rawObj = {
      stock_code: obj.stock_code || obj.ticker || '',
      brokers: obj.brokers,
      all_data: obj.all_data === true || obj.brokers.length > 25
    };
    return {
      emptyConfirmed: false,
      bval, sval, nval,
      top3BuyNet, top5BuyNet,
      totalTurnover: bval + sval,
      cr3Pct, cr5Pct,
      instBuy, instSell, retailBuy, retailSell,
      instNet: instBuy - instSell,
      retailNet: retailBuy - retailSell,
      instRatio,
      brokerCount: obj.brokers.length,
      rawObj
    };
  }
  const net = Number(obj.foreign_net ?? obj.net_value ?? obj.nval ?? 0);
  if (!Number.isFinite(net)) return null;
  return {
    emptyConfirmed: false,
    bval: Math.max(0, net), sval: Math.max(0, -net), nval: net,
    top3BuyNet: Math.max(0, net), top5BuyNet: Math.max(0, net),
    totalTurnover: Math.abs(net),
    cr3Pct: net > 0 ? 100 : 0, cr5Pct: net > 0 ? 100 : 0,
    instBuy: 0, instSell: 0, retailBuy: 0, retailSell: 0,
    instNet: 0, retailNet: 0, instRatio: null,
    brokerCount: 1, rawObj: null
  };
}

function calcEMA(arr, period) {
  if (!arr.length) return null;
  const k = 2 / (period + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMacdHist(closes) {
  if (!Array.isArray(closes) || closes.length < 35) return null;
  const fastK = 2 / 13;
  const slowK = 2 / 27;
  const sigK = 2 / 10;
  let emaFast = closes[0];
  let emaSlow = closes[0];
  const macdLine = [];
  for (let i = 1; i < closes.length; i++) {
    emaFast = closes[i] * fastK + emaFast * (1 - fastK);
    emaSlow = closes[i] * slowK + emaSlow * (1 - slowK);
    if (i >= 25) macdLine.push(emaFast - emaSlow);
  }
  if (macdLine.length < 9) return null;
  let signal = macdLine[0];
  for (let i = 1; i < macdLine.length; i++) {
    signal = macdLine[i] * sigK + signal * (1 - sigK);
  }
  return Number((macdLine[macdLine.length - 1] - signal).toFixed(3));
}

function calcRSI14(closes) {
  if (closes.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgG = gains / 14;
  const avgL = losses / 14;
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function calcAtr14(candles) {
  if (candles.length < 2) return null;
  const slice = candles.slice(-Math.min(15, candles.length));
  let sum = 0;
  let count = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const p = slice[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (Number.isFinite(tr) && tr > 0) { sum += tr; count++; }
  }
  return count > 0 ? sum / count : null;
}

function loadIdxEmitenMap(rootDir) {
  const map = {};
  try {
    const jsMapPath = path.join(rootDir, 'public', 'assets', 'idx-tickers.json');
    if (fs.existsSync(jsMapPath)) {
      const parsed = JSON.parse(fs.readFileSync(jsMapPath, 'utf8'));
      if (parsed && typeof parsed === 'object') Object.assign(map, parsed);
    }
  } catch (_) {}
  try {
    const csvPath = path.join(rootDir, 'public', 'assets', 'idx-tickers.csv');
    if (fs.existsSync(csvPath)) {
      const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = /^([A-Z0-9]{3,6}),\s*"?([^"\r\n]+)"?\s*$/.exec(line.trim());
        if (m && m[1] && m[2] && m[2].toUpperCase() !== 'NAME') {
          if (!map[m[1]]) map[m[1]] = m[2].trim();
        }
      }
    }
  } catch (_) {}
  try {
    const ownMapPath = path.join(rootDir, 'data', 'cache', 'ownership-names-map.json');
    if (fs.existsSync(ownMapPath)) {
      const parsed = JSON.parse(fs.readFileSync(ownMapPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (k && v && !map[k]) map[k] = v;
        }
      }
    }
  } catch (_) {}
  return map;
}

function clampScore(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function subtractDaysYmd(ymd, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - days));
  return dt.toISOString().slice(0, 10);
}

function summarizeInsiders(itemsJson, sessionDate) {
  let obj;
  try { obj = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson; } catch (_) { return null; }
  const items = Array.isArray(obj && obj.items) ? obj.items : (Array.isArray(obj) ? obj : []);
  if (!items.length) return { signal: 'NEUTRAL', buyCount: 0, sellCount: 0, netShares: 0, latestDate: null, bonus: 0 };
  const cutoff = subtractDaysYmd(sessionDate, 30);
  let buyCount = 0;
  let sellCount = 0;
  let netShares = 0;
  let latestDate = null;
  for (const it of items) {
    const dt = String(it && it.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
    if (!latestDate || dt > latestDate) latestDate = dt;
    if (cutoff && dt < cutoff) continue;
    const act = String(it.action_type || it.action || it.type || '').toLowerCase();
    const sharesNum = Number(String(it.change_shares || it.changes || it.shares || 0).replace(/[^0-9.-]/g, ''));
    const absShares = Number.isFinite(sharesNum) ? Math.abs(sharesNum) : 0;
    if (act === 'buy' || act.includes('beli')) {
      buyCount++;
      netShares += absShares;
    } else if (act === 'sell' || act.includes('jual')) {
      sellCount++;
      netShares -= absShares;
    }
  }
  let signal = 'NEUTRAL';
  let bonus = 0;
  if (buyCount > sellCount) {
    signal = 'BUY_30D';
    bonus = buyCount >= 2 ? 5 : 3;
  } else if (sellCount > buyCount) {
    signal = 'SELL_30D';
    bonus = sellCount >= 2 ? -4 : -2;
  }
  return { signal, buyCount, sellCount, netShares, latestDate, bonus };
}

function computeDerivedDomesticWindow(recentAll, foreignSeries, avgValue20d, ticker) {
  if (!Array.isArray(recentAll) || !recentAll.length || !Array.isArray(foreignSeries) || !foreignSeries.length) {
    return { domesticScore: null, domesticNetToday: null, domesticNetWindow: null, domesticSmartNet: null, domesticCr3Pct: null, domesticAsOf: null };
  }
  const fByDate = new Map(foreignSeries.map((r) => [r.date, r]));
  const domFrames = [];
  for (const a of recentAll) {
    const f = fByDate.get(a.date);
    if (!f) continue;
    if (a.rawObj && f.rawObj) {
      const domRes = computeDomesticBroksum(a.rawObj, f.rawObj, a.date, ticker);
      if (domRes && domRes.status === 'RELEASED' && Array.isArray(domRes.brokers)) {
        let domNet = 0;
        let domTurn = 0;
        let domBuy = 0;
        let domInstNet = 0;
        let domRetailNet = 0;
        const posNets = [];
        const grossBuys = [];
        for (const db of domRes.brokers) {
          const code = String(db.broker_code || '').toUpperCase();
          const bval = Number(db.bval || 0);
          const sval = Number(db.sval || 0);
          const nval = Number(db.nval != null ? db.nval : (bval - sval));
          domNet += nval;
          domTurn += bval + sval;
          domBuy += bval;
          if (nval > 0) posNets.push(nval);
          if (bval > 0) grossBuys.push(bval);
          if (INSTITUTIONAL_BROKERS.has(code)) domInstNet += nval;
          if (RETAIL_BROKERS.has(code)) domRetailNet += nval;
        }
        posNets.sort((x, y) => y - x);
        grossBuys.sort((x, y) => y - x);
        const top3BuyNet = posNets.slice(0, 3).reduce((s, x) => s + x, 0);
        const top5NetSum = posNets.slice(0, 5).reduce((s, x) => s + x, 0);
        const cr3 = domBuy > 0 ? (grossBuys.slice(0, 3).reduce((s, x) => s + x, 0) / domBuy) * 100 : 0;
        domFrames.push({
          date: a.date,
          net: domNet,
          smartNet: top3BuyNet,
          top5Net: top5NetSum,
          cr3,
          turnover: domTurn,
          domInstNet,
          domRetailNet
        });
        continue;
      }
    }
    // Lightweight unit-test fallback frames when broker array isn't populated
    const fallbackDomNet = Number(a.nval || 0) - Number(f.nval || 0);
    const estTop3 = Math.max(0, Number(a.top3BuyNet || 0) - Math.max(0, Number(f.nval || 0)));
    domFrames.push({
      date: a.date,
      net: fallbackDomNet,
      smartNet: estTop3 > 0 ? estTop3 : Math.max(0, fallbackDomNet),
      top5Net: fallbackDomNet,
      cr3: 50,
      turnover: a.totalTurnover || 1,
      domInstNet: fallbackDomNet > 0 ? fallbackDomNet * 0.5 : 0,
      domRetailNet: 0
    });
  }
  if (!domFrames.length) {
    return { domesticScore: null, domesticNetToday: null, domesticNetWindow: null, domesticSmartNet: null, domesticCr3Pct: null, domesticAsOf: null };
  }
  const latestDom = domFrames[domFrames.length - 1];
  const smartWin = domFrames.reduce((s, d) => s + d.smartNet, 0);
  const netWin = domFrames.reduce((s, d) => s + d.net, 0);
  const turnWin = domFrames.reduce((s, d) => s + d.turnover, 0);
  const instNetWin = domFrames.reduce((s, d) => s + d.domInstNet, 0);
  const retailNetWin = domFrames.reduce((s, d) => s + d.domRetailNet, 0);
  const avgCr3 = domFrames.reduce((s, d) => s + d.cr3, 0) / domFrames.length;
  const denom = turnWin > 0 ? turnWin : (avgValue20d > 0 ? avgValue20d * domFrames.length : 1);
  const smartRatio = denom > 0 ? smartWin / denom : 0;
  // Real Domestic accumulation: concentration (CR3 + Top-3 net) + Institutional absorbing retail supply
  let instAdj = 0;
  if (instNetWin > 0 && retailNetWin <= 0) instAdj = 12;
  else if (instNetWin > 0) instAdj = 6;
  else if (instNetWin < 0 && retailNetWin > 0) instAdj = -14;
  const cr3Boost = avgCr3 >= 55 ? 8 : (avgCr3 >= 40 ? 4 : 0);
  const domesticScore = clampScore(48 + smartRatio * 140 + cr3Boost + instAdj);
  return {
    domesticScore,
    domesticNetToday: Math.round(latestDom.net),
    domesticNetWindow: Math.round(netWin),
    domesticSmartNet: Math.round(latestDom.smartNet),
    domesticCr3Pct: Number(avgCr3.toFixed(2)),
    domesticAsOf: latestDom.date
  };
}

function buildHorizonCandidate(ticker, candles, allBrokerSeries, foreignSeries, horizonCfg, maxTradeDate, emitenName, isKonglo, minRr, extraContext = {}) {
  const key = horizonCfg.key || 'short_swing';
  const limits = HORIZON_PLAN_LIMITS[key] || HORIZON_PLAN_LIMITS.short_swing;
  if (!Array.isArray(candles) || candles.length < limits.minCandles) return null;

  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!latest || latest.time < maxTradeDate) return null; // skip suspended / stale tickers
  const close = Number(latest.close);
  // Kloter 1 All-Price >= Rp 1: permit Rp 1–49 equities equally when market quality & risk structure hold
  if (!Number.isFinite(close) || close < 1) return null;

  const recent20Candles = candles.slice(-20);
  const prevClose = Number(prev && prev.close) > 0 ? Number(prev.close) : close;
  const changePct = Number((((close - prevClose) / prevClose) * 100).toFixed(2));
  const valueTraded = close * Number(latest.volume || 0);
  if (valueTraded < limits.minValueToday) return null;

  const lb = Math.max(5, Number(horizonCfg.lookbackDays || 10));
  const windowCandles = candles.slice(-Math.min(candles.length, lb));
  const closes = candles.map((c) => Number(c.close));
  const ma20Slice = closes.slice(-Math.min(closes.length, 20));
  const sma20 = ma20Slice.reduce((a, b) => a + b, 0) / ma20Slice.length;
  const ma50Slice = closes.length >= 50 ? closes.slice(-50) : null;
  const ma50 = ma50Slice ? (ma50Slice.reduce((a, b) => a + b, 0) / ma50Slice.length) : null;
  const val20Slice = recent20Candles.map((c) => Number(c.close || 0) * Number(c.volume || 0));
  const avgValue20d = val20Slice.length ? (val20Slice.reduce((a, b) => a + b, 0) / val20Slice.length) : valueTraded;
  if (avgValue20d < limits.minAvgValue20d) return null;

  const ema9 = calcEMA(closes.slice(-Math.min(closes.length, 25)), 9) || close;
  const ema20 = calcEMA(closes.slice(-Math.min(closes.length, 40)), 20) || close;
  const closesPrev5 = closes.slice(0, Math.max(10, closes.length - 5));
  const ema20Prev5 = calcEMA(closesPrev5.slice(-Math.min(closesPrev5.length, 40)), 20) || ema20;
  const ema50 = calcEMA(closes.slice(-Math.min(closes.length, 80)), 50) || close;
  const rsi14 = calcRSI14(closes);
  const macdHist = calcMacdHist(closes);
  const atr = calcAtr14(candles) || Math.max(idxTick.idxTickSize(close), close * 0.02);

  // Volume ratio vs trailing baseline (10d for Potensi Besok breakout, 20d for swings)
  const volRefCandles = key === 'potensi_besok' ? candles.slice(-11, -1) : candles.slice(-21, -1);
  const vols = (volRefCandles.length ? volRefCandles : windowCandles.slice(0, -1))
    .map((c) => Number(c.volume || 0))
    .filter((v) => v > 0);
  const avgVol = vols.length ? (vols.reduce((a, b) => a + b, 0) / vols.length) : 0;
  const volRatio = avgVol > 0 && latest.volume > 0 ? Number((latest.volume / avgVol).toFixed(2)) : null;

  // Horizon technical & liquidity gates
  if (volRatio == null || volRatio < limits.minRvol) return null;
  if (rsi14 == null || rsi14 < limits.rsiMin || rsi14 > limits.rsiMax) return null;
  if (limits.requireCloseAboveEma20 && close < ema20 * 0.99) return null;

  const dayHigh = Number(latest.high || close);
  const dayLow = Number(latest.low || close);
  const dayRange = Math.max(1, dayHigh - dayLow);
  const closePos = (close - dayLow) / dayRange;
  if (key === 'potensi_besok') {
    if (changePct > 18 || close < ema9 * 0.99 || close < ema20 * 0.985 || closePos < 0.45) return null;
  }

  // Real Pillar 1 & 3: Broksum ALL (CR3/CR5 + Inst/Retail) + Derived Domestic (D = ALL - F)
  const flowDays = limits.flowDays;
  const recentAllRaw = (allBrokerSeries || []).slice(-Math.min(flowDays, (allBrokerSeries || []).length));
  const latestAll = recentAllRaw.length ? recentAllRaw[recentAllRaw.length - 1] : null;
  const bandarAsOf = latestAll ? latestAll.date : null;
  const nonEmptyAll = recentAllRaw.filter((r) => !r.emptyConfirmed && (r.totalTurnover || 0) > 0);
  const domMetrics = computeDerivedDomesticWindow(recentAllRaw, foreignSeries, avgValue20d, ticker);

  let bandarScore = null;
  let allBandarScore = null;
  let cr3Avg = null;
  let cr5Avg = null;
  let instRetailRatio = null;
  let bandarNetToday = latestAll ? Number(latestAll.top3BuyNet || latestAll.instNet || latestAll.nval || 0) : null;
  if (nonEmptyAll.length > 0) {
    let accSum = 0;
    let turnSum = 0;
    let posDays = 0;
    let cr3Sum = 0;
    let cr5Sum = 0;
    let instBuySum = 0;
    let retailBuySum = 0;
    let instNetSum = 0;
    let retailNetSum = 0;
    for (const r of nonEmptyAll) {
      accSum += r.top3BuyNet || 0;
      turnSum += r.totalTurnover || 0;
      cr3Sum += r.cr3Pct || 0;
      cr5Sum += r.cr5Pct || 0;
      instBuySum += r.instBuy || 0;
      retailBuySum += r.retailBuy || 0;
      instNetSum += r.instNet || 0;
      retailNetSum += r.retailNet || 0;
      if ((r.top3BuyNet || 0) > 0 || (r.nval || 0) > 0) posDays++;
    }
    cr3Avg = Number((cr3Sum / nonEmptyAll.length).toFixed(2));
    cr5Avg = Number((cr5Sum / nonEmptyAll.length).toFixed(2));
    const irTotal = instBuySum + retailBuySum;
    instRetailRatio = irTotal > 0 ? Number((instBuySum / irTotal).toFixed(3)) : null;

    const ratio = turnSum > 0 ? accSum / turnSum : 0;
    const consistencyBonus = (posDays / nonEmptyAll.length) * 14;
    let concBonus = 0;
    if (cr3Avg >= 60) concBonus += 10;
    else if (cr5Avg >= 70) concBonus += 6;
    else if (cr3Avg >= 50) concBonus += 4;
    let instBonus = 0;
    if (instRetailRatio != null) {
      if (instRetailRatio >= 0.70) instBonus += 10;
      else if (instRetailRatio >= 0.50) instBonus += 5;
    }
    if (instNetSum > 0 && retailNetSum < 0) instBonus += 6;
    else if (instNetSum < 0 && retailNetSum > 0) instBonus -= 8;

    allBandarScore = clampScore(42 + ratio * 145 + consistencyBonus + concBonus + instBonus);
    bandarScore = domMetrics.domesticScore != null
      ? clampScore(allBandarScore * 0.78 + domMetrics.domesticScore * 0.22)
      : allBandarScore;
  }

  // Real Pillar 2: Broksum Foreign Flow
  const recentForeign = (foreignSeries || []).slice(-Math.min(flowDays, (foreignSeries || []).length));
  const latestForeign = recentForeign.length ? recentForeign[recentForeign.length - 1] : null;
  const foreignAsOf = latestForeign ? latestForeign.date : null;
  let foreignScore = null;
  let foreignNetToday = null;
  let foreignNetWindow = null;
  if (recentForeign.length > 0) {
    foreignNetToday = latestForeign ? Number(latestForeign.nval || 0) : 0;
    foreignNetWindow = recentForeign.reduce((s, r) => s + Number(r.nval || 0), 0);
    const ratio = avgValue20d > 0 ? foreignNetWindow / (avgValue20d * recentForeign.length) : 0;
    const fPosDays = recentForeign.filter((r) => (r.nval || 0) > 0).length;
    foreignScore = clampScore(50 + ratio * 220 + ((fPosDays / recentForeign.length) - 0.5) * 16);
  }

  // Real Pillar 4 & 5: Insider 30D + KSEI Ownership / Free Float + Fundamentals
  const insiderInfo = extraContext.insider || null;
  const fundInfo = extraContext.fundamental || null;
  const kseiInfo = extraContext.ksei || null;
  const freeFloatPct = kseiInfo && kseiInfo.freeFloat != null
    ? Number(kseiInfo.freeFloat)
    : (fundInfo && fundInfo.free_float_pct != null ? Number(fundInfo.free_float_pct) : null);

  // Swing (7-30H) structural trend OR healthy accumulation base (instead of rejecting valid reversal bases)
  if (key === 'swing') {
    const aboveMa50 = ma50 != null && close > ma50 && ema20 >= ma50 * 0.985;
    const hasSmartAccum = (bandarScore != null && bandarScore >= 52)
      || (foreignScore != null && foreignScore >= 56)
      || (domMetrics.domesticScore != null && domMetrics.domesticScore >= 56)
      || (insiderInfo && insiderInfo.signal === 'BUY_30D');
    const structuralBaseAccum = limits.allowMa50OrStructuralBase
      && close >= ema20
      && ema20 >= ema20Prev5 * 0.992
      && hasSmartAccum;
    if (limits.requireCloseAboveMa50 && !aboveMa50) return null;
    if (!limits.requireCloseAboveMa50 && !aboveMa50 && !structuralBaseAccum) return null;
  }

  // Horizon-differentiated technical & multi-pillar score
  let techScore = 44;
  if (key === 'potensi_besok') {
    if (close > ema9) techScore += 14;
    if (close > ema20) techScore += 10;
    if (closePos >= 0.7) techScore += 12;
    else if (closePos >= 0.5) techScore += 6;
    if (volRatio >= 2.0) techScore += 14;
    else if (volRatio >= 1.5) techScore += 8;
    if (changePct > 0.5 && changePct <= 9) techScore += 6;
    if (macdHist != null && macdHist > 0) techScore += 4;
  } else if (key === 'short_swing') {
    if (close > ema20) techScore += 15;
    if (ema20 > ema50) techScore += 12;
    if (rsi14 >= 50 && rsi14 <= 66) techScore += 15;
    else if (rsi14 >= 45 && rsi14 <= 70) techScore += 8;
    if (volRatio >= 1.2 && volRatio <= 4.0) techScore += 8;
    if (close > sma20 && close <= sma20 * 1.08) techScore += 6;
    if (macdHist != null && macdHist > 0) techScore += 4;
  } else {
    if (ma50 != null && close > ma50) techScore += 18;
    else if (close > ema20 && ema20 >= ema20Prev5) techScore += 11;
    if (ma50 != null && ema20 > ma50) techScore += 12;
    if (rsi14 >= 45 && rsi14 <= 62) techScore += 14;
    else if (rsi14 >= 40 && rsi14 <= 68) techScore += 8;
    if (avgValue20d >= 20e9) techScore += 10;
    else if (avgValue20d >= 5e9) techScore += 6;
    if (changePct >= -1 && changePct <= 5) techScore += 4;
    if (macdHist != null && macdHist > 0) techScore += 4;
  }

  const insiderBonus = insiderInfo ? Number(insiderInfo.bonus || 0) : 0;
  const fundProfit = fundInfo && fundInfo.net_profit != null ? Number(fundInfo.net_profit) : null;
  const fundamentalBonus = fundProfit != null ? (fundProfit > 0 ? 2 : (fundProfit < 0 ? -1 : 0)) : 0;
  techScore = clampScore(techScore + insiderBonus + fundamentalBonus);

  // SSOT Structural Trade Plan Builder (All-Price >= Rp 1, strict IDX ticks, hard R:R & risk band)
  let entryHigh = idxTick.roundDownToIdxTick(close);
  if (!entryHigh || entryHigh < 1) return null;
  const maxEntryFloorForSpread = entryHigh / 1.04;
  const pullbackAnchor = Math.max(
    close - 0.30 * atr,
    ema20 < close && ema20 >= maxEntryFloorForSpread ? ema20 * 0.995 : maxEntryFloorForSpread
  );
  let entryLow = idxTick.roundUpToIdxTick(Math.max(1, maxEntryFloorForSpread, pullbackAnchor));
  if (!entryLow || entryLow > entryHigh) entryLow = entryHigh;
  const entrySpreadPct = entryLow > 0 ? ((entryHigh - entryLow) / entryLow) * 100 : 0;
  if (entryLow < 1 || entrySpreadPct > 4.001) return null;

  const supportCandles = candles.slice(-Math.min(candles.length, key === 'potensi_besok' ? 10 : (key === 'short_swing' ? 20 : 35)));
  const structLow = Math.min(...supportCandles.map((c) => Number(c.low || close)));

  const pickSlOptions = (eLow, guard) => {
    const tickE = idxTick.idxTickSize(eLow);
    const tickP = (tickE / eLow) * 100;
    const minTicks = (eLow < 50 && tickP >= limits.slMinPct * 0.85) ? 1 : 2;
    const floorGuard = eLow - minTicks * tickE;
    const effMaxPct = eLow <= 14 ? Math.min(15.0, Math.max(limits.slMaxPct, tickP * 1.05)) : limits.slMaxPct;
    const sub50SingleTickStop = (eLow < 50 && tickP >= limits.slMinPct * 0.85 && (atr / Math.max(1, close)) <= 0.12)
      ? floorGuard
      : null;
    const cands = [
      structLow - idxTick.idxTickSize(Math.max(1, structLow)),
      ema20 < eLow ? (ema20 - idxTick.idxTickSize(Math.max(1, ema20))) : null,
      ma50 != null && ma50 < eLow ? (ma50 - idxTick.idxTickSize(Math.max(1, ma50))) : null,
      entryHigh - limits.atrSlMult * atr,
      sub50SingleTickStop
    ].filter((v) => Number.isFinite(v) && v >= 1 && v <= Math.min(guard, floorGuard));

    const opts = [];
    for (const cand of cands) {
      const snapped = idxTick.roundDownToIdxTick(cand);
      if (!snapped || snapped < 1 || snapped > floorGuard || snapped >= eLow) continue;
      const pct = ((entryHigh - snapped) / entryHigh) * 100;
      if (pct >= Math.min(limits.slMinPct, tickP) - 1e-6 && pct <= effMaxPct + 1e-6) {
        opts.push({ sl: snapped, pct });
      }
    }
    if (opts.length === 0) {
      const minSlPriceTarget = entryHigh * (1 - limits.slMinPct / 100);
      const atrSl = idxTick.roundDownToIdxTick(Math.min(minSlPriceTarget, entryHigh - limits.atrSlMult * atr));
      if (atrSl && atrSl >= 1 && atrSl <= floorGuard && atrSl < eLow) {
        const pct = ((entryHigh - atrSl) / entryHigh) * 100;
        if (pct >= Math.min(limits.slMinPct, tickP) - 1e-6 && pct <= effMaxPct + 1e-6) {
          opts.push({ sl: atrSl, pct });
        }
      }
    }
    return opts;
  };

  let validSlOptions = pickSlOptions(entryLow, entryLow);
  // For sub-50 tick economics (e.g. close=26, 1 tick=3.85%), tightening entryLow=entryHigh frees 1 tick for valid SL corridor
  if (validSlOptions.length === 0 && entryLow < entryHigh && close < 50) {
    entryLow = entryHigh;
    validSlOptions = pickSlOptions(entryLow, entryLow);
  }
  if (validSlOptions.length === 0) return null;
  validSlOptions.sort((a, b) => a.pct - b.pct);
  const sl = validSlOptions[0].sl;
  const slPct = validSlOptions[0].pct;

  // Realistic structural/ATR TP1 & TP2
  const horizonMinRr = Math.max(Number(minRr || 0), limits.minRr);
  const resCandles = candles.slice(-Math.min(candles.length, key === 'potensi_besok' ? 20 : (key === 'short_swing' ? 40 : 65)));
  const resHigh = Math.max(...resCandles.map((c) => Number(c.high || close)));
  const tp1FloorPx = entryHigh * (1 + limits.tp1MinPct / 100);
  const tp1CapPx = entryHigh * (1 + limits.tp1MaxPct / 100);
  const atrTarget1 = entryHigh + limits.atrTp1Mult * atr;
  const structuralTarget1 = resHigh > tp1FloorPx ? Math.min(tp1CapPx, resHigh) : atrTarget1;
  const blendedRawTp1 = Math.min(tp1CapPx, Math.max(tp1FloorPx, (atrTarget1 * 0.65) + (structuralTarget1 * 0.35)));
  let tp1 = idxTick.roundDownToIdxTick(blendedRawTp1);
  if (!tp1 || tp1 <= entryHigh) tp1 = idxTick.roundUpToIdxTick(tp1FloorPx);
  if (!tp1 || tp1 <= entryHigh) return null;
  const tp1Pct = ((tp1 - entryHigh) / entryHigh) * 100;
  if (tp1Pct < limits.tp1MinPct - 1e-6 || tp1Pct > limits.tp1MaxPct + 1e-6) return null;

  const rr = idxTick.rrFromLevels(entryHigh, sl, tp1);
  if (rr == null || (rr + 1e-6) < horizonMinRr) return null;

  const risk = Math.max(1, entryHigh - sl);
  const tp2CapPx = entryHigh * (1 + limits.tp2MaxPct / 100);
  const rawTp2 = Math.min(tp2CapPx, Math.max(tp1 + risk * 1.15, entryHigh + limits.atrTp2Mult * atr));
  let tp2 = idxTick.roundUpToIdxTick(rawTp2);
  if (tp2 > tp2CapPx) tp2 = idxTick.roundDownToIdxTick(tp2CapPx);
  if (!tp2 || tp2 <= tp1) tp2 = idxTick.tickAbove(tp1);
  if (!tp2 || !(1 <= sl && sl < entryLow && entryLow <= entryHigh && entryHigh < tp1 && tp1 < tp2)) return null;

  const atrPct = atr / Math.max(1, close);
  const riskLabel = (slPct <= 5.5 && rr >= 1.8 && atrPct <= 0.045)
    ? 'Risiko Rendah'
    : (slPct <= 10.0 && atrPct <= 0.075 ? 'Risiko Sedang' : 'Risiko Tinggi');

  const resolvedCompanyName = emitenName || (kseiInfo && kseiInfo.name) || (fundInfo && (fundInfo.company_name || fundInfo.name)) || null;
  const pillarBreakdown = {
    broksum_all: { score: allBandarScore, net_today: bandarNetToday, cr3_pct: cr3Avg, cr5_pct: cr5Avg, inst_retail_ratio: instRetailRatio, as_of: bandarAsOf },
    domestic: { score: domMetrics.domesticScore, net_today: domMetrics.domesticNetToday, net_window: domMetrics.domesticNetWindow, as_of: domMetrics.domesticAsOf, formula: 'ALL - Foreign' },
    foreign: { score: foreignScore, net_today: foreignNetToday, net_window: foreignNetWindow, as_of: foreignAsOf },
    insider: insiderInfo ? { signal: insiderInfo.signal, buy_30d: insiderInfo.buyCount, sell_30d: insiderInfo.sellCount, net_shares: insiderInfo.netShares, latest_date: insiderInfo.latestDate, bonus: insiderBonus } : null,
    free_float: { pct: freeFloatPct, source: kseiInfo ? 'KSEI_2026_10_30' : (fundInfo && fundInfo.free_float_pct != null ? 'stock_fundamentals' : null), as_of: (kseiInfo && kseiInfo.as_of) || (fundInfo && fundInfo.free_float_as_of) || null },
    fundamental: fundInfo ? { pbv: fundInfo.pbv != null ? Number(fundInfo.pbv) : null, net_profit: fundProfit, market_cap: fundInfo.market_cap != null ? Number(fundInfo.market_cap) : null, sector: fundInfo.sector || null, period: fundInfo.fundamental_period || null, bonus: fundamentalBonus } : null,
    volume: { rvol: volRatio, value_today: Math.round(valueTraded), avg_value_20d: Math.round(avgValue20d), as_of: maxTradeDate },
    technical: { score: techScore, rsi14, ema9: Number(ema9.toFixed(2)), ema20: Number(ema20.toFixed(2)), ma20: Number(sma20.toFixed(2)), ma50: ma50 != null ? Number(ma50.toFixed(2)) : null, macd_hist: macdHist, atr14: Number(atr.toFixed(2)), as_of: maxTradeDate }
  };

  return {
    ticker,
    emiten: resolvedCompanyName,
    company_name: resolvedCompanyName,
    name: resolvedCompanyName,
    stock_name: resolvedCompanyName,
    last_price: close,
    close,
    high_price: dayHigh,
    low_price: dayLow,
    change_pct: changePct,
    volume: Number(latest.volume || 0),
    value_today: Math.round(valueTraded),
    avg_value_20d: Math.round(avgValue20d),
    ema9: Number(ema9.toFixed(2)),
    ema20: Number(ema20.toFixed(2)),
    ma20: Number(sma20.toFixed(2)),
    ma50: ma50 != null ? Number(ma50.toFixed(2)) : null,
    macd_hist: macdHist,
    volume_ratio: volRatio,
    volume_asof: maxTradeDate,
    technical_score: techScore,
    technical_asof: maxTradeDate,
    rsi14,
    bandar_score: bandarScore,
    bandar_asof: bandarAsOf,
    bandar_net: bandarNetToday != null ? Math.round(bandarNetToday) : null,
    cr3_pct: cr3Avg,
    cr5_pct: cr5Avg,
    inst_retail_ratio: instRetailRatio,
    domestic_score: domMetrics.domesticScore,
    domestic_net: domMetrics.domesticNetToday,
    domestic_net_window: domMetrics.domesticNetWindow,
    domestic_asof: domMetrics.domesticAsOf,
    foreign_score: foreignScore,
    foreign_asof: foreignAsOf,
    foreign_net: foreignNetToday != null ? Math.round(foreignNetToday) : null,
    foreign_net_window: foreignNetWindow != null ? Math.round(foreignNetWindow) : null,
    insider_signal: insiderInfo ? insiderInfo.signal : null,
    insider_buy_30d_count: insiderInfo ? insiderInfo.buyCount : null,
    insider_sell_30d_count: insiderInfo ? insiderInfo.sellCount : null,
    insider_asof: insiderInfo ? insiderInfo.latestDate : null,
    free_float_pct: freeFloatPct,
    ksei_as_of: (kseiInfo && kseiInfo.as_of) || null,
    pbv: fundInfo && fundInfo.pbv != null ? Number(fundInfo.pbv) : null,
    net_profit: fundProfit,
    market_cap: fundInfo && fundInfo.market_cap != null ? Number(fundInfo.market_cap) : null,
    sector: (fundInfo && fundInfo.sector) || (kseiInfo && kseiInfo.sector) || null,
    pillar_breakdown: pillarBreakdown,
    entry_low: entryLow,
    entry_high: entryHigh,
    entry1: entryHigh,
    entry2: entryLow,
    sl,
    stop_loss: sl,
    tp1,
    tp2,
    risk_reward: rr,
    rr,
    min_rr: horizonMinRr,
    sl_pct: Number(slPct.toFixed(2)),
    tp1_pct: Number(tp1Pct.toFixed(2)),
    risk_label: riskLabel,
    risk_label_v2: riskLabel,
    action_label: close <= entryHigh * 1.01 ? 'Beli Bertahap' : 'Tunggu Pullback',
    status: 'READY',
    readiness_status: 'READY',
    horizon: key,
    horizon_label: horizonCfg.label,
    holding_label: horizonCfg.holdingLabel,
    holding_days_min: horizonCfg.minHoldingDays,
    holding_days_max: horizonCfg.maxHoldingDays,
    intraday_status: 'OPEN',
    is_konglo: isKonglo,
    session_date: maxTradeDate,
    trade_date: maxTradeDate,
    price_asof: maxTradeDate,
    price_date: maxTradeDate,
    price_source: 'sqlite_market_rows',
    calculated_at: new Date().toISOString()
  };
}

function run(options = {}) {
  const dbPath = resolveDbPath(options.dbPath);
  if (!dbPath) throw new Error('CANONICAL_DB_NOT_FOUND');

  const { DatabaseSync } = require('node:sqlite');
  const roDb = new DatabaseSync(dbPath, { readOnly: true, fileMustExist: true });
  try { roDb.exec('PRAGMA busy_timeout=15000;'); } catch (_) {}

  const rawCandlesByTicker = new Map();
  const allBrokerByTicker = new Map();
  const foreignByTicker = new Map();
  const insiderRawByTicker = new Map();
  const fundamentalsByTicker = new Map();
  let latestOhlcvDate = '';
  let latestAllDate = '';
  let latestForeignDate = '';
  let latestInsidersDate = '';

  try {
    const histRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_daily_history'"
    ).all();
    for (const r of histRows) {
      let row;
      try { row = JSON.parse(r.row_json); } catch (_) { continue; }
      const ticker = String(row.ticker || String(r.row_key || '').split('\x1f')[0] || '').trim().toUpperCase();
      const dt = String(row.trade_date || row.date || '').slice(0, 10);
      const close = Number(row.close);
      if (!/^[A-Z0-9]{3,6}$/.test(ticker) || ticker === 'IHSG' || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
      if (!Number.isFinite(close) || close <= 0) continue;
      if (dt > latestOhlcvDate) latestOhlcvDate = dt;
      if (!rawCandlesByTicker.has(ticker)) rawCandlesByTicker.set(ticker, []);
      rawCandlesByTicker.get(ticker).push({
        time: dt,
        open: Number(row.open) > 0 ? Number(row.open) : close,
        high: Number(row.high) > 0 ? Number(row.high) : close,
        low: Number(row.low) > 0 ? Number(row.low) : close,
        close,
        volume: Number(row.volume) >= 0 ? Number(row.volume) : 0
      });
    }

    const allRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_broker_summary_all'"
    ).all();
    for (const r of allRows) {
      const parts = String(r.row_key || '').split(/[\x1f ]+/);
      const dt = parts[1] ? parts[1].slice(0, 10) : '';
      const t = parts[0] ? parts[0].trim().toUpperCase() : '';
      const parsed = parseBrokerNet(r.row_json);
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dt) || !parsed) continue;
      if (!parsed.emptyConfirmed && parsed.totalTurnover > 0 && dt > latestAllDate) latestAllDate = dt;
      if (!allBrokerByTicker.has(t)) allBrokerByTicker.set(t, []);
      allBrokerByTicker.get(t).push(Object.assign({ date: dt }, parsed));
    }

    const foreignRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_broker_summary_foreign'"
    ).all();
    for (const r of foreignRows) {
      const parts = String(r.row_key || '').split(/[\x1f ]+/);
      const dt = parts[1] ? parts[1].slice(0, 10) : '';
      const t = parts[0] ? parts[0].trim().toUpperCase() : '';
      const parsed = parseBrokerNet(r.row_json);
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dt) || !parsed) continue;
      if (!parsed.emptyConfirmed && dt > latestForeignDate) latestForeignDate = dt;
      if (!foreignByTicker.has(t)) foreignByTicker.set(t, []);
      foreignByTicker.get(t).push(Object.assign({ date: dt }, parsed));
    }

    const insiderRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'arjum_insiders'"
    ).all();
    for (const r of insiderRows) {
      const parts = String(r.row_key || '').split(/[\x1f ]+/);
      const dt = parts[1] ? parts[1].slice(0, 10) : '';
      const t = parts[0] ? parts[0].trim().toUpperCase() : '';
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
      if (dt > latestInsidersDate) latestInsidersDate = dt;
      const prev = insiderRawByTicker.get(t);
      if (!prev || dt > prev.date) insiderRawByTicker.set(t, { date: dt, raw: r.row_json });
    }

    const fundRows = roDb.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_fundamentals'"
    ).all();
    for (const r of fundRows) {
      let row;
      try { row = JSON.parse(r.row_json); } catch (_) { continue; }
      const t = String((row && row.ticker) || r.row_key || '').split(/[\x1f ]+/)[0].trim().toUpperCase();
      if (t) fundamentalsByTicker.set(t, row);
    }
  } finally {
    try { roDb.close(); } catch (_) {}
  }

  if (!latestOhlcvDate) throw new Error('NO_TRADE_DATE_IN_SQLITE');

  // Synchronized EOD clock (P0-08 parity): use latest session where OHLCV + Broksum ALL + Foreign agree
  let maxTradeDate = latestOhlcvDate;
  if (latestAllDate && latestForeignDate) {
    const minBrokerDate = latestAllDate <= latestForeignDate ? latestAllDate : latestForeignDate;
    if (minBrokerDate <= latestOhlcvDate) maxTradeDate = minBrokerDate;
  }

  // Filter OHLCV & broker series to <= maxTradeDate so every component clock matches session_date
  const candlesByTicker = new Map();
  for (const [ticker, list] of rawCandlesByTicker.entries()) {
    const trimmed = list.filter((c) => c.time <= maxTradeDate).sort((a, b) => a.time.localeCompare(b.time));
    if (trimmed.length > 0) candlesByTicker.set(ticker, trimmed);
  }
  for (const [ticker, list] of allBrokerByTicker.entries()) {
    allBrokerByTicker.set(ticker, list.filter((x) => x.date <= maxTradeDate).sort((a, b) => a.date.localeCompare(b.date)));
  }
  for (const [ticker, list] of foreignByTicker.entries()) {
    foreignByTicker.set(ticker, list.filter((x) => x.date <= maxTradeDate).sort((a, b) => a.date.localeCompare(b.date)));
  }

  const kseiLoaded = kseiOwnershipStore.loadActiveOwnership(ROOT);
  const kseiByTicker = new Map();
  for (const item of (kseiLoaded && Array.isArray(kseiLoaded.items) ? kseiLoaded.items : [])) {
    if (item && item.ticker) kseiByTicker.set(String(item.ticker).trim().toUpperCase(), item);
  }

  const insiderSummaryByTicker = new Map();
  for (const [t, rec] of insiderRawByTicker.entries()) {
    const s = summarizeInsiders(rec.raw, maxTradeDate);
    if (s) insiderSummaryByTicker.set(t, s);
  }

  const cfgRead = threeHorizonStore.get();
  const cfg = cfgRead.ok ? cfgRead.doc : threeHorizonStore.DEFAULT_CONFIG;
  const idxNames = loadIdxEmitenMap(ROOT);
  const tickerMap = Object.assign({}, getTickerMap(), idxNames);
  const kongloSet = loadKongloSet();
  const generatedAt = new Date().toISOString();

  const horizonSnapshots = {};
  for (const hKey of threeHorizonStore.HORIZON_KEYS) {
    const hCfg = cfg.horizons[hKey];
    const candidates = [];
    for (const [ticker, candles] of candlesByTicker.entries()) {
      const cand = buildHorizonCandidate(
        ticker,
        candles,
        allBrokerByTicker.get(ticker),
        foreignByTicker.get(ticker),
        hCfg,
        maxTradeDate,
        tickerMap[ticker] || null,
        kongloSet.has(ticker),
        cfg.minRr,
        {
          insider: insiderSummaryByTicker.get(ticker) || null,
          fundamental: fundamentalsByTicker.get(ticker) || null,
          ksei: kseiByTicker.get(ticker) || null
        }
      );
      if (cand) candidates.push(cand);
    }

    const snap = buildSahamPotensialSnapshot(candidates, {
      sessionDate: maxTradeDate,
      minRiskReward: hCfg.minRr || cfg.minRr,
      weights: hCfg.weights,
      holdingLabel: hCfg.holdingLabel,
      holdingDaysMin: hCfg.minHoldingDays,
      holdingDaysMax: hCfg.maxHoldingDays
    });

    const candByTicker = new Map(candidates.map((c) => [c.ticker, c]));
    const groupByTicker = kongloSet.groupByTicker || new Map();
    const enrichedTop20 = snap.top20.map((row, idx) => {
      const c = candByTicker.get(row.ticker) || {};
      const numScore = Number(row.score || 0);
      const rrNum = Number(row.risk_reward || row.rr || c.rr || 0);
      const swingTier = numScore >= 85 ? 'A_PLUS_SWING'
        : numScore >= 75 ? 'TRADE_CANDIDATE'
        : numScore >= 65 ? 'SWING_READY'
        : 'WATCHLIST';
      const conf = numScore >= 85 ? 'A+' : numScore >= 75 ? 'A' : numScore >= 65 ? 'B' : 'C';
      const volR = c.volume_ratio != null ? c.volume_ratio : (row.volume_ratio != null ? row.volume_ratio : null);
      const rsiV = c.rsi14 != null ? c.rsi14 : (row.rsi14 != null ? row.rsi14 : null);
      const reasonParts = [
        hCfg.holdingLabel || hCfg.label,
        rrNum > 0 ? ('R/R ' + rrNum.toFixed(2) + 'x') : null,
        volR != null ? ('Vol ' + Number(volR).toFixed(2) + 'x') : null,
        rsiV != null ? ('RSI ' + Number(rsiV).toFixed(1)) : null,
        c.domestic_net != null ? ('Dom ' + (c.domestic_net >= 0 ? '+' : '') + Math.round(c.domestic_net / 1e6) + 'jt') : null,
        c.insider_signal && c.insider_signal !== 'NEUTRAL' ? ('Insider ' + c.insider_signal) : null
      ].filter(Boolean);
      return Object.assign({}, row, {
        rank: idx + 1,
        emiten: c.company_name || (row.emiten && row.emiten !== row.ticker + ' Tbk' ? row.emiten : null) || row.ticker,
        company_name: c.company_name || null,
        name: c.company_name || null,
        stock_name: c.company_name || null,
        close: c.close != null ? c.close : row.last_price,
        horizon: hKey,
        horizon_key: hKey,
        horizon_label: hCfg.label,
        holding_label: hCfg.holdingLabel,
        holding_days_min: hCfg.minHoldingDays,
        holding_days_max: hCfg.maxHoldingDays,
        min_rr: hCfg.minRr || cfg.minRr,
        sl_pct: c.sl_pct != null ? c.sl_pct : null,
        tp1_pct: c.tp1_pct != null ? c.tp1_pct : null,
        screener_type: hKey,
        group_code: groupByTicker.get(row.ticker) || (kongloSet.has(row.ticker) ? 'KONGLO' : 'NON-KONGLO'),
        swing_tier: swingTier,
        confidence: conf,
        confidence_label: conf === 'A+' ? 'Sangat Tinggi' : (conf === 'A' ? 'Tinggi' : 'Cukup'),
        rsi14: rsiV,
        ema9: c.ema9 != null ? c.ema9 : null,
        ema20: c.ema20 != null ? c.ema20 : null,
        ma20: c.ma20 != null ? c.ma20 : null,
        ma50: c.ma50 != null ? c.ma50 : null,
        macd_hist: c.macd_hist != null ? c.macd_hist : null,
        volume: c.volume != null ? c.volume : row.volume,
        value_today: c.value_today != null ? c.value_today : null,
        avg_value_20d: c.avg_value_20d != null ? c.avg_value_20d : null,
        volume_ratio: volR,
        volume_ratio_avg20: volR,
        volume_ratio_20d: volR,
        bandar_net: c.bandar_net != null ? c.bandar_net : null,
        cr3_pct: c.cr3_pct != null ? c.cr3_pct : null,
        cr5_pct: c.cr5_pct != null ? c.cr5_pct : null,
        inst_retail_ratio: c.inst_retail_ratio != null ? c.inst_retail_ratio : null,
        domestic_score: c.domestic_score != null ? c.domestic_score : null,
        domestic_net: c.domestic_net != null ? c.domestic_net : null,
        domestic_net_window: c.domestic_net_window != null ? c.domestic_net_window : null,
        domestic_asof: c.domestic_asof || null,
        foreign_score: c.foreign_score != null ? c.foreign_score : row.foreign_flow_score,
        foreign_net: c.foreign_net != null ? c.foreign_net : null,
        foreign_net_window: c.foreign_net_window != null ? c.foreign_net_window : null,
        insider_signal: c.insider_signal || null,
        insider_buy_30d_count: c.insider_buy_30d_count != null ? c.insider_buy_30d_count : null,
        insider_sell_30d_count: c.insider_sell_30d_count != null ? c.insider_sell_30d_count : null,
        insider_asof: c.insider_asof || null,
        free_float_pct: c.free_float_pct != null ? c.free_float_pct : null,
        ksei_as_of: c.ksei_as_of || null,
        pbv: c.pbv != null ? c.pbv : null,
        net_profit: c.net_profit != null ? c.net_profit : null,
        market_cap: c.market_cap != null ? c.market_cap : null,
        sector: c.sector || null,
        pillar_breakdown: c.pillar_breakdown || null,
        risk_label: c.risk_label || null,
        risk_label_v2: c.risk_label || null,
        action_label: c.action_label || null,
        data_status: 'AVAILABLE',
        readiness_status: row.readiness === 'READY' ? 'READY' : (row.readiness || 'READY'),
        verdict_reasons: row.readiness === 'READY' ? ['ALL_GATES_PASSED'] : [row.status_reason || 'CHECK_READINESS'],
        win_rate_pct: null,
        entry_timing: 'Masih dekat entry',
        entry_window_label: 'Area entry aktif',
        direction: Number(row.change_pct || 0) >= 0 ? 'Potensi swing kuat' : 'Bullish moderat',
        status_reason: reasonParts.join(' · '),
        final_status: swingTier,
        intraday_status: 'OPEN',
        trade_date: maxTradeDate,
        calculated_at: generatedAt,
        price_asof: maxTradeDate,
        price_date: maxTradeDate,
        price_source: 'sqlite_market_rows',
        is_konglo: kongloSet.has(row.ticker)
      });
    });

    horizonSnapshots[hKey] = Object.assign({}, snap, {
      horizon_key: hKey,
      horizon_label: hCfg.label,
      holding_label: hCfg.holdingLabel,
      holding_days_min: hCfg.minHoldingDays,
      holding_days_max: hCfg.maxHoldingDays,
      min_rr: hCfg.minRr || cfg.minRr,
      lookback_days: hCfg.lookbackDays,
      weights: hCfg.weights,
      universe_count: candlesByTicker.size,
      liquid_candidates_count: snap.universe_count || candidates.length,
      evaluated_count: candlesByTicker.size,
      top20: enrichedTop20,
      picks: enrichedTop20,
      top5: enrichedTop20.slice(0, Math.min(5, enrichedTop20.length))
    });
  }

  ledgerSync.annotateDailySignalMemory(horizonSnapshots, maxTradeDate, {
    rootDir: ROOT,
    dryRun: Boolean(options.dryRun)
  });

  const primaryHorizon = horizonSnapshots.short_swing;
  const kongloRows = [];
  for (const row of horizonSnapshots.short_swing.top20.concat(horizonSnapshots.swing.top20)) {
    if (kongloSet.has(row.ticker) && !kongloRows.some((x) => x.ticker === row.ticker)) {
      kongloRows.push(row);
    }
  }
  const nkRows = horizonSnapshots.swing.top20.filter((r) => !kongloSet.has(r.ticker));

  const sourceDatesMeta = {
    ohlcv: latestOhlcvDate,
    broksum_all: latestAllDate || maxTradeDate,
    broksum_foreign: latestForeignDate || maxTradeDate,
    insiders: latestInsidersDate || null,
    ksei_ownership: (kseiLoaded && kseiLoaded.meta && kseiLoaded.meta.as_of) || null,
    daytrade: maxTradeDate,
    eod: maxTradeDate
  };

  const threeHorizonDoc = {
    version: 2,
    release: 'Auto-Cuan IDX V6.5.5-K1',
    generated_at: generatedAt,
    trade_date: maxTradeDate,
    source_dates: sourceDatesMeta,
    config_version: cfg.version,
    horizons: horizonSnapshots,
    results: primaryHorizon.top20,
    top5: primaryHorizon.top5
  };

  const screenerLatestDoc = {
    trade_date: maxTradeDate,
    market_date: maxTradeDate,
    calculated_at: generatedAt,
    generated_by: 'tools/regenerate-local-snapshots.js',
    source_dates: sourceDatesMeta,
    swing: primaryHorizon.top20,
    swing_non_konglo: horizonSnapshots.swing.top20,
    nk: horizonSnapshots.swing.top20,
    daytrade: horizonSnapshots.potensi_besok.top20,
    top5: primaryHorizon.top5,
    three_horizon: threeHorizonDoc.horizons
  };

  const rawSectorGroups = sectorRadar.getSectorRadarGroups();
  const sectorGroups = sectorVolumeRatio.enrichGroupsWithVolumeRatios(rawSectorGroups);
  const sectorHotDoc = {
    generated_at: generatedAt,
    trade_date: maxTradeDate,
    groups: sectorGroups
  };

  const top5RadarDoc = primaryHorizon.top5.length > 0 ? {
    trade_date: maxTradeDate,
    market_date: maxTradeDate,
    source_dates: sourceDatesMeta,
    generated_at: generatedAt,
    data_status: 'AVAILABLE',
    publication_blocked: false,
    top5: primaryHorizon.top5,
    picks: primaryHorizon.top5,
    top5_by_horizon: {
      potensi_besok: horizonSnapshots.potensi_besok.top5,
      short_swing: horizonSnapshots.short_swing.top5,
      swing: horizonSnapshots.swing.top5
    }
  } : null;

  let ledgerSummary = null;
  if (!options.dryRun) {
    atomicWriteJson(path.join(ROOT, 'data', 'three-horizon-latest.json'), threeHorizonDoc);
    atomicWriteJson(path.join(ROOT, 'data', 'screener-latest.json'), screenerLatestDoc);
    atomicWriteJson(path.join(ROOT, 'data', 'sector-hot-latest.json'), sectorHotDoc);
    if (top5RadarDoc) {
      atomicWriteJson(path.join(ROOT, 'data', 'top5-radar.json'), top5RadarDoc);
    }
    if (!options.skipLedgerSync) {
      ledgerSummary = ledgerSync.syncLiveSignalLedger(horizonSnapshots, maxTradeDate, generatedAt, { rootDir: ROOT, dryRun: false });
    }

    // Sync ONLY derived snapshot tables in VpsMarketStore (never raw history/broksum/insiders)
    if (!options.skipSqliteSync) {
      const store = getVpsMarketStore(dbPath);
      store.transaction(() => {
        store.clearTable('swing_screener_latest');
        for (const r of (kongloRows.length ? kongloRows : primaryHorizon.top20)) {
          store.writeRow('swing_screener_latest', r, keyFieldsFor('swing_screener_latest'), true);
        }
        store.writeRow('swing_screener_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          calculated_at: generatedAt,
          universe_count: candlesByTicker.size,
          scanned_count: candlesByTicker.size,
          published_count: (kongloRows.length ? kongloRows : primaryHorizon.top20).length,
          status: 'ok',
          source: 'local_regeneration_v65'
        }, keyFieldsFor('swing_screener_meta'), true);

        store.clearTable('swing_screener_non_konglo_latest');
        for (const r of (nkRows.length ? nkRows : horizonSnapshots.swing.top20)) {
          store.writeRow('swing_screener_non_konglo_latest', r, keyFieldsFor('swing_screener_non_konglo_latest'), true);
        }
        store.writeRow('swing_screener_non_konglo_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          published_at: generatedAt,
          calculated_at: generatedAt,
          universe_count: candlesByTicker.size,
          status: 'ok'
        }, keyFieldsFor('swing_screener_non_konglo_meta'), true);

        store.clearTable('daytrade_screener_latest');
        for (const r of horizonSnapshots.potensi_besok.top20) {
          store.writeRow('daytrade_screener_latest', r, keyFieldsFor('daytrade_screener_latest'), true);
        }
        store.writeRow('daytrade_screener_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          calculated_at: generatedAt,
          universe_count: candlesByTicker.size,
          status: 'ok'
        }, keyFieldsFor('daytrade_screener_meta'), true);

        store.clearTable('sector_hot_latest');
        store.clearTable('sector_hot_members_latest');
        for (const g of sectorGroups) {
          store.writeRow('sector_hot_latest', {
            group_code: g.group_code,
            group_name: g.group_name,
            owner_label: g.owner_label,
            stock_count: g.stock_count,
            valid_count: (g.members || []).filter((m) => m.last_price != null).length,
            avg_change_pct: g.avg_change_pct,
            volume_ratio_30d: g.volume_ratio_30d,
            avg_volume_ratio: g.avg_volume_ratio,
            top_ticker: g.top_ticker,
            top_change_pct: g.top_change_pct,
            net_flow: g.net_flow,
            calculated_at: generatedAt,
            status: 'ok'
          }, keyFieldsFor('sector_hot_latest'), true);
          for (const m of (g.members || [])) {
            store.writeRow('sector_hot_members_latest', {
              group_code: g.group_code,
              ticker: m.ticker,
              stock_name: m.stock_name,
              last_price: m.last_price,
              change_pct: m.change_pct,
              volume_today: m.volume_today,
              volume_ratio_30d: m.volume_ratio_30d,
              net_foreign: m.net_foreign,
              member_type: m.member_type || 'MEMBER',
              calculated_at: generatedAt
            }, keyFieldsFor('sector_hot_members_latest'), true);
          }
        }
        store.writeRow('sector_hot_meta', {
          id: 'latest',
          trade_date: maxTradeDate,
          calculated_at: generatedAt,
          scanned_count: sectorGroups.reduce((s, g) => s + (g.stock_count || 0), 0),
          failed_count: 0,
          status: 'ok'
        }, keyFieldsFor('sector_hot_meta'), true);
      });
    }
  }

  return {
    ok: true,
    trade_date: maxTradeDate,
    tickers_evaluated: candlesByTicker.size,
    horizons: {
      potensi_besok: horizonSnapshots.potensi_besok.top20.length,
      short_swing: horizonSnapshots.short_swing.top20.length,
      swing: horizonSnapshots.swing.top20.length
    },
    sector_groups: sectorGroups.length,
    ledger_sync: ledgerSummary,
    _threeHorizonDoc: threeHorizonDoc
  };
}

function loadEnvSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!Object.prototype.hasOwnProperty.call(process.env, k)) process.env[k] = v;
    }
  } catch (_) {}
}

async function syncTelegramDailyPicksIfConfigured(threeHorizonDoc, options = {}) {
  try {
    loadEnvSafe(path.join(ROOT, '.env'));
    loadEnvSafe(path.join(ROOT, '.env.local'));
    loadEnvSafe('/home/ubuntu/auto-cuan-runner/.env');
    if (process.env.AUTO_CUAN_MARKET_DATA_VPS == null && fs.existsSync('/home/ubuntu/auto-cuan-data/market.sqlite')) {
      process.env.AUTO_CUAN_MARKET_DATA_VPS = '1';
    }
    const { createClient } = require('../lib/hybrid-supabase-client');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return await ledgerSync.syncTelegramDailyPicksDb(
      threeHorizonDoc.horizons,
      threeHorizonDoc.trade_date,
      threeHorizonDoc.generated_at,
      { supabase, dryRun: Boolean(options.dryRun) }
    );
  } catch (err) {
    return { ok: false, skipped: true, reason: err && err.message || String(err) };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipSqliteSync = args.includes('--files-only');
  (async () => {
    try {
      const out = run({ dryRun, skipSqliteSync });
      const threeDoc = out._threeHorizonDoc;
      delete out._threeHorizonDoc;
      if (!dryRun && !args.includes('--skip-db-sync') && threeDoc) {
        out.db_picks_sync = await syncTelegramDailyPicksIfConfigured(threeDoc, { dryRun });
      }
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('[regenerate-local-snapshots] FAIL:', err && err.message || err);
      process.exit(1);
    }
  })();
}

module.exports = { run, buildHorizonCandidate, syncTelegramDailyPicksIfConfigured };

'use strict';
/**
 * B3 Adaptive Bridge — Satu modul bersama untuk 3 Screener & Chart Workstation.
 * Semua jalur (DayTrade, Swing Konglo, Swing Non-Konglo, Chart) WAJIB memanggil
 * builder sama di lib/chart-level-builder.js sehingga angka Entry/SL/TP1/TP2
 * untuk ticker yang sama 100% identik di tabel Screener maupun Chart Workstation.
 *
 * - Klasifikasi likuiditas: median nilai transaksi 20H, frekuensi, spread tick.
 *   Ambang Rp5M baseline dari config/liquidity.json (uji sensitivitas 3M/5M/10M).
 * - Jalur A (Likuid): Close>MA20, LPM>0 menanjak, Foreign 3H/5H positif ATAU
 *   BS_Ratio_3>=1.20 + konsistensi net buy min 3/5 hari. Entry pullback EMA5 /
 *   Bandar VWAP 5H (Close-0.3*ATR14 s.d. Close). TP1=Entry+(1.0-1.5)*ATR14,
 *   TP2=Entry+(2.0-2.8)*ATR14, SL close di bawah swing low 5H / modal bandar.
 *   R/R dijaga PF>1.0 (TP2/SL: A=2.8/1.5=1.86, B=2.8/2.0=1.40).
 * - Jalur B (Non-Likuid/Lapis 2-3): BS_Ratio domestik>=1.35, 0.97<=Close/Modal<=1.06,
 *   RVOL>=1.4, LPM>0. Entry sekitar modal bandar. SL anti-shakeout berbasis close
 *   harian di bawah support/modal (jarum 1-2 tick tak picu stop palsu).
 */
const fs = require('fs');
const path = require('path');

const builder = require('./chart-level-builder');
const profiler = require('./liquidity-profiler');

const ROOT = path.resolve(__dirname, '..');
const CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');
const ACCUM_DIR = path.join(ROOT, 'data', 'broker-accumulation');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function toCandles(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw.candles) ? raw.candles : (Array.isArray(raw) ? raw : []);
  return arr
    .map((c) => ({
      date: c.date || c.time || null,
      time: c.date || c.time || null,
      open: Number(c.open),
      high: Number(c.high != null ? c.high : c.close),
      low: Number(c.low != null ? c.low : c.close),
      close: Number(c.close),
      volume: Number(c.volume || 0),
      value: c.value != null ? Number(c.value) : null,
      frequency: c.frequency != null ? Number(c.frequency) : (c.freq != null ? Number(c.freq) : null)
    }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0);
}

function loadCandles(ticker) {
  const t = String(ticker || '').toUpperCase();
  const j = readJsonSafe(path.join(CANDLES_DIR, t + '.json'));
  return toCandles(j);
}

function loadBrokerData(ticker) {
  const t = String(ticker || '').toUpperCase();
  const j = readJsonSafe(path.join(ACCUM_DIR, t + '.json'));
  if (!j || !j.latest || !j.latest.windows) return {};
  const L = j.latest;
  const w3 = (L.windows['3H'] && L.windows['3H'].all) || {};
  const w5 = (L.windows['5H'] && L.windows['5H'].all) || {};
  const f3 = (L.windows['3H'] && L.windows['3H'].foreign) || {};
  const f5 = (L.windows['5H'] && L.windows['5H'].foreign) || {};
  const d3 = (L.windows['3H'] && L.windows['3H'].domestic) || {};
  const consAll = (L.consistency && L.consistency.all) || {};
  const consFor = (L.consistency && L.consistency.foreign) || {};
  return {
    bs_ratio_3: w3.bs_ratio_3 != null ? Number(w3.bs_ratio_3) : 1.0,
    domestic_bs_ratio_3: d3.bs_ratio_3 != null ? Number(d3.bs_ratio_3) : (w3.bs_ratio_3 != null ? Number(w3.bs_ratio_3) : 1.0),
    foreign_net_val_3: f3.net_val != null ? Number(f3.net_val) : 0,
    foreign_net_val_5: f5.net_val != null ? Number(f5.net_val) : 0,
    foreign_consistency_days: consFor.net_buy_days_10h != null ? Math.round(Number(consFor.net_buy_days_10h) / 2) : (consAll.net_buy_days_10h != null ? Math.round(Number(consAll.net_buy_days_10h) / 2) : 0),
    bandar_avg_buy_price: L.bandar_vwap != null && Number(L.bandar_vwap) > 0 ? Number(L.bandar_vwap) : (w3.avg_buy_price != null ? Number(w3.avg_buy_price) : null),
    bandar_vwap_5h: w5.avg_buy_price != null && Number(w5.avg_buy_price) > 0 ? Number(w5.avg_buy_price) : (L.bandar_vwap != null ? Number(L.bandar_vwap) : null)
  };
}

function buildLevels(ticker, opts) {
  opts = opts || {};
  const t = String(ticker || '').toUpperCase();
  const candles = opts.candles || loadCandles(t);
  const brokerData = opts.brokerData || loadBrokerData(t);
  const threshold = opts.threshold != null ? opts.threshold : profiler.LIQUIDITY_CONFIG.DEFAULT_THRESHOLD;
  const boardInfo = opts.boardInfo || { board: 'UTAMA', is_fca: false };
  // SATU builder sama untuk semua jalur — tidak ada rumus duplikat di screener/chart.
  const out = builder.buildFullChartAnalysis(candles, t, boardInfo, brokerData, { threshold });
  return { out, candles, brokerData, threshold, boardInfo };
}

function extractCanonical(out) {
  if (!out || out.status !== 'OK') return null;
  const liq = out.liquidity || null;
  const ad = out.adaptive || null;
  const tp = ad && ad.trade_plan ? ad.trade_plan : null;
  // FCA/Suspensi/Rp1: builder jujur (entryDisabled, badge FCA) + liquidity tetap ada.
  // Tetap terklasifikasi (tanpa error) dengan level null di kedua jalur (selisih 0).
  if (!tp) {
    if (liq) {
      return {
        entry_low: null,
        entry_high: null,
        entry_ref: null,
        sl: null,
        tp1: null,
        tp2: null,
        liquidity_tier: liq.tier || null,
        liquidity_label: liq.label || null,
        liquidity_median_20d: liq.medianValue20d != null ? liq.medianValue20d : null,
        liquidity_tooltip: liq.tooltip || liq.reason || null,
        adaptive_path: ad ? ad.path : null,
        adaptive_gate_passed: false,
        adaptive_badge: out.badge || 'TIDAK_LOLOS',
        entry_disabled: true,
        entry_disabled_reason: out.entryDisabledReason || out.badge || null,
        chart_status: out.chartStatus || null
      };
    }
    // NO_CANDLES / NO_VALID_CANDLES (mis. CNTX): tetap klasifikasi jujur REJECT.
    return {
      entry_low: null,
      entry_high: null,
      entry_ref: null,
      sl: null,
      tp1: null,
      tp2: null,
      liquidity_tier: 'ILLIQUID',
      liquidity_label: 'Tidak Lolos Lantai Likuiditas',
      liquidity_median_20d: 0,
      liquidity_tooltip: (out && (out.entryDisabledReason || out.badge)) || 'Data candle kosong dari sumber',
      adaptive_path: null,
      adaptive_gate_passed: false,
      adaptive_badge: 'TIDAK_LOLOS',
      entry_disabled: true,
      entry_disabled_reason: (out && out.entryDisabledReason) || null,
      chart_status: (out && out.chartStatus) || 'NO_CANDLES'
    };
  }
  return {
    entry_low: tp.entry_low,
    entry_high: tp.entry_high,
    entry_ref: tp.entry_ref,
    sl: tp.sl,
    tp1: tp.tp1,
    tp2: tp.tp2,
    liquidity_tier: liq ? liq.tier : null,
    liquidity_label: liq ? liq.label : null,
    liquidity_median_20d: liq ? liq.medianValue20d : null,
    liquidity_tooltip: liq ? liq.tooltip : null,
    adaptive_path: ad ? ad.path : null,
    adaptive_gate_passed: ad ? ad.gate_passed : false,
    adaptive_badge: ad ? ad.badge : null,
    entry_disabled: false,
    chart_status: out.chartStatus || 'OK'
  };
}

// Jalur Screener (DayTrade / Swing Konglo / Swing Non-Konglo) — semua via builder sama.
function getScreenerLevels(ticker, screenerType, opts) {
  const r = buildLevels(ticker, opts);
  const canon = extractCanonical(r.out);
  if (!canon) return null;
  return Object.assign({}, canon, {
    ticker: String(ticker || '').toUpperCase(),
    screener_type: screenerType || 'DAY_TRADE',
    source: 'lib/chart-level-builder.js:buildFullChartAnalysis via lib/b3-adaptive-bridge.js:getScreenerLevels'
  });
}

// Jalur Chart Workstation / /api/analyze Chart — via builder SAMA persis.
function getChartLevels(ticker, opts) {
  const r = buildLevels(ticker, opts);
  const canon = extractCanonical(r.out);
  if (!canon) return null;
  return Object.assign({}, canon, {
    ticker: String(ticker || '').toUpperCase(),
    source: 'lib/chart-level-builder.js:buildFullChartAnalysis via lib/b3-adaptive-bridge.js:getChartLevels'
  });
}

function badgeFor(liquidity) {
  if (!liquidity) return { text: '—', cls: 'b3-liq--unknown', title: 'Profil likuiditas belum tersedia' };
  if (liquidity.tier === 'LIKUID' || liquidity.isLiquid) {
    return { text: 'Likuid', cls: 'b3-liq--likuid', title: liquidity.tooltip || '' };
  }
  if (liquidity.tier === 'NON_LIKUID' || liquidity.isNonLiquid) {
    return { text: 'Non-Likuid / Lapis 2-3', cls: 'b3-liq--nonlikuid', title: liquidity.tooltip || '' };
  }
  return { text: 'Tidak Lolos Lantai', cls: 'b3-liq--reject', title: (liquidity.tooltip || liquidity.reason || '') };
}

module.exports = {
  loadCandles,
  loadBrokerData,
  buildLevels,
  extractCanonical,
  getScreenerLevels,
  getChartLevels,
  badgeFor,
  LIQUIDITY_CONFIG: profiler.LIQUIDITY_CONFIG,
  BUILDER_PATH: 'lib/chart-level-builder.js'
};

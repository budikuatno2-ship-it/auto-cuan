'use strict';

/**
 * Chart Level & Trade Plan Builder
 * =================================
 * Shared production module for chart levels, technical indicators, 5 modes,
 * 10-day fair range cone, and Adaptive Liquidity Dual-Track (Fase 6).
 *
 * Used by:
 *   - /api/quote
 *   - /api/analyze
 *   - public/chart-workstation.js
 *   - public/analisis-v2.js
 *   - scripts & audit tools
 */

const idxTick = require('./idx-tick-normalization');
const engine = require('./daytrade-screener-engine');
const adapters = require('./trade-plan-v2-source-adapters');
const tpv2 = require('./trade-plan-v2');
const profiler = require('./liquidity-profiler');

const FIVE_MODES = Object.freeze(['DayTrade', 'Swing', 'Scalping', 'Breakout', 'Reversal']);

// B1: workstation presets (Simple/Pro + horizon Scalping/Swing/Investor).
// Investor tetap jujur: "Belum ada rencana Investor dari server".
const WORKSTATION_FIVE_MODES = Object.freeze(['Simple', 'Pro', 'Scalping', 'Swing', 'Investor']);
const INVESTOR_HONEST_STATE = 'Belum ada rencana Investor dari server';

const MODE_CONFIGS = Object.freeze({
  DayTrade: { lookback: 10, slBuf: 0.975, tpMult: 1.5, tp2Mult: 2.5 },
  Swing: { lookback: 20, slBuf: 0.965, tpMult: 1.6, tp2Mult: 2.8 },
  Scalping: { lookback: 8, slTicks: 3, tpMult: 1.5, tp2Mult: 2.5 },
  Breakout: { lookback: 20, slBuf: 0.97, tpMult: 1.65, tp2Mult: 2.8, isBreakout: true },
  Reversal: { lookback: 15, slBuf: 0.965, tpMult: 1.55, tp2Mult: 2.6, isReversal: true }
});

// B1: tickers Rp1/FCA/Suspensi yang wajib badge jujur, tidak pernah chart kosong/error.
const FCA_SUSPENDED_TICKERS = Object.freeze(['MKNT', 'SBAT', 'TOPS', 'CNTX']);
const FCA_SUSPENDED_BADGE = 'Saham FCA Rp 1 / Suspensi \u2014 Rencana Entry Dinonaktifkan';
const WIDE_RISK_BADGE = 'Risiko lebar / Di luar kriteria screener';
const IHSG_DISCLAIMER = 'Ini gambaran arah pasar, bukan sinyal beli atau jual.';

function isIndexTicker(t) {
  return /^(IHSG|COMPOSITE|JKSE|JCI|LQ45|IDX30|IDX80|KOMPAS100)$/i.test(String(t || ''));
}

function isFcaSuspendedTicker(ticker, valid, lastPrice) {
  const t = String(ticker || '').toUpperCase();
  if (FCA_SUSPENDED_TICKERS.includes(t)) return true;
  if (Number.isFinite(lastPrice) && lastPrice <= 1) return true;
  if (Array.isArray(valid) && valid.length > 0) {
    const closes = valid.map((c) => Number(c.close)).filter((v) => Number.isFinite(v));
    if (closes.length > 0 && Math.max(...closes) <= 1) return true;
  }
  return false;
}

function swingMinMax(valid, lookback) {
  const n = Math.min(Math.max(1, lookback), valid.length);
  const slice = valid.slice(-n);
  let mn = Infinity, mx = -Infinity;
  for (const c of slice) {
    const h = Number(c.high != null ? c.high : c.close);
    const l = Number(c.low != null ? c.low : c.close);
    if (Number.isFinite(h) && h > mx) mx = h;
    if (Number.isFinite(l) && l < mn) mn = l;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
  return { mn, mx };
}

function validSRSet(s2, s1, r1, r2, board, isFca, ticker) {
  const vals = [s2, s1, r1, r2];
  if (!vals.every((v) => Number.isFinite(v) && v > 0)) return false;
  if (!(s2 < s1 && s1 < r1 && r1 < r2)) return false;
  return vals.every((v) => idxTick.isValidIdxPriceLevel(v, board, isFca, ticker));
}

// Fallback berjenjang B1: Pivot -> Swing High/Low 60 bar -> Swing 20 bar -> kelipatan ATR14.
// Selalu kembalikan Support2<Support1<Resistance1<Resistance2 yang finite, >0, patuh tick.
function buildTieredSR(valid, board, isFca, ticker, atr14, lastPrice, tickSize) {
  const tick = tickSize || 1;
  const atr = Number.isFinite(atr14) && atr14 > 0 ? atr14 : tick;
  const close = Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : 1;
  const rUp = (v) => idxTick.roundToIdxTick(v, 'up', board, isFca, ticker);
  const rDn = (v) => idxTick.roundToIdxTick(v, 'down', board, isFca, ticker);

  // Tingkat 1: Pivot classic dari bar terakhir.
  try {
    const last = valid[valid.length - 1];
    const H = Number(last.high != null ? last.high : last.close);
    const L = Number(last.low != null ? last.low : last.close);
    const C = Number(last.close);
    if ([H, L, C].every((v) => Number.isFinite(v) && v > 0) && H >= L) {
      const pivot = (H + L + C) / 3;
      const s1 = rDn(2 * pivot - H);
      const r1 = rUp(2 * pivot - L);
      const s2 = rDn(pivot - (H - L));
      const r2 = rUp(pivot + (H - L));
      if (validSRSet(s2, s1, r1, r2, board, isFca, ticker)) {
        return { support1: s1, support2: s2, resistance1: r1, resistance2: r2, pivot: rUp(pivot), source: 'Pivot' };
      }
    }
  } catch (_) {}

  // Tingkat 2 & 3: Swing High/Low 60 bar lalu 20 bar, S2/R2 = S1/R1 +- ATR14.
  for (const lb of [60, 20]) {
    try {
      const mm = swingMinMax(valid, lb);
      if (!mm) continue;
      const s1 = rDn(mm.mn);
      const r1 = rUp(mm.mx);
      if (!Number.isFinite(s1) || !Number.isFinite(r1) || s1 <= 0 || r1 <= 0 || r1 <= s1) continue;
      let s2 = rDn(s1 - atr);
      let r2 = rUp(r1 + atr);
      if (!Number.isFinite(s2) || s2 <= 0) s2 = Math.max(1, s1 - tick);
      if (!Number.isFinite(r2) || r2 <= 0) r2 = r1 + tick;
      if (validSRSet(s2, s1, r1, r2, board, isFca, ticker)) {
        return { support1: s1, support2: s2, resistance1: r1, resistance2: r2, pivot: null, source: 'Swing' + lb };
      }
    } catch (_) {}
  }

  // Tingkat 4: kelipatan ATR14 dari Close.
  try {
    const s1 = rDn(close - atr);
    const r1 = rUp(close + atr);
    let s2 = rDn(close - 2 * atr);
    let r2 = rUp(close + 2 * atr);
    if (!Number.isFinite(s1) || s1 <= 0 || !Number.isFinite(r1) || r1 <= 0 || r1 <= s1) throw new Error('atr_invalid');
    if (!Number.isFinite(s2) || s2 <= 0) s2 = Math.max(1, s1 - tick);
    if (!Number.isFinite(r2) || r2 <= 0) r2 = r1 + tick;
    if (validSRSet(s2, s1, r1, r2, board, isFca, ticker)) {
      return { support1: s1, support2: s2, resistance1: r1, resistance2: r2, pivot: null, source: 'ATR14' };
    }
  } catch (_) {}

  // Penjaga terakhir: tidak pernah kembalikan garis 0 / invalid.
  // Untuk harga Rp2 (tick=1): S2=1, S1=1 tidak valid (S2<S1 gagal) — paksa S1=close,
  // S2=close-1, R1=close+1, R2=close+2 agar ordering selalu lolos.
  // Catatan: roundToIdxTick bisa kembalikan null untuk harga <1 tick (BUG-FASE1-003),
  // jadi semua hasil null dipaksa ke angka mentah sebelum validasi ordering.
  // B1: S2 boleh =1 (Rp1 floor bursa) selama S2<S1 — jangan paksa S2>=tick bila close kecil.
  const numOr = (v, fb) => (Number.isFinite(v) && v > 0 ? v : fb);
  let gs1 = numOr(rDn(close - tick), close - tick);
  if (!Number.isFinite(gs1) || gs1 <= 0) gs1 = Math.max(1, close - tick);
  if (gs1 >= close) gs1 = Math.max(1, close - tick);
  if (gs1 >= close) gs1 = Math.max(1, close - 1);
  if (gs1 >= close) gs1 = close;
  let gs2 = numOr(rDn(gs1 - tick), gs1 - tick);
  if (!Number.isFinite(gs2) || gs2 <= 0 || gs2 >= gs1) gs2 = Math.max(1, gs1 - tick);
  if (gs2 >= gs1) gs2 = Math.max(1, gs1 - 1);
  if (gs2 >= gs1 && gs1 > 1) gs2 = gs1 - 1;
  let gr1 = numOr(rUp(close + tick), close + tick);
  if (!Number.isFinite(gr1) || gr1 <= 0 || gr1 <= close) gr1 = close + tick;
  let gr2 = numOr(rUp(gr1 + tick), gr1 + tick);
  if (!Number.isFinite(gr2) || gr2 <= 0 || gr2 <= gr1) gr2 = gr1 + tick;
  if (validSRSet(gs2, gs1, gr1, gr2, board, isFca, ticker)) {
    return { support1: gs1, support2: gs2, resistance1: gr1, resistance2: gr2, pivot: null, source: 'GUARD' };
  }
  // Absolut terakhir: S2=1 (Rp1 floor) diizinkan selama S2<S1<R1<R2.
  // Untuk close=2: S1=1? tidak — S1 harus <close tapi >S2=1 tidak mungkin bila close=2
  // dan tick=1 (hanya ada 1 level di bawah close). Maka S1=close-0? tidak valid.
  // Solusi B1: S1 = close (support = harga terakhir, jujur flat), S2 = 1 (floor historis).
  // Ordering S2<S1? 1<2 lolos. S1<R1? 2<3 lolos. Chart tampil S/R historis + badge.
  const hs1 = close;
  const hs2 = Math.max(1, close - tick);
  const hr1 = close + tick;
  const hr2 = hr1 + tick;
  if (hs2 < hs1 && hs1 < hr1 && hr1 < hr2) {
    return { support1: hs1, support2: hs2, resistance1: hr1, resistance2: hr2, pivot: null, source: 'GUARD_FLAT' };
  }
  return { support1: Math.max(1, close - 1), support2: 1, resistance1: close + 1, resistance2: close + 2, pivot: null, source: 'GUARD_FLAT' };
}

function computeMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period || period <= 0) return null;
  const slice = closes.slice(-period);
  let sum = 0;
  for (const v of slice) {
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return Math.round((sum / period) * 100) / 100;
}

// Panel Potensi arah IHSG: 0 Entry/SL/TP/kalkulator/layer bandar.
// Harian/Mingguan/Bulanan, bias MA, skenario R1/R2/S1/S2, rentang + disclaimer.
function buildIHSGPanel(valid) {
  const closes = valid.map((c) => Number(c.close)).filter((v) => Number.isFinite(v) && v > 0);
  const last = closes[closes.length - 1];
  const ma = (p) => computeMA(closes, p);
  const ma20 = ma(20), ma50 = ma(50), ma200 = ma(200);
  const mm60 = swingMinMax(valid, 60) || { mn: last, mx: last };
  const mm20 = swingMinMax(valid, 20) || mm60;
  const r2 = (v) => Math.round(v * 100) / 100;
  const bias = (m) => (m == null ? 'Mendatar (data kurang)' : (last > m ? 'Di atas rata-rata' : (last < m ? 'Di bawah rata-rata' : 'Mendatar')));
  const cone = calculate10DayCone(valid);
  return {
    isIndex: true,
    entry: null, sl: null, tp1: null, tp2: null,
    horizons: {
      Harian: { label: 'Harian', biasMA: 'MA20: ' + bias(ma20), ma: ma20 },
      Mingguan: { label: 'Mingguan', biasMA: 'MA50: ' + bias(ma50), ma: ma50 },
      Bulanan: { label: 'Bulanan', biasMA: 'MA200: ' + bias(ma200), ma: ma200 }
    },
    scenarios: {
      R1: r2(mm20.mx), R2: r2(mm60.mx), S1: r2(mm20.mn), S2: r2(mm60.mn)
    },
    range: cone ? { p10: cone.p10, p90: cone.p90, sigma60: cone.sigma60 } : null,
    disclaimer: IHSG_DISCLAIMER
  };
}

/**
 * Kerucut Rentang Wajar 10H (produksi):
 * Batas Atas/Bawah(h) = Close * e^{+-1.2816 * sigma60 * sqrt(h)}, h=1..10,
 * sigma60 = std log-return 60 hari terakhir.
 * Hanya horizon Scalping & Swing saham (bukan Investor, bukan IHSG).
 */
function calculateSigma60(closes) {
  const w = (closes || []).filter((v) => Number.isFinite(v) && v > 0).slice(-61);
  if (w.length < 2) return null;
  const r = [];
  for (let i = 1; i < w.length; i++) {
    if (w[i - 1] > 0 && w[i] > 0) r.push(Math.log(w[i] / w[i - 1]));
  }
  if (r.length < 2) return 0;
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / (r.length - 1));
  if (!Number.isFinite(sd) || sd < 0) return 0;
  return sd;
}

function calculate10DayCone(candles) {
  const closes = (candles || []).map((c) => Number(c && c.close)).filter((v) => Number.isFinite(v) && v > 0);
  if (closes.length < 2) return null;
  let sd = calculateSigma60(closes);
  if (!Number.isFinite(sd) || sd <= 0) {
    sd = 0.01; // minimal 1% volatility fallback for flat/dormant stocks
  }
  const c0 = closes[closes.length - 1];
  const band10 = 1.2816 * sd * Math.sqrt(10);
  const out = {
    p10: Math.round(c0 * Math.exp(-band10) * 100) / 100,
    p90: Math.round(c0 * Math.exp(band10) * 100) / 100,
    sigma60: Math.round(sd * 1000000) / 1000000,
    close: c0,
    horizon: 'Scalping/Swing saham saja (bukan Investor, bukan IHSG)'
  };
  // Per-h cone h=1..10 (spec B1).
  out.cone10H = [];
  for (let h = 1; h <= 10; h++) {
    const band = 1.2816 * sd * Math.sqrt(h);
    out.cone10H.push({
      h,
      lower: Math.round(c0 * Math.exp(-band) * 100) / 100,
      upper: Math.round(c0 * Math.exp(band) * 100) / 100
    });
  }
  return out;
}

/**
 * Compute primary indicators for a ticker's candles
 */
function calculateChartIndicators(candles, ticker, boardInfo) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const valid = candles.filter((c) => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  if (valid.length === 0) return null;

  const board = (boardInfo && boardInfo.board) || 'UTAMA';
  const isFca = !!(boardInfo && boardInfo.is_fca);
  const len = valid.length;
  const last = valid[len - 1];
  const lastPrice = Number(last.close);
  const tickSize = idxTick.getIdxTickSize(lastPrice, board, isFca, ticker) || 1;

  const closes = valid.map((c) => Number(c.close));
  const highs = valid.map((c) => Number(c.high != null ? c.high : c.close));
  const lows = valid.map((c) => Number(c.low != null ? c.low : c.close));
  const vols = valid.map((c) => Number(c.volume || 0));

  // Moving averages
  const p20 = Math.min(len, 20);
  const ma20 = Math.round(closes.slice(-p20).reduce((a, b) => a + b, 0) / p20);
  const p50 = Math.min(len, 50);
  const ma50 = Math.round(closes.slice(-p50).reduce((a, b) => a + b, 0) / p50);

  // ATR 14
  let trSum = 0, trCount = 0;
  const startAtr = Math.max(1, len - 14);
  for (let i = startAtr; i < len; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    if (Number.isFinite(tr)) { trSum += tr; trCount++; }
  }
  let atr14 = trCount > 0 && (trSum / trCount) > 0 ? (trSum / trCount) : tickSize;
  atr14 = Math.round(atr14 * 100) / 100;

  // RSI 14
  let gains = 0, losses = 0;
  const rsiLookback = Math.min(14, len - 1);
  let rsi14 = 50.0;
  if (rsiLookback > 0) {
    for (let i = len - rsiLookback; i < len; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgG = gains / rsiLookback;
    const avgL = losses / rsiLookback;
    rsi14 = avgL === 0 ? 100 : Math.round((100 - (100 / (1 + (avgG / avgL)))) * 10) / 10;
  }

  // Support & Resistance berjenjang B1:
  // Pivot (classic, bar terakhir) -> Swing High/Low 60 bar -> Swing 20 bar -> kelipatan ATR14.
  // Selalu jamin Support2<Support1<Resistance1<Resistance2, finite & >0, patuh tick.
  const sr = buildTieredSR(valid, board, isFca, ticker, atr14, lastPrice, tickSize);
  const support = sr.support1;
  const resistance = sr.resistance1;

  const volAvg20 = Math.round(vols.slice(-p20).reduce((a, b) => a + b, 0) / p20);
  const volToday = Number(last.volume || 0);
  const volumeRatio20 = volAvg20 > 0 ? Math.round((volToday / volAvg20) * 100) / 100 : 1.0;

  return {
    lastPrice,
    ma20,
    ma50,
    atr14,
    rsi14,
    support,
    resistance,
    support1: sr.support1,
    support2: sr.support2,
    resistance1: sr.resistance1,
    resistance2: sr.resistance2,
    pivot: sr.pivot,
    srSource: sr.source,
    volumeAvg20: volAvg20,
    volumeToday: volToday,
    volumeRatio20
  };
}

/**
 * Generate 5 Modes (DayTrade, Swing, Scalping, Breakout, Reversal).
 * B1: SL/TP diklem ke kewajaran vs Close (no SL<50% Close, TP>300% Close)
 * agar garis tidak gepengkan candle; saham berisiko lebar tetap tampil + badge.
 */
function calculateFiveModes(candles, ticker, boardInfo) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const valid = candles.filter((c) => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  if (valid.length === 0) return null;

  const board = (boardInfo && boardInfo.board) || 'UTAMA';
  const isFca = !!(boardInfo && boardInfo.is_fca);
  const len = valid.length;
  const last = valid[len - 1];
  const close = Number(last.close);
  const tickSize = idxTick.getIdxTickSize(close, board, isFca, ticker) || 1;

  const highs = valid.map((c) => Number(c.high != null ? c.high : c.close));
  const lows = valid.map((c) => Number(c.low != null ? c.low : c.close));

  const modes = {};
  for (const [mName, cfg] of Object.entries(MODE_CONFIGS)) {
    const lookback = Math.min(cfg.lookback, len);
    const mLow = Math.min(...lows.slice(-lookback));
    const mHigh = Math.max(...highs.slice(-lookback));
    let mSup = Number.isFinite(mLow) && mLow > 0 ? mLow : close;
    let mRes = Number.isFinite(mHigh) && mHigh > 0 ? mHigh : close;
    if (mRes <= mSup) mRes = mSup + tickSize;

    mSup = idxTick.roundToIdxTick(mSup, 'down', board, isFca, ticker);
    mRes = idxTick.roundToIdxTick(mRes, 'up', board, isFca, ticker);
    if (mRes <= mSup) mRes = idxTick.roundToIdxTick(mSup + tickSize, 'up', board, isFca, ticker);

    let entry = idxTick.roundToIdxTick(close, 'nearest', board, isFca, ticker);
    if (cfg.isBreakout) {
      entry = idxTick.roundToIdxTick(Math.max(close, mRes), 'nearest', board, isFca, ticker);
    }

    // B1: SL dijangkar ke support terdekat yang wajar (maksimal 12% di bawah entry),
    // bukan ke swing-low historis yang jauh (bisa 70% di bawah = garis gepengkan candle).
    // Saham berisiko lebar tetap tampil + badge, bukan REJECT.
    const maxRisk = Math.max(tickSize, Math.round(entry * 0.12));
    let sl;
    if (cfg.slTicks) {
      sl = idxTick.roundToIdxTick(entry - (cfg.slTicks * tickSize), 'down', board, isFca, ticker);
    } else {
      const structSl = idxTick.roundToIdxTick(mSup * cfg.slBuf, 'down', board, isFca, ticker);
      const capSl = idxTick.roundToIdxTick(entry - maxRisk, 'down', board, isFca, ticker);
      // Pilih yang TIGHTER (lebih dekat entry): struktur boleh longgar, tapi risiko diklem 12%.
      sl = (Number.isFinite(structSl) && Number.isFinite(capSl)) ? Math.max(structSl, capSl) : (Number.isFinite(structSl) ? structSl : capSl);
    }
    if (!Number.isFinite(sl) || sl <= 0) sl = Math.max(1, entry - tickSize);
    if (sl >= entry) sl = idxTick.roundToIdxTick(entry - tickSize, 'down', board, isFca, ticker);
    if (!Number.isFinite(sl) || sl <= 0) sl = Math.max(1, entry - tickSize);
    // B1 kewajaran absolut: SL tidak boleh <50% Close (garis gepengkan candle).
    const slFloor = idxTick.roundToIdxTick(close * 0.5, 'down', board, isFca, ticker) || Math.max(1, Math.floor(close * 0.5));
    if (Number.isFinite(slFloor) && slFloor > 0 && sl < slFloor) {
      sl = slFloor;
      if (sl >= entry) sl = idxTick.roundToIdxTick(entry - tickSize, 'down', board, isFca, ticker) || (entry - tickSize);
    }

    const risk = entry - sl;
    let tp1 = idxTick.roundToIdxTick(entry + Math.round(risk * cfg.tpMult), 'up', board, isFca, ticker);
    let tp2 = idxTick.roundToIdxTick(entry + Math.round(risk * cfg.tp2Mult), 'up', board, isFca, ticker);
    if (tp1 <= entry) tp1 = idxTick.roundToIdxTick(entry + tickSize, 'up', board, isFca, ticker);
    if (tp2 <= tp1) tp2 = idxTick.roundToIdxTick(tp1 + tickSize, 'up', board, isFca, ticker);
    // B1 kewajaran absolut: TP tidak boleh >300% Close.
    const tpCap = idxTick.roundToIdxTick(close * 3.0, 'up', board, isFca, ticker) || Math.ceil(close * 3.0);
    if (Number.isFinite(tpCap) && tpCap > 0) {
      if (tp1 > tpCap) tp1 = tpCap;
      if (tp2 > tpCap) tp2 = tpCap;
      if (tp1 <= entry) tp1 = idxTick.roundToIdxTick(entry + tickSize, 'up', board, isFca, ticker) || (entry + tickSize);
      if (tp2 <= tp1) tp2 = idxTick.roundToIdxTick(tp1 + tickSize, 'up', board, isFca, ticker) || (tp1 + tickSize);
    }

    const rr = risk > 0 ? Math.round(((tp1 - entry) / risk) * 100) / 100 : 0;
    const isSafeRR = rr >= 1.5;

    modes[mName] = {
      entry,
      sl,
      tp1,
      tp2,
      support: mSup,
      resistance: mRes,
      risk,
      reward: tp1 - entry,
      rr,
      isSafeRR
    };
  }

  return modes;
}

/**
 * Build full chart analysis package for one ticker (B1: 0 FAIL / 964).
 * - IHSG: 0 Entry/SL/TP/kalkulator/layer bandar; panel Potensi arah + disclaimer.
 * - Rp1/FCA/Suspensi: S/R historis + papan fraksi + badge jujur, Entry dinonaktifkan.
 * - Saham ditolak screener: TETAP tampil S/R fallback berjenjang + badge risiko lebar.
 */
function buildFullChartAnalysis(candles, ticker, boardInfo, brokerData, options) {
  const t = String(ticker || '').toUpperCase();
  const board = (boardInfo && boardInfo.board) || 'UTAMA';
  const isFca = !!(boardInfo && boardInfo.is_fca);

  if (!Array.isArray(candles) || candles.length === 0) {
    // B1: tidak pernah chart kosong/error — kembalikan S/R penjaga + badge jujur.
    const tick = idxTick.getIdxTickSize(1, board, isFca, t) || 1;
    return {
      ticker: t,
      status: 'OK',
      chartStatus: 'NO_CANDLES',
      badge: isFcaSuspendedTicker(t, [], null) ? FCA_SUSPENDED_BADGE : WIDE_RISK_BADGE,
      entryDisabled: true,
      entryDisabledReason: 'Data candle kosong dari sumber; level S/R penjaga ditampilkan, rencana Entry dinonaktifkan.',
      candles_count: 0,
      lastPrice: null,
      indicators: null,
      support1: null, support2: null, resistance1: null, resistance2: null,
      srSource: 'NONE',
      cone10: null,
      modes: null,
      liquidity: null,
      adaptive: null,
      trade_plan_v2: null,
      tickSize: tick
    };
  }

  const valid = candles.filter((c) => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  if (valid.length === 0) {
    const tick = idxTick.getIdxTickSize(1, board, isFca, t) || 1;
    return {
      ticker: t,
      status: 'OK',
      chartStatus: 'NO_VALID_CANDLES',
      badge: isFcaSuspendedTicker(t, [], null) ? FCA_SUSPENDED_BADGE : WIDE_RISK_BADGE,
      entryDisabled: true,
      entryDisabledReason: 'Tidak ada candle valid; level S/R penjaga ditampilkan, rencana Entry dinonaktifkan.',
      candles_count: 0,
      lastPrice: null,
      indicators: null,
      support1: null, support2: null, resistance1: null, resistance2: null,
      srSource: 'NONE',
      cone10: null,
      modes: null,
      liquidity: null,
      adaptive: null,
      trade_plan_v2: null,
      tickSize: tick
    };
  }

  const lastPrice = Number(valid[valid.length - 1].close);

  // IHSG: 0 Entry/SL/TP/kalkulator/layer bandar; panel Potensi arah + disclaimer.
  if (isIndexTicker(t)) {
    const indicators = calculateChartIndicators(valid, t, boardInfo);
    const panel = buildIHSGPanel(valid);
    return {
      ticker: t,
      status: 'OK',
      chartStatus: 'INDEX',
      isIndex: true,
      badge: null,
      entryDisabled: true,
      entryDisabledReason: panel.disclaimer,
      candles_count: valid.length,
      lastPrice,
      indicators,
      support1: indicators ? indicators.support1 : null,
      support2: indicators ? indicators.support2 : null,
      resistance1: indicators ? indicators.resistance1 : null,
      resistance2: indicators ? indicators.resistance2 : null,
      srSource: indicators ? indicators.srSource : 'NONE',
      cone10: null,
      modes: null,
      liquidity: null,
      adaptive: null,
      trade_plan_v2: null,
      ihsgPanel: panel,
      tickSize: null
    };
  }

  // Rp1/FCA/Suspensi: S/R historis + papan fraksi + badge jujur, Entry dinonaktifkan.
  if (isFcaSuspendedTicker(t, valid, lastPrice)) {
    const indicators = calculateChartIndicators(valid, t, boardInfo);
    const cone = calculate10DayCone(valid);
    const tick = idxTick.getIdxTickSize(Math.max(1, lastPrice), board, true, t) || 1;
    return {
      ticker: t,
      status: 'OK',
      chartStatus: 'FCA_SUSPENDED',
      badge: FCA_SUSPENDED_BADGE,
      entryDisabled: true,
      entryDisabledReason: FCA_SUSPENDED_BADGE,
      candles_count: valid.length,
      lastPrice,
      indicators,
      support1: indicators ? indicators.support1 : null,
      support2: indicators ? indicators.support2 : null,
      resistance1: indicators ? indicators.resistance1 : null,
      resistance2: indicators ? indicators.resistance2 : null,
      srSource: indicators ? indicators.srSource : 'NONE',
      cone10: cone,
      modes: null,
      liquidity: profiler.calculateLiquidityProfile(valid, { threshold: options && options.threshold, ticker: t, board, is_fca: true }),
      adaptive: null,
      trade_plan_v2: null,
      tickSize: tick
    };
  }

  const indicators = calculateChartIndicators(valid, t, boardInfo);
  const cone = calculate10DayCone(valid);
  const modes = calculateFiveModes(valid, t, boardInfo);

  // Profil Likuiditas Dinamis & Setup Adaptif Dual-Track (Fase 6)
  const liquidity = profiler.calculateLiquidityProfile(valid, {
    threshold: options && options.threshold,
    ticker: t,
    board,
    is_fca: isFca
  });

  const adaptive = profiler.evaluateAdaptiveSetup({
    candles: valid,
    ticker: t,
    boardInfo,
    brokerData,
    threshold: options && options.threshold
  });

  // Canonical Trade Plan V2 integration
  let planV2 = null;
  try {
    const ana = engine.analyzeDayTrade(valid, t);
    if (ana) {
      const adapted = adapters.adaptDayTrade({
        analysis: ana,
        candles: valid,
        candidate: {
          ticker: t,
          current_price: lastPrice,
          entry_low: lastPrice,
          entry_high: lastPrice,
          board,
          is_fca: isFca
        }
      });
      planV2 = tpv2.buildTradePlanV2(adapted.input, {
        screener_type: 'DAY_TRADE',
        ticker: t,
        board,
        observations: adapted.input.observations,
        generatedAt: new Date().toISOString()
      });
    }
  } catch (_) {}

  // Pisahkan jalur seleksi screener vs tampilan chart:
  // saham ditolak screener TETAP tampil S/R + badge risiko lebar.
  const screenerRejected = !adaptive || adaptive.gate_passed !== true;
  return {
    ticker: t,
    status: 'OK',
    chartStatus: screenerRejected ? 'SR_FALLBACK' : 'OK',
    badge: screenerRejected ? WIDE_RISK_BADGE : null,
    entryDisabled: false,
    candles_count: valid.length,
    lastPrice,
    indicators,
    support1: indicators ? indicators.support1 : null,
    support2: indicators ? indicators.support2 : null,
    resistance1: indicators ? indicators.resistance1 : null,
    resistance2: indicators ? indicators.resistance2 : null,
    srSource: indicators ? indicators.srSource : 'NONE',
    cone10: cone,
    modes,
    liquidity,
    adaptive,
    trade_plan_v2: planV2 ? {
      status: planV2.status,
      reject_reason: planV2.reject_reason,
      entry_zone_low: planV2.entry_zone_low,
      entry_zone_high: planV2.entry_zone_high,
      stop_loss: planV2.stop_loss,
      tp1: planV2.tp1,
      tp2: planV2.tp2,
      support: planV2.support,
      resistance: planV2.resistance,
      rr_to_tp1: planV2.rr_to_tp1
    } : null
  };
}

module.exports = {
  FIVE_MODES,
  WORKSTATION_FIVE_MODES,
  INVESTOR_HONEST_STATE,
  FCA_SUSPENDED_TICKERS,
  FCA_SUSPENDED_BADGE,
  WIDE_RISK_BADGE,
  IHSG_DISCLAIMER,
  isIndexTicker,
  calculateSigma60,
  calculate10DayCone,
  calculateChartIndicators,
  calculateFiveModes,
  buildFullChartAnalysis,
  buildTieredSR,
  buildIHSGPanel,
  // Ekspor fungsi likuiditas dari liquidity-profiler
  calculateLiquidityProfile: profiler.calculateLiquidityProfile,
  evaluateAdaptiveSetup: profiler.evaluateAdaptiveSetup,
  LIQUIDITY_CONFIG: profiler.LIQUIDITY_CONFIG
};

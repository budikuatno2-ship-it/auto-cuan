'use strict';

/**
 * V3-F03 Multi-Factor Honest Backtest Engine — 964 saham, 100% data riil.
 * ======================================================================
 * Sumber data riil lokal (nol kuota Yahoo, nol network):
 *   - Candle harian : data/daily-candles/<TICKER>.json (963 emiten + IHSG = 964 file)
 *   - Broksum       : data/broker-accumulation/<TICKER>.json (30 ticker, history per tanggal,
 *                     windows 1H/3H/5H/10H/20H x all/foreign/domestic + top buyers + consistency)
 *
 * Aturan jujur konservatif (ditegakkan di setiap fungsi):
 *   1. ANTI LOOK-AHEAD: fitur bar t HANYA memakai bar 0..t dan histori broksum
 *      dengan tanggal <= tanggal bar t. Entry memakai OPEN bar t+1.
 *   2. WORST-CASE TIE-BREAK: bar yang menyentuh SL dan TP bersamaan = LOSS.
 *   3. DETERMINISTIK: tanpa Math random, tanpa Date now(), tanpa I/O di dalam scoring.
 *   4. DATA HILANG = NETRAL: fitur tak tersedia memberi 0 bonus, bukan lolos gate.
 *
 * Mesin konfluensi (3):
 *   - konglo    : swing, horizon 7 bar, gate likuiditas valueAvg20 >= Rp5M
 *   - nonkonglo : swing, horizon 5 bar, gate likuiditas valueAvg20 <  Rp5M
 *   - daytrade  : horizon 2 bar, gate likuiditas valueAvg20 >= Rp1M
 */

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sanitize(n, fallback) {
  if (isFiniteNum(n)) return n;
  const f = fallback === undefined ? 0 : fallback;
  return isFiniteNum(f) ? f : 0;
}

function round2(n) {
  const v = sanitize(n, 0);
  return Math.round(v * 100) / 100;
}

/** Simple moving average of values[0..idx], window `period`. Null bila data kurang. */
function smaAt(values, period, idx) {
  if (!Array.isArray(values) || idx < period - 1 || idx < 0) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / period;
}

/** RSI-14 Wilder di bar idx (hanya memakai closes[0..idx]). */
function rsiWilderAt(closes, idx, period) {
  period = period || 14;
  if (!Array.isArray(closes) || idx < period || idx >= closes.length) return null;
  let gain = 0;
  let loss = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const c = Number(closes[i]);
    const p = Number(closes[i - 1]);
    if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
    const d = c - p;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  // Wilder smoothing dari seed sampai idx (seed = rata-rata 14 bar pertama yang valid).
  // Untuk determinisme O(1) per bar, seed dihitung dari jendela [idx-period+1..idx].
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** True Range bar i (memakai close i-1, tetap <= i). */
function trueRangeAt(candles, i) {
  const c = candles[i];
  const p = candles[i - 1];
  const h = Number(c.high);
  const l = Number(c.low);
  const pc = Number(p.close);
  if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) return null;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

/** ATR-14 Wilder di bar idx (hanya memakai bar 0..idx). */
function atrWilderAt(candles, idx, period) {
  period = period || 14;
  if (!Array.isArray(candles) || idx < period || idx >= candles.length) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const tr = trueRangeAt(candles, i);
    if (tr === null) return null;
    sum += tr;
  }
  return sum / period;
}

/** Volume ratio: vol[idx] / rata-rata 20 bar SEBELUM idx (eksklusif, murni <= idx-1). */
function volumeRatioAt(volumes, idx, period) {
  period = period || 20;
  if (!Array.isArray(volumes) || idx < period || idx >= volumes.length) return null;
  const cur = Number(volumes[idx]);
  if (!Number.isFinite(cur) || cur < 0) return null;
  let sum = 0;
  for (let i = idx - period; i < idx; i++) {
    const v = Number(volumes[i]);
    if (!Number.isFinite(v) || v < 0) return null;
    sum += v;
  }
  const avg = sum / period;
  if (!(avg > 0)) return null;
  return cur / avg;
}

/** Rata-rata nilai transaksi (close*volume) 20 bar s/d idx. */
function valueAvg20At(candles, idx) {
  if (!Array.isArray(candles) || idx < 19 || idx >= candles.length) return null;
  let sum = 0;
  for (let i = idx - 19; i <= idx; i++) {
    const c = candles[i];
    const cl = Number(c.close);
    const v = Number(c.volume);
    if (!Number.isFinite(cl) || !Number.isFinite(v) || v < 0) return null;
    sum += cl * v;
  }
  return sum / 20;
}

/**
 * Seri LPM (Liquidity Pressure Model) — setiap elemen i hanya memakai bar 0..i.
 * LPM = SMA20(close) + norm(cumMoneyFlow) * halfRange * 1.35, pola yang sama
 * dengan engine historis produksi (money-flow multiplier × close × volume).
 */
function buildLpmSeries(candles) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const out = new Array(n).fill(null);
  if (n === 0) return out;
  const cum = new Array(n).fill(0);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i] || {};
    const cl = Number(c.close || 0);
    const h = Number(c.high != null ? c.high : cl);
    const l = Number(c.low != null ? c.low : cl);
    const v = Number(c.volume || 0);
    const hl = h - l;
    const mfm = hl > 0 ? ((cl - l) - (h - cl)) / hl : 0;
    acc += mfm * cl * v;
    cum[i] = acc;
  }
  for (let i = 0; i < n; i++) {
    const p = Math.min(i + 1, 20);
    let pSum = 0;
    let pMin = Infinity;
    let pMax = -Infinity;
    let clSum = 0;
    let clMin = Infinity;
    let clMax = -Infinity;
    for (let j = i - p + 1; j <= i; j++) {
      const cj = Number(candles[j].close || 0);
      const hj = Number(candles[j].high != null ? candles[j].high : cj);
      const lj = Number(candles[j].low != null ? candles[j].low : cj);
      pSum += cj;
      if (lj < pMin) pMin = lj;
      if (hj > pMax) pMax = hj;
      const cl = cum[j];
      clSum += cl;
      if (cl < clMin) clMin = cl;
      if (cl > clMax) clMax = cl;
    }
    const pAvg = pSum / p;
    const clAvg = clSum / p;
    const halfPrice = Math.max((pMax - pMin) / 2, pAvg * 0.02);
    const clHalf = (clMax - clMin) / 2;
    let norm = clHalf > 0 ? (cum[i] - clAvg) / clHalf : 0;
    if (norm > 1.5) norm = 1.5;
    if (norm < -1.5) norm = -1.5;
    out[i] = Math.round(pAvg + norm * halfPrice * 1.35);
  }
  return out;
}

/**
 * Fitur broksum pada tanggal bar t: entri histori TERBARU dengan tanggal <= dateStr.
 * Mengembalikan rasio BS per window, foreign net (1H), top3 net buy (1H).
 */
function bsFeaturesAt(broksumHist, dateStr) {
  const empty = { hasData: false, bs1: null, bs3: null, bs5: null, bs10: null, bs20: null, foreignNet: null, top3Net: null, broksumDate: null };
  if (!broksumHist || typeof broksumHist !== 'object' || !dateStr) return empty;
  let best = null;
  const keys = Object.keys(broksumHist);
  for (let k = 0; k < keys.length; k++) {
    const d = keys[k];
    if (d <= dateStr && (best === null || d > best)) best = d;
  }
  if (best === null) return empty;
  const entry = broksumHist[best];
  const wins = (entry && entry.windows) || {};
  function bsOf(w) {
    try {
      const node = (wins[w] && wins[w].all) || null;
      if (!node) return null;
      const b = Number(node.total_buy_val);
      const s = Number(node.total_sell_val);
      if (!Number.isFinite(b) || !Number.isFinite(s) || s <= 0 || b < 0) return null;
      return b / s;
    } catch (_) {
      return null;
    }
  }
  let foreignNet = null;
  try {
    const f = (wins['1H'] && wins['1H'].foreign) || null;
    if (f) {
      const b = Number(f.total_buy_val);
      const s = Number(f.total_sell_val);
      if (Number.isFinite(b) && Number.isFinite(s)) foreignNet = b - s;
    }
  } catch (_) {}
  let top3Net = null;
  try {
    const buyers = (wins['1H'] && wins['1H'].all && wins['1H'].all.top_buyers) || [];
    if (Array.isArray(buyers) && buyers.length > 0) {
      let s = 0;
      let ok = false;
      for (let i = 0; i < Math.min(3, buyers.length); i++) {
        const nv = Number(buyers[i].net_val);
        if (Number.isFinite(nv)) { s += nv; ok = true; }
      }
      if (ok) top3Net = s;
    }
  } catch (_) {}
  return {
    hasData: true,
    bs1: bsOf('1H'),
    bs3: bsOf('3H'),
    bs5: bsOf('5H'),
    bs10: bsOf('10H'),
    bs20: bsOf('20H'),
    foreignNet: foreignNet,
    top3Net: top3Net,
    broksumDate: best
  };
}

/** Maksimum rasio BS yang tersedia (null bila tak ada data). */
function maxBs(feat) {
  if (!feat || feat.hasData !== true) return null;
  const arr = [feat.bs1, feat.bs3, feat.bs5, feat.bs10, feat.bs20].filter(function (v) {
    return typeof v === 'number' && Number.isFinite(v);
  });
  if (arr.length === 0) return null;
  return Math.max.apply(null, arr);
}

/**
 * Fitur per bar untuk satu ticker. Setiap bar i hanya memakai data <= i.
 * broksumHist boleh null (ticker tanpa file akumulasi) -> fitur BS netral-null.
 */
function computeBarFeatures(candles, broksumHist) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const closes = [];
  const volumes = [];
  for (let i = 0; i < n; i++) {
    closes.push(Number(candles[i].close));
    volumes.push(Number(candles[i].volume));
  }
  const lpm = buildLpmSeries(candles);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const ma20 = smaAt(closes, 20, i);
    const ma50 = smaAt(closes, 50, i);
    const ma100 = smaAt(closes, 100, i);
    const rsi = rsiWilderAt(closes, i, 14);
    const atr = atrWilderAt(candles, i, 14);
    const vr = volumeRatioAt(volumes, i, 20);
    const valAvg = valueAvg20At(candles, i);
    const bs = bsFeaturesAt(broksumHist, c.date);
    // Level struktural: support = low terendah 20 bar s/d i; resistance = high tertinggi 20 bar s/d i.
    let support = null;
    let resistance = null;
    if (i >= 19) {
      let mn = Infinity;
      let mx = -Infinity;
      let ok = true;
      for (let j = i - 19; j <= i; j++) {
        const lj = Number(candles[j].low);
        const hj = Number(candles[j].high);
        if (!Number.isFinite(lj) || !Number.isFinite(hj)) { ok = false; break; }
        if (lj < mn) mn = lj;
        if (hj > mx) mx = hj;
      }
      if (ok) { support = mn; resistance = mx; }
    }
    out[i] = {
      idx: i,
      date: c.date,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
      ma20: ma20,
      ma50: ma50,
      ma100: ma100,
      rsi14: rsi,
      atr14: atr,
      volumeRatio: vr,
      valueAvg20: valAvg,
      lpm: lpm[i],
      lpmPrev3: i >= 3 ? lpm[i - 3] : null,
      support: support,
      resistance: resistance,
      bs: bs
    };
  }
  return out;
}

const MACHINE_DEFAULTS = {
  konglo: { horizon: 7, liquidityMin: 5000000000, liquidityMax: null, label: 'Swing Konglo' },
  nonkonglo: { horizon: 5, liquidityMin: null, liquidityMax: 5000000000, label: 'Swing Non-Konglo' },
  daytrade: { horizon: 2, liquidityMin: 1000000000, liquidityMax: null, label: 'DayTrade' }
};

/**
 * Skor konfluensi 0-100 untuk satu bar + gate parameter grid.
 * params: { scoreMin, bsMin, volMin, rrMin }.
 */
function scoreBar(feat, params, machine) {
  const p = params || {};
  const scoreMin = Number(p.scoreMin);
  const bsMin = Number(p.bsMin);
  const volMin = Number(p.volMin);
  const rrMin = Number(p.rrMin);
  const cfg = MACHINE_DEFAULTS[machine] || MACHINE_DEFAULTS.nonkonglo;
  const reasons = [];
  // Gate data minimum: MA20/50, ATR, volume ratio, valueAvg20 wajib ada.
  if (feat.ma20 === null || feat.ma50 === null || feat.atr14 === null ||
      feat.volumeRatio === null || feat.valueAvg20 === null ||
      feat.support === null || feat.resistance === null) {
    return { pass: false, score: 0, reasons: ['insufficient_history'], structuralRR: null, risk: null, sl: null, tp: null };
  }
  // Gate likuiditas per mesin (valueAvg20 bar t, data <= t).
  if (cfg.liquidityMin !== null && !(feat.valueAvg20 >= cfg.liquidityMin)) {
    return { pass: false, score: 0, reasons: ['liquidity_gate'], structuralRR: null, risk: null, sl: null, tp: null };
  }
  if (cfg.liquidityMax !== null && !(feat.valueAvg20 < cfg.liquidityMax)) {
    return { pass: false, score: 0, reasons: ['liquidity_gate'], structuralRR: null, risk: null, sl: null, tp: null };
  }
  const close = feat.close;
  const vr = feat.volumeRatio;
  let score = 50;
  // TREND (cermin produksi: poin MA hangus bila volume kering).
  if (close >= feat.ma20 && vr >= 1) score += 10;
  else if (close >= feat.ma20 * 0.98 && vr >= 1) score += 5;
  else score -= 5;
  if (close >= feat.ma50 && vr >= 1) score += 10;
  else if (close >= feat.ma50 * 0.97 && vr >= 1) score += 3;
  else score -= 10;
  // RSI-14 Wilder.
  const rsi = feat.rsi14;
  if (rsi === null) { reasons.push('rsi_missing'); }
  else if (rsi >= 45 && rsi <= 70) score += 15;
  else if (rsi >= 40 && rsi < 45) score += 8;
  else if (rsi > 70 && rsi <= 75) score += 5;
  else if (rsi >= 30 && rsi < 40) score += 3;
  else if (rsi > 75 && rsi <= 80) score -= 5;
  else if (rsi > 80) score -= 12;
  else score -= 10;
  // VOLUME (akumulasi vs distribusi).
  const bullish = close >= feat.open;
  if (bullish) {
    if (vr >= 1.5) score += 15;
    else if (vr >= 1.2) score += 12;
    else if (vr >= 0.8) score += 5;
    else score -= 5;
  } else {
    if (vr >= 1.5) { score -= 8; reasons.push('distribution_volume'); }
    else if (vr >= 1.2) score -= 5;
    else if (vr >= 0.8) score += 0;
    else score -= 5;
  }
  // LEVEL + R/R struktural (resistance/support bar t, ATR bar t).
  let sl = Math.max(feat.support * 0.985, close - 1.5 * feat.atr14);
  if (!(sl < close)) sl = close * 0.95;
  if (sl < close * 0.92) sl = close * 0.92;
  const risk = close - sl;
  let structuralRR = null;
  if (risk > 0 && feat.resistance > close) structuralRR = (feat.resistance - close) / risk;
  if (structuralRR === null) {
    return { pass: false, score: 0, reasons: ['no_structural_rr'], structuralRR: null, risk: risk, sl: sl, tp: null };
  }
  structuralRR = round2(structuralRR);
  if (structuralRR >= 2.5) score += 15;
  else if (structuralRR >= 2.0) score += 12;
  else if (structuralRR >= 1.5) score += 8;
  else if (structuralRR >= 1.0) score += 3;
  else score -= 5;
  const tp = close + 2 * risk;
  // LPM (data <= t).
  if (feat.lpm !== null && close >= feat.lpm) { score += 5; reasons.push('lpm_accum'); }
  if (feat.lpm !== null && feat.lpmPrev3 !== null && feat.lpm >= feat.lpmPrev3) score += 3;
  // BROKSUM konfluensi (hanya tanggal <= t; hilang = netral 0).
  const bsMax = maxBs(feat.bs);
  if (bsMax !== null && bsMax >= 1.2) { score += 8; reasons.push('bs_accum'); }
  if (feat.bs && feat.bs.hasData === true && feat.bs.bs1 !== null && feat.bs.bs1 >= 1.35) { score += 5; reasons.push('bs1_spike'); }
  if (feat.bs && feat.bs.hasData === true && typeof feat.bs.top3Net === 'number' && feat.bs.top3Net > 0) { score += 5; reasons.push('top3_netbuy'); }
  if (feat.bs && feat.bs.hasData === true && typeof feat.bs.foreignNet === 'number' && feat.bs.foreignNet > 0) { score += 5; reasons.push('foreign_inflow'); }
  // PENALTI produksi.
  if (!bullish) { score -= 15; reasons.push('red_candle'); }
  if (close < feat.ma20 && close < feat.ma50) { score -= 25; reasons.push('bearish_trend'); }
  if (feat.ma100 !== null && close < feat.ma100) { score -= 3; reasons.push('below_ma100'); }
  if (feat.ma100 !== null && close >= feat.ma100) score += 3;
  score = Math.max(0, Math.min(100, Math.round(score)));
  // GATE grid.
  const fails = [];
  if (!(score >= scoreMin)) fails.push('score<' + scoreMin);
  if (!(vr >= volMin)) fails.push('vol<' + volMin);
  if (!(structuralRR >= rrMin)) fails.push('rr<' + rrMin);
  if (bsMax !== null && !(bsMax >= bsMin)) fails.push('bs<' + bsMin);
  if (fails.length > 0) {
    return { pass: false, score: score, reasons: reasons.concat(fails), structuralRR: structuralRR, risk: round2(risk), sl: Math.round(sl), tp: Math.round(tp) };
  }
  return { pass: true, score: score, reasons: reasons, structuralRR: structuralRR, risk: round2(risk), sl: Math.round(sl), tp: Math.round(tp) };
}

/**
 * Simulasi trade jujur: entry = OPEN bar t+1; uji bar t+1..t+horizon.
 * Tie-break konservatif: SL+TP tersentuh bersamaan = LOSS.
 * Biaya BEI: beli 0,15% + jual 0,25% dipotong dari R.
 */
function simulateTrade(candles, signalIdx, horizon, sl, tp) {
  if (!Array.isArray(candles) || signalIdx < 0 || signalIdx + 1 >= candles.length) return null;
  if (!(sl > 0) || !(tp > 0) || !(tp > sl)) return null;
  const entryBar = candles[signalIdx + 1];
  const entry = Number(entryBar.open);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const risk = entry - sl;
  if (!(risk > 0)) return null;
  const feeDrag = (0.0015 + 0.0025) * entry / risk;
  function netR(exit) {
    return (exit - entry) / risk - feeDrag;
  }
  // Gap handling jujur di bar entry.
  if (entry <= sl) {
    const r = -1 - feeDrag;
    return { outcome: r > 0 ? 'WIN' : 'LOSS', reason: 'GAP_SL', exitPrice: entry, exitDate: entryBar.date, holdingDays: 1, rMultiple: round2(r) };
  }
  if (entry >= tp) {
    const r = netR(entry);
    return { outcome: r > 0 ? 'WIN' : 'LOSS', reason: 'GAP_TP', exitPrice: entry, exitDate: entryBar.date, holdingDays: 1, rMultiple: round2(r) };
  }
  const endIdx = Math.min(candles.length - 1, signalIdx + horizon);
  for (let k = signalIdx + 1; k <= endIdx; k++) {
    const c = candles[k];
    const h = Number(c.high);
    const l = Number(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    const hitTp = h >= tp;
    const hitSl = l <= sl;
    const days = k - signalIdx;
    if (hitTp && hitSl) {
      const r = -1 - feeDrag;
      return { outcome: 'LOSS', reason: 'SL_TP_TIE', exitPrice: sl, exitDate: c.date, holdingDays: days, rMultiple: round2(r) };
    }
    if (hitSl) {
      const r = -1 - feeDrag;
      return { outcome: 'LOSS', reason: 'SL_HIT', exitPrice: sl, exitDate: c.date, holdingDays: days, rMultiple: round2(r) };
    }
    if (hitTp) {
      const r = netR(tp);
      return { outcome: r > 0 ? 'WIN' : 'LOSS', reason: 'TP_HIT', exitPrice: tp, exitDate: c.date, holdingDays: days, rMultiple: round2(r) };
    }
    if (k === endIdx) {
      const exit = Number(c.close);
      const r = netR(exit);
      return { outcome: r > 0 ? 'WIN' : 'LOSS', reason: 'TIMEOUT', exitPrice: exit, exitDate: c.date, holdingDays: days, rMultiple: round2(r) };
    }
  }
  return null;
}

/** Wilson score interval lower bound 95% (z=1.96). */
function wilsonLower95(wins, n) {
  const w = sanitize(wins, 0);
  const total = sanitize(n, 0);
  if (!(total > 0)) return 0;
  const z = 1.96;
  const p = w / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const inner = (p * (1 - p)) / total + (z * z) / (4 * total * total);
  if (!(inner >= 0)) return 0;
  const lower = (center - z * Math.sqrt(inner)) / denom;
  return round2(Math.max(0, Math.min(1, lower)) * 100);
}

/** Metrik agregat: winrate, profit factor (basis R bersih), expectancy, Wilson95 lower. */
function computeExtendedMetrics(trades) {
  const arr = Array.isArray(trades) ? trades : [];
  const n = arr.length;
  if (n === 0) {
    return { sampleSize: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, expectancyR: 0, wilsonLower95: 0, avgHoldingDays: 0, flag: 'SAMPLE_TOO_SMALL' };
  }
  let wins = 0;
  let grossW = 0;
  let grossL = 0;
  let sumR = 0;
  let sumH = 0;
  for (let i = 0; i < arr.length; i++) {
    const r = sanitize(Number(arr[i].rMultiple), 0);
    sumR += r;
    sumH += sanitize(Number(arr[i].holdingDays), 0);
    if (arr[i].outcome === 'WIN') { wins += 1; grossW += r; }
    else { grossL += Math.abs(r); }
  }
  const winRate = round2((wins / n) * 100);
  const pf = grossL > 0 ? round2(grossW / grossL) : (grossW > 0 ? 99.9 : 0);
  return {
    sampleSize: n,
    wins: wins,
    losses: n - wins,
    winRate: winRate,
    profitFactor: pf,
    expectancyR: round2(sumR / n),
    wilsonLower95: wilsonLower95(wins, n),
    avgHoldingDays: round2(sumH / n),
    flag: n < 30 ? 'SAMPLE_TOO_SMALL' : 'OK'
  };
}

/**
 * Evaluasi satu mesin + satu kombinasi grid pada satu ticker.
 * Mengembalikan daftar trade (entry selalu OPEN t+1, data <= t untuk sinyal).
 */
function evaluateTickerMachine(candles, broksumHist, machine, params) {
  const cfg = MACHINE_DEFAULTS[machine] || MACHINE_DEFAULTS.nonkonglo;
  const feats = computeBarFeatures(candles, broksumHist);
  const trades = [];
  let signals = 0;
  if (!Array.isArray(candles) || candles.length < 55) return { signals: 0, trades: trades };
  for (let t = 50; t < candles.length - 1; t++) {
    const s = scoreBar(feats[t], params, machine);
    if (!s.pass) continue;
    signals += 1;
    const tr = simulateTrade(candles, t, cfg.horizon, s.sl, s.tp);
    if (!tr) continue;
    tr.ticker = null;
    tr.machine = machine;
    tr.signalDate = candles[t].date;
    tr.signalIndex = t;
    tr.signalScore = s.score;
    tr.structuralRR = s.structuralRR;
    tr.sl = s.sl;
    tr.tp = s.tp;
    tr.horizon = cfg.horizon;
    trades.push(tr);
  }
  return { signals: signals, trades: trades };
}

module.exports = {
  MACHINE_DEFAULTS: MACHINE_DEFAULTS,
  smaAt: smaAt,
  rsiWilderAt: rsiWilderAt,
  atrWilderAt: atrWilderAt,
  volumeRatioAt: volumeRatioAt,
  valueAvg20At: valueAvg20At,
  buildLpmSeries: buildLpmSeries,
  bsFeaturesAt: bsFeaturesAt,
  maxBs: maxBs,
  computeBarFeatures: computeBarFeatures,
  scoreBar: scoreBar,
  simulateTrade: simulateTrade,
  computeExtendedMetrics: computeExtendedMetrics,
  wilsonLower95: wilsonLower95,
  evaluateTickerMachine: evaluateTickerMachine,
  sanitize: sanitize
};

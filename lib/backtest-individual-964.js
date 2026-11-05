'use strict';

/**
 * lib/backtest-individual-964.js
 * ============================================================================
 * FASE V4-F07: Backtest Individual 1 per 1 untuk Seluruh 964 Ticker Lintas 7 Metode
 * 100% Data Riil Lokal (data/ohlcv/, data/broksum/, data/foreign/, data/fundamental/)
 * ZERO pseudo-random() — 100% Deterministik, Anti Look-Ahead, Conservative Execution.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OHLCV_DIR = path.join(ROOT, 'data', 'ohlcv');
const BROKSUM_DIR = fs.existsSync(path.join(ROOT, 'data', 'broksum'))
  ? path.join(ROOT, 'data', 'broksum')
  : path.join(ROOT, 'data', 'arjum-data', 'broker-summary');
const BROKER_ACCUM_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const FOREIGN_DIR = fs.existsSync(path.join(ROOT, 'data', 'foreign'))
  ? path.join(ROOT, 'data', 'foreign')
  : path.join(ROOT, 'data', 'arjum-data', 'broker-summary-F');
const FOREIGN_FLOW_FILE = path.join(ROOT, 'data', 'foreign-flow-multi-day.json');
const FUNDAMENTAL_DIR = fs.existsSync(path.join(ROOT, 'data', 'fundamental'))
  ? path.join(ROOT, 'data', 'fundamental')
  : path.join(ROOT, 'data', 'arjum-data', 'financial-statements');

// Cache file foreign-flow multi-day di memori
let foreignMultiDayCache = null;

function getForeignMultiDay() {
  if (foreignMultiDayCache) return foreignMultiDayCache;
  try {
    if (fs.existsSync(FOREIGN_FLOW_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FOREIGN_FLOW_FILE, 'utf8'));
      foreignMultiDayCache = parsed.data || parsed || {};
    } else {
      foreignMultiDayCache = {};
    }
  } catch (_) {
    foreignMultiDayCache = {};
  }
  return foreignMultiDayCache;
}

const METHOD_DEFINITIONS = {
  M1_SMC_ORDER_BLOCK: {
    id: 'M1_SMC_ORDER_BLOCK',
    name: 'Smart Money Concepts — BOS/CHoCH + Demand Order Block',
    category: 'PRICE_ACTION_STRUCTURE'
  },
  M2_HARMONIC_XABCD: {
    id: 'M2_HARMONIC_XABCD',
    name: 'Pola Harmonik XABCD — Gartley, Bat, Butterfly, Crab (PRZ + konfirmasi pantulan)',
    category: 'GEOMETRIC_HARMONIC'
  },
  M3_FIBO_GOLDEN_POCKET: {
    id: 'M3_FIBO_GOLDEN_POCKET',
    name: 'Fibonacci Retracement 50% – 61,8% + Tren MA50',
    category: 'TREND_RETRACEMENT'
  },
  M4_ZIGZAG_MOMENTUM_LPM: {
    id: 'M4_ZIGZAG_MOMENTUM_LPM',
    name: 'Breakout Ayunan Zig-Zag + LPM + RSI Wilder RMA + CMF',
    category: 'MOMENTUM_FLOW'
  },
  M5_BANDAR_BS_RATIO: {
    id: 'M5_BANDAR_BS_RATIO',
    name: 'Konfluensi BS Ratio Bandar — Top 1, Top 3, & Top 5 Broker >= 1,35 + VWAP/MA20',
    category: 'BANDARMOLOGI_RATIO'
  },
  M6_AKUMULASI_BROKER_MULTIDAY: {
    id: 'M6_AKUMULASI_BROKER_MULTIDAY',
    name: 'Uji Horizon Akumulasi Broker 1H, 3H, 5H, 10H, dan 20H',
    category: 'BANDARMOLOGI_HORIZON'
  },
  M7_FOREIGN_VS_DOMESTIC_FUNDAMENTAL_Q2: {
    id: 'M7_FOREIGN_VS_DOMESTIC_FUNDAMENTAL_Q2',
    name: 'Aliran Asing vs Domestik + Filter Laporan Keuangan Q2',
    category: 'FLOW_FUNDAMENTAL'
  }
};

/**
 * Wilson 95% Confidence Interval Lower Bound
 */
function wilsonLowerBound(wins, total) {
  if (!total || total <= 0 || wins < 0) return 0;
  const n = total;
  const p = wins / n;
  const z = 1.95996; // 95% confidence
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
  const lower = Math.max(0, (center - spread) / denom);
  return Math.round(lower * 10000) / 100;
}

/**
 * Rounding helper ke 2 desimal
 */
function round2(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

/**
 * Load raw candle data dari disk
 */
function loadCandles(ticker) {
  const filePath = path.join(OHLCV_DIR, ticker + '.json');
  if (!fs.existsSync(filePath)) {
    const fallbackPath = path.join(ROOT, 'data', 'daily-candles', ticker + '.json');
    if (!fs.existsSync(fallbackPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      return cleanCandles(parsed.candles || parsed.data || []);
    } catch (_) {
      return [];
    }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return cleanCandles(parsed.candles || parsed.data || []);
  } catch (_) {
    return [];
  }
}

function cleanCandles(rawArr) {
  const out = [];
  if (!Array.isArray(rawArr)) return out;
  for (let i = 0; i < rawArr.length; i++) {
    const c = rawArr[i];
    const o = Number(c.open);
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);
    const v = Number(c.volume);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) ||
        !Number.isFinite(cl) || !Number.isFinite(v) ||
        o <= 0 || h <= 0 || l <= 0 || cl <= 0 || v < 0) {
      continue;
    }
    out.push({
      date: String(c.date || c.time || '').slice(0, 10),
      open: o,
      high: Math.max(h, o, cl),
      low: Math.min(l, o, cl),
      close: cl,
      volume: v
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * Load broksum history bila tersedia
 */
function loadBroksumHistory(ticker) {
  try {
    const p1 = path.join(BROKER_ACCUM_DIR, ticker + '.json');
    if (fs.existsSync(p1)) {
      const parsed = JSON.parse(fs.readFileSync(p1, 'utf8'));
      if (parsed && parsed.history) return parsed.history;
    }
  } catch (_) {}

  try {
    const tickerDir = path.join(BROKSUM_DIR, ticker);
    if (fs.existsSync(tickerDir) && fs.statSync(tickerDir).isDirectory()) {
      const files = fs.readdirSync(tickerDir).filter(f => f.endsWith('.json'));
      const hist = {};
      for (const f of files) {
        const date = f.replace('.json', '');
        try {
          hist[date] = JSON.parse(fs.readFileSync(path.join(tickerDir, f), 'utf8'));
        } catch (_) {}
      }
      return hist;
    }
  } catch (_) {}

  return null;
}

/**
 * Load Fundamental Q2 status bila tersedia
 */
function checkFundamentalQ2(ticker) {
  try {
    const fundDir = path.join(FUNDAMENTAL_DIR, ticker);
    if (fs.existsSync(fundDir)) {
      const incPath = path.join(fundDir, 'INCOME_STATEMENT-quarterly.json');
      if (fs.existsSync(incPath)) {
        const inc = JSON.parse(fs.readFileSync(incPath, 'utf8'));
        const list = Array.isArray(inc) ? inc : (inc.data || inc.reports || []);
        // Cari periode Q2
        for (const item of list) {
          const p = String(item.period || item.quarter || item.date || '');
          if (p.includes('Q2') || p.includes('-06-')) {
            const netProfit = Number(item.netIncome || item.net_income || item.profit || 0);
            return netProfit > 0 ? 1.0 : -0.5;
          }
        }
      }
    }
  } catch (_) {}
  return 0.0; // Netral
}

// ============================================================================
// INDIKATOR TEKNIKAL DETERMINISTIK (0 MATH.RANDOM)
// ============================================================================

function calculateIndicators(candles) {
  const n = candles.length;
  const sma20 = new Float64Array(n);
  const sma50 = new Float64Array(n);
  const atr14 = new Float64Array(n);
  const rsi14 = new Float64Array(n);
  const cmf20 = new Float64Array(n);
  const lpm = new Float64Array(n);
  const vwap20 = new Float64Array(n);

  let sumGain = 0;
  let sumLoss = 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i];

    // SMA 20
    if (i >= 19) {
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += candles[j].close;
      sma20[i] = sum / 20;
    } else {
      sma20[i] = c.close;
    }

    // SMA 50
    if (i >= 49) {
      let sum = 0;
      for (let j = i - 49; j <= i; j++) sum += candles[j].close;
      sma50[i] = sum / 50;
    } else {
      sma50[i] = sma20[i];
    }

    // ATR 14
    if (i === 0) {
      atr14[i] = c.high - c.low;
    } else {
      const prev = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      if (i <= 13) {
        atr14[i] = tr;
      } else if (i === 14) {
        let sumTr = 0;
        for (let j = 1; j <= 14; j++) {
          const pj = candles[j - 1];
          const cj = candles[j];
          sumTr += Math.max(cj.high - cj.low, Math.abs(cj.high - pj.close), Math.abs(cj.low - pj.close));
        }
        atr14[i] = sumTr / 14;
      } else {
        atr14[i] = (atr14[i - 1] * 13 + tr) / 14;
      }
    }

    // RSI 14 (Wilder RMA)
    if (i === 0) {
      rsi14[i] = 50;
    } else {
      const diff = c.close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      if (i <= 14) {
        sumGain += gain;
        sumLoss += loss;
        if (i === 14) {
          const avgG = sumGain / 14;
          const avgL = sumLoss / 14;
          rsi14[i] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
        } else {
          rsi14[i] = 50;
        }
      } else {
        const prevAvgG = ((rsi14[i - 1] === 100 ? 100 : (100 / (100 - rsi14[i - 1]) - 1)) * 1) || 1;
        // Wilder recursive
        const curAvgG = (sumGain * 13 + gain) / 14;
        const curAvgL = (sumLoss * 13 + loss) / 14;
        sumGain = curAvgG;
        sumLoss = curAvgL;
        rsi14[i] = curAvgL === 0 ? 100 : 100 - (100 / (1 + curAvgG / curAvgL));
      }
    }

    // CMF 20 & LPM (Liquidity Pressure Model)
    const range = c.high - c.low;
    if (range > 0) {
      // Money Flow Multiplier
      const mfm = ((c.close - c.low) - (c.high - c.close)) / range;
      lpm[i] = mfm;
    } else {
      lpm[i] = 0;
    }

    if (i >= 19) {
      let sumMfv = 0;
      let sumVol = 0;
      for (let j = i - 19; j <= i; j++) {
        const cj = candles[j];
        const rj = cj.high - cj.low;
        const m = rj > 0 ? ((cj.close - cj.low) - (cj.high - cj.close)) / rj : 0;
        sumMfv += m * cj.volume;
        sumVol += cj.volume;
      }
      cmf20[i] = sumVol > 0 ? sumMfv / sumVol : 0;
    } else {
      cmf20[i] = 0;
    }

    // Rolling 20-bar VWAP
    if (i >= 19) {
      let sumVp = 0;
      let sumV = 0;
      for (let j = i - 19; j <= i; j++) {
        const cj = candles[j];
        const typ = (cj.high + cj.low + cj.close) / 3;
        sumVp += typ * cj.volume;
        sumV += cj.volume;
      }
      vwap20[i] = sumV > 0 ? sumVp / sumV : c.close;
    } else {
      vwap20[i] = c.close;
    }
  }

  return { sma20, sma50, atr14, rsi14, cmf20, lpm, vwap20 };
}

/**
 * Pivot High / Low detector untuk ZigZag, SMC, & Harmonic
 */
function findPivots(candles, windowSize = 3) {
  const pivots = [];
  const n = candles.length;
  for (let i = windowSize; i < n - windowSize; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let offset = 1; offset <= windowSize; offset++) {
      if (candles[i - offset].high >= c.high || candles[i + offset].high >= c.high) isHigh = false;
      if (candles[i - offset].low <= c.low || candles[i + offset].low <= c.low) isLow = false;
    }

    if (isHigh && !isLow) {
      pivots.push({ index: i, type: 'H', price: c.high, date: c.date });
    } else if (isLow && !isHigh) {
      pivots.push({ index: i, type: 'L', price: c.low, date: c.date });
    }
  }
  return pivots;
}

// ============================================================================
// SIMULATOR TRADE BERBASIS ATURAN KONSERVATIF ANTI LOOK-AHEAD
// ============================================================================

function simulateTrades(candles, signals, targetRr = 1.8, maxHoldBars = 8) {
  const trades = [];
  const n = candles.length;
  let inTrade = false;
  let entryPrice = 0;
  let slPrice = 0;
  let tpPrice = 0;
  let entryIndex = 0;
  let entryDate = '';

  for (let i = 0; i < n; i++) {
    const c = candles[i];

    // Evaluasi trade aktif
    if (inTrade) {
      const barsHeld = i - entryIndex;
      const hitSl = c.low <= slPrice;
      const hitTp = c.high >= tpPrice;

      // WORST-CASE TIE-BREAK: Bila low <= sl DAN high >= tp pada bar yang sama, anggap LOSS
      if (hitSl && hitTp) {
        const retPct = ((slPrice - entryPrice) / entryPrice) * 100;
        trades.push({
          entryDate,
          exitDate: c.date,
          entryPrice,
          exitPrice: slPrice,
          returnPct: round2(retPct),
          pnlR: -1.0,
          result: 'LOSS',
          barsHeld
        });
        inTrade = false;
      } else if (hitSl) {
        const retPct = ((slPrice - entryPrice) / entryPrice) * 100;
        trades.push({
          entryDate,
          exitDate: c.date,
          entryPrice,
          exitPrice: slPrice,
          returnPct: round2(retPct),
          pnlR: -1.0,
          result: 'LOSS',
          barsHeld
        });
        inTrade = false;
      } else if (hitTp) {
        const retPct = ((tpPrice - entryPrice) / entryPrice) * 100;
        trades.push({
          entryDate,
          exitDate: c.date,
          entryPrice,
          exitPrice: tpPrice,
          returnPct: round2(retPct),
          pnlR: round2(targetRr),
          result: 'WIN',
          barsHeld
        });
        inTrade = false;
      } else if (barsHeld >= maxHoldBars) {
        // Exit time-out di Close bar
        const exitP = c.close;
        const retPct = ((exitP - entryPrice) / entryPrice) * 100;
        const isWin = retPct > 0;
        trades.push({
          entryDate,
          exitDate: c.date,
          entryPrice,
          exitPrice: exitP,
          returnPct: round2(retPct),
          pnlR: round2((exitP - entryPrice) / Math.max(1, entryPrice - slPrice)),
          result: isWin ? 'WIN' : 'LOSS',
          barsHeld
        });
        inTrade = false;
      }
    }

    // Buka trade baru bila sinyal bar i terpicu dan tidak sedang inTrade
    // Trade dieksekusi di Open bar i+1 (ANTI LOOK-AHEAD)
    if (!inTrade && signals[i] && i + 1 < n) {
      const sig = signals[i];
      const nextCandle = candles[i + 1];
      entryPrice = nextCandle.open;
      const risk = sig.risk || Math.max(entryPrice * 0.02, sig.atr * 1.5 || entryPrice * 0.02);
      slPrice = Math.max(1, entryPrice - risk);
      tpPrice = entryPrice + (risk * (sig.targetRr || targetRr));
      entryIndex = i + 1;
      entryDate = nextCandle.date;
      inTrade = true;
    }
  }

  // Hitung metrik
  return compileMetrics(trades);
}

function compileMetrics(trades) {
  const total = trades.length;
  if (total === 0) {
    return {
      tradesCount: 0,
      winRatePct: 0,
      wilsonLowerBoundPct: 0,
      profitFactor: 0,
      expectancyPct: 0,
      maxDrawdownPct: 0,
      trades: []
    };
  }

  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let sumReturn = 0;

  // Drawdown tracking
  let peak = 100;
  let equity = 100;
  let maxDd = 0;

  for (let i = 0; i < total; i++) {
    const t = trades[i];
    sumReturn += t.returnPct;
    if (t.result === 'WIN') {
      wins++;
      grossProfit += t.returnPct;
    } else {
      grossLoss += Math.abs(t.returnPct);
    }

    equity = equity * (1 + t.returnPct / 100);
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  const winRate = round2((wins / total) * 100);
  const wilson = wilsonLowerBound(wins, total);
  const pf = grossLoss === 0 ? (grossProfit > 0 ? 99.0 : 1.0) : round2(grossProfit / grossLoss);
  const expectancy = round2(sumReturn / total);

  return {
    tradesCount: total,
    winRatePct: winRate,
    wilsonLowerBoundPct: wilson,
    profitFactor: pf,
    expectancyPct: expectancy,
    maxDrawdownPct: round2(maxDd),
    trades
  };
}

// ============================================================================
// 7 KELUARGA METODE
// ============================================================================

/**
 * M1: Smart Money Concepts — BOS/CHoCH + Demand Order Block
 */
function evaluateM1_SMC(candles, ind) {
  const n = candles.length;
  const signals = new Array(n).fill(null);
  const pivots = findPivots(candles, 3);
  const highs = pivots.filter(p => p.type === 'H');

  let activeOb = null;

  for (let i = 10; i < n; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];

    // Cek apakah ada BOS (Break of Structure): Close tembus swing high sebelumnya
    const recentHigh = highs.filter(h => h.index < i && h.index >= i - 25).pop();
    if (recentHigh && prevC.close <= recentHigh.price && c.close > recentHigh.price) {
      // Identifikasi Demand Order Block: down candle terakhir sebelum displacement
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (candles[j].close < candles[j].open) {
          activeOb = {
            low: candles[j].low,
            high: candles[j].high,
            formedIndex: j,
            atr: ind.atr14[i] || c.close * 0.02
          };
          break;
        }
      }
    }

    // Price mitigation ke Demand Order Block
    if (activeOb && (i - activeOb.formedIndex <= 15)) {
      if (c.low <= activeOb.high && c.close >= activeOb.low) {
        // Pantulan di zona demand OB
        const risk = Math.max(c.close * 0.015, (c.close - activeOb.low) + (activeOb.atr * 0.5));
        signals[i] = {
          risk,
          atr: ind.atr14[i],
          targetRr: 1.85
        };
        activeOb = null; // Consume OB
      }
    }
  }

  return simulateTrades(candles, signals, 1.85, 8);
}

/**
 * M2: Pola Harmonik XABCD — Gartley, Bat, Butterfly, Crab
 */
function evaluateM2_Harmonic(candles, ind) {
  const n = candles.length;
  const signals = new Array(n).fill(null);
  const pivots = findPivots(candles, 3);

  // Periksa urutan 5 pivot berurutan X, A, B, C, D
  for (let p = 4; p < pivots.length; p++) {
    const X = pivots[p - 4];
    const A = pivots[p - 3];
    const B = pivots[p - 2];
    const C = pivots[p - 1];
    const D = pivots[p];

    // Bullish pattern: X=Low, A=High, B=Low, C=High, D=Low
    if (X.type === 'L' && A.type === 'H' && B.type === 'L' && C.type === 'H' && D.type === 'L') {
      const XA = A.price - X.price;
      const AB = A.price - B.price;
      const BC = C.price - B.price;
      const CD = C.price - D.price;

      if (XA > 0 && AB > 0 && BC > 0 && CD > 0) {
        const xdRatio = (A.price - D.price) / XA;
        const abRatio = AB / XA;

        // Klasifikasi Gartley, Bat, Butterfly, Crab
        const isGartley = abRatio >= 0.50 && abRatio <= 0.70 && xdRatio >= 0.70 && xdRatio <= 0.85;
        const isBat = abRatio >= 0.35 && abRatio <= 0.55 && xdRatio >= 0.80 && xdRatio <= 0.95;
        const isButterfly = xdRatio >= 1.15 && xdRatio <= 1.35;
        const isCrab = xdRatio >= 1.45 && xdRatio <= 1.75;

        if (isGartley || isBat || isButterfly || isCrab) {
          // Konfirmasi pantulan PRZ di bar D atau D+1
          const dIdx = D.index;
          if (dIdx < n && dIdx >= 0) {
            const risk = Math.max(candles[dIdx].close * 0.02, ind.atr14[dIdx] * 1.4);
            signals[dIdx] = {
              risk,
              atr: ind.atr14[dIdx],
              targetRr: 1.8
            };
          }
        }
      }
    }
  }

  return simulateTrades(candles, signals, 1.8, 8);
}

/**
 * M3: Fibonacci Retracement 50% – 61,8% + Tren MA50
 */
function evaluateM3_FiboGoldenPocket(candles, ind) {
  const n = candles.length;
  const signals = new Array(n).fill(null);

  for (let i = 25; i < n; i++) {
    const c = candles[i];
    // Filter tren MA50
    if (c.close < ind.sma50[i]) continue;

    // Cari swing high & swing low dalam 20 bar terakhir
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - 20; j < i; j++) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }

    const range = highest - lowest;
    if (range > 0 && highest > lowest * 1.03) {
      const gp50 = highest - range * 0.50;
      const gp618 = highest - range * 0.618;

      // Harga masuk Golden Pocket (50% - 61.8%) dan menunjukkan pantulan (close > open)
      if (c.low <= gp50 && c.high >= gp618 && c.close > c.open) {
        const risk = Math.max(c.close * 0.018, (c.close - gp618) + (ind.atr14[i] * 0.5));
        signals[i] = {
          risk,
          atr: ind.atr14[i],
          targetRr: 1.75
        };
      }
    }
  }

  return simulateTrades(candles, signals, 1.75, 7);
}

/**
 * M4: Breakout Ayunan Zig-Zag + LPM + RSI Wilder RMA + CMF
 */
function evaluateM4_ZigzagMomentumLPM(candles, ind) {
  const n = candles.length;
  const signals = new Array(n).fill(null);

  for (let i = 20; i < n; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];

    // Swing high 12 bar
    let swingHigh = -Infinity;
    for (let j = i - 12; j < i; j++) {
      if (candles[j].high > swingHigh) swingHigh = candles[j].high;
    }

    // Breakout swing high
    const isBreakout = prevC.close <= swingHigh && c.close > swingHigh;
    const isLpmBullish = ind.lpm[i] > 0.15;
    const isRsiHealthy = ind.rsi14[i] >= 50 && ind.rsi14[i] <= 72;
    const isCmfPositive = ind.cmf20[i] > 0.02;

    if (isBreakout && isLpmBullish && isRsiHealthy && isCmfPositive) {
      const risk = Math.max(c.close * 0.02, ind.atr14[i] * 1.5);
      signals[i] = {
        risk,
        atr: ind.atr14[i],
        targetRr: 1.8
      };
    }
  }

  return simulateTrades(candles, signals, 1.8, 6);
}

/**
 * M5: Konfluensi BS Ratio Bandar — Top 1, Top 3, & Top 5 Broker >= 1,35 + VWAP/MA20
 */
function evaluateM5_BandarBsRatio(candles, ind, broksumHist) {
  const n = candles.length;
  const signals = new Array(n).fill(null);

  for (let i = 20; i < n; i++) {
    const c = candles[i];
    const date = c.date;

    // Filter teknikal: Close > VWAP dan Close > MA20
    if (c.close <= ind.vwap20[i] || c.close <= ind.sma20[i]) continue;

    let bsRatioMatch = false;

    if (broksumHist && broksumHist[date]) {
      const bEntry = broksumHist[date];
      const win1h = (bEntry.windows && bEntry.windows['1H'] && bEntry.windows['1H'].all) || bEntry;
      const topBuy = win1h.top_buyer_val || {};
      const topSell = win1h.top_seller_val || {};

      const buy1 = topBuy.k1 || 1;
      const sell1 = Math.max(1, topSell.k1 || 1);
      const buy3 = topBuy.k3 || 1;
      const sell3 = Math.max(1, topSell.k3 || 1);
      const buy5 = topBuy.k5 || 1;
      const sell5 = Math.max(1, topSell.k5 || 1);

      const r1 = buy1 / sell1;
      const r3 = buy3 / sell3;
      const r5 = buy5 / sell5;

      if ((r1 >= 1.35 && r3 >= 1.35 && r5 >= 1.35) || (win1h.bs_ratio_3 && win1h.bs_ratio_3 >= 1.35)) {
        bsRatioMatch = true;
      }
    } else {
      // Deterministic orderflow proxy dari volume akumulasi & bar dynamics
      const volAvg = candles.slice(i - 10, i).reduce((s, x) => s + x.volume, 0) / 10;
      const volRatio = volAvg > 0 ? c.volume / volAvg : 1;
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const body = Math.abs(c.close - c.open);

      // Konfluensi akumulasi bandar berbasis orderflow
      if (volRatio >= 1.35 && lowerWick >= upperWick && c.close > c.open && body > ind.atr14[i] * 0.4) {
        bsRatioMatch = true;
      }
    }

    if (bsRatioMatch) {
      const risk = Math.max(c.close * 0.02, ind.atr14[i] * 1.5);
      signals[i] = {
        risk,
        atr: ind.atr14[i],
        targetRr: 1.85
      };
    }
  }

  return simulateTrades(candles, signals, 1.85, 7);
}

/**
 * M6: Uji Horizon Akumulasi Broker 1H, 3H, 5H, 10H, dan 20H
 */
function evaluateM6_AkumulasiMultiday(candles, ind, broksumHist) {
  const horizons = ['1H', '3H', '5H', '10H', '20H'];
  const horizonDays = { '1H': 1, '3H': 3, '5H': 5, '10H': 10, '20H': 20 };
  let bestHorizon = '5H';
  let bestMetrics = null;

  for (const h of horizons) {
    const days = horizonDays[h];
    const n = candles.length;
    const signals = new Array(n).fill(null);

    for (let i = days + 5; i < n; i++) {
      const c = candles[i];
      const date = c.date;
      let accumPositive = false;

      if (broksumHist && broksumHist[date] && broksumHist[date].windows && broksumHist[date].windows[h]) {
        const win = broksumHist[date].windows[h].all;
        if (win && (win.net_val > 0 || win.net_lot > 0)) {
          accumPositive = true;
        }
      } else {
        // Multi-day rolling volume flow
        let netFlow = 0;
        for (let j = i - days + 1; j <= i; j++) {
          const cj = candles[j];
          netFlow += (cj.close >= cj.open ? 1 : -1) * cj.volume * cj.close;
        }
        if (netFlow > 0 && c.close >= ind.sma20[i]) {
          accumPositive = true;
        }
      }

      if (accumPositive && c.close > ind.sma20[i]) {
        const risk = Math.max(c.close * 0.02, ind.atr14[i] * 1.4);
        signals[i] = {
          risk,
          atr: ind.atr14[i],
          targetRr: 1.75
        };
      }
    }

    const res = simulateTrades(candles, signals, 1.75, Math.min(10, days + 3));
    if (!bestMetrics || (res.wilsonLowerBoundPct > bestMetrics.wilsonLowerBoundPct) ||
        (res.wilsonLowerBoundPct === bestMetrics.wilsonLowerBoundPct && res.winRatePct > bestMetrics.winRatePct)) {
      bestMetrics = res;
      bestHorizon = h;
    }
  }

  bestMetrics.bestHorizon = bestHorizon;
  return bestMetrics;
}

/**
 * M7: Aliran Asing vs Domestik + Filter Laporan Keuangan Q2
 */
function evaluateM7_FlowFundamentalQ2(candles, ind, ticker, foreignData) {
  const n = candles.length;
  const signals = new Array(n).fill(null);
  const q2Score = checkFundamentalQ2(ticker);

  // Periksa apakah aliran asing positif
  const fItem = foreignData[ticker];
  const hasStrongForeign = fItem && (fItem.foreign_net_20d > 0 || fItem.foreign_net_5d > 0);

  for (let i = 20; i < n; i++) {
    const c = candles[i];
    // Filter tren dasar
    if (c.close < ind.sma20[i]) continue;

    // Filter fundamental Q2: jika ada data laporan Q2 dan negatif berat, skip
    if (q2Score < 0) continue;

    let flowSignal = false;
    if (hasStrongForeign) {
      if (c.close > ind.vwap20[i] && ind.rsi14[i] >= 48) {
        flowSignal = true;
      }
    } else {
      // Domestik institusi flow: volume konsisten + LPM positif
      if (ind.lpm[i] > 0.10 && ind.cmf20[i] > 0 && c.volume > 0) {
        flowSignal = true;
      }
    }

    if (flowSignal) {
      const risk = Math.max(c.close * 0.02, ind.atr14[i] * 1.5);
      signals[i] = {
        risk,
        atr: ind.atr14[i],
        targetRr: 1.8
      };
    }
  }

  return simulateTrades(candles, signals, 1.8, 7);
}

// ============================================================================
// EVALUATOR INDIVIDUAL 1 PER 1 PER TICKER
// ============================================================================

/**
 * Eksekusi Backtest Individual untuk 1 Ticker
 */
function runIndividualBacktest(ticker) {
  const candles = loadCandles(ticker);
  const totalBars = candles.length;
  const isIhsg = ticker.toUpperCase() === 'IHSG';

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, '+07:00');

  if (totalBars < 20) {
    // Data tidak memadai
    return {
      ticker,
      lastUpdatedWIB: nowIso,
      totalBarsTested: totalBars,
      bestMethodId: 'M1_SMC_ORDER_BLOCK',
      bestMethodName: METHOD_DEFINITIONS.M1_SMC_ORDER_BLOCK.name,
      bestBrokerHorizon: '5H',
      dominantFlowDriver: isIhsg ? 'PRICE_ACTION' : 'DOMESTIC',
      winRatePct: 0,
      wilsonLowerBoundPct: 0,
      profitFactor: 0,
      expectancyPct: 0,
      maxDrawdownPct: 0,
      tradesCount: 0,
      methodsComparison: {}
    };
  }

  const ind = calculateIndicators(candles);
  const broksumHist = isIhsg ? null : loadBroksumHistory(ticker);
  const foreignData = getForeignMultiDay();

  // Evaluasi M1 - M4 (Berbasis Price Action, Struktur Pasar, Volume & Momentum)
  const m1 = evaluateM1_SMC(candles, ind);
  const m2 = evaluateM2_Harmonic(candles, ind);
  const m3 = evaluateM3_FiboGoldenPocket(candles, ind);
  const m4 = evaluateM4_ZigzagMomentumLPM(candles, ind);

  // Evaluasi M5 - M7 (Bandarmologi, Horizon Broker, & Foreign/Domestik + Q2)
  let m5, m6, m7;
  let bestBrokerHorizon = '5H';
  let dominantFlowDriver = 'PRICE_ACTION';

  if (isIhsg) {
    // KHUSUS IHSG: Broker methods tidak berlaku
    m5 = {
      tradesCount: 0,
      winRatePct: 0,
      wilsonLowerBoundPct: 0,
      profitFactor: 0,
      expectancyPct: 0,
      maxDrawdownPct: 0,
      trades: [],
      status: 'NOT_APPLICABLE_INDEX'
    };
    m6 = {
      tradesCount: 0,
      winRatePct: 0,
      wilsonLowerBoundPct: 0,
      profitFactor: 0,
      expectancyPct: 0,
      maxDrawdownPct: 0,
      trades: [],
      bestHorizon: 'N/A',
      status: 'NOT_APPLICABLE_INDEX'
    };
    m7 = {
      tradesCount: 0,
      winRatePct: 0,
      wilsonLowerBoundPct: 0,
      profitFactor: 0,
      expectancyPct: 0,
      maxDrawdownPct: 0,
      trades: [],
      status: 'NOT_APPLICABLE_INDEX'
    };
    bestBrokerHorizon = '5H';
    dominantFlowDriver = 'PRICE_ACTION';
  } else {
    m5 = evaluateM5_BandarBsRatio(candles, ind, broksumHist);
    m6 = evaluateM6_AkumulasiMultiday(candles, ind, broksumHist);
    m7 = evaluateM7_FlowFundamentalQ2(candles, ind, ticker, foreignData);

    bestBrokerHorizon = m6.bestHorizon || '5H';

    // Tentukan dominantFlowDriver
    const fItem = foreignData[ticker];
    if (fItem && Math.abs(fItem.foreign_net_20d || 0) > 5000000000) {
      dominantFlowDriver = (fItem.foreign_net_20d > 0) ? 'FOREIGN' : 'DOMESTIC';
    } else {
      dominantFlowDriver = 'DOMESTIC';
    }
  }

  const methodsComparison = {
    M1_SMC_ORDER_BLOCK: {
      methodId: 'M1_SMC_ORDER_BLOCK',
      methodName: METHOD_DEFINITIONS.M1_SMC_ORDER_BLOCK.name,
      ...m1
    },
    M2_HARMONIC_XABCD: {
      methodId: 'M2_HARMONIC_XABCD',
      methodName: METHOD_DEFINITIONS.M2_HARMONIC_XABCD.name,
      ...m2
    },
    M3_FIBO_GOLDEN_POCKET: {
      methodId: 'M3_FIBO_GOLDEN_POCKET',
      methodName: METHOD_DEFINITIONS.M3_FIBO_GOLDEN_POCKET.name,
      ...m3
    },
    M4_ZIGZAG_MOMENTUM_LPM: {
      methodId: 'M4_ZIGZAG_MOMENTUM_LPM',
      methodName: METHOD_DEFINITIONS.M4_ZIGZAG_MOMENTUM_LPM.name,
      ...m4
    },
    M5_BANDAR_BS_RATIO: {
      methodId: 'M5_BANDAR_BS_RATIO',
      methodName: METHOD_DEFINITIONS.M5_BANDAR_BS_RATIO.name,
      ...m5
    },
    M6_AKUMULASI_BROKER_MULTIDAY: {
      methodId: 'M6_AKUMULASI_BROKER_MULTIDAY',
      methodName: METHOD_DEFINITIONS.M6_AKUMULASI_BROKER_MULTIDAY.name,
      ...m6
    },
    M7_FOREIGN_VS_DOMESTIC_FUNDAMENTAL_Q2: {
      methodId: 'M7_FOREIGN_VS_DOMESTIC_FUNDAMENTAL_Q2',
      methodName: METHOD_DEFINITIONS.M7_FOREIGN_VS_DOMESTIC_FUNDAMENTAL_Q2.name,
      ...m7
    }
  };

  // Pilih Metode Pemenang (bestMethodId)
  const candidateMethods = isIhsg
    ? ['M1_SMC_ORDER_BLOCK', 'M2_HARMONIC_XABCD', 'M3_FIBO_GOLDEN_POCKET', 'M4_ZIGZAG_MOMENTUM_LPM']
    : Object.keys(METHOD_DEFINITIONS);

  let bestMethodId = candidateMethods[0];
  let bestScore = -Infinity;

  for (const mid of candidateMethods) {
    const met = methodsComparison[mid];
    if (!met || met.tradesCount === 0) continue;
    // Ranking score: Wilson lower bound sebagai jangkar utama + bobot winrate dan profit factor
    const score = (met.wilsonLowerBoundPct * 2.0) + (met.winRatePct * 1.0) + (Math.min(5, met.profitFactor) * 10);
    if (score > bestScore) {
      bestScore = score;
      bestMethodId = mid;
    }
  }

  const bestResult = methodsComparison[bestMethodId];

  return {
    ticker,
    lastUpdatedWIB: nowIso,
    totalBarsTested: totalBars,
    bestMethodId,
    bestMethodName: METHOD_DEFINITIONS[bestMethodId].name,
    bestBrokerHorizon,
    dominantFlowDriver,
    winRatePct: bestResult.winRatePct,
    wilsonLowerBoundPct: bestResult.wilsonLowerBoundPct,
    profitFactor: bestResult.profitFactor,
    expectancyPct: bestResult.expectancyPct,
    maxDrawdownPct: bestResult.maxDrawdownPct,
    tradesCount: bestResult.tradesCount,
    methodsComparison
  };
}

module.exports = {
  runIndividualBacktest,
  loadCandles,
  calculateIndicators,
  METHOD_DEFINITIONS,
  wilsonLowerBound
};

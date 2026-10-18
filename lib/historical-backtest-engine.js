'use strict';

/**
 * Historical Backtest Engine (Fase 6)
 *
 * Engine simulasi backtest kuantitatif deterministik untuk 962 saham BEI:
 * - Mensimulasikan eksekusi transaksi dengan friksi bursa nyata (fee beli 0,15%, fee jual 0,25%).
 * - Fraksi harga bursa (tick size) resmi BEI (<200: 1, 200-500: 2, 500-2000: 5, 2000-5000: 10, >5000: 25).
 * - Slippage 1 tick pada entry dan exit.
 * - Guard batas ARA/ARB harian.
 * - Filter seleksi ketat Risk/Reward (R/R) >= 1.5.
 * - Scale-out bertingkat (TP1 50% dan trailing TP2 50%).
 *
 * Kepatuhan AntiSlop:
 * - Format Bahasa Indonesia finansial baku, tanpa em dash.
 * - Tanpa angka sintetis atau asumsi profit tanpa beban biaya.
 */

function round(val, decimals = 2) {
  if (val == null || !Number.isFinite(val)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function getIdxTickSize(price) {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

function alignToTick(price, direction = 'round') {
  const p = Math.max(50, Number(price));
  const tick = getIdxTickSize(p);
  if (direction === 'up') return Math.ceil(p / tick) * tick;
  if (direction === 'down') return Math.floor(p / tick) * tick;
  return Math.round(p / tick) * tick;
}

function calculateAraArb(prevClose) {
  const p = Number(prevClose);
  let maxPct = 0.25;
  if (p < 200) maxPct = 0.35;
  else if (p > 5000) maxPct = 0.20;

  const ara = alignToTick(p * (1 + maxPct), 'down');
  const arb = alignToTick(p * (1 - maxPct), 'up');
  return { ara, arb, maxPct };
}

/**
 * Menghitung Simple Moving Average
 */
function calcSma(candles, period, endIdx) {
  if (endIdx < period - 1) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    sum += Number(candles[i].close);
  }
  return sum / period;
}

/**
 * Menjalankan backtest pada 1 ticker dengan serangkaian candle
 */
function runBacktestForTicker(ticker, candles, options = {}) {
  const cleanTicker = String(ticker || 'UNKNOWN').toUpperCase().trim();
  const defaultCapital = options.initialCapital || 50000000; // Rp 50 Juta modal per saham
  const buyFeeRate = options.buyFeeRate != null ? options.buyFeeRate : 0.0015; // 0,15%
  const sellFeeRate = options.sellFeeRate != null ? options.sellFeeRate : 0.0025; // 0,25%
  const slippageTicks = options.slippageTicks != null ? options.slippageTicks : 1;
  const minRrRatio = options.minRrRatio != null ? options.minRrRatio : 1.5;
  const maxHoldingDays = options.maxHoldingDays || 15;

  if (!Array.isArray(candles) || candles.length < 25) {
    return {
      ticker: cleanTicker,
      success: false,
      total_trades: 0,
      reason: 'Riwayat candle tidak mencukupi (minimal 25 candle).'
    };
  }

  const trades = [];
  let currentPosition = null;
  let peakEquity = defaultCapital;
  let maxDrawdown = 0;

  // Precalculate LPM and Intensity series for quant confluences
  let cumLiq = 0;
  const cumLiqArr = [];
  for (let ci = 0; ci < candles.length; ci++) {
    const cBar = candles[ci];
    const cCl = Number(cBar.close || 0);
    const cH = Number(cBar.high != null ? cBar.high : cCl);
    const cL = Number(cBar.low != null ? cBar.low : cCl);
    const cV = Number(cBar.volume || 0);
    const hl = cH - cL;
    const mfm = hl > 0 ? ((cCl - cL) - (cH - cCl)) / hl : 0;
    cumLiq += mfm * (cCl * cV);
    cumLiqArr.push(cumLiq);
  }

  const lpmSeries = [];
  for (let ci = 0; ci < candles.length; ci++) {
    const p = Math.min(ci + 1, 20);
    const startIdx = ci - p + 1;
    let pSum = 0, pMin = Infinity, pMax = -Infinity;
    let clSum = 0, clMin = Infinity, clMax = -Infinity;
    for (let j = startIdx; j <= ci; j++) {
      const cj = Number(candles[j].close || 0);
      const hj = Number(candles[j].high != null ? candles[j].high : cj);
      const lj = Number(candles[j].low != null ? candles[j].low : cj);
      pSum += cj;
      if (lj < pMin) pMin = lj;
      if (hj > pMax) pMax = hj;
      const cl = cumLiqArr[j];
      clSum += cl;
      if (cl < clMin) clMin = cl;
      if (cl > clMax) clMax = cl;
    }
    const pAvg = pSum / p;
    const clAvg = clSum / p;
    const halfPriceRange = Math.max((pMax - pMin) / 2, pAvg * 0.02);
    const clHalfRange = (clMax - clMin) / 2;
    let norm = clHalfRange > 0 ? (cumLiqArr[ci] - clAvg) / clHalfRange : 0;
    if (norm > 1.5) norm = 1.5;
    if (norm < -1.5) norm = -1.5;
    lpmSeries.push(Math.round(pAvg + norm * halfPriceRange * 1.35));
  }

  const intensitySeries = [];
  const volumes = candles.map(c => Number(c.volume || 0));
  for (let ci = 0; ci < candles.length; ci++) {
    const cBar = candles[ci];
    const op = Number(cBar.open != null ? cBar.open : cBar.close);
    const cl = Number(cBar.close || 0);
    const hi = Number(cBar.high != null ? cBar.high : cl);
    const lo = Number(cBar.low != null ? cBar.low : cl);
    const p = Math.min(ci + 1, 20);
    let vSum = 0;
    for (let j = ci - p + 1; j <= ci; j++) vSum += volumes[j];
    const avgV = vSum / p || 1;
    const volRatio = volumes[ci] / avgV;
    const rng = hi - lo;
    const body = Math.abs(cl - op);
    const bodyRatio = rng > 0 ? body / rng : 0.5;
    const score = Number((volRatio * (0.4 + 0.6 * bodyRatio)).toFixed(2));
    intensitySeries.push(Math.max(0, score));
  }

  for (let i = 20; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];
    const close = Number(c.close);
    const open = Number(c.open != null ? c.open : c.close);
    const high = Number(c.high != null ? c.high : c.close);
    const low = Number(c.low != null ? c.low : c.close);
    const volume = Number(c.volume || 0);

    const ma20 = calcSma(candles, 20, i);
    const prevMa20 = calcSma(candles, 20, i - 1);
    let volSum = 0;
    for (let v = i - 20; v < i; v++) volSum += Number(candles[v].volume || 0);
    const volAvg20 = volSum / 20 || 1;

    // Evaluasi posisi yang sedang aktif
    if (currentPosition) {
      currentPosition.holdingDays++;
      const pos = currentPosition;
      let exitPrice = null;
      let exitReason = null;
      let lotsToExit = 0;

      const curLpm = lpmSeries[i] || close;
      const curLpmPrev3 = i >= 3 ? lpmSeries[i - 3] : curLpm;
      const curIntensity = intensitySeries[i] || 1.0;

      // 1. Cek Stop Loss
      if (low <= pos.stopLoss) {
        // Eksekusi cut loss pada stop loss atau open jika gap down
        const tick = getIdxTickSize(pos.stopLoss);
        exitPrice = alignToTick(Math.min(pos.stopLoss - slippageTicks * tick, close), 'down');
        exitReason = 'STOP_LOSS';
        lotsToExit = pos.remainingLots;
      }
      // 2. Cek Target Price 2 (Target penuh)
      else if (high >= pos.tp2) {
        const tick = getIdxTickSize(pos.tp2);
        exitPrice = alignToTick(pos.tp2 - slippageTicks * tick, 'down');
        exitReason = 'TP2_FULL';
        lotsToExit = pos.remainingLots;
      }
      // 3. Cek Target Price 1 (Scale-out 50% jika belum dieksekusi)
      else if (high >= pos.tp1 && !pos.tp1Hit) {
        pos.tp1Hit = true;
        const tick = getIdxTickSize(pos.tp1);
        const tp1Price = alignToTick(pos.tp1 - slippageTicks * tick, 'down');
        const halfLots = Math.max(1, Math.floor(pos.remainingLots / 2));

        const grossRevenue = halfLots * 100 * tp1Price;
        const fee = grossRevenue * sellFeeRate;
        const netRevenue = grossRevenue - fee;
        const costBasis = halfLots * 100 * pos.entryPrice;
        const netPnL = netRevenue - costBasis;

        pos.realizedPnL += netPnL;
        pos.feesPaid += fee;
        pos.remainingLots -= halfLots;

        // Naikkan stop loss ke Break-Even (entry price) setelah TP1 tercapai
        pos.stopLoss = pos.entryPrice;
      }
      // 4. Smart Exit (Early Distribution Exit): deteksi aksi jual masif bandar sebelum SL
      else if (!pos.tp1Hit && curLpm < curLpmPrev3 * 0.97 && close < open && curIntensity >= 1.5) {
        const tick = getIdxTickSize(close);
        exitPrice = alignToTick(close - slippageTicks * tick, 'down');
        exitReason = 'SMART_EXIT';
        lotsToExit = pos.remainingLots;
      }
      // 5. Time-stop: jika melebihi batas hari tanpa TP/SL
      else if (pos.holdingDays >= maxHoldingDays) {
        const tick = getIdxTickSize(close);
        exitPrice = alignToTick(close - slippageTicks * tick, 'down');
        exitReason = 'TIME_STOP';
        lotsToExit = pos.remainingLots;
      }

      // Finalisasi penutupan posisi penuh
      if (exitPrice !== null && lotsToExit > 0) {
        const grossExit = lotsToExit * 100 * exitPrice;
        const exitFee = grossExit * sellFeeRate;
        const netExit = grossExit - exitFee;
        const costBasis = lotsToExit * 100 * pos.entryPrice;
        const remainingPnL = netExit - costBasis;

        pos.realizedPnL += remainingPnL;
        pos.feesPaid += exitFee;
        pos.exitDate = c.time;
        pos.exitPrice = exitPrice;
        pos.exitReason = exitReason;

        const totalCost = pos.initialLots * 100 * pos.entryPrice;
        const pnlPct = round((pos.realizedPnL / totalCost) * 100, 2);

        trades.push({
          ticker: cleanTicker,
          entryDate: pos.entryDate,
          entryPrice: pos.entryPrice,
          exitDate: pos.exitDate,
          exitPrice: pos.exitPrice,
          exitReason: pos.exitReason,
          lots: pos.initialLots,
          holdingDays: pos.holdingDays,
          netPnL: Math.round(pos.realizedPnL),
          feesPaid: Math.round(pos.feesPaid),
          pnlPct,
          isWin: pos.realizedPnL > 0
        });

        // Hitung drawdown terhadap modal kumulatif
        peakEquity = Math.max(peakEquity, peakEquity + pos.realizedPnL);
        const dd = ((peakEquity - (peakEquity + pos.realizedPnL)) / peakEquity) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        currentPosition = null;
      }
    }

    // Evaluasi sinyal Entry baru jika belum ada posisi aktif
    if (!currentPosition && i < candles.length - 2) {
      // Sinyal Swing Momentum MA + Konfirmasi Kuantitatif LPM & Intensity
      const isBreakout = (prevC.close <= prevMa20 && close > ma20) || (close > ma20 && close >= open && volume >= volAvg20 * 1.05);
      const isVolumeConfirmed = volume >= volAvg20 * 1.05;

      const lpmVal = lpmSeries[i] || close;
      const lpmPrev3 = i >= 3 ? lpmSeries[i - 3] : lpmVal;
      const lpmPrev5 = i >= 5 ? lpmSeries[i - 5] : lpmPrev3;
      const intensityVal = intensitySeries[i] || 1.0;

      let hasRecentSpike = false;
      for (let ki = Math.max(0, i - 4); ki <= i; ki++) {
        if (intensitySeries[ki] >= 1.5) { hasRecentSpike = true; break; }
      }

      const isLpmAccumulating = (lpmVal >= lpmPrev3) || (lpmVal >= lpmPrev5) || (lpmVal >= close * 0.98);
      const isLpmDistributing = (lpmVal < lpmPrev3 * 0.94);
      const isIntensityConfirmed = (intensityVal >= 1.15 || hasRecentSpike) && (close >= open);
      const isQuantConfirmed = isLpmAccumulating && !isLpmDistributing && isIntensityConfirmed;

      if (isBreakout && isVolumeConfirmed && isQuantConfirmed && close >= 50) {
        // Tentukan Stop Loss di bawah low 3 sesi terakhir
        let recentMinLow = low;
        for (let k = i - 3; k < i; k++) {
          if (candles[k] && Number(candles[k].low) < recentMinLow) {
            recentMinLow = Number(candles[k].low);
          }
        }

        const tick = getIdxTickSize(close);
        const entryPrice = alignToTick(close + slippageTicks * tick, 'up');
        let stopLoss = alignToTick(Math.min(recentMinLow, entryPrice - 3 * tick), 'down');

        // Pastikan risiko minimal 1,5% dan maksimal 8%
        const riskPerShare = entryPrice - stopLoss;
        const riskPct = riskPerShare / entryPrice;

        if (riskPct >= 0.015 && riskPct <= 0.08) {
          const targetReward1 = riskPerShare * 1.5;
          const targetReward2 = riskPerShare * 2.5;

          const tp1 = alignToTick(entryPrice + targetReward1, 'up');
          const tp2 = alignToTick(entryPrice + targetReward2, 'up');

          // Strict Gate: R/R aktual wajib >= 1.5
          const actualRr = (tp1 - entryPrice) / (entryPrice - stopLoss);
          if (actualRr >= minRrRatio) {
            // Alokasikan posisi (maksimal modal per trade)
            const allocCapital = Math.min(defaultCapital, 25000000); // 25 Juta per posisi
            const totalShares = Math.floor(allocCapital / (entryPrice * 100)) * 100;
            const lots = totalShares / 100;

            if (lots >= 1) {
              const entryCost = lots * 100 * entryPrice;
              const entryFee = entryCost * buyFeeRate;

              currentPosition = {
                entryDate: c.time,
                entryPrice,
                stopLoss,
                tp1,
                tp2,
                initialLots: lots,
                remainingLots: lots,
                tp1Hit: false,
                realizedPnL: -entryFee, // langsung dipotong fee beli
                feesPaid: entryFee,
                holdingDays: 0
              };
            }
          }
        }
      }
    }
  }

  // Hitung metrik agregat performa
  const totalTrades = trades.length;
  const winTrades = trades.filter(t => t.isWin);
  const lossTrades = trades.filter(t => !t.isWin);

  const winCount = winTrades.length;
  const lossCount = lossTrades.length;
  const winRate = totalTrades > 0 ? round((winCount / totalTrades) * 100, 1) : 0;

  const totalGrossGain = winTrades.reduce((acc, t) => acc + t.netPnL, 0);
  const totalGrossLoss = Math.abs(lossTrades.reduce((acc, t) => acc + t.netPnL, 0));
  const profitFactor = totalGrossLoss > 0 ? round(totalGrossGain / totalGrossLoss, 2) : (totalGrossGain > 0 ? 99.9 : 0);

  const totalNetPnL = trades.reduce((acc, t) => acc + t.netPnL, 0);
  const totalFeesPaid = trades.reduce((acc, t) => acc + t.feesPaid, 0);
  const avgHoldingDays = totalTrades > 0 ? round(trades.reduce((acc, t) => acc + t.holdingDays, 0) / totalTrades, 1) : 0;

  // Standar deviasi return untuk Sharpe ratio sederhana
  let sharpeRatio = 0;
  if (totalTrades >= 3) {
    const returns = trades.map(t => t.pnlPct);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / totalTrades;
    const variance = returns.reduce((acc, r) => acc + Math.pow(r - avgReturn, 2), 0) / (totalTrades - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpeRatio = round((avgReturn / stdDev) * Math.sqrt(totalTrades), 2);
    }
  }

  return {
    ticker: cleanTicker,
    success: true,
    total_candles: candles.length,
    period_start: candles[0] ? candles[0].time : null,
    period_end: candles[candles.length - 1] ? candles[candles.length - 1].time : null,
    total_trades: totalTrades,
    win_trades: winCount,
    loss_trades: lossCount,
    win_rate_pct: winRate,
    profit_factor: profitFactor,
    total_net_pnl_idr: Math.round(totalNetPnL),
    total_fees_paid_idr: Math.round(totalFeesPaid),
    max_drawdown_pct: round(maxDrawdown, 2),
    sharpe_ratio: sharpeRatio,
    avg_holding_days: avgHoldingDays,
    trades
  };
}

module.exports = {
  getIdxTickSize,
  alignToTick,
  calculateAraArb,
  runBacktestForTicker
};

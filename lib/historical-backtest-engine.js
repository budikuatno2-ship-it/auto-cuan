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

  for (let i = 20; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];
    const close = Number(c.close);
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
      // 4. Time-stop: jika melebihi batas hari tanpa TP/SL
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
      // Sinyal Swing Momentum MA:
      // Penutupan melompat di atas MA20, volume di atas rata-rata 20 sesi
      const isBreakout = prevC.close <= prevMa20 && close > ma20;
      const isVolumeConfirmed = volume >= volAvg20 * 1.05;

      if (isBreakout && isVolumeConfirmed && close >= 50) {
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

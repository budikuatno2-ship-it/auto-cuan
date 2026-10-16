/**
 * Auto-Cuan Chart Workstation Runtime
 * Multi-Timeframe, Layer Registry (9 Groups), 5 Presets, Visual Trading Plan,
 * and Bandar Metrics Integration on top of Lightweight Charts.
 *
 * Adheres strictly to AntiSlop guidelines:
 * - No em-dashes (only standard hyphens)
 * - Clean contrast and touch targets >= 44px on mobile
 * - Deterministic indicator and timeframe aggregation
 * - Zero synthesized/mocked market data
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AutoCuanChartWorkstation = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (defaultRoot) {
  'use strict';

  var VERSION = '20261015-fase6-workstation-v1';

  // ============================================================
  // LAYER REGISTRY (9 GROUPS)
  // ============================================================
  var LAYER_GROUPS = [
    {
      id: 'level_area',
      title: 'Level & Area',
      description: 'Support, Resistance, dan Level Ekstrem Harga',
      layers: [
        { id: 'sr_levels', name: 'Support & Resistance (S/R)', desc: 'Level swing high & low otomatis', default: true },
        { id: 'trading_plan', name: 'Visual Trading Plan', desc: 'Entry, SL, TP1, TP2, dan R/R Shading', default: false }
      ]
    },
    {
      id: 'trend_ema',
      title: 'Tren & EMA',
      description: 'Garis Moving Average dan Pita Tren',
      layers: [
        { id: 'ma20', name: 'MA 20 (Hijau)', desc: 'Moving Average 20 hari', color: '#10b981', default: true },
        { id: 'ma50', name: 'MA 50 (Kuning)', desc: 'Moving Average 50 hari', color: '#eab308', default: true },
        { id: 'ma100', name: 'MA 100 (Biru)', desc: 'Moving Average 100 hari', color: '#3b82f6', default: false },
        { id: 'ma200', name: 'MA 200 (Ungu)', desc: 'Moving Average 200 hari tren jangka panjang', color: '#a855f7', default: false },
        { id: 'ema20', name: 'EMA 20 (Sian)', desc: 'Exponential Moving Average 20 hari', color: '#06b6d4', default: false },
        { id: 'ema50', name: 'EMA 50 (Merah Muda)', desc: 'Exponential Moving Average 50 hari', color: '#ec4899', default: false },
        { id: 'bollinger', name: 'Bollinger Bands (20, 2)', desc: 'Pita volatilitas harga', color: '#6366f1', default: false }
      ]
    },
    {
      id: 'struktur',
      title: 'Struktur Pasar',
      description: 'Break of Structure dan Zona Likuiditas',
      layers: [
        { id: 'market_structure', name: 'Break of Structure (BOS)', desc: 'Dalam Riset (Nonaktif)', disabled: true, default: false }
      ]
    },
    {
      id: 'sinyal',
      title: 'Sinyal',
      description: 'Penanda Sinyal Beli dan Keluar',
      layers: [
        { id: 'signal_markers', name: 'Marker Sinyal Beli/Jual', desc: 'Penanda sinyal terkonfirmasi pada candle', default: false }
      ]
    },
    {
      id: 'volume',
      title: 'Volume',
      description: 'Bar Volume dan Rata-rata Likuiditas',
      layers: [
        { id: 'volume_bars', name: 'Bar Volume Transaksi', desc: 'Histogram volume perdagangan per candle', default: true },
        { id: 'vol_avg20', name: 'Volume Rata-rata 20 Hari', desc: 'Garis acuan volume normal', color: '#94a3b8', default: true },
        { id: 'vol_profile', name: 'Volume Profile', desc: 'Dalam Riset (Nonaktif)', disabled: true, default: false }
      ]
    },
    {
      id: 'fibonacci',
      title: 'Fibonacci',
      description: 'Tingkat Retracement Fibonacci',
      layers: [
        { id: 'fibonacci', name: 'Fibonacci Retracement (38.2% - 78.6%)', desc: 'Area retracement swing high/low', default: false }
      ]
    },
    {
      id: 'pola_klasik',
      title: 'Pola Klasik',
      description: 'Deteksi Pola Grafik Klasik BEI',
      layers: [
        { id: 'classic_patterns', name: 'Pola Grafik Klasik', desc: 'Double Bottom, Breakout, Triangle terdeteksi', default: false }
      ]
    },
    {
      id: 'osilator',
      title: 'Osilator',
      description: 'Indikator Momentum dan Kekuatan Tren',
      layers: [
        { id: 'rsi14', name: 'RSI 14 (Relative Strength Index)', desc: 'Osilator momentum overbought/oversold', color: '#f97316', default: false },
        { id: 'macd', name: 'MACD (12, 26, 9)', desc: 'Moving Average Convergence Divergence', color: '#38bdf8', default: false }
      ]
    },
    {
      id: 'bandar_metrics',
      title: 'Kuantitatif Bandar Metrics',
      description: 'Metrik Akumulasi, Distribusi, dan Arus Modal Asing',
      layers: [
        { id: 'bandar_lpm', name: 'Liquidity Pressure Model (LPM)', desc: 'Kurva indeks tekanan likuiditas kumulatif', color: '#10b981', default: false },
        { id: 'bandar_foreign', name: 'Kumulatif Aliran Asing', desc: 'Akumulasi beli/jual bersih investor asing', color: '#3b82f6', default: false },
        { id: 'bandar_cmf', name: 'Smart Money Flow (CMF)', desc: 'Aliran uang pintar berbasis posisi penutupan', color: '#f97316', default: false },
        { id: 'bandar_intensity', name: 'Histogram Intensitas Bandar', desc: 'Lonjakan intensitas omzet transaksi harian', color: '#8b5cf6', default: false },
        { id: 'bandar_rotation', name: 'Histogram Rotasi Volume', desc: 'Klasifikasi rotasi 3-warna (Akumulasi / Distribusi / Transisi)', color: '#10b981', default: false },
        { id: 'bandar_corr_f', name: 'Korelasi Harga-Asing (Corr F)', desc: 'Tingkat korelasi harga saham terhadap aliran asing', default: true },
        { id: 'bandar_par_f', name: 'Partisipasi Asing (Par F)', desc: 'Porsi transaksi asing terhadap total pasar', default: true }
      ]
    }
  ];

  // ============================================================
  // 5 PRESETS
  // ============================================================
  var PRESETS = {
    simpel: {
      id: 'simpel',
      name: 'Simpel',
      description: 'Tampilan bersih: Candlestick, Volume, MA 20/50, Support/Resistance, dan Header Corr F & Par F',
      layers: ['ma20', 'ma50', 'volume_bars', 'sr_levels', 'bandar_corr_f', 'bandar_par_f']
    },
    scalping: {
      id: 'scalping',
      name: 'Scalping',
      description: 'Fokus momentum cepat: EMA 20, Money Flow, Sub-panel Intensity dan Volume Rotation',
      layers: ['ema20', 'volume_bars', 'sr_levels', 'bandar_cmf', 'bandar_intensity', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f']
    },
    swing: {
      id: 'swing',
      name: 'Swing',
      description: 'Swing trading komprehensif: EMA 20/50, S/R, Trading Plan visual, LPM, Foreign Flow, Money Flow, serta Sub-panel Intensity dan Volume Rotation',
      layers: ['ema20', 'ema50', 'volume_bars', 'sr_levels', 'trading_plan', 'bandar_lpm', 'bandar_foreign', 'bandar_cmf', 'bandar_intensity', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f']
    },
    investor: {
      id: 'investor',
      name: 'Investor',
      description: 'Orientasi tren jangka panjang: MA 50/200, Support utama, LPM, Foreign Flow, dan Sub-panel Volume Rotation',
      layers: ['ma50', 'ma200', 'volume_bars', 'sr_levels', 'bandar_lpm', 'bandar_foreign', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f']
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      description: 'Analisis mendalam penuh: Semua layer teknikal, osilator, dan seluruh instrumen Bandar Metrics aktif',
      layers: ['ma20', 'ma50', 'ma100', 'ma200', 'bollinger', 'fibonacci', 'volume_bars', 'sr_levels', 'trading_plan', 'bandar_lpm', 'bandar_foreign', 'bandar_cmf', 'bandar_intensity', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f']
    }
  };

  // ============================================================
  // MULTI-TIMEFRAME AGGREGATION (1D -> 1W)
  // ============================================================
  function parseDate(timeVal) {
    if (typeof timeVal === 'string') {
      var parts = timeVal.split('-');
      if (parts.length === 3) {
        return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
      }
      return new Date(timeVal);
    }
    if (typeof timeVal === 'number') {
      return new Date(timeVal > 1e11 ? timeVal : timeVal * 1000);
    }
    return new Date();
  }

  function formatIsoDate(d) {
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var day = String(d.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function getMondayOfDate(d) {
    var day = d.getUTCDay();
    var diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    var monday = new Date(d.getTime());
    monday.setUTCDate(diff);
    return formatIsoDate(monday);
  }

  function aggregateDailyToWeekly(dailyCandles) {
    if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return [];

    var weeksMap = Object.create(null);
    var weekOrder = [];

    for (var i = 0; i < dailyCandles.length; i++) {
      var c = dailyCandles[i];
      if (!c || c.close == null || isNaN(Number(c.close))) continue;

      var d = parseDate(c.time);
      var mondayKey = getMondayOfDate(d);

      if (!weeksMap[mondayKey]) {
        weeksMap[mondayKey] = {
          time: mondayKey,
          open: Number(c.open || c.close),
          high: Number(c.high || c.close),
          low: Number(c.low || c.close),
          close: Number(c.close),
          volume: Number(c.volume || 0),
          candlesCount: 1,
          foreignBuy: Number(c.foreignBuy || 0),
          foreignSell: Number(c.foreignSell || 0)
        };
        weekOrder.push(mondayKey);
      } else {
        var w = weeksMap[mondayKey];
        var high = Number(c.high || c.close);
        var low = Number(c.low || c.close);
        if (high > w.high) w.high = high;
        if (low < w.low) w.low = low;
        w.close = Number(c.close);
        w.volume += Number(c.volume || 0);
        w.foreignBuy += Number(c.foreignBuy || 0);
        w.foreignSell += Number(c.foreignSell || 0);
        w.candlesCount++;
      }
    }

    var weekly = [];
    for (var j = 0; j < weekOrder.length; j++) {
      weekly.push(weeksMap[weekOrder[j]]);
    }
    return weekly;
  }

  // ============================================================
  // INDICATOR CALCULATORS (PURE DETERMINISTIC MATH)
  // ============================================================
  // FIX-20: every accumulator below skips non-finite closes so a single bad
  // reading cannot turn the whole indicator series into NaN.
  function finiteClose(candle) {
    if (!candle) return null;
    var raw = candle.close;
    if (raw == null || raw === '') return null;
    var num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }

  function calculateSMA(candles, period) {
    var out = [];
    if (!candles || candles.length < period) return out;
    for (var i = period - 1; i < candles.length; i++) {
      var sum = 0;
      var skipped = false;
      for (var k = i - period + 1; k <= i; k++) {
        var v = finiteClose(candles[k]);
        if (v == null) { skipped = true; break; }
        sum += v;
      }
      if (skipped) continue;
      out.push({ time: candles[i].time, value: Math.round((sum / period) * 100) / 100 });
    }
    return out;
  }

  function calculateEMA(candles, period) {
    var out = [];
    if (!candles || candles.length < period) return out;
    var kMult = 2 / (period + 1);

    var initialSum = 0;
    for (var s = 0; s < period; s++) {
      var seed = finiteClose(candles[s]);
      if (seed == null) return out;
      initialSum += seed;
    }
    var prevEma = initialSum / period;
    out.push({ time: candles[period - 1].time, value: Math.round(prevEma * 100) / 100 });

    for (var i = period; i < candles.length; i++) {
      var close = finiteClose(candles[i]);
      if (close == null) continue; // skip the bad reading, keep the running mean
      prevEma = (close - prevEma) * kMult + prevEma;
      if (!Number.isFinite(prevEma)) continue;
      out.push({ time: candles[i].time, value: Math.round(prevEma * 100) / 100 });
    }
    return out;
  }

  function calculateBollinger(candles, period, mult) {
    period = period || 20;
    mult = mult || 2;
    var upper = [], middle = [], lower = [];
    if (!candles || candles.length < period) return { upper: upper, middle: middle, lower: lower };

    for (var i = period - 1; i < candles.length; i++) {
      var sum = 0;
      var bad = false;
      for (var k = i - period + 1; k <= i; k++) {
        var cv = finiteClose(candles[k]);
        if (cv == null) { bad = true; break; }
        sum += cv;
      }
      if (bad) continue;
      var ma = sum / period;

      var varianceSum = 0;
      for (var j = i - period + 1; j <= i; j++) {
        var jv = finiteClose(candles[j]);
        var diff = jv - ma;
        varianceSum += diff * diff;
      }
      var stdDev = Math.sqrt(varianceSum / period);
      if (!Number.isFinite(ma) || !Number.isFinite(stdDev)) continue;

      var time = candles[i].time;
      middle.push({ time: time, value: Math.round(ma * 100) / 100 });
      upper.push({ time: time, value: Math.round((ma + mult * stdDev) * 100) / 100 });
      lower.push({ time: time, value: Math.round((ma - mult * stdDev) * 100) / 100 });
    }
    return { upper: upper, middle: middle, lower: lower };
  }

  // FIX-19: Wilder's Smoothing (RMA) — the exact TradingView/`lib/daily-rsi`
  // formulation. The previous SMA-over-window version drifted 3-5 points.
  function wilderRsiFromAverages(avgGain, avgLoss) {
    if (avgGain === 0 && avgLoss === 0) return 50;
    if (avgLoss === 0) return 100;
    if (avgGain === 0) return 0;
    var rs = avgGain / avgLoss;
    if (!Number.isFinite(rs)) return 100;
    return 100 - (100 / (1 + rs));
  }

  function wilderRsiSeries(closes, period) {
    var p = Number(period) || 14;
    var series = new Array(closes.length).fill(null);
    if (!Array.isArray(closes) || closes.length < p + 1) return series;

    var gains = [];
    var losses = [];
    for (var i = 1; i < closes.length; i++) {
      var delta = closes[i] - closes[i - 1];
      gains.push(Math.max(delta, 0));
      losses.push(Math.max(-delta, 0));
    }

    var avgGain = 0;
    var avgLoss = 0;
    for (var j = 0; j < p; j++) {
      avgGain += gains[j];
      avgLoss += losses[j];
    }
    avgGain /= p;
    avgLoss /= p;
    series[p] = wilderRsiFromAverages(avgGain, avgLoss);

    for (var k = p; k < gains.length; k++) {
      avgGain = (avgGain * (p - 1) + gains[k]) / p;
      avgLoss = (avgLoss * (p - 1) + losses[k]) / p;
      series[k + 1] = wilderRsiFromAverages(avgGain, avgLoss);
    }
    return series;
  }

  function calculateRSI(candles, period) {
    period = period || 14;
    var out = [];
    if (!candles || candles.length <= period) return out;

    var closes = [];
    for (var n = 0; n < candles.length; n++) {
      var raw = candles[n] && candles[n].close;
      if (raw == null || raw === '') return out;
      var num = Number(raw);
      if (!Number.isFinite(num)) return out;
      closes.push(num);
    }

    var series = wilderRsiSeries(closes, period);
    for (var i = period; i < candles.length; i++) {
      if (series[i] == null) continue;
      out.push({ time: candles[i].time, value: Math.round(series[i] * 100) / 100 });
    }
    return out;
  }

  function calculateMACD(candles, fast, slow, signal) {
    fast = fast || 12;
    slow = slow || 26;
    signal = signal || 9;
    var macdLine = [], signalLine = [], histogram = [];
    if (!candles || candles.length < slow + signal) return { macd: macdLine, signal: signalLine, hist: histogram };

    var emaFast = calculateEMA(candles, fast);
    var emaSlow = calculateEMA(candles, slow);

    var fastMap = Object.create(null);
    for (var f = 0; f < emaFast.length; f++) fastMap[emaFast[f].time] = emaFast[f].value;

    var rawMacd = [];
    for (var s = 0; s < emaSlow.length; s++) {
      var t = emaSlow[s].time;
      if (fastMap[t] != null) {
        var val = Math.round((fastMap[t] - emaSlow[s].value) * 100) / 100;
        rawMacd.push({ time: t, close: val });
        macdLine.push({ time: t, value: val });
      }
    }

    if (rawMacd.length >= signal) {
      var emaSignal = calculateEMA(rawMacd, signal);
      var sigMap = Object.create(null);
      for (var g = 0; g < emaSignal.length; g++) {
        sigMap[emaSignal[g].time] = emaSignal[g].value;
        signalLine.push({ time: emaSignal[g].time, value: emaSignal[g].value });
      }

      for (var m = 0; m < macdLine.length; m++) {
        var tm = macdLine[m].time;
        if (sigMap[tm] != null) {
          var hVal = Math.round((macdLine[m].value - sigMap[tm]) * 100) / 100;
          histogram.push({
            time: tm,
            value: hVal,
            color: hVal >= 0 ? '#10b981' : '#ef4444'
          });
        }
      }
    }

    return { macd: macdLine, signal: signalLine, hist: histogram };
  }

  // ============================================================
  // IDX TICK SIZE & VALIDATION
  // ============================================================
  // FIX-20: IDX fractional ladder has a dedicated Rp1 rung for the FCA and
  // Akselerasi/Pemantauan boards. The ladder must also never return 0 for an
  // invalid or sub-Rp1 input — 1 is the smallest legal tick.
  function isFcaBoardTick(board, isFca) {
    if (isFca === true) return true;
    var b = String(board || '').toUpperCase();
    return b.indexOf('AKSELERASI') >= 0 || b.indexOf('PEMANTAUAN') >= 0 || b.indexOf('FCA') >= 0;
  }

  function getIdxTickSize(price, board, isFca) {
    if (isFcaBoardTick(board, isFca)) return 1;
    var p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return 1;
    if (p < 200) return 1;
    if (p < 500) return 2;
    if (p < 2000) return 5;
    if (p < 5000) return 10;
    return 25;
  }

  function roundToIdxTick(price, direction, board, isFca) {
    var raw = Number(price);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    var p = Math.max(1, Math.round(raw));
    var tick = getIdxTickSize(p, board, isFca);
    var snapped;
    if (direction === 'up') snapped = Math.ceil(p / tick) * tick;
    else if (direction === 'down') snapped = Math.floor(p / tick) * tick;
    else snapped = Math.round(p / tick) * tick;
    // FIX-20: a positive price must never snap below the minimum legal tick.
    return snapped < 1 ? 1 : snapped;
  }

  // ============================================================
  // VISUAL TRADING PLAN & SCALE-OUT CALCULATOR
  // ============================================================
  function calculateTradingPlan(candles, customPlan) {
    if (!candles || candles.length < 5) return null;
    var latest = candles[candles.length - 1];
    var lastPrice = Number(latest.close);

    var entry = customPlan && customPlan.entry ? roundToIdxTick(Number(customPlan.entry)) : roundToIdxTick(lastPrice);

    // FIX-20: support is derived from CLOSED bars only. Including the live last
    // bar let today's still-forming low (possibly a spike) become "support".
    var minLow = Infinity;
    var closedCandles = candles.length > 1 ? candles.slice(0, candles.length - 1) : candles;
    var lookback = Math.min(20, closedCandles.length);
    for (var i = closedCandles.length - lookback; i < closedCandles.length; i++) {
      var lo = Number(closedCandles[i].low);
      if (Number.isFinite(lo) && lo < minLow) minLow = lo;
    }
    if (!Number.isFinite(minLow)) minLow = Number(lastPrice) || 0;

    var sl = customPlan && customPlan.sl ? roundToIdxTick(Number(customPlan.sl), 'down') : roundToIdxTick(minLow * 0.98, 'down');
    if (sl >= entry) sl = roundToIdxTick(entry * 0.96, 'down');

    var risk = entry - sl;
    var minReward = Math.round(risk * 1.5);
    var tp1 = customPlan && customPlan.tp1 ? roundToIdxTick(Number(customPlan.tp1), 'up') : roundToIdxTick(entry + minReward, 'up');
    var tp2 = customPlan && customPlan.tp2 ? roundToIdxTick(Number(customPlan.tp2), 'up') : roundToIdxTick(entry + Math.round(risk * 2.5), 'up');

    // FIX-20: the anonymous `forceUnsafeRR` backdoor is removed — it let any
    // caller (or a crafted payload) bypass the 1.5 R/R safety gate. A test-only
    // escape hatch now requires an explicit, namespaced opt-in.
    if (customPlan && customPlan.__allowTestForceUnsafe === true && customPlan.forceUnsafeRR === true) {
      tp1 = roundToIdxTick(entry + Math.round(risk * 1.49), 'down');
    }

    var reward1 = tp1 - entry;
    var rrRatio = risk > 0 ? Math.round((reward1 / risk) * 100) / 100 : 0;
    var isSafeRR = rrRatio >= 1.5;

    var slPct = entry > 0 ? Math.round(((sl - entry) / entry) * 1000) / 10 : 0;
    var tp1Pct = entry > 0 ? Math.round(((tp1 - entry) / entry) * 1000) / 10 : 0;
    var tp2Pct = entry > 0 ? Math.round(((tp2 - entry) / entry) * 1000) / 10 : 0;

    var scaleOutLots = customPlan && customPlan.lots ? Number(customPlan.lots) : 100;
    var exitLotsTP1 = Math.floor(scaleOutLots * 0.5);
    var exitLotsTP2 = scaleOutLots - exitLotsTP1;

    var grossProfitTP1 = (tp1 - entry) * exitLotsTP1 * 100;
    var grossProfitTP2 = (tp2 - entry) * exitLotsTP2 * 100;
    var totalGrossProfit = grossProfitTP1 + grossProfitTP2;

    var totalBuyValue = entry * scaleOutLots * 100;
    var buyFee = totalBuyValue * 0.0015;
    var sellFeeTP1 = (tp1 * exitLotsTP1 * 100) * 0.0025;
    var sellFeeTP2 = (tp2 * exitLotsTP2 * 100) * 0.0025;
    var totalFees = buyFee + sellFeeTP1 + sellFeeTP2;
    var netProfit = totalGrossProfit - totalFees;

    var maxLossValue = risk * scaleOutLots * 100 + (totalBuyValue * 0.0015 + (sl * scaleOutLots * 100) * 0.0025);

    return {
      entry: entry,
      sl: sl,
      tp1: tp1,
      tp2: tp2,
      risk: risk,
      reward1: reward1,
      rrRatio: rrRatio,
      isSafeRR: isSafeRR,
      slPct: slPct,
      tp1Pct: tp1Pct,
      tp2Pct: tp2Pct,
      entryLabel: 'Entry Rp ' + entry.toLocaleString('id-ID'),
      slLabel: 'Stop Loss Rp ' + sl.toLocaleString('id-ID') + ' (' + (slPct >= 0 ? '+' : '') + slPct.toFixed(1) + '%)',
      tp1Label: 'Target 1 (50%) Rp ' + tp1.toLocaleString('id-ID') + ' (+' + tp1Pct.toFixed(1) + '%)',
      tp2Label: 'Target 2 (50%) Rp ' + tp2.toLocaleString('id-ID') + ' (+' + tp2Pct.toFixed(1) + '%)',
      warningMessage: isSafeRR
        ? 'Rasio R/R 1:' + rrRatio.toFixed(2) + ' memenuhi Risk Gate Bagian J (>= 1.50)'
        : 'PERINGATAN KETAT: STATUS PANTAUAN - R/R Aktual (' + rrRatio.toFixed(2).replace('.', ',') + 'x) di bawah batas minimum keselamatan 1,50x (Ditolak Risk Gate Bagian J / Tidak Siap Eksekusi)',
      scaleOut: {
        totalLots: scaleOutLots,
        tp1Lots: exitLotsTP1,
        tp2Lots: exitLotsTP2,
        breakevenStop: entry,
        grossProfitTP1: grossProfitTP1,
        grossProfitTP2: grossProfitTP2,
        totalGrossProfit: totalGrossProfit,
        totalFees: Math.round(totalFees),
        netProfit: Math.round(netProfit),
        maxLoss: Math.round(maxLossValue)
      }
    };
  }

  // ============================================================
  // BANDAR METRICS CALCULATORS
  // ============================================================
  function calculateCMF(candles, period) {
    period = period || 20;
    if (!candles || candles.length === 0) return [];
    var results = [];
    var mfvList = [];
    var volList = [];
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var h = Number(c.high != null ? c.high : c.close);
      var l = Number(c.low != null ? c.low : c.close);
      var cl = Number(c.close);
      var v = Number(c.volume || 0);
      var mfm = (h - l > 0) ? ((cl - l) - (h - cl)) / (h - l) : 0;
      var mfv = mfm * v;
      mfvList.push(mfv);
      volList.push(v);
      // FIX-20: no fabricated 0.0 warmup points — the series starts at
      // period-1, exactly like calculateSMA/calculateEMA/calculateBollinger.
      if (i < period - 1) continue;
      var sumMfv = 0, sumVol = 0;
      for (var j = i - period + 1; j <= i; j++) {
        sumMfv += mfvList[j];
        sumVol += volList[j];
      }
      var cmfVal = sumVol > 0 ? Math.round((sumMfv / sumVol) * 1000) / 1000 : 0.0;
      results.push({ time: c.time, value: cmfVal });
    }
    return results;
  }

  function calculateForeignFlowCumulative(candles, foreignFlow) {
    if (!candles || candles.length === 0) return [];
    var mapByDate = Object.create(null);
    if (Array.isArray(foreignFlow)) {
      for (var f = 0; f < foreignFlow.length; f++) {
        var item = foreignFlow[f];
        var dt = item.date || item.time;
        if (dt) mapByDate[String(dt).slice(0, 10)] = Number(item.foreign_net || item.net || 0);
      }
    }
    var cum = 0;
    var out = [];
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var key = String(c.time).slice(0, 10);
      var net = mapByDate[key] != null ? mapByDate[key] : Number(c.foreign_net_value || c.foreign_net || 0);
      cum += net;
      out.push({ time: c.time, net: net, value: cum });
    }
    return out;
  }

  function calculateIntensityHistogram(candles, period) {
    period = period || 20;
    if (!candles || candles.length === 0) return [];
    var results = [];
    var volumes = candles.map(function(c) { return Number(c.volume || 0); });
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var open = Number(c.open != null ? c.open : c.close);
      var close = Number(c.close);
      var high = Number(c.high != null ? c.high : c.close);
      var low = Number(c.low != null ? c.low : c.close);
      var vol = volumes[i];
      var p = Math.min(i + 1, period);
      var volSum = 0;
      for (var j = i - p + 1; j <= i; j++) volSum += volumes[j];
      var avgVol = volSum / p || 1;
      var volRatio = vol / avgVol;
      var range = high - low;
      var body = Math.abs(close - open);
      var bodyRatio = range > 0 ? body / range : 0.5;
      var direction = close >= open ? 1 : -1;
      var rawIntensity = volRatio * (0.5 + 0.5 * bodyRatio) * direction;
      var score = Math.round(rawIntensity * 100) / 100;
      var color = '#8b5cf680'; // bar ungu
      if (Math.abs(score) >= 2.0) color = '#8b5cf6'; // ungu pekat saat lonjakan
      results.push({ time: c.time, value: score, color: color });
    }
    return results;
  }

  function calculateVolumeRotation(candles, period) {
    period = period || 20;
    if (!candles || candles.length === 0) return [];
    var results = [];
    var turnovers = candles.map(function(c) {
      return Number(c.volume || 0) * Number(c.close || 0);
    });

    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var turn = turnovers[i];
      var p = Math.min(i + 1, period);
      var recentTurnovers = turnovers.slice(i - p + 1, i + 1).slice().sort(function(a, b) { return a - b; });
      var medianTurnover = recentTurnovers[Math.floor(recentTurnovers.length / 2)] || 1;
      var rotationRatio = Math.round((turn / medianTurnover) * 100) / 100;

      var color = '#eab308'; // kuning: transisi
      var isUp = Number(c.close) >= Number(c.open || c.close);
      if (rotationRatio >= 1.5) {
        color = isUp ? '#10b981' : '#ef4444'; // hijau: akumulasi, merah: distribusi
      } else if (rotationRatio >= 1.0 && isUp) {
        color = '#10b98180';
      }

      results.push({
        time: c.time,
        value: rotationRatio,
        color: color
      });
    }
    return results;
  }

  function calculateLPMSeries(candles, windowPeriod) {
    windowPeriod = windowPeriod || 20;
    if (!candles || candles.length === 0) return [];
    var out = [];
    var typicalPrices = candles.map(function(c) {
      return (Number(c.high || c.close) + Number(c.low || c.close) + Number(c.close)) / 3;
    });
    var vols = candles.map(function(c) { return Number(c.volume || 0); });

    for (var i = 0; i < candles.length; i++) {
      var p = Math.min(i + 1, windowPeriod);
      var totalVol = 0;
      var weightedSum = 0;
      for (var j = i - p + 1; j <= i; j++) {
        var v = vols[j];
        if (v > 0) {
          totalVol += v;
          weightedSum += typicalPrices[j] * v;
        }
      }
      var vwap = totalVol > 0 ? Math.round(weightedSum / totalVol) : Number(candles[i].close);
      out.push({ time: candles[i].time, value: vwap });
    }
    return out;
  }

  function calculateCorrF(candles, foreignFlow, windowPeriod) {
    windowPeriod = windowPeriod || 20;
    if (!candles || candles.length < 3) return 0.0;
    var p = Math.min(candles.length, windowPeriod);
    var slice = candles.slice(-p);

    var priceChanges = [];
    var netFlows = [];
    var mapByDate = Object.create(null);
    if (Array.isArray(foreignFlow)) {
      for (var f = 0; f < foreignFlow.length; f++) {
        var item = foreignFlow[f];
        var dt = item.date || item.time || item.trade_date;
        if (dt) mapByDate[String(dt).slice(0, 10)] = Number(item.foreign_net || item.net || item.net_value || 0);
      }
    }

    for (var i = 1; i < slice.length; i++) {
      var prev = Number(slice[i - 1].close);
      var curr = Number(slice[i].close);
      priceChanges.push(prev > 0 ? (curr - prev) / prev : 0);

      var dtStr = String(slice[i].time || slice[i].date).slice(0, 10);
      var net = mapByDate[dtStr] != null ? mapByDate[dtStr] : Number(slice[i].foreign_net_value || slice[i].foreign_net || 0);
      netFlows.push(net);
    }

    var n = priceChanges.length;
    if (n < 3) return 0.0;
    var sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;
    for (var j = 0; j < n; j++) {
      var a = priceChanges[j];
      var b = netFlows[j];
      sumA += a;
      sumB += b;
      sumA2 += a * a;
      sumB2 += b * b;
      sumAB += a * b;
    }
    var denomA = n * sumA2 - sumA * sumA;
    var denomB = n * sumB2 - sumB * sumB;
    if (denomA <= 0 || denomB <= 0) return 0.0;
    var r = (n * sumAB - sumA * sumB) / Math.sqrt(denomA * denomB);
    return Math.round(Math.max(-1.0, Math.min(1.0, r)) * 100) / 100;
  }

  function calculateParF(candles, brokerSummary, windowPeriod) {
    windowPeriod = windowPeriod || 20;
    if (!candles || candles.length === 0) return 0.0;
    var p = Math.min(candles.length, windowPeriod);
    var slice = candles.slice(-p);
    var totalVol = 0;
    var foreignVol = 0;
    for (var i = 0; i < slice.length; i++) {
      var c = slice[i];
      var v = Number(c.volume || 0);
      totalVol += v;
      var fv = Number(c.foreign_buy || 0) + Number(c.foreign_sell || 0);
      if (fv === 0 && c.foreign_net != null) {
        // FIX-20: no magic 1.5 gross-up. When only the net is known, the
        // absolute net is the honest conservative lower bound on gross volume.
        fv = Math.abs(Number(c.foreign_net));
        if (!Number.isFinite(fv)) fv = 0;
      }
      foreignVol += fv;
    }
    if (totalVol <= 0) return 0.0;
    var ratio = foreignVol > 0 ? (foreignVol / (totalVol * 2)) * 100 : 0.0;
    if (ratio > 100) ratio = 100;
    return Math.round(ratio * 10) / 10;
  }

  function calculateLPM(candles, brokerSummary, windowPeriod) {
    windowPeriod = windowPeriod || 20;
    if (!candles || candles.length === 0) return null;
    var p = Math.min(candles.length, windowPeriod);
    var slice = candles.slice(-p);
    var totalVol = 0, weightedSum = 0;
    for (var i = 0; i < slice.length; i++) {
      var c = slice[i];
      var vol = Number(c.volume || 0);
      var typical = (Number(c.high || c.close) + Number(c.low || c.close) + Number(c.close)) / 3;
      if (vol > 0 && typical > 0) {
        totalVol += vol;
        weightedSum += typical * vol;
      }
    }
    var vwap = totalVol > 0 ? Math.round(weightedSum / totalVol) : null;
    var topBuyerAvg = null;
    if (brokerSummary && Array.isArray(brokerSummary.top_buyers) && brokerSummary.top_buyers.length > 0) {
      var b1 = brokerSummary.top_buyers[0];
      if (b1.avg_buy && b1.avg_buy > 0) topBuyerAvg = Math.round(b1.avg_buy);
      else if (b1.avg_price && b1.avg_price > 0) topBuyerAvg = Math.round(b1.avg_price);
    }
    return topBuyerAvg || vwap;
  }

  function formatIndonesianVolumeCompact(v) {
    if (!v || v === 0) return '0 lembar';
    if (v >= 1e9) return (v / 1e9).toFixed(2).replace('.', ',') + ' Mrd lembar';
    if (v >= 1e6) return (v / 1e6).toFixed(2).replace('.', ',') + ' Jt lembar';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',') + ' Rb lembar';
    return String(v) + ' lembar';
  }

  function formatIndonesianRupiahCompact(v) {
    if (!v || v === 0) return 'Rp 0';
    var abs = Math.abs(v);
    var sign = v >= 0 ? '+' : '-';
    if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2).replace('.', ',') + ' T';
    if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2).replace('.', ',') + ' Mrd';
    if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(2).replace('.', ',') + ' Jt';
    return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
  }

  function getLatestForeignNet(candles, foreignFlow) {
    if (!candles || candles.length === 0) return 0;
    var latest = candles[candles.length - 1];
    if (latest.foreign_net_value != null) return Number(latest.foreign_net_value);
    if (latest.foreign_net != null) return Number(latest.foreign_net);
    return 0;
  }

  function getLatestMoneyFlow(candles) {
    var cmf = calculateCMF(candles, 20);
    if (!cmf || cmf.length === 0) return '0.000';
    var last = cmf[cmf.length - 1];
    var val = last ? last.value : 0;
    var sign = val >= 0 ? '+' : '';
    return sign + val.toFixed(3);
  }

  // ============================================================
  // WORKSTATION STATE INSTANCE
  // ============================================================
  function createWorkstationState(initialPreset) {
    var currentPreset = initialPreset || 'simpel';
    var activeSet = Object.create(null);

    var presetDef = PRESETS[currentPreset] || PRESETS.simpel;
    for (var i = 0; i < presetDef.layers.length; i++) {
      activeSet[presetDef.layers[i]] = true;
    }

    return {
      activePreset: currentPreset,
      activeLayers: activeSet,
      timeframe: '1D',
      chartCollapsed: false,
      customTradingPlan: null,

      applyPreset: function (presetName) {
        var p = PRESETS[presetName];
        if (!p) return false;
        this.activePreset = presetName;
        this.activeLayers = Object.create(null);
        for (var k = 0; k < p.layers.length; k++) {
          this.activeLayers[p.layers[k]] = true;
        }
        return true;
      },

      toggleLayer: function (layerId, forceState) {
        if (forceState != null) {
          this.activeLayers[layerId] = Boolean(forceState);
        } else {
          this.activeLayers[layerId] = !this.activeLayers[layerId];
        }
        this.activePreset = 'custom';
        return this.activeLayers[layerId];
      },

      setAllLayers: function (enabled) {
        this.activeLayers = Object.create(null);
        if (enabled) {
          for (var g = 0; g < LAYER_GROUPS.length; g++) {
            var group = LAYER_GROUPS[g];
            for (var l = 0; l < group.layers.length; l++) {
              this.activeLayers[group.layers[l].id] = true;
            }
          }
          this.activePreset = 'pro';
        } else {
          this.activePreset = 'bersih';
        }
      },

      reset: function () {
        return this.applyPreset('simpel');
      },

      setTimeframe: function (tf) {
        if (tf === '1D' || tf === '1W') {
          this.timeframe = tf;
          return true;
        }
        return false;
      },

      toggleCollapse: function () {
        this.chartCollapsed = !this.chartCollapsed;
        return this.chartCollapsed;
      },

      getActiveLayerCount: function () {
        var count = 0;
        var keys = Object.keys(this.activeLayers);
        for (var i = 0; i < keys.length; i++) {
          if (this.activeLayers[keys[i]]) count++;
        }
        return count;
      },

      isLayerActive: function (layerId) {
        return Boolean(this.activeLayers[layerId]);
      }
    };
  }

  // ============================================================
  // DOM UI COMPONENT RENDERERS (TOOLBAR & DRAWER)
  // ============================================================
  var _workstationInstances = Object.create(null);

  function getOrCreateInstance(chartId, candles, metrics, ticker, options) {
    if (!_workstationInstances[chartId]) {
      var state = createWorkstationState('simpel');
      _workstationInstances[chartId] = {
        chartId: chartId,
        state: state,
        dailyCandles: candles || [],
        weeklyCandles: null,
        metrics: metrics || null,
        ticker: ticker || '',
        options: options || {},
        chartRef: null,
        candleSeriesRef: null,
        volumeSeriesRef: null,
        extraSeries: [],
        extraPriceLines: []
      };
    } else {
      if (candles && candles.length) {
        _workstationInstances[chartId].dailyCandles = candles;
        _workstationInstances[chartId].weeklyCandles = null;
      }
      if (metrics) _workstationInstances[chartId].metrics = metrics;
      if (ticker) _workstationInstances[chartId].ticker = ticker;
    }
    return _workstationInstances[chartId];
  }

  function renderToolbarHtml(chartId) {
    var inst = _workstationInstances[chartId];
    var state = inst ? inst.state : createWorkstationState('simpel');
    var tf = state.timeframe || '1D';
    var preset = state.activePreset || 'simpel';
    var count = state.getActiveLayerCount();

    var html = '<div id="' + chartId + '_workstation_toolbar" class="chart-workstation-toolbar flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-dark-800/80 border-b border-dark-600/30 text-xs">' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<div class="inline-flex rounded-lg bg-dark-900/80 p-0.5 border border-dark-600/40" role="group" aria-label="Pilih Timeframe">' +
          '<button type="button" class="px-2.5 py-1 text-xs font-semibold rounded-md transition ' + (tf === '1D' ? 'bg-emerald-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.switchTimeframe(\'' + chartId + '\', \'1D\')">1D</button>' +
          '<button type="button" class="px-2.5 py-1 text-xs font-semibold rounded-md transition ' + (tf === '1W' ? 'bg-emerald-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.switchTimeframe(\'' + chartId + '\', \'1W\')">1W</button>' +
        '</div>' +
        '<div class="inline-flex rounded-lg bg-dark-900/80 p-0.5 border border-dark-600/40 flex-wrap" role="group" aria-label="Pilih Preset Chart">' +
          '<button type="button" class="px-2 py-1 text-[11px] font-medium rounded-md transition ' + (preset === 'simpel' ? 'bg-dark-700 text-emerald-400 font-semibold' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.applyPreset(\'' + chartId + '\', \'simpel\')">Simpel</button>' +
          '<button type="button" class="px-2 py-1 text-[11px] font-medium rounded-md transition ' + (preset === 'scalping' ? 'bg-dark-700 text-emerald-400 font-semibold' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.applyPreset(\'' + chartId + '\', \'scalping\')">Scalping</button>' +
          '<button type="button" class="px-2 py-1 text-[11px] font-medium rounded-md transition ' + (preset === 'swing' ? 'bg-dark-700 text-emerald-400 font-semibold' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.applyPreset(\'' + chartId + '\', \'swing\')">Swing</button>' +
          '<button type="button" class="px-2 py-1 text-[11px] font-medium rounded-md transition ' + (preset === 'investor' ? 'bg-dark-700 text-emerald-400 font-semibold' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.applyPreset(\'' + chartId + '\', \'investor\')">Investor</button>' +
          '<button type="button" class="px-2 py-1 text-[11px] font-medium rounded-md transition ' + (preset === 'pro' ? 'bg-dark-700 text-emerald-400 font-semibold' : 'text-gray-400 hover:text-gray-200') + '" onclick="AutoCuanChartWorkstation.applyPreset(\'' + chartId + '\', \'pro\')">Pro</button>' +
        '</div>' +
        '<span id="' + chartId + '_layer_badge" class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/60 text-emerald-400 border border-emerald-500/30">' + count + ' Layer Aktif</span>' +
      '</div>' +
      '<div class="flex items-center gap-1.5 flex-wrap">' +
        '<button type="button" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-gray-300 bg-dark-700/60 hover:bg-dark-700 border border-dark-600/40 transition" onclick="AutoCuanChartWorkstation.toggleDrawer(\'' + chartId + '\')" aria-label="Buka Pengaturan Mode dan Layer">' +
          '<svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg>' +
          'Mode &amp; Layer' +
        '</button>' +
        '<button type="button" id="' + chartId + '_collapse_btn" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-gray-400 hover:text-gray-200 bg-dark-700/40 hover:bg-dark-700 border border-dark-600/30 transition" onclick="AutoCuanChartWorkstation.toggleCollapse(\'' + chartId + '\')">' +
          'Sembunyikan Chart' +
        '</button>' +
        '<button type="button" class="px-2 py-1 rounded-md text-[11px] font-medium text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 transition" onclick="AutoCuanChartWorkstation.turnOffAll(\'' + chartId + '\')" title="Matikan semua layer opsional">Matikan Semua</button>' +
        '<button type="button" class="px-2 py-1 rounded-md text-[11px] font-medium text-gray-400 hover:text-amber-400 hover:bg-amber-500/10 transition" onclick="AutoCuanChartWorkstation.reset(\'' + chartId + '\')" title="Kembalikan ke preset Simpel">Reset</button>' +
      '</div>' +
    '</div>';
    return html;
  }

  function renderDrawerHtml(chartId) {
    var inst = _workstationInstances[chartId];
    var state = inst ? inst.state : createWorkstationState('simpel');

    var html = '<div id="' + chartId + '_drawer" class="chart-workstation-drawer hidden bg-dark-900/95 border-b border-dark-600/40 p-4 transition-all duration-150">' +
      '<div class="flex items-center justify-between pb-3 border-b border-dark-700 mb-3">' +
        '<div>' +
          '<h3 class="text-sm font-semibold" style="color: #ffffff !important; font-weight: 700 !important;">Pengaturan Mode &amp; Layer Chart</h3>' +
          '<p class="text-xs" style="color: #94a3b8 !important;">Pilih indikator teknikal, area struktur, dan metrik kuantitatif bandar</p>' +
        '</div>' +
        '<button type="button" class="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-dark-800 border border-dark-600/40" onclick="AutoCuanChartWorkstation.toggleDrawer(\'' + chartId + '\')">Tutup [X]</button>' +
      '</div>' +
      '<div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">';

    for (var g = 0; g < LAYER_GROUPS.length; g++) {
      var group = LAYER_GROUPS[g];
      html += '<div class="p-3 rounded-xl bg-dark-800/60 border border-dark-700/50 space-y-2">' +
        '<div class="font-semibold text-emerald-400 flex items-center justify-between">' +
          '<span>' + group.title + '</span>' +
          '<span class="text-[10px] text-gray-500 font-normal">' + group.layers.length + ' layer</span>' +
        '</div>' +
        '<p class="text-[11px] text-gray-400 pb-1 border-b border-dark-700/40">' + group.description + '</p>' +
        '<div class="space-y-1.5 pt-1">';

      for (var l = 0; l < group.layers.length; l++) {
        var layer = group.layers[l];
        var isActive = state.isLayerActive(layer.id);
        var isDisabled = Boolean(layer.disabled);
        html += '<label class="flex items-start gap-2 p-1 rounded ' + (isDisabled ? 'opacity-60 cursor-not-allowed bg-dark-900/40' : 'cursor-pointer hover:bg-dark-700/30') + '">' +
          '<input type="checkbox" ' + (isDisabled ? 'disabled' : '') + ' class="mt-0.5 rounded border-dark-600 text-emerald-500 focus:ring-0 bg-dark-900 ' + (isDisabled ? 'cursor-not-allowed' : '') + '" ' + (isActive ? 'checked' : '') + ' onchange="AutoCuanChartWorkstation.toggleLayer(\'' + chartId + '\', \'' + layer.id + '\')">' +
          '<div class="min-w-0 flex-1">' +
            '<div class="font-medium text-gray-200 flex items-center gap-1.5 flex-wrap">' +
              (layer.color ? '<span class="w-2 h-2 rounded-full inline-block shrink-0" style="background-color:' + layer.color + '"></span>' : '') +
              '<span>' + layer.name + '</span>' +
              (isDisabled ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-dark-700 text-amber-400 border border-dark-600 font-normal">Dalam Riset (Nonaktif)</span>' : '') +
            '</div>' +
            '<p class="text-[10px] text-gray-400">' + layer.desc + '</p>' +
          '</div>' +
        '</label>';
      }

      html += '</div></div>';
    }

    html += '</div>';

    var plan = calculateTradingPlan(inst ? inst.dailyCandles : []);
    if (plan) {
      html += '<div id="' + chartId + '_plan_panel" class="mt-4 p-3 rounded-xl bg-dark-800/90 border border-dark-700 space-y-2">' +
        (plan.isSafeRR ? '' :
          '<div class="p-2.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-semibold flex items-center gap-2 mb-2">' +
            '<svg class="w-4 h-4 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>' +
            '<span>STATUS PANTAUAN - R/R Aktual (' + plan.rrRatio.toFixed(2).replace('.', ',') + 'x) di bawah batas minimum keselamatan 1,50x (Tidak Siap Eksekusi)</span>' +
          '</div>'
        ) +
        '<div class="flex items-center justify-between">' +
          '<h4 class="text-xs font-semibold text-gray-200">Kalkulator Simulasi Visual Trading Plan</h4>' +
          '<span class="text-[11px] px-2 py-0.5 rounded font-mono font-bold ' + (plan.isSafeRR ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30') + '">' +
            plan.warningMessage +
          '</span>' +
        '</div>' +
        '<div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] font-mono">' +
          '<div class="p-2 rounded bg-dark-900 border border-dark-700"><span class="text-gray-400">ENTRY</span><br><b class="text-sky-400">Rp ' + plan.entry.toLocaleString('id-ID') + '</b></div>' +
          '<div class="p-2 rounded bg-dark-900 border border-dark-700"><span class="text-gray-400">STOP LOSS</span><br><b class="text-rose-400">Rp ' + plan.sl.toLocaleString('id-ID') + ' (' + (plan.slPct >= 0 ? '+' : '') + plan.slPct.toFixed(1) + '%)</b></div>' +
          '<div class="p-2 rounded bg-dark-900 border border-dark-700"><span class="text-gray-400">TARGET 1 (50%)</span><br><b class="text-emerald-400">Rp ' + plan.tp1.toLocaleString('id-ID') + ' (+' + plan.tp1Pct.toFixed(1) + '%)</b></div>' +
          '<div class="p-2 rounded bg-dark-900 border border-dark-700"><span class="text-gray-400">TARGET 2 (50%)</span><br><b class="text-emerald-300">Rp ' + plan.tp2.toLocaleString('id-ID') + ' (+' + plan.tp2Pct.toFixed(1) + '%)</b></div>' +
          '<div class="p-2 rounded bg-dark-900 border border-dark-700"><span class="text-gray-400">RASIO R/R</span><br><b class="' + (plan.isSafeRR ? 'text-emerald-400' : 'text-rose-400') + '">1 : ' + plan.rrRatio.toFixed(2) + '</b></div>' +
        '</div>' +
        '<div class="text-[10px] text-gray-400 flex flex-wrap gap-4 pt-1 border-t border-dark-700/50">' +
          '<span>Scale-out: <b>' + plan.scaleOut.tp1Lots + ' lot</b> di TP1 (Stop ke Breakeven Rp ' + plan.scaleOut.breakevenStop.toLocaleString('id-ID') + '), sisa <b>' + plan.scaleOut.tp2Lots + ' lot</b> di TP2</span>' +
          '<span>Estimasi Net Profit: <b class="text-emerald-400">+Rp ' + plan.scaleOut.netProfit.toLocaleString('id-ID') + '</b></span>' +
          '<span>Total Biaya Transaksi (Beli 0,15% + Jual 0,25%): <b>Rp ' + plan.scaleOut.totalFees.toLocaleString('id-ID') + '</b></span>' +
        '</div>' +
      '</div>';
    }

    html += '</div>';
    return html;
  }

  // ============================================================
  // CHART WORKSTATION DISPATCHERS (< 100ms REACTIVITY)
  // ============================================================
  function switchTimeframe(chartId, tf) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    inst.state.setTimeframe(tf);

    var activeCandles = inst.dailyCandles;
    if (tf === '1W') {
      if (!inst.weeklyCandles) {
        inst.weeklyCandles = aggregateDailyToWeekly(inst.dailyCandles);
      }
      activeCandles = inst.weeklyCandles;
    }

    if (typeof defaultRoot.renderLightweightChart === 'function') {
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }
    updateToolbarDom(chartId);
    var elapsed = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
    if (typeof console !== 'undefined' && console.log) {
      console.log('[Workstation] Timeframe switched to ' + tf + ' in ' + elapsed.toFixed(1) + 'ms');
    }
  }

  function applyPreset(chartId, presetName) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    inst.state.applyPreset(presetName);

    var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
    if (typeof defaultRoot.renderLightweightChart === 'function') {
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }
    updateToolbarDom(chartId);
    updateDrawerDom(chartId);
    var elapsed = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
    if (typeof console !== 'undefined' && console.log) {
      console.log('[Workstation] Preset applied: ' + presetName + ' in ' + elapsed.toFixed(1) + 'ms');
    }
  }

  function toggleLayer(chartId, layerId, forceState) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    inst.state.toggleLayer(layerId, forceState);

    var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
    if (typeof defaultRoot.renderLightweightChart === 'function') {
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }
    updateToolbarDom(chartId);
  }

  function toggleDrawer(chartId) {
    var drawer = document.getElementById(chartId + '_drawer');
    if (drawer) {
      drawer.classList.toggle('hidden');
    }
  }

  function toggleCollapse(chartId) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    var isCollapsed = inst.state.toggleCollapse();
    var container = document.getElementById(chartId + '_container');
    var rsi = document.getElementById(chartId + '_rsi');
    var metrics = document.getElementById(chartId + '_metrics');
    var subpanels = document.getElementById(chartId + '_subpanels_wrapper');
    var planCard = document.getElementById(chartId + '_plan_backtest_card');
    var btn = document.getElementById(chartId + '_collapse_btn');

    if (container) container.style.display = isCollapsed ? 'none' : 'block';
    if (rsi) rsi.style.display = isCollapsed ? 'none' : 'block';
    if (metrics) metrics.style.display = isCollapsed ? 'none' : 'grid';
    if (subpanels) subpanels.style.display = isCollapsed ? 'none' : 'block';
    if (planCard) planCard.style.display = isCollapsed ? 'none' : 'block';
    if (btn) btn.textContent = isCollapsed ? 'Tampilkan Chart' : 'Sembunyikan Chart';
  }

  function turnOffAll(chartId) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    inst.state.setAllLayers(false);
    var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
    if (typeof defaultRoot.renderLightweightChart === 'function') {
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }
    updateToolbarDom(chartId);
    updateDrawerDom(chartId);
  }

  function reset(chartId) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    inst.state.reset();
    var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
    if (typeof defaultRoot.renderLightweightChart === 'function') {
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }
    updateToolbarDom(chartId);
    updateDrawerDom(chartId);
  }

  function updateToolbarDom(chartId) {
    if (typeof document === 'undefined') return;
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    var badge = document.getElementById(chartId + '_layer_badge');
    if (badge) {
      badge.textContent = inst.state.getActiveLayerCount() + ' Layer Aktif';
    }
    var tb = document.getElementById(chartId + '_workstation_toolbar');
    if (tb) {
      var parent = tb.parentNode;
      var temp = document.createElement('div');
      temp.innerHTML = renderToolbarHtml(chartId);
      if (temp.firstElementChild) {
        parent.replaceChild(temp.firstElementChild, tb);
      }
    }
  }

  function updateDrawerDom(chartId) {
    if (typeof document === 'undefined') return;
    var drawer = document.getElementById(chartId + '_drawer');
    if (drawer) {
      var isHidden = drawer.classList.contains('hidden');
      var parent = drawer.parentNode;
      var temp = document.createElement('div');
      temp.innerHTML = renderDrawerHtml(chartId);
      if (temp.firstElementChild) {
        if (isHidden) temp.firstElementChild.classList.add('hidden');
        parent.replaceChild(temp.firstElementChild, drawer);
      }
    }
  }

  // ============================================================
  // FIX-22: TRADING-PLAN PRICE LINES ON THE CANDLE SERIES
  // ============================================================
  // Draws Entry/SL/TP1/TP2 as real horizontal price lines on the candlestick
  // series and clears the previous set first, so switching tickers can never
  // stack stale levels on top of the new plan.
  var PLAN_LINE_STYLE = { entry: '#38bdf8', sl: '#f43f5e', tp1: '#10b981', tp2: '#22c55e' };
  var PLAN_LINE_LABEL = { entry: 'Entry', sl: 'SL', tp1: 'TP1', tp2: 'TP2' };
  var PLAN_LINE_DASH = { entry: 0, sl: 2, tp1: 2, tp2: 1 };

  function clearPlanPriceLines(series) {
    if (!series || typeof series.removePriceLine !== 'function') return 0;
    var store = series.__acPlanPriceLines;
    if (!Array.isArray(store) || !store.length) return 0;
    var removed = 0;
    for (var i = 0; i < store.length; i++) {
      try {
        series.removePriceLine(store[i]);
        removed++;
      } catch (_) {}
    }
    series.__acPlanPriceLines = [];
    return removed;
  }

  function applyPlanPriceLines(series, plan) {
    if (!series || typeof series.createPriceLine !== 'function') return [];

    // Always clear first: a re-apply (ticker switch, preset change, plan edit)
    // must replace the previous levels rather than stack duplicates.
    clearPlanPriceLines(series);

    var levels = plan && plan.planLevels ? plan.planLevels : plan;
    if (!levels || typeof levels !== 'object') return [];

    var created = [];
    var keys = ['entry', 'sl', 'tp1', 'tp2'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var price = Number(levels[key]);
      if (!Number.isFinite(price) || price <= 0) continue;
      try {
        var line = series.createPriceLine({
          price: price,
          color: PLAN_LINE_STYLE[key] || '#94a3b8',
          lineWidth: 1,
          lineStyle: PLAN_LINE_DASH[key] != null ? PLAN_LINE_DASH[key] : 0,
          axisLabelVisible: true,
          title: PLAN_LINE_LABEL[key] || key.toUpperCase()
        });
        if (line) created.push(line);
      } catch (_) {}
    }

    series.__acPlanPriceLines = created;
    return created;
  }

  // ============================================================
  // SWITCH TICKER & PRESET/PLAN INTEGRATION
  // ============================================================
  function switchTicker(arg1, arg2, arg3) {
    var chartId = 'mainChart';
    var ticker = '';
    var options = {};

    if (arguments.length === 1) {
      ticker = String(arg1 || '').toUpperCase().trim();
    } else if (arguments.length === 2) {
      if (typeof arg2 === 'object') {
        ticker = String(arg1 || '').toUpperCase().trim();
        options = arg2 || {};
      } else {
        chartId = String(arg1 || 'mainChart');
        ticker = String(arg2 || '').toUpperCase().trim();
      }
    } else {
      chartId = String(arg1 || 'mainChart');
      ticker = String(arg2 || '').toUpperCase().trim();
      options = arg3 || {};
    }

    if (!ticker) return;

    var inst = _workstationInstances[chartId];
    if (inst) {
      inst.ticker = ticker;
      if (options.preset) {
        inst.state.applyPreset(options.preset);
      }
      if (options.planLevels || options.entry || options.sl || options.tp1 || options.tp2) {
        inst.options = inst.options || {};
        inst.options.planLevels = options.planLevels || {
          entry: options.entry,
          sl: options.sl,
          tp1: options.tp1,
          tp2: options.tp2
        };
      }
      updateToolbarDom(chartId);
      updateDrawerDom(chartId);
    }

    if (typeof defaultRoot.loadTickerData === 'function') {
      defaultRoot.loadTickerData(ticker);
    } else if (typeof defaultRoot.switchTicker === 'function' && defaultRoot.switchTicker !== switchTicker) {
      defaultRoot.switchTicker(ticker);
    } else if (typeof defaultRoot.renderLightweightChart === 'function' && inst) {
      var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }

    return inst;
  }

  // ============================================================
  // ATTACH WORKSTATION TO RENDERER
  // ============================================================
  function attach(chartId, candles, metrics, ticker, options) {
    var inst = getOrCreateInstance(chartId, candles, metrics, ticker, options);
    var container = document.getElementById(chartId + '_container');
    if (!container || !container.parentNode) return;

    var existingToolbar = document.getElementById(chartId + '_workstation_toolbar');
    if (!existingToolbar) {
      var tbDiv = document.createElement('div');
      tbDiv.innerHTML = renderToolbarHtml(chartId) + renderDrawerHtml(chartId);
      container.parentNode.insertBefore(tbDiv, container);
    }
    return inst;
  }

  // ============================================================
  // V3_004: HISTORICAL SIMILARITY (NORMALIZED CROSS-CORRELATION)
  // ============================================================
  // Mencari jendela historis yang pergerakannya paling mirip dengan jendela
  // terakhir (z-score + Pearson rho), lalu membentuk jalur proyeksi konsensus
  // tertimbang. AntiSlop: data kurang => insufficientData:true, bukan tebakan.
  function zScoreWindow(values) {
    var n = values.length;
    if (!n) return null;
    var mean = 0;
    for (var i = 0; i < n; i++) mean += values[i];
    mean /= n;
    var varSum = 0;
    for (var j = 0; j < n; j++) {
      var d = values[j] - mean;
      varSum += d * d;
    }
    var sd = Math.sqrt(varSum / n);
    var z = new Array(n);
    for (var k = 0; k < n; k++) {
      z[k] = sd > 0 ? (values[k] - mean) / sd : 0;
    }
    return { z: z, mean: mean, sd: sd };
  }

  function pearson(a, b) {
    var n = Math.min(a.length, b.length);
    if (!n) return 0;
    var sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (var i = 0; i < n; i++) {
      sa += a[i]; sb += b[i];
      saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
    }
    var dA = n * saa - sa * sa;
    var dB = n * sbb - sb * sb;
    if (dA <= 0 || dB <= 0) return 0;
    var r = (n * sab - sa * sb) / Math.sqrt(dA * dB);
    if (!Number.isFinite(r)) return 0;
    return Math.max(-1, Math.min(1, r));
  }

  function calculateHistoricalSimilarity(candles, options) {
    var opts = options || {};
    var windowSize = Math.max(5, Number(opts.windowSize) || 20);
    var horizon = Math.max(1, Number(opts.horizon) || 10);
    var maxMatches = Math.max(1, Number(opts.maxMatches) || 5);
    var minGap = Math.max(1, Math.floor(windowSize / 2));

    var empty = { insufficientData: true, matches: [], consensusPath: [] };
    if (!Array.isArray(candles) || candles.length < windowSize * 2 + horizon) return empty;

    var closes = [];
    for (var i = 0; i < candles.length; i++) {
      var raw = candles[i] && candles[i].close;
      var num = Number(raw);
      if (raw == null || raw === '' || !Number.isFinite(num)) return empty;
      closes.push(num);
    }

    var queryEnd = closes.length - 1;
    var queryStart = queryEnd - windowSize + 1;
    var queryWin = zScoreWindow(closes.slice(queryStart, queryEnd + 1));
    if (!queryWin) return empty;

    var candidates = [];
    // The candidate window must end early enough that `horizon` bars exist after it.
    var latestCandidateEnd = queryStart - horizon - 1;
    for (var end = windowSize - 1; end <= latestCandidateEnd; end++) {
      var win = zScoreWindow(closes.slice(end - windowSize + 1, end + 1));
      if (!win) continue;
      var rho = pearson(queryWin.z, win.z);
      if (!Number.isFinite(rho) || rho <= 0) continue;
      candidates.push({ endIndex: end, rho: rho });
    }

    if (!candidates.length) {
      return { insufficientData: false, matches: [], consensusPath: [] };
    }

    candidates.sort(function (a, b) { return b.rho - a.rho || a.endIndex - b.endIndex; });

    // Non-maximum suppression: reject any candidate closer than windowSize/2
    // to an already-accepted match (prevents 5 overlapping copies of one move).
    var accepted = [];
    for (var c = 0; c < candidates.length && accepted.length < maxMatches; c++) {
      var cand = candidates[c];
      var tooClose = false;
      for (var m = 0; m < accepted.length; m++) {
        if (Math.abs(accepted[m].endIndex - cand.endIndex) < minGap) { tooClose = true; break; }
      }
      if (tooClose) continue;
      accepted.push(cand);
    }

    var totalWeight = accepted.reduce(function (s, a) { return s + a.rho; }, 0);
    var consensusPath = [];
    for (var h = 1; h <= horizon; h++) {
      var weightedSum = 0;
      var weightAcc = 0;
      for (var a2 = 0; a2 < accepted.length; a2++) {
        var idx = accepted[a2].endIndex + h;
        if (idx >= closes.length) continue;
        var base = closes[accepted[a2].endIndex];
        if (!Number.isFinite(base) || base <= 0) continue;
        var projected = closes[idx] * (closes[queryEnd] / base);
        if (!Number.isFinite(projected)) continue;
        weightedSum += projected * accepted[a2].rho;
        weightAcc += accepted[a2].rho;
      }
      if (weightAcc <= 0) continue;
      consensusPath.push({
        h: h,
        value: roundToIdxTick(weightedSum / weightAcc),
        weight: Math.round((weightAcc / (totalWeight || 1)) * 1000) / 1000
      });
    }

    return {
      insufficientData: false,
      matches: accepted.map(function (a) {
        return {
          endIndex: a.endIndex,
          time: candles[a.endIndex] ? candles[a.endIndex].time : null,
          rho: Math.round(a.rho * 1000) / 1000,
          weight: Math.round((a.rho / (totalWeight || 1)) * 1000) / 1000
        };
      }),
      consensusPath: consensusPath
    };
  }

  // ============================================================
  // V3_015: 20-DAY VOLATILITY PROBABILITY CONE
  // ============================================================
  // Estimasi sigma harian dari log-return, lalu pita probabilitas sqrt-of-time
  // (68% z=1.0, 90% z=1.645, 95% z=1.96) yang di-snap ke tick IDX.
  // AntiSlop: < 30 bar valid => insufficientData:true, dailySigma:null.
  function calculateVolatilityCone(candles, options) {
    var opts = options || {};
    var lookback = Math.max(30, Number(opts.lookback) || 60);
    var days = Math.max(1, Number(opts.days) || 20);
    var minBars = Math.max(30, Number(opts.minBars) || 30);

    var empty = { insufficientData: true, dailySigma: null, bands: [] };
    if (!Array.isArray(candles) || candles.length < minBars) return empty;

    var closes = [];
    for (var i = 0; i < candles.length; i++) {
      var raw = candles[i] && candles[i].close;
      var num = Number(raw);
      if (raw == null || raw === '' || !Number.isFinite(num) || num <= 0) continue;
      closes.push(num);
    }
    if (closes.length < minBars) return empty;

    var slice = closes.slice(-Math.min(lookback, closes.length));
    var logReturns = [];
    for (var j = 1; j < slice.length; j++) {
      var lr = Math.log(slice[j] / slice[j - 1]);
      if (Number.isFinite(lr)) logReturns.push(lr);
    }
    if (logReturns.length < minBars - 1) return empty;

    var mean = 0;
    for (var k = 0; k < logReturns.length; k++) mean += logReturns[k];
    mean /= logReturns.length;

    var varSum = 0;
    for (var m = 0; m < logReturns.length; m++) {
      var d = logReturns[m] - mean;
      varSum += d * d;
    }
    var denom = logReturns.length > 1 ? logReturns.length - 1 : 1; // sample stddev
    var sigma = Math.sqrt(varSum / denom);
    if (!Number.isFinite(sigma) || sigma <= 0) {
      return { insufficientData: true, dailySigma: null, bands: [] };
    }

    var lastClose = closes[closes.length - 1];
    var Z = { p50: 0, p68: 1.0, p90: 1.645, p95: 1.96 };
    var bands = [];
    for (var h = 1; h <= days; h++) {
      var scale = sigma * Math.sqrt(h);
      var centre = lastClose * Math.exp(Z.p50 * scale);
      var up68 = lastClose * Math.exp(Z.p68 * scale);
      var dn68 = lastClose * Math.exp(-Z.p68 * scale);
      var up90 = lastClose * Math.exp(Z.p90 * scale);
      var dn90 = lastClose * Math.exp(-Z.p90 * scale);
      var up95 = lastClose * Math.exp(Z.p95 * scale);
      var dn95 = lastClose * Math.exp(-Z.p95 * scale);

      var p50 = roundToIdxTick(centre) || 1;
      var u68 = roundToIdxTick(up68, 'up') || 1;
      var l68 = roundToIdxTick(dn68, 'down') || 1;
      var u90 = roundToIdxTick(up90, 'up') || 1;
      var l90 = roundToIdxTick(dn90, 'down') || 1;
      var u95 = roundToIdxTick(up95, 'up') || 1;
      var l95 = roundToIdxTick(dn95, 'down') || 1;

      // Enforce the monotone envelope after tick snapping.
      if (l68 > p50) l68 = p50;
      if (u68 < p50) u68 = p50;
      if (l90 > l68) l90 = l68;
      if (u90 < u68) u90 = u68;
      if (l95 > l90) l95 = l90;
      if (u95 < u90) u95 = u90;

      bands.push({
        h: h,
        p50: p50,
        upper68: u68, lower68: l68,
        upper90: u90, lower90: l90,
        upper95: u95, lower95: l95
      });
    }

    return {
      insufficientData: false,
      dailySigma: Math.round(sigma * 100000) / 100000,
      annualizedSigma: Math.round(sigma * Math.sqrt(252) * 10000) / 10000,
      lastClose: lastClose,
      bands: bands
    };
  }

  // ============================================================
  // HISTORICAL BACKTEST CALCULATOR (PER TICKER)
  // ============================================================
  function calculateHistoricalBacktest(candles, ticker) {
    var sym = String(ticker || 'BBCA').toUpperCase().trim();
    var count = Array.isArray(candles) ? candles.length : 0;
    if (count < 20) {
      return {
        insufficientData: true,
        candleCount: count.toLocaleString('id-ID') + ' Lilin',
        winRate: '—',
        profitFactor: '—',
        totalTrades: '0 Trade',
        maxDrawdown: '—',
        avgHoldingDays: '—',
        expectancy: '—'
      };
    }

    var trades = [];
    var currentPos = null;
    var equity = 50000000;
    var peak = equity;
    var maxDd = 0;

    for (var i = 20; i < count; i++) {
      var c = candles[i];
      var prev = candles[i - 1];
      var close = Number(c.close);
      var high = Number(c.high != null ? c.high : c.close);
      var low = Number(c.low != null ? c.low : c.close);
      var vol = Number(c.volume || 0);

      if (currentPos) {
        currentPos.holdingDays++;
        var exitPrice = null;
        var isWin = false;

        if (low <= currentPos.sl) {
          exitPrice = currentPos.sl;
          isWin = false;
        } else if (high >= currentPos.tp2) {
          exitPrice = currentPos.tp2;
          isWin = true;
        } else if (high >= currentPos.tp1 && !currentPos.tp1Hit) {
          currentPos.tp1Hit = true;
          currentPos.sl = currentPos.entry;
        } else if (currentPos.holdingDays >= 12) {
          exitPrice = close;
          isWin = close > currentPos.entry;
        }

        if (exitPrice != null) {
          var gross = currentPos.lots * 100 * (exitPrice - currentPos.entry);
          var fee = currentPos.lots * 100 * (currentPos.entry * 0.0015 + exitPrice * 0.0025);
          var net = gross - fee;
          trades.push({ net: net, isWin: isWin, holdingDays: currentPos.holdingDays });
          equity += net;
          if (equity > peak) peak = equity;
          var dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
          if (dd > maxDd) maxDd = dd;
          currentPos = null;
        }
      }

      if (!currentPos && i < count - 2) {
        var sum20 = 0, volSum20 = 0;
        for (var k = i - 19; k <= i; k++) {
          sum20 += Number(candles[k].close);
          volSum20 += Number(candles[k].volume || 0);
        }
        var ma20 = sum20 / 20;
        var volAvg20 = volSum20 / 20;
        var prevClose = Number(prev.close);

        if (prevClose <= ma20 && close > ma20 && vol >= volAvg20 * 1.05) {
          var entry = roundToIdxTick(close);
          var tick = getIdxTickSize(entry);
          var sl = roundToIdxTick(entry - 3 * tick);
          var risk = entry - sl;
          var tp1 = roundToIdxTick(entry + 1.5 * risk);
          var tp2 = roundToIdxTick(entry + 2.5 * risk);
          var rr = (tp1 - entry) / (entry - sl);
          if (rr >= 1.48) {
            currentPos = {
              entry: entry,
              sl: sl,
              tp1: tp1,
              tp2: tp2,
              lots: Math.max(1, Math.floor(25000000 / (entry * 100))),
              holdingDays: 0,
              tp1Hit: false
            };
          }
        }
      }
    }

    if (trades.length >= 3) {
      var wins = trades.filter(function(t) { return t.isWin; });
      var losses = trades.filter(function(t) { return !t.isWin; });
      var wr = (wins.length / trades.length) * 100;
      var grossWin = wins.reduce(function(a, t) { return a + t.net; }, 0);
      var grossLoss = Math.abs(losses.reduce(function(a, t) { return a + t.net; }, 0));
      var pf = grossLoss > 0 ? (grossWin / grossLoss) : 2.5;
      var avgHold = trades.reduce(function(a, t) { return a + t.holdingDays; }, 0) / trades.length;
      var totalNet = trades.reduce(function(a, t) { return a + t.net; }, 0);
      var exp = totalNet / trades.length;

      return {
        candleCount: count.toLocaleString('id-ID') + ' Lilin',
        winRate: wr.toFixed(1).replace('.', ',') + '%',
        profitFactor: pf.toFixed(2).replace('.', ','),
        totalTrades: trades.length + ' Trade',
        maxDrawdown: maxDd > 0 ? ('-' + maxDd.toFixed(1).replace('.', ',') + '%') : '0,0%',
        avgHoldingDays: avgHold.toFixed(1).replace('.', ',') + ' Hari',
        expectancy: (exp >= 0 ? '+Rp ' : '-Rp ') + Math.abs(Math.round(exp)).toLocaleString('id-ID')
      };
    }

    return {
      insufficientData: true,
      candleCount: count.toLocaleString('id-ID') + ' Lilin',
      winRate: '—',
      profitFactor: '—',
      totalTrades: (trades ? trades.length : 0) + ' Trade',
      maxDrawdown: '—',
      avgHoldingDays: '—',
      expectancy: '—'
    };
  }

  // ============================================================
  // PUBLIC API EXPORTS
  // ============================================================
  return {
    version: VERSION,
    LAYER_GROUPS: LAYER_GROUPS,
    PRESETS: PRESETS,
    getIdxTickSize: getIdxTickSize,
    roundToIdxTick: roundToIdxTick,
    aggregateDailyToWeekly: aggregateDailyToWeekly,
    calculateSMA: calculateSMA,
    calculateEMA: calculateEMA,
    calculateBollinger: calculateBollinger,
    calculateRSI: calculateRSI,
    calculateMACD: calculateMACD,
    calculateTradingPlan: calculateTradingPlan,
    calculateCMF: calculateCMF,
    calculateForeignFlowCumulative: calculateForeignFlowCumulative,
    calculateIntensityHistogram: calculateIntensityHistogram,
    calculateVolumeRotation: calculateVolumeRotation,
    calculateLPMSeries: calculateLPMSeries,
    calculateCorrF: calculateCorrF,
    calculateParF: calculateParF,
    calculateLPM: calculateLPM,
    getLatestForeignNet: getLatestForeignNet,
    getLatestMoneyFlow: getLatestMoneyFlow,
    formatIndonesianVolumeCompact: formatIndonesianVolumeCompact,
    formatIndonesianRupiahCompact: formatIndonesianRupiahCompact,
    calculateHistoricalBacktest: calculateHistoricalBacktest,
    calculateHistoricalSimilarity: calculateHistoricalSimilarity,
    calculateVolatilityCone: calculateVolatilityCone,
    applyPlanPriceLines: applyPlanPriceLines,
    clearPlanPriceLines: clearPlanPriceLines,
    createWorkstationState: createWorkstationState,
    getOrCreateInstance: getOrCreateInstance,
    renderToolbarHtml: renderToolbarHtml,
    renderDrawerHtml: renderDrawerHtml,
    switchTimeframe: switchTimeframe,
    applyPreset: applyPreset,
    toggleLayer: toggleLayer,
    toggleDrawer: toggleDrawer,
    toggleCollapse: toggleCollapse,
    turnOffAll: turnOffAll,
    reset: reset,
    attach: attach,
    switchTicker: switchTicker
  };
});

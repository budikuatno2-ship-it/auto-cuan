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
        { id: 'market_structure', name: 'Break of Structure (BOS)', desc: 'Penembusan Swing High (Bullish BOS) & Swing Low (Bearish BOS)', color: '#06b6d4', default: false }
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
        { id: 'vol_profile', name: 'Volume Profile (POC / VAH / VAL)', desc: 'Point of Control dan Value Area (70% Volume)', color: '#f59e0b', default: false }
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
        { id: 'bandar_lpm', name: 'LPM · kurva tekanan candle', desc: 'Dihitung dari candle harian (OHLCV), bukan data transaksi. Tampil bersama Money Flow di legenda; komponen asing belum digabung', color: '#10b981', default: false },
        { id: 'bandar_foreign', name: 'Kumulatif Aliran Asing', desc: 'Akumulasi beli/jual bersih investor asing', color: '#3b82f6', default: false },
        { id: 'bandar_cmf', name: 'Smart Money Flow (CMF)', desc: 'Aliran uang pintar berbasis posisi penutupan', color: '#f97316', default: false },
        { id: 'bandar_intensity', name: 'Histogram Intensitas Bandar', desc: 'Lonjakan intensitas omzet transaksi harian', color: '#8b5cf6', default: false },
        { id: 'bandar_rotation', name: 'Histogram Rotasi Volume', desc: 'Klasifikasi rotasi 3-warna (Akumulasi / Distribusi / Transisi)', color: '#10b981', default: false },
        { id: 'bandar_corr_f', name: 'Korelasi Harga-Asing (Corr F)', desc: 'Tingkat korelasi harga saham terhadap aliran asing', default: true },
        { id: 'bandar_par_f', name: 'Partisipasi Asing (Par F)', desc: 'Porsi transaksi asing terhadap total pasar', default: true },
        { id: 'bandar_kons', name: 'Konsistensi broker', desc: 'Pembeli bersih terbesar 20 hari: hari net buy dari 10 hari terakhir dan hari beruntun', color: '#2C3E8F', default: false },
        { id: 'bandar_tekanan_broker', name: 'Tekanan Broker', desc: 'Tekanan akumulasi/distribusi dari broker summary harian', color: '#38bdf8', default: false },
        { id: 'bandar_avg_price', name: 'Harga rata-rata bandar', desc: 'Volume Weighted Average Price (VWAP) broker pembeli bersih terbesar', color: '#f59e0b', default: false }
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
      layers: ['ma50', 'ma200', 'volume_bars', 'sr_levels', 'bandar_lpm', 'bandar_foreign', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f', 'bandar_kons']
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      description: 'Analisis mendalam penuh: Semua layer teknikal, osilator, dan seluruh instrumen Bandar Metrics aktif',
      layers: ['ma20', 'ma50', 'ma100', 'ma200', 'bollinger', 'fibonacci', 'volume_bars', 'sr_levels', 'trading_plan', 'bandar_lpm', 'bandar_foreign', 'bandar_cmf', 'bandar_intensity', 'bandar_rotation', 'bandar_corr_f', 'bandar_par_f', 'bandar_kons']
    }
  };

  // ============================================================
  // 5 DYNAMIC MODE STRATEGY CONFIGURATIONS
  // ============================================================
  var MODE_STRATEGY_CONFIG = {
    simpel: {
      id: 'simpel',
      name: 'Simpel (Swing Standar)',
      lookbackSR: 20,
      slBufferPct: 0.97,
      slMaxPct: 0.95,
      tp1Multiplier: 1.6,
      tp2Multiplier: 2.8,
      maxHoldingDays1D: 12,
      maxHoldingDays1W: 6,
      volAvgMultiplier: 1.05,
      strategyType: 'swing'
    },
    scalping: {
      id: 'scalping',
      name: 'Scalping (Momentum Kilat)',
      lookbackSR: 8,
      slBufferPct: 0.985,
      slMaxPct: 0.975,
      slTicks: 3,
      tp1Multiplier: 1.5,
      tp2Multiplier: 2.5,
      maxHoldingDays1D: 3,
      maxHoldingDays1W: 2,
      volAvgMultiplier: 1.15,
      strategyType: 'scalping'
    },
    swing: {
      id: 'swing',
      name: 'Swing (Trend Following)',
      lookbackSR: 20,
      slBufferPct: 0.965,
      slMaxPct: 0.95,
      tp1Multiplier: 1.6,
      tp2Multiplier: 2.8,
      maxHoldingDays1D: 12,
      maxHoldingDays1W: 6,
      volAvgMultiplier: 1.05,
      strategyType: 'swing'
    },
    investor: {
      id: 'investor',
      name: 'Investor (Posisi Jangka Panjang)',
      lookbackSR: 60,
      slBufferPct: 0.92,
      slMaxPct: 0.90,
      tp1Multiplier: 1.8,
      tp2Multiplier: 3.5,
      maxHoldingDays1D: 45,
      maxHoldingDays1W: 16,
      volAvgMultiplier: 1.0,
      strategyType: 'investor'
    },
    pro: {
      id: 'pro',
      name: 'Pro (Multi-Factor Kuantitatif)',
      lookbackSR: 30,
      slBufferPct: 0.96,
      slMaxPct: 0.94,
      tp1Multiplier: 1.75,
      tp2Multiplier: 3.0,
      maxHoldingDays1D: 15,
      maxHoldingDays1W: 8,
      volAvgMultiplier: 1.05,
      strategyType: 'pro'
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
      var fNet = Number(c.foreign_net_value != null ? c.foreign_net_value : (c.foreign_net || 0));
      var fBuy = Number(c.foreignBuy != null ? c.foreignBuy : (c.foreign_buy || 0));
      var fSell = Number(c.foreignSell != null ? c.foreignSell : (c.foreign_sell || 0));

      if (!weeksMap[mondayKey]) {
        weeksMap[mondayKey] = {
          time: mondayKey,
          open: Number(c.open || c.close),
          high: Number(c.high || c.close),
          low: Number(c.low || c.close),
          close: Number(c.close),
          volume: Number(c.volume || 0),
          candlesCount: 1,
          foreignBuy: fBuy,
          foreignSell: fSell,
          foreign_buy: fBuy,
          foreign_sell: fSell,
          foreign_net: fNet,
          foreign_net_value: fNet
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
        w.foreignBuy += fBuy;
        w.foreignSell += fSell;
        w.foreign_buy = w.foreignBuy;
        w.foreign_sell = w.foreignSell;
        w.foreign_net = (w.foreign_net || 0) + fNet;
        w.foreign_net_value = w.foreign_net;
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
  function calculateTradingPlan(candles, customPlan, mode, timeframe) {
    if (!candles || candles.length < 5) return null;
    mode = (mode || 'swing').toLowerCase();
    timeframe = timeframe || '1D';
    var strat = MODE_STRATEGY_CONFIG[mode] || MODE_STRATEGY_CONFIG.swing;

    var latest = candles[candles.length - 1];
    var lastPrice = Number(latest && latest.close);

    // If latest candle has invalid or non-positive close, search backwards for the last valid bar
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      for (var ci = candles.length - 2; ci >= 0; ci--) {
        var candClose = Number(candles[ci] && candles[ci].close);
        if (Number.isFinite(candClose) && candClose > 0) {
          latest = candles[ci];
          lastPrice = candClose;
          break;
        }
      }
    }
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

    var entry = customPlan && customPlan.entry ? roundToIdxTick(Number(customPlan.entry)) : roundToIdxTick(lastPrice);
    if (!entry || entry <= 0) entry = roundToIdxTick(lastPrice);
    if (!entry || entry <= 0) entry = Math.max(1, Math.round(lastPrice));

    // Support is derived from CLOSED bars only.
    var minLow = Infinity;
    var closedCandles = candles.length > 1 ? candles.slice(0, candles.length - 1) : candles;
    var lookback = Math.min(strat.lookbackSR, closedCandles.length);
    for (var i = closedCandles.length - lookback; i < closedCandles.length; i++) {
      var lo = Number(closedCandles[i] && closedCandles[i].low);
      if (Number.isFinite(lo) && lo > 0 && lo < minLow) minLow = lo;
    }
    if (!Number.isFinite(minLow) || minLow <= 0) minLow = Number(lastPrice) || 1;

    var sl;
    if (customPlan && customPlan.sl) {
      sl = roundToIdxTick(Number(customPlan.sl), 'down');
    } else if (strat.slTicks) {
      var tick = getIdxTickSize(entry);
      sl = roundToIdxTick(entry - (strat.slTicks * tick), 'down');
      if (sl > minLow && minLow > 0) sl = roundToIdxTick(minLow, 'down');
    } else {
      sl = roundToIdxTick(minLow * strat.slBufferPct, 'down');
    }
    if (sl >= entry) sl = roundToIdxTick(entry * (strat.slMaxPct || 0.96), 'down');
    if (sl <= 0) sl = Math.max(1, entry - getIdxTickSize(entry));

    var risk = entry - sl;
    if (risk <= 0) risk = getIdxTickSize(entry);

    var tp1Mult = strat.tp1Multiplier || 1.5;
    var tp2Mult = strat.tp2Multiplier || 2.5;
    var minReward = Math.round(risk * tp1Mult);

    var tp1 = customPlan && customPlan.tp1 ? roundToIdxTick(Number(customPlan.tp1), 'up') : roundToIdxTick(entry + minReward, 'up');
    var tp2 = customPlan && customPlan.tp2 ? roundToIdxTick(Number(customPlan.tp2), 'up') : roundToIdxTick(entry + Math.round(risk * tp2Mult), 'up');
    if (tp1 <= entry) tp1 = entry + Math.max(1, Math.round(risk * tp1Mult));
    if (tp2 <= tp1) tp2 = entry + Math.max(2, Math.round(risk * tp2Mult));

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
      // Activity measurement (always >= 0): volume ratio weighted by candle body dominance
      // Formula: (volume / volSma20) * (Math.abs(close - open) / (high - low || 1))
      var bodyRatio = range > 0 ? (body / range) : 0.5;
      var rawIntensity = volRatio * (0.4 + 0.6 * bodyRatio);
      var score = Math.round(rawIntensity * 100) / 100;
      if (score < 0) score = 0;

      // Color coding according to Auto-Cuan indicator rules:
      // Hijau jika close >= open (aktivitas didominasi buyer)
      // Merah jika close < open (aktivitas didominasi seller)
      // Kuning / oranye jika Intensity >= 2.0 (lonjakan intensitas ekstrem / anomali)
      var color = '#10b981'; // buyer dominant
      if (score >= 2.0) {
        color = '#f59e0b'; // lonjakan intensitas anomali (> 2.0x)
      } else if (close < open) {
        color = '#ef4444'; // seller dominant
      }

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
    var cumLiq = 0;
    var cumLiqArr = [];

    // 1. Calculate Money Flow / Liquidity Pressure & accumulate cumLiq
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var high = Number(c.high != null ? c.high : c.close);
      var low = Number(c.low != null ? c.low : c.close);
      var close = Number(c.close);
      var vol = Number(c.volume || 0);
      var turnover = vol * close;
      var range = high - low;
      // mfMult = ((c - l) - (h - c)) / (h - l || 1)
      var mfMult = range > 0 ? ((close - low) - (high - close)) / range : 0;
      var liqPressure = mfMult * turnover;
      cumLiq += liqPressure;
      cumLiqArr.push(cumLiq);
    }

    // 2. Project cumLiq to the running price range of the stock
    for (var i = 0; i < candles.length; i++) {
      var p = Math.min(i + 1, windowPeriod);
      var startIdx = i - p + 1;

      var pSum = 0;
      var pMin = Infinity;
      var pMax = -Infinity;
      var clSum = 0;
      var clMin = Infinity;
      var clMax = -Infinity;

      for (var j = startIdx; j <= i; j++) {
        var cj = Number(candles[j].close);
        var hj = Number(candles[j].high != null ? candles[j].high : cj);
        var lj = Number(candles[j].low != null ? candles[j].low : cj);
        pSum += cj;
        if (lj < pMin) pMin = lj;
        if (hj > pMax) pMax = hj;

        var cl = cumLiqArr[j];
        clSum += cl;
        if (cl < clMin) clMin = cl;
        if (cl > clMax) clMax = cl;
      }

      var pAvg = pSum / p;
      var clAvg = clSum / p;
      var halfPriceRange = Math.max((pMax - pMin) / 2, pAvg * 0.02);
      var clHalfRange = (clMax - clMin) / 2;

      var normPressure = clHalfRange > 0 ? (cumLiqArr[i] - clAvg) / clHalfRange : 0;
      if (normPressure > 1.5) normPressure = 1.5;
      if (normPressure < -1.5) normPressure = -1.5;

      // Project into price space: When smart money is heavily buying (cumLiq rising),
      // LPM line rises sharply above the price candles, creating Bullish LPM Divergence!
      var lpmValue = Math.round(pAvg + (normPressure * halfPriceRange * 1.35));
      out.push({ time: candles[i].time, value: lpmValue });
    }
    return out;
  }

  // ============================================================
  // PIVOT EXTRACTOR & ADVANCED S/R (FRACTAL 3-BAR/5-BAR)
  // ============================================================
  function calculateSwingPivots(candles, lookback) {
    lookback = Math.min(Number(lookback) || 30, candles.length);
    if (!candles || candles.length < 5) return { support: null, resistance: null, swingHighs: [], swingLows: [] };
    var startIdx = Math.max(0, candles.length - lookback);
    var swingHighs = [];
    var swingLows = [];

    for (var i = startIdx + 2; i < candles.length - 2; i++) {
      var c = candles[i];
      var h = Number(c.high != null ? c.high : c.close);
      var l = Number(c.low != null ? c.low : c.close);

      // 5-bar Fractal Swing High
      var hPrev1 = Number(candles[i - 1].high != null ? candles[i - 1].high : candles[i - 1].close);
      var hPrev2 = Number(candles[i - 2].high != null ? candles[i - 2].high : candles[i - 2].close);
      var hNext1 = Number(candles[i + 1].high != null ? candles[i + 1].high : candles[i + 1].close);
      var hNext2 = Number(candles[i + 2].high != null ? candles[i + 2].high : candles[i + 2].close);

      if (h > hPrev1 && h > hPrev2 && h >= hNext1 && h > hNext2) {
        swingHighs.push({ time: c.time, price: h, index: i });
      }

      // 5-bar Fractal Swing Low
      var lPrev1 = Number(candles[i - 1].low != null ? candles[i - 1].low : candles[i - 1].close);
      var lPrev2 = Number(candles[i - 2].low != null ? candles[i - 2].low : candles[i - 2].close);
      var lNext1 = Number(candles[i + 1].low != null ? candles[i + 1].low : candles[i + 1].close);
      var lNext2 = Number(candles[i + 2].low != null ? candles[i + 2].low : candles[i + 2].close);

      if (l < lPrev1 && l < lPrev2 && l <= lNext1 && l < lNext2) {
        swingLows.push({ time: c.time, price: l, index: i });
      }
    }

    var lastClose = Number(candles[candles.length - 1].close);
    var resPivot = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : null;
    var supPivot = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : null;

    // Fallback to min/max if no fractals
    if (!resPivot) {
      var maxH = -Infinity;
      for (var hi = startIdx; hi < candles.length; hi++) {
        var ch = Number(candles[hi].high != null ? candles[hi].high : candles[hi].close);
        if (ch > maxH) maxH = ch;
      }
      resPivot = maxH > 0 && Number.isFinite(maxH) ? maxH : lastClose * 1.05;
    }
    if (!supPivot) {
      var minL = Infinity;
      for (var li = startIdx; li < candles.length; li++) {
        var cl = Number(candles[li].low != null ? candles[li].low : candles[li].close);
        if (cl < minL) minL = cl;
      }
      supPivot = minL > 0 && Number.isFinite(minL) ? minL : lastClose * 0.95;
    }

    return {
      resistance: roundToIdxTick(resPivot),
      support: roundToIdxTick(supPivot),
      swingHighs: swingHighs,
      swingLows: swingLows
    };
  }

  // ============================================================
  // BREAK OF STRUCTURE (BOS) CALCULATOR
  // ============================================================
  function calculateBOS(candles) {
    if (!candles || candles.length < 15) return { events: [], lines: [], latestStatus: 'NETRAL' };
    var pivots = calculateSwingPivots(candles, Math.min(60, candles.length));
    var events = [];
    var lines = [];
    var latestClose = Number(candles[candles.length - 1].close);

    // Check for Bullish BOS (Close breaks above recent Swing High)
    if (pivots.swingHighs.length > 0) {
      var lastSh = pivots.swingHighs[pivots.swingHighs.length - 1];
      var isBullishBOS = latestClose > lastSh.price;
      lines.push({
        price: lastSh.price,
        color: '#06b6d4',
        title: 'BOS High: Rp ' + lastSh.price.toLocaleString('id-ID'),
        type: 'high'
      });
      if (isBullishBOS) {
        events.push({
          type: 'BULLISH_BOS',
          label: 'Bullish BOS Terkonfirmasi',
          level: lastSh.price,
          time: candles[candles.length - 1].time
        });
      }
    }

    // Check for Bearish BOS (Close breaks below recent Swing Low)
    if (pivots.swingLows.length > 0) {
      var lastSl = pivots.swingLows[pivots.swingLows.length - 1];
      var isBearishBOS = latestClose < lastSl.price;
      lines.push({
        price: lastSl.price,
        color: '#ec4899',
        title: 'BOS Low: Rp ' + lastSl.price.toLocaleString('id-ID'),
        type: 'low'
      });
      if (isBearishBOS) {
        events.push({
          type: 'BEARISH_BOS',
          label: 'Bearish BOS Terkonfirmasi',
          level: lastSl.price,
          time: candles[candles.length - 1].time
        });
      }
    }

    return {
      events: events,
      lines: lines,
      latestStatus: events.length > 0 ? events[events.length - 1].label : 'Dalam Struktur Konsolidasi'
    };
  }

  // ============================================================
  // VOLUME PROFILE (POC, VAH, VAL) CALCULATOR
  // ============================================================
  function calculateVolumeProfile(candles, numBins) {
    numBins = numBins || 12;
    if (!candles || candles.length < 5) return null;
    var lookback = Math.min(60, candles.length);
    var slice = candles.slice(-lookback);

    var minPrice = Infinity;
    var maxPrice = -Infinity;
    for (var i = 0; i < slice.length; i++) {
      var h = Number(slice[i].high != null ? slice[i].high : slice[i].close);
      var l = Number(slice[i].low != null ? slice[i].low : slice[i].close);
      if (h > maxPrice) maxPrice = h;
      if (l < minPrice) minPrice = l;
    }
    if (maxPrice <= minPrice || !Number.isFinite(maxPrice) || !Number.isFinite(minPrice)) return null;

    var binSize = (maxPrice - minPrice) / numBins;
    var bins = [];
    for (var b = 0; b < numBins; b++) {
      bins.push({
        low: minPrice + b * binSize,
        high: minPrice + (b + 1) * binSize,
        mid: minPrice + (b + 0.5) * binSize,
        volume: 0
      });
    }

    var totalVolume = 0;
    for (var j = 0; j < slice.length; j++) {
      var c = slice[j];
      var typical = (Number(c.high || c.close) + Number(c.low || c.close) + Number(c.close)) / 3;
      var vol = Number(c.volume || 0);
      totalVolume += vol;

      var binIdx = Math.min(numBins - 1, Math.max(0, Math.floor((typical - minPrice) / binSize)));
      bins[binIdx].volume += vol;
    }

    // Find POC (Point of Control = bin with highest volume)
    var maxBinVol = -1;
    var pocBinIdx = 0;
    for (var k = 0; k < numBins; k++) {
      if (bins[k].volume > maxBinVol) {
        maxBinVol = bins[k].volume;
        pocBinIdx = k;
      }
    }
    var poc = roundToIdxTick(bins[pocBinIdx].mid);

    // Value Area (70% of total volume around POC)
    var targetVA = totalVolume * 0.70;
    var vaVol = bins[pocBinIdx].volume;
    var upIdx = pocBinIdx;
    var dnIdx = pocBinIdx;

    while (vaVol < targetVA && (upIdx < numBins - 1 || dnIdx > 0)) {
      var nextUpVol = upIdx < numBins - 1 ? bins[upIdx + 1].volume : 0;
      var nextDnVol = dnIdx > 0 ? bins[dnIdx - 1].volume : 0;
      if (nextUpVol >= nextDnVol && upIdx < numBins - 1) {
        upIdx++;
        vaVol += bins[upIdx].volume;
      } else if (dnIdx > 0) {
        dnIdx--;
        vaVol += bins[dnIdx].volume;
      } else if (upIdx < numBins - 1) {
        upIdx++;
        vaVol += bins[upIdx].volume;
      } else {
        break;
      }
    }

    var vah = roundToIdxTick(bins[upIdx].high, 'up');
    var val = roundToIdxTick(bins[dnIdx].low, 'down');

    return {
      poc: poc,
      vah: vah,
      val: val,
      bins: bins,
      totalVolume: totalVolume
    };
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
    var series = calculateLPMSeries(candles, windowPeriod);
    if (series && series.length > 0) {
      return series[series.length - 1].value;
    }
    return Number(candles[candles.length - 1].close);
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
    if (latest && latest.foreign_net_value != null && Number.isFinite(Number(latest.foreign_net_value))) return Number(latest.foreign_net_value);
    if (latest && latest.foreign_net != null && Number.isFinite(Number(latest.foreign_net))) return Number(latest.foreign_net);
    if (Array.isArray(foreignFlow) && foreignFlow.length > 0) {
      var latestFf = foreignFlow[foreignFlow.length - 1];
      if (latestFf) {
        var val = latestFf.foreign_net != null ? latestFf.foreign_net : (latestFf.net != null ? latestFf.net : latestFf.net_value);
        if (val != null && Number.isFinite(Number(val))) return Number(val);
      }
    }
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
      range: null,
      chartCollapsed: false,
      customTradingPlan: null,

      applyPreset: function (presetName) {
        var p = PRESETS[presetName];
        if (!p) return false;
        this.activePreset = presetName;
        this.range = null;
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

  // Redesign v2 toolbar (canvas Analisis.dc.html mode bar): MODE and TF as
  // segmented controls, then layers, "Satu layar" and the price-scale
  // buttons. The handlers are the existing ones.
  function renderToolbarHtml(chartId) {
    var inst = _workstationInstances[chartId];
    var state = inst ? inst.state : createWorkstationState('simpel');
    var tf = state.timeframe || '1D';
    var preset = state.activePreset || 'simpel';
    var count = state.getActiveLayerCount();
    var q = "'" + chartId + "'";
    function seg(on, label, call, extra) {
      return '<button type="button" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" onclick="' + call + '"' + (extra || '') + '>' + label + '</button>';
    }
    var presets = [['simpel', 'Simpel'], ['scalping', 'Scalping'], ['swing', 'Swing'], ['investor', 'Investor'], ['pro', 'Pro']];
    var range = activeRange(state);

    var html = '<div id="' + chartId + '_workstation_toolbar" class="chart-workstation-toolbar cw-bar" data-ac-ui="v2">' +
      '<div class="cw-group"><span class="cw-l">Mode</span>' +
        '<div class="segx cw-seg" role="group" aria-label="Pilih Preset Chart">' +
          presets.map(function (p) { return seg(preset === p[0], p[1], 'AutoCuanChartWorkstation.applyPreset(' + q + ', \'' + p[0] + '\')'); }).join('') +
        '</div>' +
        '<span class="cw-l">TF</span>' +
        '<div class="segx cw-seg" role="group" aria-label="Pilih Timeframe">' +
          seg(tf === '1D', '1D', 'AutoCuanChartWorkstation.switchTimeframe(' + q + ', \'1D\')') +
          seg(tf === '1W', '1W', 'AutoCuanChartWorkstation.switchTimeframe(' + q + ', \'1W\')') +
        '</div>' +
        '<span class="cw-l">Rentang</span>' +
        '<div class="segx cw-seg" role="group" aria-label="Pilih rentang">' +
          RANGES.map(function (r) { return seg(range === r[0], r[1], 'AutoCuanChartWorkstation.setRange(' + q + ', \'' + r[0] + '\')', ' title="' + r[2] + '"'); }).join('') +
        '</div>' +
      '</div>' +
      '<div class="cw-group cw-right">' +
        '<span class="cw-hint">Ctrl + scroll = zoom</span>' +
        '<button type="button" class="vbtn sm" onclick="AutoCuanChartWorkstation.toggleOneScreen(' + q + ')" title="Satu layar (F, tutup dengan Esc)" aria-keyshortcuts="F">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>Satu layar</button>' +
        '<button type="button" class="vbtn sm" onclick="AutoCuanChartWorkstation.toggleDrawer(' + q + ')" aria-label="Buka pengaturan mode dan layer">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/></svg>Mode &amp; Layer ' +
          '<span id="' + chartId + '_layer_badge" class="cw-count">' + count + ' Layer Aktif</span></button>' +
        '<span class="cw-scale" role="group" aria-label="Skala harga">' +
          '<button type="button" class="vbtn sm" onclick="AutoCuanChartWorkstation.scalePrice(' + q + ', \'out\')" aria-label="Perkecil skala harga" title="Perkecil skala harga">&minus;</button>' +
          '<button type="button" class="vbtn sm" onclick="AutoCuanChartWorkstation.scalePrice(' + q + ', \'in\')" aria-label="Perbesar skala harga" title="Perbesar skala harga">+</button>' +
          '<button type="button" class="vbtn sm" onclick="AutoCuanChartWorkstation.scalePrice(' + q + ', \'auto\')" aria-label="Skala harga otomatis" title="Skala otomatis">Auto</button>' +
        '</span>' +
        '<button type="button" id="' + chartId + '_collapse_btn" class="vbtn sm q" onclick="AutoCuanChartWorkstation.toggleCollapse(' + q + ')">Sembunyikan Chart</button>' +
        '<button type="button" class="vbtn sm q" onclick="AutoCuanChartWorkstation.turnOffAll(' + q + ')" title="Matikan semua layer opsional">Matikan Semua</button>' +
        '<button type="button" class="vbtn sm q" onclick="AutoCuanChartWorkstation.reset(' + q + ')" title="Kembalikan ke preset Simpel">Reset</button>' +
      '</div>' +
    '</div>';
    return html;
  }

  // Price-scale zoom (HANDOFF 5a): + / - narrow or widen the visible price
  // range around the last close, so the last price stays put; Auto returns
  // to the library's own autoscale. Ticker/timeframe changes re-create the
  // series, which drops back to Auto by itself.
  function scalePrice(chartId, dir) {
    var reg = defaultRoot && defaultRoot.__chartRegistry ? defaultRoot.__chartRegistry[chartId] : null;
    var chart = reg && reg.mainChart, series = reg && reg.candleSeries;
    if (!chart || !series) return;
    var others = (reg.allSeries || []).filter(function (x) { return x.scale === 'right'; }).map(function (x) { return x.series; });
    if (dir === 'auto') {
      // Options merge ignores undefined, so hand back the built-in autoscale.
      var builtIn = function (base) { return base(); };
      series.applyOptions({ autoscaleInfoProvider: builtIn });
      others.forEach(function (sr) { try { sr.applyOptions({ autoscaleInfoProvider: builtIn }); } catch (_) {} });
      chart.priceScale('right').applyOptions({ autoScale: true });
      if (reg.hiLo) reg.hiLo.refresh();
      return;
    }
    // Visible price span of the pane, minus the scale margins the library
    // adds around the data range (otherwise each step would widen it again).
    var el = typeof document !== 'undefined' ? document.getElementById(chartId + '_container') : null;
    var paneH = (typeof chart.paneSize === 'function' && chart.paneSize().height) || (el ? el.clientHeight - chart.timeScale().height() : 0);
    if (!(paneH > 0)) return;
    var visTop = series.coordinateToPrice(0), visBottom = series.coordinateToPrice(paneH);
    var m = (chart.priceScale('right').options() || {}).scaleMargins || { top: 0.2, bottom: 0.1 };
    var span = visTop - visBottom;
    var top = visTop - span * m.top, bottom = visBottom + span * m.bottom;
    var last = reg.lastClose;
    if (!(top > 0) || !(bottom > 0) || !(last > 0) || !(top > bottom)) return;
    var f = dir === 'in' ? 0.8 : 1.25;
    var minV = last - (last - bottom) * f, maxV = last + (top - last) * f;
    if (!(maxV > minV)) return;
    series.applyOptions({ autoscaleInfoProvider: function () { return { priceRange: { minValue: minV, maxValue: maxV } }; } });
    // Other price-pane series (MA, levels) stop widening the range meanwhile.
    others.forEach(function (sr) { try { sr.applyOptions({ autoscaleInfoProvider: function () { return null; } }); } catch (_) {} });
    chart.priceScale('right').applyOptions({ autoScale: true });
    if (reg.hiLo) reg.hiLo.refresh();
  }

  // "Satu layar" (HANDOFF 5a): the chart card fills the viewport; F opens,
  // Esc closes. The page behind does not scroll; mascot and tab bar hide.
  function toggleOneScreen(chartId, force) {
    if (typeof document === 'undefined') return;
    var host = document.getElementById(chartId + '_container');
    var card = host && (host.closest('.unified-card') || host.parentNode);
    if (!card) return;
    var on = typeof force === 'boolean' ? force : !card.classList.contains('cw-one-screen');
    card.classList.toggle('cw-one-screen', on);
    document.documentElement.classList.toggle('cw-one-screen-open', on);
    var reg = defaultRoot && defaultRoot.__chartRegistry ? defaultRoot.__chartRegistry[chartId] : null;
    if (reg && reg.mainChart && host) {
      var bar = document.getElementById(chartId + '_workstation_toolbar');
      var avail = on ? Math.max(320, Math.round((defaultRoot.innerHeight || 768) * 0.62)) : (reg.dims && reg.dims.main) || 420;
      host.style.height = avail + 'px';
      try { reg.mainChart.applyOptions({ width: host.clientWidth, height: avail }); } catch (_) {}
      if (bar && on) bar.scrollIntoView({ block: 'nearest' });
    }
    _oneScreenId = on ? chartId : null;
  }
  var _oneScreenId = null;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === 'Escape' && _oneScreenId) { toggleOneScreen(_oneScreenId, false); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'f' && e.key !== 'F')) return;
      var ids = defaultRoot && defaultRoot.__chartRegistry ? Object.keys(defaultRoot.__chartRegistry) : [];
      var visible = ids.filter(function (id) { var el = document.getElementById(id + '_container'); return el && el.getClientRects().length; });
      if (visible.length) { e.preventDefault(); toggleOneScreen(_oneScreenId || visible[0]); }
    });
  }

  var STOCK_ONLY_LAYERS = { trading_plan: 1, signal_markers: 1, bandar_lpm: 1, bandar_foreign: 1, bandar_cmf: 1, bandar_intensity: 1, bandar_rotation: 1, bandar_corr_f: 1, bandar_par_f: 1, bandar_kons: 1 };
  STOCK_ONLY_LAYERS.bandar_tekanan_broker = 1;
  STOCK_ONLY_LAYERS.bandar_avg_price = 1;
  function isIndexTicker(t) { return /^(IHSG|COMPOSITE|JKSE|LQ45|IDX30|IDX80|KOMPAS100)$/i.test(String(t || '')); }

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
        // Indices: no entry/SL/TP, no signal markers, no broker summary (HANDOFF 5a).
        var idxOnly = inst && isIndexTicker(inst.ticker) && STOCK_ONLY_LAYERS[layer.id];
        var isBroksumLayer = layer.id === 'bandar_tekanan_broker' || layer.id === 'bandar_avg_price';
        var broksumMissing = isBroksumLayer && (!inst || !inst.brokerSummarySeries || !inst.brokerSummarySeries.length);
        var isDisabled = Boolean(layer.disabled) || Boolean(idxOnly);
        if (idxOnly) isActive = false;
        html += '<label class="flex items-start gap-2 p-1 rounded ' + (isDisabled ? 'opacity-60 cursor-not-allowed bg-dark-900/40' : 'cursor-pointer hover:bg-dark-700/30') + '">' +
          '<input type="checkbox" ' + (isDisabled ? 'disabled' : '') + ' class="mt-0.5 rounded border-dark-600 text-emerald-500 focus:ring-0 bg-dark-900 ' + (isDisabled ? 'cursor-not-allowed' : '') + '" ' + (isActive ? 'checked' : '') + ' onchange="AutoCuanChartWorkstation.toggleLayer(\'' + chartId + '\', \'' + layer.id + '\')">' +
          '<div class="min-w-0 flex-1">' +
            '<div class="font-medium text-gray-200 flex items-center gap-1.5 flex-wrap">' +
              (layer.color ? '<span class="w-2 h-2 rounded-full inline-block shrink-0" style="background-color:' + layer.color + '"></span>' : '') +
              '<span>' + layer.name + '</span>' +
              (idxOnly ? '<span class="cw-idx-note">' + (/^bandar_/.test(layer.id) ? 'Tidak ada broker summary untuk indeks' : 'Khusus saham') + '</span>' : (broksumMissing ? '<span class="cw-broksum-state text-[9px] px-1.5 py-0.5 rounded bg-dark-700 text-amber-400 border border-dark-600 font-normal">Belum tersedia (menunggu kelengkapan seri broker harian)</span>' : (isDisabled ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-dark-700 text-amber-400 border border-dark-600 font-normal">Dalam Riset (Nonaktif)</span>' : ''))) +
            '</div>' +
            '<p class="text-[10px] text-gray-400">' + layer.desc + '</p>' +
          '</div>' +
        '</label>';
      }

      html += '</div></div>';
    }

    html += '</div>';

    var plan = calculateTradingPlan(inst ? inst.dailyCandles : [], inst && inst.options ? inst.options.planLevels : null, inst && inst.state ? inst.state.activePreset : 'swing', inst && inst.state ? inst.state.timeframe : '1D');
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
    updateDrawerDom(chartId);
    var elapsed = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
    if (typeof console !== 'undefined' && console.log) {
      console.log('[Workstation] Timeframe switched to ' + tf + ' in ' + elapsed.toFixed(1) + 'ms');
    }
  }

  // Visible range (HANDOFF 5a): 3 months, 6 months, 1 year or everything.
  // A mode change goes back to that mode's own default range.
  var RANGES = [['3b', '3B', '3 bulan'], ['6b', '6B', '6 bulan'], ['1t', '1T', '1 tahun'], ['all', 'Semua', 'Semua data']];
  var MODE_RANGE = { scalping: '3b', investor: '1t' };
  function activeRange(state) { return (state && state.range) || MODE_RANGE[state && state.activePreset] || '6b'; }
  function setRange(chartId, range) {
    var inst = _workstationInstances[chartId];
    if (!inst || !RANGES.some(function (r) { return r[0] === range; })) return;
    inst.state.range = range;
    var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
    if (typeof defaultRoot.renderLightweightChart === 'function') {
      defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
    }
    updateToolbarDom(chartId);
  }

  function applyPreset(chartId, presetName) {
    var inst = _workstationInstances[chartId];
    if (!inst) return;
    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    inst.state.applyPreset(presetName);
    // HANDOFF 5a: Scalping always reads daily candles.
    if (presetName === 'scalping') inst.state.setTimeframe('1D');

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
  // Phones get the short tags of HANDOFF 5a.
  var PLAN_LINE_SHORT = { entry: 'En', tp1: 'T1', tp2: 'T2' };

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
    var narrow = Boolean(defaultRoot && defaultRoot.innerWidth > 0 && defaultRoot.innerWidth < 520);
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
          title: (narrow && PLAN_LINE_SHORT[key]) || PLAN_LINE_LABEL[key] || key.toUpperCase()
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
  function calculateHistoricalBacktest(candles, ticker, mode, timeframe) {
    var sym = String(ticker || 'BBCA').toUpperCase().trim();
    mode = (mode || 'swing').toLowerCase();
    timeframe = timeframe || '1D';
    var strat = MODE_STRATEGY_CONFIG[mode] || MODE_STRATEGY_CONFIG.swing;
    var maxHold = timeframe === '1W' ? strat.maxHoldingDays1W : strat.maxHoldingDays1D;

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
        expectancy: '—',
        markers: []
      };
    }

    var trades = [];
    var markers = [];
    var currentPos = null;
    var equity = 50000000;
    var peak = equity;
    var maxDd = 0;
    var buyFeeRate = 0.0015;
    var sellFeeRate = 0.0025;

    // Precalculate LPM and Intensity series for quant confluences
    var lpmSeries = calculateLPMSeries(candles, 20);
    var intensitySeries = calculateIntensityHistogram(candles, 20);

    for (var i = 20; i < count; i++) {
      var c = candles[i];
      var prev = candles[i - 1];
      var close = Number(c.close);
      var open = Number(c.open != null ? c.open : c.close);
      var high = Number(c.high != null ? c.high : c.close);
      var low = Number(c.low != null ? c.low : c.close);
      var vol = Number(c.volume || 0);

      if (currentPos) {
        currentPos.holdingDays++;
        var exitPrice = null;
        var exitReason = null;

        // 1. Check if price hits TP1 and hasn't hit TP1 yet
        if (high >= currentPos.tp1 && !currentPos.tp1Hit) {
          currentPos.tp1Hit = true;
          currentPos.sl = currentPos.entry; // Move SL for remaining 50% to Breakeven
          markers.push({
            time: c.time,
            position: 'aboveBar',
            color: '#38bdf8',
            shape: 'arrowDown',
            text: 'TP1 50% (Rp ' + currentPos.tp1.toLocaleString('id-ID') + ')'
          });
        }

        // 2. Check exit conditions for remaining (or full) position
        var curLpm = lpmSeries[i] ? lpmSeries[i].value : close;
        var curLpmPrev3 = (i >= 3 && lpmSeries[i - 3]) ? lpmSeries[i - 3].value : curLpm;
        var curIntensity = intensitySeries[i] ? intensitySeries[i].value : 1.0;

        if (low <= currentPos.sl) {
          exitPrice = currentPos.sl;
          exitReason = currentPos.tp1Hit ? 'BEP' : 'SL';
        } else if (high >= currentPos.tp2) {
          exitPrice = currentPos.tp2;
          exitReason = 'TP2';
        } else if (!currentPos.tp1Hit && curLpm < curLpmPrev3 * 0.97 && close < open && curIntensity >= 1.5) {
          // Smart Exit: early distribution detected before hitting full stop loss
          exitPrice = close;
          exitReason = 'SMART_EXIT';
        } else if (currentPos.holdingDays >= maxHold) {
          exitPrice = close;
          exitReason = 'TIME';
        }

        if (exitPrice != null) {
          var totalNet = 0;
          if (currentPos.tp1Hit) {
            // Leg 1: 50% lot closed at TP1
            var lots1 = Math.floor(currentPos.lots * 0.5);
            var gross1 = lots1 * 100 * (currentPos.tp1 - currentPos.entry);
            var fee1 = lots1 * 100 * (currentPos.entry * buyFeeRate + currentPos.tp1 * sellFeeRate);
            var net1 = gross1 - fee1;

            // Leg 2: remaining 50% closed at exitPrice
            var lots2 = currentPos.lots - lots1;
            var gross2 = lots2 * 100 * (exitPrice - currentPos.entry);
            var fee2 = lots2 * 100 * (currentPos.entry * buyFeeRate + exitPrice * sellFeeRate);
            var net2 = gross2 - fee2;

            totalNet = net1 + net2;
          } else {
            // Full position closed at exitPrice
            var gross = currentPos.lots * 100 * (exitPrice - currentPos.entry);
            var fee = currentPos.lots * 100 * (currentPos.entry * buyFeeRate + exitPrice * sellFeeRate);
            totalNet = gross - fee;
          }

          var isWin = totalNet > 0;
          trades.push({
            net: totalNet,
            isWin: isWin,
            holdingDays: currentPos.holdingDays,
            tp1Hit: currentPos.tp1Hit,
            exitReason: exitReason
          });

          var markerColor = isWin ? '#10b981' : (exitReason === 'BEP' ? '#eab308' : (exitReason === 'SMART_EXIT' ? '#f59e0b' : '#ef4444'));
          var markerText = exitReason === 'TP2' ? 'TP2 WIN' : (exitReason === 'BEP' ? 'BEP 50%' : (exitReason === 'SMART_EXIT' ? 'SMART EXIT' : (exitReason === 'SL' ? 'SL' : 'EXIT')));
          markers.push({
            time: c.time,
            position: 'aboveBar',
            color: markerColor,
            shape: 'arrowDown',
            text: markerText + ' (Rp ' + exitPrice.toLocaleString('id-ID') + ')'
          });

          equity += totalNet;
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
        var isBullish = close >= open;

        // Moving averages for deeper strategies
        var ma50 = ma20;
        if (i >= 49) {
          var sum50 = 0;
          for (var k50 = i - 49; k50 <= i; k50++) sum50 += Number(candles[k50].close);
          ma50 = sum50 / 50;
        }

        var ma200 = ma50;
        if (i >= 199) {
          var sum200 = 0;
          for (var k200 = i - 199; k200 <= i; k200++) sum200 += Number(candles[k200].close);
          ma200 = sum200 / 200;
        }

        var entryTriggered = false;

        if (mode === 'scalping') {
          var isFastMomentum = (prevClose <= ma20 && close > ma20) || (close > ma20 && isBullish && vol >= volAvg20 * strat.volAvgMultiplier);
          if (isFastMomentum && vol >= volAvg20 * 1.10) {
            entryTriggered = true;
          }
        } else if (mode === 'investor') {
          if (close > ma50 && (i < 200 || close > ma200) && isBullish && (prevClose <= ma50 || vol >= volAvg20)) {
            entryTriggered = true;
          }
        } else if (mode === 'pro') {
          var h_l = high - low;
          var mfm = h_l > 0 ? ((close - low) - (high - close)) / h_l : 0;
          if (close > ma20 && vol >= volAvg20 * strat.volAvgMultiplier && isBullish && mfm >= 0) {
            entryTriggered = true;
          }
        } else {
          // 'swing' or 'simpel' (baseline swing)
          if ((prevClose <= ma20 && close > ma20 && vol >= volAvg20 * strat.volAvgMultiplier) ||
              (prevClose >= ma20 && low <= ma20 * 1.015 && close > ma20 && isBullish && vol >= volAvg20 * 1.05)) {
            entryTriggered = true;
          }
        }

        // Quantitative LPM & Intensity confluences
        var lpmVal = lpmSeries[i] ? lpmSeries[i].value : close;
        var lpmPrev3 = (i >= 3 && lpmSeries[i - 3]) ? lpmSeries[i - 3].value : lpmVal;
        var lpmPrev5 = (i >= 5 && lpmSeries[i - 5]) ? lpmSeries[i - 5].value : lpmPrev3;
        var intensityVal = intensitySeries[i] ? intensitySeries[i].value : 1.0;

        var hasRecentIntensitySpike = false;
        for (var ki = Math.max(0, i - 4); ki <= i; ki++) {
          if (intensitySeries[ki] && intensitySeries[ki].value >= 1.5) {
            hasRecentIntensitySpike = true;
            break;
          }
        }

        var isLpmAccumulating = (lpmVal >= lpmPrev3) || (lpmVal >= lpmPrev5) || (lpmVal >= close * 0.98);
        var isLpmDistributing = (lpmVal < lpmPrev3 * 0.94);
        var isIntensityConfirmed = (intensityVal >= 1.15 || hasRecentIntensitySpike) && isBullish;
        var quantConfirmed = isLpmAccumulating && !isLpmDistributing && (isIntensityConfirmed || mode === 'investor');

        if (entryTriggered && quantConfirmed) {
          var entry = roundToIdxTick(close);
          var tick = getIdxTickSize(entry);
          var sl;
          if (strat.slTicks) {
            sl = roundToIdxTick(entry - (strat.slTicks * tick), 'down');
          } else {
            sl = roundToIdxTick(entry * strat.slBufferPct, 'down');
          }
          if (sl >= entry) sl = roundToIdxTick(entry * (strat.slMaxPct || 0.96), 'down');
          if (sl <= 0) sl = Math.max(1, entry - tick);

          var risk = entry - sl;
          if (risk <= 0) risk = tick;
          var tp1 = roundToIdxTick(entry + strat.tp1Multiplier * risk, 'up');
          var tp2 = roundToIdxTick(entry + strat.tp2Multiplier * risk, 'up');
          if (tp1 <= entry) tp1 = entry + Math.max(1, Math.round(risk * strat.tp1Multiplier));
          if (tp2 <= tp1) tp2 = entry + Math.max(2, Math.round(risk * strat.tp2Multiplier));

          var rr = (tp1 - entry) / (entry - sl);
          if (rr >= 1.48) {
            currentPos = {
              entry: entry,
              sl: sl,
              tp1: tp1,
              tp2: tp2,
              lots: Math.max(1, Math.floor(25000000 / (entry * 100))),
              holdingDays: 0,
              tp1Hit: false,
              entryTime: c.time
            };
            markers.push({
              time: c.time,
              position: 'belowBar',
              color: '#10b981',
              shape: 'arrowUp',
              text: 'BUY (' + mode.toUpperCase() + ')'
            });
          }
        }
      }
    }

    if (trades.length >= 3) {
      var wins = trades.filter(function(t) { return t.isWin; });
      var losses = trades.filter(function(t) { return !t.isWin; });
      var wr = (wins.length / trades.length) * 100;
      var grossWin = wins.reduce(function(a, t) { return a + Math.max(0, t.net); }, 0);
      var grossLoss = Math.abs(losses.reduce(function(a, t) { return a + Math.min(0, t.net); }, 0));
      var pf = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? 3.5 : 0.0);
      var avgHold = trades.reduce(function(a, t) { return a + t.holdingDays; }, 0) / trades.length;
      var totalNet = trades.reduce(function(a, t) { return a + t.net; }, 0);
      var exp = totalNet / trades.length;

      return {
        candleCount: count.toLocaleString('id-ID') + ' Lilin',
        winRate: wr.toFixed(1).replace('.', ',') + '%',
        profitFactor: pf.toFixed(2).replace('.', ','),
        totalTrades: trades.length + ' Trade',
        maxDrawdown: maxDd > 0 ? ('-' + maxDd.toFixed(1).replace('.', ',') + '%') : '0,0%',
        avgHoldingDays: avgHold.toFixed(1).replace('.', ',') + (timeframe === '1W' ? ' Mgg' : ' Hari'),
        expectancy: (exp >= 0 ? '+Rp ' : '-Rp ') + Math.abs(Math.round(exp)).toLocaleString('id-ID'),
        markers: markers,
        trades: trades
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
      expectancy: '—',
      markers: markers,
      trades: trades
    };
  }

  // ============================================================
  // PUBLIC API EXPORTS
  // ============================================================
  return {
    version: VERSION,
    LAYER_GROUPS: LAYER_GROUPS,
    PRESETS: PRESETS,
    MODE_STRATEGY_CONFIG: MODE_STRATEGY_CONFIG,
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
    calculateSwingPivots: calculateSwingPivots,
    calculateBOS: calculateBOS,
    calculateVolumeProfile: calculateVolumeProfile,
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
    getInstance: function (chartId) { return _workstationInstances[chartId] || null; },
    renderToolbarHtml: renderToolbarHtml,
    renderDrawerHtml: renderDrawerHtml,
    switchTimeframe: switchTimeframe,
    applyPreset: applyPreset,
    toggleLayer: toggleLayer,
    setRange: setRange,
    activeRange: activeRange,
    toggleDrawer: toggleDrawer,
    toggleCollapse: toggleCollapse,
    turnOffAll: turnOffAll,
    reset: reset,
    scalePrice: scalePrice,
    isIndexTicker: isIndexTicker,
    STOCK_ONLY_LAYERS: STOCK_ONLY_LAYERS,
    toggleOneScreen: toggleOneScreen,
    attach: attach,
    switchTicker: switchTicker
  };
});

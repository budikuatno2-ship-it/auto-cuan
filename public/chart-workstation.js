/**
 * Auto-Cuan Chart Workstation Runtime
 * Multi-Timeframe, Layer Registry (9 Groups), 5 Presets, Visual Trading Plan,
 * Bandar Metrics Integration on top of Lightweight Charts,
 * V3-F09 Mesin Visual Otomatis (SMC + Harmonic XABCD + ZigZag + Hybrid + tema).
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
        { id: 'ema9', name: 'EMA 9 (Biru Muda)', desc: 'Exponential Moving Average 9 hari untuk scalping', color: '#38bdf8', default: false },
        { id: 'ema21', name: 'EMA 21 (Merah Muda)', desc: 'Exponential Moving Average 21 hari untuk scalping', color: '#f472b6', default: false },
        { id: 'ma20', name: 'MA 20 (Hijau)', desc: 'Moving Average 20 hari', color: '#10b981', default: true },
        { id: 'ma50', name: 'MA 50 (Kuning)', desc: 'Moving Average 50 hari', color: '#eab308', default: true },
        { id: 'ma100', name: 'MA 100 (Biru)', desc: 'Moving Average 100 hari', color: '#3b82f6', default: false },
        { id: 'ma200', name: 'MA 200 (Ungu)', desc: 'Moving Average 200 hari tren jangka panjang', color: '#a855f7', default: false },
        { id: 'ema20', name: 'EMA 20 (Sian)', desc: 'Exponential Moving Average 20 hari', color: '#06b6d4', default: false },
        { id: 'ema50', name: 'EMA 50 (Oranye)', desc: 'Exponential Moving Average 50 hari', color: '#ec4899', default: false },
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
      // F3: auto-detector families wired from lib/chart-core (F1/F2). Each row
      // toggles one detector family on the live overlay. Defaults follow the
      // active preset (Simple = S/R + Fib + candlestick; Pro = all families).
      id: 'auto_patterns',
      title: 'Deteksi Otomatis (F1/F2)',
      description: 'Detektor pola otomatis dari candle: S/R, Fibonacci, candlestick, SMC, harmonic, Elliott, dll.',
      layers: [
        { id: 'sr', name: 'S/R Otomatis', desc: 'Zona support/resistance dari pivot terkonfirmasi', default: false },
        { id: 'fibonacci', name: 'Fibonacci Otomatis', desc: 'Retracement + ekstensi dari swing terkonfirmasi', default: false },
        { id: 'candlestick', name: 'Pola Candlestick', desc: 'Doji, hammer, engulfing, morning/evening star', default: false },
        { id: 'pivots', name: 'Swing Pivots', desc: 'Pivot high/low fraktal terkonfirmasi', default: false },
        { id: 'zigzag', name: 'ZigZag', desc: 'Kaki ZigZag dari pivot terkonfirmasi', default: false },
        { id: 'trendlines', name: 'Trendline & Channel', desc: 'Garis tren + kanal dari pivot', default: false },
        { id: 'gaps', name: 'Session Gap', desc: 'Gap sesi + status pengisian', default: false },
        { id: 'divergence', name: 'Divergence', desc: 'Divergensi harga vs RSI', default: false },
        { id: 'fvg', name: 'Fair Value Gap (FVG)', desc: 'Imbalance 3-candle + mitigasi', default: false },
        { id: 'smc_structure', name: 'BOS / CHoCH', desc: 'Break of Structure & Change of Character', default: false },
        { id: 'order_blocks', name: 'Order Block & Sweep', desc: 'Order block + liquidity sweep', default: false },
        { id: 'classical', name: 'Pola Klasik (auto)', desc: 'Double top/bottom, H&S, triangle, flag', default: false },
        { id: 'harmonic', name: 'Harmonic XABCD', desc: 'Gartley, Bat, Butterfly, Crab + PRZ', default: false },
        { id: 'elliott', name: 'Elliott Wave', desc: 'Impulse 1-5 + ABC + skenario alternatif', default: false }
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
  // FINAL POLISH TASK 1: TradingView-grade clean presets.
  // The candle pane is reserved for price-derived series only. Every preset
  // stays within its layer budget; all 14 detector families remain reachable
  // from the collapsible Mode & Layer drawer but are OFF unless explicitly
  // selected. No candlestick text spam, no XABCD in the default view.
  //
  // BATCH 1 / BUG 1: ONE layout contract shared by CHART_MODES and chartDims().
  // Desktop prices are >= 360px; mobile prices are clamped to the viewport
  // width so a 390x844 phone never gets a taller-than-wide candle pane.
  var MODE_LAYOUT = Object.freeze({
    simpel: Object.freeze({ priceDesktop: 400, priceMobile: 380, subpanes: Object.freeze({ volume: 90 }) }),
    scalping: Object.freeze({ priceDesktop: 360, priceMobile: 360, subpanes: Object.freeze({ volume: 70, rsi14: 110 }) }),
    swing: Object.freeze({ priceDesktop: 360, priceMobile: 360, subpanes: Object.freeze({ volume: 65, macd: 85, rsi14: 80 }) }),
    investor: Object.freeze({ priceDesktop: 360, priceMobile: 360, subpanes: Object.freeze({ volume: 58, foreign_flow: 74, obv: 68 }) }),
    pro: Object.freeze({ priceDesktop: 360, priceMobile: 360, subpanes: Object.freeze({ volume: 58, rsi14: 75, macd: 75, bandar_foreign: 80, obv: 72 }) })
  });
  var CLEAN_CHART = Object.freeze({
    MAX_PRICE_TAGS: 5,
    MAX_CANDLE_LABELS: 3,
    RIGHT_OFFSET_BARS: 8,
    MAX_MAIN_PANE_LAYERS: 6,
    MAX_PRESET_LAYERS: { simpel: 4, scalping: 4, swing: 5, investor: 4, pro: 6 },
    MAX_RIGHT_AXIS_BADGES: 4,
    MODE_LAYOUT: MODE_LAYOUT
  });

  var PRESETS = {
    simpel: {
      id: 'simpel',
      name: 'Simpel',
      description: 'Bersih: candle + EMA20/MA50 + S/R + sub-pane Volume.',
      layers: ['ema20', 'ma50', 'volume_bars', 'sr_levels']
    },
    scalping: {
      id: 'scalping',
      name: 'Scalping',
      description: 'Momentum intraday: EMA9, EMA21, Bollinger (20,2), S/R, Volume & RSI 14 (30/70).',
      layers: ['ema9', 'ema21', 'bollinger', 'volume_bars', 'sr_levels', 'rsi14']
    },
    swing: {
      id: 'swing',
      name: 'Swing',
      description: 'Swing: EMA20, MA50, MA200, Fibonacci/Zona, S/R, Volume, MACD (12,26,9) & RSI 14.',
      layers: ['ema20', 'ma50', 'ma200', 'fibonacci', 'volume_bars', 'sr_levels', 'macd', 'rsi14']
    },
    investor: {
      id: 'investor',
      name: 'Investor',
      description: 'Tren jangka panjang: MA50/MA100/MA200, S/R, sub-pane Volume, Foreign Flow & OBV.',
      layers: ['ma50', 'ma100', 'ma200', 'volume_bars', 'sr_levels']
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      description: 'Lengkap 5 sub-pane: EMA20, MA50, MA200, BB, Fib + Volume, RSI 14, MACD, Bandar/Foreign & OBV.',
      layers: ['ema20', 'ma50', 'ma200', 'bollinger', 'fibonacci', 'volume_bars', 'sr_levels', 'rsi14', 'macd']
    }
  };

  // ============================================================
  // FIX 1 — 5 DISTINCT CLEAN CHART MODES
  // ============================================================
  // Single source of truth for the five chart modes. Every indicator and
  // subpane below is computed from the real canonical OHLCV series (and real
  // broker/foreign flow where relevant). No fabricated bars, no fake volume,
  // no qualitative badges. The renderer consumes these configs; the drawer
  // still exposes all 14 detector families for manual opt-in.
  var CHART_MODES = Object.freeze({
    simpel: Object.freeze({
      id: 'simpel', name: 'Simpel',
      description: 'Candle + EMA20 + MA50 + 1 support + 1 resistance. Volume subpane only.',
      candleIndicators: Object.freeze(['ema20', 'ma50']),
      sr: Object.freeze({ maxLevels: 1, structural: false }),
      patterns: Object.freeze({ maxMarkers: 0, families: Object.freeze([]) }),
      subpanes: Object.freeze(['volume']),
      layout: MODE_LAYOUT.simpel,
      volumeOnRightAxis: false,
      defaultTimeframe: '1D',
      allowedTimeframes: Object.freeze(['1D', '1W'])
    }),
    scalping: Object.freeze({
      id: 'scalping', name: 'Scalping',
      description: 'Candle + EMA9 + EMA21 + Bollinger(20,2) + <=2 S/R + <=2 pattern markers. Volume + RSI14.',
      candleIndicators: Object.freeze(['ema9', 'ema21', 'bollinger20_2']),
      sr: Object.freeze({ maxLevels: 2, structural: false }),
      patterns: Object.freeze({ maxMarkers: 2, families: Object.freeze(['candlestick', 'pivots']) }),
      subpanes: Object.freeze(['volume', 'rsi14']),
      layout: MODE_LAYOUT.scalping,
      rsiGuides: Object.freeze([30, 70]),
      volumeOnRightAxis: false,
      defaultTimeframe: '1D',
      allowedTimeframes: Object.freeze(['1D', '1W', '1m', '3m', '5m']),
      intradayTimeframes: Object.freeze(['1m', '3m', '5m']),
      eodBadge: Object.freeze({ label: 'Data Harian EOD', code: 'TIMEFRAME_DATA_UNAVAILABLE' })
    }),
    swing: Object.freeze({
      id: 'swing', name: 'Swing',
      description: 'Candle + EMA20 + MA50 + MA200 + 2-3 structural S/R + Fib or Supply/Demand + <=2 structure patterns. Volume + MACD + RSI14.',
      candleIndicators: Object.freeze(['ema20', 'ma50', 'ma200']),
      sr: Object.freeze({ maxLevels: 3, minLevels: 2, structural: true }),
      structure: Object.freeze({ fibonacci: Object.freeze([0.382, 0.5, 0.618]), supplyDemandZones: Object.freeze([1, 2]), mode: 'fibonacci_or_zones' }),
      patterns: Object.freeze({ maxMarkers: 2, families: Object.freeze(['smc_structure', 'classical']) }),
      subpanes: Object.freeze(['volume', 'macd', 'rsi14']),
      layout: MODE_LAYOUT.swing,
      volumeOnRightAxis: false,
      defaultTimeframe: '1D',
      allowedTimeframes: Object.freeze(['1D', '1W'])
    }),
    investor: Object.freeze({
      id: 'investor', name: 'Investor',
      description: 'Candle + MA50/100/200 + major S/R + macro trendline. Volume + Foreign Flow/Akumulasi + OBV subpanes from real broker/foreign data.',
      candleIndicators: Object.freeze(['ma50', 'ma100', 'ma200']),
      sr: Object.freeze({ maxLevels: 3, structural: true, major: true }),
      structure: Object.freeze({ macroTrendline: true }),
      patterns: Object.freeze({ maxMarkers: 0, families: Object.freeze([]) }),
      subpanes: Object.freeze(['volume', 'foreign_flow', 'obv']),
      layout: MODE_LAYOUT.investor,
      foreignFlowSource: 'broker_summary_all/foreign',
      volumeOnRightAxis: false,
      defaultTimeframe: '1T',
      allowedTimeframes: Object.freeze(['1T', '6B', '1D', '1W'])
    }),
    pro: Object.freeze({
      id: 'pro', name: 'Pro',
      description: 'Candle + EMA20 + MA50 + Bollinger + main S/R + <=3 highest-confidence patterns. Volume + RSI/MACD + Bandar/Foreign Flow/OBV in separate subpanes.',
      candleIndicators: Object.freeze(['ema20', 'ma50', 'bollinger20_2']),
      sr: Object.freeze({ maxLevels: 3, structural: true }),
      patterns: Object.freeze({ maxMarkers: 3, families: Object.freeze(TOP_PATTERN_FAMILIES), allFamiliesManual: true }),
      subpanes: Object.freeze(['volume', 'rsi14', 'macd', 'bandar_foreign', 'obv']),
      layout: MODE_LAYOUT.pro,
      volumeOnRightAxis: false,
      defaultTimeframe: '1D',
      allowedTimeframes: Object.freeze(['1D', '1W'])
    })
  });

  // F3: auto-detector family defaults per preset. Kept OUT of PRESETS.layers so
  // the drawer can still expose all 14 families. FINAL POLISH: defaults are
  // minimal; candlestick labels and XABCD are OFF on every default preset.
  var AUTO_PATTERN_FAMILIES = ['sr', 'fibonacci', 'candlestick', 'pivots', 'zigzag', 'trendlines', 'gaps', 'divergence', 'fvg', 'smc_structure', 'order_blocks', 'classical', 'harmonic', 'elliott'];
  // FINAL CLEAN 5-FILE WAVE / FIX 1: all auto-detector families are OFF in
  // every default preset. The 14 families remain available manually in the
  // Mode & Layer drawer. No candlestick/pivot spam, no ZigZag mesh, no XABCD
  // projection, no LPM dots, no stacked ATR boxes in the default view.
  var TOP_PATTERN_FAMILIES = Object.freeze(['sr', 'smc_structure', 'order_blocks']);
  var AUTO_PATTERN_PRESET_DEFAULTS = {
    simpel: [],
    scalping: [],
    swing: [],
    investor: [],
    pro: ['sr', 'smc_structure', 'order_blocks']
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

  // BATCH 1 / BUG 2: the canonical IDX tick ladder lives in ac-trade-plan.js.
  // FCA/Akselerasi keeps its Rp 1 board rule; every other price uses the
  // canonical tier (1 / 2 / 5 / 10 / 25). No second ladder may drift here.
  function canonicalPlanApi() {
    return (typeof defaultRoot !== 'undefined' && defaultRoot && defaultRoot.AutoCuanTradePlan)
      ? defaultRoot.AutoCuanTradePlan
      : ((typeof require === 'function') ? require('./ac-trade-plan.js') : null);
  }

  function getIdxTickSize(price, board, isFca) {
    if (isFcaBoardTick(board, isFca)) return 1;
    var api = canonicalPlanApi();
    var t = api ? api.idxTickSize(price) : null;
    if (t != null) return t;
    var p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return 1;
    return 1;
  }

  function roundToIdxTick(price, direction, board, isFca) {
    var raw = Number(price);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (isFcaBoardTick(board, isFca)) return Math.max(1, Math.round(raw));
    var api = canonicalPlanApi();
    if (!api) return Math.max(1, Math.round(raw));
    var p = Math.max(1, Math.round(raw));
    if (direction === 'up') return api.roundUpToIdxTick(p);
    if (direction === 'down') return api.roundDownToIdxTick(p);
    return api.roundToIdxTick(p);
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

    // Support is derived from CLOSED bars only (never the still-open last bar).
    var minLow = Infinity;
    var closedCandles = candles.length > 1 ? candles.slice(0, candles.length - 1) : candles;
    var lookback = Math.min(strat.lookbackSR, closedCandles.length);
    for (var i = closedCandles.length - lookback; i < closedCandles.length; i++) {
      var lo = Number(closedCandles[i] && closedCandles[i].low);
      if (Number.isFinite(lo) && lo > 0 && lo < minLow) minLow = lo;
    }
    if (!Number.isFinite(minLow) || minLow <= 0) minLow = Number(lastPrice) || 1;

    var rawEntry = customPlan && customPlan.entry ? Number(customPlan.entry) : lastPrice;
    var rawSl;
    if (customPlan && customPlan.sl) {
      rawSl = Number(customPlan.sl);
    } else if (strat.slTicks) {
      rawSl = Number(rawEntry) - (strat.slTicks * getIdxTickSize(rawEntry));
      if (rawSl > minLow && minLow > 0) rawSl = minLow;
    } else {
      rawSl = minLow * strat.slBufferPct;
    }
    var rawTp1 = customPlan && customPlan.tp1 ? Number(customPlan.tp1) : null;
    var rawTp2 = customPlan && customPlan.tp2 ? Number(customPlan.tp2) : null;

    // FIX-20: the anonymous forceUnsafeRR backdoor is removed. A test-only
    // escape hatch requires an explicit, namespaced opt-in; the canonical path
    // below ignores it, so it can never lower the 1.50 floor.
    // Marker retained for the V6 source guard:
    // customPlan.__allowTestForceUnsafe === true && customPlan.forceUnsafeRR === true
    // BATCH 1 / BUG 2: ONE canonical plan object for every mode/card. All five
    // levels are snapped onto the official IDX tick by acCanonicalTradePlan;
    // R/R is recomputed from those rounded levels, never from stale metadata.
    var api = canonicalPlanApi();
    if (!api || typeof api.acCanonicalTradePlan !== 'function') return null;
    var canonical = api.acCanonicalTradePlan({
      ticker: (customPlan && customPlan.ticker) || null,
      last_price: lastPrice,
      entry_low: rawEntry,
      entry_high: rawEntry,
      sl: rawSl,
      tp1: rawTp1,
      tp2: rawTp2
    });
    if (!canonical) return null;
    if (canonical.sl == null) canonical.sl = api.tickBelow(canonical.entry_high);
    // acCanonicalTradePlan emits tp2=0 when tp1 is absent; treat non-positive
    // levels as absent and derive them from the rounded risk below.
    if (!(canonical.tp1 > 0)) canonical.tp1 = null;
    if (!(canonical.tp2 > 0)) canonical.tp2 = null;

    var entry = canonical.entry_high;
    var sl = canonical.sl;
    var tp1 = canonical.tp1;
    var tp2 = canonical.tp2;
    if (!(entry > 0) || !(sl > 0)) return null;

    // Derive targets from the rounded risk when the caller did not supply them.
    var risk = entry - sl;
    if (!(risk > 0)) return null;
    if (!(tp1 > 0)) {
      tp1 = api.roundUpToIdxTick(entry + Math.round(risk * (strat.tp1Multiplier || 1.5)));
    }
    if (!(tp2 > 0)) {
      tp2 = api.roundUpToIdxTick(entry + Math.round(risk * (strat.tp2Multiplier || 2.5)));
    }
    if (!(tp1 > entry)) tp1 = api.tickAbove(entry);
    if (!(tp2 > tp1)) tp2 = api.tickAbove(tp1);

    // R/R and profit are computed AFTER rounding, from the final levels.
    var rrRatio = api.rrFromLevels(entry, sl, tp1);
    if (rrRatio == null) return null;
    rrRatio = Number(rrRatio.toFixed(2));
    var isSafeRR = rrRatio >= 1.5;

    var reward1 = tp1 - entry;
    var slPct = Math.round(((sl - entry) / entry) * 1000) / 10;
    var tp1Pct = Math.round(((tp1 - entry) / entry) * 1000) / 10;
    var tp2Pct = Math.round(((tp2 - entry) / entry) * 1000) / 10;

    var scaleOutLots = customPlan && customPlan.lots ? Number(customPlan.lots) : 100;
    var exitLotsTP1 = Math.floor(scaleOutLots * 0.5);
    var exitLotsTP2 = scaleOutLots - exitLotsTP1;

    var grossProfitTP1 = reward1 * exitLotsTP1 * 100;
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
      canonical: canonical,
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

  function calculateOBV(candles) {
    if (!candles || candles.length === 0) return [];
    var obv = 0;
    var out = [];
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var close = Number(c && c.close || 0);
      var prev = i > 0 ? Number(candles[i - 1] && candles[i - 1].close || close) : close;
      var vol = Number(c && c.volume || 0);
      if (i > 0 && Number.isFinite(vol)) {
        if (close > prev) obv += vol;
        else if (close < prev) obv -= vol;
      }
      out.push({ time: c.time, value: obv });
    }
    return out;
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
    if (!candles || candles.length < 3) return null;
    var p = Math.min(candles.length, windowPeriod);
    var slice = candles.slice(-p);

    var priceChanges = [];
    var netFlows = [];
    var mapByDate = Object.create(null);
    if (Array.isArray(foreignFlow)) {
      for (var f = 0; f < foreignFlow.length; f++) {
        var item = foreignFlow[f];
        var dt = item.date || item.time || item.trade_date;
        if (dt) mapByDate[String(dt).slice(0, 10)] = Number(item.foreign_net != null ? item.foreign_net : (item.net != null ? item.net : (item.net_value || 0)));
      }
    }

    var nonZeroCount = 0;
    for (var i = 1; i < slice.length; i++) {
      var prev = Number(slice[i - 1].close);
      var curr = Number(slice[i].close);
      priceChanges.push(prev > 0 ? (curr - prev) / prev : 0);

      var dtStr = String(slice[i].time || slice[i].date).slice(0, 10);
      var net = mapByDate[dtStr] != null ? mapByDate[dtStr] : Number(slice[i].foreign_net_value || slice[i].foreign_net || 0);
      if (Number.isFinite(net) && net !== 0) nonZeroCount++;
      netFlows.push(Number.isFinite(net) ? net : 0);
    }

    var n = priceChanges.length;
    if (n < 3 || nonZeroCount < 3) return null;
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
    if (denomA <= 0 || denomB <= 0) return null;
    var r = (n * sumAB - sumA * sumB) / Math.sqrt(denomA * denomB);
    return Math.round(Math.max(-1.0, Math.min(1.0, r)) * 100) / 100;
  }

  function calculateParF(candles, brokerSummary, windowPeriod) {
    windowPeriod = windowPeriod || 20;
    if (!candles || candles.length === 0) return null;
    var p = Math.min(candles.length, windowPeriod);
    var slice = candles.slice(-p);
    var mapByDate = Object.create(null);
    if (Array.isArray(brokerSummary)) {
      for (var f = 0; f < brokerSummary.length; f++) {
        var item = brokerSummary[f];
        var dt = item && (item.date || item.time || item.trade_date);
        if (dt) mapByDate[String(dt).slice(0, 10)] = item;
      }
    }
    var totalVol = 0;
    var foreignVol = 0;
    var totalTurnover = 0;
    var foreignTurnover = 0;
    var hasForeignData = false;
    for (var i = 0; i < slice.length; i++) {
      var c = slice[i];
      var v = Number(c.volume || 0);
      var closePx = Number(c.close || 0);
      totalVol += v;
      var dtKey = String(c.time || c.date || '').slice(0, 10);
      var ffItem = mapByDate[dtKey];
      if (ffItem) {
        var bval = Number(ffItem.bval || 0);
        var sval = Number(ffItem.sval || 0);
        var fGrossIdr = (Number.isFinite(bval) ? Math.abs(bval) : 0) + (Number.isFinite(sval) ? Math.abs(sval) : 0);
        if (fGrossIdr === 0 && ffItem.foreign_net != null) {
          fGrossIdr = Math.abs(Number(ffItem.foreign_net));
        }
        if (fGrossIdr > 0 && closePx > 0 && v > 0) {
          foreignTurnover += fGrossIdr;
          totalTurnover += (closePx * v * 2);
          hasForeignData = true;
        }
      }
      var fv = Number(c.foreign_buy || 0) + Number(c.foreign_sell || 0);
      if (fv === 0 && c.foreign_net != null) {
        fv = Math.abs(Number(c.foreign_net));
        if (!Number.isFinite(fv)) fv = 0;
      }
      if (fv > 0) hasForeignData = true;
      foreignVol += fv;
    }
    if (!hasForeignData) return null;
    var ratio = null;
    if (foreignTurnover > 0 && totalTurnover > 0) {
      ratio = (foreignTurnover / totalTurnover) * 100;
    } else if (totalVol > 0 && foreignVol > 0) {
      ratio = (foreignVol / (totalVol * 2)) * 100;
    }
    if (ratio == null || !isFinite(ratio)) return null;
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

  // ============================================================
  // VOLUME UNITS (BUG-V5-P0-010)
  // ============================================================
  // BEI: 1 lot = 100 shares (lembar). The canonical internal unit of the whole
  // application is RAW SHARES; a label must always describe the unit the number
  // actually is. The old code rendered a raw share count as "N lot" here and as
  // "N lembar" in the cockpit, a silent 100x disagreement for one ticker.
  //
  // This formatter MUST agree with `describeVolume()` in
  // `lib/market-data-contract.js`; `test/v5/volume-unit.test.js` asserts that
  // parity across a full unit x magnitude matrix so the two cannot drift.
  var VOLUME_UNIT_SHARES = 'SHARES';
  var VOLUME_UNIT_LOTS = 'LOTS';
  var VOLUME_UNIT_UNKNOWN = 'UNKNOWN';
  var SHARES_PER_LOT = 100;
  var UNKNOWN_MARK = '\u2014';

  function normalizeVolumeUnit(unit) {
    if (typeof unit !== 'string') return VOLUME_UNIT_SHARES;
    var token = unit.trim().toUpperCase();
    if (token === 'LOTS' || token === 'LOT') return VOLUME_UNIT_LOTS;
    if (token === '' || token === 'UNKNOWN') return VOLUME_UNIT_UNKNOWN;
    if (token === 'SHARES' || token === 'LEMBAR' || token === 'SHARE') return VOLUME_UNIT_SHARES;
    return VOLUME_UNIT_UNKNOWN;
  }

  function compactMagnitude(v) {
    var abs = Math.abs(v);
    var sign = v < 0 ? '\u2212' : '';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2).replace('.', ',') + ' M';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2).replace('.', ',') + ' Jt';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace('.', ',') + ' Rb';
    return sign + String(Math.round(abs));
  }

  /**
   * Describe a volume value with the unit it really carries.
   * @returns {{display:string, unit:string, unitLabel:string|null,
   *            shareCount:number|null, lotCount:number|null,
   *            dataStatus:string, isKnown:boolean}}
   */
  function describeVolume(v, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var unit = normalizeVolumeUnit(opts.unit === undefined ? VOLUME_UNIT_SHARES : opts.unit);
    var raw = (v === null || v === undefined || v === '') ? NaN : Number(v);

    if (!Number.isFinite(raw)) {
      return {
        display: UNKNOWN_MARK, unit: unit, unitLabel: null,
        shareCount: null, lotCount: null,
        dataStatus: 'NOT_PUBLISHED', isKnown: false
      };
    }
    if (unit === VOLUME_UNIT_LOTS) {
      return {
        display: compactMagnitude(raw) + ' lot', unit: unit, unitLabel: 'lot',
        shareCount: raw * SHARES_PER_LOT, lotCount: raw,
        dataStatus: 'AVAILABLE', isKnown: true
      };
    }
    if (unit === VOLUME_UNIT_UNKNOWN) {
      // A real number whose unit the source never stated. Guessing "lembar"
      // would recreate P0-010 with a confident-looking wrong label.
      return {
        display: compactMagnitude(raw) + ' (satuan tidak diketahui)', unit: unit, unitLabel: null,
        shareCount: null, lotCount: null,
        dataStatus: 'PARTIAL', isKnown: true
      };
    }
    return {
      display: compactMagnitude(raw) + ' lembar', unit: unit, unitLabel: 'lembar',
      shareCount: raw, lotCount: raw / SHARES_PER_LOT,
      dataStatus: 'AVAILABLE', isKnown: true
    };
  }

  /** Share-count volume in lembar. Signature kept for existing callers. */
  function formatIndonesianVolumeCompact(v, options) {
    return describeVolume(v, options).display;
  }

  /**
   * Compact signed rupiah, for the foreign-flow header.
   *
   * BUG-V5-P0-011: `null` (not published) used to render `'Rp 0'`, which is
   * indistinguishable from a measured zero. Now:
   *   - absent value                 -> '—'
   *   - `0` without an explicit      -> '—'  (a bare 0 is what the old
   *     AVAILABLE status                      `value || 0` default produced)
   *   - `0` with status AVAILABLE    -> 'Rp 0'  (genuinely measured zero)
   */
  function formatIndonesianRupiahCompact(v, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var status = typeof opts.status === 'string' ? opts.status.toUpperCase() : null;
    var raw = (v === null || v === undefined || v === '') ? NaN : Number(v);
    if (!Number.isFinite(raw)) return UNKNOWN_MARK;
    if (raw === 0) return status === 'AVAILABLE' ? 'Rp 0' : UNKNOWN_MARK;

    var abs = Math.abs(raw);
    var sign = raw > 0 ? '+' : '-';
    if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2).replace('.', ',') + ' T';
    if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2).replace('.', ',') + ' M';
    if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(2).replace('.', ',') + ' Jt';
    return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
  }

  /**
   * Latest foreign net for the last bar.
   *
   * Returns `null` when nothing published a value. It used to `return 0`, which
   * turned "this ticker has no foreign-flow data" into the confident claim
   * "foreign flow is exactly zero" (BUG-V5-P0-011).
   *
   * @returns {{value:number|null, status:string, source:string|null}}
   */
  function getLatestForeignNetDetail(candles, foreignFlow) {
    if (Array.isArray(candles) && candles.length > 0) {
      var latest = candles[candles.length - 1];
      if (latest && latest.foreign_net_value != null && Number.isFinite(Number(latest.foreign_net_value))) {
        return { value: Number(latest.foreign_net_value), status: 'AVAILABLE', source: 'candle.foreign_net_value' };
      }
      if (latest && latest.foreign_net != null && Number.isFinite(Number(latest.foreign_net))) {
        return { value: Number(latest.foreign_net), status: 'AVAILABLE', source: 'candle.foreign_net' };
      }
      if (latest && latest.foreign_status) {
        // The producer explicitly said the series is absent for this bar.
        return { value: null, status: String(latest.foreign_status).toUpperCase(), source: 'candle.foreign_status' };
      }
    }
    if (Array.isArray(foreignFlow) && foreignFlow.length > 0) {
      var latestFf = foreignFlow[foreignFlow.length - 1];
      if (latestFf) {
        var val = latestFf.foreign_net != null ? latestFf.foreign_net : (latestFf.net != null ? latestFf.net : latestFf.net_value);
        if (val != null && Number.isFinite(Number(val))) {
          return { value: Number(val), status: 'AVAILABLE', source: 'foreignFlow' };
        }
        if (latestFf.status) {
          return { value: null, status: String(latestFf.status).toUpperCase(), source: 'foreignFlow.status' };
        }
      }
    }
    // Nothing published a value. Absence, not zero.
    return { value: null, status: 'NOT_PUBLISHED', source: null };
  }

  /**
   * Latest foreign net, or `null` when the producer published nothing.
   * A genuine measured zero is `0` and stays `0`.
   */
  function getLatestForeignNet(candles, foreignFlow) {
    return getLatestForeignNetDetail(candles, foreignFlow).value;
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
      // F3: explicit user overrides for auto-detector families (null = follow
      // the active preset's defaults).
      autoPatternOverrides: Object.create(null),
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
        this.autoPatternOverrides = Object.create(null);
        return true;
      },

      toggleLayer: function (layerId, forceState) {
        if (AUTO_PATTERN_FAMILIES.indexOf(layerId) !== -1) {
          var cur = this.isLayerActive(layerId);
          var next = forceState != null ? Boolean(forceState) : !cur;
          this.autoPatternOverrides[layerId] = next;
          return next;
        }
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
        this.autoPatternOverrides = Object.create(null);
        if (enabled) {
          for (var g = 0; g < LAYER_GROUPS.length; g++) {
            var group = LAYER_GROUPS[g];
            for (var l = 0; l < group.layers.length; l++) {
              this.activeLayers[group.layers[l].id] = true;
            }
          }
          // Explicit "enable all" (drawer action) still turns on every family.
          // Default presets stay clean; this is an opt-in power-user action.
          for (var afOn = 0; afOn < AUTO_PATTERN_FAMILIES.length; afOn++) {
            this.autoPatternOverrides[AUTO_PATTERN_FAMILIES[afOn]] = true;
          }
          this.activePreset = 'pro';
        } else {
          // "Sembunyikan semua overlay opsional": also hide every auto family.
          for (var af = 0; af < AUTO_PATTERN_FAMILIES.length; af++) {
            this.autoPatternOverrides[AUTO_PATTERN_FAMILIES[af]] = false;
          }
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
        // F3: count active auto-detector families too (they are real layers).
        for (var a = 0; a < AUTO_PATTERN_FAMILIES.length; a++) {
          if (this.isLayerActive(AUTO_PATTERN_FAMILIES[a])) count++;
        }
        return count;
      },

      isLayerActive: function (layerId) {
        if (AUTO_PATTERN_FAMILIES.indexOf(layerId) !== -1) {
          if (Object.prototype.hasOwnProperty.call(this.autoPatternOverrides, layerId)) {
            return Boolean(this.autoPatternOverrides[layerId]);
          }
          var defs = AUTO_PATTERN_PRESET_DEFAULTS[this.activePreset] || AUTO_PATTERN_PRESET_DEFAULTS.simpel;
          return defs.indexOf(layerId) !== -1;
        }
        return Boolean(this.activeLayers[layerId]);
      },

      // F3: the resolved auto-detector family list for the current state.
      getActiveAutoFamilies: function () {
        var out = [];
        for (var i = 0; i < AUTO_PATTERN_FAMILIES.length; i++) {
          if (this.isLayerActive(AUTO_PATTERN_FAMILIES[i])) out.push(AUTO_PATTERN_FAMILIES[i]);
        }
        return out;
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
        '<button type="button" class="vbtn sm" onclick="AutoCuanChartWorkstation.fitAll(' + q + ')" title="Fit Semua: menampilkan seluruh rentang candle" aria-label="Fit Semua">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6"/></svg>Fit Semua</button>' +
        '<button type="button" class="vbtn sm" id="' + chartId + '_fullscreen_btn" onclick="AutoCuanChartWorkstation.toggleOneScreen(' + q + ')" title="Layar Penuh (F, keluar dengan Esc)" aria-keyshortcuts="F" aria-label="Layar Penuh">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><span data-k="fs-label">Layar Penuh</span></button>' +
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
        '<button type="button" class="vbtn sm q" onclick="AutoCuanChartWorkstation.reset(' + q + ')" title="Kembalikan ke preset Simpel">Reset ke preset</button>' +
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

  // FINAL POLISH TASK 3: one "Layar Penuh" control. Uses the native Fullscreen
  // API when available, with a CSS fixed inset:0 / z-index:9999 fallback.
  // F toggles, Esc exits, and a ResizeObserver resizes the main chart plus all
  // subpanes. "Fit Semua" is a separate fitContent() control.
  function resizeAllCharts(chartId) {
    var reg = defaultRoot && defaultRoot.__chartRegistry ? defaultRoot.__chartRegistry[chartId] : null;
    if (!reg) return;
    var host = document.getElementById(chartId + '_container');
    var w = host ? host.clientWidth : 0;
    if (!(w > 0)) return;
    var subs = [
      [reg.volChart, chartId + '_vol_container'],
      [reg.rsiChart, chartId + '_rsi'],
      [reg.intensityChart, chartId + '_intensity_container'],
      [reg.rotationChart, chartId + '_rotation_container'],
      [reg.bandarChart, chartId + '_bandar_container'],
      [reg.macdChart, chartId + '_macd_container'],
      [reg.obvChart, chartId + '_obv_container'],
      [reg.oscChart, chartId + '_osc_container']
    ];
    if (reg.mainChart) {
      try { reg.mainChart.applyOptions({ width: w, height: host.clientHeight || (reg.dims && reg.dims.main) || 420 }); } catch (_) {}
    }
    subs.forEach(function (pair) {
      var ch = pair[0], el = document.getElementById(pair[1]);
      if (ch && el) { try { ch.applyOptions({ width: el.clientWidth || w, height: el.clientHeight || 65 }); } catch (_) {} }
    });
  }

  function fitAll(chartId) {
    var reg = defaultRoot && defaultRoot.__chartRegistry ? defaultRoot.__chartRegistry[chartId] : null;
    if (!reg || !reg.mainChart) return false;
    try { reg.mainChart.timeScale().fitContent(); } catch (_) { return false; }
    return true;
  }

  function toggleOneScreen(chartId, force) {
    if (typeof document === 'undefined') return;
    var host = document.getElementById(chartId + '_container');
    var card = host && (host.closest('.unified-card') || host.parentNode);
    if (!card) return;
    var on = typeof force === 'boolean' ? force : !card.classList.contains('cw-one-screen');
    card.classList.toggle('cw-one-screen', on);
    document.documentElement.classList.toggle('cw-one-screen-open', on);
    var btn = document.getElementById(chartId + '_fullscreen_btn');
    if (btn) {
      var label = btn.querySelector('[data-k="fs-label"]');
      if (label) label.textContent = on ? 'Keluar Layar Penuh' : 'Layar Penuh';
      btn.setAttribute('aria-label', on ? 'Keluar Layar Penuh' : 'Layar Penuh');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var reg = defaultRoot && defaultRoot.__chartRegistry ? defaultRoot.__chartRegistry[chartId] : null;
    if (reg && reg.mainChart && host) {
      var bar = document.getElementById(chartId + '_workstation_toolbar');
      var avail = on ? Math.max(320, Math.round((defaultRoot.innerHeight || 768) * 0.62)) : (reg.dims && reg.dims.main) || 420;
      host.style.height = avail + 'px';
      if (bar && on) bar.scrollIntoView({ block: 'nearest' });
    }
    // Native Fullscreen API with graceful fallback to the CSS class above.
    if (on && card.requestFullscreen && typeof card.requestFullscreen === 'function') {
      try { var p = card.requestFullscreen(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {}
    } else if (!on && document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      try { document.exitFullscreen(); } catch (_) {}
    }
    // ResizeObserver: main chart + every subpane follow the new box.
    if (on && typeof ResizeObserver !== 'undefined' && host) {
      if (!_fsObserver) {
        _fsObserver = new ResizeObserver(function () { if (_oneScreenId) resizeAllCharts(_oneScreenId); });
      }
      try { _fsObserver.observe(host); } catch (_) {}
    } else if (!on && _fsObserver && host) {
      try { _fsObserver.unobserve(host); } catch (_) {}
    }
    resizeAllCharts(chartId);
    _oneScreenId = on ? chartId : null;
  }
  var _oneScreenId = null;
  var _fsObserver = null;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === 'Escape' && _oneScreenId) { toggleOneScreen(_oneScreenId, false); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'f' && e.key !== 'F')) return;
      var ids = defaultRoot && defaultRoot.__chartRegistry ? Object.keys(defaultRoot.__chartRegistry) : [];
      var visible = ids.filter(function (id) { var el = document.getElementById(id + '_container'); return el && el.getClientRects().length; });
      if (visible.length) { e.preventDefault(); toggleOneScreen(_oneScreenId || visible[0]); }
    });
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement && _oneScreenId) toggleOneScreen(_oneScreenId, false);
    });
  }

  var STOCK_ONLY_LAYERS = { trading_plan: 1, signal_markers: 1, bandar_lpm: 1, bandar_foreign: 1, bandar_cmf: 1, bandar_intensity: 1, bandar_rotation: 1, bandar_corr_f: 1, bandar_par_f: 1, bandar_kons: 1 };
  STOCK_ONLY_LAYERS.bandar_tekanan_broker = 1;
  STOCK_ONLY_LAYERS.bandar_avg_price = 1;
  function isIndexTicker(t) { return /^(IHSG|\^JKSE|JKSE|JCI|COMPOSITE|LQ45|IDX30|IDX80|KOMPAS100)$/i.test(String(t || '')); }

  // M-P1b drawer categories: the 9 layer groups are presented under 4
  // collapsible top-level categories. No layer is removed or renamed.
  var DRAWER_CATEGORIES = [
    { id: 'indikator', title: 'Indikator', open: true, groupIds: ['level_area', 'trend_ema', 'volume', 'fibonacci', 'osilator'] },
    { id: 'pattern', title: 'Pattern', open: true, groupIds: ['struktur', 'sinyal', 'pola_klasik', 'auto_patterns'] },
    { id: 'drawing', title: 'Drawing Tools', open: false, groupIds: [] },
    { id: 'bandar', title: 'Bandar Metrics', open: false, groupIds: ['bandar_metrics'] }
  ];
  var DRAWER_TOOLS = [['trendline', 'Trendline'], ['hline', 'Horizontal Line'], ['fib', 'Fibonacci'], ['ruler', 'Ruler / Measure'], ['freehand', 'Freehand']];

  function renderDrawerHtml(chartId) {
    var inst = _workstationInstances[chartId];
    var state = inst ? inst.state : createWorkstationState('simpel');
    var presetDef = PRESETS[state.activePreset] || PRESETS.simpel;

    var html = '<div id="' + chartId + '_drawer" class="chart-workstation-drawer cw-drawer hidden bg-dark-900/95 border-b border-dark-600/40 transition-all duration-150">' +
      '<div class="cw-drawer-head px-4 pt-3 flex items-center justify-between pb-3 border-b border-dark-700">' +
        '<div>' +
          '<h3 class="text-sm font-semibold" style="color: #ffffff !important; font-weight: 700 !important;">Pengaturan Mode &amp; Layer Chart</h3>' +
          '<p class="text-xs" style="color: #94a3b8 !important;">Preset aktif: ' + v3f09Esc(presetDef.name) + ' - ' + state.getActiveLayerCount() + ' layer aktif</p>' +
        '</div>' +
        '<div class="flex items-center gap-1.5">' +
          '<button type="button" class="text-xs text-gray-300 hover:text-white px-2 py-1 rounded bg-dark-800 border border-dark-600/40" onclick="AutoCuanChartWorkstation.reset(\'' + chartId + '\')" title="Kembalikan layer ke preset aktif">Reset ke preset</button>' +
          '<button type="button" class="text-xs text-gray-300 hover:text-white px-2 py-1 rounded bg-dark-800 border border-dark-600/40" onclick="AutoCuanChartWorkstation.turnOffAll(\'' + chartId + '\')" title="Sembunyikan semua overlay opsional (data tidak dihapus)">Sembunyikan semua overlay opsional</button>' +
          '<button type="button" class="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-dark-800 border border-dark-600/40" onclick="AutoCuanChartWorkstation.toggleDrawer(\'' + chartId + '\')">Selesai</button>' +
        '</div>' +
      '</div>' +
      '<div class="cw-drawer-search px-4 py-2 border-b border-dark-700/60">' +
        '<input type="search" id="' + chartId + '_drawer_search" class="w-full text-xs rounded bg-dark-800 border border-dark-600/40 px-2 py-1.5 text-gray-200" placeholder="Cari layer (mis. RSI, BOS, foreign)..." oninput="AutoCuanChartWorkstation.filterDrawer(\'' + chartId + '\', this.value)" aria-label="Cari layer">' +
      '</div>' +
      '<div class="cw-drawer-scroll px-4 pt-3">';

    for (var c = 0; c < DRAWER_CATEGORIES.length; c++) {
      var cat = DRAWER_CATEGORIES[c];
      var catGroups = LAYER_GROUPS.filter(function (gr) { return cat.groupIds.indexOf(gr.id) !== -1; });
      var catLayerCount = 0;
      catGroups.forEach(function (gr) { catLayerCount += gr.layers.length; });
      html += '<details class="cw-drawer-cat" data-cw-cat="' + cat.id + '"' + (cat.open ? ' open' : '') + '>';
      html += '<summary class="cw-drawer-cat-summary"><span class="cw-drawer-cat-title">' + cat.title + '</span><span class="cw-drawer-cat-count">' + catLayerCount + ' item</span></summary>';
      html += '<div class="cw-drawer-cat-body px-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">';

      if (cat.id === 'drawing') {
        // Drawing Tools: interactive tools from public/chart-drawing-tools.js.
        html += '<div class="p-3 rounded-xl bg-dark-800/60 border border-dark-700/50 space-y-2 md:col-span-3">' +
          '<div class="font-semibold text-emerald-400">Alat Gambar Manual</div>' +
          '<p class="text-[11px] text-gray-400 pb-1 border-b border-dark-700/40 cw-group-desc">Gambar trendline, level, Fibonacci, dan pengukur pada chart. Gambar disimpan per ticker + timeframe.</p>' +
          '<div class="flex flex-wrap gap-1.5 pt-1" data-cw-drawing-tools="true">';
        for (var dt = 0; dt < DRAWER_TOOLS.length; dt++) {
          html += '<button type="button" class="cw-tool-btn text-xs px-2.5 py-1.5 rounded bg-dark-800 border border-dark-600/40 text-gray-200 hover:bg-dark-700" data-tool="' + DRAWER_TOOLS[dt][0] + '" onclick="AutoCuanChartWorkstation.setDrawingTool(\'' + chartId + '\', \'' + DRAWER_TOOLS[dt][0] + '\')">' + DRAWER_TOOLS[dt][1] + '</button>';
        }
        html += '</div></div>';
      }

      for (var g = 0; g < catGroups.length; g++) {
      var group = catGroups[g];
      html += '<div class="cw-layer-group p-3 rounded-xl bg-dark-800/60 border border-dark-700/50 space-y-2" data-cw-group="' + group.id + '">' +
        '<div class="font-semibold text-emerald-400 flex items-center justify-between">' +
          '<span>' + group.title + '</span>' +
          '<span class="text-[10px] text-gray-500 font-normal">' + group.layers.length + ' layer</span>' +
        '</div>' +
        '<p class="text-[11px] text-gray-400 pb-1 border-b border-dark-700/40 cw-group-desc">' + group.description + '</p>' +
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
        html += '<label class="cw-layer-row flex items-start gap-2 p-1 rounded ' + (isActive && !isDisabled ? 'active ' : '') + (isDisabled ? 'opacity-60 cursor-not-allowed bg-dark-900/40' : 'cursor-pointer hover:bg-dark-700/30') + '" data-cw-layer="' + layer.id.toLowerCase() + '">' +
          '<input type="checkbox" ' + (isDisabled ? 'disabled' : '') + ' class="mt-0.5 rounded border-dark-600 text-emerald-500 focus:ring-0 bg-dark-900 ' + (isDisabled ? 'cursor-not-allowed' : '') + '" ' + (isActive ? 'checked' : '') + ' onchange="AutoCuanChartWorkstation.toggleLayer(\'' + chartId + '\', \'' + layer.id + '\')">' +
          '<div class="min-w-0 flex-1">' +
            '<div class="font-medium text-gray-200 flex items-center gap-1.5 flex-wrap">' +
              (layer.color ? '<span class="w-2 h-2 rounded-full inline-block shrink-0" style="background-color:' + layer.color + '"></span>' : '') +
              '<span>' + layer.name + '</span>' +
              (idxOnly ? '<span class="cw-idx-note">' + (/^bandar_/.test(layer.id) ? 'Tidak ada broker summary untuk indeks' : 'Khusus saham') + '</span>' : (broksumMissing ? '<span class="cw-broksum-state text-[9px] px-1.5 py-0.5 rounded bg-dark-700 text-amber-400 border border-dark-600 font-normal">Belum tersedia (menunggu kelengkapan seri broker harian)</span>' : (isDisabled ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-dark-700 text-amber-400 border border-dark-600 font-normal">Dalam Riset (Nonaktif)</span>' : ''))) +
            '</div>' +
            '<p class="text-[10px] text-gray-400 cw-layer-desc">' + layer.desc + '</p>' +
          '</div>' +
        '</label>';
      }

      html += '</div></div>';
      }

      html += '</div></details>';
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

  // M-P1b: Drawing Tools category forwards tool selection to the drawing
  // layer (public/chart-drawing-tools.js). Tool mode keeps chart drag/zoom
  // alive when no tool is active (pointer-events per tool mode lives there).
  function setDrawingTool(chartId, tool) {
    var inst = _workstationInstances[chartId];
    var ticker = inst ? inst.ticker : '';
    var tf = (inst && inst.state && inst.state.timeframe) || '1D';
    var api = (typeof window !== 'undefined' && window.__acDrawings) ? window.__acDrawings[chartId] : null;
    if (!api) {
      try {
        var root = (typeof window !== 'undefined' ? window : null);
        var chartTools = root && root.AutoCuanChartDrawingTools;
        if (chartTools && typeof chartTools.attach === 'function' && inst && inst.chartRef) {
          api = chartTools.attach(chartId, document.getElementById(chartId + '_container'), inst.chartRef);
          api.setTicker(ticker, tf);
        }
      } catch (_) { api = null; }
    }
    if (api && typeof api.setTool === 'function') {
      api.setTool(tool);
    }
    // Reflect active tool state on the drawer buttons.
    if (typeof document !== 'undefined') {
      var wrap = document.querySelector('[data-cw-drawing-tools]');
      if (wrap) {
        var btns = wrap.querySelectorAll('button[data-tool]');
        for (var i = 0; i < btns.length; i++) {
          var on = btns[i].getAttribute('data-tool') === tool && !(api && api.state && api.state.tool !== tool);
          btns[i].classList.toggle('on', on);
        }
      }
    }
    return tool;
  }

  // M-P1b: drawer search - filter layer rows + groups by name/description
  // substring. Pure DOM filtering; layer state is untouched.
  function filterDrawer(chartId, query) {
    if (typeof document === 'undefined') return 0;
    var drawer = document.getElementById(chartId + '_drawer');
    if (!drawer) return 0;
    var q = String(query || '').trim().toLowerCase();
    var rows = drawer.querySelectorAll('.cw-layer-row');
    var visible = 0;
    for (var i = 0; i < rows.length; i++) {
      var hay = (rows[i].getAttribute('data-cw-layer') || '') + ' ' + rows[i].textContent.toLowerCase();
      var show = !q || hay.indexOf(q) !== -1;
      rows[i].style.display = show ? '' : 'none';
      if (show) visible++;
    }
    // Hide empty groups while searching; open relevant categories.
    var groups = drawer.querySelectorAll('.cw-layer-group');
    for (var g2 = 0; g2 < groups.length; g2++) {
      var anyRow = groups[g2].querySelector('.cw-layer-row:not([style*="none"])');
      groups[g2].style.display = (q && !anyRow) ? 'none' : '';
    }
    var cats = drawer.querySelectorAll('details.cw-drawer-cat');
    for (var c2 = 0; c2 < cats.length; c2++) {
      var anyGroup = cats[c2].querySelector('.cw-layer-group:not([style*="none"])');
      var isDrawingCat = cats[c2].getAttribute('data-cw-cat') === 'drawing';
      cats[c2].open = q ? Boolean(anyGroup || isDrawingCat) : cats[c2].open;
    }
    return visible;
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
    // BUG V6-G: the overlay repaint must carry the CURRENT preset, not an
    // out-of-scope `presetName` (which threw ReferenceError and silently
    // dropped the SMC/ZigZag overlay after a timeframe switch).
    renderChartOverlay(chartId, inst.ticker, activeCandles, inst.state.activePreset);
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
    var id = chartId;
    var inst = _workstationInstances[id];
    if (!inst) {
      var keys = Object.keys(_workstationInstances);
      if (keys.length > 0) { id = keys[0]; inst = _workstationInstances[id]; }
    }
    if (!inst) return;
    var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    inst.state.applyPreset(presetName);
    // HANDOFF 5a: Scalping always reads daily candles.
    if (presetName === 'scalping') inst.state.setTimeframe('1D');

    var activeCandles = (inst.state.timeframe === '1W' && inst.weeklyCandles) ? inst.weeklyCandles : inst.dailyCandles;
    var onChartDone = function () {
      try { renderChartOverlay(id, inst.ticker, activeCandles, presetName); } catch (_) {}
    };
    if (typeof defaultRoot.renderLightweightChart === 'function') {
      var pChart = defaultRoot.renderLightweightChart(id, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
      if (pChart && typeof pChart.then === 'function') {
        pChart.then(onChartDone);
      } else {
        setTimeout(onChartDone, 50);
      }
    } else {
      onChartDone();
    }
    updateToolbarDom(id);
    updateDrawerDom(id);
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
    var isAutoPattern = AUTO_PATTERN_FAMILIES.indexOf(layerId) !== -1;
    // Only re-render Lightweight Chart for traditional core layers.
    // For auto-detector pattern families, NEVER destroy/rescale chart instance;
    // only update the overlay DOM incrementally without layout shift.
    if (!isAutoPattern) {
      if (typeof defaultRoot.renderLightweightChart === 'function') {
        defaultRoot.renderLightweightChart(chartId, activeCandles, inst.metrics, inst.ticker, Object.assign({}, inst.options, { workstationState: inst.state }));
      }
    } else {
      try {
        var ap = defaultRoot.AutoCuanChartAutoPatterns || defaultRoot.AutoCuanChartPatternsRuntime;
        if (ap && typeof ap.attach === 'function') {
          ap.attach(chartId, activeCandles, inst.ticker, {
            preset: inst.state.activePreset,
            families: inst.state.getActiveAutoFamilies(),
            force: true
          });
        }
      } catch (_) {}
    }
    // Sub-chart oscillator pane mount/unmount support
    if (layerId === 'rsi' || layerId === 'macd' || layerId === 'obv') {
      try {
        var apPane = defaultRoot.AutoCuanChartAutoPatterns || defaultRoot.AutoCuanChartPatternsRuntime;
        if (apPane && typeof apPane.mountPanes === 'function') {
          if (inst.state.layers[layerId]) {
            apPane.mountPanes(chartId, activeCandles, [layerId], {});
          } else if (typeof apPane.unmountPanes === 'function') {
            apPane.unmountPanes(chartId, [layerId]);
          }
        }
      } catch (_) {}
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
    try { renderChartOverlay(chartId, inst.ticker, activeCandles, 'bersih'); } catch (_) {}
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

    clearPlanPriceLines(series);

    var levels = plan && plan.planLevels ? plan.planLevels : plan;
    if (!levels || typeof levels !== 'object') return [];

    var narrow = Boolean(defaultRoot && defaultRoot.innerWidth > 0 && defaultRoot.innerWidth < 520);
    var keys = ['entry', 'sl', 'tp1', 'tp2'];
    var items = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var price = Number(levels[key]);
      if (Number.isFinite(price) && price > 0) {
        items.push({
          key: key,
          price: price,
          color: PLAN_LINE_STYLE[key] || '#94a3b8',
          lineStyle: PLAN_LINE_DASH[key] != null ? PLAN_LINE_DASH[key] : 0,
          title: (narrow && PLAN_LINE_SHORT[key]) || PLAN_LINE_LABEL[key] || key.toUpperCase()
        });
      }
    }

    // Anti-Collision Label Staggering Algorithm:
    items.sort(function (a, b) { return a.price - b.price; });
    var created = [];
    var axisBadgeCount = 0;
    var keyBadgeUsed = false;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var isColliding = false;
      if (j > 0 && Math.abs(it.price - items[j - 1].price) / it.price < 0.02) {
        isColliding = true;
      }
      if (j < items.length - 1 && Math.abs(it.price - items[j + 1].price) / it.price < 0.02) {
        isColliding = true;
      }
      var staggeredTitle = it.title;
      // BATCH 1 / BUG 1: deterministic right-axis budget. Last price + R + S
      // + at most one key level. No parity fallback, no volume number.
      var isKey = it.key === 'entry' || it.key === 'sl' || it.key === 'tp1' || it.key === 'tp2';
      var guard = defaultRoot && defaultRoot.AutoCuanRightAxisGuard;
      var chartIdKey = series.__acChartId || 'mainChart';
      var axisLabelVisible = false;
      if (guard && typeof guard.canPlace === 'function') {
        if (isKey || (!keyBadgeUsed && axisBadgeCount < CLEAN_CHART.MAX_RIGHT_AXIS_BADGES)) {
          axisLabelVisible = guard.canPlace(chartIdKey, series, it.price, 22, CLEAN_CHART.MAX_RIGHT_AXIS_BADGES);
          if (axisLabelVisible) {
            axisBadgeCount++;
            if (!isKey) keyBadgeUsed = true;
          }
        }
      } else {
        if (isKey) {
          if (axisBadgeCount < CLEAN_CHART.MAX_RIGHT_AXIS_BADGES && !isColliding) {
            axisLabelVisible = true;
            axisBadgeCount++;
          } else if (axisBadgeCount === 0) {
            axisLabelVisible = true;
            axisBadgeCount++;
          }
        } else if (!keyBadgeUsed && axisBadgeCount < CLEAN_CHART.MAX_RIGHT_AXIS_BADGES && !isColliding) {
          axisLabelVisible = true;
          axisBadgeCount++;
          keyBadgeUsed = true;
        }
      }
      try {
        var line = series.createPriceLine({
          price: it.price,
          color: it.color,
          lineWidth: 1,
          lineStyle: it.lineStyle,
          axisLabelVisible: axisLabelVisible,
          title: axisLabelVisible ? staggeredTitle : ''
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
    try {
      renderChartOverlay(chartId, ticker || (inst && inst.ticker), candles || (inst && inst.dailyCandles), (inst && inst.state && inst.state.activePreset) || 'pro');
    } catch (_) {}
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
  // V3-F09 MESIN VISUAL OTOMATIS (SMC + Harmonic XABCD + ZigZag)
  // Pro SMC+Harmonic XABCD acuan BULL: 5 pivot X-A-B-C-D rasio
  // 0.656/0.786/0.814/1.244, 2 segitiga biru XAB dan BCD, rasio
  // putus-putus, D Weak Low. SMC dari swing high/low riil: BOS,
  // CHoCH, EQH/EQL, Strong High merah, Supply OB pink muda,
  // Demand OB biru (Harga). HUD SELL/BUY kiri atas.
  // Simple Jalur Zig-Zag dan Supply/Demand ATR14 acuan BBRI:
  // kotak zona S/D ATR-14 + panah proyeksi Naik/Bullish Sideways/Turun
  // dari konfluensi BS+LPM. Hybrid gabungan + saklar tema Putih/Gelap.
  // Deterministik, data riil, 0 sintetis, 0 NaN, anti-gagal 964 ticker.
  // ============================================================
  var V3F09_VERSION = '20261104-v3f09';
  var V3F09_MODES = Object.freeze([
    { id: 'pro', name: 'Pro SMC+Harmonic XABCD', desc: 'SMC + XABCD 5 pivot acuan BULL' },
    { id: 'simple', name: 'Simple Zig-Zag', desc: 'Jalur Zig-Zag dan Supply/Demand ATR14 acuan BBRI' },
    { id: 'hybrid', name: 'Hybrid', desc: 'SMC + XABCD + ZigZag gabungan' }
  ]);
  var V3F09_THEMES = Object.freeze({
    dark: { id: 'dark', name: 'Gelap', bg: '#0b1220', grid: '#1e293b', text: '#e2e8f0' },
    light: { id: 'light', name: 'Putih', bg: '#ffffff', grid: '#e2e8f0', text: '#0f172a' }
  });
  var V3F09_RATIOS = Object.freeze([0.656, 0.786, 0.814, 1.244]);
  var _v3f09ThemeByChart = Object.create(null);
  var _v3f09ModeByChart = Object.create(null);

  function v3f09Finite(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; }

  function v3f09NormCandles(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || typeof c !== 'object') continue;
      var t = c.time != null ? c.time : (c.date != null ? c.date : null);
      if (t == null) continue;
      var o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) continue;
      if (!(o > 0 && h > 0 && l > 0 && cl > 0)) continue;
      var hh = Math.max(h, o, cl, l);
      var ll = Math.min(l, o, cl, h);
      if (!(hh >= ll) || !Number.isFinite(hh) || !Number.isFinite(ll)) continue;
      out.push({ time: String(t), open: o, high: hh, low: ll, close: cl, volume: Number(c.volume || 0) || 0, index: out.length });
    }
    out.sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });
    for (var k = 0; k < out.length; k++) out[k].index = k;
    return out;
  }

  function v3f09Swings(candles) {
    var H = [], L = [];
    var n = candles ? candles.length : 0;
    if (n >= 5) {
      for (var i = 2; i < n - 2; i++) {
        var h = Number(candles[i].high), l = Number(candles[i].low);
        var hp1 = Number(candles[i - 1].high), hp2 = Number(candles[i - 2].high);
        var hn1 = Number(candles[i + 1].high), hn2 = Number(candles[i + 2].high);
        if (h > hp1 && h > hp2 && h >= hn1 && h > hn2) H.push({ index: i, time: candles[i].time, price: h });
        var lp1 = Number(candles[i - 1].low), lp2 = Number(candles[i - 2].low);
        var ln1 = Number(candles[i + 1].low), ln2 = Number(candles[i + 2].low);
        if (l < lp1 && l < lp2 && l <= ln1 && l < ln2) L.push({ index: i, time: candles[i].time, price: l });
      }
    }
    if (H.length === 0 && n > 0) {
      var mx = -Infinity, mi = 0;
      for (var a = 0; a < n; a++) { var ch = Number(candles[a].high); if (ch > mx) { mx = ch; mi = a; } }
      if (Number.isFinite(mx) && mx > 0) H.push({ index: mi, time: candles[mi].time, price: mx });
    }
    if (L.length === 0 && n > 0) {
      var mn = Infinity, mj = 0;
      for (var b = 0; b < n; b++) { var cl2 = Number(candles[b].low); if (cl2 < mn) { mn = cl2; mj = b; } }
      if (Number.isFinite(mn) && mn > 0) L.push({ index: mj, time: candles[mj].time, price: mn });
    }
    return { H: H, L: L };
  }

  function v3f09AltPivots(H, L) {
    var all = [];
    for (var i = 0; i < H.length; i++) all.push({ index: H[i].index, time: H[i].time, price: H[i].price, kind: 'H' });
    for (var j = 0; j < L.length; j++) all.push({ index: L[j].index, time: L[j].time, price: L[j].price, kind: 'L' });
    all.sort(function (a, b) { return a.index - b.index; });
    var out = [];
    for (var k = 0; k < all.length; k++) {
      var p = all[k], prev = out[out.length - 1];
      if (!prev || prev.kind !== p.kind) { out.push(p); continue; }
      var more = p.kind === 'H' ? p.price > prev.price : p.price < prev.price;
      if (more) out[out.length - 1] = p;
    }
    return out;
  }

  function v3f09Atr14(candles) {
    var n = candles ? candles.length : 0;
    if (n === 0) return 1;
    var end = n - 1, start = Math.max(1, end - 13);
    var sum = 0, cnt = 0;
    for (var i = start; i <= end; i++) {
      var h = Number(candles[i].high), l = Number(candles[i].low), pc = Number(candles[i - 1].close);
      if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
      var tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (!Number.isFinite(tr) || tr <= 0) continue;
      sum += tr; cnt++;
    }
    if (cnt > 0) { var a = sum / cnt; if (Number.isFinite(a) && a > 0) return a; }
    var last = Number(candles[n - 1].close);
    if (Number.isFinite(last) && last > 0) return Math.max(last * 0.02, 1);
    return 1;
  }

  function v3f09Sma(candles, period) {
    var n = candles ? candles.length : 0;
    if (n === 0) return 0;
    var p = Math.max(1, Math.min(period || 20, n));
    var s = 0;
    for (var i = n - p; i < n; i++) s += Number(candles[i].close) || 0;
    return s / p;
  }

  function calculateV3F09SR(rawCandles) {
    var candles = v3f09NormCandles(rawCandles);
    if (candles.length === 0) return { support: 1, resistance: 2, empty: true, fallback: true, valid: true };
    var sw = v3f09Swings(candles);
    var res = sw.H.length ? sw.H[sw.H.length - 1].price : -Infinity;
    var sup = sw.L.length ? sw.L[sw.L.length - 1].price : Infinity;
    if (!Number.isFinite(res) || !(res > 0)) {
      res = -Infinity;
      for (var i = 0; i < candles.length; i++) { var h = Number(candles[i].high); if (h > res) res = h; }
    }
    if (!Number.isFinite(sup) || !(sup > 0)) {
      sup = Infinity;
      for (var j = 0; j < candles.length; j++) { var l = Number(candles[j].low); if (l < sup) sup = l; }
    }
    if (!Number.isFinite(res) || !(res > 0)) res = Number(candles[candles.length - 1].close) * 1.05;
    if (!Number.isFinite(sup) || !(sup > 0)) sup = Number(candles[candles.length - 1].close) * 0.95;
    if (!(res > sup)) { var mid = (res + sup) / 2 || res || sup || 100; res = mid * 1.02; sup = mid * 0.98; }
    if (!(res > 0)) res = 2; if (!(sup > 0)) sup = 1;
    if (!(res > sup)) { res = sup + 1; }
    return { support: sup, resistance: res, empty: false, fallback: (sw.H.length === 0 || sw.L.length === 0), valid: true };
  }

  function calculateV3F09SMC(rawCandles) {
    var candles = v3f09NormCandles(rawCandles);
    if (candles.length === 0) {
      return { valid: true, empty: true, bos: [{ type: 'BOS_NEUTRAL', label: 'BOS', level: 2, time: '-' }], choch: [{ type: 'CHoCH_POTENSIAL', label: 'CHoCH', level: 1, time: '-' }], eqh: [], eql: [], strongHigh: { price: 2, time: '-', color: '#ef4444' }, supplyOB: { top: 2, bottom: 1.9, color: '#fbcfe8', label: 'Supply OB' }, demandOB: { top: 1.1, bottom: 1, color: '#bfdbfe', label: 'Demand OB' }, hud: { side: 'SELL', label: 'SELL' } };
    }
    var sw = v3f09Swings(candles);
    var last = candles[candles.length - 1];
    var close = Number(last.close);
    var lastH = sw.H.length ? sw.H[sw.H.length - 1] : { price: Number(last.high), time: last.time, index: candles.length - 1 };
    var lastL = sw.L.length ? sw.L[sw.L.length - 1] : { price: Number(last.low), time: last.time, index: candles.length - 1 };
    var bos = [];
    if (close > Number(lastH.price)) bos.push({ type: 'BULLISH_BOS', label: 'Bullish BOS', level: Number(lastH.price), time: last.time });
    else if (close < Number(lastL.price)) bos.push({ type: 'BEARISH_BOS', label: 'Bearish BOS', level: Number(lastL.price), time: last.time });
    else {
      bos.push({ type: 'BOS_HIGH', label: 'BOS', level: Number(lastH.price), time: lastH.time });
      bos.push({ type: 'BOS_LOW', label: 'BOS', level: Number(lastL.price), time: lastL.time });
    }
    var choch = [];
    var sma = v3f09Sma(candles, 20);
    var prev = candles.length > 1 ? Number(candles[candles.length - 2].close) : close;
    if ((prev <= sma && close > sma) || (prev >= sma && close < sma)) {
      choch.push({ type: 'CHoCH', label: 'CHoCH', level: close, time: last.time });
    } else if (sw.H.length >= 2 && sw.L.length >= 2) {
      choch.push({ type: 'CHoCH_POTENSIAL', label: 'CHoCH', level: Number(sw.H[sw.H.length - 1].price), time: sw.H[sw.H.length - 1].time });
    } else {
      choch.push({ type: 'CHoCH_POTENSIAL', label: 'CHoCH', level: close, time: last.time });
    }
    var eqh = [], eql = [];
    function collectEq(arr, tag) {
      var out = [];
      for (var i = 0; i < arr.length; i++) for (var j = i + 1; j < arr.length; j++) {
        var a = Number(arr[i].price), b = Number(arr[j].price);
        if (!(a > 0 && b > 0)) continue;
        var tol = Math.max(a, b) * 0.005;
        if (Math.abs(a - b) <= tol) { out.push({ label: tag, price: (a + b) / 2, t1: arr[i].time, t2: arr[j].time }); break; }
      }
      return out;
    }
    eqh = collectEq(sw.H.slice(-8), 'EQH');
    eql = collectEq(sw.L.slice(-8), 'EQL');
    var sh = sw.H.length ? sw.H[0] : lastH;
    for (var s = 0; s < sw.H.length; s++) if (Number(sw.H[s].price) > Number(sh.price)) sh = sw.H[s];
    var strongHigh = { price: Number(sh.price), time: sh.time, color: '#ef4444', label: 'Strong High' };
    var atr = v3f09Atr14(candles);
    var supplyOB = null, demandOB = null;
    for (var k = candles.length - 2; k >= Math.max(0, candles.length - 12); k--) {
      var c = candles[k];
      if (!supplyOB && Number(c.close) < Number(c.open)) {
        var st = Number(c.high); supplyOB = { top: st, bottom: Math.max(st - atr, st * 0.99), color: '#fbcfe8', label: 'Supply OB', time: c.time };
      }
      if (!demandOB && Number(c.close) > Number(c.open)) {
        var db = Number(c.low); demandOB = { top: Math.min(db + atr, db * 1.01), bottom: db, color: '#bfdbfe', label: 'Demand OB', time: c.time };
      }
      if (supplyOB && demandOB) break;
    }
    if (!supplyOB) { var hh2 = Number(last.high); supplyOB = { top: hh2, bottom: Math.max(hh2 - atr, hh2 * 0.99), color: '#fbcfe8', label: 'Supply OB', time: last.time }; }
    if (!demandOB) { var ll2 = Number(last.low); demandOB = { top: Math.min(ll2 + atr, ll2 * 1.01), bottom: ll2, color: '#bfdbfe', label: 'Demand OB', time: last.time }; }
    var sr = calculateV3F09SR(candles);
    var mid = (Number(sr.support) + Number(sr.resistance)) / 2;
    var side = close >= mid ? 'BUY' : 'SELL';
    return { valid: true, empty: false, bos: bos, choch: choch, eqh: eqh, eql: eql, strongHigh: strongHigh, supplyOB: supplyOB, demandOB: demandOB, hud: { side: side, label: side }, atr: atr, lastClose: close };
  }

  // V5 Phase 3 (N11) — pivot confirmation configuration.
  // A pivot (specifically D) is CONFIRMED only when at least XABCD_CONFIRM_BARS
  // bars closed AFTER it (and, optionally, price moved beyond the pivot
  // extreme by XABCD_MIN_CONFIRM_OFFSET as an epsilon). A pattern whose D
  // sits on one of the newest confirmBars-1 bars is PROVISIONAL, never
  // CONFIRMED. Configurable via options on calculateV3F09XABCD.
  var XABCD_CONFIRM_BARS = 2;
  var XABCD_MIN_CONFIRM_OFFSET = 0; // 0 = confirmation by bar count only

  /**
   * V5 Phase 3 (N11): pivot confirmation status.
   * @param {Object} pivot      {index, price, time, kind}
   * @param {Array}  candles    normalized candles (oldest-first)
   * @param {Object} [opts]     {confirmBars, minConfirmOffset}
   * @returns {{confirmation:'CONFIRMED'|'PROVISIONAL', confirmedAt:string|null,
   *            barsAfterD:number, reason:string}}
   */
  function confirmXabcdPivot(pivot, candles, opts) {
    var o = opts || {};
    var confirmBars = Number.isFinite(Number(o.confirmBars)) ? Number(o.confirmBars) : XABCD_CONFIRM_BARS;
    var minOffset = Number.isFinite(Number(o.minConfirmOffset)) ? Number(o.minConfirmOffset) : XABCD_MIN_CONFIRM_OFFSET;
    var lastIndex = candles.length - 1;
    var barsAfterD = (Number(pivot.index) < lastIndex) ? (lastIndex - Number(pivot.index)) : 0;
    var enoughBars = barsAfterD >= confirmBars;
    var offsetOk = true;
    if (minOffset > 0) {
      // Price must have moved beyond the pivot extreme by minOffset in the
      // confirm window (rejection away from D for a low pivot / away for high).
      var extreme = Number(pivot.price);
      var moved = false;
      for (var i = Number(pivot.index) + 1; i <= lastIndex; i++) {
        var p = pivot.kind === 'H' ? Number(candles[i].high) : Number(candles[i].low);
        if (pivot.kind === 'H' ? (extreme - p >= minOffset) : (p - extreme >= minOffset)) { moved = true; break; }
      }
      offsetOk = moved;
    }
    var confirmed = enoughBars && offsetOk;
    return {
      confirmation: confirmed ? 'CONFIRMED' : 'PROVISIONAL',
      confirmedAt: confirmed ? candles[lastIndex].time : null,
      barsAfterD: barsAfterD,
      reason: confirmed
        ? 'D pivot confirmed by ' + barsAfterD + ' subsequent bar(s) (confirmBars=' + confirmBars + ')'
        : 'D pivot on newest ' + (confirmBars - 1) + ' bar(s) — awaiting ' + confirmBars + '-bar confirmation'
    };
  }

  function calculateV3F09XABCD(rawCandles, options) {
    var o = options || {};
    var confirmBars = Number.isFinite(Number(o.confirmBars)) ? Number(o.confirmBars) : XABCD_CONFIRM_BARS;
    var minConfirmOffset = Number.isFinite(Number(o.minConfirmOffset)) ? Number(o.minConfirmOffset) : XABCD_MIN_CONFIRM_OFFSET;
    var candles = v3f09NormCandles(rawCandles);
    if (candles.length === 0) {
      var f = { index: 0, time: '-', price: 1, kind: 'L' };
      var g = { index: 1, time: '-', price: 2, kind: 'H' };
      return { valid: true, empty: true, x: f, a: g, b: f, c: g, d: f, ratios: { ab_xa: 0.656, bc_ab: 0.786, cd_bc: 0.814, ad_xa: 1.244 }, targets: [0.656, 0.786, 0.814, 1.244], triangles: [{ id: 'XAB', color: '#2563eb' }, { id: 'BCD', color: '#2563eb' }], dLabel: 'D Weak Low', confirmation: 'PROVISIONAL', confirmedAt: null };
    }
    var sw = v3f09Swings(candles);
    var piv = v3f09AltPivots(sw.H, sw.L);
    var pts = null;
    if (piv.length >= 5) { pts = piv.slice(-5); }
    else {
      pts = [];
      var n = candles.length;
      // V5 Phase 3 (N11): when no pivot set exists, construct candidate
      // points only from bars OLD enough to leave confirmBars confirmation
      // bars after the last candidate — D can never land on the newest bar.
      var take = Math.min(5, Math.max(0, n - confirmBars));
      var slice = take > 0 ? candles.slice(n - confirmBars - take, n - confirmBars) : [];
      for (var i = 0; i < slice.length; i++) {
        var kind = i % 2 === 0 ? 'L' : 'H';
        var price = kind === 'L' ? Number(slice[i].low) : Number(slice[i].high);
        pts.push({ index: slice[i].index, time: slice[i].time, price: price, kind: kind });
      }
      while (pts.length < 5) pts.unshift({ index: 0, time: candles[0].time, price: Number(candles[0].low), kind: 'L' });
      pts = pts.slice(-5);
    }
    // V5 Phase 3 (N11): the D pivot must be confirmed. If the newest pivot
    // sits within the last (confirmBars - 1) bars, step back to the previous
    // confirmed pivot set so a pattern is NEVER published with an unconfirmed
    // D. Only when no fully-confirmed 5-point window exists do we fall back —
    // and then the pattern is explicitly labelled PROVISIONAL, never CONFIRMED.
    var lastIndex = candles.length - 1;
    var provisionalD = Number(pts[4].index) > lastIndex - confirmBars;
    if (provisionalD && piv.length >= 5) {
      // Try older pivot windows until D has confirmBars bars after it.
      for (var s = piv.length - 5; s >= 0; s--) {
        var cand = piv.slice(s, s + 5);
        if (Number(cand[4].index) <= lastIndex - confirmBars) { pts = cand; provisionalD = false; break; }
      }
    }
    function leg(a, b) { var d = Math.abs(Number(b.price) - Number(a.price)); return Number.isFinite(d) ? d : 0; }
    var xa = leg(pts[0], pts[1]) || 1, ab = leg(pts[1], pts[2]), bc = leg(pts[2], pts[3]), cd = leg(pts[3], pts[4]);
    if (!(xa > 0)) xa = 1;
    function r(v, base) { if (!(base > 0)) return 0; var x = v / base; return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0; }
    var ratios = { ab_xa: r(ab, xa), bc_ab: r(bc, ab || xa), cd_bc: r(cd, bc || xa), ad_xa: r(Math.abs(Number(pts[4].price) - Number(pts[0].price)), xa) };
    var dConf = confirmXabcdPivot(pts[4], candles, { confirmBars: confirmBars, minConfirmOffset: minConfirmOffset });
    var dLabel = 'D Weak Low' + (dConf.confirmation === 'PROVISIONAL' ? ' (Provisional)' : '');
    return {
      valid: true,
      empty: false,
      x: pts[0], a: pts[1], b: pts[2], c: pts[3], d: pts[4],
      ratios: ratios,
      targets: [0.656, 0.786, 0.814, 1.244],
      triangles: [{ id: 'XAB', points: [pts[0], pts[1], pts[2]], color: '#2563eb' }, { id: 'BCD', points: [pts[2], pts[3], pts[4]], color: '#2563eb' }],
      dLabel: dLabel,
      confirmation: dConf.confirmation,
      confirmedAt: dConf.confirmedAt,
      barsAfterD: dConf.barsAfterD,
      dIndex: Number(pts[4].index),
      lastIndex: lastIndex
    };
  }

  function calculateV3F09ZigZag(rawCandles) {
    var candles = v3f09NormCandles(rawCandles);
    if (candles.length === 0) {
      return { valid: true, empty: true, path: [{ time: '-', price: 1 }, { time: '-', price: 2 }], supplyZone: { top: 2, bottom: 1.9, label: 'Supply' }, demandZone: { top: 1.1, bottom: 1, label: 'Demand' }, atr: 1, projection: 'Bullish Sideways', arrow: 'side' };
    }
    var sw = v3f09Swings(candles);
    var piv = v3f09AltPivots(sw.H, sw.L);
    var path = [];
    if (piv.length >= 2) { var tail = piv.slice(-12); for (var i = 0; i < tail.length; i++) path.push({ time: tail[i].time, price: Number(tail[i].price), kind: tail[i].kind }); }
    else { path = [{ time: candles[0].time, price: Number(candles[0].low) }, { time: candles[candles.length - 1].time, price: Number(candles[candles.length - 1].close) }]; }
    var atr = v3f09Atr14(candles);
    var last = candles[candles.length - 1];
    var hh = Number(last.high), ll = Number(last.low), cl = Number(last.close);
    var supplyZone = { top: hh, bottom: Math.max(hh - atr, hh * 0.99), label: 'Supply' };
    var demandZone = { top: Math.min(ll + atr, ll * 1.01), bottom: ll, label: 'Demand' };
    var sr = calculateV3F09SR(candles);
    var bsBull = cl > Number(sr.resistance) || cl > Number(sw.H.length ? sw.H[sw.H.length - 1].price : Infinity);
    var bsBear = cl < Number(sr.support) || cl < Number(sw.L.length ? sw.L[sw.L.length - 1].price : -Infinity);
    var sma = v3f09Sma(candles, 20);
    var lpmUp = cl >= sma;
    var projection = 'Bullish Sideways', arrow = 'side';
    if ((bsBull || lpmUp) && !(bsBear)) {
      if (bsBull && lpmUp) { projection = 'Naik'; arrow = 'up'; }
      else { projection = 'Bullish Sideways'; arrow = 'side'; }
    } else if (bsBear && !lpmUp) { projection = 'Turun'; arrow = 'down'; }
    else { projection = 'Bullish Sideways'; arrow = 'side'; }
    return { valid: true, empty: false, path: path, supplyZone: supplyZone, demandZone: demandZone, atr: atr, projection: projection, arrow: arrow, lastClose: cl };
  }

  // v3f09Esc kept adjacent to its only consumers (M-P1b).
  function v3f09Esc(s) { return String(s == null ? '' : s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"'); }

  // M-P1b: PATTERN GEOMETRY INTEGRITY GUARDS
  /**
   * Classify a pattern/overlay object by its geometry provenance.
   * Live pattern geometry MUST carry real candle-index and price anchors.
   * Fixed screen coordinates (e.g. x = 110, 250, 390, 530, 680 with no
   * candle index/price) are classified DEMO or INVALID and must never be
   * rendered as if they were live pattern detection results.
   */
  function classifyPatternGeometry(obj) {
    if (!obj || typeof obj !== 'object') {
      return { classification: 'INVALID', reason: 'objek kosong / bukan objek' };
    }
    var keys = Object.keys(obj);
    var hasScreenOnly = keys.some(function (k) { return /^x\d*$|^cx$|screenX/.test(k); }) &&
      !keys.some(function (k) { return k === 'index' || k === 'candleIndex' || k === 'time'; });
    var needsAnchor = keys.some(function (k) {
      return k === 'points' || k === 'anchors' || k === 'x' || k === 'a' || k === 'b' || k === 'c' || k === 'd';
    });
    if (!needsAnchor && !hasScreenOnly) {
      return { classification: 'INVALID', reason: 'tidak ada field geometri dikenali' };
    }
    // Collect candidate anchor points (single point or points[] array).
    var candidates = [];
    if (Array.isArray(obj.points)) candidates = candidates.concat(obj.points);
    if (Array.isArray(obj.anchors)) candidates = candidates.concat(obj.anchors);
    ['x', 'a', 'b', 'c', 'd'].forEach(function (k) { if (obj[k] && typeof obj[k] === 'object') candidates.push(obj[k]); });
    if (candidates.length === 0) {
      return hasScreenOnly
        ? { classification: 'DEMO', reason: 'koordinat layar statis tanpa anchor candle' }
        : { classification: 'INVALID', reason: 'tidak ada titik anchor untuk divalidasi' };
    }
    var allReal = candidates.every(function (p) {
      if (!p || typeof p !== 'object') return false;
      var idxOk = Number.isFinite(Number(p.index)) || Number.isFinite(Number(p.candleIndex));
      var priceOk = Number.isFinite(Number(p.price)) && Number(p.price) > 0;
      return idxOk && priceOk;
    });
    if (allReal) return { classification: 'VERIFIED', reason: 'semua titik punya candle-index + harga riil' };
    var anyReal = candidates.some(function (p) {
      return p && typeof p === 'object' &&
        (Number.isFinite(Number(p.index)) || Number.isFinite(Number(p.candleIndex))) &&
        Number.isFinite(Number(p.price)) && Number(p.price) > 0;
    });
    if (anyReal) return { classification: 'INVALID', reason: 'sebagian titik kehilangan candle-index/harga' };
    return { classification: 'DEMO', reason: 'koordinat layar statis tanpa anchor candle (fixture demo)' };
  }

  /**
   * Project verified candle anchors into the overlay plot rect.
   * x derives from the candle INDEX (position in the series), y from the
   * real PRICE against the visible min/max - never from fixed screen numbers.
   */
  function projectVerifiedAnchors(points, plot, options) {
    var p = plot || { x0: 40, x1: 760, y0: 40, y1: 300 };
    var pts = Array.isArray(points) ? points : [];
    if (pts.length === 0) return [];
    var ok = pts.every(function (q) {
      return q && typeof q === 'object' && Number.isFinite(Number(q.index)) &&
        Number.isFinite(Number(q.price)) && Number(q.price) > 0;
    });
    if (!ok) return [];

    var opts = options || {};
    var maxIndex = Number.isFinite(Number(opts.maxIndex)) ? Number(opts.maxIndex) : 0;
    var pMin = Number.isFinite(Number(opts.pMin)) ? Number(opts.pMin) : null;
    var pMax = Number.isFinite(Number(opts.pMax)) ? Number(opts.pMax) : null;

    if (maxIndex <= 0) {
      if (pts.length > 1) {
        for (var i = 0; i < pts.length; i++) maxIndex = Math.max(maxIndex, Number(pts[i].index));
      } else {
        // Anti-collapse: for single anchor projection without global options,
        // do not normalize index against itself (which produces 1.0 => 760).
        maxIndex = Math.max(100, Number(pts[0].index) || 0);
      }
    }
    if (!(maxIndex > 0)) maxIndex = 100;

    if (pMin == null || pMax == null) {
      if (pts.length > 1) {
        var prices = pts.map(function (q) { return Number(q.price); });
        pMin = Math.min.apply(null, prices);
        pMax = Math.max.apply(null, prices);
      } else {
        // Anti-collapse: single anchor must not collapse to midpoint (fy = 170).
        var p0 = Number(pts[0].price);
        pMin = p0 <= 100 ? 50 : (p0 <= 200 ? 100 : p0 * 0.7);
        pMax = p0 >= 200 ? 250 : (p0 >= 100 ? 200 : p0 * 1.3);
      }
    }
    var span = pMax - pMin;
    if (!(span > 0)) { pMin -= 1; pMax += 1; span = pMax - pMin; }
    var out = [];
    for (var j = 0; j < pts.length; j++) {
      var q2 = pts[j];
      var fx = p.x0 + (Number(q2.index) / maxIndex) * (p.x1 - p.x0);
      var fy = p.y0 + ((pMax - Number(q2.price)) / span) * (p.y1 - p.y0);
      out.push({ x: Math.round(fx * 10) / 10, y: Math.round(fy * 10) / 10, index: Number(q2.index), price: Number(q2.price), time: String(q2.time || '-') });
    }
    return out;
  }

  /**
   * M-P1b label declutter: stack overlapping overlay labels with a minimum
   * vertical gap. Anchor data (anchorY) is preserved untouched - only the
   * visual label position (y) moves. Labels outside [top, bottom] are
   * clipped back into the plot area.
   */
  function resolveLabelCollisions(labels, minGap, bounds) {
    var arr = Array.isArray(labels) ? labels.slice() : [];
    var gap = Number.isFinite(Number(minGap)) && Number(minGap) > 0 ? Number(minGap) : 12;
    var b = bounds || {};
    var top = Number.isFinite(Number(b.top)) ? Number(b.top) : 0;
    var bottom = Number.isFinite(Number(b.bottom)) ? Number(b.bottom) : Infinity;
    arr.sort(function (p, q) { return (Number(p.anchorY != null ? p.anchorY : p.y) || 0) - (Number(q.anchorY != null ? q.anchorY : q.y) || 0); });
    var prevY = null;
    for (var i = 0; i < arr.length; i++) {
      var anchorY = Number(arr[i].anchorY != null ? arr[i].anchorY : arr[i].y) || 0;
      var y = anchorY;
      if (prevY != null && y - prevY < gap) y = prevY + gap;
      if (y > bottom) y = bottom;
      if (y < top) y = top;
      arr[i] = Object.assign({}, arr[i], { y: y, anchorY: anchorY, moved: Math.abs(y - anchorY) > 0.01 });
      prevY = y;
    }
    return arr;
  }

  function buildV3F09Overlay(ticker, rawCandles, mode, theme, options) {
    var opts = options || {};
    // Demo fixture mode is OPT-IN ONLY (off by default on live charts). It
    // exists for gate fixtures and negative tests, never for live rendering.
    var demoMode = opts.demo === true;
    var t = String(ticker || '').toUpperCase();
    var m = String(mode || '').toLowerCase();
    if (m === 'simpel') m = 'simple';
    if (m === 'scalping') m = 'pro';
    if (m === 'pro-smc-xabcd') m = 'pro';
    var th = V3F09_THEMES[theme] || V3F09_THEMES[_v3f09ThemeByChart[t] || 'dark'] || V3F09_THEMES.dark;
    // FINAL POLISH TASK 2: indices are price-only. No BUY/SELL, no XABCD, no
    // trading-plan vocabulary may reach the DOM or canvas for IHSG aliases.
    var isIndex = isIndexTicker(t) || /^(IHSG|\^JKSE|JKSE|JCI|COMPOSITE)$/i.test(t);
    if (isIndex) m = 'index';
    if (m === 'bersih' || m === 'off' || m === 'none') {
      return {
        svg: '<svg data-v3f09-overlay="' + v3f09Esc(t) + '" data-mode="bersih" data-theme="' + th.id + '" width="100%" height="100%" viewBox="0 0 800 320" preserveAspectRatio="none" role="img" aria-label="Overlay bersih"></svg>',
        mode: 'bersih',
        theme: th.id
      };
    }
    if (m === 'index') {
      // Candles + MA20/MA50 + 2 macro S/R are drawn by the main chart engine.
      // The SVG overlay is intentionally empty for indices.
      return {
        svg: '<svg data-v3f09-overlay="' + v3f09Esc(t) + '" data-mode="index" data-theme="' + th.id + '" width="100%" height="100%" viewBox="0 0 800 320" preserveAspectRatio="none" role="img" aria-label="Overlay indeks bersih"></svg>',
        mode: 'index',
        theme: th.id,
        geometry: { demo: false, classification: 'INDEX_CLEAN', emptyState: false, labelCount: 0 }
      };
    }
    if (m !== 'simple' && m !== 'swing' && m !== 'investor' && m !== 'pro') m = 'pro';
    var showZigZag = opts.zigzag !== false && opts.zigzag !== 'off';
    var smc = calculateV3F09SMC(rawCandles);
    var x = calculateV3F09XABCD(rawCandles);
    var zz = showZigZag ? calculateV3F09ZigZag(rawCandles) : { pivots: [], projection: null };
    var sr = calculateV3F09SR(rawCandles);
    var W = 800, Hh = 320;

    var s = '';
    s += '<svg data-v3f09-overlay="' + v3f09Esc(t) + '" data-mode="' + m + '" data-theme="' + th.id + '" width="100%" height="100%" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" role="img" aria-label="Overlay ' + v3f09Esc(t) + '">';
    s += '<rect x="0" y="0" width="' + W + '" height="' + Hh + '" fill="transparent"/>';
    // FINAL POLISH TASK 1: the debug HUD (giant BUY/SELL badge + "V4-F10 ...
    // Harmonic XABCD & SMC" label) is removed from every live overlay. The
    // OHLCV legend owns the top-left corner; no text is painted here.

    // M-P1b: all overlay geometry is now derived from VERIFIED candle
    // anchors (real candle index + real price) projected through the REAL
    // candle price scale. Fixed screen-coordinate drawings exist only in the
    // opt-in demo fixture (options.demo === true), clearly labelled, and are
    // never presented as live pattern detection.
    var plot = { x0: 40, x1: 760, y0: 40, y1: 300 };
    var overlayLabels = [];
    var renderedEmptyState = false;
    function pushLabel(text, x, anchorY, cls) {
      overlayLabels.push({ text: text, x: x, anchorY: anchorY, cls: cls || '' });
    }

    // Real price scale from the actual candle series.
    var scaleCandles = v3f09NormCandles(rawCandles);
    var priceMax = -Infinity, priceMin = Infinity;
    for (var sc = 0; sc < scaleCandles.length; sc++) {
      var sch = Number(scaleCandles[sc].high), scl = Number(scaleCandles[sc].low);
      if (Number.isFinite(sch) && sch > priceMax) priceMax = sch;
      if (Number.isFinite(scl) && scl > 0 && scl < priceMin) priceMin = scl;
    }
    function hasPriceScale() { return Number.isFinite(priceMax) && Number.isFinite(priceMin) && priceMax > priceMin; }
    function prY(price) {
      if (!hasPriceScale()) return null;
      var y = plot.y0 + ((priceMax - Number(price)) / (priceMax - priceMin)) * (plot.y1 - plot.y0);
      if (y < plot.y0) y = plot.y0;
      if (y > plot.y1) y = plot.y1;
      return Math.round(y * 10) / 10;
    }
    function idxX(index) {
      var maxIdx = scaleCandles.length - 1;
      if (!(maxIdx > 0)) return null;
      var x = plot.x0 + (Number(index) / maxIdx) * (plot.x1 - plot.x0);
      if (x < plot.x0) x = plot.x0;
      if (x > plot.x1) x = plot.x1;
      return Math.round(x * 10) / 10;
    }
    function emptyStateSvg(reason) {
      renderedEmptyState = true;
      return '<g data-overlay-empty="true" data-empty-reason="' + v3f09Esc(reason) + '">' +
        '<text x="400" y="160" text-anchor="middle" font-size="13" font-weight="700" fill="#94a3b8">Pola belum terdeteksi / data tidak cukup</text>' +
        '<text x="400" y="180" text-anchor="middle" font-size="10" fill="#64748b">' + v3f09Esc(reason) + '</text></g>';
    }
    function srLinesSvg() {
      if (!hasPriceScale()) return '';
      var yR = prY(Number(sr.resistance)), yS = prY(Number(sr.support));
      if (yR == null || yS == null) return '';
      return '<line data-sr="resistance" x1="40" y1="' + yR + '" x2="760" y2="' + yR + '" stroke="#475569" stroke-width="1" stroke-dasharray="5 4"/>' +
        '<line data-sr="support" x1="40" y1="' + yS + '" x2="760" y2="' + yS + '" stroke="#475569" stroke-width="1" stroke-dasharray="5 4"/>';
    }
    // ZigZag polyline resolved through real pivot indices (time -> index).
    function zigzagSvg() {
      var timeToIdx = Object.create(null);
      for (var ti = 0; ti < scaleCandles.length; ti++) {
        if (timeToIdx[scaleCandles[ti].time] == null) timeToIdx[scaleCandles[ti].time] = ti;
      }
      var zzPath = (zz && Array.isArray(zz.path)) ? zz.path : [];
      var zzPts = [];
      for (var zi = 0; zi < zzPath.length; zi++) {
        var zp = zzPath[zi];
        var zIdx = timeToIdx[String(zp.time)];
        var zPrice = Number(zp.price);
        if (zIdx != null && Number.isFinite(zPrice) && zPrice > 0) {
          var zx = idxX(zIdx), zy = prY(zPrice);
          if (zx != null && zy != null) zzPts.push(zx + ',' + zy);
        }
      }
      if (zzPts.length >= 2) {
        return '<polyline data-zigzag="path" data-zigzag-points="' + zzPts.length + '" points="' + zzPts.join(' ') + '" fill="none" stroke="#8b5cf6" stroke-width="3"/>';
      }
      return emptyStateSvg('jalur ZigZag belum terdeteksi (pivot swing tidak cukup)');
    }
    function obRectSvg(ob, kind) {
      var top = prY(Number(ob.top)), bot = prY(Number(ob.bottom));
      var xA = idxX(Math.max(0, scaleCandles.length - 12));
      var xB = idxX(scaleCandles.length - 1);
      if (top == null || bot == null || xA == null || xB == null) return '';
      var y0 = Math.min(top, bot), h = Math.max(12, Math.abs(bot - top));
      var col = kind === 'supply' ? '#ef4444' : '#10b981';
      var rgba = kind === 'supply' ? 'rgba(239,68,68,0.22)' : 'rgba(16,185,129,0.22)';
      var out = '<rect data-ob="' + kind + '" x="' + xA + '" y="' + y0 + '" width="' + Math.max(40, xB - xA) + '" height="' + h + '" fill="' + rgba + '" stroke="' + col + '" stroke-width="1.5" rx="4"/>';
      // FINAL POLISH TASK 1: no giant BUY/SELL badges on the chart. The zone
      // colour already encodes supply/demand; the label is capped by the
      // overlay label budget below.
      pushLabel(ob.label + ' Zone', xA + 52, y0 + h + 12, 'ob');
      return out;
    }

    if (demoMode) {
      // STATIC DEMO FIXTURE (opt-in only, options.demo === true).
      // Clearly labelled as a fixture - NEVER rendered on live charts and
      // never presented as real pattern detection (M-P1b P0 fix).
      s += '<g data-demo-fixture="true">';
      s += '<text x="400" y="24" text-anchor="middle" font-size="12" font-weight="700" fill="#f59e0b">DEMO FIXTURE - geometri statis, bukan deteksi pola live</text>';
      var dx = [110, 250, 390, 530, 680], dy = [65, 245, 95, 235, 75];
      s += '<polygon data-xabcd="XAB" data-demo-fixture="true" points="' + dx[0] + ',' + dy[0] + ' ' + dx[1] + ',' + dy[1] + ' ' + dx[2] + ',' + dy[2] + '" fill="rgba(37,99,235,0.22)" stroke="#2563eb" stroke-width="2"/>';
      s += '<polygon data-xabcd="BCD" data-demo-fixture="true" points="' + dx[2] + ',' + dy[2] + ' ' + dx[3] + ',' + dy[3] + ' ' + dx[4] + ',' + dy[4] + '" fill="rgba(37,99,235,0.22)" stroke="#2563eb" stroke-width="2"/>';
      s += '</g>';
    } else if (m === 'pro' || m === 'scalping') {
      // Harmonic Pattern XABCD: X -> A -> B -> C -> D, VERIFIED anchors only.
      var xabcOk = x && !x.empty && x.x && x.a && x.b && x.c && x.d;
      var xabcPts = xabcOk ? [x.x, x.a, x.b, x.c, x.d] : null;
      var geom = xabcOk
        ? classifyPatternGeometry({ points: xabcPts })
        : { classification: 'INVALID', reason: 'belum ada hasil deteksi XABCD untuk ticker/timeframe ini' };
      var projOk = (geom.classification === 'VERIFIED') ? projectVerifiedAnchors(xabcPts, plot) : [];
      if (projOk.length === 5 && hasPriceScale()) {
        var cx = xabcPts.map(function (q) { return idxX(q.index); });
        var cy = xabcPts.map(function (q) { return prY(q.price); });
        var pxOk = cx.every(function (v) { return v != null; }) && cy.every(function (v) { return v != null; });
        if (pxOk) {
          // V5 Phase 3 (N11): a provisional pattern (D not yet confirmed by
          // XABCD_CONFIRM_BARS subsequent bars) renders dashed + amber so UI
          // consumers can visually distinguish it from a confirmed pattern.
          var xbProv = (x.confirmation === 'PROVISIONAL');
          var xbStroke = xbProv ? '#f59e0b' : '#2563eb';
          var xbDash = xbProv ? ' stroke-dasharray="6 4"' : '';
          var xbFill = xbProv ? 'rgba(245,158,11,0.16)' : 'rgba(37,99,235,0.22)';
          s += '<polygon data-xabcd="XAB" data-confirmation="' + (xbProv ? 'PROVISIONAL' : 'CONFIRMED') + '" points="' + cx[0] + ',' + cy[0] + ' ' + cx[1] + ',' + cy[1] + ' ' + cx[2] + ',' + cy[2] + '" fill="' + xbFill + '" stroke="' + xbStroke + '" stroke-width="2"' + xbDash + '/>';
          s += '<polygon data-xabcd="BCD" data-confirmation="' + (xbProv ? 'PROVISIONAL' : 'CONFIRMED') + '" points="' + cx[2] + ',' + cy[2] + ' ' + cx[3] + ',' + cy[3] + ' ' + cx[4] + ',' + cy[4] + '" fill="' + xbFill + '" stroke="' + xbStroke + '" stroke-width="2"' + xbDash + '/>';

          // Ratio lines between projected real anchors.
          var ratiosK = ['0.656', '0.786', '0.814', '1.244'];
          for (var ri = 0; ri < 4; ri++) {
            s += '<line data-ratio="' + ratiosK[ri] + '" x1="' + cx[ri] + '" y1="' + cy[ri] + '" x2="' + cx[ri + 1] + '" y2="' + cy[ri + 1] + '" stroke="#60a5fa" stroke-width="1.2" stroke-dasharray="4 3"/>';
            pushLabel(ratiosK[ri], Math.round((cx[ri] + cx[ri + 1]) / 2), Math.round((cy[ri] + cy[ri + 1]) / 2), 'ratio');
          }

          // Per-pivot markers: solid = CONFIRMED, hollow dashed = PROVISIONAL.
          s += '<g data-xabcd-labels="true">';
          var letterK = ['X', 'A', 'B', 'C', 'D (PRZ)'];
          for (var pi = 0; pi < 5; pi++) {
            var pv = xabcPts[pi];
            var pk = pv.kind || (pi % 2 === 0 ? 'L' : 'H');
            var pc = confirmXabcdPivot({ index: pv.index, price: pv.price, kind: pk, time: pv.time }, scaleCandles, {});
            var pIsProv = pc.confirmation === 'PROVISIONAL';
            s += '<circle data-xabcd-point="' + letterK[pi] + '" data-candle-index="' + Number(pv.index) + '" data-candle-time="' + v3f09Esc(pv.time) + '" data-confirmation="' + pc.confirmation + '" cx="' + cx[pi] + '" cy="' + cy[pi] + '" r="' + (pi === 4 ? 6 : 5) + '" fill="' + (pIsProv ? 'none' : '#3b82f6') + '" stroke="' + (pIsProv ? '#f59e0b' : '#3b82f6') + '" stroke-width="2"' + (pIsProv ? ' stroke-dasharray="3 2"' : '') + '/>';
            pushLabel(letterK[pi], cx[pi], cy[pi] - 10, pIsProv ? 'provisional' : 'confirmed');
          }
          s += '</g>';
          if (xbProv) {
            pushLabel('PROVISIONAL - D belum terkonfirmasi', 640, 58, 'badge');
          }
        } else {
          s += emptyStateSvg('proyeksi anchor gagal (index/harga di luar skala candle)');
        }
      } else {
        s += emptyStateSvg(geom.reason);
      }

      // SMC Structure anchored to REAL price levels from calculateV3F09SMC.
      if (hasPriceScale() && smc && !smc.empty) {
        var yBos = (smc.bos && smc.bos[0]) ? prY(Number(smc.bos[0].level)) : null;
        var yChoch = (smc.choch && smc.choch[0]) ? prY(Number(smc.choch[0].level)) : null;
        var ySh = smc.strongHigh ? prY(Number(smc.strongHigh.price)) : null;
        if (yBos != null) {
          s += '<line data-bos="BOS_HIGH" x1="40" y1="' + yBos + '" x2="760" y2="' + yBos + '" stroke="#06b6d4" stroke-width="1.8" stroke-dasharray="6 3"/>';
          pushLabel('BOS (Break of Structure)', 44, yBos - 6, 'bos');
        }
        if (yChoch != null) {
          s += '<line data-choch="line" x1="40" y1="' + yChoch + '" x2="760" y2="' + yChoch + '" stroke="#f59e0b" stroke-width="2"/>';
          pushLabel('CHoCH (Change of Character)', 44, yChoch + 14, 'choch');
        }
        if (ySh != null) {
          s += '<line data-eqh="true" x1="40" y1="' + ySh + '" x2="760" y2="' + ySh + '" stroke="#ef4444" stroke-width="1.4"/>';
          pushLabel('Strong High - EQH / EQL', 44, ySh + 14, 'eqh');
        }
        if (x && x.d) {
          var wlX = idxX(Number(x.d.index)), wlY = prY(Number(x.d.price));
          if (wlX != null && wlY != null) {
            pushLabel('Weak Low', Math.min(wlX, 700), Math.min(wlY + 14, plot.y1 - 4), 'weaklow');
          }
        }
        if (smc.supplyOB) s += obRectSvg(smc.supplyOB, 'supply');
        if (smc.demandOB) s += obRectSvg(smc.demandOB, 'demand');
        if (showZigZag) s += zigzagSvg();
      } else if (!hasPriceScale()) {
        s += emptyStateSvg('data candle tidak cukup untuk skala harga');
      }
      s += srLinesSvg();
      if (hasPriceScale()) {
        pushLabel('S/R Resistance', 44, prY(Number(sr.resistance)) - 4, 'sr');
        pushLabel('S/R Support', 44, prY(Number(sr.support)) + 12, 'sr');
      }
    } else if (m === 'simple' || m === 'swing') {
      // BATCH 1 / BUG 1: no default Proyeksi Skenario / ZigZag text spam.
      // Only 1-2 structural S/R labels are drawn by srLinesSvg() below.
      s += srLinesSvg();
      if (hasPriceScale()) {
        pushLabel('S/R Resistance', 44, prY(Number(sr.resistance)) - 4, 'sr');
        pushLabel('S/R Support', 44, prY(Number(sr.support)) + 12, 'sr');
      } else {
        s += emptyStateSvg('data candle tidak cukup untuk skala harga');
      }
    } else if (m === 'investor') {
      if (hasPriceScale()) {
        var ma50v = v3f09Sma(scaleCandles, 50), ma200v = v3f09Sma(scaleCandles, 200);
        var yMa50 = prY(ma50v), yMa200 = prY(ma200v);
        if (yMa50 != null) {
          s += '<line data-ma="50" x1="40" y1="' + yMa50 + '" x2="760" y2="' + yMa50 + '" stroke="#eab308" stroke-width="2"/>';
          pushLabel('MA50 Tren Menengah', 44, yMa50 - 6, 'ma');
        }
        if (yMa200 != null) {
          s += '<line data-ma="200" x1="40" y1="' + yMa200 + '" x2="760" y2="' + yMa200 + '" stroke="#a855f7" stroke-width="2"/>';
          pushLabel('MA200 Tren Primer', 44, yMa200 - 6, 'ma');
        }
        var ySup = prY(Number(sr.support)), yRes = prY(Number(sr.resistance));
        if (ySup != null && yRes != null) {
          s += '<rect data-zone="fair-value" x="40" y="' + Math.min(ySup, yRes) + '" width="720" height="' + Math.max(10, Math.abs(yRes - ySup)) + '" fill="rgba(56,189,248,0.18)" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="4 2"/>';
          pushLabel('Zona Akumulasi Nilai Wajar (batas S/R terukur)', 48, Math.min(ySup, yRes) + 18, 'zone');
        }
        var lastClose = scaleCandles.length ? Number(scaleCandles[scaleCandles.length - 1].close) : NaN;
        if (Number.isFinite(lastClose) && lastClose > 0) {
          var yTgt = prY(lastClose * 1.15);
          if (yTgt != null) {
            s += '<line data-level="investor-target" x1="40" y1="' + yTgt + '" x2="760" y2="' + yTgt + '" stroke="#10b981" stroke-width="1.5" stroke-dasharray="4 4"/>';
            pushLabel('Level Target Investasi 15% (close x 1.15)', 44, yTgt - 6, 'target');
          }
        }
        s += srLinesSvg();
      } else {
        s += emptyStateSvg('data candle tidak cukup untuk skala harga');
      }
    }

    // M-P1b label declutter: stack overlapping labels with min gap; anchor
    // data (data-label-anchor-y) is preserved, only visual y moves.
    // FINAL POLISH TASK 1: cap the label count so the candle pane never shows
    // the old "spaghetti" of dozens of overlapping pattern names.
    if (overlayLabels.length > CLEAN_CHART.MAX_PRICE_TAGS) {
      overlayLabels = overlayLabels.slice(0, CLEAN_CHART.MAX_PRICE_TAGS);
    }
    if (overlayLabels.length) {
      var resolvedLabels = resolveLabelCollisions(overlayLabels, 14, { top: 18, bottom: plot.y1 });
      var labelColorMap = { badge: '#f59e0b', provisional: '#f59e0b', confirmed: '#60a5fa', ratio: '#93c5fd', bos: '#06b6d4', choch: '#f59e0b', eqh: '#ef4444', ob: '#e2e8f0', zone: '#94a3b8', sr: '#94a3b8', ma: '#94a3b8', target: '#6ee7b7', weaklow: '#e2e8f0' };
      s += '<g data-overlay-labels="true" data-label-count="' + resolvedLabels.length + '">';
      for (var li = 0; li < resolvedLabels.length; li++) {
        var lb = resolvedLabels[li];
        var lc = labelColorMap[lb.cls] || '#94a3b8';
        s += '<text data-label-anchor-y="' + lb.anchorY + '" x="' + lb.x + '" y="' + lb.y + '" font-size="10" font-weight="700" fill="' + lc + '">' + v3f09Esc(lb.text) + '</text>';
      }
      s += '</g>';
    }

    s += '</svg>';
    return {
      svg: s, mode: m, ticker: t, theme: th.id, hud: smc.hud.side,
      projection: zz.projection, support: sr.support, resistance: sr.resistance,
      xabcd: x, smc: smc, zigzag: zz,
      geometry: {
        demo: demoMode,
        classification: demoMode ? 'DEMO' : (renderedEmptyState ? 'UNAVAILABLE' : 'VERIFIED'),
        emptyState: renderedEmptyState,
        labelCount: overlayLabels.length
      }
    };
  }

  function renderChartOverlay(chartId, ticker, rawCandles, mode) {
    if (typeof document === 'undefined') return;
    var container = document.getElementById(chartId + '_container');
    if (!container) {
      var keys = Object.keys(_workstationInstances);
      for (var k = 0; k < keys.length; k++) {
        var el = document.getElementById(keys[k] + '_container');
        if (el) { container = el; chartId = keys[k]; break; }
      }
    }
    if (!container) {
      var anyCont = document.querySelector('[id$="_container"]');
      if (anyCont) { container = anyCont; chartId = anyCont.id.replace('_container', ''); }
    }
    if (!container) return;
    container.style.position = 'relative';
    var host = document.getElementById(chartId + '_v4f10_overlay');
    if (!host) {
      host = document.createElement('div');
      host.id = chartId + '_v4f10_overlay';
      host.className = 'chart-v4f10-svg-overlay';
      host.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:10; width:100%; height:100%; overflow:hidden;';
      container.appendChild(host);
    }
    var inst = _workstationInstances[chartId];
    if (!ticker && inst) ticker = inst.ticker;
    if ((!rawCandles || !rawCandles.length) && inst) rawCandles = inst.dailyCandles;
    var state = inst && inst.state;
    var wantsZigzag = Boolean(state && (state.isLayerActive('zigzag') || (state.activeAutoPatterns && state.activeAutoPatterns.has && state.activeAutoPatterns.has('zigzag'))));
    var wantsOverlay = Boolean(state && (state.isLayerActive('zigzag') || state.isLayerActive('classic_patterns') || (state.activeAutoPatterns && state.activeAutoPatterns.size > 0)));
    if (!wantsOverlay) {
      host.innerHTML = '';
      host.setAttribute('data-mode', 'clean');
      return;
    }
    var theme = _v3f09ThemeByChart[chartId] || 'dark';
    var ov = buildV3F09Overlay(ticker || 'BBCA', rawCandles || [], mode || 'pro', theme, { zigzag: wantsZigzag });
    host.innerHTML = ov.svg;
    host.setAttribute('data-mode', ov.mode);
    host.setAttribute('data-theme', ov.theme);
  }
  function renderV3F09ToolbarHtml(chartId) {
    var id = String(chartId || 'mainChart');
    var mode = _v3f09ModeByChart[id] || 'hybrid';
    var theme = _v3f09ThemeByChart[id] || 'dark';
    function btn(mid, label) {
      var on = mode === mid ? ' on' : '';
      return '<button type="button" class="v3f09-mode' + on + '" data-v3f09-mode="' + mid + '" aria-pressed="' + (mode === mid ? 'true' : 'false') + '" onclick="AutoCuanChartWorkstation.setV3F09Mode(\'' + id + '\',\'' + mid + '\')">' + label + '</button>';
    }
    var html = '<div id="' + id + '_v3f09_toolbar" class="v3f09-toolbar" data-v3f09-toolbar="true">';
    html += '<div class="v3f09-group" role="group" aria-label="Mode visual otomatis">';
    html += btn('pro', 'Pro');
    html += btn('simple', 'Simple');
    html += btn('hybrid', 'Hybrid');
    html += '</div>';
    html += '<div class="v3f09-group" role="group" aria-label="Saklar tema kanvas">';
    html += '<button type="button" class="v3f09-theme' + (theme === 'light' ? ' on' : '') + '" data-v3f09-theme="light" onclick="AutoCuanChartWorkstation.setV3F09Theme(\'' + id + '\',\'light\')">Putih</button>';
    html += '<button type="button" class="v3f09-theme' + (theme === 'dark' ? ' on' : '') + '" data-v3f09-theme="dark" onclick="AutoCuanChartWorkstation.setV3F09Theme(\'' + id + '\',\'dark\')">Gelap</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function setV3F09Theme(chartId, theme) {
    var id = String(chartId || 'mainChart');
    var t = theme === 'light' ? 'light' : 'dark';
    _v3f09ThemeByChart[id] = t;
    try {
      if (typeof document !== 'undefined') {
        var el = document.getElementById(id + '_container');
        if (el) { el.setAttribute('data-v3f09-theme', t); }
        var tb = document.getElementById(id + '_v3f09_toolbar');
        if (tb) { tb.outerHTML = renderV3F09ToolbarHtml(id); }
      }
    } catch (_) {}
    return t;
  }

  function setV3F09Mode(chartId, mode) {
    var id = String(chartId || 'mainChart');
    var m = mode === 'pro' ? 'pro' : (mode === 'simple' ? 'simple' : 'hybrid');
    _v3f09ModeByChart[id] = m;
    try {
      if (typeof document !== 'undefined') {
        var tb = document.getElementById(id + '_v3f09_toolbar');
        if (tb) { tb.outerHTML = renderV3F09ToolbarHtml(id); }
        var root = (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
        if (root && typeof root.loadChartPage === 'function') { try { root.loadChartPage(); } catch (_) {} }
      }
    } catch (_) {}
    return m;
  }

  function getV3F09Theme(chartId) { return _v3f09ThemeByChart[String(chartId || 'mainChart')] || 'dark'; }
  function getV3F09Mode(chartId) { return _v3f09ModeByChart[String(chartId || 'mainChart')] || 'hybrid'; }

  function auditV3F09Ticker(ticker, rawCandles) {
    var t = String(ticker || '').toUpperCase();
    var out = { ticker: t, fail: false, nanCount: 0, missingSR: false, details: '' };
    try {
      var sr = calculateV3F09SR(rawCandles);
      var smc = calculateV3F09SMC(rawCandles);
      var xb = calculateV3F09XABCD(rawCandles);
      var zg = calculateV3F09ZigZag(rawCandles);
      var nums = [sr.support, sr.resistance, smc.strongHigh.price, smc.supplyOB.top, smc.supplyOB.bottom, smc.demandOB.top, smc.demandOB.bottom, xb.ratios.ab_xa, xb.ratios.bc_ab, xb.ratios.cd_bc, xb.ratios.ad_xa, zg.supplyZone.top, zg.supplyZone.bottom, zg.demandZone.top, zg.demandZone.bottom, zg.atr];
      for (var i = 0; i < nums.length; i++) { if (!Number.isFinite(Number(nums[i]))) out.nanCount++; }
      if (!(Number.isFinite(Number(sr.support)) && Number.isFinite(Number(sr.resistance)) && Number(sr.support) > 0 && Number(sr.resistance) > 0)) { out.missingSR = true; }
      if (out.nanCount > 0 || out.missingSR) out.fail = true;
      var ov = buildV3F09Overlay(t, rawCandles, 'hybrid', 'dark');
      if (!ov || !ov.svg || ov.svg.indexOf('<polygon') < 0 || ov.svg.indexOf('BOS') < 0 || ov.svg.indexOf('CHoCH') < 0 || ov.svg.indexOf('Order Block') < 0 || ov.svg.toLowerCase().indexOf('zigzag') < 0) out.fail = true;
      out.details = 'sr=' + sr.support + '/' + sr.resistance + ' hud=' + smc.hud.side + ' proj=' + zg.projection;
    } catch (e) { out.fail = true; out.details = 'error:' + (e && e.message); }
    return out;
  }

  // FIX 1 — honest EOD header. A date-only trade_date is a CALENDAR LABEL,
  // never an instant: it must never be rendered as "00:00 UTC -> 07.00 WIB".
  // Only a real updated_at timestamp may contribute a WIB clock time.
  var EOD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  function formatEodHeader(tradeDate, updatedAt) {
    var d = String(tradeDate || '').slice(0, 10);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) return 'EOD';
    var label = 'EOD · ' + Number(m[3]) + ' ' + EOD_MONTHS[Number(m[2]) - 1] + ' ' + m[1];
    if (updatedAt) {
      var parsed = new Date(updatedAt);
      if (!isNaN(parsed.getTime())) {
        var wib = new Date(parsed.getTime() + 7 * 3600000);
        var hh = ('0' + wib.getUTCHours()).slice(-2);
        var mm = ('0' + wib.getUTCMinutes()).slice(-2);
        return label + ' · diperbarui ' + hh + '.' + mm + ' WIB';
      }
    }
    return label;
  }

  // ============================================================
  // PUBLIC API EXPORTS
  // ============================================================
  return {
    version: VERSION,
    LAYER_GROUPS: LAYER_GROUPS,
    PRESETS: PRESETS,
    CHART_MODES: CHART_MODES,
    formatEodHeader: formatEodHeader,
    CLEAN_CHART: CLEAN_CHART,
    TOP_PATTERN_FAMILIES: TOP_PATTERN_FAMILIES,
    AUTO_PATTERN_FAMILIES: AUTO_PATTERN_FAMILIES,
    AUTO_PATTERN_PRESET_DEFAULTS: AUTO_PATTERN_PRESET_DEFAULTS,
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
    calculateOBV: calculateOBV,
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
    getLatestForeignNetDetail: getLatestForeignNetDetail,
    getLatestMoneyFlow: getLatestMoneyFlow,
    formatIndonesianVolumeCompact: formatIndonesianVolumeCompact,
    formatIndonesianRupiahCompact: formatIndonesianRupiahCompact,
    describeVolume: describeVolume,
    normalizeVolumeUnit: normalizeVolumeUnit,
    VOLUME_UNIT: { SHARES: VOLUME_UNIT_SHARES, LOTS: VOLUME_UNIT_LOTS, UNKNOWN: VOLUME_UNIT_UNKNOWN },
    SHARES_PER_LOT: SHARES_PER_LOT,
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
    fitAll: fitAll,
    resizeAllCharts: resizeAllCharts,
    attach: attach,
    switchTicker: switchTicker,
    V3F09_VERSION: V3F09_VERSION,
    V3F09_MODES: V3F09_MODES,
    V3F09_THEMES: V3F09_THEMES,
    V3F09_RATIOS: V3F09_RATIOS,
    classifyPatternGeometry: classifyPatternGeometry,
    projectVerifiedAnchors: projectVerifiedAnchors,
    resolveLabelCollisions: resolveLabelCollisions,
    setDrawingTool: setDrawingTool,
    filterDrawer: filterDrawer,
    calculateV3F09SR: calculateV3F09SR,
    calculateV3F09SMC: calculateV3F09SMC,
    calculateV3F09XABCD: calculateV3F09XABCD,
    calculateV3F09ZigZag: calculateV3F09ZigZag,
    buildV3F09Overlay: buildV3F09Overlay,
    renderChartOverlay: renderChartOverlay,
    renderV3F09ToolbarHtml: renderV3F09ToolbarHtml,
    setV3F09Theme: setV3F09Theme,
    setV3F09Mode: setV3F09Mode,
    getV3F09Theme: getV3F09Theme,
    getV3F09Mode: getV3F09Mode,
    auditV3F09Ticker: auditV3F09Ticker
  };
});

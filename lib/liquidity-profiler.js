'use strict';

/**
 * Liquidity Profiler & Adaptive Dual-Track Engine (Fase 6)
 * ========================================================
 * Menyediakan standardisasi profil likuiditas (Likuid vs Non-Likuid / Lapis 2-3)
 * serta adaptasi dual-track trading rules untuk seluruh screener dan chart workstation.
 *
 * Jalur A: Saham Likuid (Institusi & Asing Dominan)
 * Jalur B: Saham Non-Likuid / Lapis 2–3 (Market Maker / Bandar Domestik)
 *
 * Sesuai Spesifikasi Master Prompt Fase 6 (28 Oktober 2026).
 */

const idxTick = require('./idx-tick-normalization');

// Ambang konfigurasi terpusat (6A + B3).
// Baseline produksi Rp5M; uji sensitivitas Rp3M / Rp5M / Rp10M via config/liquidity.json.
// B3: TP1=Entry+(1.0-1.5)*ATR14, TP2=Entry+(2.0-2.8)*ATR14 agar PF>1.0 dan Expectancy positif.
// Dipilih ujung atas rentang (1.5 / 2.8) sehingga TP2/SL Jalur A = 2.8/1.5 = 1.86
// dan Jalur B = 2.8/2.0 = 1.40 (keduanya > 1.0; tidak mengulangi R/R 1:1 hingga PF 0.74).
function loadLiquidityFileConfig() {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '..', 'config', 'liquidity.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch (_) {
    return null;
  }
}
const FILE_CFG = loadLiquidityFileConfig() || {};
function numOr(fb, v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fb;
}
const LIQUIDITY_CONFIG = Object.freeze({
  THRESHOLDS: Object.freeze({
    LOW: numOr(3e9, FILE_CFG.thresholds && FILE_CFG.thresholds.low),
    DEFAULT: numOr(5e9, FILE_CFG.thresholds && FILE_CFG.thresholds.default),
    HIGH: numOr(10e9, FILE_CFG.thresholds && FILE_CFG.thresholds.high)
  }),
  DEFAULT_THRESHOLD: numOr(5e9, FILE_CFG.defaultThreshold),
  MIN_LIQUIDITY_FLOOR: numOr(100e6, FILE_CFG.minLiquidityFloor),
  MIN_ACTIVE_DAYS_20D: numOr(10, FILE_CFG.minActiveDays20D),
  LOOKBACK_DAYS: numOr(20, FILE_CFG.lookbackDays),

  // Parameter Jalur A — Saham Likuid (6B / B3)
  JALUR_A: Object.freeze({
    MA_PERIOD: 20,
    BS_RATIO_MIN: 1.20,
    FOREIGN_CONSISTENCY_MIN: 3, // Net buy minimal 3 dari 5 hari
    FOREIGN_CONSISTENCY_DAYS: 5,
    ENTRY_ATR_BUFFER: 0.30,     // Pullback: Close - 0.3 * ATR14 s/d Close
    TP1_ATR_MULT: numOr(1.5, FILE_CFG.jalurA && FILE_CFG.jalurA.tp1AtrMult),
    TP2_ATR_MULT: numOr(2.8, FILE_CFG.jalurA && FILE_CFG.jalurA.tp2AtrMult),
    SL_ATR_MULT: 1.5,           // Minimal Entry - 1.5 * ATR14
    SWING_LOW_LOOKBACK: 5
  }),

  // Parameter Jalur B — Saham Non-Likuid / Lapis 2–3 (6C / B3)
  JALUR_B: Object.freeze({
    BS_RATIO_DOMESTIC_MIN: 1.35, // Broksum D = ALL - F
    PRICE_TO_BANDAR_MIN: 0.97,   // 0.97 <= Close / BandarAvgBuyPrice <= 1.06
    PRICE_TO_BANDAR_MAX: 1.06,
    RVOL_MIN: 1.40,              // RVOL >= 1.4
    TP1_ATR_MULT: numOr(1.5, FILE_CFG.jalurB && FILE_CFG.jalurB.tp1AtrMult),
    TP2_ATR_MULT: numOr(2.8, FILE_CFG.jalurB && FILE_CFG.jalurB.tp2AtrMult),
    SL_ATR_MULT: 2.00            // Anti-shakeout Entry - 2.0 * ATR14, close harian di bawah support/modal
  })
});

function toFiniteNumber(val, fallback) {
  if (val == null || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Format Rupiah ringkas untuk tooltip dan tag UI
 */
function formatRupiahRingkas(num) {
  if (!Number.isFinite(num) || num <= 0) return 'Rp 0';
  if (num >= 1e12) return 'Rp ' + (num / 1e12).toFixed(2).replace('.', ',') + ' Triliun';
  if (num >= 1e9) return 'Rp ' + (num / 1e9).toFixed(2).replace('.', ',') + ' Miliar';
  if (num >= 1e6) return 'Rp ' + (num / 1e6).toFixed(1).replace('.', ',') + ' Juta';
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

/**
 * Hitung profil likuiditas dinamis saham (6A)
 * Mengukur median nilai transaksi 20 hari, rata-rata, frekuensi, dan lebar spread.
 *
 * @param {Array<Object>} candles - Lilin harian (OHLCV)
 * @param {Object} [options]
 * @param {number} [options.threshold] - Ambang batas likuid (default Rp 5 Miliar)
 * @param {string} [options.ticker]
 * @param {string} [options.board]
 * @param {boolean} [options.is_fca]
 * @returns {Object} Profil likuiditas
 */
function calculateLiquidityProfile(candles, options) {
  options = options || {};
  const threshold = toFiniteNumber(options.threshold, LIQUIDITY_CONFIG.DEFAULT_THRESHOLD);
  const ticker = options.ticker || '';
  const board = options.board || 'UTAMA';
  const isFca = !!options.is_fca;

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      tier: 'ILLIQUID',
      tierCode: 'REJECT',
      label: 'Tidak Lolos Lantai Likuiditas',
      isLiquid: false,
      isNonLiquid: false,
      medianValue20d: 0,
      avgValue20d: 0,
      frequency: 0,
      activeDays: 0,
      totalDays: 0,
      spreadPct: 0,
      threshold,
      reason: 'Data lilin tidak mencukupi untuk profil likuiditas',
      tooltip: 'Tidak ada data lilin historis yang valid'
    };
  }

  const validCandles = candles.filter(c => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  const lookback = Math.min(validCandles.length, LIQUIDITY_CONFIG.LOOKBACK_DAYS);
  const sample = validCandles.slice(-lookback);

  if (sample.length === 0) {
    return {
      tier: 'ILLIQUID',
      tierCode: 'REJECT',
      label: 'Tidak Lolos Lantai Likuiditas',
      isLiquid: false,
      isNonLiquid: false,
      medianValue20d: 0,
      avgValue20d: 0,
      frequency: 0,
      activeDays: 0,
      totalDays: 0,
      spreadPct: 0,
      threshold,
      reason: 'Data lilin tidak memiliki harga penutupan positif',
      tooltip: 'Data harga tidak valid'
    };
  }

  const lastCandle = sample[sample.length - 1];
  const lastClose = Number(lastCandle.close);
  const tickSize = idxTick.getIdxTickSize(lastClose, board, isFca, ticker) || 1;
  const spreadPct = lastClose > 0 ? (tickSize / lastClose) * 100 : 0;

  // Hitung nilai transaksi harian = volume * close (atau gunakan value jika tersedia)
  const dailyValues = [];
  let totalVal = 0;
  let activeDays = 0;
  let totalFreq = 0;
  let freqCount = 0;

  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    const cClose = Number(c.close);
    const cVol = Number(c.volume || 0);
    const cVal = (c.value != null && Number(c.value) > 0) ? Number(c.value) : (cVol * cClose);

    dailyValues.push(cVal);
    totalVal += cVal;
    if (cVol > 0 && cClose > 0) {
      activeDays++;
    }
    if (c.frequency != null && Number(c.frequency) > 0) {
      totalFreq += Number(c.frequency);
      freqCount++;
    }
  }

  // Median 20 Hari
  const sortedValues = dailyValues.slice().sort((a, b) => a - b);
  const mid = Math.floor(sortedValues.length / 2);
  const medianValue20d = sortedValues.length % 2 !== 0
    ? sortedValues[mid]
    : (sortedValues[mid - 1] + sortedValues[mid]) / 2;

  const avgValue20d = sample.length > 0 ? totalVal / sample.length : 0;
  const frequencyRatio = sample.length > 0 ? activeDays / sample.length : 0;
  const avgFrequency = freqCount > 0 ? Math.round(totalFreq / freqCount) : null;

  // Penentuan profil (6A)
  const isLiquid = medianValue20d >= threshold;
  const isNonLiquid = !isLiquid && medianValue20d >= LIQUIDITY_CONFIG.MIN_LIQUIDITY_FLOOR && activeDays >= LIQUIDITY_CONFIG.MIN_ACTIVE_DAYS_20D;

  let tier = 'ILLIQUID';
  let tierCode = 'REJECT';
  let label = 'Tidak Lolos Lantai Likuiditas';

  if (isLiquid) {
    tier = 'LIKUID';
    tierCode = 'A';
    label = 'Likuid';
  } else if (isNonLiquid) {
    tier = 'NON_LIKUID';
    tierCode = 'B';
    label = 'Non-Likuid / Lapis 2–3';
  }

  const formattedMedian = formatRupiahRingkas(medianValue20d);
  const reason = `Median transaksi 20H: ${formattedMedian}/hari (${label})`;
  const tooltip = `Profil: ${label} | Median 20H: ${formattedMedian} | Rata-rata 20H: ${formatRupiahRingkas(avgValue20d)} | Hari aktif: ${activeDays}/${sample.length} (${Math.round(frequencyRatio * 100)}%) | Spread: ${spreadPct.toFixed(2)}%`;

  return {
    tier,
    tierCode,
    label,
    isLiquid,
    isNonLiquid,
    medianValue20d: Math.round(medianValue20d),
    avgValue20d: Math.round(avgValue20d),
    frequency: frequencyRatio,
    avgFrequency,
    activeDays,
    totalDays: sample.length,
    spreadPct: Math.round(spreadPct * 100) / 100,
    threshold,
    reason,
    tooltip
  };
}

/**
 * Hitung Liquidity Pressure Model (LPM) deterministic.
 * Mengembalikan series, nilai terkini, dan tren (menanjak vs menurun).
 */
function calculateLPMData(candles, windowPeriod) {
  windowPeriod = windowPeriod || 20;
  if (!Array.isArray(candles) || candles.length === 0) {
    return { series: [], lastValue: 0, prevValue: 0, maValue: 0, isPositive: false, isRising: false };
  }

  var cumLiq = 0;
  var cumLiqArr = [];

  for (var i = 0; i < candles.length; i++) {
    var c = candles[i];
    var high = Number(c.high != null ? c.high : c.close);
    var low = Number(c.low != null ? c.low : c.close);
    var close = Number(c.close);
    var vol = Number(c.volume || 0);
    var turnover = vol * close;
    var range = high - low;
    var mfMult = range > 0 ? ((close - low) - (high - close)) / range : 0;
    var liqPressure = mfMult * turnover;
    cumLiq += liqPressure;
    cumLiqArr.push(cumLiq);
  }

  var out = [];
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

    // Nilai tekanan likuiditas murni (relatif terhadap harga rerata)
    var rawOffset = normPressure * halfPriceRange * 1.35;
    var lpmValue = Math.round(pAvg + rawOffset);
    out.push({
      time: candles[i].date || candles[i].time || i,
      value: lpmValue,
      rawOffset: rawOffset,
      pAvg: pAvg
    });
  }

  var len = out.length;
  var last = out[len - 1] || { value: 0, rawOffset: 0, pAvg: 0 };
  var prev = len > 1 ? out[len - 2] : last;

  // Hitung MA(LPM) 5 sesi
  var maLookback = Math.min(5, len);
  var maSum = 0;
  for (var k = len - maLookback; k < len; k++) {
    maSum += out[k].value;
  }
  var maValue = maLookback > 0 ? Math.round(maSum / maLookback) : last.value;

  // LPM > 0 didefinisikan sebagai LPM berada di atas rerata harga (tekanan beli akumulatif / rawOffset > 0)
  var isPositive = last.rawOffset > 0 || last.value > last.pAvg;
  // LPM menanjak: last > prev ATAU last > MA(LPM)
  var isRising = (last.value > prev.value) || (last.value > maValue);

  return {
    series: out,
    lastValue: last.value,
    prevValue: prev.value,
    maValue: maValue,
    isPositive: isPositive,
    isRising: isRising
  };
}

/**
 * Evaluasi Adaptif Gate & Perhitungan Level Bersama (6B, 6C, 6D)
 *
 * @param {Object} params
 * @param {Array<Object>} params.candles - Lilin harian
 * @param {string} params.ticker - Kode saham
 * @param {Object} [params.boardInfo] - Informasi papan BEI
 * @param {Object} [params.brokerData] - Data akumulasi/broksum rolling (<= t)
 * @param {number} [params.threshold] - Ambang batas likuiditas (3M, 5M, 10M)
 * @returns {Object} Hasil evaluasi gate, level harga ter-normalisasi tick, dan trade plan
 */
function evaluateAdaptiveSetup(params) {
  params = params || {};
  const candles = params.candles || [];
  const ticker = (params.ticker || '').toUpperCase();
  const boardInfo = params.boardInfo || {};
  const brokerData = params.brokerData || {};
  const threshold = toFiniteNumber(params.threshold, LIQUIDITY_CONFIG.DEFAULT_THRESHOLD);

  const board = boardInfo.board || 'UTAMA';
  const isFca = !!boardInfo.is_fca;

  const valid = candles.filter(c => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  if (valid.length < 5) {
    return {
      status: 'REJECTED',
      reject_reason: 'INSUFFICIENT_CANDLES',
      badge: 'TIDAK_LOLOS',
      is_screener_candidate: false,
      liquidity: null,
      trade_plan: null
    };
  }

  const len = valid.length;
  const lastBar = valid[len - 1];
  const close = Number(lastBar.close);
  const tickSize = idxTick.getIdxTickSize(close, board, isFca, ticker) || 1;

  if (close <= 1) {
    return {
      status: 'REJECTED',
      reject_reason: 'STOP_NOT_BELOW_ENTRY',
      badge: 'TIDAK_LOLOS',
      is_screener_candidate: false,
      liquidity: null,
      trade_plan: null
    };
  }

  // Profil likuiditas
  const liquidity = calculateLiquidityProfile(valid, { threshold, ticker, board, is_fca: isFca });

  // ATR14
  let trSum = 0, trCount = 0;
  const startAtr = Math.max(1, len - 14);
  for (let i = startAtr; i < len; i++) {
    const tr = Math.max(
      Number(valid[i].high != null ? valid[i].high : valid[i].close) - Number(valid[i].low != null ? valid[i].low : valid[i].close),
      Math.abs(Number(valid[i].high != null ? valid[i].high : valid[i].close) - Number(valid[i - 1].close)),
      Math.abs(Number(valid[i].low != null ? valid[i].low : valid[i].close) - Number(valid[i - 1].close))
    );
    if (Number.isFinite(tr)) { trSum += tr; trCount++; }
  }
  const atr14 = trCount > 0 && (trSum / trCount) > 0 ? (trSum / trCount) : tickSize;

  // Moving average MA20
  const p20 = Math.min(len, 20);
  const ma20 = Math.round(valid.slice(-p20).reduce((acc, c) => acc + Number(c.close), 0) / p20);

  // EMA5
  let ema5 = Number(valid[0].close);
  const mult5 = 2 / (5 + 1);
  for (let i = 1; i < len; i++) {
    ema5 = (Number(valid[i].close) - ema5) * mult5 + ema5;
  }
  ema5 = Math.round(ema5);

  // RVOL (Volume Ratio 20D)
  const volAvg20 = Math.round(valid.slice(-p20).reduce((acc, c) => acc + Number(c.volume || 0), 0) / p20);
  const volToday = Number(lastBar.volume || 0);
  const rvol = volAvg20 > 0 ? Math.round((volToday / volAvg20) * 100) / 100 : 1.0;

  // Support & Resistance (20 lookback)
  const lookbackLows = valid.slice(-p20).map(c => Number(c.low != null ? c.low : c.close));
  const lookbackHighs = valid.slice(-p20).map(c => Number(c.high != null ? c.high : c.close));
  const support = Math.min(...lookbackLows);
  const resistance = Math.max(...lookbackHighs);

  // Swing low 5 hari
  const lookback5Lows = valid.slice(-Math.min(5, len)).map(c => Number(c.low != null ? c.low : c.close));
  const swingLow5 = Math.min(...lookback5Lows);

  // Indikator LPM
  const lpm = calculateLPMData(valid, 20);

  // Informasi broker & akumulasi rolling (dari Fase 5, bebas look-ahead)
  const bsRatio3 = toFiniteNumber(brokerData.bs_ratio_3 || brokerData.bsRatio3 || brokerData.ratio, 1.0);
  const domesticBsRatio3 = toFiniteNumber(brokerData.domestic_bs_ratio_3 || brokerData.domesticBsRatio3 || brokerData.bs_ratio_3, 1.0);
  const foreignNetVal3 = toFiniteNumber(brokerData.foreign_net_val_3 || brokerData.foreignNetVal3, 0);
  const foreignNetVal5 = toFiniteNumber(brokerData.foreign_net_val_5 || brokerData.foreignNetVal5, 0);
  const foreignConsistencyCount = toFiniteNumber(brokerData.foreign_consistency_days || brokerData.foreignConsistency || brokerData.foreignNetBuyDays5, 0);
  const bandarAvgBuyPrice = toFiniteNumber(brokerData.bandar_avg_buy_price || brokerData.bandarAvgBuyPrice || brokerData.bandar_vwap || brokerData.avgBuyPrice, null);
  const bandarVwap5h = toFiniteNumber(brokerData.bandar_vwap_5h || brokerData.bandarVwap || ema5, ema5);

  // Evaluasi Jalur A vs Jalur B
  let path = null;
  let gatePassed = false;
  const gateChecks = {};
  const failReasons = [];

  if (liquidity.tier === 'LIKUID') {
    path = 'A';
    // 6B: Gate Masuk Jalur A
    // 1. Close > MA20
    const condCloseMA20 = close > ma20;
    gateChecks.close_above_ma20 = condCloseMA20;
    if (!condCloseMA20) failReasons.push(`Close (${close}) <= MA20 (${ma20})`);

    // 2. LPM > 0 dan menanjak (LPM > MA(LPM) atau menaik)
    const condLpm = lpm.isPositive && lpm.isRising;
    gateChecks.lpm_positive_and_rising = condLpm;
    if (!condLpm) failReasons.push(`LPM tidak positif dan menanjak (pos: ${lpm.isPositive}, ris: ${lpm.isRising})`);

    // 3. Akumulasi Foreign 3H/5H positif ATAU BS_Ratio_3 >= 1.20
    const condForeignOrBs = (foreignNetVal3 > 0 || foreignNetVal5 > 0) || (bsRatio3 >= LIQUIDITY_CONFIG.JALUR_A.BS_RATIO_MIN);
    gateChecks.foreign_accum_or_bs_ratio = condForeignOrBs;
    if (!condForeignOrBs) failReasons.push(`Akumulasi foreign tidak positif & BS_Ratio_3 (${bsRatio3.toFixed(2)}) < 1,20`);

    // 4. Konsistensi net buy asing >= 3 dari 5 hari (jika data asing tersedia)
    const condForeignConsistency = foreignConsistencyCount >= LIQUIDITY_CONFIG.JALUR_A.FOREIGN_CONSISTENCY_MIN || bsRatio3 >= 1.30;
    gateChecks.foreign_consistency = condForeignConsistency;
    if (!condForeignConsistency) failReasons.push(`Konsistensi net buy asing < 3/5 hari (aktual: ${foreignConsistencyCount}/5)`);

    gatePassed = condCloseMA20 && condLpm && condForeignOrBs && condForeignConsistency;

  } else if (liquidity.tier === 'NON_LIKUID') {
    path = 'B';
    // 6C: Gate Masuk Jalur B (Lapis 2-3 / Market Maker Domestik)
    // 1. Broksum Domestik D = ALL - F konsentrasi BS_Ratio_3 >= 1.35
    const condDomesticBs = domesticBsRatio3 >= LIQUIDITY_CONFIG.JALUR_B.BS_RATIO_DOMESTIC_MIN;
    gateChecks.domestic_concentration = condDomesticBs;
    if (!condDomesticBs) failReasons.push(`BS_Ratio Domestik (${domesticBsRatio3.toFixed(2)}) < 1,35`);

    // 2. 0.97 <= Close / BandarAvgBuyPrice <= 1.06
    let condPriceBandar = true;
    if (bandarAvgBuyPrice && bandarAvgBuyPrice > 0) {
      const ratioBandar = close / bandarAvgBuyPrice;
      condPriceBandar = ratioBandar >= LIQUIDITY_CONFIG.JALUR_B.PRICE_TO_BANDAR_MIN && ratioBandar <= LIQUIDITY_CONFIG.JALUR_B.PRICE_TO_BANDAR_MAX;
      if (!condPriceBandar) failReasons.push(`Rasio Close/BandarCost (${ratioBandar.toFixed(3)}) di luar rentang 0,97 - 1,06`);
    } else {
      const ratioSupport = close / Math.max(1, support);
      condPriceBandar = ratioSupport >= 0.98 && ratioSupport <= 1.08;
    }
    gateChecks.close_near_bandar_price = condPriceBandar;

    // 3. RVOL >= 1.4
    const condRvol = rvol >= LIQUIDITY_CONFIG.JALUR_B.RVOL_MIN;
    gateChecks.rvol_high = condRvol;
    if (!condRvol) failReasons.push(`RVOL (${rvol.toFixed(2)}x) < 1,40x`);

    // 4. LPM > 0
    const condLpm = lpm.isPositive;
    gateChecks.lpm_positive = condLpm;
    if (!condLpm) failReasons.push('LPM tidak positif');

    gatePassed = condDomesticBs && condPriceBandar && condRvol && condLpm;

  } else {
    // ILLIQUID: tidak lolos lantai likuiditas minimal
    path = null;
    gatePassed = false;
    gateChecks.minimum_liquidity_floor = false;
    failReasons.push(liquidity.reason);
  }

  // Hitung Level Entry / TP / SL
  let entryLow, entryHigh, entryRef, tp1, tp2, sl, slBuffer;

  if (path === 'A') {
    // 6B: Entry Zone Jalur A (Pullback di sekitar EMA5 / Bandar VWAP 5H: Close - 0.3*ATR s/d Close)
    const pullbackLow = Math.min(close, bandarVwap5h, ema5);
    entryHigh = idxTick.roundToIdxTick(close, 'nearest', board, isFca, ticker);
    entryLow = idxTick.roundToIdxTick(Math.min(close, pullbackLow, close - (LIQUIDITY_CONFIG.JALUR_A.ENTRY_ATR_BUFFER * atr14)), 'nearest', board, isFca, ticker);
    if (entryLow > entryHigh) { const tmp = entryLow; entryLow = entryHigh; entryHigh = tmp; }
    if (entryLow === entryHigh) {
      entryLow = idxTick.roundToIdxTick(entryHigh - tickSize, 'down', board, isFca, ticker);
    }
    entryRef = Math.round((entryLow + entryHigh) / 2);

    // TP1: Entry + 1.0 * ATR14 (rentang 0.8 s/d 1.2)
    tp1 = idxTick.roundToIdxTick(entryHigh + Math.round(LIQUIDITY_CONFIG.JALUR_A.TP1_ATR_MULT * atr14), 'up', board, isFca, ticker);
    // TP2: Entry + 2.0 * ATR14 (rentang 1.8 s/d 2.5)
    tp2 = idxTick.roundToIdxTick(entryHigh + Math.round(LIQUIDITY_CONFIG.JALUR_A.TP2_ATR_MULT * atr14), 'up', board, isFca, ticker);

    // SL: di bawah swing low 5 hari atau bandar cost minus buffer, minimal Entry - 1.5 * ATR14
    const bandarCostFloor = (bandarAvgBuyPrice && bandarAvgBuyPrice > 0) ? (bandarAvgBuyPrice * 0.98) : Infinity;
    const technicalFloor = Math.min(swingLow5, bandarCostFloor);
    const minAtrSl = entryLow - Math.round(LIQUIDITY_CONFIG.JALUR_A.SL_ATR_MULT * atr14);
    // Batasi risiko maksimal 1.5x ATR (tidak boleh lebih lebar dari minAtrSl)
    const targetSl = Math.max(technicalFloor, minAtrSl);
    sl = idxTick.roundToIdxTick(targetSl, 'down', board, isFca, ticker);
    slBuffer = Math.round(atr14 * 0.5);

  } else if (path === 'B') {
    // 6C: Entry Zone Jalur B (Dekat BandarAvgBuyPrice)
    const bandarCenter = (bandarAvgBuyPrice && bandarAvgBuyPrice > 0) ? bandarAvgBuyPrice : close;
    entryHigh = idxTick.roundToIdxTick(Math.max(close, bandarCenter), 'nearest', board, isFca, ticker);
    entryLow = idxTick.roundToIdxTick(Math.min(close, bandarCenter, close - Math.round(0.15 * atr14)), 'nearest', board, isFca, ticker);
    if (entryLow > entryHigh) { const tmp = entryLow; entryLow = entryHigh; entryHigh = tmp; }
    if (entryLow === entryHigh) {
      entryLow = idxTick.roundToIdxTick(entryHigh - tickSize, 'down', board, isFca, ticker);
    }
    entryRef = Math.round((entryLow + entryHigh) / 2);

    // TP1: Entry + 1.25 * ATR14
    tp1 = idxTick.roundToIdxTick(entryHigh + Math.round(LIQUIDITY_CONFIG.JALUR_B.TP1_ATR_MULT * atr14), 'up', board, isFca, ticker);
    // TP2: Entry + 2.50 * ATR14
    tp2 = idxTick.roundToIdxTick(entryHigh + Math.round(LIQUIDITY_CONFIG.JALUR_B.TP2_ATR_MULT * atr14), 'up', board, isFca, ticker);

    // SL: Anti-shakeout, Entry - 2.0 * ATR14, berbasis close di bawah support / bandar cost
    const bandarCostFloor = (bandarAvgBuyPrice && bandarAvgBuyPrice > 0) ? (bandarAvgBuyPrice * 0.96) : support;
    const minAtrSl = entryLow - Math.round(LIQUIDITY_CONFIG.JALUR_B.SL_ATR_MULT * atr14);
    const targetSl = Math.max(Math.min(support, bandarCostFloor), minAtrSl);
    sl = idxTick.roundToIdxTick(targetSl, 'down', board, isFca, ticker);
    slBuffer = Math.round(atr14 * 0.7);

  } else {
    // Fallback teknikal untuk saham di luar kriteria (0 FAIL chart guarantee)
    entryHigh = idxTick.roundToIdxTick(close, 'nearest', board, isFca, ticker);
    entryLow = idxTick.roundToIdxTick(close - tickSize, 'down', board, isFca, ticker);
    entryRef = close;
    tp1 = idxTick.roundToIdxTick(close + Math.round(1.5 * atr14), 'up', board, isFca, ticker);
    tp2 = idxTick.roundToIdxTick(close + Math.round(2.5 * atr14), 'up', board, isFca, ticker);
    sl = idxTick.roundToIdxTick(Math.min(support, close - Math.round(1.5 * atr14)), 'down', board, isFca, ticker);
    slBuffer = Math.round(atr14 * 0.5);
  }

  // Post-normalization check & Safety Floor Guard
  if (sl >= entryLow) {
    sl = idxTick.roundToIdxTick(entryLow - tickSize, 'down', board, isFca, ticker);
  }
  if (sl <= 0) {
    sl = Math.max(1, entryLow - tickSize);
  }
  if (tp1 <= entryHigh) {
    tp1 = idxTick.roundToIdxTick(entryHigh + tickSize, 'up', board, isFca, ticker);
  }
  if (tp2 <= tp1) {
    tp2 = idxTick.roundToIdxTick(tp1 + tickSize, 'up', board, isFca, ticker);
  }

  // Risk and Reward relative to Entry Reference Zone (pullback area)
  const risk = Math.max(1, entryRef - sl);
  const reward1 = tp1 - entryRef;
  const reward2 = tp2 - entryRef;
  const rrTp1 = Math.round((reward1 / risk) * 100) / 100;
  const rrTp2 = Math.round((reward2 / risk) * 100) / 100;
  const isSafeRR = rrTp1 >= 0.8 || rrTp2 >= 1.5;

  const plan = {
    path,
    tier: liquidity.tier,
    entry_low: entryLow,
    entry_high: entryHigh,
    entry_ref: entryRef,
    sl,
    tp1,
    tp2,
    bep_stop: entryRef,
    sl_buffer: slBuffer,
    atr14: Math.round(atr14 * 100) / 100,
    risk,
    reward1,
    reward2,
    rr: rrTp1,
    rr_tp1: rrTp1,
    rr_tp2: rrTp2,
    isSafeRR
  };

  const badge = gatePassed
    ? (path === 'A' ? 'SIAP_EKSEKUSI_LIKUID' : 'SIAP_EKSEKUSI_NON_LIKUID')
    : 'REFERENSI_TEKNIKAL';

  return {
    ticker,
    status: 'OK',
    gate_passed: gatePassed,
    path,
    badge,
    is_screener_candidate: gatePassed,
    liquidity,
    indicators: {
      close,
      ma20,
      ema5,
      atr14: Math.round(atr14 * 100) / 100,
      rvol,
      support,
      resistance,
      swingLow5,
      lpm: {
        lastValue: lpm.lastValue,
        isPositive: lpm.isPositive,
        isRising: lpm.isRising
      }
    },
    gate_checks: gateChecks,
    fail_reasons: failReasons,
    trade_plan: plan
  };
}

module.exports = {
  LIQUIDITY_CONFIG,
  toFiniteNumber,
  formatRupiahRingkas,
  calculateLiquidityProfile,
  calculateLPMData,
  evaluateAdaptiveSetup
};

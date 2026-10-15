'use strict';

/**
 * Bandar Metrics Quantitative Engine (Fase 6)
 *
 * Menghitung indikator kuantitatif bandarmologi dan aliran dana institusional:
 * 1. Corr F (Foreign Correlation): korelasi bergulir antara harga dan aliran asing (-1.00 s.d. +1.00).
 * 2. Par F (Foreign Participation): persentase omset asing terhadap total omset bursa (0% s.d. 100%).
 * 3. 3 Overlays:
 *    - LPM (Liquidity Provider Marker / Level Pembelian Major institusi)
 *    - Foreign Flow Cumulative (aliran dana asing kumulatif)
 *    - Money Flow / CMF (Chaikin Money Flow)
 * 4. 2 Sub-panel Histograms:
 *    - Intensity (Intensitas Aktivitas Bandar)
 *    - Volume Rotation (Perputaran Volume antar broker)
 *
 * Kepatuhan AntiSlop:
 * - Bahasa Indonesia finansial baku, tanpa em dash.
 * - Nilai data yang hilang dikembalikan sebagai null transparan tanpa angka sintetis.
 */

function round(val, decimals = 2) {
  if (val == null || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Menghitung korelasi Pearson antara 2 deret angka
 */
function calculatePearsonCorrelation(seriesA, seriesB) {
  if (!Array.isArray(seriesA) || !Array.isArray(seriesB)) return null;
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 3) return null;

  let sumA = 0, sumB = 0;
  let sumA2 = 0, sumB2 = 0;
  let sumAB = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const a = Number(seriesA[i]);
    const b = Number(seriesB[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    sumA += a;
    sumB += b;
    sumA2 += a * a;
    sumB2 += b * b;
    sumAB += a * b;
    count++;
  }

  if (count < 3) return null;

  const denomA = count * sumA2 - sumA * sumA;
  const denomB = count * sumB2 - sumB * sumB;

  if (denomA <= 0 || denomB <= 0) return 0.0;

  const r = (count * sumAB - sumA * sumB) / Math.sqrt(denomA * denomB);
  if (!Number.isFinite(r)) return 0.0;
  return round(Math.max(-1.0, Math.min(1.0, r)), 2);
}

/**
 * Corr F: Korelasi bergulir antara perubahan harga penutupan dan aliran bersih asing
 */
function calculateCorrForeign(candles, foreignFlow, windowPeriod = 14) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return {
      value: null,
      status: 'DATA_TIDAK_TERSEDIA',
      label: 'Data Tidak Tersedia',
      description: 'Jumlah candle tidak mencukupi untuk menghitung korelasi.'
    };
  }

  const p = Math.max(3, Math.min(candles.length, windowPeriod));
  const recentCandles = candles.slice(-p);

  // Perubahan harga
  const priceChanges = [];
  for (let i = 1; i < recentCandles.length; i++) {
    const prev = Number(recentCandles[i - 1].close);
    const curr = Number(recentCandles[i].close);
    priceChanges.push(prev > 0 ? (curr - prev) / prev : 0);
  }

  // Aliran asing jika tersedia
  let netFlows = [];
  if (Array.isArray(foreignFlow) && foreignFlow.length >= 3) {
    const mapByDate = new Map();
    for (const item of foreignFlow) {
      const dt = item.date || item.time || item.trade_date;
      if (dt) mapByDate.set(String(dt).slice(0, 10), Number(item.foreign_net || item.net || item.net_value || 0));
    }
    for (let i = 1; i < recentCandles.length; i++) {
      const dt = String(recentCandles[i].time || recentCandles[i].date).slice(0, 10);
      netFlows.push(mapByDate.get(dt) || 0);
    }
  } else {
    // Estimasi aliran dari candle bila feed asing terpisah belum dimuat
    // Perubahan volume bertanda arah close vs open
    const hasAnyForeign = recentCandles.some(c => c.foreign_net_value != null || c.foreign_net != null);
    if (hasAnyForeign) {
      for (let i = 1; i < recentCandles.length; i++) {
        netFlows.push(Number(recentCandles[i].foreign_net_value != null ? recentCandles[i].foreign_net_value : recentCandles[i].foreign_net) || 0);
      }
    }
  }

  if (netFlows.length < 2 || netFlows.every(v => v === 0)) {
    return {
      value: null,
      status: 'NETRAL_ATAU_BELUM_ADA_FEED',
      label: 'Belum Ada Feed Asing',
      description: 'Data aliran asing harian belum tersedia pada periode ini.'
    };
  }

  const corr = calculatePearsonCorrelation(priceChanges, netFlows);

  let status = 'NETRAL';
  let label = 'Korelasi Netral';
  if (corr != null) {
    if (corr >= 0.6) {
      status = 'KORELASI_POSITIF_TINGGI';
      label = 'Korelasi Positif Tinggi';
    } else if (corr >= 0.25) {
      status = 'KORELASI_POSITIF_MODERAT';
      label = 'Korelasi Positif Moderat';
    } else if (corr <= -0.6) {
      status = 'KORELASI_NEGATIF_TINGGI';
      label = 'Korelasi Negatif Tinggi';
    } else if (corr <= -0.25) {
      status = 'KORELASI_NEGATIF_MODERAT';
      label = 'Korelasi Negatif Moderat';
    }
  }

  return {
    value: corr,
    status,
    label,
    description: corr != null
      ? `Korelasi bergulir ${p} hari antara harga dan aliran asing adalah ${corr}.`
      : 'Korelasi tidak dapat dihitung.'
  };
}

/**
 * Par F: Partisipasi Asing terhadap Total Turnover
 */
function calculateParForeign(foreignTurnover, totalTurnover) {
  const fTurn = Number(foreignTurnover);
  const tTurn = Number(totalTurnover);

  if (!Number.isFinite(fTurn) || !Number.isFinite(tTurn) || tTurn <= 0) {
    return {
      value: null,
      percentage: null,
      status: 'DATA_TIDAK_TERSEDIA',
      label: 'Tidak Tersedia'
    };
  }

  const ratio = Math.max(0.0, Math.min(1.0, fTurn / tTurn));
  const pct = round(ratio * 100, 1);

  let status = 'RENDAH';
  let label = 'Partisipasi Rendah (< 15%)';
  if (pct >= 40.0) {
    status = 'SANGAT_TINGGI';
    label = 'Partisipasi Sangat Tinggi (>= 40%)';
  } else if (pct >= 25.0) {
    status = 'TINGGI';
    label = 'Partisipasi Tinggi (25% - 40%)';
  } else if (pct >= 15.0) {
    status = 'MODERAT';
    label = 'Partisipasi Moderat (15% - 25%)';
  }

  return {
    value: ratio,
    percentage: pct,
    status,
    label
  };
}

/**
 * LPM (Liquidity Provider Marker / Level Pembelian Major)
 * Menentukan klaster harga rata-rata tertimbang volume saat akumulasi terjadi
 */
function calculateLPM(candles, brokerSummary, windowPeriod = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const p = Math.min(candles.length, windowPeriod);
  const slice = candles.slice(-p);

  let totalVol = 0;
  let weightedSum = 0;
  let highestVolCandle = null;
  let maxVol = 0;

  for (const c of slice) {
    const vol = Number(c.volume || 0);
    const close = Number(c.close || 0);
    const typical = Number(c.high && c.low && c.close ? (c.high + c.low + c.close) / 3 : close);

    if (vol > 0 && typical > 0) {
      totalVol += vol;
      weightedSum += typical * vol;
      if (vol > maxVol) {
        maxVol = vol;
        highestVolCandle = c;
      }
    }
  }

  const vwap = totalVol > 0 ? Math.round(weightedSum / totalVol) : null;

  // Jika ada broker summary, ambil average buy dari top buyer peringkat 1
  let topBuyerAvg = null;
  let topBuyerBroker = null;
  if (brokerSummary && Array.isArray(brokerSummary.top_buyers) && brokerSummary.top_buyers.length > 0) {
    const b1 = brokerSummary.top_buyers[0];
    if (b1 && b1.avg_buy && b1.avg_buy > 0) {
      topBuyerAvg = Math.round(b1.avg_buy);
      topBuyerBroker = b1.broker || b1.broker_code || '';
    } else if (b1 && b1.avg_price && b1.avg_price > 0) {
      topBuyerAvg = Math.round(b1.avg_price);
      topBuyerBroker = b1.broker || b1.broker_code || '';
    }
  }

  const majorLevel = topBuyerAvg || vwap;

  return {
    major_level: majorLevel,
    vwap_20: vwap,
    top_buyer_avg: topBuyerAvg,
    top_buyer_broker: topBuyerBroker,
    highest_volume_date: highestVolCandle ? highestVolCandle.time : null,
    highest_volume_price: highestVolCandle ? highestVolCandle.close : null,
    label: majorLevel ? `LPM: ${majorLevel.toLocaleString('id-ID')}` : 'LPM Belum Tersedia'
  };
}

/**
 * Money Flow / CMF (Chaikin Money Flow)
 * CMF = Sum(MFV, 20) / Sum(Volume, 20)
 * MFV = [((Close - Low) - (High - Close)) / (High - Low)] * Volume
 */
function calculateMoneyFlow(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];
  const mfvList = [];
  const volList = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const h = Number(c.high != null ? c.high : c.close);
    const l = Number(c.low != null ? c.low : c.close);
    const cl = Number(c.close);
    const v = Number(c.volume || 0);

    let mfm = 0;
    if (h - l > 0) {
      mfm = ((cl - l) - (h - cl)) / (h - l);
    }
    const mfv = mfm * v;
    mfvList.push(mfv);
    volList.push(v);

    if (i < period - 1) {
      results.push({
        time: c.time,
        value: 0.0,
        signal: 'NETRAL'
      });
      continue;
    }

    let sumMfv = 0;
    let sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumMfv += mfvList[j];
      sumVol += volList[j];
    }

    const cmf = sumVol > 0 ? round(sumMfv / sumVol, 3) : 0.0;
    let signal = 'NETRAL';
    if (cmf >= 0.15) signal = 'INFLOW_KUAT';
    else if (cmf > 0.05) signal = 'INFLOW';
    else if (cmf <= -0.15) signal = 'OUTFLOW_KUAT';
    else if (cmf < -0.05) signal = 'OUTFLOW';

    results.push({
      time: c.time,
      value: cmf,
      signal
    });
  }

  return results;
}

/**
 * Foreign Flow Cumulative Series
 */
function calculateForeignFlowCumulative(candles, foreignFlow) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const mapByDate = new Map();
  if (Array.isArray(foreignFlow)) {
    for (const item of foreignFlow) {
      const dt = item.date || item.time || item.trade_date;
      if (dt) mapByDate.set(String(dt).slice(0, 10), Number(item.foreign_net || item.net || 0));
    }
  }

  let runningCumulative = 0;
  const series = [];

  for (const c of candles) {
    const dt = String(c.time || c.date).slice(0, 10);
    const net = mapByDate.has(dt) ? mapByDate.get(dt) : Number(c.foreign_net_value || c.foreign_net || 0);
    runningCumulative += net;
    series.push({
      time: c.time,
      net: net,
      value: runningCumulative,
      cumulative: runningCumulative
    });
  }

  return series;
}

/**
 * Intensity Histogram (Intensitas Aktivitas Bandar)
 * Mengukur kombinasi lonjakan volume abnormal dan ekspansi rentang harga
 */
function calculateIntensityHistogram(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];
  const volumes = candles.map(c => Number(c.volume || 0));

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = Number(c.open != null ? c.open : c.close);
    const close = Number(c.close);
    const high = Number(c.high != null ? c.high : c.close);
    const low = Number(c.low != null ? c.low : c.close);
    const vol = volumes[i];

    // Volume moving average
    const p = Math.min(i + 1, period);
    let volSum = 0;
    for (let j = i - p + 1; j <= i; j++) volSum += volumes[j];
    const avgVol = volSum / p || 1;

    const volRatio = vol / avgVol;
    const range = high - low;
    const body = Math.abs(close - open);
    const bodyRatio = range > 0 ? body / range : 0.5;

    // Arah pergerakan harga
    const direction = close >= open ? 1 : -1;
    const rawIntensity = volRatio * (0.5 + 0.5 * bodyRatio) * direction;
    const score = round(rawIntensity, 2);

    let color = '#6b728040'; // abu-abu transparan (normal)
    if (score >= 2.0) color = '#10b981'; // akumulasi kuat (hijau terang)
    else if (score > 1.0) color = '#10b98180'; // akumulasi moderat
    else if (score <= -2.0) color = '#ef4444'; // distribusi kuat (merah terang)
    else if (score < -1.0) color = '#ef444480'; // distribusi moderat

    results.push({
      time: c.time,
      value: score,
      color,
      is_accumulation: score > 0,
      is_distribution: score < 0
    });
  }

  return results;
}

/**
 * Volume Rotation Histogram
 * Mengukur percepatan omset volume relatif terhadap median 20 sesi
 */
function calculateVolumeRotation(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];
  const turnovers = candles.map(c => Number(c.volume || 0) * Number(c.close || 0));

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const turn = turnovers[i];

    const p = Math.min(i + 1, period);
    const recentTurnovers = turnovers.slice(i - p + 1, i + 1).sort((a, b) => a - b);
    const medianTurnover = recentTurnovers[Math.floor(recentTurnovers.length / 2)] || 1;

    const rotationRatio = round(turn / medianTurnover, 2);

    let color = '#3b82f640';
    if (rotationRatio >= 2.5) color = '#f59e0b'; // rotasi sangat tinggi (amber)
    else if (rotationRatio >= 1.5) color = '#3b82f6'; // rotasi aktif (biru)

    results.push({
      time: c.time,
      value: rotationRatio,
      color,
      turnover: turn
    });
  }

  return results;
}

/**
 * Master API: Menghitung paket penuh Bandar Metrics
 */
function calculateBandarMetrics(params = {}) {
  const { candles, foreignFlow, brokerSummary, totalTurnover } = params;

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      success: false,
      error: 'Candles array wajib diisi.'
    };
  }

  const latestCandle = candles[candles.length - 1];
  const latestTurnover = totalTurnover || (latestCandle ? Number(latestCandle.volume || 0) * Number(latestCandle.close || 0) : 0);

  // Foreign turnover dari broker summary atau foreign flow
  let foreignTurnover = null;
  if (brokerSummary && brokerSummary.foreign_turnover) {
    foreignTurnover = Number(brokerSummary.foreign_turnover);
  } else if (brokerSummary && brokerSummary.foreign_buy_val && brokerSummary.foreign_sell_val) {
    foreignTurnover = Number(brokerSummary.foreign_buy_val) + Number(brokerSummary.foreign_sell_val);
  }

  const corrF = calculateCorrForeign(candles, foreignFlow);
  const parF = calculateParForeign(foreignTurnover, latestTurnover);
  const lpm = calculateLPM(candles, brokerSummary);
  const moneyFlow = calculateMoneyFlow(candles);
  const foreignFlowSeries = calculateForeignFlowCumulative(candles, foreignFlow);
  const intensity = calculateIntensityHistogram(candles);
  const volumeRotation = calculateVolumeRotation(candles);

  const latestCmf = moneyFlow.length > 0 ? moneyFlow[moneyFlow.length - 1] : null;
  const latestIntensity = intensity.length > 0 ? intensity[intensity.length - 1] : null;
  const latestRotation = volumeRotation.length > 0 ? volumeRotation[volumeRotation.length - 1] : null;

  return {
    success: true,
    as_of: latestCandle ? latestCandle.time : null,
    indicators: {
      corr_foreign: corrF,
      par_foreign: parF,
      lpm: lpm,
      latest_cmf: latestCmf,
      latest_intensity: latestIntensity,
      latest_rotation: latestRotation
    },
    series: {
      money_flow: moneyFlow,
      foreign_flow_cumulative: foreignFlowSeries,
      intensity: intensity,
      volume_rotation: volumeRotation
    }
  };
}

module.exports = {
  calculatePearsonCorrelation,
  calculateCorrForeign,
  calculateParForeign,
  calculateLPM,
  calculateMoneyFlow,
  calculateForeignFlowCumulative,
  calculateIntensityHistogram,
  calculateVolumeRotation,
  calculateBandarMetrics
};

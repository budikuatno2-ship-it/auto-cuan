'use strict';

/**
 * Broksum Archive Sanity Validator
 * =================================
 * Membandingkan payload broker summary dengan nilai transaksi candle hari yang sama.
 *
 * Mengapa modul ini ada:
 * Pemeriksaan lama hanya mendeteksi file yang "terpotong 25 broker". Kasus lain
 * seperti file kosong (brokers: []) dan file yang hanya separuh ukuran (subset broker)
 * LOLOS dari pemeriksaan tersebut sehingga tidak pernah diambil ulang oleh backfill.
 *
 * Aturan kewajaran:
 * A. Rasio nilai:  ratio = total_buy_value / candle_turnover
 *                  Tidak wajar bila ratio < MIN_RATIO atau ratio > MAX_RATIO.
 *                  MAX_RATIO sengaja longgar karena transaksi negosiasi (NG) dapat
 *                  membuat nilai broksum melebihi nilai candle reguler.
 * B. Kosong:       brokers/levels kosong padahal candle volume > 0.
 * C. Seimbang:     |total_buy - total_sell| / max(total_buy, total_sell) > 0.5%.
 */

const MIN_RATIO = 0.95;
const MAX_RATIO = 1.25;
const BALANCE_TOLERANCE = 0.005; // 0.5%

function cleanNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Hitung total nilai beli, total nilai jual, dan jumlah broker dari payload broksum.
 *
 * PENTING: payload Arjum dapat membawa DUA bentuk sekaligus:
 *   - `brokers[]`       : daftar flat hasil `broker_limit` (bisa SUBSET, mis. 25-70 broker)
 *   - `broker_levels[]` : pasangan buy/sell hasil `level_limit` (biasanya SUPERSET, mis. 67-100)
 *
 * Sebelumnya modul ini memilih `brokers[]` bila tidak kosong, sehingga nilai transaksi
 * hanya dihitung dari broker teratas (menghasilkan ratio < 0.95 yang salah dan
 * "broker hilang" pada flow=F). Solusinya: gabungkan KEDUA sumber secara deduplikatif
 * dan ambil nilai maksimum per (broker, sisi) sehingga tidak ada double-counting.
 */
function summarizeBroksumTotals(payload) {
  if (!payload || typeof payload !== 'object') {
    return { totalBuy: 0, totalSell: 0, brokerCount: 0, codes: [], source: 'none' };
  }

  // key = BROKER_CODE -> { buy, sell, name }
  const perBroker = new Map();
  const touch = (code, name) => {
    const key = String(code).trim().toUpperCase();
    if (!key) return null;
    if (!perBroker.has(key)) perBroker.set(key, { buy: 0, sell: 0, name: name || key });
    const rec = perBroker.get(key);
    if (name && (rec.name === key)) rec.name = name;
    return rec;
  };

  let sawBrokers = false;
  if (Array.isArray(payload.brokers)) {
    for (const b of payload.brokers) {
      if (!b || !b.broker_code) continue;
      sawBrokers = true;
      const rec = touch(b.broker_code, b.broker_name);
      if (!rec) continue;
      const buy = cleanNumber(b.bval != null ? b.bval : b.buy_val);
      const sell = cleanNumber(b.sval != null ? b.sval : b.sell_val);
      if (buy > rec.buy) rec.buy = buy;
      if (sell > rec.sell) rec.sell = sell;
    }
  }

  let sawLevels = false;
  if (Array.isArray(payload.broker_levels)) {
    for (const lvl of payload.broker_levels) {
      if (!lvl) continue;
      if (lvl.buy && lvl.buy.broker_code) {
        sawLevels = true;
        const rec = touch(lvl.buy.broker_code, lvl.buy.broker_name);
        if (rec) {
          const buy = cleanNumber(lvl.buy.bval);
          if (buy > rec.buy) rec.buy = buy;
        }
      }
      if (lvl.sell && lvl.sell.broker_code) {
        sawLevels = true;
        const rec = touch(lvl.sell.broker_code, lvl.sell.broker_name);
        if (rec) {
          const sell = cleanNumber(lvl.sell.sval);
          if (sell > rec.sell) rec.sell = sell;
        }
      }
    }
  }

  let totalBuy = 0;
  let totalSell = 0;
  const codes = [];
  for (const [code, rec] of perBroker.entries()) {
    totalBuy += rec.buy;
    totalSell += rec.sell;
    if (rec.buy > 0 || rec.sell > 0) codes.push(code);
  }

  const source = sawBrokers && sawLevels ? 'both' : (sawLevels ? 'levels' : (sawBrokers ? 'brokers' : 'none'));
  return { totalBuy, totalSell, brokerCount: codes.length, codes, source };
}

/**
 * Validasi kewajaran satu payload broksum terhadap candle hari tersebut.
 *
 * @param {object} payload - Payload broksum (all atau F)
 * @param {object|null} candle - { close, volume, value } hari yang sama (opsional)
 * @param {object} [options]
 * @param {boolean} [options.requireBalance=true] - Cek total beli ≈ total jual
 * @returns {{valid:boolean, flags:string[], ratio:number|null, totals:object}}
 */
function validateBroksumAgainstCandle(payload, candle, options = {}) {
  const requireBalance = options.requireBalance !== false;
  const flags = [];
  const totals = summarizeBroksumTotals(payload);

  // Derived no-trade: sah hanya bila candle memang tanpa transaksi (atau candle tidak diketahui).
  if (payload && payload.derived === 'no-trade') {
    const candleVol = candle ? cleanNumber(candle.volume) : 0;
    if (candleVol > 0) {
      return {
        valid: false,
        flags: ['no_trade_but_candle_has_volume'],
        ratio: 0,
        totals,
        candleTurnover: candleTurnoverOf(candle)
      };
    }
    return { valid: true, flags: ['derived_no_trade'], ratio: null, totals, candleTurnover: 0 };
  }

  const candleTurnover = candleTurnoverOf(candle);

  // Jika candle tidak tersedia / turnover nol, kita tidak bisa menilai rasio.
  // Yang tetap bisa dinilai: file kosong pada sesi yang punya volume.
  if (!candle || candleTurnover <= 0) {
    const candleVol = candle ? cleanNumber(candle.volume) : 0;
    if (candleVol > 0 && totals.brokerCount === 0 && totals.totalBuy === 0 && totals.totalSell === 0) {
      return { valid: false, flags: ['empty_broksum_but_candle_has_volume'], ratio: null, totals, candleTurnover };
    }
    return { valid: true, flags: ['no_candle_reference'], ratio: null, totals, candleTurnover };
  }

  const ratio = totals.totalBuy > 0 ? totals.totalBuy / candleTurnover : 0;

  // A. Rasio nilai
  if (ratio < MIN_RATIO) flags.push('ratio_below_min');
  if (ratio > MAX_RATIO) flags.push('ratio_above_max');

  // B. File kosong padahal ada volume
  if (totals.brokerCount === 0 && cleanNumber(candle.volume) > 0) {
    flags.push('empty_broksum_but_candle_has_volume');
  }

  // C. Beli ≠ jual
  if (requireBalance) {
    const denom = Math.max(totals.totalBuy, totals.totalSell);
    if (denom > 0) {
      const imbalance = Math.abs(totals.totalBuy - totals.totalSell) / denom;
      if (imbalance > BALANCE_TOLERANCE) flags.push('buy_sell_imbalance');
    }
  }

  return {
    valid: flags.length === 0,
    flags,
    ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null,
    totals,
    candleTurnover
  };
}

function candleTurnoverOf(candle) {
  if (!candle) return 0;
  const value = cleanNumber(candle.value != null ? candle.value : candle.turnover);
  if (value > 0) return value;
  const close = cleanNumber(candle.close);
  const volume = cleanNumber(candle.volume);
  if (close > 0 && volume > 0) return close * volume;
  return 0;
}

/**
 * Bangun himpunan kode broker dari payload, menggabungkan `brokers[]` DAN
 * `broker_levels[]`, mengabaikan entri `null`/padding. Dipakai untuk perbandingan
 * F vs all tanpa false positive akibat padding.
 */
function buildCompleteCodeSet(payload) {
  const codes = new Set();
  if (!payload || typeof payload !== 'object') return codes;
  if (Array.isArray(payload.brokers)) {
    for (const b of payload.brokers) {
      if (b && b.broker_code) codes.add(String(b.broker_code).trim().toUpperCase());
    }
  }
  if (Array.isArray(payload.broker_levels)) {
    for (const lvl of payload.broker_levels) {
      if (!lvl) continue;
      if (lvl.buy && lvl.buy.broker_code) codes.add(String(lvl.buy.broker_code).trim().toUpperCase());
      if (lvl.sell && lvl.sell.broker_code) codes.add(String(lvl.sell.broker_code).trim().toUpperCase());
    }
  }
  return codes;
}

/**
 * Validasi khusus flow Foreign: nilai asing tidak boleh melebihi nilai `all` hari yang sama.
 *
 * @param {object} foreignPayload
 * @param {object} allPayload
 * @param {object|number} [optionsOrTolerance] - angka = tolerancePct; object = { tolerancePct, requireAllDataFlag }
 * @returns {{valid:boolean, flags:string[], foreignTotals:object, allTotals:object, missingCodes:number, skippedReason?:string}}
 *
 * CATATAN PENTING (perbaikan 18 Okt 2026):
 * Aturan `foreign_broker_missing_in_all` sebelumnya menghasilkan 12.376 false positive
 * karena `broker_levels[]` di file `all` dipadding `null` (panjang 100, isi 25-73).
 * Perbaikan: himpunan kode dibangun dari GABUNGAN `brokers[]` + `broker_levels[]`,
 * dan aturan ini HANYA dijalankan ketika `all` membawa penanda eksplisit `all_data === true`
 * (kecuali `requireAllDataFlag: false` diberikan untuk keperluan diagnostik).
 */
function validateForeignAgainstAll(foreignPayload, allPayload, optionsOrTolerance) {
  const opts = typeof optionsOrTolerance === 'number'
    ? { tolerancePct: optionsOrTolerance }
    : (optionsOrTolerance || {});
  const tolerancePct = Number(opts.tolerancePct != null ? opts.tolerancePct : 1);
  const requireAllDataFlag = opts.requireAllDataFlag !== false;

  const f = summarizeBroksumTotals(foreignPayload);
  const a = summarizeBroksumTotals(allPayload);
  const flags = [];

  // Kasus khusus: vendor Arjum kadang mengirim payload F KOSONG (brokers: [],
  // broker_levels: []) tetapi dengan `broker_date_max` < tanggal yang diminta,
  // artinya vendor memang belum punya data F untuk tanggal itu (bukan korupsi).
  // Contoh nyata: KOTA 2026-10-16 dengan broker_date_max = 2026-10-15.
  const foreignIsEmpty = f.brokerCount === 0 && foreignPayload && foreignPayload.derived !== 'no-trade';
  const requestedDate = String((foreignPayload && (foreignPayload.broker_start_date || foreignPayload.date || foreignPayload.broker_end_date)) || '').slice(0, 10);
  const vendorMax = String((foreignPayload && foreignPayload.broker_date_max) || '').slice(0, 10);
  const vendorNotReadyYet = Boolean(requestedDate && vendorMax && vendorMax < requestedDate);

  if (foreignIsEmpty && vendorNotReadyYet) {
    return {
      valid: true,
      flags: ['vendor_foreign_not_yet_published'],
      foreignTotals: f,
      allTotals: a,
      missingCodes: 0,
      skippedReason: 'vendor_foreign_pending'
    };
  }

  if (f.totalBuy > a.totalBuy * (1 + tolerancePct / 100) && a.totalBuy > 0) {
    flags.push('foreign_buy_exceeds_all');
  }
  if (f.totalSell > a.totalSell * (1 + tolerancePct / 100) && a.totalSell > 0) {
    flags.push('foreign_sell_exceeds_all');
  }

  // Aturan broker-hilang: hanya dijalankan ketika `all` benar-benar lengkap.
  const allHasFlag = allPayload && allPayload.all_data === true;
  let missingCodes = 0;
  let skippedReason;
  if (requireAllDataFlag && !allHasFlag) {
    skippedReason = 'all_missing_all_data_flag';
  } else {
    const allCodes = buildCompleteCodeSet(allPayload);
    const foreignCodes = buildCompleteCodeSet(foreignPayload);
    for (const code of foreignCodes) {
      if (!allCodes.has(code)) missingCodes++;
    }
    if (missingCodes > 0) flags.push('foreign_broker_missing_in_all');
  }

  return {
    valid: flags.length === 0,
    flags,
    foreignTotals: f,
    allTotals: a,
    missingCodes,
    skippedReason
  };
}

module.exports = {
  MIN_RATIO,
  MAX_RATIO,
  BALANCE_TOLERANCE,
  summarizeBroksumTotals,
  validateBroksumAgainstCandle,
  validateForeignAgainstAll,
  buildCompleteCodeSet,
  candleTurnoverOf
};

/**
 * lib/short-swing-hourly-confirmation.js
 *
 * Short Swing Hourly Confirmation Engine (Addendum P1 & P10 / V6 Specification)
 *
 * Prinsip Utama:
 * 1. Pembaruan ringan selama jam bursa untuk setup swing harian yang sudah dihitung EOD.
 * 2. BUKAN screener baru dan BUKAN menghidupkan kembali Day Trade / FastWatcher.
 * 3. Ranking utama Top 20 dan Top 5 malam hari bersifat immutable (tidak ditulis ulang).
 * 4. Saat bursa buka, sistem mengecek apakah setup masih valid, dekat entry, di area beli, dsb.
 * 5. Fokus selektif: IHSG, Top 20, Top 5, posisi aktif, dan watchlist prioritas (JANGAN panggil 963 ticker!).
 * 6. Status konfirmasi tidak boleh memalsukan probabilitas keberhasilan.
 * 7. Candlestick sementara: Last > Open = hijau, Last < Open = merah, Last = Open = netral. Tidak mengarang wick tanpa data High/Low.
 * 8. Feature flag WAJIB OFF secara default (ENABLE_HOURLY_CONFIRMATION = false).
 */

'use strict';

const { isMarketOpen, getMarketSession, isExchangeHoliday } = require('./market-hours-guard');

// Konstanta State Evaluasi sesuai kontrak Addendum
const CONFIRMATION_STATES = Object.freeze({
  DATA_NOT_READY: 'DATA_NOT_READY',
  SETUP_VALID: 'SETUP_VALID',
  MOMENTUM_STRENGTHENING: 'MOMENTUM_STRENGTHENING',
  NEAR_ENTRY: 'NEAR_ENTRY',
  ENTRY_ZONE_VALID: 'ENTRY_ZONE_VALID',
  PRICE_ABOVE_MAX_ENTRY: 'PRICE_ABOVE_MAX_ENTRY',
  SETUP_INVALIDATED: 'SETUP_INVALIDATED',
  STALE_DATA: 'STALE_DATA',
  BLOCKED: 'BLOCKED'
});

// Jadwal Target Resmi (WIB)
const SCHEDULE_TARGETS = Object.freeze({
  MON_THU: ['09:15', '10:15', '11:15', '12:15', '13:45', '14:45', '15:40'],
  FRI: ['09:15', '10:15', '11:15', '11:40', '14:15', '15:15', '15:40']
});

// Toleransi waktu quote dianggap basi (default: 15 menit = 900.000 ms)
const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;

// Umur maksimum snapshot setup (as_of) agar masih boleh dikonfirmasi.
// Setup EOD berumur > 10 hari kalender sudah melewati horizon Short Swing
// (2–5 hari bursa) dan level entry/SL/TP-nya tidak lagi dapat dipercaya.
const DEFAULT_MAX_SETUP_AGE_DAYS = 10;

// Toleransi harga "NEAR_ENTRY" (misal: dalam jarak 1.5% di bawah batas bawah entry zone atau pivot)
const DEFAULT_NEAR_ENTRY_THRESHOLD_PCT = 1.5;

// R/R minimum yang wajib dipenuhi agar sebuah setup layak dikonfirmasi sebagai
// zona entry yang valid. Konsisten dengan MIN_RR_THRESHOLD short-swing canonical.
const MIN_HOURLY_RR_THRESHOLD = 1.5;

/**
 * Memeriksa apakah feature flag aktif.
 * Default: false (OFF)
 */
function isFeatureEnabled() {
  const envVal = process.env.ENABLE_HOURLY_CONFIRMATION;
  return envVal === 'true' || envVal === '1';
}

/**
 * Menghitung warna dan representasi candlestick sementara
 * Last > Open = Hijau (BULLISH)
 * Last < Open = Merah (BEARISH)
 * Last == Open = Netral (NEUTRAL)
 */
function evaluateInterimCandle(open, last, high, low) {
  if (open == null || last == null || isNaN(open) || isNaN(last)) {
    return { color: 'UNKNOWN', direction: 'UNKNOWN', hasWick: false };
  }

  let color = 'NEUTRAL';
  let direction = 'FLAT';
  if (last > open) {
    color = 'GREEN';
    direction = 'BULLISH';
  } else if (last < open) {
    color = 'RED';
    direction = 'BEARISH';
  }

  const hasHighLow = high != null && low != null && !isNaN(high) && !isNaN(low);

  return {
    color,
    direction,
    hasWick: hasHighLow,
    open: Number(open),
    last: Number(last),
    high: hasHighLow ? Number(high) : null,
    low: hasHighLow ? Number(low) : null
  };
}

/**
 * Evaluasi status konfirmasi untuk satu ticker setup swing
 *
 * @param {Object} setup - Objek snapshot malam (EOD):
 *    {
 *      ticker: string,
 *      entryMin: number, // batas bawah area beli
 *      entryMax: number, // batas atas area beli (max entry)
 *      stopLoss: number, // level invalidasi
 *      targetPrice: number, // TP
 *      baseVolume: number, // volume rata-rata EOD
 *    }
 * @param {Object} quote - Objek intraday bar:
 *    {
 *      open: number,
 *      high: number,
 *      low: number,
 *      last: number,
 *      volume: number,
 *      timestamp: number|string|Date
 *    }
 * @param {Object} options - Opsi evaluasi (now, staleThresholdMs, etc.)
 * @returns {Object} Hasil evaluasi konfirmasi
 */
function blocked(reason, extra = {}) {
  return Object.assign({
    status: CONFIRMATION_STATES.BLOCKED,
    reason
  }, extra);
}

/**
 * Hitung R/R konservatif setup swing: (targetPrice - maxEntry) / (maxEntry - stopLoss).
 * Mengembalikan { rr, maxEntry } bila cukup data, atau { rr: null, reason } bila tidak.
 */
function computeHourlyRiskReward(setup) {
  const entryMin = Number(setup && setup.entryMin);
  const entryMax = Number(setup && setup.entryMax);
  const stopLoss = Number(setup && setup.stopLoss);
  const targetPrice = Number(setup && setup.targetPrice);

  const eMin = Number.isFinite(entryMin) ? entryMin : NaN;
  const eMax = Number.isFinite(entryMax) ? entryMax : NaN;
  const maxEntry = Number.isFinite(Math.max(eMin, eMax)) && (Number.isFinite(eMin) || Number.isFinite(eMax))
    ? Math.max(Number.isFinite(eMin) ? eMin : -Infinity, Number.isFinite(eMax) ? eMax : -Infinity)
    : NaN;

  if (!Number.isFinite(eMin) || !Number.isFinite(eMax)) {
    return { rr: null, maxEntry: null, reason: 'Rentang entry (entryMin/entryMax) tidak lengkap' };
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0) {
    return { rr: null, maxEntry, reason: 'Stop loss atau target price tidak tersedia untuk validasi R/R' };
  }
  if (maxEntry <= stopLoss || targetPrice <= maxEntry) {
    return { rr: null, maxEntry, reason: 'Struktur plan invalid: maxEntry <= stopLoss atau target <= maxEntry' };
  }
  const risk = maxEntry - stopLoss;
  const reward = targetPrice - maxEntry;
  if (risk <= 0 || reward <= 0) {
    return { rr: null, maxEntry, reason: 'risk/reward tidak positif' };
  }
  const rr = reward / risk;
  return { rr: Number.isFinite(rr) ? Number(rr.toFixed(4)) : null, maxEntry, reason: null };
}

function evaluateHourlyConfirmation(setup, quote, options = {}) {
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const staleThreshold = options.staleThresholdMs || DEFAULT_STALE_THRESHOLD_MS;
  const nearEntryThresholdPct = options.nearEntryThresholdPct || DEFAULT_NEAR_ENTRY_THRESHOLD_PCT;
  const minRr = options.minRiskReward != null ? Number(options.minRiskReward) : MIN_HOURLY_RR_THRESHOLD;

  // 1. Data Not Ready Check
  if (!setup || !quote) {
    return {
      status: CONFIRMATION_STATES.DATA_NOT_READY,
      reason: 'Setup atau Quote intraday tidak tersedia',
      candle: null,
      timestamp: now
    };
  }

  const lastPrice = Number(quote.last);
  const openPrice = Number(quote.open);
  const quoteTime = quote.timestamp ? new Date(quote.timestamp).getTime() : null;

  if (isNaN(lastPrice) || lastPrice <= 0 || quoteTime == null || isNaN(quoteTime)) {
    return {
      status: CONFIRMATION_STATES.DATA_NOT_READY,
      reason: 'Harga last atau timestamp quote tidak valid',
      candle: null,
      timestamp: now
    };
  }

  // 2. Ticker identity mismatch — fail-closed BEFORE any price evaluation.
  //    A BBCA setup confirmed against a BBRI quote must never enter the zone.
  const setupTicker = setup.ticker ? String(setup.ticker).trim().toUpperCase() : null;
  const quoteTicker = (quote.ticker || quote.symbol) ? String(quote.ticker || quote.symbol).trim().toUpperCase() : null;
  if (setupTicker && quoteTicker && setupTicker !== quoteTicker) {
    return blocked(
      `Ticker setup (${setupTicker}) tidak cocok dengan ticker quote (${quoteTicker})`,
      { lastPrice, candle: evaluateInterimCandle(openPrice, lastPrice, quote.high, quote.low), timestamp: now, tickerMismatch: true }
    );
  }

  // 3. Delayed / non-realtime price guard — a delayed quote cannot confirm a
  //    live entry zone.
  const delayed = quote.delayed === true || quote.is_delayed === true || String(quote.priceStatus || quote.price_status || '').toUpperCase() === 'DELAYED';
  if (delayed) {
    return blocked(
      'Quote intraday tertunda (delayed price) — tidak dapat mengonfirmasi zona entry realtime',
      { lastPrice, candle: evaluateInterimCandle(openPrice, lastPrice, quote.high, quote.low), timestamp: now, delayed: true }
    );
  }

  // 4. Holiday check — konfirmasi hanya bermakna pada hari bursa.
  if (options.holidaySet && isExchangeHoliday(now, options.holidaySet)) {
    return blocked(
      'Hari ini libur bursa — konfirmasi hourly tidak bermakna',
      { lastPrice, candle: null, timestamp: now, holiday: true }
    );
  }

  // 5. Source / as_of validation — fail-closed: tanpa provenance setup tidak
  //    boleh dikonfirmasi (mencegah konfirmasi atas snapshot tak bertanggal).
  const source = (setup.source || setup.src || '').toString().trim();
  const asOf = (setup.asOf || setup.as_of || '').toString().trim();
  if (!source || !asOf) {
    return blocked(
      `Setup tidak memiliki source/as_of yang lengkap (source=${source || '-'}, as_of=${asOf || '-'})`,
      { lastPrice, candle: null, timestamp: now, provenanceMissing: true }
    );
  }

  // 5b. Stale as_of — snapshot setup yang terlalu tua tidak boleh dikonfirmasi.
  //     Level entry/SL/TP dari EOD lama sudah melewati horizon Short Swing dan
  //     mengonfirmasinya akan mempublikasikan zona beli basi sebagai valid.
  const maxSetupAgeDays = options.maxSetupAgeDays != null
    ? Number(options.maxSetupAgeDays)
    : DEFAULT_MAX_SETUP_AGE_DAYS;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    return blocked(
      `as_of setup tidak dapat diparsing sebagai tanggal (${asOf})`,
      { lastPrice, candle: null, timestamp: now, provenanceInvalid: true }
    );
  }
  const setupAgeDays = (now - asOfMs) / 86400000;
  if (Number.isFinite(maxSetupAgeDays) && maxSetupAgeDays > 0 && setupAgeDays > maxSetupAgeDays) {
    return blocked(
      `Setup basi: as_of ${asOf} berumur ${Math.floor(setupAgeDays)} hari (> ${maxSetupAgeDays} hari) — di luar horizon Short Swing`,
      { lastPrice, candle: null, timestamp: now, staleSetup: true, asOf, setupAgeDays: Number(setupAgeDays.toFixed(2)) }
    );
  }

  // 6. Stale Data Check
  if (now - quoteTime > staleThreshold) {
    return {
      status: CONFIRMATION_STATES.STALE_DATA,
      reason: `Data intraday kadaluarsa (${Math.round((now - quoteTime) / 60000)} menit lalu)`,
      lastPrice,
      quoteTime,
      candle: evaluateInterimCandle(openPrice, lastPrice, quote.high, quote.low),
      timestamp: now
    };
  }

  const entryMin = Number(setup.entryMin);
  const entryMax = Number(setup.entryMax);
  const stopLoss = Number(setup.stopLoss);
  const candle = evaluateInterimCandle(openPrice, lastPrice, quote.high, quote.low);

  // 7. R/R gate — R/R ~0.33 (atau di bawah ambang 1.5) TIDAK boleh menjadi
  //    ENTRY_ZONE_VALID. Fail-closed: R/R tak terhitung juga diblokir.
  const rrCheck = computeHourlyRiskReward(setup);
  if (rrCheck.rr == null || rrCheck.rr < minRr) {
    const rrText = rrCheck.rr == null ? 'tidak dapat divalidasi' : rrCheck.rr.toFixed(2);
    return blocked(
      `R/R setup (${rrText}) gagal memenuhi minimal ${minRr} — tidak layak ENTRY_ZONE_VALID (${rrCheck.reason || 'rr terlalu rendah'})`,
      { lastPrice, rr: rrCheck.rr, candle, timestamp: now }
    );
  }

  // 8. Gap ambiguity — open gapped above the entry zone, then last fell back
  //    inside. A fill inside the zone cannot be assumed real (no lookahead).
  if (Number.isFinite(entryMax) && Number.isFinite(openPrice) && entryMax > 0 &&
      openPrice > entryMax && lastPrice <= entryMax) {
    return blocked(
      `Gap ambigus: open (${openPrice}) melompat di atas max entry (${entryMax}) lalu last (${lastPrice}) kembali ke zona`,
      { lastPrice, entryMax, candle, timestamp: now, gapAmbiguous: true }
    );
  }

  // 9. Setup Invalidated Check (Breakdown below Stop Loss)
  if (!isNaN(stopLoss) && stopLoss > 0 && lastPrice < stopLoss) {
    return {
      status: CONFIRMATION_STATES.SETUP_INVALIDATED,
      reason: `Harga last (${lastPrice}) breakdown menembus Stop Loss (${stopLoss})`,
      lastPrice,
      stopLoss,
      candle,
      timestamp: now
    };
  }

  // 10. Price Above Max Entry Check (Chasing / Over-extended)
  if (!isNaN(entryMax) && entryMax > 0 && lastPrice > entryMax) {
    return {
      status: CONFIRMATION_STATES.PRICE_ABOVE_MAX_ENTRY,
      reason: `Harga last (${lastPrice}) melampaui batas maksimal entry (${entryMax})`,
      lastPrice,
      entryMax,
      candle,
      timestamp: now
    };
  }

  // 11. Entry Zone Valid Check (Harga berada dalam rentang [entryMin, entryMax])
  const inEntryZone = (!isNaN(entryMin) && !isNaN(entryMax))
    ? (lastPrice >= entryMin && lastPrice <= entryMax)
    : false;

  if (inEntryZone) {
    const hasStrongVolume = setup.baseVolume && quote.volume && (quote.volume > setup.baseVolume * 0.5);
    const isBullishCandle = candle.direction === 'BULLISH';

    if (hasStrongVolume && isBullishCandle) {
      return {
        status: CONFIRMATION_STATES.MOMENTUM_STRENGTHENING,
        reason: `Harga (${lastPrice}) di entry zone dengan candle bullish dan volume meningkat`,
        lastPrice,
        entryZone: [entryMin, entryMax],
        rr: rrCheck.rr,
        candle,
        timestamp: now
      };
    }

    return {
      status: CONFIRMATION_STATES.ENTRY_ZONE_VALID,
      reason: `Harga (${lastPrice}) berada di dalam rentang ideal entry [${entryMin} - ${entryMax}]`,
      lastPrice,
      entryZone: [entryMin, entryMax],
      rr: rrCheck.rr,
      candle,
      timestamp: now
    };
  }

  // 12. Near Entry Check (Harga berada sedikit di bawah entryMin, mendekati area beli)
  if (!isNaN(entryMin) && entryMin > 0 && lastPrice < entryMin) {
    const diffPct = ((entryMin - lastPrice) / entryMin) * 100;
    if (diffPct <= nearEntryThresholdPct) {
      return {
        status: CONFIRMATION_STATES.NEAR_ENTRY,
        reason: `Harga (${lastPrice}) mendekati entry zone (${diffPct.toFixed(2)}% di bawah ${entryMin})`,
        lastPrice,
        entryMin,
        diffPct: Number(diffPct.toFixed(2)),
        candle,
        timestamp: now
      };
    }
  }

  // 13. Momentum Strengthening (Di luar kondisi di atas tapi setup masih utuh & volume kuat)
  if (candle.direction === 'BULLISH' && quote.volume && setup.baseVolume && quote.volume > setup.baseVolume * 0.7) {
    return {
      status: CONFIRMATION_STATES.MOMENTUM_STRENGTHENING,
      reason: `Volume intraday signifikan (${quote.volume}) dengan candle hijau`,
      lastPrice,
      candle,
      timestamp: now
    };
  }

  // 14. Default fallback: SETUP_VALID
  return {
    status: CONFIRMATION_STATES.SETUP_VALID,
    reason: `Setup masih terjaga di atas stop loss (${stopLoss || '-'})`,
    lastPrice,
    stopLoss,
    rr: rrCheck.rr,
    candle,
    timestamp: now
  };
}

/**
 * Runner koordinasi konfirmasi per jam untuk daftar watchlist terpilih.
 *
 * Menerapkan Fail-Closed & Guard:
 * 1. Jika ENABLE_HOURLY_CONFIRMATION = false, function LANGSUNG mengembalikan status disabled tanpa aksi I/O.
 * 2. Hanya dijalankan pada jam bursa (cek isMarketOpen).
 * 3. Membatasi universe ke Top 20/Top 5/Watchlist (hard cap: 30 ticker).
 */
async function runHourlyConfirmationCheck({
  snapshots = [],
  quoteFetcher = null,
  now = new Date(),
  forceRun = false // hanya untuk testing offline
} = {}) {
  // Guard 1: Feature Flag
  if (!isFeatureEnabled() && !forceRun) {
    return {
      success: false,
      skipped: true,
      reason: 'Feature flag ENABLE_HOURLY_CONFIRMATION is disabled (OFF by default)',
      processedCount: 0,
      results: []
    };
  }

  // Guard 2: Jam Bursa Resmi (Kecuali forceRun)
  if (!forceRun) {
    const marketOpen = isMarketOpen(now);
    if (!marketOpen) {
      return {
        success: false,
        skipped: true,
        reason: 'Di luar jam bursa resmi BEI atau hari libur',
        processedCount: 0,
        results: []
      };
    }
  }

  // Guard 3: Universe hard cap (Maksimal 30 ticker untuk melindungi kuota data)
  const MAX_TICKERS = 30;
  const targetSnapshots = snapshots.slice(0, MAX_TICKERS);

  if (targetSnapshots.length === 0) {
    return {
      success: true,
      skipped: false,
      reason: 'Tidak ada snapshot ticker yang diberikan',
      processedCount: 0,
      results: []
    };
  }

  if (typeof quoteFetcher !== 'function') {
    return {
      success: false,
      skipped: false,
      reason: 'quoteFetcher function wajib disediakan',
      processedCount: 0,
      results: []
    };
  }

  const results = [];
  for (const item of targetSnapshots) {
    try {
      const quote = await quoteFetcher(item.ticker);
      const evalResult = evaluateHourlyConfirmation(item, quote, { now });
      results.push({
        ticker: item.ticker,
        rank: item.rank || null,
        ...evalResult
      });
    } catch (err) {
      results.push({
        ticker: item.ticker,
        status: CONFIRMATION_STATES.DATA_NOT_READY,
        reason: `Gagal mengambil quote: ${err.message}`,
        candle: null,
        timestamp: now instanceof Date ? now.getTime() : Date.now()
      });
    }
  }

  return {
    success: true,
    skipped: false,
    evaluatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    processedCount: results.length,
    results
  };
}

module.exports = {
  CONFIRMATION_STATES,
  SCHEDULE_TARGETS,
  DEFAULT_STALE_THRESHOLD_MS,
  DEFAULT_MAX_SETUP_AGE_DAYS,
  DEFAULT_NEAR_ENTRY_THRESHOLD_PCT,
  MIN_HOURLY_RR_THRESHOLD,
  isFeatureEnabled,
  evaluateInterimCandle,
  computeHourlyRiskReward,
  evaluateHourlyConfirmation,
  runHourlyConfirmationCheck
};

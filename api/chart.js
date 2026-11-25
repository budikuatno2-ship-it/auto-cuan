'use strict';

/**
 * api/chart.js
 * Endpoint API /api/chart?ticker={TICKER}
 * Menyajikan candle harian aktual yang bersih dari anomali/split error.
 *
 * V6 SUBTASK G — FAIL-CLOSED, NO SYNTHETIC INDEX
 * ---------------------------------------------------------------------------
 * Perilaku LAMA (DIHAPUS): ketika seri IHSG kosong / semua bar < 6000, handler
 * mendorong bar hardcoded
 *   { date:'2026-11-04', open:7460.50, high:7495.80, low:7445.10,
 *     close:7480.25, volume:24500000000 }.
 * Itu adalah ANGKA SINTETIS: bukan data bursa, tidak dapat didistribusikan, dan
 * membuat indeks SELALU tampak segar sehingga konsumen tidak pernah tahu bahwa
 * upstream ^JKSE berhenti menerbitkan bar. Bukti produksi (read-only SSH,
 * 2026-11-11T19:19+07:00): data/daily-candles/IHSG.json di VPS berisi 0 candle,
 * dan stock_daily_history IHSG berhenti di 2026-10-27 close 5266.13 (korup).
 *
 * Perilaku BARU:
 *   - Tidak ada bar sintetis yang pernah disuntikkan di jalur mana pun.
 *   - Setiap respons membawa identitas tanggal eksplisit:
 *       data_status        : 'ok' | 'stale' | 'unavailable'
 *       actual_data_date   : tanggal bar sah terakhir yang benar-benar ada
 *       expected_t1_date   : kandidat sesi selesai sebelumnya (Jakarta)
 *       jakarta_today      : tanggal Jakarta "hari ini"
 *       source_timestamp   : kapan respons ini dibangun
 *   - Bila tidak ada candle sah => success:false + data_status:'unavailable'
 *     (HTTP 200 agar renderer menampilkan "belum tersedia", bukan angka karangan).
 *   - Bila candle ada tetapi lebih tua dari sesi yang diharapkan =>
 *     data_status:'stale' NAMUN candle riil tetap dikembalikan bersama tanggalnya,
 *     sehingga UI dapat melabeli "data per <tanggal>", bukan "hari ini".
 *   - metrics.bandarAccumulation tidak lagi diisi konstanta fabrikasi 1250000000;
 *     endpoint ini tidak menghitung flow bandar, jadi nilainya null (jujur).
 *
 * Canonical SQLite OHLCV is returned unchanged. Price alone cannot establish
 * corporate actions or corruption; no fixed scale/range rule is applied.
 */

const t1Policy = require('../lib/chart-t1-policy');
const {
  isValidIhsgCandle,
  IHSG_MIN_VALID_CLOSE,
  IHSG_MODERN_CUTOFF,
  IHSG_MODERN_MIN_CLOSE,
  IHSG_MODERN_MAX_CLOSE,
  IHSG_HISTORICAL_MIN_CLOSE
} = require('../lib/ihsg-validation');
const { LAST_PROVEN_TRADING_DATE, evaluateDataGovernance } = require('../lib/data-governance-policy');

const { readCandleSeries, readForeignFlowSeries } = require('../lib/local-market-subset-store');

function calcSeriesMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const v = Number(prices[i]);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return Math.round((sum / period) * 100) / 100;
}

function calcSeriesRSI(prices, period) {
  if (!Array.isArray(prices) || prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = Number(prices[i]) - Number(prices[i - 1]);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function normalizeTicker(raw) {
  let ticker = String(raw == null ? '' : raw).toUpperCase().trim().replace(/\.JK$/i, '');
  if (ticker === '^JKSE' || ticker === 'JKSE' || ticker === 'JCI' || ticker === 'COMPOSITE') ticker = 'IHSG';
  return ticker || 'IHSG';
}

function parseTicker(req) {
  if (req && req.query && req.query.ticker) return normalizeTicker(req.query.ticker);
  if (req && req.body && req.body.ticker) return normalizeTicker(req.body.ticker);
  return 'IHSG';
}

/**
 * Inti deterministik endpoint. Membaca SQLite kanonik (flat-file bila DB absen),
 * dan mengklasifikasikan kesegaran. TIDAK PERNAH menciptakan bar.
 *
 * @param {string} ticker
 * @param {Date} now
 * @param {object} [opts] { root }
 * @returns {{statusCode:number, payload:object}}
 */
function buildChartResponse(ticker, now, opts) {
  const options = opts || {};
  const symbol = ticker === 'IHSG' ? '^JKSE' : ticker + '.JK';
  const jakartaToday = t1Policy.formatJakartaDate(now);
  const expectedT1 = t1Policy.previousWeekday(jakartaToday);

  const series = readCandleSeries(ticker, options);

  function unavailable(reason, lastValidDate, statusCode) {
    return {
      statusCode: statusCode || 200,
      payload: {
        success: false,
        ticker,
        symbol,
        data_status: 'unavailable',
        unavailable_reason: reason,
        as_of: lastValidDate || null,
        actual_data_date: null,
        last_valid_date: lastValidDate || null,
        jakarta_today: jakartaToday,
        expected_t1_date: expectedT1,
        source_timestamp: now.toISOString(),
        total_candles: 0,
        candles: [],
        metrics: { support: null, trend: null, bandarAccumulation: null },
        error: 'Data candle tidak tersedia (fail-closed, tanpa angka sintetis).'
      }
    };
  }

  if (!series.source) return unavailable('no_storage_file', null, 404);
  // OHLCV remains exactly as stored. No inferred split, range or replacement.
  const cutoff = t1Policy.retainCompletedCandles(series.candles, now, {
    allowTodayAfterClose: series.source === 'sqlite_market_rows'
  });
  const clean = cutoff.candles;

  // Semua bar habis tersaring / berkas kosong => UNAVAILABLE dengan tanggal sah
  // terakhir (bila pernah ada). TIDAK ada bar pengganti.
  if (clean.length === 0) {
    return unavailable('no_valid_candle_after_guard', null, 200);
  }

  const last = clean[clean.length - 1];
  const actualDataDate = last.time;
  const meta = t1Policy.buildMetadata(actualDataDate, now);
  const isStale = meta.t1_status === 'stale' || (expectedT1 && actualDataDate < expectedT1);
  // KASUS KECIL (TAHAP 1, 2026-11-19): `data_status` dan `data_governance.status`
  // kini memakai huruf kecil agar konsisten dengan `t1_status` yang sudah huruf
  // kecil. Nilai & makna tidak berubah - hanya casing.
  const dataStatus = isStale ? 'stale' : 'ok';

  const refIndex = Math.max(0, clean.length - 20);
  const closePrices = clean.map((k) => Number(k.close));
  const ma20 = calcSeriesMA(closePrices, 20);
  const ma50 = calcSeriesMA(closePrices, 50);
  const ma100 = calcSeriesMA(closePrices, 100);
  const ma200 = calcSeriesMA(closePrices, 200);
  const rsi14 = calcSeriesRSI(closePrices, 14);
  const win20 = clean.slice(-20);
  const support20 = Math.round(Math.min(...win20.map((k) => Number(k.low != null ? k.low : k.close))));
  const trend = ma20 != null
    ? (Number(last.close) >= ma20 ? 'Bullish (Di atas MA20)' : 'Bearish (Di bawah MA20)')
    : (Number(last.close) >= Number(clean[refIndex].close) ? 'UPTREND' : 'DOWNTREND');
  let foreignFlow = [];
  if (ticker !== 'IHSG') {
    try {
      foreignFlow = readForeignFlowSeries(ticker, { asOf: options.asOf || null });
    } catch (_) {
      foreignFlow = [];
    }
  }
  const latestFf = foreignFlow.length ? foreignFlow[foreignFlow.length - 1] : null;
  const bandarAccumulation = latestFf && latestFf.foreign_net != null && Number.isFinite(Number(latestFf.foreign_net))
    ? Number(latestFf.foreign_net)
    : null;

  return {
    statusCode: 200,
    payload: {
      success: true,
      source: series.source,
      ticker,
      symbol,
      data_status: dataStatus,
      as_of: actualDataDate,
      actual_data_date: actualDataDate,
      last_valid_date: actualDataDate,
      expected_t1_date: expectedT1,
      jakarta_today: jakartaToday,
      source_timestamp: now.toISOString(),
      t1_status: meta.t1_status,
      data_governance: evaluateDataGovernance(actualDataDate, now),
      total_candles: clean.length,
      latest: {
        date: actualDataDate,
        last: Number(last.close),
        close: Number(last.close),
        open: Number(last.open),
        high: Number(last.high),
        low: Number(last.low),
        volume: last.volume,
        provenance: last.provenance
      },
      candles: clean.map((k) => ({
        time: k.time,
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        close: Number(k.close),
        volume: k.volume,
        provenance: k.provenance
      })),
      foreignFlow,
      metrics: {
        support: support20,
        trend,
        ma20,
        ma50,
        ma100,
        ma200,
        rsi14,
        bandarAccumulation
      }
    }
  };
}

module.exports = async function handler(req, res) {
  const now = new Date();
  try {
    const ticker = parseTicker(req);
    const { statusCode, payload } = buildChartResponse(ticker, now, {
      asOf: (req.query && req.query.as_of) || (req.body && req.body.as_of)
    });
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(JSON.stringify(payload));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      success: false,
      data_status: 'unavailable',
      unavailable_reason: 'internal_error',
      actual_data_date: null,
      source_timestamp: now.toISOString(),
      candles: [],
      error: 'Internal Server Error'
    }));
  }
};

// Diekspos agar test & tool audit memanggil FUNGSI NYATA (bukan HTTP, bukan
// string-matching sumber).
module.exports.buildChartResponse = buildChartResponse;
module.exports.parseTicker = parseTicker;
module.exports.normalizeTicker = normalizeTicker;
module.exports.isValidIhsgCandle = isValidIhsgCandle;
module.exports.IHSG_MIN_VALID_CLOSE = IHSG_MIN_VALID_CLOSE;
module.exports.IHSG_MODERN_CUTOFF = IHSG_MODERN_CUTOFF;
module.exports.IHSG_MODERN_MIN_CLOSE = IHSG_MODERN_MIN_CLOSE;
module.exports.IHSG_MODERN_MAX_CLOSE = IHSG_MODERN_MAX_CLOSE;
module.exports.IHSG_HISTORICAL_MIN_CLOSE = IHSG_HISTORICAL_MIN_CLOSE;
module.exports.LAST_PROVEN_TRADING_DATE = LAST_PROVEN_TRADING_DATE;
module.exports.evaluateDataGovernance = evaluateDataGovernance;

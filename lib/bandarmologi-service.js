'use strict';

/**
 * Bandarmologi & Insider Service
 * Combines local disk cache (arjum-data/), in-memory cache, and Arjum API Client.
 */

const fs = require('fs');
const path = require('path');
const arjumClient = require('./arjum-client');

const MEMORY_CACHE = new Map();
const MEMORY_TTL_MS = 5 * 60 * 1000;
const CACHE_VERSION = 'bandarmologi-v2';

// `a || b || []` does NOT fall back past an empty array — `[]` is truthy in
// JS — so `raw.gross_sellers || raw.top_sellers || []` silently kept an
// empty gross_sellers field from Arjum's own response and discarded a
// populated top_sellers, even though both ultimately feed the same
// top_sellers/gross_sellers fields in the object this module returns. This
// was the root cause of the "Semua" (all) flow bubble view showing every
// broker as BUY with zero sellers, even for tickers with real sell-side
// data (visible in each broker's own detail card, which reads bval/sval
// directly off the item rather than through this list).
function firstNonEmptyArray() {
  for (let i = 0; i < arguments.length; i++) {
    if (Array.isArray(arguments[i]) && arguments[i].length > 0) return arguments[i];
  }
  return [];
}

/**
 * AUDIT-F4-10/11/12: feed broker summary Arjum & VPS dapat mengirim angka
 * sebagai string — plain ("1500000000"), ribuan bertitik Indonesia
 * ("1.500.000.000"), ribuan berkoma ("1,500,000,000"), atau berdesimal koma
 * ("1500,25"). `Number()` mentah mengembalikan NaN untuk semuanya kecuali
 * bentuk plain, yang membuat nilai rupiah hilang (NaN) atau kolaps menjadi 0.
 * Helper ini menormalkan seluruh bentuk tersebut ke Number; nilai yang benar-
 * benar tidak dapat diurai dikembalikan sebagai null supaya pemanggil bisa
 * memilih default 0 secara eksplisit (bukan diam-diam menghasilkan NaN).
 */
function toNumberLoose(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;

  let s = value.trim();
  if (!s || s === '-' || s === '—' || s === '–') return null;

  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/^\(/, '').replace(/\)$/, '');
  s = s.replace(/[Rprp](?=[\s.\d,])/g, '').replace(/[%+\s]/g, '');
  if (!s) return null;

  const hasDot = s.indexOf('.') >= 0;
  const hasComma = s.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    // Separator desimal adalah yang muncul paling akhir.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // "1,500,000" => ribuan; "1500,25" => desimal koma Indonesia.
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (hasDot) {
    // "1.500.000" / "1.500" => ribuan Indonesia; "1500.25" => desimal.
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }

  s = s.replace(/[^\d.eE+-]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative && n > 0 ? -n : n;
}

function getStorageDir() {
  const configured = process.env.ARJUM_DATA_DIR;
  if (configured && fs.existsSync(configured)) return configured;
  const defaultLocal = path.join(__dirname, '..', 'data', 'arjum-data');
  return defaultLocal;
}

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getCache(key) {
  const item = MEMORY_CACHE.get(key);
  if (!item || item.version !== CACHE_VERSION || !item.data) {
    if (item) MEMORY_CACHE.delete(key);
    return null;
  }
  if (!Number.isFinite(item.expiresAt) || Date.now() >= item.expiresAt) {
    MEMORY_CACHE.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttlMs = MEMORY_TTL_MS) {
  if (!data || typeof data !== 'object') return;
  const boundedTtl = Number.isFinite(ttlMs) ? Math.max(1000, Math.min(ttlMs, 15 * 60 * 1000)) : MEMORY_TTL_MS;
  if (MEMORY_CACHE.size > 300) {
    const oldestKey = MEMORY_CACHE.keys().next().value;
    MEMORY_CACHE.delete(oldestKey);
  }
  MEMORY_CACHE.set(key, {
    version: CACHE_VERSION,
    data,
    expiresAt: Date.now() + boundedTtl
  });
}

function versionedCacheKey(parts) {
  return [CACHE_VERSION].concat(parts || []).map(value => String(value == null ? '' : value)).join('|');
}

/**
 * Read from disk cache if exists
 */
function readDiskCache(endpoint, ticker, identifier = 'latest') {
  try {
    const baseDir = getStorageDir();
    const targetDir = path.join(baseDir, endpoint, ticker);
    if (!fs.existsSync(targetDir)) return null;

    if (identifier && identifier !== 'latest') {
      const filePath = path.join(targetDir, `${identifier}.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
      const latestPath = path.join(targetDir, 'latest.json');
      if (fs.existsSync(latestPath)) {
        try {
          const latestData = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
          if (latestData && (latestData.date === identifier || latestData.broker_start_date === identifier)) {
            return latestData;
          }
        } catch (_) {}
      }
      // Explicit identifier requested (e.g. date) but does not exist:
      // MUST return null, do NOT fallback to latest or other dates
      return null;
    }

    // Only fallback when no specific date was requested (e.g. 'latest' or omitted)
    const latestPath = path.join(targetDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      return JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    }

    // Fallback: pick newest dated file
    const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
    if (files.length > 0) {
      const newestPath = path.join(targetDir, files[0]);
      return JSON.parse(fs.readFileSync(newestPath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function hasDiskCache(endpoint, ticker, identifier = 'latest') {
  try {
    const baseDir = getStorageDir();
    const targetDir = path.join(baseDir, endpoint, ticker);
    if (!fs.existsSync(targetDir)) return false;
    if (identifier && identifier !== 'latest') {
      if (fs.existsSync(path.join(targetDir, `${identifier}.json`))) return true;
      const latestPath = path.join(targetDir, 'latest.json');
      if (fs.existsSync(latestPath)) {
        try {
          const latestData = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
          if (latestData && (latestData.date === identifier || latestData.broker_start_date === identifier)) return true;
        } catch (_) {}
      }
      return false;
    }
    const latestPath = path.join(targetDir, 'latest.json');
    if (fs.existsSync(latestPath)) return true;
    const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && f !== 'latest.json');
    return files.length > 0;
  } catch (_) {
    return false;
  }
}

function listDiskDates(endpoint, ticker) {
  try {
    const baseDir = getStorageDir();
    const targetDir = path.join(baseDir, endpoint, ticker);
    if (!fs.existsSync(targetDir)) return [];
    const dateFiles = fs.readdirSync(targetDir)
      .filter(f => f.endsWith('.json') && f !== 'latest.json')
      .map(f => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
    if (dateFiles.length === 0 && fs.existsSync(path.join(targetDir, 'latest.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(targetDir, 'latest.json'), 'utf8'));
        if (raw && (raw.date || raw.broker_start_date)) {
          return [raw.date || raw.broker_start_date];
        }
      } catch (_) {}
    }
    return dateFiles;
  } catch (_) {
    return [];
  }
}

/**
 * Write to disk cache
 */
function writeDiskCache(endpoint, ticker, identifier, data) {
  try {
    const baseDir = getStorageDir();
    const targetDir = path.join(baseDir, endpoint, ticker);
    ensureDirExists(targetDir);
    const filePath = path.join(targetDir, `${identifier}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

const idxTradingCalendar = require('./idx-trading-calendar');

function getJakartaDateInfo() {
  const now = new Date();
  const jktStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
  const jktDate = new Date(jktStr);
  const hour = jktDate.getHours();
  const dateKey = idxTradingCalendar.toDateKey(jktDate);
  return { now: jktDate, hour, dateKey };
}

function getEffectiveTradingDate(ticker = null, inputDate = null) {
  const { hour, dateKey: currentJktKey } = getJakartaDateInfo();
  let targetKey = inputDate ? idxTradingCalendar.toDateKey(inputDate) : currentJktKey;

  if (ticker) {
    const dates = listDiskDates('broker-summary', ticker);
    if (dates.length > 0) {
      if (!inputDate && dates.includes(currentJktKey) && hour >= 18) {
        return currentJktKey;
      }
      if (inputDate && dates.includes(targetKey)) {
        return targetKey;
      }
      return dates[0];
    }
  }

  // If target date is a weekend or holiday, fallback to latest previous trading day.
  // Never invent a hardcoded date: if no previous trading day can be resolved,
  // return null so the caller surfaces an explicit "tanggal belum tersedia"
  // status instead of presenting a stale literal as the effective session.
  if (!idxTradingCalendar.isTradingDay(targetKey)) {
    const prevTrading = idxTradingCalendar.previousTradingDay(targetKey);
    return prevTrading || null;
  }

  // For current day before 18:00 WIB, market session summary is not yet published:
  // Fall back to previous completed trading day. No static fallback — null
  // propagates as the DATE_UNRESOLVED signal.
  if (!inputDate && hour < 18) {
    const prev = idxTradingCalendar.previousTradingDay(currentJktKey);
    return prev || null;
  }

  return targetKey;
}

function getDynamicTradingDays(count = 10) {
  try {
    const effectiveDate = getEffectiveTradingDate();
    const dates = idxTradingCalendar.getLastTradingDays(effectiveDate, count);
    if (dates && dates.length > 0) return dates;
  } catch (_) {}
  // Never fabricate a static series of dates: return an empty list so callers
  // render an explicit "tanggal belum tersedia" message rather than presenting
  // hardcoded stale keys as live session headers.
  return [];
}

// PR4: baseline sanity prices per ticker. These activate the anti-outlier guard
// in bandarmologi-intel-service.getCachedClosePrice (a candle deviating >35%
// from the baseline is rejected). Empty before this change, so the guard was a
// no-op and a stale 2026-07-17 candle could flow straight through as "current".
// Values are the volume-weighted average buy price across all brokers on the
// latest broker-summary day (resolved dynamically via
// getEffectiveTradingDate(); see Batch 6 F-068 in FULL_REPO_FIX_LOG.md) — a
// close-enough price anchor, not a quote. They only need to be within ~35%
// of the true price for the guard.
const KNOWN_TICKER_PRICES = Object.freeze({
  BBCA: 6471,
  BBRI: 4200,
  BMRI: 6000,
  BBNI: 4500,
  TLKM: 2800,
  ASII: 5000,
  CUAN: 1001,
  PTRO: 5627,
  GOTO: 50,
  ICBP: 11000,
  RAJA: 2500
});

function normalizeVwapPrice(raw, refPrice) {
  raw = Number(raw || 0);
  if (!raw || !isFinite(raw) || raw <= 0) return 0;
  refPrice = Number(refPrice || 0);

  if (refPrice > 0 && isFinite(refPrice)) {
    var rawDiv100 = raw / 100;
    var rawMul100 = raw * 100;
    var diffRaw = Math.abs(raw - refPrice);
    var diffDiv = Math.abs(rawDiv100 - refPrice);
    var diffMul = Math.abs(rawMul100 - refPrice);

    if (diffDiv < diffRaw && diffDiv <= diffMul) {
      return Math.round(rawDiv100);
    }
    if (diffMul < diffRaw && diffMul < diffDiv) {
      return Math.round(rawMul100);
    }
    return Math.round(raw);
  }

  // Fallback when refPrice is unknown
  // Di BEI, jika raw > 100.000 (misal Rp 950.000 untuk saham Rp 9.500),
  // nilai tersebut adalah Rp/lot (1 lot = 100 lembar), sehingga dinormalisasi ke harga lembar (/ 100).
  // DILARANG membagi harga wajar saham biasa (Rp 50 s/d 50.000) dengan 100 karena akan merusak harga asli.
  if (raw > 100000 && Math.round(raw / 100) >= 1) {
    return Math.round(raw / 100);
  }
  return Math.round(raw);
}

function getReferencePrice(ticker) {
  const clean = String(ticker || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (!clean) return 0;

  // 1. Authoritative live price from VPS fetcher
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    if (vpsFetcher && typeof vpsFetcher.fetchLivePriceFromVpsSync === 'function') {
      const live = vpsFetcher.fetchLivePriceFromVpsSync(clean);
      if (live && live.price > 0) {
        return Math.round(Number(live.price));
      }
    }
  } catch (_) {}

  // 2. Try reading freshest closing price from daytrade OHLCV cache (must be fresh, not ancient data)
  try {
    const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`);
    if (fs.existsSync(ohlcvPath)) {
      const data = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const candles = data && data.candles;
      if (Array.isArray(candles) && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        // Freshness gate is anchored on the dynamically resolved effective
        // trading day (T-1 / current session boundary from
        // idx-trading-calendar.previousTradingDay), NOT a hardcoded cutoff
        // date — see Batch 6 F-043 in FULL_REPO_FIX_LOG.md.
        let freshnessFloor = null;
        try {
          const { dateKey: refKey } = getJakartaDateInfo();
          freshnessFloor = idxTradingCalendar.previousTradingDay(refKey, undefined, { maxLookback: 60 });
          if (!freshnessFloor) freshnessFloor = idxTradingCalendar.addDaysToKey(refKey, -7);
        } catch (_) {}
        const isFresh = lastCandle && lastCandle.date && freshnessFloor && String(lastCandle.date) >= freshnessFloor;
        if (isFresh && Number(lastCandle.close) > 0) {
          return Math.round(Number(lastCandle.close));
        }
      }
    }
  } catch (_) {}

  // 2. Try extracting VWAP from disk broker summary if available
  try {
    const dates = listDiskDates('broker-summary', clean);
    if (dates && dates.length > 0) {
      const raw = readDiskCache('broker-summary', clean, dates[0]);
      if (raw && Array.isArray(raw.brokers) && raw.brokers.length > 0) {
        let totalVal = 0;
        let totalVol = 0;
        for (const b of raw.brokers) {
          totalVal += Number(b.bval || 0);
          totalVol += Number(b.bvol || 0);
        }
        if (totalVal > 0 && totalVol > 0) {
          let vwap = normalizeVwapPrice(totalVal / totalVol, 0);
          if (vwap > 0) return vwap;
        }
      }
    }
  } catch (_) {}

  // Zero/unavailable when authentic data is not found — zero hallucinations
  return 0;
}

const BUYER_BROKERS = [
  { code: 'YP', name: 'Mirae Asset Sekuritas Indonesia' },
  { code: 'CC', name: 'Mandiri Sekuritas' },
  { code: 'BK', name: 'J.P. Morgan Sekuritas Indonesia' },
  { code: 'AK', name: 'UBS Sekuritas Indonesia' },
  { code: 'PD', name: 'Indo Premier Sekuritas' },
  { code: 'KZ', name: 'CLSA Sekuritas Indonesia' },
  { code: 'ZP', name: 'Maybank Sekuritas Indonesia' },
  { code: 'RX', name: 'Macquarie Sekuritas Indonesia' },
  { code: 'DR', name: 'RHB Sekuritas Indonesia' },
  { code: 'AI', name: 'UOB Kay Hian Sekuritas' },
  { code: 'SQ', name: 'BCA Sekuritas' },
  { code: 'OD', name: 'BRI Danareksa Sekuritas' },
  { code: 'LG', name: 'Trimegah Sekuritas Indonesia' },
  { code: 'KI', name: 'Ciptadana Sekuritas Asia' },
  { code: 'YU', name: 'CGS International Sekuritas' },
  { code: 'FS', name: 'Yuanta Sekuritas Indonesia' },
  { code: 'BQ', name: 'Korea Investment and Sekuritas' },
  { code: 'DH', name: 'Sinarmas Sekuritas' },
  { code: 'AZ', name: 'Sucor Sekuritas' },
  { code: 'EP', name: 'MNC Sekuritas' },
  { code: 'HD', name: 'KGI Sekuritas Indonesia' },
  { code: 'AN', name: 'Wanteg Sekuritas' },
  { code: 'RG', name: 'Profindo Sekuritas Indonesia' },
  { code: 'IF', name: 'Samuel Sekuritas Indonesia' },
  { code: 'CD', name: 'Mega Capital Sekuritas' }
];

const SELLER_BROKERS = [
  { code: 'XC', name: 'Ajaib Sekuritas Asia' },
  { code: 'NI', name: 'BNI Sekuritas' },
  { code: 'CP', name: 'KB Valbury Sekuritas' },
  { code: 'GR', name: 'Panin Sekuritas' },
  { code: 'MG', name: 'Semesta Indovest Sekuritas' },
  { code: 'KK', name: 'Phillip Sekuritas Indonesia' },
  { code: 'XL', name: 'Stockbit Sekuritas' },
  { code: 'AT', name: 'Phintraco Sekuritas' },
  { code: 'LS', name: 'Reliance Sekuritas Indonesia' },
  { code: 'DP', name: 'DBS Vickers Sekuritas' },
  { code: 'IN', name: 'Investindo Nusantara Sekuritas' },
  { code: 'AH', name: 'Shinhan Sekuritas Indonesia' },
  { code: 'AG', name: 'Kiwoom Sekuritas Indonesia' },
  { code: 'AO', name: 'ERDIKHA Elit Sekuritas' },
  { code: 'AP', name: 'Pacific Sekuritas Indonesia' },
  { code: 'AR', name: 'Binaartha Sekuritas' },
  { code: 'BD', name: 'Kresna Sekuritas' },
  { code: 'BF', name: 'Inti Fikasa Sekuritas' },
  { code: 'GA', name: 'Surya Fajar Sekuritas' },
  { code: 'HP', name: 'Henan Putihrai Sekuritas' },
  { code: 'IC', name: 'Victoria Sekuritas Indonesia' },
  { code: 'ID', name: 'Anugerah Sekuritas Indonesia' },
  { code: 'IT', name: 'Pilarmas Investindo Sekuritas' },
  { code: 'KS', name: 'Karta Rajasa Sekuritas' },
  { code: 'LH', name: 'Royal Investium Sekuritas' }
];

/**
 * Official empty schema when local cache or API data is not present
 */
function generateDemoData() {
  return { is_empty: true, status: 'NO_DATA', gross_buyers: [], gross_sellers: [], top_buyers: [], top_sellers: [] };
}


function enrichBrokerItem(item, isBuyer, refPrice) {
  if (!item) return null;
  // AUDIT-F4-11: seluruh pembacaan numerik memakai toNumberLoose() supaya feed
  // string numerik (ribuan bertitik/koma) tidak berubah menjadi 0 / NaN.
  const pick = (...candidates) => {
    for (const c of candidates) {
      const n = toNumberLoose(c);
      if (n != null) return n;
    }
    return 0;
  };
  const rawNet = item.nval != null ? toNumberLoose(item.nval) : (item.net_val != null ? toNumberLoose(item.net_val) : null);
  let bval = 0;
  let sval = 0;
  if (isBuyer) {
    bval = pick(item.bval, item.buy_val, item.val, item.value);
    sval = pick(item.sval, item.sell_val);
  } else {
    sval = pick(item.sval, item.sell_val, item.val, item.value);
    bval = pick(item.bval, item.buy_val);
  }
  let bvol = 0;
  let svol = 0;
  const rawNetVol = item.nvol != null ? toNumberLoose(item.nvol) : (item.net_vol != null ? toNumberLoose(item.net_vol) : null);
  if (isBuyer) {
    bvol = pick(item.bvol, item.buy_vol, item.vol, item.volume);
    svol = pick(item.svol, item.sell_vol);
  } else {
    svol = pick(item.svol, item.sell_vol, item.vol, item.volume);
    bvol = pick(item.bvol, item.buy_vol);
  }
  const bfrq = pick(item.bfrq);
  const sfrq = pick(item.sfrq);

  // Sanitize 100x multiplier artifacts (e.g. single broker transactions in Trillions or price per share > 200k)
  if (bval >= 5e11 || (bvol > 0 && Math.abs(bval / (bvol * 100)) > 200000)) {
    bval = Math.round(bval / 100);
  }
  if (sval >= 5e11 || (svol > 0 && Math.abs(sval / (svol * 100)) > 200000)) {
    sval = Math.round(sval / 100);
  }

  let nval;
  if (item.nval != null) {
    nval = Number(item.nval);
  } else if (item.net_val != null) {
    nval = Number(item.net_val);
  } else if (rawNet != null) {
    nval = rawNet;
  } else {
    nval = bval - sval;
  }
  if (Math.abs(nval) >= 5e11) {
    nval = Math.round(nval / 100);
  }
  if (!isBuyer && nval > 0 && (sval > bval || bval === 0)) {
    nval = -Math.abs(nval);
  }

  let nvol;
  if (item.nvol != null) {
    nvol = Number(item.nvol);
  } else if (item.net_vol != null) {
    nvol = Number(item.net_vol);
  } else if (rawNetVol != null) {
    nvol = rawNetVol;
  } else {
    nvol = bvol - svol;
  }
  if (!isBuyer && nvol > 0 && (svol > bvol || bvol === 0)) {
    nvol = -Math.abs(nvol);
  }

  // Pure Gross Buy / Sell VWAP calculation (strictly avoids net_val / net_vol churning bug)
  let avgBuy = 0;
  if (item.buy_avg_price || item.bavg || item.avg_buy) {
    avgBuy = normalizeVwapPrice(item.buy_avg_price || item.bavg || item.avg_buy, refPrice);
  } else if (bval > 0 && bvol > 0) {
    avgBuy = normalizeVwapPrice(bval / bvol, refPrice);
  }

  let avgSell = 0;
  if (item.sell_avg_price || item.savg || item.avg_sell) {
    avgSell = normalizeVwapPrice(item.sell_avg_price || item.savg || item.avg_sell, refPrice);
  } else if (sval > 0 && svol > 0) {
    avgSell = normalizeVwapPrice(sval / svol, refPrice);
  }

  let avgPrice = 0;
  if (isBuyer) {
    avgPrice = avgBuy || (item.avg_price ? normalizeVwapPrice(item.avg_price, refPrice) : 0);
  } else {
    avgPrice = avgSell || (item.avg_price ? normalizeVwapPrice(item.avg_price, refPrice) : 0);
  }

  return {
    broker: item.broker || item.broker_code || '',
    broker_name: item.broker_name || '',
    bval,
    sval,
    bvol,
    svol,
    bfrq,
    sfrq,
    nval,
    nvol,
    avg_price: avgPrice,
    avg_buy: avgBuy,
    avg_sell: avgSell,
    buy_avg_price: avgBuy,
    sell_avg_price: avgSell,
    buy_val: bval,
    buy_vol: bvol,
    sell_val: sval,
    sell_vol: svol,
    net_val: nval,
    net_vol: nvol
  };
}

function normalizeBrokerSummary(raw, date, ticker) {
  if (!raw || (!raw.brokers && !raw.top_buyers && !raw.broker_levels && !raw.gross_buyers && !raw.buyers && !raw.sellers && !raw.top_sellers && !raw.gross_sellers && !raw.net_buyers && !raw.net_sellers)) return null;

  const cleanTicker = String(ticker || raw.stock_code || raw.ticker || raw.symbol || '').toUpperCase().trim();
  const refPrice = cleanTicker ? getReferencePrice(cleanTicker) : 0;

  function getBrokerPrice(val, vol, givenAvg) {
    // AUDIT-F4-10: avg price juga dapat datang sebagai string numerik.
    const given = toNumberLoose(givenAvg);
    if (given != null && given > 0) return normalizeVwapPrice(given, refPrice);
    val = toNumberLoose(val);
    vol = toNumberLoose(vol);
    if (!val || !vol || vol <= 0) return 0;
    const ratio = val / vol;
    return normalizeVwapPrice(ratio, refPrice);
  }

  function parseBrokerRow(b, isBuyerDefault) {
    if (!b) return null;
    const code = b.broker_code || b.broker || b.code || '';
    const name = b.broker_name || b.name || '';
    const pick = (...candidates) => {
      for (const c of candidates) {
        const n = toNumberLoose(c);
        if (n != null) return n;
      }
      return 0;
    };
    // AUDIT-F4-12: apakah baris ini membawa data angka sama sekali? Broker
    // tanpa nilai apa pun tetap sah sebagai IDENTITAS (feed kadang hanya
    // mengirim daftar kode), tetapi magnitudonya tidak boleh dikarang.
    const hasValueData = [
      b.bval, b.buy_val, b.sval, b.sell_val, b.val, b.value,
      b.bvol, b.buy_vol, b.svol, b.sell_vol, b.vol, b.volume,
      b.nval, b.net_val, b.nvol, b.net_vol
    ].some(v => toNumberLoose(v) != null);
    let bval = pick(b.bval, b.buy_val, isBuyerDefault ? b.val : null);
    let sval = pick(b.sval, b.sell_val, !isBuyerDefault ? b.val : null);
    let bvol = pick(b.bvol, b.buy_vol, isBuyerDefault ? b.vol : null);
    let svol = pick(b.svol, b.sell_vol, !isBuyerDefault ? b.vol : null);
    let nval = b.nval != null ? toNumberLoose(b.nval) : (b.net_val != null ? toNumberLoose(b.net_val) : null);
    let nvol = b.nvol != null ? toNumberLoose(b.nvol) : (b.net_vol != null ? toNumberLoose(b.net_vol) : null);

    if (nval == null) {
      if (bval > 0 || sval > 0) {
        nval = bval - sval;
      } else if (!hasValueData) {
        // AUDIT-F4-12: baris tanpa data angka sama sekali. `|| 1` dulu membuat
        // hari kosong berubah menjadi net -1 (penjual hantu) sehingga status
        // terbaca BIG_DISTRIBUTION. Net flow tetap 0, namun magnitudo volume
        // dipertahankan sebesar 0 juga — identitas broker tidak dikarang.
        nval = 0;
      } else if (isBuyerDefault) {
        nval = bval || bvol;
      } else {
        nval = -(sval || svol);
      }
    }
    if (nvol == null) {
      if (bvol > 0 || svol > 0) {
        nvol = bvol - svol;
      } else if (isBuyerDefault) {
        nvol = bvol;
      } else {
        nvol = -svol;
      }
    }
    if (bval === 0 && sval === 0 && nval !== 0) {
      if (nval > 0) bval = nval;
      else sval = Math.abs(nval);
    }
    if (bvol === 0 && svol === 0 && nvol !== 0) {
      if (nvol > 0) bvol = nvol;
      else svol = Math.abs(nvol);
    }

    const avgPrice = getBrokerPrice(
      bval || Math.abs(nval),
      bvol || Math.abs(nvol),
      b.avg_price || (isBuyerDefault ? (b.avg_buy || b.bavg) : (b.avg_sell || b.savg))
    );

    return {
      broker: code,
      broker_name: name,
      bval,
      bvol,
      buy_val: bval,
      buy_vol: bvol,
      sval,
      svol,
      sell_val: sval,
      sell_vol: svol,
      nval,
      net_val: nval,
      nvol,
      net_vol: nvol,
      bfrq: pick(b.bfrq),
      sfrq: pick(b.sfrq),
      avg_price: avgPrice,
      avg_buy: toNumberLoose(b.avg_buy) || (isBuyerDefault ? avgPrice : 0),
      avg_sell: toNumberLoose(b.avg_sell) || (!isBuyerDefault ? avgPrice : 0)
    };
  }

  let gross_buyers = [];
  let gross_sellers = [];
  let top_buyers = [];
  let top_sellers = [];
  let brokers = [];

  if (Array.isArray(raw.brokers) && raw.brokers.length > 0) {
    // 1. Unified brokers array (e.g. daily real bursa files)
    brokers = raw.brokers.map(b => parseBrokerRow(b, (b.nval != null ? Number(b.nval) : ((b.bval || 0) - (b.sval || 0))) >= 0)).filter(Boolean);

    gross_buyers = brokers
      .filter(b => (b.bval || b.buy_val || 0) > 0 || (b.bvol || b.buy_vol || 0) > 0)
      .sort((a, b) => (b.bval - a.bval) || (b.bvol - a.bvol));

    gross_sellers = brokers
      .filter(b => (b.sval || b.sell_val || 0) > 0 || (b.svol || b.sell_vol || 0) > 0)
      .sort((a, b) => (b.sval - a.sval) || (b.svol - a.svol));

    top_buyers = brokers
      .filter(b => (b.nval != null ? b.nval : (b.bval - b.sval)) > 0)
      .sort((a, b) => b.net_val - a.net_val);

    top_sellers = brokers
      .filter(b => (b.nval != null ? b.nval : (b.bval - b.sval)) < 0)
      .sort((a, b) => a.net_val - b.net_val);
  } else if (Array.isArray(raw.broker_levels) && raw.broker_levels.length > 0) {
    // 2. Broker levels shape
    const rawBuyers = [];
    const rawSellers = [];
    for (const lvl of raw.broker_levels) {
      if (lvl.buy && lvl.buy.broker_code) {
        rawBuyers.push({
          broker_code: lvl.buy.broker_code,
          broker_name: lvl.buy.broker_name || '',
          bval: Number(lvl.buy.bval || 0),
          bvol: Number(lvl.buy.bvol || 0),
          bfrq: Number(lvl.buy.bfrq || 0),
          bavg: Number(lvl.buy.bavg || 0)
        });
      }
      if (lvl.sell && lvl.sell.broker_code) {
        rawSellers.push({
          broker_code: lvl.sell.broker_code,
          broker_name: lvl.sell.broker_name || '',
          sval: Number(lvl.sell.sval || 0),
          svol: Number(lvl.sell.svol || 0),
          sfrq: Number(lvl.sell.sfrq || 0),
          savg: Number(lvl.sell.savg || 0)
        });
      }
    }
    gross_buyers = rawBuyers.map(b => parseBrokerRow(b, true)).filter(Boolean);
    gross_sellers = rawSellers.map(s => parseBrokerRow(s, false)).filter(Boolean);
    top_buyers = gross_buyers.slice();
    top_sellers = gross_sellers.map(s => {
      const row = { ...s };
      // AUDIT-F4-12: hapus phantom `|| 1` — baris tanpa nilai tidak boleh
      // berubah menjadi penjual dengan net -1.
      row.net_val = -Math.abs(row.sval);
      row.nval = row.net_val;
      return row;
    });
    const bMap = new Map();
    gross_buyers.forEach(b => bMap.set(b.broker, b));
    gross_sellers.forEach(s => {
      if (bMap.has(s.broker)) {
        const existing = bMap.get(s.broker);
        existing.sval = s.sval;
        existing.svol = s.svol;
        existing.sell_val = s.sval;
        existing.sell_vol = s.svol;
        existing.nval = existing.bval - s.sval;
        existing.net_val = existing.nval;
      } else {
        bMap.set(s.broker, s);
      }
    });
    brokers = Array.from(bMap.values());
  } else {
    // 3. Separate / partitioned lists (e.g. Arjum API, tests)
    const rawBuyers = firstNonEmptyArray(raw.gross_buyers, raw.top_buyers, raw.buyers);
    const rawSellers = firstNonEmptyArray(raw.gross_sellers, raw.top_sellers, raw.sellers);
    const rawNetBuyers = firstNonEmptyArray(raw.net_buyers);
    const rawNetSellers = firstNonEmptyArray(raw.net_sellers);

    if (rawBuyers.length > 0) {
      const hasRealBval = rawBuyers.some(b => toNumberLoose(b.bval != null ? b.bval : b.buy_val) > 0);
      gross_buyers = rawBuyers.map(b => parseBrokerRow(b, true)).filter(Boolean);
      if (hasRealBval) {
        gross_buyers.sort((a, b) => b.bval - a.bval);
      }
    }
    if (rawSellers.length > 0) {
      const hasRealSval = rawSellers.some(s => toNumberLoose(s.sval != null ? s.sval : s.sell_val) > 0);
      gross_sellers = rawSellers.map(s => parseBrokerRow(s, false)).filter(Boolean);
      if (hasRealSval) {
        gross_sellers.sort((a, b) => b.sval - a.sval);
      }
    }

    if (rawNetBuyers.length > 0) {
      const hasRealBval = rawNetBuyers.some(b => toNumberLoose(b.bval != null ? b.bval : b.buy_val) > 0);
      top_buyers = rawNetBuyers.map(b => parseBrokerRow(b, true)).filter(b => b && b.net_val > 0);
      if (hasRealBval) {
        top_buyers.sort((a, b) => b.bval - a.bval);
      }
    }
    // AUDIT-F4-13: fallback top_buyers TIDAK dihitung di sini. `gross_buyers`
    // belum mengenal sisi jual (sval selalu 0 pada daftar pembeli terpisah),
    // sehingga broker cross-trade tampak sebagai net buyer besar dan
    // menggelembungkan CR3 sampai 100%. Fallback dihitung setelah merge
    // buy+sell di bawah, memakai net (bval - sval) yang sebenarnya.

    if (rawNetSellers.length > 0) {
      const hasRealSval = rawNetSellers.some(s => Number(s.sval || s.sell_val || 0) > 0);
      top_sellers = rawNetSellers.map(s => {
        const row = parseBrokerRow(s, false);
        if (row && row.net_val > 0) {
          row.net_val = -row.net_val;
          row.nval = row.net_val;
        }
        return row;
      }).filter(s => s && s.net_val < 0);
      if (hasRealSval) {
        top_sellers.sort((a, b) => b.sval - a.sval);
      }
    }
    if (top_sellers.length === 0 && gross_sellers.length > 0) {
      const hasRealSval = gross_sellers.some(s => toNumberLoose(s.sval != null ? s.sval : s.sell_val) > 0);
      top_sellers = gross_sellers.map(s => {
        const row = { ...s };
        if (row.net_val >= 0 && row.sval > 0) {
          row.net_val = -Math.abs(row.sval - (row.bval || 0));
          row.nval = row.net_val;
        } else if (row.net_val >= 0) {
          // AUDIT-F4-12: nilai riil 0 tetap 0 — jangan paksakan penjual hantu -1.
          row.net_val = -Math.abs(row.sval || row.svol);
          row.nval = row.net_val;
        }
        return row;
      }).filter(s => s.net_val < 0);
      if (hasRealSval) {
        top_sellers.sort((a, b) => b.sval - a.sval);
      }
      if (top_sellers.length === 0) {
        top_sellers = gross_sellers.map(s => {
          const absSval = Math.abs(toNumberLoose(s.sval != null ? s.sval : s.net_val) || 0);
          return { ...s, nval: -absSval, net_val: -absSval };
        }).filter(s => s.net_val < 0);
      }
    }

    // Combine into brokers list for downstream aggregators
    const bMap = new Map();
    gross_buyers.forEach(b => bMap.set(b.broker, b));
    gross_sellers.forEach(s => {
      if (bMap.has(s.broker)) {
        const existing = bMap.get(s.broker);
        existing.sval = s.sval;
        existing.svol = s.svol;
        existing.sell_val = s.sval;
        existing.sell_vol = s.svol;
        existing.nval = existing.bval - s.sval;
        existing.net_val = existing.nval;
      } else {
        bMap.set(s.broker, s);
      }
    });
    brokers = Array.from(bMap.values());

    // AUDIT-F4-13: fallback top_buyers dihitung dari broker list yang SUDAH
    // di-merge (bval & sval lengkap), bukan dari gross_buyers yang buta sisi
    // jual. Broker cross trade / churn (net 0) tidak lagi masuk sebagai top
    // buyer, sehingga CR3 mencerminkan akumulasi bersih riil. Urutan feed
    // dipertahankan (kontrak lama) supaya peringkat yang sudah disiapkan
    // upstream tidak berubah.
    //
    // AUDIT-F4-12: bila TIDAK ADA satu pun broker dengan informasi net, seluruh
    // daftar identitas dipertahankan (kontrak lama) supaya sinyal berbasis
    // broker code tetap bekerja — tanpa mengarang magnitudo apa pun.
    if (top_buyers.length === 0) {
      const netBuyers = brokers.filter(b => Number(b.net_val || 0) > 0);
      top_buyers = netBuyers.length > 0 ? netBuyers : gross_buyers.slice();
    }
    if (top_sellers.length === 0) {
      const netSellers = brokers.filter(b => Number(b.net_val || 0) < 0);
      top_sellers = netSellers.length > 0 ? netSellers : gross_sellers.slice();
    }
  }

  gross_buyers.sort((a, b) => Number(b.bval || b.buy_val || 0) - Number(a.bval || a.buy_val || 0));
  gross_sellers.sort((a, b) => Number(b.sval || b.sell_val || 0) - Number(a.sval || a.sell_val || 0));

  // AUDIT-F4-13: deteksi wash sale / cross trading sederhana — broker yang sama
  // tampil sebagai pembeli SEKALIGUS penjual dengan lot (atau nilai) identik.
  // Pola "tukar barang" ini bukan akumulasi; tanpa flag eksplisit ia menyamar
  // sebagai netral lalu mencemari basis konsentrasi CR3/CR5.
  const crossTradeBrokers = [];
  for (const b of brokers) {
    const bval = Number(b.bval || b.buy_val || 0);
    const sval = Number(b.sval || b.sell_val || 0);
    const bvol = Number(b.bvol || b.buy_vol || 0);
    const svol = Number(b.svol || b.sell_vol || 0);
    if (!(bval > 0 && sval > 0)) continue;
    const valueIdentical = Math.abs(bval - sval) <= Math.max(1, Math.max(bval, sval) * 1e-9);
    const lotsIdentical = bvol > 0 && svol > 0 && Math.abs(bvol - svol) <= Math.max(1, Math.max(bvol, svol) * 1e-9);
    if (valueIdentical || lotsIdentical) crossTradeBrokers.push(b.broker);
  }
  const hasCrossTrade = crossTradeBrokers.length > 0;

  // 4. Calculate Net Flow: connect to authentic institutional/foreign net flow or top broker differential
  //
  // AUDIT-F6-03: this set is the foreign-institution whitelist used to split
  // foreign buy vs foreign sell, and it used to contain 'CC'. CC is Mandiri
  // Sekuritas — a DOMESTIC Indonesian broker — so every rupiah of domestic
  // institutional buying was silently counted as foreign inflow, inflating
  // foreign_buy (and therefore foreign_net) by an unbounded amount. The
  // canonical whitelist in lib/foreign-flow-recap.js (FOREIGN_BROKERS, asserted
  // by test/foreign-flow-recap.test.js: "CC Mandiri is domestic") never
  // contained it. Removed here — this is a pure deletion so the existing
  // membership of every other code is untouched.
  const FOREIGN_INST_BROKERS = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB']);
  let foreignInstNet = 0;
  const allBrokersList = brokers.length > 0 ? brokers : gross_buyers;
  for (const b of allBrokersList) {
    const code = b.broker || b.broker_code;
    if (FOREIGN_INST_BROKERS.has(code)) {
      foreignInstNet += Number(b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
    }
  }

  // Authentic Foreign Flow Calculation (Foreign Buy vs Foreign Sell)
  let foreignBuyVal = 0;
  let foreignSellVal = 0;
  gross_buyers.forEach(b => {
    const code = b.broker || b.broker_code;
    if (FOREIGN_INST_BROKERS.has(code)) {
      foreignBuyVal += Number(b.bval || b.buy_val || 0);
    }
  });
  gross_sellers.forEach(s => {
    const code = s.broker || s.broker_code;
    if (FOREIGN_INST_BROKERS.has(code)) {
      foreignSellVal += Number(s.sval || s.sell_val || 0);
    }
  });

  if (typeof raw.foreign_buy === 'number' && typeof raw.foreign_sell === 'number') {
    foreignBuyVal = raw.foreign_buy;
    foreignSellVal = raw.foreign_sell;
  } else if (typeof raw.fbuy === 'number' && typeof raw.fsell === 'number') {
    foreignBuyVal = raw.fbuy;
    foreignSellVal = raw.fsell;
  }

  const foreignNetVal = (typeof raw.foreign_net === 'number')
    ? raw.foreign_net
    : (foreignBuyVal - foreignSellVal);

  const sumBval = gross_buyers.reduce((sum, b) => sum + Number(b.bval || b.buy_val || 0), 0);
  const sumSval = gross_sellers.reduce((sum, s) => sum + Number(s.sval || s.sell_val || 0), 0);
  const totalNetFlow = sumBval - sumSval;

  let rawNetFlow = 0;
  if (typeof raw.total_net_flow === 'number' && raw.total_net_flow !== 0) {
    rawNetFlow = raw.total_net_flow;
  } else if (typeof raw.net_flow === 'number' && raw.net_flow !== 0) {
    rawNetFlow = raw.net_flow;
  } else if (foreignInstNet !== 0) {
    rawNetFlow = foreignInstNet;
  } else if (top_buyers.length > 0 || top_sellers.length > 0) {
    const topBuyVal = top_buyers.slice(0, 3).reduce((acc, b) => acc + (b.net_val != null ? b.net_val : b.bval), 0);
    const topSellVal = Math.abs(top_sellers.slice(0, 3).reduce((acc, b) => acc + (b.net_val != null ? b.net_val : -b.sval), 0));
    rawNetFlow = topBuyVal - topSellVal;
  } else if (totalNetFlow !== 0) {
    rawNetFlow = totalNetFlow;
  } else {
    rawNetFlow = 0;
  }

  const netFlowFormatted = (rawNetFlow >= 0 ? '+' : '') + (rawNetFlow / 1e9).toFixed(2) + ' M';

  let netStatus = 'NEUTRAL';
  let netLabel = 'Netral';
  if (rawNetFlow > 0) {
    netStatus = 'BIG_ACCUMULATION';
    netLabel = 'Big Accumulation';
  } else if (rawNetFlow < 0) {
    netStatus = 'BIG_DISTRIBUTION';
    netLabel = 'Big Distribution';
  }

  const totalBuyVal = raw.total_buy_val || gross_buyers.reduce((sum, b) => sum + b.bval, 0);
  const totalSellVal = raw.total_sell_val || gross_sellers.reduce((sum, b) => sum + b.sval, 0);
  const totalBuyVol = raw.total_volume || raw.volume || gross_buyers.reduce((sum, b) => sum + b.bvol, 0);
  const totalTurnover = raw.total_turnover || raw.turnover || totalBuyVal;

  // No static fallback: when the cached payload carries no session key,
  // surface DATE_UNRESOLVED (null) so the caller can render the explicit
  // "tanggal belum tersedia" state instead of a stale hardcoded date.
  const targetDate = date === 'latest' || !date ? (raw.date || raw.broker_start_date || null) : date;

  return {
    date: targetDate,
    stock_code: cleanTicker || raw.stock_code || '',
    gross_buyers,
    gross_sellers,
    top_buyers,
    top_sellers,
    // AUDIT-F4-12: net_buyers/net_sellers HARUS benar-benar bersih menurut tanda
    // net. Sebelumnya keduanya hanya alias top_*, sehingga baris tanpa magnitudo
    // (net 0) ikut bocor ke daftar "net seller" sebagai penjual hantu.
    net_buyers: top_buyers.filter(b => Number(b.net_val || 0) > 0),
    net_sellers: top_sellers.filter(b => Number(b.net_val || 0) < 0),
    // AUDIT-F4-13: sinyal wash sale / cross trading eksplisit untuk UI & skoring.
    cross_trade_brokers: crossTradeBrokers,
    has_cross_trade: hasCrossTrade,
    net_flow: rawNetFlow,
    net_flow_formatted: netFlowFormatted,
    total_net_flow: rawNetFlow,
    net_status: netStatus,
    net_label: netLabel,
    total_buy_val: totalBuyVal,
    total_sell_val: totalSellVal,
    total_buy_vol: totalBuyVol,
    total_volume: totalBuyVol,
    total_turnover: totalTurnover,
    brokers: brokers,
    foreign_buy: foreignBuyVal,
    foreign_sell: foreignSellVal,
    foreign_net: foreignNetVal,
    foreign_buy_val: foreignBuyVal,
    foreign_sell_val: foreignSellVal,
    foreign_net_val: foreignNetVal,
    foreign_flow_status: foreignNetVal > 0 ? 'ACCUMULATION' : (foreignNetVal < 0 ? 'DISTRIBUTION' : 'NEUTRAL')
  };
}

/**
 * Calculate Scanner Discount percentage:
 * formula: Number((((modal - last_price) / modal) * 100).toFixed(2))
 */
function calculateScannerDiscount(modal, last_price) {
  modal = Number(modal || 0);
  last_price = Number(last_price || 0);
  if (!modal || modal <= 0 || !last_price || last_price <= 0) return 0;
  return Number((((modal - last_price) / modal) * 100).toFixed(2));
}

/**
 * Build 24-day daily tracking series from disk cache
 */
function buildDailyHistorySeries(ticker, maxDays = 24) {
  if (!ticker) return [];
  const clean = String(ticker).trim().toUpperCase();
  const dates = listDiskDates('broker-summary', clean);
  if (!dates || dates.length === 0) return [];
  const targetDates = dates.slice(0, maxDays).reverse();
  const series = [];
  for (const d of targetDates) {
    const raw = readDiskCache('broker-summary', clean, d);
    if (!raw) continue;
    const norm = normalizeBrokerSummary(raw, d, clean);
    if (!norm) continue;
    const dayNetFlow = norm.net_flow != null ? norm.net_flow : 0;
    const dayBuyers = firstNonEmptyArray(norm.gross_buyers, norm.net_buyers, norm.top_buyers);
    const daySellers = firstNonEmptyArray(norm.gross_sellers, norm.net_sellers, norm.top_sellers);
    const topBuyer = dayBuyers.length > 0 ? (dayBuyers[0].broker || dayBuyers[0].broker_code || '—') : '—';
    const topSeller = daySellers.length > 0 ? (daySellers[0].broker || daySellers[0].broker_code || '—') : '—';
    const top1 = dayNetFlow >= 0 ? topBuyer : topSeller;
    series.push({
      date: d,
      net_val: dayNetFlow,
      status: dayNetFlow >= 0 ? 'ACC' : 'DIST',
      top_buyer: topBuyer,
      top_seller: topSeller,
      top_1_broker: top1,
      top1_broker: top1,
      top_broker: top1,
      buyer1: topBuyer,
      seller1: topSeller
    });
  }
  return series;
}

/**
 * Build a synthetic broker_accumulation payload from an existing broker_summary
 * normSummary object (which always has real net_buyers / net_sellers).
 * This is the fallback when no broker-accumulation disk cache exists so that
 * the Akumulasi Broker bubble view never shows "Semua (0)".
 */
function synthesizeAccumulationFromSummary(normSummary, ticker) {
  if (!normSummary) {
    return { ticker, series: [], daily_summary: [], top_buyers: [], top_sellers: [], net_buyers: [], net_sellers: [] };
  }
  const buyers = firstNonEmptyArray(normSummary.net_buyers, normSummary.gross_buyers, normSummary.top_buyers, normSummary.buyers);
  const sellers = firstNonEmptyArray(normSummary.net_sellers, normSummary.gross_sellers, normSummary.top_sellers, normSummary.sellers);

  // Partition: ensure no item ends up on the wrong side
  const finalBuyers = [];
  const finalSellers = [];
  const seen = new Set();
  for (const b of buyers) {
    const code = b.broker || b.broker_code || '';
    if (seen.has(code)) continue;
    seen.add(code);
    const nval = b.nval != null ? b.nval : (b.net_val != null ? b.net_val : ((b.bval || 0) - (b.sval || 0)));
    if (nval < 0) {
      finalSellers.push(b);
    } else {
      finalBuyers.push(b);
    }
  }
  for (const s of sellers) {
    const code = s.broker || s.broker_code || '';
    if (seen.has(code)) continue;
    seen.add(code);
    finalSellers.push(s);
  }

  // Recovery guard: If finalSellers is empty, recover from buyers with sell volume
  if (finalSellers.length === 0 && finalBuyers.length > 0) {
    const pBuyers = [];
    const pSellers = [];
    for (const b of finalBuyers) {
      const nval = b.nval != null ? b.nval : (b.net_val != null ? b.net_val : ((b.bval || 0) - (b.sval || 0)));
      if (nval < 0 || ((b.sval || 0) > (b.bval || 0))) {
        pSellers.push(b);
      } else {
        pBuyers.push(b);
      }
    }
    if (pSellers.length > 0) {
      finalBuyers.length = 0;
      finalBuyers.push(...pBuyers);
      finalSellers.push(...pSellers);
    } else {
      const withSell = finalBuyers.filter(b => (b.sval || 0) > 0);
      if (withSell.length > 0) {
        finalSellers.push(...withSell);
      }
    }
  }

  const netFlow = normSummary.net_flow || 0;

  // For multi-day aggregated summaries, date_headers provides per-day net flows
  // which are more informative than a single combined net_flow entry for the chart.
  let series;
  if (Array.isArray(normSummary.date_headers) && normSummary.date_headers.length > 0) {
    series = normSummary.date_headers.map(h => {
      const isPos = (h.net_val || 0) >= 0;
      const tBuyer = h.top_buyer || h.buyer1 || (h.top_buyers && h.top_buyers[0] && (h.top_buyers[0].broker || h.top_buyers[0].code)) || '—';
      const tSeller = h.top_seller || h.seller1 || (h.top_sellers && h.top_sellers[0] && (h.top_sellers[0].broker || h.top_sellers[0].code)) || '—';
      const top1 = h.top_1_broker || h.top1_broker || h.top_broker || (isPos ? tBuyer : tSeller) || '—';
      return {
        date: h.date,
        net_val: h.net_val,
        status: h.status || (isPos ? 'ACC' : 'DIST'),
        top_buyer: tBuyer,
        top_seller: tSeller,
        top_1_broker: top1,
        top1_broker: top1,
        top_broker: top1,
        buyer1: tBuyer,
        seller1: tSeller
      };
    });
  } else {
    const dateLabel = normSummary.date || normSummary.range_label || 'latest';
    const isPos = netFlow >= 0;
    const tBuyer = (finalBuyers[0] && (finalBuyers[0].broker || finalBuyers[0].broker_code || finalBuyers[0].code)) || '—';
    const tSeller = (finalSellers[0] && (finalSellers[0].broker || finalSellers[0].broker_code || finalSellers[0].code)) || '—';
    const top1 = isPos ? tBuyer : tSeller;
    series = netFlow !== 0 ? [{
      date: dateLabel,
      net_val: netFlow,
      status: isPos ? 'ACC' : 'DIST',
      top_buyer: tBuyer,
      top_seller: tSeller,
      top_1_broker: top1,
      top1_broker: top1,
      top_broker: top1,
      buyer1: tBuyer,
      seller1: tSeller
    }] : [];
  }

  // F-067: derive score from real metrics (net-flow share of gross value +
  // multi-day consistency) or null when data is insufficient — never a
  // sign-only constant (70/30).
  const grossVal = finalBuyers.reduce((s, b) => s + Math.abs(Number(b.bval || b.buy_val || 0)), 0)
    + finalSellers.reduce((s, b) => s + Math.abs(Number(b.sval || b.sell_val || 0)), 0);
  const accDays = series.filter(d => (d.net_val || 0) > 0).length;

  // AUDIT-F5-06: a churning book must never score as accumulation. When the
  // same brokers trade the same size both ways across the window, net flow
  // collapses to ~0 while gross value stays huge — that is "tukar barang",
  // not accumulation. Detect it from the real net/gross ratio so the score
  // is withheld (null) instead of rewarded.
  const absNetFlow = Math.abs(netFlow);
  const isChurn = grossVal > 0 && absNetFlow < grossVal * 0.01;
  const accumulationScore = (grossVal > 0 && series.length > 0 && !isChurn)
    ? Math.round(Math.min(100, Math.max(0,
        50 + (netFlow / grossVal) * 50 + ((accDays / series.length) - 0.5) * 20)))
    : null;

  // AUDIT-F5-06: status must describe the data that exists. A book with real
  // broker rows whose net cancels out is NEUTRAL; only a payload with neither a
  // series nor any broker rows is genuinely NO_DATA.
  const hasBrokerRows = finalBuyers.length > 0 || finalSellers.length > 0;
  let status;
  if (series.length === 0 && !hasBrokerRows) status = 'NO_DATA';
  else if (isChurn || netFlow === 0) status = 'NEUTRAL';
  else status = netFlow > 0 ? 'ACCUMULATION' : 'DISTRIBUTION';

  return {
    ticker: ticker,
    accumulation_score: accumulationScore,
    status,
    is_churn: isChurn,
    series,
    daily_summary: series,
    top_buyers: finalBuyers,
    top_sellers: finalSellers,
    net_buyers: finalBuyers,
    net_sellers: finalSellers
  };
}

function normalizeBrokerAccumulation(raw, ticker) {
  // AUDIT-F5-04: a null payload is NO_DATA, not DISTRIBUTION — the empty
  // structure must still carry the honest status for downstream consumers.
  if (!raw) return {
    ticker,
    status: 'NO_DATA',
    accumulation_score: null,
    series: [],
    daily_summary: [],
    top_buyers: [],
    top_sellers: [],
    net_buyers: [],
    net_sellers: []
  };

  function sanitizeAccItem(it) {
    if (!it) return it;
    const copy = Object.assign({}, it);
    const keys = ['bval', 'buy_val', 'sval', 'sell_val', 'nval', 'net_val', 'val', 'value'];
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (copy[key] != null && Math.abs(Number(copy[key])) >= 5e11) {
        copy[key] = Math.round(Number(copy[key]) / 100);
      }
    }
    return copy;
  }

  if (Array.isArray(raw.series) && raw.series.length > 0 && raw.series[0].date && !raw.series[0].points) {
    const rawBuyers = (Array.isArray(raw.net_buyers) && raw.net_buyers.length > 0 ? raw.net_buyers : (Array.isArray(raw.top_buyers) ? raw.top_buyers : [])).map(sanitizeAccItem);
    const rawSellers = (Array.isArray(raw.net_sellers) && raw.net_sellers.length > 0 ? raw.net_sellers : (Array.isArray(raw.top_sellers) ? raw.top_sellers : [])).map(sanitizeAccItem);
    const bList = [];
    const sList = [].concat(rawSellers);
    for (const b of rawBuyers) {
      const net = b.nval != null ? b.nval : (b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
      if (net < 0) {
        sList.push(b);
      } else {
        bList.push(b);
      }
    }
    const cleanSeries = (raw.series || []).map(s => {
      const copy = Object.assign({}, s);
      if (copy.net_val != null && Math.abs(copy.net_val) >= 5e11) {
        copy.net_val = Math.round(copy.net_val / 100);
      }
      // AUDIT-F5-04: each session carries its own verdict. The upstream payload
      // supplies only net_val here, so derive the per-day status from that real
      // magnitude instead of leaving it undefined in the history table.
      if (!copy.status) {
        const net = Number(copy.net_val || 0);
        copy.status = net > 0 ? 'ACC' : (net < 0 ? 'DIST' : 'NEUTRAL');
      }
      return copy;
    });
    // AUDIT-F5-04: the status must come from this payload's own latest session,
    // never be inherited/absent. Previously the pre-shaped branch returned raw
    // verbatim, so a distribution series carried no status at all (undefined).
    const latestNet = cleanSeries.length > 0 ? (cleanSeries[cleanSeries.length - 1].net_val || 0) : 0;
    const shapedStatus = cleanSeries.length === 0
      ? 'NO_DATA'
      : (latestNet > 0 ? 'ACCUMULATION' : (latestNet < 0 ? 'DISTRIBUTION' : 'NEUTRAL'));

    return Object.assign({}, raw, {
      top_buyers: bList,
      top_sellers: sList,
      net_buyers: bList,
      net_sellers: sList,
      status: shapedStatus,
      series: cleanSeries
    });
  }

  const dateMap = new Map();
  const brokerTotals = new Map();
  if (Array.isArray(raw.series)) {
    for (const broker of raw.series) {
      if (Array.isArray(broker.points)) {
        const bCode = broker.broker_code || broker.broker || '';
        if (!bCode) continue;
        let totalNet = 0;
        let totalVol = 0;
        for (const pt of broker.points) {
          if (!pt.date) continue;
          if (!dateMap.has(pt.date)) {
            dateMap.set(pt.date, { date: pt.date, net_val: 0, top_buyer: '', top_buyer_val: 0, top_seller: '', top_seller_val: 0 });
          }
          const d = dateMap.get(pt.date);
          let nval = pt.nval || 0;
          if (Math.abs(nval) >= 5e11 || (pt.nvol > 0 && Math.abs(nval / pt.nvol) > 100000)) {
            nval = Math.round(nval / 100);
          }
          d.net_val += nval;
          totalNet += nval;
          totalVol += (pt.nvol || 0);
          if (nval > d.top_buyer_val) {
            d.top_buyer = bCode;
            d.top_buyer_val = nval;
          }
          if (nval < d.top_seller_val) {
            d.top_seller = bCode;
            d.top_seller_val = nval;
          }
        }
        if (Math.abs(totalNet) >= 5e11) {
          totalNet = Math.round(totalNet / 100);
        }
        brokerTotals.set(bCode, {
          broker: bCode,
          broker_name: broker.broker_name || '',
          nval: totalNet,
          net_val: totalNet,
          nvol: totalVol,
          net_vol: totalVol,
          buy_val: totalNet > 0 ? totalNet : 0,
          sell_val: totalNet < 0 ? Math.abs(totalNet) : 0
        });
      }
    }
  }

  const sortedDates = Array.from(dateMap.keys()).sort();
  const dailySeries = sortedDates.map(date => {
    const item = dateMap.get(date);
    let netVal = item.net_val;
    if (Math.abs(netVal) >= 5e11) {
      netVal = Math.round(netVal / 100);
    }
    const isAcc = netVal >= 0;
    return {
      date,
      net_val: netVal,
      status: isAcc ? 'ACC' : 'DIST',
      top_buyer: item.top_buyer || '—',
      top_seller: item.top_seller || '—'
    };
  });

  const accBrokers = Array.from(brokerTotals.values());
  const accBuyers = accBrokers.filter(b => b.nval >= 0).sort((a, b) => b.nval - a.nval);
  const accSellers = accBrokers.filter(b => b.nval < 0).sort((a, b) => Math.abs(b.nval) - Math.abs(a.nval));

  let topBuyers = ((Array.isArray(raw.top_buyers) && raw.top_buyers.length > 0) ? raw.top_buyers : accBuyers).map(sanitizeAccItem);
  let topSellers = ((Array.isArray(raw.top_sellers) && raw.top_sellers.length > 0) ? raw.top_sellers : accSellers).map(sanitizeAccItem);

  if (topSellers.length === 0 && topBuyers.length > 0) {
    const bList = [];
    const sList = [];
    for (const b of topBuyers) {
      if ((b.nval != null && b.nval < 0) || (b.net_val != null && b.net_val < 0) || ((b.sval || 0) > (b.bval || 0))) {
        sList.push(b);
      } else {
        bList.push(b);
      }
    }
    if (sList.length > 0) {
      topBuyers = bList;
      topSellers = sList;
    }
  }

  // AUDIT-F5-04: absent data must never become a verdict. A payload with no
  // usable series previously reported DISTRIBUTION purely because
  // dailySeries.length === 0 made the condition false — a status invented from
  // missing input. NO_DATA is the honest answer; a real series still resolves
  // from its latest session's net flow.
  let accStatus;
  if (dailySeries.length === 0) accStatus = 'NO_DATA';
  else {
    const latestNet = dailySeries[dailySeries.length - 1].net_val || 0;
    accStatus = latestNet > 0 ? 'ACCUMULATION' : (latestNet < 0 ? 'DISTRIBUTION' : 'NEUTRAL');
  }

  return {
    ticker: raw.code || ticker,
    accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : null,
    status: accStatus,
    series: dailySeries.slice(-24),
    top_buyers: topBuyers,
    top_sellers: topSellers,
    net_buyers: topBuyers,
    net_sellers: topSellers
  };
}

// Arjum's insider fields have shown up as either a plain number or a
// thousand-separated string (e.g. "1,234,567"). The client's formatNumber()
// runs `isNaN(num)` on whatever it's given, which returns true for a comma-
// formatted string — the number silently rendered as "–" even though real
// data existed, while the neighboring pct_change column (already a
// formatted string, displayed as raw text with no numeric parsing) showed
// fine. Coerce to a real number here so a genuine value is never dropped;
// return null only when there's truly nothing to parse.
function toNumericOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  // AUDIT-F6-04: feed insider Arjum mengirim saldo kepemilikan sebagai string
  // ribuan bergaya Indonesia ("3.200.142.830"). Versi lama hanya membuang koma
  // dan spasi, sehingga titik ribuan membuat Number() mengembalikan NaN dan
  // saldo saham pemegang >5% hilang menjadi null tanpa peringatan.
  // toNumberLoose() adalah parser numerik longgar yang sudah menjadi standar
  // repo ini (AUDIT-F4-10/11/12); delegasikan agar perilakunya konsisten.
  return toNumberLoose(value);
}

function formatPercentageString(val) {
  if (val == null) return null;
  const str = String(val).trim();
  if (!str || str === '—' || str === '-') return null;
  if (str.endsWith('%')) return str;
  const clean = str.replace(/[+%,\s]/g, '');
  const num = Number(clean);
  if (!Number.isFinite(num)) return str + '%';
  const prefix = str.startsWith('+') ? '+' : (str.startsWith('-') ? '-' : '');
  return prefix + num + '%';
}

function normalizeInsiders(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.items || raw.results || raw.data || []);
  return list.map(item => {
    // 1. Name normalization (insider_name or name or shareholder_name)
    const rawName = item.insider_name || item.name || item.shareholder_name || item.owner_name || '';
    const name = String(rawName).trim().replace(/\s+/g, ' ') || '—';

    // 2. Action type (BUY, SELL, TRANSFER)
    const rawAction = String(item.action_type || item.type || item.transaction_type || item.action || 'BUY').trim().toUpperCase();
    let actionType = 'BUY';
    if (rawAction.includes('SELL') || rawAction.includes('JUAL') || rawAction.includes('BUANG') || rawAction.includes('DISTRIBUSI')) {
      actionType = 'SELL';
    } else if (rawAction.includes('TRANS') || rawAction.includes('ALIH') || rawAction.includes('HIBAH') || rawAction.includes('BONUS') || rawAction.includes('WARIS') || rawAction.includes('MESOP') || rawAction.includes('ESOP') || rawAction.includes('REPO')) {
      actionType = 'TRANSFER';
    } else if (rawAction.includes('BUY') || rawAction.includes('BELI') || rawAction.includes('AKUM')) {
      actionType = 'BUY';
    } else {
      actionType = rawAction || 'BUY';
    }

    // 3. Broker code (e.g. YP, XL, XA, CC, PD)
    const rawBroker = item.broker || item.broker_code || item.sec_code || item.securities_company || item.broker_name || '';
    const broker = String(rawBroker).trim().toUpperCase() || '—';

    // 4. Shares change (shares / volume / changes_value)
    const sharesChange = toNumericOrNull(item.changes_value) ?? toNumericOrNull(item.shares_change) ?? toNumericOrNull(item.shares) ?? toNumericOrNull(item.volume);

    // 5. Price
    const price = toNumericOrNull(item.price) ?? toNumericOrNull(item.price_formatted) ?? toNumericOrNull(item.harga) ?? 0;

    // 6. Percentage change
    const pctChange = formatPercentageString(item.changes_percentage || item.pct_change || item.percentage_change) || '—';

    // 7. Shares after & before
    const sharesAfter = toNumericOrNull(item.current_value) ?? toNumericOrNull(item.shares_after) ?? toNumericOrNull(item.current_shares) ?? toNumericOrNull(item.volume_after) ?? toNumericOrNull(item.after_value);
    const rawPctAfter = item.current_percentage || item.shares_after_percentage || item.percentage_after || item.pct_after || item.current_shares_percentage || item.after_percentage || null;
    const pctAfter = formatPercentageString(rawPctAfter);

    let sharesBefore = toNumericOrNull(item.previous_value) ?? toNumericOrNull(item.shares_before) ?? toNumericOrNull(item.previous_shares) ?? toNumericOrNull(item.volume_before) ?? toNumericOrNull(item.before_value);
    // Fallback formula: shares_before = shares_after - shares_change
    if (sharesBefore == null && sharesAfter != null && sharesChange != null) {
      const signedChange = (actionType === 'SELL' && sharesChange > 0) ? -sharesChange : sharesChange;
      sharesBefore = sharesAfter - signedChange;
    }
    const rawPctBefore = item.previous_percentage || item.shares_before_percentage || item.percentage_before || item.pct_before || item.before_percentage || item.previous_shares_percentage || null;
    let pctBefore = formatPercentageString(rawPctBefore);
    if (!pctBefore && sharesBefore != null && sharesAfter != null && pctAfter) {
      const numAfter = parseFloat(String(pctAfter).replace(/[%+]/g, ''));
      if (numAfter > 0 && sharesAfter > 0) {
        pctBefore = ((sharesBefore / sharesAfter) * numAfter).toFixed(2) + '%';
      }
    }

    // 8. Nationality (local / foreign)
    const rawNat = String(item.nationality || item.national || item.kewarganegaraan || '').toLowerCase();
    let nationality = 'local';
    if (rawNat.includes('foreign') || rawNat.includes('asing') || rawNat.includes('wna')) {
      nationality = 'foreign';
    } else if (rawNat.includes('local') || rawNat.includes('lokal') || rawNat.includes('wni') || rawNat.includes('indonesia')) {
      nationality = 'local';
    } else if (rawNat) {
      nationality = rawNat;
    }

    let position = item.position || item.jabatan || item.title || item.status || ((Array.isArray(item.badges) && item.badges[0]) ? item.badges[0] : null);
    if (!position || position === '—') {
      const numPct = parseFloat(String(pctAfter || pctBefore || '0').replace(/[%+]/g, ''));
      if (numPct >= 5.0) {
        position = 'Pemegang Saham >5%';
      } else {
        position = '—';
      }
    }

    // Absolute shareholding balance after transaction (saldo kepemilikan mutlak)
    const sharesBalance = toNumericOrNull(item.current_value) ?? toNumericOrNull(item.shares_after) ?? toNumericOrNull(item.current_shares) ?? toNumericOrNull(item.shares);
    const lastChange = toNumericOrNull(item.changes_value) ?? toNumericOrNull(item.shares_change) ?? toNumericOrNull(item.volume);
    const finalShares = sharesBalance ?? lastChange ?? null;

    // AUDIT-F6-06: trade date dan tanggal pelaporan ke OJK/BEI adalah dua
    // peristiwa berbeda. Transaksi insider di BEI wajib dilaporkan dalam 3 hari
    // bursa, jadi sebuah sinyal tidak mungkin diketahui pasar pada hari
    // transaksinya. Versi lama hanya menyimpan satu `date`, sehingga seluruh
    // konsumen memperlakukan tanggal transaksi sebagai tanggal publikasi —
    // sebuah time-leak klasik (look-ahead) untuk backtest maupun sinyal live.
    // Tanggal transaksi dipertahankan apa adanya, tanggal pelaporan disimpan
    // terpisah, dan `signal_available_date` menandai kapan sinyal benar-benar
    // boleh dipakai. Tanpa data pelaporan, nilainya null — tidak pernah
    // diasumsikan sama dengan tanggal transaksi.
    const tradeDate = item.transaction_date || item.tanggal_transaksi || item.date || item.tanggal || '—';
    const filingDate = item.filing_date || item.report_date || item.tanggal_lapor || item.published_at || null;
    const filingDateNormalized = (typeof filingDate === 'string' && filingDate.trim())
      ? filingDate.trim().slice(0, 10)
      : (filingDate == null ? null : String(filingDate).slice(0, 10));

    return {
      date: tradeDate,
      trade_date: tradeDate,
      filing_date: filingDateNormalized,
      signal_available_date: filingDateNormalized,
      name: name,
      insider_name: name,
      position: position,
      action_type: actionType,
      broker: broker,
      price: price,
      shares: finalShares, // Saldo kepemilikan atau mutasi transaksi
      last_change: lastChange, // Mutasi transaksi ini
      shares_change: lastChange,
      pct_change: pctChange,
      shares_after: sharesAfter ?? sharesBalance,
      pct_after: pctAfter,
      shares_after_percentage: pctAfter,
      current_percentage: pctAfter,
      shares_before: sharesBefore,
      pct_before: pctBefore,
      shares_before_percentage: pctBefore,
      previous_percentage: pctBefore,
      nationality: nationality
    };
  });
}

function resolveTickerInsiders(ticker, diskInsiders) {
  let list = normalizeInsiders(diskInsiders);
  if (!list || list.length === 0) {
    try {
      const insiderNetworkService = require('./insider-network-service');
      const dbRecords = insiderNetworkService.getInsidersForTicker(ticker);
      if (dbRecords && dbRecords.length > 0) {
        list = normalizeInsiders(dbRecords);
      }
    } catch (_) {}
  }
  return list || [];
}

function filterCalendarWindowDates(dates, numDays) {
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const days = Number(numDays) || 7;
  // AUDIT-F5-02: de-duplicate before windowing. A caller that merged a
  // calendar-derived list with a disk-derived list could hand the same session
  // in twice, and aggregateBrokerSummaries then summed that day's flow twice —
  // inflating net flow, gross value and the broker totals by a full session.
  const seen = new Set();
  const sorted = [];
  for (const d of dates) {
    if (!d) continue;
    const key = String(d);
    if (seen.has(key)) continue;
    seen.add(key);
    sorted.push(key);
  }
  sorted.sort((a, b) => String(b).localeCompare(String(a)));
  if (sorted.length === 0) return [];

  const latestStr = sorted[0];
  const latestTime = new Date(latestStr + 'T00:00:00Z').getTime();
  if (isNaN(latestTime)) return sorted.slice(0, days);

  // Batasi tanggal yang boleh diambil maksimal mundur (rangeDays * 2.5) hari kalender dari tanggal file terbaru
  const maxCalendarDays = Math.ceil(days * 2.5);
  const cutoffTime = latestTime - (maxCalendarDays * 24 * 60 * 60 * 1000);
  const cutoffStr = new Date(cutoffTime).toISOString().slice(0, 10);

  const inWindow = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i];
    if (d < cutoffStr || d > latestStr) continue;
    if (i > 0) {
      const prevTime = new Date(sorted[i - 1] + 'T00:00:00Z').getTime();
      const currTime = new Date(d + 'T00:00:00Z').getTime();
      if (!isNaN(prevTime) && !isNaN(currTime) && (prevTime - currTime) > 7 * 24 * 60 * 60 * 1000) {
        // Date gap > 7 calendar days between trading days (e.g. September jumps to July)
        break;
      }
    }
    inWindow.push(d);
  }
  // BATCH 3 Module 4: agregasi multi-hari harus tepat `days` hari bursa riil
  // (newest-first). Tanpa slice ini window filter over-collect (mis. want=5
  // mengembalikan 10 tanggal) sehingga 5D/14D/30D/60D tercemar hari ekstra.
  return inWindow.slice(0, days);
}

function aggregateBrokerSummaries(ticker, dates, requestedDays, isCustomRange = false) {
  const reqDays = Number(requestedDays || (dates && dates.length) || 7);
  // AUDIT-F5-02: the custom-range branch bypassed filterCalendarWindowDates,
  // so a duplicated date in an explicit window was summed twice. De-duplicate
  // the custom window too, preserving the caller's ordering.
  let customDates = dates;
  if (isCustomRange && Array.isArray(dates)) {
    const seenCustom = new Set();
    customDates = dates.filter(d => {
      if (!d) return false;
      const key = String(d);
      if (seenCustom.has(key)) return false;
      seenCustom.add(key);
      return true;
    });
  }
  const validDates = isCustomRange ? customDates : filterCalendarWindowDates(dates, reqDays);
  const diskDates = (validDates || []).filter(d => hasDiskCache('broker-summary', ticker, d));

  function getHunterFallback() {
    try {
      const intelService = require('./bandarmologi-intel-service');
      const rangeStr = reqDays <= 1 ? '1d' : (reqDays <= 5 ? '5d' : (reqDays <= 7 ? '7d' : (reqDays <= 14 ? '14d' : (reqDays <= 30 ? '30d' : '60d'))));
      let hunterFallback = null;
      if (intelService && typeof intelService.getBrokersFromHunterIndexes === 'function') {
        hunterFallback = intelService.getBrokersFromHunterIndexes(ticker, rangeStr);
      }
      if (!hunterFallback) {
        try {
          const hunterIndexDir = path.join(__dirname, '..', 'data', 'broker-hunter-indexes');
          if (fs.existsSync(hunterIndexDir)) {
            const cleanT = String(ticker || '').trim().toUpperCase();
            const suffix = `_${rangeStr}.json`;
            const files = fs.readdirSync(hunterIndexDir).filter(f => f.endsWith(suffix));
            const buyers = [];
            const sellers = [];
            let targetDates = [];
            for (const f of files) {
              try {
                const d = JSON.parse(fs.readFileSync(path.join(hunterIndexDir, f), 'utf8'));
                if (!targetDates.length && Array.isArray(d.target_dates)) targetDates = d.target_dates;
                const bCode = d.broker;
                const bName = d.broker_name || bCode;
                for (const acc of (d.top_accumulated || [])) {
                  if (acc && acc.ticker && acc.ticker.toUpperCase() === cleanT) {
                    const bNval = Number(acc.net_val != null ? acc.net_val : ((acc.buy_val || 0) - (acc.sell_val || 0)));
                    const bNvol = Number(acc.net_vol != null ? acc.net_vol : (acc.net_lot ? acc.net_lot * 100 : ((acc.buy_vol || 0) - (acc.sell_vol || 0))));
                    buyers.push({
                      broker: bCode,
                      broker_name: bName,
                      buy_val: Number(acc.buy_val || 0),
                      bval: Number(acc.buy_val || 0),
                      buy_vol: Number(acc.buy_vol || 0),
                      bvol: Number(acc.buy_vol || 0),
                      avg_buy: Number(acc.avg_buy_price || 0),
                      avg_price: Number(acc.avg_buy_price || 0),
                      net_val: bNval,
                      nval: bNval,
                      net_vol: bNvol,
                      nvol: bNvol
                    });
                  }
                }
                for (const dist of (d.top_distributed || [])) {
                  if (dist && dist.ticker && dist.ticker.toUpperCase() === cleanT) {
                    const sNval = Number(dist.net_val != null ? dist.net_val : ((dist.buy_val || 0) - (dist.sell_val || 0)));
                    const sNvol = Number(dist.net_vol != null ? dist.net_vol : (dist.net_lot ? dist.net_lot * 100 : ((dist.buy_vol || 0) - (dist.sell_vol || 0))));
                    sellers.push({
                      broker: bCode,
                      broker_name: bName,
                      sell_val: Number(dist.sell_val || 0),
                      sval: Number(dist.sell_val || 0),
                      sell_vol: Number(dist.sell_vol || 0),
                      svol: Number(dist.sell_vol || 0),
                      avg_sell: Number(dist.avg_sell_price || 0),
                      avg_price: Number(dist.avg_sell_price || 0),
                      net_val: sNval,
                      nval: sNval,
                      net_vol: sNvol,
                      nvol: sNvol
                    });
                  }
                }
              } catch (_) {}
            }
            if (buyers.length > 0 || sellers.length > 0) {
              hunterFallback = {
                ticker: cleanT,
                range: rangeStr,
                target_dates: targetDates,
                top_buyers: buyers.sort((a, b) => b.buy_val - a.buy_val),
                top_sellers: sellers.sort((a, b) => b.sell_val - a.sell_val)
              };
            }
          }
        } catch (_) {}
      }
      if (hunterFallback && ((Array.isArray(hunterFallback.top_buyers) && hunterFallback.top_buyers.length > 0) || (Array.isArray(hunterFallback.top_sellers) && hunterFallback.top_sellers.length > 0))) {
          const buyers = hunterFallback.top_buyers || [];
          const sellers = hunterFallback.top_sellers || [];
          const targetDates = (hunterFallback.target_dates && hunterFallback.target_dates.length > 0)
            ? hunterFallback.target_dates
            : (validDates.length > 0 ? validDates : (dates || []));
          const totalBuyVal = buyers.reduce((sum, b) => sum + Number(b.buy_val || b.bval || 0), 0);
          const totalSellVal = sellers.reduce((sum, s) => sum + Number(s.sell_val || s.sval || 0), 0);
          const totalBuyVol = buyers.reduce((sum, b) => sum + Number(b.buy_vol || b.bvol || 0), 0);
          const totalSellVol = sellers.reduce((sum, s) => sum + Number(s.sell_vol || s.svol || 0), 0);
          const netFlow = totalBuyVal - totalSellVal;
          const sDate = targetDates[targetDates.length - 1] || '—';
          const eDate = targetDates[0] || '—';
          const dateLabel = sDate === eDate ? sDate : `${sDate} s/d ${eDate}`;
          const countLabel = `${reqDays} Hari Bursa`;

          const headers = targetDates.map(d => ({
            date: d,
            net_val: Math.round(netFlow / Math.max(1, targetDates.length)),
            status: netFlow >= 0 ? 'ACC' : 'DIST',
            top_buyer: (buyers[0] && buyers[0].broker) || '—',
            top_seller: (sellers[0] && sellers[0].broker) || '—',
            top_1_broker: (buyers[0] && buyers[0].broker) || '—',
            top1_broker: (buyers[0] && buyers[0].broker) || '—',
            top_broker: (buyers[0] && buyers[0].broker) || '—',
            buyer1: (buyers[0] && buyers[0].broker) || '—',
            seller1: (sellers[0] && sellers[0].broker) || '—'
          }));

          return {
            ticker: ticker,
            date: dateLabel,
            range_label: `${countLabel} (${dateLabel})`,
            range_days: reqDays,
            net_flow: netFlow,
            net_status: netFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
            net_label: netFlow >= 0 ? 'Akumulasi' : 'Distribusi',
            total_buy_val: totalBuyVal,
            total_sell_val: totalSellVal,
            total_buy_vol: totalBuyVol,
            total_sell_vol: totalSellVol,
            total_volume: totalBuyVol,
            total_turnover: totalBuyVal,
            top_buyers: buyers,
            top_sellers: sellers,
            gross_buyers: buyers,
            gross_sellers: sellers,
            net_buyers: buyers,
            net_sellers: sellers,
            date_headers: headers
          };
        }
    } catch (_) {}
    return null;
  }

  // Fallback Dataset: Jika tanggal disk yang valid kurang dari hari bursa yang diminta,
  // ambil data dari getBrokersFromHunterIndexes(ticker, range) agar modal VWAP tetap konsisten di level harga pasar saat ini.
  if (!isCustomRange && (diskDates.length < reqDays || diskDates.length === 0)) {
    const fb = getHunterFallback();
    if (fb) return fb;
  }

  const useDates = diskDates.length > 0 ? diskDates : (validDates.length > 0 ? validDates : dates);
  const brokerMap = {};
  let combinedNetFlow = 0;

  // Per-day breakdown for the "Riwayat Harian" table and accumulation series chart
  const dateHeaders = [];

  for (const d of useDates) {
    const raw = readDiskCache('broker-summary', ticker, d);
    if (!raw) continue;
    const norm = normalizeBrokerSummary(raw, d);
    if (!norm) continue;

    const dayNetFlow = norm.net_flow || 0;
    combinedNetFlow += dayNetFlow;

    // Find top buyer / seller for this specific day
    const dayBuyers = firstNonEmptyArray(norm.gross_buyers, norm.net_buyers, norm.top_buyers);
    const daySellers = firstNonEmptyArray(norm.gross_sellers, norm.net_sellers, norm.top_sellers);
    const topBuyer = dayBuyers.length > 0 ? (dayBuyers[0].broker || dayBuyers[0].broker_code || '—') : '—';
    const topSeller = daySellers.length > 0 ? (daySellers[0].broker || daySellers[0].broker_code || '—') : '—';
    const top1 = dayNetFlow >= 0 ? topBuyer : topSeller;

    dateHeaders.push({
      date: d,
      net_val: dayNetFlow,
      status: dayNetFlow >= 0 ? 'ACC' : 'DIST',
      top_buyer: topBuyer,
      top_seller: topSeller,
      top_1_broker: top1,
      top1_broker: top1,
      top_broker: top1,
      buyer1: topBuyer,
      seller1: topSeller
    });

    const dayBrokers = new Map();

    const buyers = firstNonEmptyArray(norm.gross_buyers, norm.top_buyers);
    for (const b of buyers) {
      if (!b.broker) continue;
      dayBrokers.set(b.broker, {
        broker: b.broker,
        broker_name: b.broker_name || '',
        bval: Number(b.bval || b.buy_val || 0),
        sval: Number(b.sval || b.sell_val || 0),
        bvol: Number(b.bvol || b.buy_vol || 0),
        svol: Number(b.svol || b.sell_vol || 0),
        bfrq: Number(b.bfrq || 0),
        sfrq: Number(b.sfrq || 0)
      });
    }

    const sellers = firstNonEmptyArray(norm.gross_sellers, norm.top_sellers);
    for (const s of sellers) {
      if (!s.broker) continue;
      const existing = dayBrokers.get(s.broker);
      if (existing) {
        existing.sval = Math.max(existing.sval, Number(s.sval || s.sell_val || 0));
        existing.svol = Math.max(existing.svol, Number(s.svol || s.sell_vol || 0));
        existing.sfrq = Math.max(existing.sfrq, Number(s.sfrq || 0));
        existing.bval = Math.max(existing.bval, Number(s.bval || s.buy_val || 0));
        existing.bvol = Math.max(existing.bvol, Number(s.bvol || s.buy_vol || 0));
        existing.bfrq = Math.max(existing.bfrq, Number(s.bfrq || 0));
        if (!existing.broker_name && s.broker_name) existing.broker_name = s.broker_name;
      } else {
        dayBrokers.set(s.broker, {
          broker: s.broker,
          broker_name: s.broker_name || '',
          bval: Number(s.bval || s.buy_val || 0),
          sval: Number(s.sval || s.sell_val || 0),
          bvol: Number(s.bvol || s.buy_vol || 0),
          svol: Number(s.svol || s.sell_vol || 0),
          bfrq: Number(s.bfrq || 0),
          sfrq: Number(s.sfrq || 0)
        });
      }
    }

    for (const [code, item] of dayBrokers.entries()) {
      if (!brokerMap[code]) {
        brokerMap[code] = {
          broker: code,
          broker_name: item.broker_name,
          bval: 0,
          sval: 0,
          bvol: 0,
          svol: 0,
          bfrq: 0,
          sfrq: 0
        };
      }
      brokerMap[code].bval += item.bval;
      brokerMap[code].sval += item.sval;
      brokerMap[code].bvol += item.bvol;
      brokerMap[code].svol += item.svol;
      brokerMap[code].bfrq += item.bfrq;
      brokerMap[code].sfrq += item.sfrq;
      if (item.broker_name && !brokerMap[code].broker_name) {
        brokerMap[code].broker_name = item.broker_name;
      }
    }
  }

  const refPrice = getReferencePrice(ticker);
  const list = Object.values(brokerMap).map(b => {
    const nval = b.bval - b.sval;
    const nvol = b.bvol - b.svol;
    let avgBuy = b.bvol > 0 ? normalizeVwapPrice(b.bval / b.bvol, refPrice) : 0;
    let avgSell = b.svol > 0 ? normalizeVwapPrice(b.sval / b.svol, refPrice) : 0;
    const totVal = b.bval + b.sval;
    const totVol = b.bvol + b.svol;
    let avgPrice = totVol > 0 ? normalizeVwapPrice(totVal / totVol, refPrice) : (avgBuy || avgSell || 0);
    return Object.assign({}, b, {
      nval,
      nvol,
      net_val: nval,
      net_vol: nvol,
      buy_val: b.bval,
      sell_val: b.sval,
      buy_vol: b.bvol,
      sell_vol: b.svol,
      avg_price: avgPrice,
      avg_buy: avgBuy,
      avg_sell: avgSell
    });
  });


  if (list.length === 0) {
    if (!isCustomRange) {
      const fb = getHunterFallback();
      if (fb) return fb;
    }
    return null;
  }

  const grossBuyers = list.slice().sort((a, b) => b.bval - a.bval).map(b => Object.assign({}, b, { avg_price: b.avg_buy || b.avg_price }));
  const grossSellers = list.slice().sort((a, b) => b.sval - a.sval).map(s => Object.assign({}, s, { avg_price: s.avg_sell || s.avg_price }));
  const netBuyers = list.filter(b => b.nval >= 0).sort((a, b) => b.nval - a.nval).map(b => Object.assign({}, b, { avg_price: b.avg_buy || b.avg_price }));
  const netSellers = list.filter(b => b.nval < 0).sort((a, b) => Math.abs(b.nval) - Math.abs(a.nval)).map(s => Object.assign({}, s, { avg_price: s.avg_sell || s.avg_price }));

  const totalBuyVal = list.reduce((sum, b) => sum + (b.bval || 0), 0);
  const totalSellVal = list.reduce((sum, b) => sum + (b.sval || 0), 0);
  const totalBuyVol = list.reduce((sum, b) => sum + (b.bvol || 0), 0);
  const totalSellVol = list.reduce((sum, b) => sum + (b.svol || 0), 0);
  const totalTurnover = totalBuyVal;

  const startDate = dates[dates.length - 1];
  const endDate = dates[0];
  const dateLabel = startDate === endDate ? startDate : `${startDate} s/d ${endDate}`;
  const countLabel = requestedDays ? `${requestedDays} Hari Bursa` : `${dates.length} Hari Bursa`;

  const sortedDateHeaders = [...dateHeaders].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return {
    date: dateLabel,
    range_label: `${countLabel} (${dateLabel})`,
    range_days: dates.length,
    net_flow: combinedNetFlow,
    net_status: combinedNetFlow > 0 ? 'ACCUMULATION' : (combinedNetFlow < 0 ? 'DISTRIBUTION' : 'NEUTRAL'),
    net_label: combinedNetFlow > 0 ? 'Akumulasi' : (combinedNetFlow < 0 ? 'Distribusi' : 'Netral'),
    total_buy_val: totalBuyVal,
    total_sell_val: totalSellVal,
    total_buy_vol: totalBuyVol,
    total_sell_vol: totalSellVol,
    total_volume: totalBuyVol,
    total_turnover: totalTurnover,
    top_buyers: grossBuyers,
    top_sellers: grossSellers,
    gross_buyers: grossBuyers,
    gross_sellers: grossSellers,
    net_buyers: netBuyers,
    net_sellers: netSellers,
    date_headers: sortedDateHeaders
  };
}


/**
 * Scale broker summary and accumulation objects for multi-day periods,
 * and guarantee range_label is attached unconditionally without inflating monetary figures.
 */
function applyMultiDayScaling(summary, accumulation, numDays, targetDate) {
  if (!summary) return;
  if (numDays > 1) {
    if (summary._is_scaled) return;
    summary._is_scaled = true;

    // Batch 1 (P0): synthetic multipliers removed.
    //
    // This function used to multiply a single trading day's volume and net flow
    // by a fixed constant (x5 / x10 / x22 / x44) and present the result as an
    // "N Hari Bursa Agregat" figure. Those are fabricated numbers, not an
    // aggregate: a genuine multi-day figure is produced by
    // aggregateBrokerSummaries() summing real days from disk.
    //
    // When only one day exists there is nothing to aggregate, so the honest
    // answer is to keep the real single-day values and declare explicitly that
    // the multi-day label is NOT backed by multi-day data.
    summary.synthetic_scaling = true;
    summary.aggregation_basis_days = summary.basis_days || 1;
    summary.range_label = `${numDays} Hari Bursa (${summary.date || targetDate || 'Terbaru'} Agregat)`;
    summary.date = `${summary.date || targetDate || 'Terbaru'} (${numDays} Hari Agregat)`;

    const scaleBrokers = list => list;
    if (summary.gross_buyers) summary.gross_buyers = scaleBrokers(summary.gross_buyers);
    if (summary.gross_sellers) summary.gross_sellers = scaleBrokers(summary.gross_sellers);
    if (summary.top_buyers) summary.top_buyers = scaleBrokers(summary.top_buyers);
    if (summary.top_sellers) summary.top_sellers = scaleBrokers(summary.top_sellers);
    if (summary.net_buyers) summary.net_buyers = scaleBrokers(summary.net_buyers);
    if (summary.net_sellers) summary.net_sellers = scaleBrokers(summary.net_sellers);
    if (accumulation) {
      if (accumulation.top_buyers) accumulation.top_buyers = scaleBrokers(accumulation.top_buyers);
      if (accumulation.top_sellers) accumulation.top_sellers = scaleBrokers(accumulation.top_sellers);
      if (accumulation.net_buyers) accumulation.net_buyers = scaleBrokers(accumulation.net_buyers);
      if (accumulation.net_sellers) accumulation.net_sellers = scaleBrokers(accumulation.net_sellers);
    }
  } else if (!summary.range_label) {
    summary.range_label = summary.date ? `Tanggal: ${summary.date}` : 'Terbaru';
  }
}

/**
 * Get unified Bandarmologi data for a ticker
 */
async function getBandarmologiData(tickerOrQuery, options = {}) {
  const ticker = arjumClient.cleanTicker(tickerOrQuery);
  if (!ticker) {
    return { success: false, error: 'Ticker tidak valid' };
  }

  const range = String(options.range || '1d').toLowerCase();
  const targetDate = options.date || '';
  const flow = String(options.flow || '').trim().toUpperCase(); // '', 'F' (foreign), or 'D' (domestic)
  const isFlowFiltered = flow === 'F' || flow === 'D';
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[range] || (parseInt(range, 10) || 1);
  const isCustomRange = range === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(options.startDate || '') && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate || '') && options.startDate <= options.endDate;
  const forceRefresh = Boolean(options.forceRefresh);
  const cacheKey = versionedCacheKey([
    'bandar', ticker,
    isCustomRange ? 'custom' : (targetDate || 'latest'),
    isCustomRange ? options.startDate : range,
    isCustomRange ? options.endDate : '',
    isFlowFiltered ? `flow${flow}` : 'all',
    numDays > 1 ? `days${numDays}` : ''
  ]);
  const cached = getCache(cacheKey);
  if (cached && !forceRefresh) {
    return Object.assign({ success: true, from_cache: true }, cached);
  }

  // Foreign/Domestic flow filtering is not part of the backfilled disk cache
  // (which only holds the combined/"all" view), so a flow-filtered request
  // always goes straight to the live Arjum API for a single date rather than
  // serving disk-cached "all" data under a misleading filter.
  if (isFlowFiltered) {
    if (!arjumClient.hasArjumApiKey()) {
      return { success: false, error: 'Filter Foreign/Domestic butuh koneksi API live (ARJUM_API_KEY belum tersedia).' };
    }
    try {
      const [sumRes, accRes, insRes] = await Promise.all([
        arjumClient.fetchBrokerSummary(ticker, targetDate, flow),
        arjumClient.fetchBrokerAccumulation(ticker),
        arjumClient.fetchInsiders(ticker, 1, 15)
      ]);
      if (!sumRes.ok || !sumRes.data) {
        return { success: false, error: (sumRes && sumRes.error) || 'Gagal memuat data broker summary (flow filter).' };
      }
      const freshSummary = normalizeBrokerSummary(sumRes.data, targetDate);
      const normAcc = normalizeBrokerAccumulation(accRes.ok ? accRes.data : null, ticker);
      const normIns = resolveTickerInsiders(ticker, insRes.ok ? insRes.data : []);
      if (freshSummary) {
        applyMultiDayScaling(freshSummary, normAcc, numDays, targetDate);
      }
      const payload = {
        is_demo: false,
        ticker,
        date: (freshSummary && freshSummary.range_label) || targetDate || (freshSummary && freshSummary.date) || 'latest',
        range: range,
        flow: flow,
        available_dates: listDiskDates('broker-summary', ticker),
        broker_summary: freshSummary,
        broker_accumulation: normAcc,
        insiders: normIns
      };
      setCache(cacheKey, payload);
      return Object.assign({ success: true, live: true }, payload);
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // On-demand VPS fetcher: If local disk cache does not have data for this ticker,
  // fetch it directly from VPS via HTTP tunnel or SSH child_process before attempting any fallback
  let availableDates = listDiskDates('broker-summary', ticker);
  if (!forceRefresh) {
    if (availableDates.length === 0) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchAvailableDatesFromVpsSync === 'function') {
          const vDates = vpsFetcher.fetchAvailableDatesFromVpsSync(ticker);
          if (Array.isArray(vDates) && vDates.length > 0) {
            availableDates = vDates;
          }
        }
      } catch (_) {}
    }
    if (availableDates.length === 0 || (targetDate && targetDate !== 'latest' && !availableDates.includes(targetDate))) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
          const targetVpsDate = targetDate || getEffectiveTradingDate(ticker);
          const fetched = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetVpsDate);
          if (fetched && availableDates.length === 0) {
            availableDates = listDiskDates('broker-summary', ticker);
            if (availableDates.length === 0 && fetched.date) {
              availableDates = [fetched.date];
            }
          }
        }
      } catch (_) {}
    }
    if ((numDays > 1 || isCustomRange) && availableDates.length < (numDays || 30)) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryRangeFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
          vpsFetcher.fetchBrokerSummaryRangeFromVpsSync(ticker, Math.max(numDays || 30, 30));
          const diskDates = listDiskDates('broker-summary', ticker);
          if (diskDates.length > 0) availableDates = diskDates;
        }
      } catch (_) {}
    }
  }
  let normSummary = null;

  // 1. Multi-day range aggregation from local disk cache
  if (!forceRefresh) {
    if (isCustomRange && availableDates.length > 0) {
      const targetDates = availableDates.filter(d => d >= options.startDate && d <= options.endDate);
      normSummary = targetDates.length > 0 ? aggregateBrokerSummaries(ticker, targetDates, targetDates.length, true) : null;
    } else if (numDays > 1) {
      if (availableDates.length > 1) {
        const targetDates = availableDates.slice(0, numDays);
        normSummary = aggregateBrokerSummaries(ticker, targetDates, numDays);
      } else if (availableDates.length === 1) {
        let diskSummary = readDiskCache('broker-summary', ticker, availableDates[0]);
        if (!diskSummary && hasDiskCache('broker-summary', ticker)) {
          diskSummary = readDiskCache('broker-summary', ticker, 'latest');
        }
        if (!diskSummary) {
          try {
            const vpsFetcher = require('./vps-data-fetcher');
            if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
              diskSummary = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, availableDates[0]);
            }
          } catch (_) {}
        }
        if (diskSummary) {
          normSummary = normalizeBrokerSummary(diskSummary, diskSummary.date || availableDates[0]);
          applyMultiDayScaling(normSummary, null, numDays, diskSummary.date || availableDates[0]);
        } else {
          normSummary = aggregateBrokerSummaries(ticker, availableDates, numDays);
        }
      } else {
        normSummary = aggregateBrokerSummaries(ticker, [], numDays);
      }
    } else if (numDays === 1 && !isCustomRange) {
      if (targetDate && targetDate !== 'latest') {
        let diskSummary = readDiskCache('broker-summary', ticker, targetDate);
        if (!diskSummary) {
          try {
            const vpsFetcher = require('./vps-data-fetcher');
            if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
              const vps = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate);
              if (vps && (vps.date === targetDate || vps.broker_start_date === targetDate)) {
                diskSummary = vps;
              }
            }
          } catch (_) {}
        }
        // Batch 1 (P0): date masquerading removed. This previously read
        // `availableDates[0]` whenever the requested date was missing and then
        // labelled that other snapshot with `targetDate` — so any historical
        // date silently returned today's numbers. A requested date that is not
        // on disk must report not-found, never a different day's data.
        if (!diskSummary && availableDates.includes(targetDate)) {
          diskSummary = readDiskCache('broker-summary', ticker, targetDate);
        }
        if (diskSummary) {
          normSummary = normalizeBrokerSummary(diskSummary, diskSummary.date || targetDate, ticker);
        } else {
          return {
            success: true,
            is_demo: false,
            is_empty: true,
            status: 'NO_DATA',
            not_found: true,
            not_found_reason: 'requested_date_not_available',
            ticker,
            date: targetDate,
            range: '1d',
            available_dates: availableDates,
            broker_summary: {
              date: targetDate,
              range_label: targetDate,
              net_flow: 0,
              net_status: 'NO_DATA',
              net_label: 'Tidak Ada Data',
              is_empty: true,
              status: 'NO_DATA',
              top_buyers: [],
              top_sellers: [],
              gross_buyers: [],
              gross_sellers: [],
              net_buyers: [],
              net_sellers: []
            },
            broker_accumulation: { top_buyers: [], top_sellers: [], net_buyers: [], net_sellers: [], series: [] },
            insiders: resolveTickerInsiders(ticker, null) || []
          };
        }
      } else {
        let diskSummary = null;
        if (availableDates.length > 0) {
          diskSummary = readDiskCache('broker-summary', ticker, availableDates[0]);
        }
        if (!diskSummary) {
          diskSummary = readDiskCache('broker-summary', ticker, 'latest');
        }
        if (!diskSummary && hasDiskCache('broker-summary', ticker)) {
          diskSummary = (availableDates.length > 0 ? readDiskCache('broker-summary', ticker, availableDates[0]) : null);
        }
        if (!diskSummary) {
          try {
            const vpsFetcher = require('./vps-data-fetcher');
            if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
              diskSummary = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, (availableDates.length > 0 ? availableDates[0] : 'latest'));
            }
          } catch (_) {}
        }
        if (diskSummary) {
          const chosenDate = (targetDate && targetDate !== 'latest') ? targetDate : (availableDates.length > 0 ? availableDates[0] : (diskSummary.date || targetDate));
          normSummary = normalizeBrokerSummary(diskSummary, chosenDate, ticker);
        }
      }
    } else if (numDays > 1 && !isCustomRange && !arjumClient.hasArjumApiKey()) {
      let diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
      if (!diskSummary && (!targetDate || targetDate === 'latest') && hasDiskCache('broker-summary', ticker)) {
        diskSummary = readDiskCache('broker-summary', ticker, 'latest') || (availableDates.length > 0 ? readDiskCache('broker-summary', ticker, availableDates[0]) : null);
      }
      if (!diskSummary && (!targetDate || targetDate === 'latest')) {
        try {
          const vpsFetcher = require('./vps-data-fetcher');
          if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
            diskSummary = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'));
          }
        } catch (_) {}
      }
      if (diskSummary) {
        normSummary = normalizeBrokerSummary(diskSummary, diskSummary.date || targetDate, ticker);
      }
    }
  }

  // Custom range must reflect exactly what's on disk for that window — never
  // silently fall back to a single-date live/demo fetch that ignores the
  // range the user picked.
  if (isCustomRange && !normSummary) {
    return {
      success: true,
      is_demo: false,
      ticker,
      date: `${options.startDate} s/d ${options.endDate}`,
      range: 'custom',
      available_dates: availableDates,
      broker_summary: { date: `${options.startDate} s/d ${options.endDate}`, range_label: `Custom (${options.startDate} s/d ${options.endDate})`, net_flow: 0, net_status: 'NO_DATA', net_label: 'Tidak Ada Data', top_buyers: [], top_sellers: [], gross_buyers: [], gross_sellers: [], net_buyers: [], net_sellers: [] },
      broker_accumulation: { series: [] },
      insiders: resolveTickerInsiders(ticker, null)
    };
  }

  let diskAcc = !forceRefresh ? readDiskCache('broker-accumulation', ticker, 'series') : null;
  if (!diskAcc && !forceRefresh) {
    try {
      const vpsFetcher = require('./vps-data-fetcher');
      if (vpsFetcher && typeof vpsFetcher.fetchBrokerAccumulationFromVpsSync === 'function') {
        const vpsAcc = vpsFetcher.fetchBrokerAccumulationFromVpsSync(ticker);
        if (vpsAcc) {
          diskAcc = vpsAcc;
        }
      }
    } catch (_) {}
  }
  let diskInsiders = !forceRefresh ? readDiskCache('insiders', ticker, 'p1') : null;
  if (!diskInsiders && !forceRefresh) {
    try {
      const vpsFetcher = require('./vps-data-fetcher');
      if (vpsFetcher && typeof vpsFetcher.fetchInsidersFromVpsSync === 'function') {
        const vpsIns = vpsFetcher.fetchInsidersFromVpsSync(ticker);
        if (vpsIns) {
          diskInsiders = vpsIns;
        }
      }
    } catch (_) {}
  }

  if (normSummary) {
    // When diskAcc is available with valid brokers, use it; otherwise synthesize from broker_summary
    // so that Akumulasi Broker never renders "Semua (0) | Buyers (0) | Sellers (0)"
    let normAcc = diskAcc ? normalizeBrokerAccumulation(diskAcc, ticker) : null;
    if (!normAcc || ((!normAcc.top_buyers || normAcc.top_buyers.length === 0) && (!normAcc.top_sellers || normAcc.top_sellers.length === 0))) {
      const syn = synthesizeAccumulationFromSummary(normSummary, ticker);
      if (normAcc) {
        normAcc.top_buyers = syn.top_buyers;
        normAcc.top_sellers = syn.top_sellers;
        normAcc.net_buyers = syn.net_buyers;
        normAcc.net_sellers = syn.net_sellers;
        if (!normAcc.series || normAcc.series.length === 0) {
          normAcc.series = syn.series;
          normAcc.daily_summary = syn.daily_summary;
        }
      } else {
        normAcc = syn;
      }
    }
    const normIns = resolveTickerInsiders(ticker, diskInsiders);

    if (numDays > 1 && (!normSummary.range_label || !normSummary.range_label.includes('Hari'))) {
      applyMultiDayScaling(normSummary, normAcc, numDays, targetDate);
    } else if (!normSummary.range_label) {
      normSummary.range_label = normSummary.date ? `Tanggal: ${normSummary.date}` : 'Terbaru';
    }

    // AUDIT-F5-03: the "Riwayat Harian" window must stay inside the range the
    // caller asked for. This guard used to replace ANY window shorter than 24
    // sessions with the full 24-day history series, so a 5D request rendered a
    // "5 Hari Bursa" label above 24 sessions of unrelated flow. The 24-day
    // series is a fallback for a MISSING window, never a replacement for a
    // shorter-but-valid one.
    const dailySeries = buildDailyHistorySeries(ticker, 24);
    if (!normSummary.date_headers || normSummary.date_headers.length === 0) {
      normSummary.date_headers = dailySeries;
    }
    if (normAcc) {
      if (!normAcc.series || normAcc.series.length === 0) {
        normAcc.series = dailySeries;
        normAcc.daily_summary = dailySeries;
      }
    }

    // Never fabricate a date: if neither the disk payload nor the available
    // date list carries one, surface DATE_UNRESOLVED (null) for the UI.
    const resolvedDate = (normSummary && normSummary.range_label) || (targetDate && targetDate !== 'latest' ? targetDate : '') || (normSummary && normSummary.date) || (availableDates.length > 0 ? availableDates[0] : null);
    const combined = {
      is_demo: false,
      ticker,
      date: resolvedDate,
      range: range,
      available_dates: availableDates,
      broker_summary: normSummary,
      broker_accumulation: normAcc,
      insiders: normIns,
      net_flow: normSummary ? (normSummary.net_flow || normSummary.net_flow_formatted) : undefined
    };
    setCache(cacheKey, combined);
    return Object.assign({ success: true, from_disk: true }, combined);
  }

  // Why we ended up on demo data — surfaced to the client so the badge can
  // say something more useful than a generic "DEMO PREVIEW".
  let demoReason = 'no_api_key';
  let demoDetail = '';

  // 2. If API Key is present in environment, query Arjum API for single date
  if (arjumClient.hasArjumApiKey()) {
    demoReason = 'no_disk_cache';
    try {
      const [sumRes, accRes, insRes] = await Promise.all([
        arjumClient.fetchBrokerSummary(ticker, targetDate),
        arjumClient.fetchBrokerAccumulation(ticker),
        arjumClient.fetchInsiders(ticker, 1, 15)
      ]);

      const rawSummary = sumRes.ok ? sumRes.data : null;
      const rawAcc = accRes.ok ? accRes.data : (diskAcc || null);
      const rawIns = insRes.ok ? insRes.data : (diskInsiders || []);

      if (rawSummary || rawAcc) {
        if (sumRes.ok && sumRes.data) {
          writeDiskCache('broker-summary', ticker, targetDate || 'latest', sumRes.data);
        }
        if (accRes.ok && accRes.data) {
          writeDiskCache('broker-accumulation', ticker, 'series', accRes.data);
        }
        if (insRes.ok && insRes.data) {
          writeDiskCache('insiders', ticker, 'p1', rawIns);
        }

        const freshSummary = normalizeBrokerSummary(rawSummary, targetDate);
        let normAcc = normalizeBrokerAccumulation(rawAcc, ticker);
        if ((!normAcc || ((!normAcc.top_buyers || normAcc.top_buyers.length === 0) && (!normAcc.top_sellers || normAcc.top_sellers.length === 0))) && freshSummary) {
          const syn = synthesizeAccumulationFromSummary(freshSummary, ticker);
          if (normAcc) {
            normAcc.top_buyers = syn.top_buyers;
            normAcc.top_sellers = syn.top_sellers;
            normAcc.net_buyers = syn.net_buyers;
            normAcc.net_sellers = syn.net_sellers;
            if (!normAcc.series || normAcc.series.length === 0) {
              normAcc.series = syn.series;
              normAcc.daily_summary = syn.daily_summary;
            }
          } else {
            normAcc = syn;
          }
        }
        const normIns = resolveTickerInsiders(ticker, rawIns);

        if (freshSummary) {
          applyMultiDayScaling(freshSummary, normAcc, numDays, targetDate);
        }

        const payload = {
          is_demo: false,
          ticker,
          date: (freshSummary && freshSummary.range_label) || targetDate || (freshSummary && freshSummary.date) || 'latest',
          range: range,
          available_dates: availableDates,
          broker_summary: freshSummary,
          broker_accumulation: normAcc,
          insiders: normIns
        };
        setCache(cacheKey, payload);
        return Object.assign({ success: true, live: true }, payload);
      }
      // Live call ran but returned nothing usable — classify why, from
      // whichever leg actually failed (broker summary is the primary one).
      const failed = !sumRes.ok ? sumRes : (!accRes.ok ? accRes : insRes);
      const classified = arjumClient.classifyFailure(failed);
      demoReason = classified.reason;
      demoDetail = classified.detail;
    } catch (err) {
      demoReason = 'network_error';
      demoDetail = err && err.message ? err.message : String(err);
    }
  }

  // 2.5 Try on-demand VPS single-date fetch before falling back to demo
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    const vpsRaw = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate || 'latest');
    const vpsDate = vpsRaw && (vpsRaw.date || vpsRaw.broker_start_date);
    const dateMatches = !targetDate || targetDate === 'latest' || vpsDate === targetDate;
    if (vpsRaw && (vpsRaw.brokers || vpsRaw.stock_code) && dateMatches) {
      const freshSummary = normalizeBrokerSummary(vpsRaw, targetDate || vpsRaw.date);
      let normAcc = synthesizeAccumulationFromSummary(freshSummary, ticker);
      const normIns = resolveTickerInsiders(ticker, null);
      if (freshSummary) {
        applyMultiDayScaling(freshSummary, normAcc, numDays, targetDate);
      }
      const payload = {
        is_demo: false,
        ticker,
        date: (freshSummary && freshSummary.range_label) || targetDate || (freshSummary && freshSummary.date) || 'latest',
        range: range,
        available_dates: availableDates.length > 0 ? availableDates : (vpsRaw.date ? [vpsRaw.date] : getDynamicTradingDays(10)),
        broker_summary: freshSummary,
        broker_accumulation: normAcc,
        insiders: normIns
      };
      setCache(cacheKey, payload);
      return Object.assign({ success: true, live: true, from_vps_tunnel: true }, payload);
    }
  } catch (_) {}

  // 3. Fallback: Return honest empty payload when upstream data is unavailable
  const emptyPayload = {
    success: true,
    is_demo: false,
    is_empty: true,
    status: 'NO_DATA',
    gross_buyers: [],
    gross_sellers: [],
    top_buyers: [],
    top_sellers: [],
    is_offline: true,
    demo_reason: 'no_data',
    demo_detail: demoDetail || 'Tidak ada data transaksi broker summary untuk tanggal ini (Pasar tutup / data belum tersedia)',
    ticker,
    date: targetDate || (numDays > 1 ? `${numDays} Hari Bursa` : 'latest'),
    range: range,
    available_dates: availableDates.length > 0 ? availableDates : [],
    broker_summary: {
      date: targetDate || (numDays > 1 ? `${numDays} Hari Bursa` : 'latest'),
      range_label: numDays > 1 ? `${numDays} Hari Bursa (${targetDate || 'Terbaru'})` : (targetDate || 'latest'),
      net_flow: 0,
      net_status: 'NO_DATA',
      net_label: 'Tidak Ada Data',
      is_empty: true,
      status: 'NO_DATA',
      top_buyers: [],
      top_sellers: [],
      gross_buyers: [],
      gross_sellers: [],
      net_buyers: [],
      net_sellers: []
    },
    broker_accumulation: {
      top_buyers: [],
      top_sellers: [],
      net_buyers: [],
      net_sellers: [],
      series: []
    },
    insiders: resolveTickerInsiders(ticker, null) || []
  };
  setCache(cacheKey, emptyPayload, 60 * 1000);
  return emptyPayload;
}

/**
 * Is this process running on the read-only deployed runtime (Vercel) rather
 * than a developer machine / VPS worker with its own data directory?
 */
function isDeployedRuntime() {
  return String(process.env.VERCEL || '') === '1';
}

/**
 * Available trading dates for a ticker.
 *
 * Batch 2: the local directory listing is NOT the source of truth on a deployed
 * instance — it only holds whatever was uploaded/synced there, so a partial
 * deployment produced a one-option dropdown while the bridge held the full
 * history. When deployed, the bridge's master list wins and the local listing is
 * only a fallback for when the bridge is unreachable.
 */
async function getAvailableDates(ticker) {
  const diskDates = listDiskDates('broker-summary', ticker);

  if (isDeployedRuntime()) {
    try {
      const vpsFetcher = require('./vps-data-fetcher');
      const bridgeDates = typeof vpsFetcher.fetchAvailableDatesFromVpsBridgeSync === 'function'
        ? vpsFetcher.fetchAvailableDatesFromVpsBridgeSync(ticker)
        : await vpsFetcher.fetchAvailableDatesFromVps(ticker);
      if (Array.isArray(bridgeDates) && bridgeDates.length > 0) {
        return bridgeDates;
      }
    } catch (err) {
      console.warn(`[BANDARMOLOGI][WARN] bridge date list unavailable for ${ticker}: ${err.message}`);
    }
    return diskDates;
  }

  if (diskDates.length > 0) return diskDates;
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    const vDates = await vpsFetcher.fetchAvailableDatesFromVps(ticker);
    if (vDates.length > 0) return vDates;
  } catch (err) {
    console.warn(`[BANDARMOLOGI][WARN] VPS date list unavailable for ${ticker}: ${err.message}`);
  }
  return [];
}

/**
 * Read authentic net foreign flow directly from local Arjum daily snapshot on disk.
 * Strictly local disk cache, no manual upload endpoint needed.
 */
function getNetForeignFlow(ticker, date = 'latest') {
  if (!ticker) return null;
  const clean = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;

  let norm = null;
  const raw = readDiskCache('broker-summary', clean, date);
  if (raw) {
    norm = normalizeBrokerSummary(raw, date, clean);
  }

  if (!norm && (date === 'latest' || !date)) {
    const dates = listDiskDates('broker-summary', clean);
    if (dates && dates.length > 0) {
      const latestRaw = readDiskCache('broker-summary', clean, dates[0]);
      if (latestRaw) {
        norm = normalizeBrokerSummary(latestRaw, dates[0], clean);
      }
    }
  }

  if (!norm) {
    // AUDIT-F6-02c: tanpa snapshot, `foreign_flow_status` dulu mengembalikan
    // 'NEUTRAL' — sebuah VERDIK pasar (net seimbang) padahal yang sebenarnya
    // terjadi adalah tidak ada data sama sekali. Dua keadaan itu harus dapat
    // dibedakan oleh konsumen; 'NO_DATA' dipakai untuk yang kedua, dan
    // has_data:false tetap menjadi penanda utamanya.
    return {
      ticker: clean,
      date: null,
      foreign_buy: 0,
      foreign_sell: 0,
      foreign_net: 0,
      foreign_flow_status: 'NO_DATA',
      is_massive_distribution: false,
      is_massive_accumulation: false,
      net_flow: 0,
      whale_status: 'NO_DATA',
      has_data: false
    };
  }

  const foreignBuy = Number(norm.foreign_buy || 0);
  const foreignSell = Number(norm.foreign_sell || 0);
  const foreignNetRaw = norm.foreign_net != null ? Number(norm.foreign_net) : null;
  const foreignNet = Number.isFinite(foreignNetRaw) ? foreignNetRaw : (foreignBuy - foreignSell);
  // AUDIT-F6-03b: rasio buy/sell hanya bermakna bila KEDUA sisi punya nilai.
  // Guard `foreignSell > 0` / `foreignBuy > 0` di bawah sudah mencegah
  // pembagian dengan nol; keduanya dipertahankan eksplisit agar rasio tidak
  // pernah dievaluasi pada sisi yang nol (0/0 => NaN => perbandingan false
  // yang menyamar sebagai "bukan distribusi").
  const isMassiveDist = (foreignNet < -2000000000) || (foreignSell > 0 && foreignBuy / foreignSell < 0.25 && foreignNet < -500000000) || (norm.net_status === 'BIG_DISTRIBUTION' && foreignNet < 0);
  const isMassiveAcc = (foreignNet > 2000000000) || (foreignBuy > 0 && foreignSell / foreignBuy < 0.25 && foreignNet > 500000000) || (norm.net_status === 'BIG_ACCUMULATION' && foreignNet > 0);

  return {
    ticker: clean,
    date: norm.date,
    foreign_buy: foreignBuy,
    foreign_sell: foreignSell,
    foreign_net: foreignNet,
    foreign_flow_status: foreignNet > 0 ? 'ACCUMULATION' : (foreignNet < 0 ? 'DISTRIBUTION' : 'NEUTRAL'),
    is_massive_distribution: isMassiveDist,
    is_massive_accumulation: isMassiveAcc,
    net_flow: norm.net_flow || 0,
    whale_status: norm.net_status || 'NEUTRAL',
    has_data: true
  };
}

/**
 * Confluence Bandarmologi & Foreign Flow Arjum:
 * Evaluates foreign flow & whale accumulation confirmation.
 * If breakout teknikal terjadi namun asing dan bandar melakukan net distribution masif,
 * beri flag HINDARI / DOWNGGRADE_GRADE.
 */
function evaluateConfluenceSignal(ticker, options = {}) {
  const foreignInfo = getNetForeignFlow(ticker, options.date || 'latest');
  if (!foreignInfo || !foreignInfo.has_data) {
    return {
      confluence_flag: 'NEUTRAL',
      confluence_action: 'HOLD',
      confluence_penalty: 0,
      is_massive_distribution: false,
      foreign_net: 0,
      bandar_net: 0,
      notes: 'Data bandarmologi / foreign flow Arjum lokal belum tersedia.'
    };
  }

  const isDist = foreignInfo.is_massive_distribution;
  const isWhaleDist = foreignInfo.whale_status === 'BIG_DISTRIBUTION' || foreignInfo.net_flow < -3000000000;

  if (isDist || (isWhaleDist && foreignInfo.foreign_net < 0)) {
    return {
      confluence_flag: 'HINDARI',
      confluence_action: 'DOWNGGRADE_GRADE',
      confluence_penalty: -20,
      is_massive_distribution: true,
      foreign_net: foreignInfo.foreign_net,
      bandar_net: foreignInfo.net_flow,
      notes: `Asing dan bandar net distribution masif (Net Foreign: ${(foreignInfo.foreign_net / 1e9).toFixed(2)}M, Net Bandar: ${(foreignInfo.net_flow / 1e9).toFixed(2)}M).`
    };
  }

  if (foreignInfo.is_massive_accumulation && foreignInfo.whale_status === 'BIG_ACCUMULATION') {
    return {
      confluence_flag: 'CONFIRMED',
      confluence_action: 'UPGRADE_GRADE',
      confluence_penalty: 5,
      is_massive_distribution: false,
      foreign_net: foreignInfo.foreign_net,
      bandar_net: foreignInfo.net_flow,
      notes: `Asing dan bandar konfirmasi akumulasi (Net Foreign: +${(foreignInfo.foreign_net / 1e9).toFixed(2)}M, Net Bandar: +${(foreignInfo.net_flow / 1e9).toFixed(2)}M).`
    };
  }

  return {
    confluence_flag: 'NEUTRAL',
    confluence_action: 'HOLD',
    confluence_penalty: 0,
    is_massive_distribution: false,
    foreign_net: foreignInfo.foreign_net,
    bandar_net: foreignInfo.net_flow,
    notes: 'Arjum foreign flow seimbang / normal.'
  };
}

module.exports = {
  getBandarmologiData,
  getAvailableDates,
  generateDemoData,
  getEffectiveTradingDate,
  getDynamicTradingDays,
  getStorageDir,
  readDiskCache,
  hasDiskCache,
  writeDiskCache,
  listDiskDates,
  aggregateBrokerSummaries,
  aggregateMultiDayBrokerSummary: aggregateBrokerSummaries,
  filterCalendarWindowDates,
  applyMultiDayScaling,
  normalizeBrokerSummary,
  enrichBrokerItem,
  normalizeBrokerAccumulation,
  synthesizeAccumulationFromSummary,
  normalizeInsiders,
  normalizeVwapPrice,
  getReferencePrice,
  calculateScannerDiscount,
  buildDailyHistorySeries,
  getNetForeignFlow,
  evaluateConfluenceSignal,
  get insiderNetworkService() { return require('./insider-network-service'); },
  get buildInsiderNetworkGraph() { return require('./insider-network-service').buildInsiderNetworkGraph; },
  get searchInsiders() { return require('./insider-network-service').searchInsiders; },
  get getInsiderProfile() { return require('./insider-network-service').getInsiderProfile; }
};

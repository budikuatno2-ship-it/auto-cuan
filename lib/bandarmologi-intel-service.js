'use strict';

/**
 * Bandarmologi Intelligence Service
 *
 * Pre-calculates and surfaces 4 advanced Bandarmologi intelligence signals:
 * 1. Harga di Bawah Modal Bandar (Current Price <= Avg Buy Top 3 Broker)
 * 2. Silent Foreign Accumulation (Net Foreign Buy positive 3-5 days + Sideways <= 2%)
 * 3. Ritel Cutloss vs Bandar Nampung (Top 3 Seller dominated by Retail & Top 3 Buyer dominated by Inst/Foreign, + reverse)
 * 4. Concentration Ratio (CR3 & CR5 >= 60% Akumulasi Masif)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const bandarmologiService = require('./bandarmologi-service');
const arjumClient = require('./arjum-client');
const { formatJakartaDate } = require('./chart-t1-policy');
const { isValidIdxTicker } = require('./idx-ticker');

const ARJUM_BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');

// Batch 2: every intel storage location is resolved per call and is overridable,
// so an operator (or a test) can redirect it without reloading the module. These
// used to be import-time constants, which made the serving path impossible to
// isolate — a leftover file in a machine-global directory silently turned a
// "nothing available" case into a "served stale data" case.
function getIntelCacheDir() {
  return process.env.INTEL_CACHE_DIR || path.join(ARJUM_BASE_DIR, 'bandarmologi-intel');
}
function getPersistentIntelIndexDir() {
  return process.env.INTEL_INDEX_DIR || path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes');
}
function getTmpIntelCacheDir() {
  return process.env.INTEL_TMP_DIR || path.join(os.tmpdir(), 'bandarmologi-intel');
}
const INTEL_CACHE_DIR = getIntelCacheDir();
const PERSISTENT_INTEL_INDEX_DIR = getPersistentIntelIndexDir();
const TMP_INTEL_CACHE_DIR = getTmpIntelCacheDir();


const RETAIL_BROKERS = new Set(['YP', 'PD', 'XC', 'XL', 'NI']);
const INSTITUTIONAL_BROKERS = new Set(['AK', 'BK', 'RX', 'CC', 'KZ', 'ZP', 'CS', 'DB']);
const FOREIGN_BROKERS = new Set(['AK', 'BK', 'RX', 'KZ', 'ZP', 'CS', 'DB']);

const BROKER_NAMES = {
  'YP': 'Mirae Asset Sekuritas Indonesia',
  'CC': 'Mandiri Sekuritas',
  'PD': 'Indo Premier Sekuritas',
  'NI': 'BNI Sekuritas',
  'BK': 'J.P. Morgan Sekuritas Indonesia',
  'AK': 'UBS Sekuritas Indonesia',
  'CS': 'Credit Suisse Sekuritas Indonesia',
  'RX': 'Macquarie Sekuritas Indonesia',
  'KZ': 'CLSA Sekuritas Indonesia',
  'ZP': 'Maybank Sekuritas Indonesia',
  'XC': 'Ajaib Sekuritas Asia',
  'XL': 'Stockbit Sekuritas',
  'CP': 'KB Valbury Sekuritas',
  'GR': 'Panin Sekuritas',
  'MG': 'Semesta Indovest Sekuritas',
  'OD': 'BRI Danareksa Sekuritas',
  'LG': 'Trimegah Sekuritas Indonesia',
  'KI': 'Ciptadana Sekuritas Asia',
  'KK': 'Phillip Sekuritas Indonesia',
  'SQ': 'BCA Sekuritas',
  'AI': 'UOB Kay Hian Sekuritas',
  'YU': 'CGS International Sekuritas',
  'FS': 'Yuanta Sekuritas Indonesia',
  'BQ': 'Korea Investment and Sekuritas',
  'DR': 'RHB Sekuritas Indonesia',
  'DH': 'Sinarmas Sekuritas',
  'AZ': 'Sucor Sekuritas',
  'EP': 'MNC Sekuritas',
  'HD': 'KGI Sekuritas Indonesia',
  'AN': 'Wanteg Sekuritas',
  'RG': 'Profindo Sekuritas Indonesia',
  'IF': 'Samuel Sekuritas Indonesia'
};

const BROKER_HUNTER_INDEX_DIR = path.join(__dirname, '..', 'data', 'broker-hunter-indexes');

function getBrokerFullName(code) {
  if (!code) return 'Unknown Broker';
  const c = String(code).trim().toUpperCase();
  return BROKER_NAMES[c] || `Broker ${c}`;
}

function ensureDirExists(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function safeWriteJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    ensureDirExists(dir);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (_) {
    // If target directory is strictly read-only (e.g. Vercel Serverless /var/task),
    // redirect write to system /tmp directory so no exception is thrown
    try {
      const fileName = path.basename(filePath);
      const tmpFile = path.join(TMP_INTEL_CACHE_DIR, fileName);
      ensureDirExists(TMP_INTEL_CACHE_DIR);
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }
}

function loadCachedIntel(range) {
  const cleanRange = range ? String(range).trim().toLowerCase() : '';
  const indexDir = getPersistentIntelIndexDir();
  const cacheDir = getIntelCacheDir();
  const tmpDir = getTmpIntelCacheDir();
  const candidatePaths = [];
  if (cleanRange) {
    candidatePaths.push(
      path.join(indexDir, `latest_${cleanRange}.json`),
      path.join(indexDir, `catalog_${cleanRange}.json`),
      path.join(cacheDir, `latest_${cleanRange}.json`),
      path.join(tmpDir, `latest_${cleanRange}.json`)
    );
  }
  candidatePaths.push(
    path.join(indexDir, 'latest.json'),
    path.join(indexDir, 'catalog.json'),
    path.join(cacheDir, 'latest.json'),
    path.join(tmpDir, 'latest.json')
  );
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && (parsed.indexes || parsed.tickers)) {
          return parsed;
        }
      }
    } catch (_) {}
  }
  return null;
}


const HUNTER_TICKER_MAP_CACHE = new Map();

function getHunterTickerMap(range = '7d') {
  const cleanRange = String(range || '7d').toLowerCase();
  if (HUNTER_TICKER_MAP_CACHE.has(cleanRange)) {
    return HUNTER_TICKER_MAP_CACHE.get(cleanRange);
  }

  // Base range file to read from disk and proportionality scale factor
  let baseRange = '7d';
  let scale = 1.0;
  let targetDayCount = 7;
  if (cleanRange === '1d') {
    baseRange = '1d';
    scale = 1.0;
    targetDayCount = 1;
  } else if (cleanRange === '5d') {
    baseRange = '7d';
    scale = 5 / 7;
    targetDayCount = 5;
  } else if (cleanRange === '7d') {
    baseRange = '7d';
    scale = 1.0;
    targetDayCount = 7;
  } else if (cleanRange === '14d') {
    baseRange = '7d';
    scale = 14 / 7;
    targetDayCount = 14;
  } else if (cleanRange === '30d') {
    baseRange = '30d';
    scale = 1.0;
    targetDayCount = 30;
  } else if (cleanRange === '60d') {
    baseRange = '30d';
    scale = 2.0;
    targetDayCount = 60;
  }

  const tickerMap = new Map();
  try {
    if (!fs.existsSync(BROKER_HUNTER_INDEX_DIR)) return tickerMap;
    const suffix = `_${baseRange}.json`;
    const files = fs.readdirSync(BROKER_HUNTER_INDEX_DIR).filter(f => f.endsWith(suffix));
    let targetDates = [];

    for (const f of files) {
      try {
        const filePath = path.join(BROKER_HUNTER_INDEX_DIR, f);
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!targetDates.length && Array.isArray(d.target_dates)) {
          targetDates = d.target_dates;
        }
        const bCode = d.broker;
        const bName = d.broker_name || getBrokerFullName(bCode);

        for (const acc of (d.top_accumulated || [])) {
          if (!acc || !acc.ticker) continue;
          const t = acc.ticker.toUpperCase();
          if (!tickerMap.has(t)) {
            tickerMap.set(t, { buyers: [], sellers: [], target_dates: targetDates });
          }
          const bVal = Math.round(Number(acc.buy_val || 0) * scale);
          const sVal = Math.round(Number(acc.sell_val || 0) * scale);
          const bVol = Math.round(Number(acc.buy_vol || 0) * scale);
          const sVol = Math.round(Number(acc.sell_vol || 0) * scale);
          const netVal = Math.round(Number(acc.net_val || 0) * scale);
          const netVol = Math.round(Number(acc.net_vol || 0) * scale);
          const avgBuy = (bVal > 0 && bVol > 0) ? Math.round(bVal / bVol) : Number(acc.avg_buy_price || 0);

          tickerMap.get(t).buyers.push({
            broker: bCode,
            broker_name: bName,
            bval: bVal,
            buy_val: bVal,
            sval: sVal,
            sell_val: sVal,
            bvol: bVol,
            buy_vol: bVol,
            svol: sVol,
            sell_vol: sVol,
            avg_price: avgBuy,
            avg_buy: avgBuy,
            avg_buy_price: avgBuy,
            net_val: netVal,
            net_vol: netVol
          });
        }

        for (const dist of (d.top_distributed || [])) {
          if (!dist || !dist.ticker) continue;
          const t = dist.ticker.toUpperCase();
          if (!tickerMap.has(t)) {
            tickerMap.set(t, { buyers: [], sellers: [], target_dates: targetDates });
          }
          const bVal = Math.round(Number(dist.buy_val || 0) * scale);
          const sVal = Math.round(Number(dist.sell_val || 0) * scale);
          const bVol = Math.round(Number(dist.buy_vol || 0) * scale);
          const sVol = Math.round(Number(dist.sell_vol || 0) * scale);
          const netVal = Math.round(Number(dist.net_val || 0) * scale);
          const netVol = Math.round(Number(dist.net_vol || 0) * scale);
          const avgSell = (sVal > 0 && sVol > 0) ? Math.round(sVal / sVol) : Number(dist.avg_sell_price || 0);

          tickerMap.get(t).sellers.push({
            broker: bCode,
            broker_name: bName,
            bval: bVal,
            buy_val: bVal,
            sval: sVal,
            sell_val: sVal,
            bvol: bVol,
            buy_vol: bVol,
            svol: sVol,
            sell_vol: sVol,
            avg_price: avgSell,
            avg_sell: avgSell,
            avg_sell_price: avgSell,
            net_val: netVal,
            net_vol: netVol
          });
        }
      } catch (_) {}
    }

    let finalDates = targetDates;
    if (targetDates.length > targetDayCount) {
      finalDates = targetDates.slice(0, targetDayCount);
    } else if (targetDates.length < targetDayCount && typeof bandarmologiService.getDynamicTradingDays === 'function') {
      finalDates = bandarmologiService.getDynamicTradingDays(targetDayCount);
    }

    for (const data of tickerMap.values()) {
      data.buyers.sort((a, b) => b.buy_val - a.buy_val);
      data.sellers.sort((a, b) => b.sell_val - a.sell_val);
      data.target_dates = finalDates;
    }

    if (tickerMap.size > 0) {
      HUNTER_TICKER_MAP_CACHE.set(cleanRange, tickerMap);
    }
  } catch (_) {}
  return tickerMap;
}

function getBrokersFromHunterIndexes(ticker, range = '7d') {
  const cleanTicker = String(ticker || '').trim().toUpperCase();
  const cleanRange = String(range || '7d').toLowerCase();
  const tickerMap = getHunterTickerMap(cleanRange);
  const data = tickerMap.get(cleanTicker);
  if (!data) return null;

  return {
    ticker: cleanTicker,
    range: cleanRange,
    target_dates: data.target_dates || [],
    top_buyers: data.buyers,
    top_sellers: data.sellers,
    gross_buyers: data.buyers,
    gross_sellers: data.sellers
  };
}

// PR4: derive a same-day VWAP/close estimate from the newest broker-summary on
// disk. The broker-summary feed has no explicit close field, but each broker
// row carries bval/bvol (buy value / buy volume in lots), so a volume-weighted
// average of buy price across all listed brokers is the freshest market price
// we actually have for the most recent trading day.
function deriveCloseFromLatestBrokerSummary(ticker) {
  try {
    const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return null;
    const dates = bandarmologiService.listDiskDates('broker-summary', clean);
    if (!dates || dates.length === 0) return null;
    const raw = bandarmologiService.readDiskCache('broker-summary', clean, dates[0]);
    const norm = bandarmologiService.normalizeBrokerSummary(raw, dates[0], clean);
    if (!norm) return null;
    const rows = (norm.gross_buyers && norm.gross_buyers.length ? norm.gross_buyers : norm.brokers) || [];
    let sumVal = 0;
    let sumVol = 0;
    for (const b of rows) {
      const bval = Number(b.bval || b.buy_val || b.val || 0);
      const bvol = Number(b.bvol || b.buy_vol || b.vol || 0); // shares
      if (bval > 0 && bvol > 0) {
        sumVal += bval;
        // bvol in this feed is already share-count (bval/bvol ≈ traded price,
        // e.g. 6464 for BBCA 2026-09-11), so do NOT multiply by 100.
        sumVol += bvol;
      }
    }
    if (sumVal > 0 && sumVol > 0) {
      const vwap = sumVal / sumVol;
      if (isFinite(vwap) && vwap > 0) return Math.round(vwap);
    }
  } catch (_) {}
  return null;
}

/**
 * Local-only price ladder (OHLCV candle -> known baseline -> broker-summary VWAP
 * -> reference price). Batch 2 renamed this from getCachedClosePrice; the public
 * accessor now consults the LIVE bridge first (see getCachedClosePriceDetail).
 */
function getCachedClosePriceLegacy(ticker) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;

  const knownPrice = bandarmologiService.KNOWN_TICKER_PRICES && bandarmologiService.KNOWN_TICKER_PRICES[clean];

  // 1. Check authentic OHLCV candle cache (reflects freshest market trading quote)
  try {
    const candidatePaths = [
      path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache', `${clean}.json`),
      path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`)
    ];
    let ohlcvPath = candidatePaths.find(p => fs.existsSync(p));
    if (!ohlcvPath) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchOhlcvFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
          vpsFetcher.fetchOhlcvFromVpsSync(clean);
        }
      } catch (_) {}
      ohlcvPath = candidatePaths.find(p => fs.existsSync(p));
    }
    if (ohlcvPath && fs.existsSync(ohlcvPath)) {
      const data = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const candles = data && data.candles;
      if (Array.isArray(candles) && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const cPrice = Number(lastCandle && (lastCandle.close != null ? lastCandle.close : lastCandle.c));
        // PR4: reject a stale candle. If the candle's own date predates the most
        // recent broker-summary trading day, it is not "current" — skip it and
        // fall through to the broker-summary-derived price below. This is the
        // fix for CUAN/PTRO showing the 2026-07-17 close (630 / 4080) while the
        // latest traded day on disk is 2026-09-11.
        let staleCandle = false;
        try {
          const candleDate = lastCandle && (lastCandle.date || (lastCandle.time ? formatJakartaDate(new Date(lastCandle.time * 1000)) : null));
          const bsDates = bandarmologiService.listDiskDates('broker-summary', clean);
          if (candleDate && bsDates && bsDates.length > 0 && candleDate < bsDates[0]) {
            staleCandle = true;
          }
        } catch (_) {}
        if (cPrice > 0 && !staleCandle) {
          // If known baseline price exists, verify candle is not an extreme outlier (>35% deviation)
          if (knownPrice) {
            const dev = Math.abs(cPrice - knownPrice) / knownPrice;
            if (dev <= 0.35) {
              return cPrice;
            }
          } else {
            return cPrice;
          }
        }
      }
    }
  } catch (_) {}

  // 2. Reference price fallback from known tickers
  if (knownPrice && knownPrice > 0) {
    return knownPrice;
  }

  // 3. PR4: freshest same-day price from the newest broker-summary on disk.
  // Runs BEFORE the single-broker VWAP below — it weights across all brokers.
  const summaryVwap = deriveCloseFromLatestBrokerSummary(clean);
  if (summaryVwap && summaryVwap > 0) {
    return summaryVwap;
  }

  // 4. Fall back to broker summary VWAP (top buyer only) if available
  try {
    const availableDates = bandarmologiService.listDiskDates('broker-summary', clean);
    if (availableDates && availableDates.length > 0) {
      const raw = bandarmologiService.readDiskCache('broker-summary', clean, availableDates[0]);
      const norm = bandarmologiService.normalizeBrokerSummary(raw, availableDates[0], clean);
      if (norm && norm.top_buyers && norm.top_buyers.length > 0) {
        const topB = norm.top_buyers[0];
        const p = Number(topB.avg_price || topB.avg_buy || (topB.bvol > 0 ? Math.round(topB.bval / topB.bvol) : 0));
        if (p > 0) return p;
      }
    }
  } catch (_) {}

  // 5. Reference price fallback from bandarmologiService
  try {
    const ref = bandarmologiService.getReferencePrice(clean);
    if (ref && ref > 0) return ref;
  } catch (_) {}

  return null;
}

let __lastPriceProvenance = null;

/**
 * Batch 2: price WITH provenance.
 *
 * A live price from the VPS bridge is authoritative — it is the price market
 * participants actually traded. The local candle cache is only consulted when
 * the bridge has nothing, because that cache is exactly the artefact that made
 * the scanner quote 630 for CUAN instead of 914.
 *
 * @returns {{price: number, as_of_date: string|null, price_source: string}|null}
 */
function getCachedClosePriceDetail(ticker) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;

  let bridgeDetail = null;
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    if (vpsFetcher && typeof vpsFetcher.fetchLivePriceFromVpsSync === 'function') {
      bridgeDetail = vpsFetcher.fetchLivePriceFromVpsSync(clean);
    }
  } catch (err) {
    console.warn(`[INTEL][WARN] live bridge price unavailable for ${clean}: ${err.message}`);
  }

  if (bridgeDetail && bridgeDetail.price > 0) {
    const detail = {
      price: bridgeDetail.price,
      as_of_date: bridgeDetail.as_of_date || null,
      price_source: 'vps_bridge_live'
    };
    __lastPriceProvenance = Object.assign({ ticker: clean }, detail);
    return detail;
  }

  const local = getCachedClosePriceLegacy(clean);
  if (local && local > 0) {
    const detail = {
      price: local,
      as_of_date: null,
      price_source: 'local_cache'
    };
    __lastPriceProvenance = Object.assign({ ticker: clean }, detail);
    return detail;
  }

  __lastPriceProvenance = null;
  return null;
}

function getCachedClosePrice(ticker) {
  const detail = getCachedClosePriceDetail(ticker);
  return detail ? detail.price : null;
}

function loadUniverseTickers() {
  const tickers = new Set();
  try {
    if (fs.existsSync(BROKER_HUNTER_INDEX_DIR)) {
      const tickerMap = getHunterTickerMap('7d');
      for (const t of tickerMap.keys()) {
        tickers.add(t);
      }
    }
  } catch (_) {}

  try {
    const sumDir = path.join(ARJUM_BASE_DIR, 'broker-summary');
    if (fs.existsSync(sumDir)) {
      fs.readdirSync(sumDir).filter(isValidIdxTicker).forEach(t => tickers.add(t));
    }
  } catch (_) {}

  if (tickers.size === 0) {
    try {
      const dbTickers = db.all('SELECT DISTINCT ticker FROM intraday_screener_runs ORDER BY ticker LIMIT 100');
      if (dbTickers && dbTickers.length > 0) {
        dbTickers.forEach(r => tickers.add(r.ticker));
      }
    } catch (_) {}
  }

  return Array.from(tickers).sort();
}

/**
 * Signal 1: Harga di Bawah Modal Bandar (Buy Broker Average)
 * Triggered when current close price is lower than the volume-weighted average buy price of Top 3 Net Buyers.
 * Sweet spot: 0.0% < discount <= 5.0%.
 */
function detectPriceBelowBandarCost(ticker, options = {}) {
  const range = options.range || '7d';
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[String(range).toLowerCase()] || (parseInt(range, 10) || 7);

  let top3 = [];
  const candidateBrokers = (options.brokerSummary && (options.brokerSummary.net_buyers || options.brokerSummary.top_buyers)) || [];
  const validAccumulators = candidateBrokers.filter(b => {
    const net = Number(b.net_val != null ? b.net_val : (b.nval != null ? b.nval : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0))));
    return net > 0;
  }).sort((a, b) => {
    const netA = Number(a.net_val != null ? a.net_val : (a.nval || 0));
    const netB = Number(b.net_val != null ? b.net_val : (b.nval || 0));
    return netB - netA;
  });

  if (validAccumulators.length > 0) {
    top3 = validAccumulators.slice(0, 3);
  } else {
    try {
      const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
      if (availableDates && availableDates.length > 0) {
        const validDates = typeof bandarmologiService.filterCalendarWindowDates === 'function'
          ? bandarmologiService.filterCalendarWindowDates(availableDates, numDays)
          : availableDates.slice(0, numDays);
        const datesToUse = validDates.length > 0 ? validDates.slice(0, numDays) : availableDates.slice(0, numDays);
        if (datesToUse.length > 0) {
          const agg = datesToUse.length > 1
            ? bandarmologiService.aggregateBrokerSummaries(ticker, datesToUse, numDays)
            : bandarmologiService.normalizeBrokerSummary(bandarmologiService.readDiskCache('broker-summary', ticker, datesToUse[0]), datesToUse[0], ticker);
          const aggBuyers = (agg && (agg.net_buyers || agg.top_buyers)) || [];
          const aggAcc = aggBuyers.filter(b => {
            const net = Number(b.net_val != null ? b.net_val : (b.nval != null ? b.nval : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0))));
            return net > 0;
          }).sort((a, b) => {
            const netA = Number(a.net_val != null ? a.net_val : (a.nval || 0));
            const netB = Number(b.net_val != null ? b.net_val : (b.nval || 0));
            return netB - netA;
          });
          if (aggAcc.length > 0) {
            top3 = aggAcc.slice(0, 3);
          }
        }
      }
    } catch (_) {}
  }

  if (top3.length === 0) {
    const hunterData = getBrokersFromHunterIndexes(ticker, range);
    if (hunterData && Array.isArray(hunterData.top_buyers) && hunterData.top_buyers.length > 0) {
      const hunterAcc = hunterData.top_buyers.filter(b => {
        const net = Number(b.net_val != null ? b.net_val : (b.nval != null ? b.nval : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0))));
        return net > 0;
      }).sort((a, b) => {
        const netA = Number(a.net_val != null ? a.net_val : (a.nval || 0));
        const netB = Number(b.net_val != null ? b.net_val : (b.nval || 0));
        return netB - netA;
      });
      if (hunterAcc.length > 0) {
        top3 = hunterAcc.slice(0, 3);
      }
    }
  }

  if (top3.length === 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      reason: 'NO_DATA'
    };
  }

  let currentPrice = Number(options.currentPrice || options.price || options.close || 0);
  if (!currentPrice || currentPrice <= 0) {
    const clean = String(ticker || '').toUpperCase().trim();
    const candidatePaths = [
      path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`),
      path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache', `${clean}.json`)
    ];
    // PR4: same stale-candle guard as getCachedClosePrice — a candle whose own
    // date predates the newest broker-summary trading day is not "current", so
    // it must not become `currentPrice` (the source of CUAN 630 / PTRO 4080).
    let bsLatest = [];
    try { bsLatest = bandarmologiService.listDiskDates('broker-summary', clean) || []; } catch (_) {}
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const ohlcv = JSON.parse(fs.readFileSync(p, 'utf8'));
          const candles = ohlcv && ohlcv.candles;
          if (Array.isArray(candles) && candles.length > 0) {
            const last = candles[candles.length - 1];
            const candleDate = last && (last.date || (last.time ? formatJakartaDate(new Date(last.time * 1000)) : null));
            if (candleDate && bsLatest.length > 0 && candleDate < bsLatest[0]) {
              // stale — skip this cache file
              currentPrice = 0;
              continue;
            }
            currentPrice = Number(last.close || 0);
            if (currentPrice > 0) break;
          }
        } catch (_) {}
      }
    }
  }
  if (!currentPrice || currentPrice <= 0) {
    currentPrice = getCachedClosePrice(ticker);
  }

  const refPrice = currentPrice > 0 ? currentPrice : bandarmologiService.getReferencePrice(ticker);

  const formatTopBroker = b => {
    const bVal = Number(b.buy_val || b.bval || 0);
    const bVol = Number(b.buy_vol || b.bvol || 0);
    let p = 0;
    if (b.avg_price && b.avg_price > 0) {
      p = bandarmologiService.normalizeVwapPrice(b.avg_price, refPrice);
    } else if (b.avg_buy && b.avg_buy > 0) {
      p = bandarmologiService.normalizeVwapPrice(b.avg_buy, refPrice);
    } else if (bVal > 0 && bVol > 0) {
      const pLot = Math.round(bVal / (bVol * 100));
      const pShare = Math.round(bVal / bVol);
      if (refPrice > 0) {
        p = (Math.abs(pLot - refPrice) < Math.abs(pShare - refPrice)) ? pLot : pShare;
      } else if (pLot >= 50 && pLot <= 200000) {
        p = pLot;
      } else {
        p = pShare;
      }
      p = bandarmologiService.normalizeVwapPrice(p, refPrice);
    } else if (b.bavg && b.bavg > 0) {
      p = bandarmologiService.normalizeVwapPrice(b.bavg, refPrice);
    }
    return {
      broker: b.broker || b.broker_code,
      broker_name: b.broker_name || getBrokerFullName(b.broker || b.broker_code),
      buy_val: bVal,
      buy_vol: bVol,
      avg_price: p,
      avg_buy: p
    };
  };

  const top3Formatted = top3.map(formatTopBroker);
  let totalBuyVal = 0;
  let totalBuyVol = 0;
  for (const b of top3Formatted) {
    totalBuyVal += Number(b.buy_val || b.bval || 0);
    totalBuyVol += Number(b.buy_vol || b.bvol || 0);
  }

  let avgBuyTop3 = 0;
  if (totalBuyVal > 0 && totalBuyVol > 0) {
    avgBuyTop3 = bandarmologiService.normalizeVwapPrice(totalBuyVal / totalBuyVol, refPrice);
  } else if (top3Formatted.length > 0) {
    const avgP = top3Formatted.reduce((sum, b) => sum + (b.avg_price || 0), 0) / top3Formatted.length;
    avgBuyTop3 = Math.round(avgP);
  }

  if (totalBuyVol <= 0 && avgBuyTop3 <= 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      reason: 'ZERO_VOLUME'
    };
  }

  if (!currentPrice || currentPrice <= 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      in_sweet_spot: false,
      is_sweet_spot: false,
      reason: 'NO_CURRENT_PRICE',
      current_price: null,
      close_price: null,
      bandar_avg_buy: avgBuyTop3,
      bandar_avg_price: avgBuyTop3,
      avg_buy_price: avgBuyTop3,
      broker_cost: avgBuyTop3,
      harga_modal: avgBuyTop3,
      discount_pct: null,
      price_diff_pct: null,
      range: `${numDays}D`,
      top_3_brokers: top3Formatted,
      top_broker_details: top3Formatted,
      top_brokers: top3.map(b => b.broker),
      description: `Harga pasar terkini tidak tersedia (cache OHLCV kosong). Modal rata-rata Top 3 Bandar: ${avgBuyTop3}.`
    };
  }

  let diff = avgBuyTop3 - currentPrice;
  let discountPct = avgBuyTop3 > 0 ? Number(((diff / avgBuyTop3) * 100).toFixed(2)) : 0;
  let priceDiffPct = avgBuyTop3 > 0 ? Number((((currentPrice - avgBuyTop3) / avgBuyTop3) * 100).toFixed(2)) : 0;

  // Sweet spot requires genuine discount: 1.5% <= discount <= 5.0%
  const inSweetSpot = discountPct >= 1.5 && discountPct <= 5.0;
  // Triggered only if discount is >= 1.0% (difference < 1.0% is At Par / Fair Value, not aggressive accumulation)
  const isAtPar = Math.abs(discountPct) < 1.0;
  const triggered = discountPct >= 1.0;

  return {
    signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
    signal_name: 'Harga di Bawah Modal Bandar',
    triggered,
    in_sweet_spot: inSweetSpot,
    is_sweet_spot: inSweetSpot,
    is_at_par: isAtPar,
    current_price: currentPrice,
    close_price: currentPrice,
    bandar_avg_buy: avgBuyTop3,
    bandar_avg_price: avgBuyTop3,
    avg_buy_price: avgBuyTop3,
    broker_cost: avgBuyTop3,
    harga_modal: avgBuyTop3,
    discount_pct: discountPct,
    price_diff_pct: priceDiffPct,
    range: `${numDays}D`,
    top_3_brokers: top3Formatted,
    top_broker_details: top3Formatted,
    top_brokers: top3.map(b => b.broker),
    description: triggered
      ? `Harga terkini (${currentPrice}) berada di bawah modal rata-rata Top 3 Bandar (${avgBuyTop3}) dengan diskon ${discountPct}%.`
      : (isAtPar
          ? `Harga terkini (${currentPrice}) berada pada harga wajar / at par terhadap modal rata-rata Top 3 Bandar (${avgBuyTop3}) (selisih ${discountPct}%).`
          : `Harga terkini (${currentPrice}) masih di atas modal rata-rata Top 3 Bandar (${avgBuyTop3}).`)
  };
}

/**
 * Signal 2: Silent Foreign Accumulation
 * Net Foreign Buy positive for 3 to 5 consecutive trading days with sideways price action (change <= 2%).
 */
function detectSilentForeignAccumulation(ticker, options = {}) {
  const range = String(options.range || '7d').toLowerCase();
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[range] || (parseInt(range, 10) || 7);

  const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
  if (!availableDates || availableDates.length < 3) {
    const hunterData = getBrokersFromHunterIndexes(ticker, range);
    if (hunterData && Array.isArray(hunterData.top_buyers)) {
      // Filter strictly to foreign brokers with net positive value (no net sellers)
      const foreignBuyers = hunterData.top_buyers.filter(b => {
        if (!FOREIGN_BROKERS.has(b.broker)) return false;
        const net = Number(b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
        return net > 0;
      });
      const totalForeignNet = foreignBuyers.reduce((sum, b) => {
        const net = Number(b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
        return sum + (net > 0 ? net : 0);
      }, 0);

      // F-071: hunter data is a range AGGREGATE, not a daily series — it cannot
      // prove a consecutive-day streak or sideways price action. Never trigger.
      if (foreignBuyers.length >= 2 && totalForeignNet > 0) {
        return {
          signal_key: 'SILENT_FOREIGN_ACCUMULATION',
          signal_name: 'Silent Foreign Accumulation',
          triggered: false,
          reason: 'DAILY_SERIES_UNAVAILABLE',
          total_foreign_net: totalForeignNet,
          total_foreign_net_val: totalForeignNet,
          foreign_accumulators: foreignBuyers.map(b => b.broker),
          description: 'Data hunter bersifat agregat rentang — streak harian tidak dapat diverifikasi.'
        };
      }
    }
    return {
      signal_key: 'SILENT_FOREIGN_ACCUMULATION',
      signal_name: 'Silent Foreign Accumulation',
      triggered: false,
      reason: 'INSUFFICIENT_DATES'
    };
  }

  const checkDates = availableDates.slice(0, Math.min(Math.max(numDays, 5), 30)); // check newest trading days
  const dailyFlows = [];

  for (let i = 0; i < checkDates.length; i++) {
    const d = checkDates[i];
    const raw = bandarmologiService.readDiskCache('broker-summary', ticker, d);
    if (!raw) break;
    const norm = bandarmologiService.normalizeBrokerSummary(raw, d, ticker);
    if (!norm) break;

    // Calculate foreign broker net value and track per broker
    let foreignNet = 0;
    const dayForeignMap = {};
    const allBrokers = [
      ...(norm.gross_buyers || norm.top_buyers || norm.buyers || []),
      ...(norm.gross_sellers || norm.top_sellers || norm.sellers || [])
    ];
    const seen = new Set();
    for (const b of allBrokers) {
      const code = b && (b.broker || b.broker_code);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      if (FOREIGN_BROKERS.has(code)) {
        const net = Number(b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
        foreignNet += net;
        dayForeignMap[code] = (dayForeignMap[code] || 0) + net;
      }
    }

    // Determine day reference price and candle high/low
    let dayPrice = 0;
    let dayHigh = 0;
    let dayLow = 0;
    try {
      const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${ticker}.json`);
      if (fs.existsSync(ohlcvPath)) {
        const rawOhlcv = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
        const cList = rawOhlcv.candles || rawOhlcv.data || (Array.isArray(rawOhlcv) ? rawOhlcv : []);
        const match = cList.find(c => c.date === d || (c.time && new Date(c.time * 1000).toISOString().startsWith(d)));
        if (match) {
          dayPrice = Number(match.close || match.c || 0);
          dayHigh = Number(match.high || match.h || dayPrice);
          dayLow = Number(match.low || match.l || dayPrice);
        }
      }
    } catch (_) {}

    if (!dayPrice) {
      if (options.pricesByDate && options.pricesByDate[d]) {
        dayPrice = Number(options.pricesByDate[d]);
      } else {
        const topB = (norm.top_buyers && norm.top_buyers[0]) || (norm.gross_buyers && norm.gross_buyers[0]);
        if (topB) {
          // PR4: bvol is share-count in this feed, so the fallback VWAP is
          // bval / bvol (NOT bval / (bvol*100) — that under-scaled the price by
          // 100x and was a second contributor to the wrong "current price").
          dayPrice = Number(topB.avg_price || topB.avg_buy || topB.bavg || (topB.bvol > 0 ? Math.round(topB.bval / topB.bvol) : 0));
        }
      }
      if (!dayPrice) {
        dayPrice = bandarmologiService.getReferencePrice(ticker);
      }
      if (!dayHigh) dayHigh = dayPrice;
      if (!dayLow) dayLow = dayPrice;
    }

    dailyFlows.push({
      date: d,
      foreign_net: foreignNet,
      foreign_brokers: dayForeignMap,
      price: dayPrice,
      high: dayHigh,
      low: dayLow
    });
  }

  if (dailyFlows.length < 3) {
    return {
      signal_key: 'SILENT_FOREIGN_ACCUMULATION',
      signal_name: 'Silent Foreign Accumulation',
      triggered: false,
      consecutive_days: 0,
      reason: 'INSUFFICIENT_DAILY_FLOWS'
    };
  }

  // Count consecutive positive days from the newest day backwards. Breaks immediately on non-positive foreign flow.
  let consecutivePositiveDays = 0;
  let totalForeignNet = 0;
  const streakForeignNets = {};

  for (let i = 0; i < dailyFlows.length; i++) {
    if (dailyFlows[i].foreign_net > 0) {
      consecutivePositiveDays++;
      totalForeignNet += dailyFlows[i].foreign_net;
      for (const [code, net] of Object.entries(dailyFlows[i].foreign_brokers)) {
        streakForeignNets[code] = (streakForeignNets[code] || 0) + net;
      }
    } else {
      break;
    }
  }

  // Filter foreign accumulators strictly to net buyers (net_val > 0), discarding net sellers like BK
  const foreignAccumulators = Object.entries(streakForeignNets)
    .filter(([_, net]) => net > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);

  if (consecutivePositiveDays < 3) {
    return {
      signal_key: 'SILENT_FOREIGN_ACCUMULATION',
      signal_name: 'Silent Foreign Accumulation',
      triggered: false,
      consecutive_days: consecutivePositiveDays,
      total_foreign_net: totalForeignNet,
      total_foreign_net_val: totalForeignNet,
      foreign_accumulators: foreignAccumulators,
      reason: 'CONSECUTIVE_DAYS_LESS_THAN_3'
    };
  }

  // Calculate real price fluctuation from active streak range: ((high - low) / low) * 100
  let streakHigh = 0;
  let streakLow = 0;
  const activeFlows = dailyFlows.slice(0, consecutivePositiveDays);
  const highs = activeFlows.map(f => f.high || f.price).filter(p => p > 0);
  const lows = activeFlows.map(f => f.low || f.price).filter(p => p > 0);
  if (highs.length > 0 && lows.length > 0) {
    streakHigh = Math.max(...highs);
    streakLow = Math.min(...lows);
  }

  let priceFluctuationPct = 0;
  if (streakLow > 0 && streakHigh >= streakLow) {
    priceFluctuationPct = Number((((streakHigh - streakLow) / streakLow) * 100).toFixed(2));
  }
  if (priceFluctuationPct === 0 && streakLow > 0) {
    const pNewest = dailyFlows[0] ? dailyFlows[0].price : streakLow;
    const pOldest = dailyFlows[consecutivePositiveDays - 1] ? dailyFlows[consecutivePositiveDays - 1].price : streakLow;
    if (pNewest !== pOldest && Math.min(pNewest, pOldest) > 0) {
      priceFluctuationPct = Number((((Math.max(pNewest, pOldest) - Math.min(pNewest, pOldest)) / Math.min(pNewest, pOldest)) * 100).toFixed(2));
    }
  }

  const isSideways = priceFluctuationPct <= 3.0;
  const triggered = consecutivePositiveDays >= 3 && isSideways && foreignAccumulators.length > 0;

  return {
    signal_key: 'SILENT_FOREIGN_ACCUMULATION',
    signal_name: 'Silent Foreign Accumulation',
    triggered,
    consecutive_days: consecutivePositiveDays,
    price_change_pct: priceFluctuationPct,
    price_fluctuation_pct: priceFluctuationPct,
    is_sideways: isSideways,
    total_foreign_net: totalForeignNet,
    total_foreign_net_val: totalForeignNet,
    foreign_accumulators: foreignAccumulators,
    daily_breakdown: dailyFlows.slice(0, consecutivePositiveDays),
    description: triggered
      ? `Net Foreign Buy positif ${consecutivePositiveDays} hari berturut-turut (total net Rp${Math.round(totalForeignNet).toLocaleString('id-ID')}) oleh broker asing (${foreignAccumulators.join(', ')}). Fluktuasi harga: ${priceFluctuationPct}%.`
      : `Net Foreign Buy positif ${consecutivePositiveDays} hari, namun fluktuasi harga (${priceFluctuationPct}%) melampaui batas sideways.`
  };
}

/**
 * Signal 3: Ritel Cutloss vs Bandar Nampung
 * Condition A (Bandar Nampung / Ritel Cutloss):
 *   Top 3 Seller dominated by retail (YP, PD, XC, XL, NI) and Top 3 Buyer dominated by institutional/foreign (AK, BK, RX, CC, KZ).
 * Condition B (Distribusi ke Ritel):
 *   Top 3 Buyer dominated by retail and Top 3 Seller dominated by institutional/bandar.
 */
function detectRetailCutlossVsBandar(ticker, options = {}) {
  const range = options.range || '7d';
  let norm = options.brokerSummary || null;

  if (!norm) {
    const targetDate = options.date || '';
    const diskSummary = bandarmologiService.readDiskCache('broker-summary', ticker, targetDate || 'latest');
    norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate);

    if (!norm || !Array.isArray(norm.top_buyers) || !Array.isArray(norm.top_sellers) ||
        norm.top_buyers.length === 0 || norm.top_sellers.length === 0) {
      const hunterData = getBrokersFromHunterIndexes(ticker, range);
      if (hunterData && Array.isArray(hunterData.top_buyers) && Array.isArray(hunterData.top_sellers) &&
          hunterData.top_buyers.length > 0 && hunterData.top_sellers.length > 0) {
        norm = hunterData;
      }
    }
  }

  if (!norm || !Array.isArray(norm.top_buyers) || !Array.isArray(norm.top_sellers) ||
      norm.top_buyers.length === 0 || norm.top_sellers.length === 0) {
    return {
      signal_key: 'RITEL_CUTLOSS_VS_BANDAR',
      signal_name: 'Ritel Cutloss vs Bandar Nampung',
      triggered: false,
      sub_type: 'NO_DATA'
    };
  }

  const top3Buyers = norm.top_buyers.slice(0, 3).map(b => b.broker);
  const top3Sellers = norm.top_sellers.slice(0, 3).map(s => s.broker);

  let instBuyerCount = 0;
  let retailBuyerCount = 0;
  for (const code of top3Buyers) {
    if (INSTITUTIONAL_BROKERS.has(code)) instBuyerCount++;
    if (RETAIL_BROKERS.has(code)) retailBuyerCount++;
  }

  let retailSellerCount = 0;
  let instSellerCount = 0;
  for (const code of top3Sellers) {
    if (RETAIL_BROKERS.has(code)) retailSellerCount++;
    if (INSTITUTIONAL_BROKERS.has(code)) instSellerCount++;
  }

  // Bandar Nampung: Institutional buyers >= 2 and Retail sellers >= 2
  const isBandarNampung = instBuyerCount >= 2 && retailSellerCount >= 2;
  // Distribusi ke Ritel: Retail buyers >= 2 and Institutional sellers >= 2
  const isDistribusiKeRitel = retailBuyerCount >= 2 && instSellerCount >= 2;

  let subType = 'NEUTRAL';
  let description = 'Distribusi transaksi antara ritel dan institusi seimbang / normal.';
  if (isBandarNampung) {
    subType = 'BANDAR_NAMPUNG_RITEL_CUTLOSS';
    description = `Top 3 Buyer didominasi institusi/bandar (${top3Buyers.join(', ')}) dan Top 3 Seller didominasi ritel (${top3Sellers.join(', ')}). Ritel sedang cutloss dan ditampung bandar.`;
  } else if (isDistribusiKeRitel) {
    subType = 'DISTRIBUSI_KE_RITEL';
    description = `Top 3 Buyer didominasi ritel (${top3Buyers.join(', ')}) dan Top 3 Seller didominasi institusi/bandar (${top3Sellers.join(', ')}). Bandar sedang mendistribusikan barang ke ritel.`;
  }

  return {
    signal_key: 'RITEL_CUTLOSS_VS_BANDAR',
    signal_name: 'Ritel Cutloss vs Bandar Nampung',
    triggered: isBandarNampung || isDistribusiKeRitel,
    sub_type: subType,
    is_bandar_nampung: isBandarNampung,
    is_distribusi_ke_ritel: isDistribusiKeRitel,
    top_buyers: top3Buyers,
    top_sellers: top3Sellers,
    inst_buyer_count: instBuyerCount,
    retail_seller_count: retailSellerCount,
    retail_buyer_count: retailBuyerCount,
    inst_seller_count: instSellerCount,
    description
  };
}

function getCachedTurnover(ticker, numDays = 1) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return 0;
  try {
    const candidatePaths = [
      path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache', `${clean}.json`),
      path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`)
    ];
    const ohlcvPath = candidatePaths.find(p => fs.existsSync(p));
    if (ohlcvPath && fs.existsSync(ohlcvPath)) {
      const data = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const candles = data && data.candles;
      if (Array.isArray(candles) && candles.length > 0) {
        const slice = candles.slice(-Math.max(1, numDays));
        let total = 0;
        for (const c of slice) {
          const close = Number(c.close || 0);
          const vol = Number(c.volume || 0);
          if (c.turnover || c.value) {
            total += Number(c.turnover || c.value);
          } else if (close > 0 && vol > 0) {
            total += close * vol;
          }
        }
        if (total > 0) return total;
      }
    }
  } catch (_) {}
  return 0;
}

/**
 * Signal 4: Concentration Ratio (CR3 & CR5)
 * CR3 >= 60%: Akumulasi Sangat Masif (Monopoli Bandar)
 * CR3 >= 40%: Akumulasi Terkonsentrasi
 */
function computeConcentrationRatios(ticker, options = {}) {
  const range = String(options.range || '7d').toLowerCase();
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[range] || (parseInt(range, 10) || 7);
  const targetDate = options.date || '';

  let norm = options.brokerSummary || options.summary || null;
  if (!norm) {
    const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
    if (availableDates && availableDates.length > 0) {
      if (numDays > 1 && !targetDate && availableDates.length > 1) {
        const targetDates = availableDates.slice(0, numDays);
        norm = bandarmologiService.aggregateBrokerSummaries(ticker, targetDates, numDays);
      } else {
        const diskSummary = bandarmologiService.readDiskCache('broker-summary', ticker, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'));
        norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'), ticker);
      }
    }
  }

  if (!norm || !Array.isArray(norm.gross_buyers) || norm.gross_buyers.length === 0) {
    const hunterData = getBrokersFromHunterIndexes(ticker, range);
    if (hunterData && Array.isArray(hunterData.gross_buyers) && hunterData.gross_buyers.length > 0) {
      norm = hunterData;
    }
  }

  if (!norm || !Array.isArray(norm.gross_buyers) || norm.gross_buyers.length === 0) {
    return {
      signal_key: 'CONCENTRATION_RATIO',
      signal_name: 'Concentration Ratio (CR3 & CR5)',
      triggered: false,
      reason: 'NO_DATA',
      cr3: 0,
      cr5: 0
    };
  }

  const buyers = (Array.isArray(norm.top_buyers) && norm.top_buyers.length > 0)
    ? norm.top_buyers
    : (norm.gross_buyers || []);

  let top3Val = 0;
  let top3Vol = 0;
  for (let i = 0; i < Math.min(3, buyers.length); i++) {
    top3Val += Number(buyers[i].bval || buyers[i].buy_val || buyers[i].val || 0);
    top3Vol += Number(buyers[i].bvol || buyers[i].buy_vol || buyers[i].vol || 0);
  }

  let top5Val = 0;
  let top5Vol = 0;
  for (let i = 0; i < Math.min(5, buyers.length); i++) {
    top5Val += Number(buyers[i].bval || buyers[i].buy_val || buyers[i].val || 0);
    top5Vol += Number(buyers[i].bvol || buyers[i].buy_vol || buyers[i].vol || 0);
  }

  let totalBuyVol = buyers.reduce((sum, b) => sum + Number(b.bvol || b.buy_vol || b.vol || 0), 0);
  if (norm.total_volume && Number(norm.total_volume) > totalBuyVol) {
    totalBuyVol = Number(norm.total_volume);
  }

  // Denominator: Total Turnover Emiten (Nilai Transaksi Pasar Beli Seluruh Broker)
  const allBrokers = (Array.isArray(norm.brokers) && norm.brokers.length > 0)
    ? norm.brokers
    : (Array.isArray(norm.gross_buyers) && norm.gross_buyers.length > 0 ? norm.gross_buyers : buyers);
  let totalTurnover = allBrokers.reduce((acc, b) => acc + Number(b.bval || b.buy_val || 0), 0);
  if (totalTurnover <= 0) {
    totalTurnover = Number(norm.total_turnover || norm.turnover || norm.total_buy_val || norm.total_value || 0);
  } else if (norm.total_turnover && Number(norm.total_turnover) > totalTurnover) {
    totalTurnover = Number(norm.total_turnover);
  }

  const ohlcvTurnover = getCachedTurnover(ticker, numDays);
  if (ohlcvTurnover > 0) {
    totalTurnover = Math.max(totalTurnover, ohlcvTurnover);
  }

  // F-070: never fabricate the value denominator. If real market turnover is
  // absent, fall back to the volume-based CR (real data); only when neither
  // exists return null CR with an explicit reason.
  let valueDenominatorOk = true;
  if (totalTurnover <= top5Val) {
    if (ohlcvTurnover > 0 && ohlcvTurnover > top5Val) {
      totalTurnover = ohlcvTurnover;
    } else {
      valueDenominatorOk = false;
    }
  }

  let cr3 = null;
  let cr5 = null;
  let crBasis = null;
  if (valueDenominatorOk && top3Val > 0 && totalTurnover > 0) {
    cr3 = Number(((top3Val / totalTurnover) * 100).toFixed(2));
    cr5 = Number(((top5Val / totalTurnover) * 100).toFixed(2));
    crBasis = 'VALUE';
  } else if (top3Vol > 0 && totalBuyVol > 0) {
    // Fallback to volume concentration if value metrics are omitted in feed/mock
    cr3 = Number(((top3Vol / totalBuyVol) * 100).toFixed(2));
    cr5 = Number(((top5Vol / totalBuyVol) * 100).toFixed(2));
    crBasis = 'VOLUME';
  }
  if (cr3 != null) cr3 = Math.min(100, Math.max(0, cr3));
  if (cr5 != null) cr5 = Math.min(100, Math.max(0, cr5));
  const turnoverUnavailable = cr3 == null;

  let status = 'NORMAL_DIFFUSE';
  let label = 'Normal / Tersebar';
  let isMassive = false;

  if (cr3 >= 60.0) {
    status = 'AKUMULASI_MASIF';
    label = 'Akumulasi Sangat Masif (Monopoli)';
    isMassive = true;
  } else if (cr3 >= 40.0) {
    status = 'AKUMULASI_TERKONSENTRASI';
    label = 'Akumulasi Terkonsentrasi';
  }

  const triggered = cr3 >= 40.0;

  // Filter top accumulating brokers strictly to those with net_val > 0 (exclude net sellers like ZP/CC)
  const netAccumulators = (norm.net_buyers || buyers).filter(b => {
    const net = Number(b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
    return net > 0;
  });
  const topAccumulatorCodes = netAccumulators.length > 0
    ? netAccumulators.slice(0, 3).map(b => b.broker)
    : buyers.slice(0, 3).map(b => b.broker);

  return {
    signal_key: 'CONCENTRATION_RATIO',
    signal_name: 'Concentration Ratio (CR3 & CR5)',
    triggered,
    is_massive: isMassive,
    cr3,
    cr5,
    status,
    label,
    reason: turnoverUnavailable ? 'TURNOVER_UNAVAILABLE' : undefined,
    cr_basis: crBasis || undefined,
    top_3_val: top3Val,
    top_5_val: top5Val,
    total_turnover: turnoverUnavailable ? null : totalTurnover,
    top_3_vol: top3Vol,
    top_5_vol: top5Vol,
    total_vol: totalBuyVol,
    top_3_brokers: topAccumulatorCodes,
    top_accumulators: topAccumulatorCodes,
    description: turnoverUnavailable
      ? 'Total turnover pasar tidak tersedia — CR3/CR5 tidak dihitung.'
      : `CR3 sebesar ${cr3}% dan CR5 sebesar ${cr5}%. Status: ${label}.`
  };
}

function validateIntelEvaluation(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.ticker !== 'string' || !value.ticker) return false;
  if (!value.signals || typeof value.signals !== 'object') return false;
  const signalKeys = ['harga_di_bawah_modal_bandar', 'silent_foreign_accumulation', 'ritel_cutloss_vs_bandar', 'concentration_ratio'];
  return signalKeys.every(key => !value.signals[key] || typeof value.signals[key] === 'object');
}

function safeEvaluateBandarmologiIntelForTicker(ticker, options = {}) {
  try {
    const result = evaluateBandarmologiIntelForTicker(ticker, options);
    if (validateIntelEvaluation(result)) return result;
  } catch (_) {}
  const clean = arjumClient.cleanTicker(ticker);
  return {
    ticker: clean,
    has_data: false,
    // DATE_UNRESOLVED: never fabricate a literal — null propagates to UI as
    // an explicit "tanggal belum tersedia" badge instead of a stale key.
    effective_date: options.date || null,
    range: `${Number(options.days || 7)}D`,
    days: Number(options.days || 7),
    evaluated_at: options.date || null,
    confluence_badge: 'NEUTRAL',
    bullish_signals_count: 0,
    bearish_signals_count: 0,
    signals: {
      harga_di_bawah_modal_bandar: { triggered: false, reason: 'INTEL_EVALUATION_ERROR' },
      silent_foreign_accumulation: { triggered: false, reason: 'INTEL_EVALUATION_ERROR' },
      ritel_cutloss_vs_bandar: { triggered: false, sub_type: 'NO_DATA' },
      concentration_ratio: { triggered: false, reason: 'INTEL_EVALUATION_ERROR' }
    }
  };
}

/**
 * Comprehensive Evaluation across all 4 intelligence signals for a ticker
 */
function evaluateBandarmologiIntelForTicker(ticker, options = {}) {
  const clean = arjumClient.cleanTicker(ticker);
  const range = String(options.range || '7d').toLowerCase();
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[range] || (parseInt(range, 10) || 7);

  // On-demand fetch from VPS if local broker-summary is missing
  let availableDates = bandarmologiService.listDiskDates('broker-summary', clean);
  try {
    if (!availableDates || availableDates.length === 0) {
      const vpsFetcher = require('./vps-data-fetcher');
      if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryRangeFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
        vpsFetcher.fetchBrokerSummaryRangeFromVpsSync(clean, Math.max(numDays, 30));
        availableDates = bandarmologiService.listDiskDates('broker-summary', clean);
      } else if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
        // No hardcoded date default — pass 'latest' so the VPS fetcher picks
        // the most recent available broker-summary on the remote host.
        vpsFetcher.fetchBrokerSummaryFromVpsSync(clean, options.date || 'latest');
        availableDates = bandarmologiService.listDiskDates('broker-summary', clean);
      }
    }
  } catch (_) {}

  // On-demand fetch from VPS if local OHLCV is missing
  try {
    const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`);
    if (!fs.existsSync(ohlcvPath)) {
      const vpsFetcher = require('./vps-data-fetcher');
      if (vpsFetcher && typeof vpsFetcher.fetchOhlcvFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
        vpsFetcher.fetchOhlcvFromVpsSync(clean);
      }
    }
  } catch (_) {}

  // Build unified multi-day broker summary across the requested range
  let unifiedSummary = options.brokerSummary || null;
  if (!unifiedSummary && availableDates && availableDates.length > 0) {
    if (numDays > 1) {
      const validDates = typeof bandarmologiService.filterCalendarWindowDates === 'function'
        ? bandarmologiService.filterCalendarWindowDates(availableDates, numDays)
        : availableDates.slice(0, numDays);
      const datesToUse = validDates.length > 0 ? validDates.slice(0, numDays) : availableDates.slice(0, numDays);
      if (datesToUse.length > 1) {
        unifiedSummary = bandarmologiService.aggregateBrokerSummaries(clean, datesToUse, numDays);
      } else if (datesToUse.length === 1) {
        const raw = bandarmologiService.readDiskCache('broker-summary', clean, datesToUse[0]);
        unifiedSummary = bandarmologiService.normalizeBrokerSummary(raw, datesToUse[0], clean);
      } else {
        unifiedSummary = getBrokersFromHunterIndexes(clean, range);
      }
    } else {
      const raw = bandarmologiService.readDiskCache('broker-summary', clean, availableDates[0]);
      unifiedSummary = bandarmologiService.normalizeBrokerSummary(raw, availableDates[0], clean);
    }
  }

  if (!unifiedSummary || !Array.isArray(unifiedSummary.top_buyers) || unifiedSummary.top_buyers.length === 0) {
    const hunterSummary = getBrokersFromHunterIndexes(clean, range);
    if (hunterSummary && Array.isArray(hunterSummary.top_buyers) && hunterSummary.top_buyers.length > 0) {
      unifiedSummary = hunterSummary;
    }
  }

  const evalOptions = Object.assign({}, options, {
    range,
    numDays,
    brokerSummary: unifiedSummary
  });

  const s1 = detectPriceBelowBandarCost(clean, evalOptions);
  const s2 = detectSilentForeignAccumulation(clean, evalOptions);
  const s3 = detectRetailCutlossVsBandar(clean, evalOptions);
  const s4 = computeConcentrationRatios(clean, evalOptions);

  const hasData = Boolean(
    (s1 && s1.reason !== 'NO_DATA') ||
    (s2 && s2.reason !== 'NO_DATA') ||
    (s3 && s3.reason !== 'NO_DATA') ||
    (s4 && s4.reason !== 'NO_DATA')
  );

  let bullishCount = 0;
  let bearishCount = 0;

  if (s1.triggered) bullishCount++;
  if (s2.triggered) bullishCount++;
  if (s3.triggered && s3.is_bandar_nampung) bullishCount++;
  if (s3.triggered && s3.is_distribusi_ke_ritel) bearishCount++;
  if (s4.triggered && s4.is_massive) bullishCount += 2;
  else if (s4.triggered) bullishCount++;

  let confluenceBadge = 'NEUTRAL';
  if (bullishCount >= 3) {
    confluenceBadge = 'STRONG_ACCUMULATION';
  } else if (bullishCount >= 1 && bearishCount === 0) {
    confluenceBadge = 'ACCUMULATION';
  } else if (bearishCount > 0 && bullishCount === 0) {
    confluenceBadge = 'DISTRIBUTION';
  }

  // Pillar 9 Guard: Disallow Buy signals when 5D trend is Bearish or RSI > 70
  let is5dBearish = false;
  let rsi14 = null;
  try {
    const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`);
    if (fs.existsSync(ohlcvPath)) {
      const ohlcvData = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const candles = ohlcvData && (ohlcvData.candles || ohlcvData.data || (Array.isArray(ohlcvData) ? ohlcvData : []));
      if (Array.isArray(candles) && candles.length >= 5) {
        const lastClose = Number(candles[candles.length - 1].close);
        const close5dAgo = Number(candles[candles.length - 5].close);
        if (lastClose > 0 && close5dAgo > 0 && lastClose < close5dAgo) {
          is5dBearish = true;
        }
        if (candles.length >= 15) {
          let gains = 0;
          let losses = 0;
          for (let i = candles.length - 14; i < candles.length; i++) {
            const diff = Number(candles[i].close) - Number(candles[i - 1].close);
            if (diff >= 0) gains += diff;
            else losses += Math.abs(diff);
          }
          const avgGain = gains / 14;
          const avgLoss = losses / 14;
          rsi14 = avgLoss === 0 ? 100 : (100 - (100 / (1 + (avgGain / avgLoss))));
        }
      }
    }
  } catch (_) {}

  const isOverbought = rsi14 !== null && rsi14 > 70;
  if ((is5dBearish || isOverbought) && (confluenceBadge === 'STRONG_ACCUMULATION' || confluenceBadge === 'ACCUMULATION')) {
    confluenceBadge = bearishCount > 0 ? 'DISTRIBUTION' : 'NEUTRAL';
  }

  // Reconcile status konfluensi (Anti-Skizofrenia) with unified broker summary net flow/status
  const netFlow = Number(unifiedSummary && (unifiedSummary.net_flow != null ? unifiedSummary.net_flow : (unifiedSummary.total_net_val || 0)));
  const netStatus = String(unifiedSummary && (unifiedSummary.net_status || unifiedSummary.status || '')).toUpperCase();
  const isNetDistribution = netStatus.includes('DIST') || netFlow <= -1e9;
  const isBigDistribution = netStatus.includes('BIG_DIST') || netFlow <= -5e9;

  if (isNetDistribution) {
    if (bearishCount === 0) bearishCount++;
    if (isBigDistribution) {
      bullishCount = 0;
      confluenceBadge = 'DISTRIBUTION';
    } else {
      if (confluenceBadge === 'STRONG_ACCUMULATION' || confluenceBadge === 'ACCUMULATION') {
        confluenceBadge = bearishCount > 0 ? 'DISTRIBUTION' : 'NEUTRAL';
      }
    }
  }

  // No static fallback: if the effective trading date cannot be resolved,
  // surface DATE_UNRESOLVED (null) so the caller can render an explicit
  // "tanggal belum tersedia" badge.
  const effectiveTradingDate = bandarmologiService.getEffectiveTradingDate(clean, options.date) || null;

  return {
    ticker: clean,
    has_data: hasData,
    effective_date: effectiveTradingDate,
    range: `${numDays}D`,
    days: numDays,
    evaluated_at: effectiveTradingDate,
    confluence_badge: confluenceBadge,
    bullish_signals_count: bullishCount,
    bearish_signals_count: bearishCount,
    is_5d_bearish: is5dBearish,
    rsi14: rsi14 != null ? Number(rsi14.toFixed(1)) : null,
    signals: {
      harga_di_bawah_modal_bandar: s1,
      silent_foreign_accumulation: s2,
      ritel_cutloss_vs_bandar: s3,
      concentration_ratio: s4
    }
  };
}

/**
 * Pre-computes intelligence signals for tickers and caches index to disk
 */
function computeAndSaveIntel(options = {}) {
  let tickers = (Array.isArray(options.tickers) && options.tickers.length > 0)
    ? options.tickers
    : loadUniverseTickers();

  if (Number.isFinite(options.limit) && options.limit > 0) {
    tickers = tickers.slice(0, options.limit);
  }

  ensureDirExists(getIntelCacheDir());

  const resultsByTicker = {};
  const indexes = {
    harga_di_bawah_modal_bandar: [],
    silent_foreign_accumulation: [],
    ritel_cutloss_bandar_nampung: [],
    distribusi_ke_ritel: [],
    cr3_massive: []
  };

  for (const ticker of tickers) {
    try {
      const evaluation = evaluateBandarmologiIntelForTicker(ticker, options);
      resultsByTicker[ticker] = evaluation;

      const s = evaluation.signals;
      if (s.harga_di_bawah_modal_bandar && s.harga_di_bawah_modal_bandar.triggered) {
        indexes.harga_di_bawah_modal_bandar.push({
          ticker,
          current_price: s.harga_di_bawah_modal_bandar.current_price,
          bandar_avg_buy: s.harga_di_bawah_modal_bandar.bandar_avg_buy,
          discount_pct: s.harga_di_bawah_modal_bandar.discount_pct,
          in_sweet_spot: s.harga_di_bawah_modal_bandar.in_sweet_spot,
          top_3_brokers: s.harga_di_bawah_modal_bandar.top_3_brokers,
          description: s.harga_di_bawah_modal_bandar.description,
          note: s.harga_di_bawah_modal_bandar.description
        });
      }

      if (s.silent_foreign_accumulation && s.silent_foreign_accumulation.triggered) {
        indexes.silent_foreign_accumulation.push({
          ticker,
          consecutive_days: s.silent_foreign_accumulation.consecutive_days,
          price_change_pct: s.silent_foreign_accumulation.price_change_pct,
          total_foreign_net: s.silent_foreign_accumulation.total_foreign_net,
          description: s.silent_foreign_accumulation.description,
          note: s.silent_foreign_accumulation.description
        });
      }

      if (s.ritel_cutloss_vs_bandar && s.ritel_cutloss_vs_bandar.is_bandar_nampung) {
        indexes.ritel_cutloss_bandar_nampung.push({
          ticker,
          top_buyers: s.ritel_cutloss_vs_bandar.top_buyers,
          top_sellers: s.ritel_cutloss_vs_bandar.top_sellers,
          description: s.ritel_cutloss_vs_bandar.description,
          note: s.ritel_cutloss_vs_bandar.description
        });
      }

      if (s.ritel_cutloss_vs_bandar && s.ritel_cutloss_vs_bandar.is_distribusi_ke_ritel) {
        indexes.distribusi_ke_ritel.push({
          ticker,
          top_buyers: s.ritel_cutloss_vs_bandar.top_buyers,
          top_sellers: s.ritel_cutloss_vs_bandar.top_sellers,
          description: s.ritel_cutloss_vs_bandar.description,
          note: s.ritel_cutloss_vs_bandar.description
        });
      }

      if (s.concentration_ratio && s.concentration_ratio.is_massive) {
        indexes.cr3_massive.push({
          ticker,
          cr3: s.concentration_ratio.cr3,
          cr5: s.concentration_ratio.cr5,
          top_3_brokers: s.concentration_ratio.top_3_brokers,
          description: s.concentration_ratio.description,
          note: s.concentration_ratio.description
        });
      }
    } catch (_) {}
  }

  // Sort indexes according to market intelligence criteria
  if (Array.isArray(indexes.harga_di_bawah_modal_bandar)) {
    indexes.harga_di_bawah_modal_bandar.sort((a, b) => (b.discount_pct || 0) - (a.discount_pct || 0));
  }
  if (Array.isArray(indexes.silent_foreign_accumulation)) {
    indexes.silent_foreign_accumulation.sort((a, b) => ((b.consecutive_days || 0) - (a.consecutive_days || 0)) || ((b.total_foreign_net || 0) - (a.total_foreign_net || 0)));
  }
  if (Array.isArray(indexes.cr3_massive)) {
    indexes.cr3_massive.sort((a, b) => (b.cr3 || 0) - (a.cr3 || 0));
  }

  // No static fallback: a null marketDate propagates as DATE_UNRESOLVED to
  // every consumer (intel payload, effective_date, updated_at).
  const marketDate = bandarmologiService.getEffectiveTradingDate() || null;
  const cleanRange = String(options.range || '7d').trim().toLowerCase();
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[cleanRange] || (parseInt(cleanRange, 10) || 7);

  const payload = {
    updated_at: marketDate,
    effective_date: marketDate,
    date: marketDate,
    range: cleanRange,
    days: numDays,
    total_evaluated: tickers.length,
    indexes,
    summary: {
      harga_di_bawah_modal_bandar_count: indexes.harga_di_bawah_modal_bandar.length,
      silent_foreign_accumulation_count: indexes.silent_foreign_accumulation.length,
      ritel_cutloss_bandar_nampung_count: indexes.ritel_cutloss_bandar_nampung.length,
      distribusi_ke_ritel_count: indexes.distribusi_ke_ritel.length,
      cr3_massive_count: indexes.cr3_massive.length
    },
    tickers: resultsByTicker
  };

  // If calculating default 7d or unspecified, update latest.json and catalog.json
  // Batch 2: resolve write targets per call. Using the import-time constants here
  // meant an operator could not redirect the index output (and a test could not
  // isolate it), so a run would silently overwrite committed index data.
  const indexOutDir = getPersistentIntelIndexDir();
  const cacheOutDir = getIntelCacheDir();

  if (!options.range || cleanRange === '7d') {
    safeWriteJson(path.join(indexOutDir, 'latest.json'), payload);
    safeWriteJson(path.join(indexOutDir, 'catalog.json'), payload);
    safeWriteJson(path.join(cacheOutDir, 'latest.json'), payload);
  }

  // Write range-specific persistent index files
  safeWriteJson(path.join(indexOutDir, `latest_${cleanRange}.json`), payload);
  safeWriteJson(path.join(indexOutDir, `catalog_${cleanRange}.json`), payload);
  safeWriteJson(path.join(cacheOutDir, `latest_${cleanRange}.json`), payload);

  if (options.date) {
    safeWriteJson(path.join(cacheOutDir, `${options.date}.json`), payload);
  }

  return payload;
}

/**
 * API handler to serve Bandarmologi Intelligence
 */
/**
 * Batch 2: resolve the freshest available intel index plus its provenance.
 *
 * Order of preference:
 *   1. the live bridge aggregate (freshest, read-only, no local write)
 *   2. a baked index on disk (labelled as such so the UI can flag staleness)
 *
 * The bridge is tried FIRST because the baked index is a frozen snapshot: serving
 * it while a live source is reachable is exactly the "stale price with no label"
 * defect.
 */
function loadIntelIndexWithProvenance(range) {
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    if (vpsFetcher && typeof vpsFetcher.fetchIntelIndexFromVpsSync === 'function') {
      const live = vpsFetcher.fetchIntelIndexFromVpsSync(range);
      if (live && live.indexes) {
        return { data: live, data_source: 'live_bridge' };
      }
    }
  } catch (err) {
    console.warn(`[INTEL][WARN] live bridge index unavailable for range ${range}: ${err.message}`);
  }

  const baked = loadCachedIntel(range);
  if (baked) return { data: baked, data_source: 'baked_index' };

  return { data: null, data_source: 'unavailable' };
}

/** Effective trading date carried by the aggregate, never a write timestamp. */
function resolveIndexAsOfDate(data) {
  if (!data) return null;
  return data.effective_date || data.date || data.as_of_date || null;
}

async function getBandarmologiIntel(options = {}) {
  const ticker = options.ticker ? arjumClient.cleanTicker(options.ticker) : null;
  const signal = options.signal || null;

  if (ticker) {
    const result = safeEvaluateBandarmologiIntelForTicker(ticker, options);
    // Batch 2: provenance travels with the payload so the UI can label the price
    // and flag it when the quote could not be confirmed by the live bridge.
    const provenance = __lastPriceProvenance && __lastPriceProvenance.ticker === ticker
      ? __lastPriceProvenance
      : null;
    const usedLiveBridge = provenance && provenance.price_source === 'vps_bridge_live';
    return {
      success: true,
      ticker,
      as_of_date: (result && result.effective_date) || (provenance && provenance.as_of_date) || null,
      data_source: usedLiveBridge ? 'live_bridge' : 'local_cache',
      price_source: provenance ? provenance.price_source : null,
      result
    };
  }

  const resolved = loadIntelIndexWithProvenance(options.range);
  let cacheData = resolved.data;
  const dataSource = resolved.data_source;

  // Batch 2: recompute is a WRITE and is impossible on the read-only deployed
  // runtime. It stays disabled there, but that must never stop the handler from
  // SERVING whatever the bridge or the baked index provides.
  if (options.forceRefresh && !process.env.VERCEL) {
    cacheData = computeAndSaveIntel(options);
  }

  // CRITICAL: never compute the full universe live in a serverless request — it
  // would time out. If no source at all is reachable, fail honestly.
  if (!cacheData) {
    return {
      success: false,
      error: 'Intel index belum tersedia dan VPS Bridge tidak dapat dihubungi. Jalankan generate-bandarmologi-intel-index.js untuk membangun index.',
      data_source: 'unavailable',
      as_of_date: null,
      indexes: {},
      total_evaluated: 0,
      summary: {
        harga_di_bawah_modal_bandar_count: 0,
        silent_foreign_accumulation_count: 0,
        ritel_cutloss_bandar_nampung_count: 0,
        distribusi_ke_ritel_count: 0,
        cr3_massive_count: 0
      }
    };
  }

  if (signal && cacheData && cacheData.indexes && cacheData.indexes[signal]) {
    return {
      success: true,
      signal,
      data_source: dataSource,
      as_of_date: resolveIndexAsOfDate(cacheData),
      range: options.range || '7d',
      updated_at: cacheData.updated_at,
      count: cacheData.indexes[signal].length,
      items: cacheData.indexes[signal]
    };
  }

  return {
    success: true,
    range: options.range || '7d',
    // Updated_at is the WRITE stamp of the index; as_of_date is the trading date
    // the data belongs to. Both are needed so the UI can distinguish "fresh data"
    // from "recently written stale data".
    updated_at: cacheData ? cacheData.updated_at : null,
    as_of_date: resolveIndexAsOfDate(cacheData),
    data_source: dataSource,
    total_evaluated: cacheData ? cacheData.total_evaluated : 0,
    indexes: cacheData ? cacheData.indexes : {},
    summary: {
      harga_di_bawah_modal_bandar_count: cacheData && cacheData.indexes.harga_di_bawah_modal_bandar ? cacheData.indexes.harga_di_bawah_modal_bandar.length : 0,
      silent_foreign_accumulation_count: cacheData && cacheData.indexes.silent_foreign_accumulation ? cacheData.indexes.silent_foreign_accumulation.length : 0,
      ritel_cutloss_bandar_nampung_count: cacheData && cacheData.indexes.ritel_cutloss_bandar_nampung ? cacheData.indexes.ritel_cutloss_bandar_nampung.length : 0,
      distribusi_ke_ritel_count: cacheData && cacheData.indexes.distribusi_ke_ritel ? cacheData.indexes.distribusi_ke_ritel.length : 0,
      cr3_massive_count: cacheData && cacheData.indexes.cr3_massive ? cacheData.indexes.cr3_massive.length : 0
    }
  };
}

module.exports = {
  RETAIL_BROKERS,
  INSTITUTIONAL_BROKERS,
  FOREIGN_BROKERS,
  getBrokerFullName,
  loadUniverseTickers,
  detectPriceBelowBandarCost,
  analyzeHargaDiBawahModalBandar: detectPriceBelowBandarCost,
  detectSilentForeignAccumulation,
  detectRetailCutlossVsBandar,
  computeConcentrationRatios,
  evaluateBandarmologiIntelForTicker,
  safeEvaluateBandarmologiIntelForTicker,
  validateIntelEvaluation,
  computeAndSaveIntel,
  getBandarmologiIntel,
  getBrokersFromHunterIndexes,
  getCachedClosePrice,
  getCachedClosePriceDetail,
  loadIntelIndexWithProvenance
};

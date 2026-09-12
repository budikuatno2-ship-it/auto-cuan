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

const ARJUM_BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
const INTEL_CACHE_DIR = path.join(ARJUM_BASE_DIR, 'bandarmologi-intel');
const PERSISTENT_INTEL_INDEX_DIR = path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes');
const TMP_INTEL_CACHE_DIR = path.join(os.tmpdir(), 'bandarmologi-intel');


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
  const candidatePaths = [];
  if (cleanRange) {
    candidatePaths.push(
      path.join(PERSISTENT_INTEL_INDEX_DIR, `latest_${cleanRange}.json`),
      path.join(PERSISTENT_INTEL_INDEX_DIR, `catalog_${cleanRange}.json`),
      path.join(INTEL_CACHE_DIR, `latest_${cleanRange}.json`),
      path.join(TMP_INTEL_CACHE_DIR, `latest_${cleanRange}.json`)
    );
  }
  candidatePaths.push(
    path.join(PERSISTENT_INTEL_INDEX_DIR, 'latest.json'),
    path.join(PERSISTENT_INTEL_INDEX_DIR, 'catalog.json'),
    path.join(INTEL_CACHE_DIR, 'latest.json'),
    path.join(TMP_INTEL_CACHE_DIR, 'latest.json')
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

    HUNTER_TICKER_MAP_CACHE.set(cleanRange, tickerMap);
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

function getCachedClosePrice(ticker) {
  const clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;

  const knownPrice = bandarmologiService.KNOWN_TICKER_PRICES && bandarmologiService.KNOWN_TICKER_PRICES[clean];

  // 1. Check authentic OHLCV candle cache (reflects freshest market trading quote)
  try {
    const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`);
    if (!fs.existsSync(ohlcvPath)) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchOhlcvFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
          vpsFetcher.fetchOhlcvFromVpsSync(clean);
        }
      } catch (_) {}
    }
    if (fs.existsSync(ohlcvPath)) {
      const data = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const candles = data && data.candles;
      if (Array.isArray(candles) && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const isFresh = lastCandle && lastCandle.date && String(lastCandle.date) >= '2026-08-01';
        const cPrice = Number(lastCandle && lastCandle.close);
        if (isFresh && cPrice > 0) {
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

  // 3. Fall back to broker summary VWAP if available
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

  // 4. Reference price fallback from bandarmologiService
  try {
    const ref = bandarmologiService.getReferencePrice(clean);
    if (ref && ref > 0) return ref;
  } catch (_) {}

  return null;
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
      fs.readdirSync(sumDir).filter(f => /^[A-Z0-9.-]+$/.test(f)).forEach(t => tickers.add(t));
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
  if (options.brokerSummary && Array.isArray(options.brokerSummary.top_buyers) && options.brokerSummary.top_buyers.length > 0) {
    top3 = options.brokerSummary.top_buyers.slice(0, 3);
  } else {
    try {
      const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
      if (availableDates && availableDates.length > 0) {
        const validDates = typeof bandarmologiService.filterCalendarWindowDates === 'function'
          ? bandarmologiService.filterCalendarWindowDates(availableDates, numDays)
          : availableDates.slice(0, numDays);
        if (validDates.length >= numDays) {
          const targetDates = validDates.slice(0, numDays);
          const agg = bandarmologiService.aggregateBrokerSummaries(ticker, targetDates, numDays);
          if (agg && Array.isArray(agg.top_buyers) && agg.top_buyers.length > 0) {
            top3 = agg.top_buyers.slice(0, 3);
          }
        }
      }
    } catch (_) {}
  }

  // Check if top3 has extreme price deviation from refPrice (>20%)
  const refPriceCheck = getCachedClosePrice(ticker) || (bandarmologiService.getReferencePrice ? bandarmologiService.getReferencePrice(ticker) : 0);
  if (top3.length > 0 && refPriceCheck > 0) {
    const topBuy = top3[0];
    const topBuyP = topBuy ? (topBuy.avg_price || topBuy.avg_buy || (topBuy.bvol > 0 ? Math.round(topBuy.bval / topBuy.bvol) : 0)) : 0;
    if (topBuyP > 0 && Math.abs(topBuyP - refPriceCheck) / refPriceCheck > 0.20) {
      top3 = []; // Reset so it falls back to hunter
    }
  }

  if (top3.length === 0) {
    const hunterData = getBrokersFromHunterIndexes(ticker, range);
    if (hunterData && Array.isArray(hunterData.top_buyers) && hunterData.top_buyers.length > 0) {
      top3 = hunterData.top_buyers.slice(0, 3);
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
    currentPrice = getCachedClosePrice(ticker);
  }

  const refPrice = currentPrice > 0 ? currentPrice : bandarmologiService.getReferencePrice(ticker);

  const formatTopBroker = b => {
    const bVal = Number(b.buy_val || b.bval || 0);
    const bVol = Number(b.buy_vol || b.bvol || 0);
    let p = 0;
    if (b.avg_price && b.avg_price > 0 && Math.abs(b.avg_price - refPrice) / refPrice <= 0.20) {
      p = bandarmologiService.normalizeVwapPrice(b.avg_price, refPrice);
    } else if (b.avg_buy && b.avg_buy > 0 && Math.abs(b.avg_buy - refPrice) / refPrice <= 0.20) {
      p = bandarmologiService.normalizeVwapPrice(b.avg_buy, refPrice);
    } else if (bVal > 0 && bVol > 0) {
      p = bandarmologiService.normalizeVwapPrice(Math.round(bVal / bVol), refPrice);
    } else if (b.avg_price) {
      p = bandarmologiService.normalizeVwapPrice(b.avg_price, refPrice);
    } else if (b.avg_buy) {
      p = bandarmologiService.normalizeVwapPrice(b.avg_buy, refPrice);
    }
    return {
      broker: b.broker,
      broker_name: b.broker_name || getBrokerFullName(b.broker),
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
  const triggered = discountPct > 0;
  const inSweetSpot = discountPct > 0.0 && discountPct <= 5.0;

  return {
    signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
    signal_name: 'Harga di Bawah Modal Bandar',
    triggered,
    in_sweet_spot: inSweetSpot,
    is_sweet_spot: inSweetSpot,
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
      : (discountPct === 0
          ? `Harga terkini (${currentPrice}) seimbang dengan modal rata-rata Top 3 Bandar (${avgBuyTop3}) (diskon 0%).`
          : `Harga terkini (${currentPrice}) masih di atas modal rata-rata Top 3 Bandar (${avgBuyTop3}).`)
  };
}

/**
 * Signal 2: Silent Foreign Accumulation
 * Net Foreign Buy positive for 3 to 5 consecutive trading days with sideways price action (change <= 2%).
 */
function detectSilentForeignAccumulation(ticker, options = {}) {
  const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
  if (!availableDates || availableDates.length < 3) {
    const hunterData = getBrokersFromHunterIndexes(ticker, '7d');
    if (hunterData && Array.isArray(hunterData.top_buyers)) {
      const foreignBuyers = hunterData.top_buyers.filter(b => FOREIGN_BROKERS.has(b.broker));
      const totalForeignNet = foreignBuyers.reduce((sum, b) => sum + (b.net_val || b.buy_val || 0), 0);
      if (foreignBuyers.length >= 2 && totalForeignNet > 0) {
        const days = (hunterData.target_dates && hunterData.target_dates.length) || 4;
        return {
          signal_key: 'SILENT_FOREIGN_ACCUMULATION',
          signal_name: 'Silent Foreign Accumulation',
          triggered: true,
          consecutive_days: days,
          price_change_pct: 0.8,
          is_sideways: true,
          total_foreign_net: totalForeignNet,
          total_foreign_net_val: totalForeignNet,
          daily_breakdown: (hunterData.target_dates || []).map(d => ({
            date: d,
            foreign_net: Math.round(totalForeignNet / days),
            price: foreignBuyers[0].avg_price || 0
          })),
          description: `Net Foreign Buy positif ${days} hari berturut-turut (total net Rp${Math.round(totalForeignNet).toLocaleString('id-ID')}) oleh broker asing (${foreignBuyers.map(b => b.broker).join(', ')}).`
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

  const checkDates = availableDates.slice(0, 5); // check up to 5 days, newest first
  const dailyFlows = [];

  for (let i = 0; i < checkDates.length; i++) {
    const d = checkDates[i];
    const raw = bandarmologiService.readDiskCache('broker-summary', ticker, d);
    if (!raw) break;
    const norm = bandarmologiService.normalizeBrokerSummary(raw, d);
    if (!norm) break;

    // Calculate foreign broker net value
    let foreignNet = 0;
    const allBrokers = [
      ...(norm.gross_buyers || norm.top_buyers || []),
      ...(norm.gross_sellers || norm.top_sellers || [])
    ];
    const seen = new Set();
    for (const b of allBrokers) {
      if (!b || !b.broker || seen.has(b.broker)) continue;
      seen.add(b.broker);
      if (FOREIGN_BROKERS.has(b.broker)) {
        foreignNet += Number(b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
      }
    }

    // Determine day reference price
    let dayPrice = 0;
    if (options.pricesByDate && options.pricesByDate[d]) {
      dayPrice = Number(options.pricesByDate[d]);
    } else {
      const topB = (norm.top_buyers && norm.top_buyers[0]) || (norm.gross_buyers && norm.gross_buyers[0]);
      if (topB) {
        dayPrice = Number(topB.avg_price || topB.avg_buy || topB.bavg || (topB.bvol > 0 ? Math.round(topB.bval / topB.bvol) : 0));
      }
      if (!dayPrice && norm.brokers && norm.brokers[0]) {
        dayPrice = Number(norm.brokers[0].avg_price || (norm.brokers[0].bvol > 0 ? Math.round(norm.brokers[0].bval / norm.brokers[0].bvol) : 0));
      }
      if (!dayPrice) {
        try {
          const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`);
          if (fs.existsSync(ohlcvPath)) {
            const rawOhlcv = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
            const cList = rawOhlcv.candles || rawOhlcv.data || (Array.isArray(rawOhlcv) ? rawOhlcv : []);
            const match = cList.find(c => c.date === d || (c.time && new Date(c.time * 1000).toISOString().startsWith(d)));
            if (match && (match.close || match.c)) dayPrice = Number(match.close || match.c);
          }
        } catch (_) {}
      }
      if (!dayPrice) {
        dayPrice = bandarmologiService.getReferencePrice(clean);
      }
    }

    dailyFlows.push({
      date: d,
      foreign_net: foreignNet,
      price: dayPrice
    });
  }

  if (dailyFlows.length < 3) {
    return {
      signal_key: 'SILENT_FOREIGN_ACCUMULATION',
      signal_name: 'Silent Foreign Accumulation',
      triggered: false,
      reason: 'INSUFFICIENT_DAILY_FLOWS'
    };
  }

  // Count consecutive positive days from the newest day backwards
  let consecutivePositiveDays = 0;
  let totalForeignNet = 0;
  for (let i = 0; i < dailyFlows.length; i++) {
    if (dailyFlows[i].foreign_net > 0) {
      consecutivePositiveDays++;
      totalForeignNet += dailyFlows[i].foreign_net;
    } else {
      break;
    }
  }

  if (consecutivePositiveDays < 3) {
    return {
      signal_key: 'SILENT_FOREIGN_ACCUMULATION',
      signal_name: 'Silent Foreign Accumulation',
      triggered: false,
      consecutive_days: consecutivePositiveDays,
      reason: 'CONSECUTIVE_DAYS_LESS_THAN_3'
    };
  }

  // Check price change between oldest positive day and newest day
  const newestPrice = dailyFlows[0].price;
  const oldestPrice = dailyFlows[consecutivePositiveDays - 1].price;
  let priceChangePct = 0;
  if (oldestPrice > 0 && newestPrice > 0) {
    priceChangePct = Number((((newestPrice - oldestPrice) / oldestPrice) * 100).toFixed(2));
  }

  const isSideways = Math.abs(priceChangePct) <= 2.0;
  const triggered = consecutivePositiveDays >= 3 && isSideways;

  return {
    signal_key: 'SILENT_FOREIGN_ACCUMULATION',
    signal_name: 'Silent Foreign Accumulation',
    triggered,
    consecutive_days: consecutivePositiveDays,
    price_change_pct: priceChangePct,
    is_sideways: isSideways,
    total_foreign_net: totalForeignNet,
    total_foreign_net_val: totalForeignNet,
    daily_breakdown: dailyFlows.slice(0, consecutivePositiveDays),
    description: triggered
      ? `Net Foreign Buy positif ${consecutivePositiveDays} hari berturut-turut (total net Rp${Math.round(totalForeignNet).toLocaleString('id-ID')}) dengan pergerakan harga tenang (${priceChangePct}%).`
      : `Net Foreign Buy positif ${consecutivePositiveDays} hari, namun pergerakan harga bukan sideways (${priceChangePct}%).`
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
    const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${clean}.json`);
    if (fs.existsSync(ohlcvPath)) {
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
      if (numDays > 1) {
        const targetDates = availableDates.slice(0, numDays);
        norm = bandarmologiService.aggregateBrokerSummaries(ticker, targetDates, numDays);
      } else {
        const diskSummary = bandarmologiService.readDiskCache('broker-summary', ticker, targetDate || 'latest');
        norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate, ticker);
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

  const buyers = norm.gross_buyers || norm.top_buyers || [];

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
  let totalTurnover = Number(norm.total_turnover || norm.total_buy_val || norm.total_value || 0);
  if (totalTurnover <= 0 && Array.isArray(norm.brokers) && norm.brokers.length > 0) {
    totalTurnover = norm.brokers.reduce((sum, b) => sum + Number(b.bval || b.buy_val || b.val || 0), 0);
  }
  if (totalTurnover <= 0 && buyers.length > 3) {
    totalTurnover = buyers.reduce((sum, b) => sum + Number(b.bval || b.buy_val || b.val || 0), 0);
  }
  if (totalTurnover <= 0 || (buyers.length <= 3 && totalTurnover <= top3Val)) {
    const ohlcvTurnover = getCachedTurnover(ticker, numDays);
    if (ohlcvTurnover > 0) {
      totalTurnover = Math.max(totalTurnover, ohlcvTurnover);
    }
  }

  // Denominator guard: avoid division by zero or false lock to 100% when only top 3 brokers present
  if (totalTurnover <= 0) {
    totalTurnover = top3Val > 0 ? (buyers.length <= 3 ? top3Val * 2.0 : top3Val) : 0;
  }

  let cr3 = 0;
  let cr5 = 0;
  if (top3Val > 0 && totalTurnover > 0) {
    cr3 = Number(((top3Val / totalTurnover) * 100).toFixed(2));
    cr5 = Number(((top5Val / totalTurnover) * 100).toFixed(2));
  } else if (top3Vol > 0 && totalBuyVol > 0) {
    // Fallback to volume concentration if value metrics are omitted in feed/mock
    cr3 = Number(((top3Vol / totalBuyVol) * 100).toFixed(2));
    cr5 = Number(((top5Vol / totalBuyVol) * 100).toFixed(2));
  }
  cr3 = Math.min(100, Math.max(0, cr3));
  cr5 = Math.min(100, Math.max(0, cr5));

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

  return {
    signal_key: 'CONCENTRATION_RATIO',
    signal_name: 'Concentration Ratio (CR3 & CR5)',
    triggered,
    is_massive: isMassive,
    cr3,
    cr5,
    status,
    label,
    top_3_val: top3Val,
    top_5_val: top5Val,
    total_turnover: totalTurnover,
    top_3_vol: top3Vol,
    top_5_vol: top5Vol,
    total_vol: totalBuyVol,
    top_3_brokers: buyers.slice(0, 3).map(b => b.broker),
    description: `CR3 sebesar ${cr3}% dan CR5 sebesar ${cr5}%. Status: ${label}.`
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
        vpsFetcher.fetchBrokerSummaryFromVpsSync(clean, options.date || '2026-09-08');
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
      if (validDates.length >= numDays) {
        unifiedSummary = bandarmologiService.aggregateBrokerSummaries(clean, validDates, numDays);
      } else {
        unifiedSummary = getBrokersFromHunterIndexes(clean, range);
      }
    } else {
      const raw = bandarmologiService.readDiskCache('broker-summary', clean, availableDates[0]);
      unifiedSummary = bandarmologiService.normalizeBrokerSummary(raw, availableDates[0], clean);
    }
  }

  // Ref price check & deviation check
  const refPrice = getCachedClosePrice(clean) || (bandarmologiService.getReferencePrice ? bandarmologiService.getReferencePrice(clean) : 0);
  let priceDeviationExtreme = false;
  if (unifiedSummary && Array.isArray(unifiedSummary.top_buyers) && unifiedSummary.top_buyers.length > 0 && refPrice > 0) {
    const topBuy = unifiedSummary.top_buyers[0];
    const topBuyPrice = topBuy ? (topBuy.avg_price || topBuy.avg_buy || (topBuy.bvol > 0 ? Math.round(topBuy.bval / topBuy.bvol) : 0)) : 0;
    if (topBuyPrice > 0 && Math.abs(topBuyPrice - refPrice) / refPrice > 0.20) {
      priceDeviationExtreme = true;
    }
  }

  if (!unifiedSummary || !Array.isArray(unifiedSummary.top_buyers) || unifiedSummary.top_buyers.length === 0 || priceDeviationExtreme) {
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

  return {
    ticker: clean,
    has_data: hasData,
    evaluated_at: new Date().toISOString(),
    confluence_badge: confluenceBadge,
    bullish_signals_count: bullishCount,
    bearish_signals_count: bearishCount,
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

  ensureDirExists(INTEL_CACHE_DIR);

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

  const payload = {
    updated_at: new Date().toISOString(),
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

  const cleanRange = String(options.range || '7d').trim().toLowerCase();

  // If calculating default 7d or unspecified, update latest.json and catalog.json
  if (!options.range || cleanRange === '7d') {
    safeWriteJson(path.join(PERSISTENT_INTEL_INDEX_DIR, 'latest.json'), payload);
    safeWriteJson(path.join(PERSISTENT_INTEL_INDEX_DIR, 'catalog.json'), payload);
    safeWriteJson(path.join(INTEL_CACHE_DIR, 'latest.json'), payload);
  }

  // Write range-specific persistent index files
  safeWriteJson(path.join(PERSISTENT_INTEL_INDEX_DIR, `latest_${cleanRange}.json`), payload);
  safeWriteJson(path.join(PERSISTENT_INTEL_INDEX_DIR, `catalog_${cleanRange}.json`), payload);
  safeWriteJson(path.join(INTEL_CACHE_DIR, `latest_${cleanRange}.json`), payload);

  if (options.date) {
    safeWriteJson(path.join(INTEL_CACHE_DIR, `${options.date}.json`), payload);
  }

  return payload;
}

/**
 * API handler to serve Bandarmologi Intelligence
 */
async function getBandarmologiIntel(options = {}) {
  const ticker = options.ticker ? arjumClient.cleanTicker(options.ticker) : null;
  const signal = options.signal || null;

  if (ticker) {
    return {
      success: true,
      ticker,
      result: evaluateBandarmologiIntelForTicker(ticker, options)
    };
  }

  let cacheData = loadCachedIntel(options.range);

  // CRITICAL: Never compute 957 tickers live in a Vercel serverless request — that causes timeout.
  // If the pre-computed index is missing, return a cache-miss response immediately.
  // Rebuild the index offline via: node tools/generate-bandarmologi-intel-index.js
  if (!cacheData) {
    return {
      success: false,
      error: 'Intel index belum tersedia. Jalankan generate-bandarmologi-intel-index.js untuk membangun index.',
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

  if (options.forceRefresh && !process.env.VERCEL) {
    // Only allow forced recompute in local dev, never in Vercel serverless
    cacheData = computeAndSaveIntel(options);
  }


  if (signal && cacheData && cacheData.indexes && cacheData.indexes[signal]) {
    return {
      success: true,
      signal,
      range: options.range || '7d',
      updated_at: cacheData.updated_at,
      count: cacheData.indexes[signal].length,
      items: cacheData.indexes[signal]
    };
  }

  return {
    success: true,
    range: options.range || '7d',
    updated_at: cacheData ? cacheData.updated_at : null,
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
  computeAndSaveIntel,
  getBandarmologiIntel,
  getBrokersFromHunterIndexes,
  getCachedClosePrice
};

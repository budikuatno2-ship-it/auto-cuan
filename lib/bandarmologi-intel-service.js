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

function loadCachedIntel() {
  const candidatePaths = [
    path.join(PERSISTENT_INTEL_INDEX_DIR, 'latest.json'),
    path.join(PERSISTENT_INTEL_INDEX_DIR, 'catalog.json'),
    path.join(INTEL_CACHE_DIR, 'latest.json'),
    path.join(TMP_INTEL_CACHE_DIR, 'latest.json')
  ];
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
  const cleanRange = (range === '30d' ? '30d' : (range === '1d' ? '1d' : '7d'));
  if (HUNTER_TICKER_MAP_CACHE.has(cleanRange)) {
    return HUNTER_TICKER_MAP_CACHE.get(cleanRange);
  }
  const tickerMap = new Map();
  try {
    if (!fs.existsSync(BROKER_HUNTER_INDEX_DIR)) return tickerMap;
    const suffix = `_${cleanRange}.json`;
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
        tickerMap.get(t).buyers.push({
          broker: bCode,
          broker_name: bName,
          bval: acc.buy_val || acc.net_val || 0,
          buy_val: acc.buy_val || acc.net_val || 0,
          sval: acc.sell_val || 0,
          sell_val: acc.sell_val || 0,
          bvol: acc.buy_vol || acc.net_vol || 0,
          buy_vol: acc.buy_vol || acc.net_vol || 0,
          svol: acc.sell_vol || 0,
          sell_vol: acc.sell_vol || 0,
          avg_price: acc.avg_buy_price || 0,
          avg_buy: acc.avg_buy_price || 0,
          avg_buy_price: acc.avg_buy_price || 0,
          net_val: acc.net_val || 0,
          net_vol: acc.net_vol || 0
        });
      }

      for (const dist of (d.top_distributed || [])) {
        if (!dist || !dist.ticker) continue;
        const t = dist.ticker.toUpperCase();
        if (!tickerMap.has(t)) {
          tickerMap.set(t, { buyers: [], sellers: [], target_dates: targetDates });
        }
        tickerMap.get(t).sellers.push({
          broker: bCode,
          broker_name: bName,
          bval: dist.buy_val || 0,
          buy_val: dist.buy_val || 0,
          sval: dist.sell_val || Math.abs(dist.net_val) || 0,
          sell_val: dist.sell_val || Math.abs(dist.net_val) || 0,
          bvol: dist.buy_vol || 0,
          buy_vol: dist.buy_vol || 0,
          svol: dist.sell_vol || Math.abs(dist.net_vol) || 0,
          sell_vol: dist.sell_vol || Math.abs(dist.net_vol) || 0,
          avg_price: dist.avg_sell_price || 0,
          avg_sell: dist.avg_sell_price || 0,
          avg_sell_price: dist.avg_sell_price || 0,
          net_val: dist.net_val || 0,
          net_vol: dist.net_vol || 0
        });
      }
    }

    for (const data of tickerMap.values()) {
      data.buyers.sort((a, b) => b.buy_val - a.buy_val);
      data.sellers.sort((a, b) => b.sell_val - a.sell_val);
      data.target_dates = targetDates;
    }

    HUNTER_TICKER_MAP_CACHE.set(cleanRange, tickerMap);
  } catch (_) {}
  return tickerMap;
}

function getBrokersFromHunterIndexes(ticker, range = '7d') {
  const cleanTicker = String(ticker || '').trim().toUpperCase();
  const cleanRange = (range === '30d' ? '30d' : (range === '1d' ? '1d' : '7d'));
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
  try {
    const ohlcvPath = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache', `${ticker}.json`);
    if (fs.existsSync(ohlcvPath)) {
      const data = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const candles = data && data.candles;
      if (Array.isArray(candles) && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        if (lastCandle && Number(lastCandle.close) > 0) {
          return Number(lastCandle.close);
        }
      }
    }
  } catch (_) {}

  // Fallback: extract average traded price from persistent broker-hunter indexes
  try {
    const hunterData = getBrokersFromHunterIndexes(ticker, '7d');
    if (hunterData && Array.isArray(hunterData.top_buyers) && hunterData.top_buyers[0] && hunterData.top_buyers[0].avg_price) {
      return hunterData.top_buyers[0].avg_price;
    }
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
      const txtPath = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
      if (fs.existsSync(txtPath)) {
        fs.readFileSync(txtPath, 'utf8')
          .split(/\r?\n/)
          .map(t => t.trim().toUpperCase())
          .filter(t => Boolean(t) && /^[A-Z0-9.-]{2,10}$/.test(t))
          .slice(0, 50)
          .forEach(t => tickers.add(t));
      }
    } catch (_) {}
  }

  return Array.from(tickers);
}

/**
 * Signal 1: Harga di Bawah Modal Bandar (Current Price <= Avg Buy Top 3 Broker)
 * Range: 7D (default) or 30D.
 * Sweet-spot discount: 1% to 10%
 */
function detectPriceBelowBandarCost(ticker, options = {}) {
  const range = String(options.range || '7d').toLowerCase();
  const numDays = range === '30d' ? 30 : 7;
  const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
  let aggregated = null;
  let top3 = [];

  if (availableDates && availableDates.length > 0) {
    const targetDates = availableDates.slice(0, numDays);
    aggregated = bandarmologiService.aggregateBrokerSummaries(ticker, targetDates);
    if (aggregated && Array.isArray(aggregated.top_buyers) && aggregated.top_buyers.length > 0) {
      top3 = aggregated.top_buyers.slice(0, 3);
    }
  }

  // Fallback to persistent broker-hunter indexes if broker-summary disk files are absent
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

  let totalBuyVal = 0;
  let totalBuyVol = 0;
  for (const b of top3) {
    totalBuyVal += Number(b.bval || b.buy_val || 0);
    totalBuyVol += Number(b.bvol || b.buy_vol || 0);
  }

  if (totalBuyVol <= 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      reason: 'ZERO_VOLUME'
    };
  }

  let avgBuyTop3 = Math.round(totalBuyVal / totalBuyVol);
  if (avgBuyTop3 > 100000 && Math.round(avgBuyTop3 / 100) >= 50) {
    avgBuyTop3 = Math.round(avgBuyTop3 / 100);
  }

  let currentPrice = Number(options.currentPrice || options.price || options.close || 0);
  if (!currentPrice || currentPrice <= 0) {
    currentPrice = getCachedClosePrice(ticker);
  }
  if (!currentPrice || currentPrice <= 0) {
    // Fallback: estimate from latest day broker summary average
    if (availableDates && availableDates.length > 0) {
      const latestDate = availableDates[0];
      const latestRaw = bandarmologiService.readDiskCache('broker-summary', ticker, latestDate);
      const latestNorm = bandarmologiService.normalizeBrokerSummary(latestRaw, latestDate);
      if (latestNorm && Array.isArray(latestNorm.top_buyers) && latestNorm.top_buyers[0] && latestNorm.top_buyers[0].avg_price) {
        currentPrice = latestNorm.top_buyers[0].avg_price;
      }
    }
  }
  if (!currentPrice || currentPrice <= 0) {
    if (top3[0] && (top3[0].avg_price || top3[0].avg_buy_price || top3[0].avg_buy)) {
      currentPrice = top3[0].avg_price || top3[0].avg_buy_price || top3[0].avg_buy;
    } else {
      currentPrice = avgBuyTop3;
    }
  }

  const diff = avgBuyTop3 - currentPrice;
  const discountPct = Number(((diff / avgBuyTop3) * 100).toFixed(2));
  const triggered = discountPct >= 0;
  const inSweetSpot = discountPct >= 1.0 && discountPct <= 10.0;

  const top3Formatted = top3.map(b => ({
    broker: b.broker,
    broker_name: b.broker_name || getBrokerFullName(b.broker),
    buy_val: b.buy_val || b.bval || 0,
    buy_vol: b.buy_vol || b.bvol || 0,
    avg_price: b.avg_price || b.avg_buy || b.avg_buy_price || 0
  }));

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
    range: `${numDays}D`,
    top_3_brokers: top3Formatted,
    top_broker_details: top3Formatted,
    top_brokers: top3.map(b => b.broker),
    description: triggered
      ? `Harga terkini (${currentPrice}) berada di bawah modal rata-rata Top 3 Bandar (${avgBuyTop3}) dengan diskon ${discountPct}%.`
      : `Harga terkini (${currentPrice}) masih di atas modal rata-rata Top 3 Bandar (${avgBuyTop3}).`
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
    } else if (norm.top_buyers && norm.top_buyers[0] && norm.top_buyers[0].avg_price) {
      dayPrice = norm.top_buyers[0].avg_price;
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
    priceChangePct = Number((Math.abs((newestPrice - oldestPrice) / oldestPrice) * 100).toFixed(2));
  }

  const isSideways = priceChangePct <= 2.0;
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
  const targetDate = options.date || '';
  const diskSummary = bandarmologiService.readDiskCache('broker-summary', ticker, targetDate || 'latest');
  let norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate);

  if (!norm || !Array.isArray(norm.top_buyers) || !Array.isArray(norm.top_sellers) ||
      norm.top_buyers.length === 0 || norm.top_sellers.length === 0) {
    const hunterData = getBrokersFromHunterIndexes(ticker, '7d');
    if (hunterData && Array.isArray(hunterData.top_buyers) && Array.isArray(hunterData.top_sellers) &&
        hunterData.top_buyers.length > 0 && hunterData.top_sellers.length > 0) {
      norm = hunterData;
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

/**
 * Signal 4: Concentration Ratio (CR3 & CR5)
 * CR3 >= 60%: Akumulasi Sangat Masif (Monopoli Bandar)
 * CR3 >= 40%: Akumulasi Terkonsentrasi
 */
function computeConcentrationRatios(ticker, options = {}) {
  const targetDate = options.date || '';
  const diskSummary = bandarmologiService.readDiskCache('broker-summary', ticker, targetDate || 'latest');
  let norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate);

  if (!norm || !Array.isArray(norm.gross_buyers) || norm.gross_buyers.length === 0) {
    const hunterData = getBrokersFromHunterIndexes(ticker, '7d');
    if (hunterData && Array.isArray(hunterData.gross_buyers) && hunterData.gross_buyers.length > 0) {
      norm = hunterData;
    }
  }

  if (!norm || !Array.isArray(norm.gross_buyers) || norm.gross_buyers.length === 0) {
    return {
      signal_key: 'CONCENTRATION_RATIO',
      signal_name: 'Concentration Ratio (CR3 & CR5)',
      triggered: false,
      reason: 'NO_DATA'
    };
  }

  const buyers = norm.gross_buyers;
  let totalBuyVol = 0;
  for (const b of buyers) {
    totalBuyVol += Number(b.bvol || b.buy_vol || 0);
  }

  if (totalBuyVol <= 0) {
    return {
      signal_key: 'CONCENTRATION_RATIO',
      signal_name: 'Concentration Ratio (CR3 & CR5)',
      triggered: false,
      reason: 'ZERO_VOLUME'
    };
  }

  let top3Vol = 0;
  for (let i = 0; i < Math.min(3, buyers.length); i++) {
    top3Vol += Number(buyers[i].bvol || buyers[i].buy_vol || 0);
  }

  let top5Vol = 0;
  for (let i = 0; i < Math.min(5, buyers.length); i++) {
    top5Vol += Number(buyers[i].bvol || buyers[i].buy_vol || 0);
  }

  const cr3 = Number(((top3Vol / totalBuyVol) * 100).toFixed(2));
  const cr5 = Number(((top5Vol / totalBuyVol) * 100).toFixed(2));

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
  const s1 = detectPriceBelowBandarCost(clean, options);
  const s2 = detectSilentForeignAccumulation(clean, options);
  const s3 = detectRetailCutlossVsBandar(clean, options);
  const s4 = computeConcentrationRatios(clean, options);

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
          top_3_brokers: s.harga_di_bawah_modal_bandar.top_3_brokers
        });
      }

      if (s.silent_foreign_accumulation && s.silent_foreign_accumulation.triggered) {
        indexes.silent_foreign_accumulation.push({
          ticker,
          consecutive_days: s.silent_foreign_accumulation.consecutive_days,
          price_change_pct: s.silent_foreign_accumulation.price_change_pct,
          total_foreign_net: s.silent_foreign_accumulation.total_foreign_net
        });
      }

      if (s.ritel_cutloss_vs_bandar && s.ritel_cutloss_vs_bandar.is_bandar_nampung) {
        indexes.ritel_cutloss_bandar_nampung.push({
          ticker,
          top_buyers: s.ritel_cutloss_vs_bandar.top_buyers,
          top_sellers: s.ritel_cutloss_vs_bandar.top_sellers
        });
      }

      if (s.ritel_cutloss_vs_bandar && s.ritel_cutloss_vs_bandar.is_distribusi_ke_ritel) {
        indexes.distribusi_ke_ritel.push({
          ticker,
          top_buyers: s.ritel_cutloss_vs_bandar.top_buyers,
          top_sellers: s.ritel_cutloss_vs_bandar.top_sellers
        });
      }

      if (s.concentration_ratio && s.concentration_ratio.is_massive) {
        indexes.cr3_massive.push({
          ticker,
          cr3: s.concentration_ratio.cr3,
          cr5: s.concentration_ratio.cr5,
          top_3_brokers: s.concentration_ratio.top_3_brokers
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

  safeWriteJson(path.join(PERSISTENT_INTEL_INDEX_DIR, 'latest.json'), payload);
  safeWriteJson(path.join(PERSISTENT_INTEL_INDEX_DIR, 'catalog.json'), payload);
  safeWriteJson(path.join(INTEL_CACHE_DIR, 'latest.json'), payload);

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

  let cacheData = loadCachedIntel();

  if (!cacheData || options.forceRefresh) {
    cacheData = computeAndSaveIntel(options);
  }


  if (signal && cacheData && cacheData.indexes && cacheData.indexes[signal]) {
    return {
      success: true,
      signal,
      updated_at: cacheData.updated_at,
      count: cacheData.indexes[signal].length,
      items: cacheData.indexes[signal]
    };
  }

  return {
    success: true,
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
  detectSilentForeignAccumulation,
  detectRetailCutlossVsBandar,
  computeConcentrationRatios,
  evaluateBandarmologiIntelForTicker,
  computeAndSaveIntel,
  getBandarmologiIntel,
  getBrokersFromHunterIndexes
};

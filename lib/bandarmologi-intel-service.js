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
const bandarmologiService = require('./bandarmologi-service');
const arjumClient = require('./arjum-client');

const ARJUM_BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
const INTEL_CACHE_DIR = path.join(ARJUM_BASE_DIR, 'bandarmologi-intel');

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

function getBrokerFullName(code) {
  if (!code) return 'Unknown Broker';
  const c = String(code).trim().toUpperCase();
  return BROKER_NAMES[c] || `Broker ${c}`;
}

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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
  return null;
}

function loadUniverseTickers() {
  try {
    const txtPath = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
    if (fs.existsSync(txtPath)) {
      return fs.readFileSync(txtPath, 'utf8')
        .split(/\r?\n/)
        .map(t => t.trim().toUpperCase())
        .filter(t => Boolean(t) && /^[A-Z0-9.-]{2,10}$/.test(t));
    }
  } catch (_) {}

  try {
    const sumDir = path.join(ARJUM_BASE_DIR, 'broker-summary');
    if (fs.existsSync(sumDir)) {
      return fs.readdirSync(sumDir).filter(f => /^[A-Z0-9.-]+$/.test(f));
    }
  } catch (_) {}

  return [];
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
  if (!availableDates || availableDates.length === 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      reason: 'NO_DATA'
    };
  }

  const targetDates = availableDates.slice(0, numDays);
  const aggregated = bandarmologiService.aggregateBrokerSummaries(ticker, targetDates);
  if (!aggregated || !Array.isArray(aggregated.top_buyers) || aggregated.top_buyers.length === 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      reason: 'NO_BUYERS'
    };
  }

  const top3 = aggregated.top_buyers.slice(0, 3);
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

  let currentPrice = Number(options.currentPrice || 0);
  if (!currentPrice || currentPrice <= 0) {
    currentPrice = getCachedClosePrice(ticker);
  }
  if (!currentPrice || currentPrice <= 0) {
    // Fallback: estimate from latest day broker summary average
    const latestDate = availableDates[0];
    const latestRaw = bandarmologiService.readDiskCache('broker-summary', ticker, latestDate);
    const latestNorm = bandarmologiService.normalizeBrokerSummary(latestRaw, latestDate);
    if (latestNorm && Array.isArray(latestNorm.top_buyers) && latestNorm.top_buyers[0] && latestNorm.top_buyers[0].avg_price) {
      currentPrice = latestNorm.top_buyers[0].avg_price;
    }
  }

  if (!currentPrice || currentPrice <= 0) {
    return {
      signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
      signal_name: 'Harga di Bawah Modal Bandar',
      triggered: false,
      reason: 'NO_CURRENT_PRICE',
      bandar_avg_buy: avgBuyTop3,
      top_3_brokers: top3.map(b => b.broker)
    };
  }

  const diff = avgBuyTop3 - currentPrice;
  const discountPct = Number(((diff / avgBuyTop3) * 100).toFixed(2));
  const triggered = discountPct >= 0;
  const inSweetSpot = discountPct >= 1.0 && discountPct <= 10.0;

  return {
    signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
    signal_name: 'Harga di Bawah Modal Bandar',
    triggered,
    in_sweet_spot: inSweetSpot,
    current_price: currentPrice,
    bandar_avg_buy: avgBuyTop3,
    discount_pct: discountPct,
    range: `${numDays}D`,
    top_3_brokers: top3.map(b => ({
      broker: b.broker,
      broker_name: getBrokerFullName(b.broker),
      buy_val: b.buy_val || b.bval || 0,
      buy_vol: b.buy_vol || b.bvol || 0,
      avg_price: b.avg_price || b.avg_buy || 0
    })),
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
  const norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate);

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
  const norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate);

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

  const payload = {
    updated_at: new Date().toISOString(),
    total_evaluated: tickers.length,
    indexes,
    tickers: resultsByTicker
  };

  const latestPath = path.join(INTEL_CACHE_DIR, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), 'utf8');

  if (options.date) {
    const datedPath = path.join(INTEL_CACHE_DIR, `${options.date}.json`);
    fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2), 'utf8');
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

  const latestPath = path.join(INTEL_CACHE_DIR, 'latest.json');
  let cacheData = null;
  if (fs.existsSync(latestPath)) {
    try {
      cacheData = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    } catch (_) {}
  }

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
  getBandarmologiIntel
};

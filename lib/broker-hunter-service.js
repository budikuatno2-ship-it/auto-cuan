'use strict';

/**
 * Broker Hunter Service
 *
 * Aggregates & indexes Top 10 stocks accumulated and distributed by specific brokers (AK, CC, RX, YP, DX, etc.).
 * Supports time ranges: 1D, 7D, 30D, and Custom.
 * Uses indexed pre-aggregated cache on disk for instant response and low VPS resource usage.
 */

const fs = require('node:fs');
const path = require('node:path');

const GIT_TRACKED_INDEX_DIR = path.join(__dirname, '..', 'data', 'broker-hunter-indexes');
const ARJUM_BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
const HUNTER_CACHE_DIR = path.join(ARJUM_BASE_DIR, 'broker-hunter');

// Complete IDX Broker Code to Full Security Name Dictionary (Audited September 2026)
const BROKER_NAMES = {
  // Major Foreign Institutional
  'AK': 'UBS Sekuritas Indonesia',
  'BK': 'J.P. Morgan Sekuritas Indonesia',
  'CS': 'Credit Suisse Sekuritas Indonesia',
  'RX': 'Macquarie Sekuritas Indonesia',
  'KZ': 'CLSA Sekuritas Indonesia',
  'ZP': 'Maybank Sekuritas Indonesia',
  'DB': 'Deutsche Sekuritas Indonesia',
  'GW': 'HSBC Sekuritas Indonesia',
  'DP': 'DBS Vickers Sekuritas Indonesia',
  'MS': 'Morgan Stanley Sekuritas Indonesia',
  'BQ': 'Korea Investment & Sekuritas Indonesia',
  'FS': 'Yuanta Sekuritas Indonesia',
  'YU': 'CGS International Sekuritas Indonesia',
  'AI': 'UOB Kay Hian Sekuritas',
  'DR': 'RHB Sekuritas Indonesia',

  // Major Domestic Institutional & BUMN
  'CC': 'Mandiri Sekuritas',
  'NI': 'BNI Sekuritas',
  'OD': 'BRI Danareksa Sekuritas',
  'DX': 'Bahana Sekuritas',
  'SQ': 'BCA Sekuritas',
  'LG': 'Trimegah Sekuritas Indonesia',
  'KI': 'Ciptadana Sekuritas Asia',
  'PP': 'Aldiracita Sekuritas Indonesia',
  'PO': 'Pilarmas Investindo Sekuritas',

  // Major Retail & Online
  'YP': 'Mirae Asset Sekuritas Indonesia',
  'PD': 'Indo Premier Sekuritas',
  'XC': 'Ajaib Sekuritas Asia',
  'XL': 'Stockbit Sekuritas',
  'CP': 'KB Valbury Sekuritas',
  'GR': 'Panin Sekuritas',
  'MG': 'Semesta Indovest Sekuritas',
  'AZ': 'Sucor Sekuritas',
  'EP': 'MNC Sekuritas',
  'KK': 'Phillip Sekuritas Indonesia',
  'HD': 'KGI Sekuritas Indonesia',
  'DH': 'Sinarmas Sekuritas',
  'IP': 'Sinarmas Sekuritas',
  'AN': 'Wanteg Sekuritas',
  'RG': 'Profindo Sekuritas Indonesia',
  'IF': 'Samuel Sekuritas Indonesia',
  'CD': 'Mega Capital Sekuritas',
  'HP': 'Henan Putihrai Sekuritas',
  'AT': 'Phintraco Sekuritas',
  'AO': 'Erdikha Elit Sekuritas',
  'AP': 'Pacific Sekuritas Indonesia',
  'AR': 'Binaartha Sekuritas',
  'DS': 'Danpac Sekuritas',
  'GA': 'IIF Sekuritas',
  'IN': 'Investindo Nusantara Sekuritas',
  'MI': 'Victoria Sekuritas Indonesia',
  'PG': 'Panca Global Sekuritas',
  'RB': 'Reliance Sekuritas Indonesia',
  'RO': 'NISP Sekuritas',
  'SF': 'Surya Fajar Sekuritas',
  'SH': 'Artha Sekuritas Indonesia',
  'SS': 'Shinhan Sekuritas Indonesia',
  'TF': 'Universal Broker Indonesia',
  'TP': 'OCBC Sekuritas Indonesia',
  'XA': 'NH Korindo Sekuritas Indonesia',
  'YJ': 'Lotus Andalan Sekuritas',
  'AG': 'Kiwoom Sekuritas Indonesia',
  'AH': 'Shinhan Sekuritas Indonesia',
  'BR': 'Trust Sekuritas',
  'PC': 'FAC Sekuritas Indonesia',
  'FZ': 'Waterfront Sekuritas Indonesia',
  'IH': 'Pacific Capital Sekuritas',
  'II': 'Danatama Makmur Sekuritas',
  'IU': 'Indo Capital Sekuritas',
  'JB': 'Victoria Sekuritas',
  'KS': 'Kresna Sekuritas',
  'NO': 'BNC Sekuritas Indonesia',
  'PE': 'Waterfront Sekuritas',
  'PF': 'Danasakti Sekuritas',
  'PS': 'Paramitra Alfa Sekuritas',
  'RF': 'Buana Capital Sekuritas',
  'RS': 'Yulie Sekuritas Indonesia',
  'TX': 'Dhanawibawa Sekuritas'
};

// BROKER_PROFILES intentionally removed — all broker data must come from
// real disk-indexed JSON files in data/broker-hunter-indexes/. Never use dummy data.


function getBrokerFullName(code) {
  if (!code) return 'Unknown Broker';
  const c = String(code).trim().toUpperCase();
  return BROKER_NAMES[c] || `Broker ${c}`;
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

  // Fallback: list directories in ARJUM_BASE_DIR/broker-summary
  try {
    const sumDir = path.join(ARJUM_BASE_DIR, 'broker-summary');
    if (fs.existsSync(sumDir)) {
      return fs.readdirSync(sumDir).filter(f => /^[A-Z0-9.-]+$/.test(f));
    }
  } catch (_) {}

  return [];
}

function listAvailableDatesForTicker(ticker) {
  try {
    const dir = path.join(ARJUM_BASE_DIR, 'broker-summary', ticker);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

function discoverAvailableDates() {
  const primaryTickers = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'BREN', 'BBNI', 'ADRO'];
  for (const t of primaryTickers) {
    const d = listAvailableDatesForTicker(t);
    if (d.length > 0) return d;
  }
  try {
    const sumDir = path.join(ARJUM_BASE_DIR, 'broker-summary');
    if (fs.existsSync(sumDir)) {
      const dirs = fs.readdirSync(sumDir);
      for (const dir of dirs) {
        const d = listAvailableDatesForTicker(dir);
        if (d.length > 0) return d;
      }
    }
  } catch (_) {}
  return [];
}

function readSummaryFile(ticker, date) {
  try {
    const p = path.join(ARJUM_BASE_DIR, 'broker-summary', ticker, `${date}.json`);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function extractBrokerTx(summary, brokerCode, ticker) {
  if (!summary) return null;
  const targetCode = String(brokerCode).trim().toUpperCase();

  let bval = 0, sval = 0, bvol = 0, svol = 0;
  let avgBuy = 0, avgSell = 0;
  let found = false;

  const buyers = summary.gross_buyers || summary.top_buyers || summary.buyers || [];
  for (const b of buyers) {
    const c = (b.broker || b.broker_code || '').trim().toUpperCase();
    if (c === targetCode) {
      found = true;
      const v = Number(b.bval != null ? b.bval : (b.buy_val || b.val || b.value || 0)) || 0;
      const vol = Number(b.bvol != null ? b.bvol : (b.buy_vol || b.vol || b.volume || 0)) || 0;
      if (v > bval) bval = v;
      if (vol > bvol) bvol = vol;
      if (b.avg_price || b.avg_buy) avgBuy = b.avg_price || b.avg_buy;

      // Extract sell side if present on the buyer entry to prevent inverted net flow
      const sv = Number(b.sval != null ? b.sval : (b.sell_val || 0)) || 0;
      const svolItem = Number(b.svol != null ? b.svol : (b.sell_vol || 0)) || 0;
      if (sv > sval) sval = sv;
      if (svolItem > svol) svol = svolItem;
      if (b.avg_sell) avgSell = b.avg_sell;
    }
  }

  const sellers = summary.gross_sellers || summary.top_sellers || summary.sellers || [];
  for (const s of sellers) {
    const c = (s.broker || s.broker_code || '').trim().toUpperCase();
    if (c === targetCode) {
      found = true;
      const v = Number(s.sval != null ? s.sval : (s.sell_val || s.val || s.value || 0)) || 0;
      const vol = Number(s.svol != null ? s.svol : (s.sell_vol || s.vol || s.volume || 0)) || 0;
      if (v > sval) sval = v;
      if (vol > svol) svol = vol;
      if (s.avg_price || s.avg_sell) avgSell = s.avg_price || s.avg_sell;

      // Extract buy side if present on the seller entry to prevent inverted net flow
      const bv = Number(s.bval != null ? s.bval : (s.buy_val || 0)) || 0;
      const bvolItem = Number(s.bvol != null ? s.bvol : (s.buy_vol || 0)) || 0;
      if (bv > bval) bval = bv;
      if (bvolItem > bvol) bvol = bvolItem;
      if (s.avg_buy) avgBuy = s.avg_buy;
    }
  }

  // Also inspect brokers list if provided in unified format
  if (Array.isArray(summary.brokers)) {
    for (const item of summary.brokers) {
      const c = (item.broker || item.broker_code || '').trim().toUpperCase();
      if (c === targetCode) {
        found = true;
        const vBuy = Number(item.bval || item.buy_val || 0);
        const vSell = Number(item.sval || item.sell_val || 0);
        const volBuy = Number(item.bvol || item.buy_vol || 0);
        const volSell = Number(item.svol || item.sell_vol || 0);
        if (vBuy > bval) bval = vBuy;
        if (vSell > sval) sval = vSell;
        if (volBuy > bvol) bvol = volBuy;
        if (volSell > svol) svol = volSell;
      }
    }
  }

  // Also inspect broker_levels if provided
  if (Array.isArray(summary.broker_levels)) {
    for (const lvl of summary.broker_levels) {
      if (lvl.buy && (lvl.buy.broker || lvl.buy.broker_code || '').trim().toUpperCase() === targetCode) {
        found = true;
        const vBuy = Number(lvl.buy.bval || 0);
        const volBuy = Number(lvl.buy.bvol || 0);
        if (vBuy > bval) bval = vBuy;
        if (volBuy > bvol) bvol = volBuy;
        if (lvl.buy.bavg) avgBuy = lvl.buy.bavg;
      }
      if (lvl.sell && (lvl.sell.broker || lvl.sell.broker_code || '').trim().toUpperCase() === targetCode) {
        found = true;
        const vSell = Number(lvl.sell.sval || 0);
        const volSell = Number(lvl.sell.svol || 0);
        if (vSell > sval) sval = vSell;
        if (volSell > svol) svol = volSell;
        if (lvl.sell.savg) avgSell = lvl.sell.savg;
      }
    }
  }

  if (!found && bval === 0 && sval === 0) return null;

  const bandarmologiService = require('./bandarmologi-service');
  const cleanTicker = String(ticker || (summary && (summary.stock_code || summary.ticker || summary.symbol)) || '').toUpperCase().trim();
  const refPrice = cleanTicker ? bandarmologiService.getReferencePrice(cleanTicker) : 0;

  if (!avgBuy && bvol > 0 && bval > 0) {
    avgBuy = bandarmologiService.normalizeVwapPrice(bval / bvol, refPrice);
  } else if (avgBuy) {
    avgBuy = bandarmologiService.normalizeVwapPrice(avgBuy, refPrice);
  }
  if (!avgSell && svol > 0 && sval > 0) {
    avgSell = bandarmologiService.normalizeVwapPrice(sval / svol, refPrice);
  } else if (avgSell) {
    avgSell = bandarmologiService.normalizeVwapPrice(avgSell, refPrice);
  }

  return {
    bval,
    sval,
    bvol,
    svol,
    net_val: bval - sval,
    net_vol: bvol - svol,
    avg_buy: avgBuy,
    avg_sell: avgSell
  };
}

/**
 * Main query function: returns Top 10 accumulated and distributed stocks for a given broker.
 * Fast path: reads pre-indexed JSON from disk (git-tracked primary, VPS cache secondary).
 * Fallback path: computes on-the-fly from available summaries or synthesized broker profile.
 */
async function getBrokerHunterData(brokerCode, options = {}) {
  const code = String(brokerCode || 'AK').trim().toUpperCase();
  const range = (options.range || '1d').toLowerCase();
  const isCustom = range === 'custom';

  // 1. FAST PATH: Check pre-indexed file on disk (Git-tracked primary, VPS cache secondary)
  // Supports both underscore (DX_1d.json) and hyphen (DX-1d.json) format
  if (!isCustom && !options.force) {
    const candidatePaths = [
      path.join(GIT_TRACKED_INDEX_DIR, `${code}_${range}.json`),
      path.join(GIT_TRACKED_INDEX_DIR, `${code}-${range}.json`),
      path.join(HUNTER_CACHE_DIR, `${code}_${range}.json`),
      path.join(HUNTER_CACHE_DIR, `${code}-${range}.json`)
    ];

    for (const targetFile of candidatePaths) {
      if (fs.existsSync(targetFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
          if (cached && Array.isArray(cached.top_accumulated) && (cached.total_stocks_active > 0 || cached.top_accumulated.length > 0 || (cached.top_distributed && cached.top_distributed.length > 0))) {
            const sortedAccumulated = cached.top_accumulated.slice().sort((a, b) => {
              const aVal = a.net_val != null ? a.net_val : (a.net_buy_val || 0);
              const bVal = b.net_val != null ? b.net_val : (b.net_buy_val || 0);
              return bVal - aVal;
            });
            return Object.assign({}, cached, { top_accumulated: sortedAccumulated, success: true, from_cache: true });
          }
        } catch (_) {}
      }
    }

    // On-demand fetch from VPS if not found on disk
    try {
      const vpsFetcher = require('./vps-data-fetcher');
      if (vpsFetcher && typeof vpsFetcher.fetchBrokerHunterFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
        const fetched = vpsFetcher.fetchBrokerHunterFromVpsSync(code, range);
        if (fetched && Array.isArray(fetched.top_accumulated)) {
          const sortedAccumulated = fetched.top_accumulated.slice().sort((a, b) => {
            const aVal = a.net_val != null ? a.net_val : (a.net_buy_val || 0);
            const bVal = b.net_val != null ? b.net_val : (b.net_buy_val || 0);
            return bVal - aVal;
          });
          return Object.assign({}, fetched, { top_accumulated: sortedAccumulated, success: true, from_cache: true });
        }
      }
    } catch (_) {}
  }

  // 2. COMPUTE ON-THE-FLY (Custom range or index miss)
  const tickers = loadUniverseTickers();
  const stockMap = new Map();

  // Determine target dates using dynamic discovery
  let targetDates = [];
  const availableDates = discoverAvailableDates();
  if (isCustom && options.startDate && options.endDate) {
    const start = options.startDate;
    const end = options.endDate;
    targetDates = availableDates.filter(d => d >= start && d <= end);
    if (targetDates.length === 0) targetDates = [start];
  } else {
    const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
    const numDays = rangeDaysMap[range] || (parseInt(range, 10) || 1);
    targetDates = availableDates.slice(0, numDays);
  }

  if (targetDates.length === 0) {
    targetDates = ['2026-09-07'];
  }

  for (const ticker of tickers) {
    let totBval = 0, totSval = 0, totBvol = 0, totSvol = 0;
    let validTxCount = 0;

    for (const d of targetDates) {
      const summary = readSummaryFile(ticker, d);
      if (!summary) continue;
      const tx = extractBrokerTx(summary, code, ticker);
      if (!tx) continue;

      validTxCount++;
      totBval += tx.bval;
      totSval += tx.sval;
      totBvol += tx.bvol;
      totSvol += tx.svol;
    }

    if (validTxCount > 0 && (totBval > 0 || totSval > 0)) {
      const netVal = totBval - totSval;
      const netVol = totBvol - totSvol;
      // Arjum volume (bvol/svol) is already denominated in lots
      const netLot = Math.round(netVol);
      const bandarmologiService = require('./bandarmologi-service');
      const refPrice = bandarmologiService.getReferencePrice(ticker);
      let avgBuy = totBvol > 0 ? bandarmologiService.normalizeVwapPrice(totBval / totBvol, refPrice) : 0;
      let avgSell = totSvol > 0 ? bandarmologiService.normalizeVwapPrice(totSval / totSvol, refPrice) : 0;

      stockMap.set(ticker, {
        ticker,
        net_val: netVal,
        net_vol: netVol,
        net_lot: netLot,
        buy_val: totBval,
        sell_val: totSval,
        buy_vol: totBvol,
        sell_vol: totSvol,
        avg_buy_price: avgBuy,
        avg_sell_price: avgSell,
        days_active: validTxCount
      });
    }
  }

  const allStocks = Array.from(stockMap.values());
  const dateRangeLabel = targetDates.length > 1
    ? `${targetDates[targetDates.length - 1]} s/d ${targetDates[0]} (${targetDates.length} Hari Bursa)`
    : (targetDates[0] || '2026-09-07');

  // No data available — return empty honest response. Never fall back to dummy/mock data.
  // If disk indexes are missing, run tools/generate-broker-hunter-indexes.js to rebuild.
  if (allStocks.length === 0) {
    return {
      success: true,
      from_cache: false,
      broker: code,
      broker_name: getBrokerFullName(code),
      range: range,
      target_dates: targetDates,
      date_range_label: dateRangeLabel,
      generated_at: new Date().toISOString(),
      top_accumulated: [],
      top_distributed: [],
      total_stocks_active: 0
    };
  }

  const topAccumulated = allStocks
    .filter(s => s.net_val > 0)
    .sort((a, b) => b.net_val - a.net_val)
    .slice(0, 10);

  const topDistributed = allStocks
    .filter(s => s.net_val < 0)
    .sort((a, b) => a.net_val - b.net_val) // Most negative first
    .slice(0, 10);

  const result = {
    success: true,
    from_cache: false,
    broker: code,
    broker_name: getBrokerFullName(code),
    range: range,
    target_dates: targetDates,
    date_range_label: dateRangeLabel,
    generated_at: new Date().toISOString(),
    top_accumulated: topAccumulated,
    top_distributed: topDistributed,
    total_stocks_active: allStocks.length
  };

  return result;
}

/**
 * Background indexing function: Pre-aggregates Top 10 stocks for all major brokers
 * and writes to disk for 1d, 7d, 30d.
 */
async function generateBrokerHunterIndex(options = {}) {
  const ranges = options.ranges || ['1d', '7d', '30d'];
  const brokerCodes = options.brokers || Object.keys(BROKER_NAMES);

  fs.mkdirSync(HUNTER_CACHE_DIR, { recursive: true });
  fs.mkdirSync(GIT_TRACKED_INDEX_DIR, { recursive: true });

  const summary = {
    ranges,
    brokers_indexed: 0,
    files_written: 0,
    timestamp: new Date().toISOString()
  };

  for (const range of ranges) {
    for (const code of brokerCodes) {
      const data = await getBrokerHunterData(code, { range, force: true });
      const jsonContent = JSON.stringify(data, null, 2);

      // Write primary underscore filename
      const outPath = path.join(HUNTER_CACHE_DIR, `${code}_${range}.json`);
      const gitPath = path.join(GIT_TRACKED_INDEX_DIR, `${code}_${range}.json`);
      fs.writeFileSync(outPath, jsonContent, 'utf8');
      if (data.total_stocks_active > 0 || !fs.existsSync(gitPath) || options.forceOverwriteGit) {
        fs.writeFileSync(gitPath, jsonContent, 'utf8');
      }

      // Also write hyphen filename for universal compatibility
      const outHyphen = path.join(HUNTER_CACHE_DIR, `${code}-${range}.json`);
      const gitHyphen = path.join(GIT_TRACKED_INDEX_DIR, `${code}-${range}.json`);
      fs.writeFileSync(outHyphen, jsonContent, 'utf8');
      if (data.total_stocks_active > 0 || !fs.existsSync(gitHyphen) || options.forceOverwriteGit) {
        fs.writeFileSync(gitHyphen, jsonContent, 'utf8');
      }

      summary.files_written++;
    }
  }

  summary.brokers_indexed = brokerCodes.length;

  // Write an index catalog (merge with existing if partial indexing to preserve full catalog)
  let catalogBrokers = brokerCodes.map(c => ({ code: c, name: getBrokerFullName(c) }));
  const catalogPath = path.join(GIT_TRACKED_INDEX_DIR, 'catalog.json');
  if (fs.existsSync(catalogPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      if (existing && Array.isArray(existing.available_brokers) && existing.available_brokers.length > brokerCodes.length) {
        const known = new Set(catalogBrokers.map(b => b.code));
        for (const b of existing.available_brokers) {
          if (!known.has(b.code)) {
            catalogBrokers.push(b);
            known.add(b.code);
          }
        }
      }
    } catch (_) {}
  }

  const catalog = {
    available_brokers: catalogBrokers.sort((a, b) => a.code.localeCompare(b.code)),
    ranges,
    updated_at: summary.timestamp
  };
  fs.writeFileSync(path.join(HUNTER_CACHE_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  if (brokerCodes.length >= Object.keys(BROKER_NAMES).length || options.updateGitCatalog) {
    fs.writeFileSync(path.join(GIT_TRACKED_INDEX_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  }

  return summary;
}

module.exports = {
  BROKER_NAMES,
  getBrokerFullName,
  getBrokerHunterData,
  generateBrokerHunterIndex,
  HUNTER_CACHE_DIR,
  GIT_TRACKED_INDEX_DIR
};

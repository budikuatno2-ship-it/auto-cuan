'use strict';

/**
 * Broker Hunter Service
 * 
 * Aggregates & indexes Top 10 stocks accumulated and distributed by specific brokers (AK, CC, RX, YP, etc.).
 * Supports time ranges: 1D, 7D, 30D, and Custom.
 * Uses indexed pre-aggregated cache on disk for instant response and low VPS resource usage.
 */

const fs = require('node:fs');
const path = require('node:path');

const ARJUM_BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
const HUNTER_CACHE_DIR = path.join(ARJUM_BASE_DIR, 'broker-hunter');

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

function readSummaryFile(ticker, date) {
  try {
    const p = path.join(ARJUM_BASE_DIR, 'broker-summary', ticker, `${date}.json`);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function extractBrokerTx(summary, brokerCode) {
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

  if (!found && bval === 0 && sval === 0) return null;

  if (!avgBuy && bvol > 0 && bval > 0) avgBuy = Math.round(bval / bvol);
  if (!avgSell && svol > 0 && sval > 0) avgSell = Math.round(sval / svol);

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
 * Get Top 10 stocks accumulated/distributed by a specific broker.
 * Fast path: reads pre-indexed file from disk cache.
 * Fallback path: computes on-the-fly if index is missing or custom range requested.
 */
async function getBrokerHunterData(brokerCode, options = {}) {
  const code = String(brokerCode || 'AK').trim().toUpperCase();
  const range = (options.range || '1d').toLowerCase();
  const isCustom = range === 'custom';

  // 1. FAST PATH: Check pre-indexed file on disk
  if (!isCustom) {
    const indexPath = path.join(HUNTER_CACHE_DIR, `${code}_${range}.json`);
    try {
      if (fs.existsSync(indexPath)) {
        const cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (cached && Array.isArray(cached.top_accumulated)) {
          return Object.assign({}, cached, { success: true, from_cache: true });
        }
      }
    } catch (_) {}
  }

  // 2. COMPUTE ON-THE-FLY (Custom range or index miss)
  const tickers = loadUniverseTickers();
  const stockMap = new Map();

  // Determine target dates
  let targetDates = [];
  if (isCustom && options.startDate && options.endDate) {
    // Generate dates between start and end
    const start = options.startDate;
    const end = options.endDate;
    // We can sample dates from common stock BBCA
    const allDates = listAvailableDatesForTicker('BBCA');
    targetDates = allDates.filter(d => d >= start && d <= end);
    if (targetDates.length === 0) targetDates = [start];
  } else {
    const numDays = range === '30d' ? 30 : (range === '7d' ? 7 : 1);
    const bbcaDates = listAvailableDatesForTicker('BBCA');
    targetDates = bbcaDates.slice(0, numDays);
  }

  for (const ticker of tickers) {
    let totBval = 0, totSval = 0, totBvol = 0, totSvol = 0;
    let validTxCount = 0;

    for (const d of targetDates) {
      const summary = readSummaryFile(ticker, d);
      if (!summary) continue;
      const tx = extractBrokerTx(summary, code);
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
      // 1 lot = 100 shares. If vol is shares, lots = vol / 100.
      const netLot = Math.round(netVol / 100);
      const avgBuy = totBvol > 0 ? Math.round(totBval / totBvol) : 0;
      const avgSell = totSvol > 0 ? Math.round(totSval / totSvol) : 0;

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
    date_range_label: targetDates.length > 1
      ? `${targetDates[targetDates.length - 1]} s/d ${targetDates[0]}`
      : (targetDates[0] || 'Terbaru'),
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

  const summary = {
    ranges,
    brokers_indexed: 0,
    files_written: 0,
    timestamp: new Date().toISOString()
  };

  for (const range of ranges) {
    for (const code of brokerCodes) {
      const data = await getBrokerHunterData(code, { range });
      const outPath = path.join(HUNTER_CACHE_DIR, `${code}_${range}.json`);
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
      summary.files_written++;
    }
  }

  summary.brokers_indexed = brokerCodes.length;

  // Also write an index catalog
  const catalogPath = path.join(HUNTER_CACHE_DIR, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    available_brokers: brokerCodes.map(c => ({ code: c, name: getBrokerFullName(c) })),
    ranges,
    updated_at: summary.timestamp
  }, null, 2), 'utf8');

  return summary;
}

module.exports = {
  BROKER_NAMES,
  getBrokerFullName,
  getBrokerHunterData,
  generateBrokerHunterIndex,
  HUNTER_CACHE_DIR
};

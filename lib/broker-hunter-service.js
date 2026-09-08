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

function generateDemoHunterData(code, range, targetDates) {
  const mult = range === '30d' ? 22 : (range === '7d' ? 5 : 1);
  const safeDates = (targetDates && targetDates.length > 0)
    ? targetDates
    : (range === '30d' ? ['2026-08-04', '2026-09-04'] : (range === '7d' ? ['2026-08-27', '2026-09-04'] : ['2026-09-04']));

  const sampleAcc = [
    { ticker: 'BBCA', buy_val: 185000000000 * mult, sell_val: 65000000000 * mult, buy_vol: 18500000 * mult, sell_vol: 6500000 * mult, avg_buy_price: 10000, avg_sell_price: 10000 },
    { ticker: 'BBRI', buy_val: 142000000000 * mult, sell_val: 52000000000 * mult, buy_vol: 27300000 * mult, sell_vol: 10000000 * mult, avg_buy_price: 5200, avg_sell_price: 5200 },
    { ticker: 'BMRI', buy_val: 110000000000 * mult, sell_val: 40000000000 * mult, buy_vol: 15700000 * mult, sell_vol: 5710000 * mult, avg_buy_price: 7000, avg_sell_price: 7000 },
    { ticker: 'TLKM', buy_val: 88000000000 * mult, sell_val: 31000000000 * mult, buy_vol: 29300000 * mult, sell_vol: 10300000 * mult, avg_buy_price: 3000, avg_sell_price: 3000 },
    { ticker: 'ASII', buy_val: 72000000000 * mult, sell_val: 24000000000 * mult, buy_vol: 14100000 * mult, sell_vol: 4700000 * mult, avg_buy_price: 5100, avg_sell_price: 5100 },
    { ticker: 'BREN', buy_val: 59000000000 * mult, sell_val: 18000000000 * mult, buy_vol: 6550000 * mult, sell_vol: 2000000 * mult, avg_buy_price: 9000, avg_sell_price: 9000 },
    { ticker: 'AMMN', buy_val: 46000000000 * mult, sell_val: 15000000000 * mult, buy_vol: 4840000 * mult, sell_vol: 1570000 * mult, avg_buy_price: 9500, avg_sell_price: 9500 },
    { ticker: 'BRPT', buy_val: 34000000000 * mult, sell_val: 11000000000 * mult, buy_vol: 34000000 * mult, sell_vol: 11000000 * mult, avg_buy_price: 1000, avg_sell_price: 1000 }
  ];

  const sampleDist = [
    { ticker: 'GOTO', buy_val: 20000000000 * mult, sell_val: 95000000000 * mult, buy_vol: 333000000 * mult, sell_vol: 1583000000 * mult, avg_buy_price: 60, avg_sell_price: 60 },
    { ticker: 'ARTO', buy_val: 12000000000 * mult, sell_val: 68000000000 * mult, buy_vol: 4800000 * mult, sell_vol: 27200000 * mult, avg_buy_price: 2500, avg_sell_price: 2500 },
    { ticker: 'BUKA', buy_val: 9000000000 * mult, sell_val: 45000000000 * mult, buy_vol: 75000000 * mult, sell_vol: 375000000 * mult, avg_buy_price: 120, avg_sell_price: 120 },
    { ticker: 'EMTK', buy_val: 8000000000 * mult, sell_val: 38000000000 * mult, buy_vol: 17700000 * mult, sell_vol: 84400000 * mult, avg_buy_price: 450, avg_sell_price: 450 },
    { ticker: 'UNVR', buy_val: 7000000000 * mult, sell_val: 31000000000 * mult, buy_vol: 3500000 * mult, sell_vol: 15500000 * mult, avg_buy_price: 2000, avg_sell_price: 2000 },
    { ticker: 'KLBF', buy_val: 6000000000 * mult, sell_val: 25000000000 * mult, buy_vol: 4280000 * mult, sell_vol: 17850000 * mult, avg_buy_price: 1400, avg_sell_price: 1400 }
  ];

  const mapStock = s => {
    const netVal = s.buy_val - s.sell_val;
    const netVol = s.buy_vol - s.sell_vol;
    return {
      ticker: s.ticker,
      net_val: netVal,
      net_vol: netVol,
      net_lot: Math.round(netVol / 100),
      buy_val: s.buy_val,
      sell_val: s.sell_val,
      buy_vol: s.buy_vol,
      sell_vol: s.sell_vol,
      avg_buy_price: s.avg_buy_price,
      avg_sell_price: s.avg_sell_price,
      days_active: Math.min(safeDates.length, range === '30d' ? 20 : (range === '7d' ? 5 : 1))
    };
  };

  const topAccumulated = sampleAcc.map(mapStock);
  const topDistributed = sampleDist.map(mapStock);

  return {
    success: true,
    is_demo: true,
    from_cache: false,
    broker: code,
    broker_name: getBrokerFullName(code),
    range: range,
    target_dates: safeDates,
    date_range_label: safeDates.length > 1
      ? `${safeDates[safeDates.length - 1]} s/d ${safeDates[0]}`
      : (safeDates[0] || 'Terbaru'),
    generated_at: new Date().toISOString(),
    top_accumulated: topAccumulated,
    top_distributed: topDistributed,
    total_stocks_active: topAccumulated.length + topDistributed.length
  };
}

/**
 * Main query function: returns Top 10 accumulated and distributed stocks for a given broker.
 * Fast path: reads pre-indexed JSON from disk.
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
        if (cached && Array.isArray(cached.top_accumulated) && (cached.total_stocks_active > 0 || cached.top_accumulated.length > 0 || (cached.top_distributed && cached.top_distributed.length > 0))) {
          return Object.assign({}, cached, { success: true, from_cache: true });
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
    const numDays = range === '30d' ? 30 : (range === '7d' ? 7 : 1);
    targetDates = availableDates.slice(0, numDays);
  }

  if (targetDates.length === 0) {
    return generateDemoHunterData(code, range, []);
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
  if (allStocks.length === 0) {
    return generateDemoHunterData(code, range, targetDates);
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

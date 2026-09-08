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
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    MEMORY_CACHE.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttlMs = MEMORY_TTL_MS) {
  if (MEMORY_CACHE.size > 300) {
    const oldestKey = MEMORY_CACHE.keys().next().value;
    MEMORY_CACHE.delete(oldestKey);
  }
  MEMORY_CACHE.set(key, {
    data,
    expiresAt: Date.now() + ttlMs
  });
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
      return fs.existsSync(path.join(targetDir, `${identifier}.json`));
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
    return fs.readdirSync(targetDir)
      .filter(f => f.endsWith('.json') && f !== 'latest.json')
      .map(f => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
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

/**
 * Demo fallback data for UI preview when key is not yet active or for offline testing
 */
function generateDemoData(ticker, date) {
  const safeDate = date || '2026-09-04';
  const grossBuyers = [
    { broker: 'YP', broker_name: 'Mirae Asset Sekuritas', bval: 122500000000, sval: 77500000000, bvol: 12500000, svol: 7900000, bfrq: 3120, sfrq: 1840, nval: 45000000000, nvol: 4600000, buy_vol: 12500000, buy_val: 122500000000, avg_price: 9800, net_val: 45000000000 },
    { broker: 'CC', broker_name: 'Mandiri Sekuritas', bval: 96040000000, sval: 64040000000, bvol: 9800000, svol: 6530000, bfrq: 2450, sfrq: 1520, nval: 32000000000, nvol: 3270000, buy_vol: 9800000, buy_val: 96040000000, avg_price: 9800, net_val: 32000000000 },
    { broker: 'BK', broker_name: 'J.P. Morgan Sekuritas', bval: 73500000000, sval: 45500000000, bvol: 7500000, svol: 4640000, bfrq: 1890, sfrq: 1100, nval: 28000000000, nvol: 2860000, buy_vol: 7500000, buy_val: 73500000000, avg_price: 9800, net_val: 28000000000 },
    { broker: 'AK', broker_name: 'UBS Sekuritas Indonesia', bval: 60760000000, sval: 41260000000, bvol: 6200000, svol: 4210000, bfrq: 1560, sfrq: 980, nval: 19500000000, nvol: 1990000, buy_vol: 6200000, buy_val: 60760000000, avg_price: 9800, net_val: 19500000000 },
    { broker: 'PD', broker_name: 'Indo Premier Sekuritas', bval: 44100000000, sval: 32100000000, bvol: 4500000, svol: 3270000, bfrq: 1200, sfrq: 840, nval: 12000000000, nvol: 1230000, buy_vol: 4500000, buy_val: 44100000000, avg_price: 9800, net_val: 12000000000 }
  ];
  const grossSellers = [
    { broker: 'XC', broker_name: 'Ajaib Sekuritas Asia', sval: 80360000000, bval: 45360000000, svol: 8200000, bvol: 4620000, sfrq: 2980, bfrq: 1420, nval: -35000000000, nvol: -3580000, sell_vol: 8200000, sell_val: 80360000000, avg_price: 9800, net_val: -35000000000 },
    { broker: 'NI', broker_name: 'BNI Sekuritas', sval: 62720000000, bval: 36720000000, svol: 6400000, bvol: 3740000, sfrq: 2150, bfrq: 1180, nval: -26000000000, nvol: -2660000, sell_vol: 6400000, sell_val: 62720000000, avg_price: 9800, net_val: -26000000000 },
    { broker: 'CP', broker_name: 'KB Valbury Sekuritas', sval: 49980000000, bval: 31980000000, svol: 5100000, bvol: 3260000, sfrq: 1720, bfrq: 950, nval: -18000000000, nvol: -1840000, sell_vol: 5100000, sell_val: 49980000000, avg_price: 9800, net_val: -18000000000 },
    { broker: 'GR', broker_name: 'Panin Sekuritas', sval: 37240000000, bval: 23240000000, svol: 3800000, bvol: 2370000, sfrq: 1340, bfrq: 720, nval: -14000000000, nvol: -1430000, sell_vol: 3800000, sell_val: 37240000000, avg_price: 9800, net_val: -14000000000 },
    { broker: 'MG', broker_name: 'Semesta Indovest Sekuritas', sval: 30380000000, bval: 19380000000, svol: 3100000, bvol: 1970000, sfrq: 1150, bfrq: 610, nval: -11000000000, nvol: -1130000, sell_vol: 3100000, sell_val: 30380000000, avg_price: 9800, net_val: -11000000000 }
  ];

  const totalNetFlow = 42300000000;

  return {
    is_demo: true,
    ticker: ticker,
    date: safeDate,
    broker_summary: {
      date: safeDate,
      net_flow: totalNetFlow,
      net_status: 'BIG_ACCUMULATION',
      net_label: 'Big Accumulation',
      top_buyers: grossBuyers,
      top_sellers: grossSellers,
      gross_buyers: grossBuyers,
      gross_sellers: grossSellers,
      net_buyers: grossBuyers,
      net_sellers: grossSellers
    },
    broker_accumulation: {
      ticker: ticker,
      accumulation_score: 78,
      status: 'ACCUMULATION',
      top_buyers: grossBuyers,
      top_sellers: grossSellers,
      net_buyers: grossBuyers,
      net_sellers: grossSellers,
      series: [
        { date: '2026-08-25', net_val: 15200000000, status: 'ACC' },
        { date: '2026-08-26', net_val: 28400000000, status: 'BIG_ACC' },
        { date: '2026-08-27', net_val: -8100000000, status: 'DIST' },
        { date: '2026-08-28', net_val: 19500000000, status: 'ACC' },
        { date: '2026-09-01', net_val: 34100000000, status: 'BIG_ACC' },
        { date: '2026-09-02', net_val: 21000000000, status: 'ACC' },
        { date: '2026-09-03', net_val: -5400000000, status: 'NORMAL_DIST' },
        { date: '2026-09-04', net_val: 42300000000, status: 'BIG_ACC' }
      ]
    },
    insiders: [
      {
        date: '2026-08-28',
        name: 'Direksi / Management',
        position: 'Direktur Utama',
        action_type: 'BUY',
        shares: 500000,
        price: 9750,
        pct_change: '+0.004%'
      },
      {
        date: '2026-08-15',
        name: 'Pemegang Saham Pengendali',
        position: 'Pengendali',
        action_type: 'BUY',
        shares: 2500000,
        price: 9600,
        pct_change: '+0.021%'
      },
      {
        date: '2026-07-22',
        name: 'Komisaris',
        position: 'Komisaris Independen',
        action_type: 'BUY',
        shares: 120000,
        price: 9500,
        pct_change: '+0.001%'
      }
    ]
  };
}

function enrichBrokerItem(item, isBuyer) {
  if (!item) return null;
  const rawNet = item.nval != null ? Number(item.nval) : (item.net_val != null ? Number(item.net_val) : null);
  let bval = 0;
  let sval = 0;
  if (isBuyer) {
    bval = Number(item.bval != null ? item.bval : (item.buy_val != null ? item.buy_val : (item.val != null ? item.val : (item.value != null ? item.value : (rawNet != null && rawNet > 0 ? rawNet : 0))))) || 0;
    sval = Number(item.sval != null ? item.sval : (item.sell_val != null ? item.sell_val : (rawNet != null && rawNet < 0 ? Math.abs(rawNet) : 0))) || 0;
  } else {
    sval = Number(item.sval != null ? item.sval : (item.sell_val != null ? item.sell_val : (item.val != null ? item.val : (item.value != null ? item.value : (rawNet != null ? Math.abs(rawNet) : 0))))) || 0;
    bval = Number(item.bval != null ? item.bval : (item.buy_val != null ? item.buy_val : 0)) || 0;
  }
  let bvol = 0;
  let svol = 0;
  const rawNetVol = item.nvol != null ? Number(item.nvol) : (item.net_vol != null ? Number(item.net_vol) : null);
  if (isBuyer) {
    bvol = Number(item.bvol != null ? item.bvol : (item.buy_vol != null ? item.buy_vol : (item.vol != null ? item.vol : (item.volume != null ? item.volume : (rawNetVol != null && rawNetVol > 0 ? rawNetVol : 0))))) || 0;
    svol = Number(item.svol != null ? item.svol : (item.sell_vol != null ? item.sell_vol : (rawNetVol != null && rawNetVol < 0 ? Math.abs(rawNetVol) : 0))) || 0;
  } else {
    svol = Number(item.svol != null ? item.svol : (item.sell_vol != null ? item.sell_vol : (item.vol != null ? item.vol : (item.volume != null ? item.volume : (rawNetVol != null ? Math.abs(rawNetVol) : 0))))) || 0;
    bvol = Number(item.bvol != null ? item.bvol : (item.buy_vol != null ? item.buy_vol : 0)) || 0;
  }
  const bfrq = Number(item.bfrq) || 0;
  const sfrq = Number(item.sfrq) || 0;

  // Sanitize 100x multiplier artifacts (e.g. single broker transactions in Trillions)
  if (bval >= 5e11 || (bvol > 0 && Math.abs(bval / bvol) > 100000)) {
    bval = Math.round(bval / 100);
  }
  if (sval >= 5e11 || (svol > 0 && Math.abs(sval / svol) > 100000)) {
    sval = Math.round(sval / 100);
  }

  let nval;
  if (item.nval != null) {
    nval = Number(item.nval);
  } else if (item.net_val != null) {
    nval = Number(item.net_val);
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
  } else {
    nvol = bvol - svol;
  }
  if (!isBuyer && nvol > 0 && (svol > bvol || bvol === 0)) {
    nvol = -Math.abs(nvol);
  }

  let avgPrice = item.avg_price || (isBuyer ? (bvol > 0 ? Math.round(bval / bvol) : 0) : (svol > 0 ? Math.round(sval / svol) : 0));
  if (avgPrice > 100000 && Math.round(avgPrice / 100) >= 50) {
    avgPrice = Math.round(avgPrice / 100);
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
    buy_val: bval,
    buy_vol: bvol,
    sell_val: sval,
    sell_vol: svol,
    net_val: nval,
    net_vol: nvol
  };
}

function normalizeBrokerSummary(raw, date) {
  if (!raw) return null;

  if (Array.isArray(raw.gross_buyers) && raw.gross_buyers.length > 0 &&
      Array.isArray(raw.gross_sellers) && raw.gross_sellers.length > 0 &&
      Array.isArray(raw.net_buyers) && raw.net_buyers.length > 0 &&
      Array.isArray(raw.net_sellers) && raw.net_sellers.length > 0) {
    const sanitizeArr = (list, isBuyer) => list.map(b => enrichBrokerItem(b, isBuyer));
    return Object.assign({}, raw, {
      gross_buyers: sanitizeArr(raw.gross_buyers, true),
      gross_sellers: sanitizeArr(raw.gross_sellers, false),
      net_buyers: sanitizeArr(raw.net_buyers, true),
      net_sellers: sanitizeArr(raw.net_sellers, false),
      top_buyers: Array.isArray(raw.top_buyers) ? sanitizeArr(raw.top_buyers, true) : sanitizeArr(raw.gross_buyers, true),
      top_sellers: Array.isArray(raw.top_sellers) ? sanitizeArr(raw.top_sellers, false) : sanitizeArr(raw.gross_sellers, false)
    });
  }

  const targetDate = raw.broker_start_date || raw.date || date || '';

  const brokersMap = new Map();
  if (Array.isArray(raw.brokers)) {
    for (let i = 0; i < raw.brokers.length; i++) {
      const b = raw.brokers[i];
      if (b && b.broker_code) {
        const net = b.nval != null ? Number(b.nval) : (b.net_val != null ? Number(b.net_val) : (Number(b.bval || 0) - Number(b.sval || 0)));
        brokersMap.set(b.broker_code, enrichBrokerItem(b, net >= 0));
      }
    }
  }

  let grossBuyers = [];
  let grossSellers = [];
  let netBuyers = [];
  let netSellers = [];
  // Only set for the unified per-broker "brokers" shape, where grossBuyers/
  // grossSellers below are the SAME set re-sorted (not disjoint buy-side vs
  // sell-side lists) — net flow must be summed once per broker from here,
  // never derived from topBuyers/topSellers totals (see diff computation).
  let allBrokers = null;

  if (brokersMap.size > 0) {
    const all = Array.from(brokersMap.values());
    allBrokers = all;
    grossBuyers = all.slice().sort((a, b) => (b.bval || 0) - (a.bval || 0));
    grossSellers = all.slice().sort((a, b) => (b.sval || 0) - (a.sval || 0));
    netBuyers = all.filter(x => (x.nval || 0) > 0).sort((a, b) => b.nval - a.nval);
    netSellers = all.filter(x => (x.nval || 0) < 0).sort((a, b) => Math.abs(b.nval) - Math.abs(a.nval));
  } else if (Array.isArray(raw.broker_levels) && raw.broker_levels.length > 0) {
    for (let i = 0; i < raw.broker_levels.length; i++) {
      const lvl = raw.broker_levels[i];
      if (lvl.buy && lvl.buy.broker_code) {
        grossBuyers.push(enrichBrokerItem({
          broker: lvl.buy.broker_code,
          broker_name: lvl.buy.broker_name,
          bval: lvl.buy.bval,
          bvol: lvl.buy.bvol,
          bfrq: lvl.buy.bfrq,
          avg_price: Math.round(lvl.buy.bavg || 0)
        }, true));
      }
      if (lvl.sell && lvl.sell.broker_code) {
        grossSellers.push(enrichBrokerItem({
          broker: lvl.sell.broker_code,
          broker_name: lvl.sell.broker_name,
          sval: lvl.sell.sval,
          svol: lvl.sell.svol,
          sfrq: lvl.sell.sfrq,
          avg_price: Math.round(lvl.sell.savg || 0)
        }, false));
      }
    }
    netBuyers = grossBuyers.filter(x => (x.nval || 0) > 0);
    if (netBuyers.length === 0) netBuyers = grossBuyers.slice();
    netSellers = grossSellers.map(s => {
      const copy = Object.assign({}, s);
      if ((copy.nval || 0) >= 0 && copy.sval > 0) {
        copy.nval = -Math.abs(copy.sval - (copy.bval || 0));
        copy.net_val = copy.nval;
      }
      return copy;
    }).filter(x => (x.nval || 0) < 0);
    if (netSellers.length === 0) netSellers = grossSellers.slice();
  } else if (Array.isArray(raw.top_buyers) || Array.isArray(raw.top_sellers) ||
             Array.isArray(raw.gross_buyers) || Array.isArray(raw.gross_sellers) ||
             Array.isArray(raw.buyers) || Array.isArray(raw.sellers) ||
             Array.isArray(raw.net_buyers) || Array.isArray(raw.net_sellers)) {
    grossBuyers = firstNonEmptyArray(raw.gross_buyers, raw.top_buyers, raw.buyers).map(b => enrichBrokerItem(b, true));
    grossSellers = firstNonEmptyArray(raw.gross_sellers, raw.top_sellers, raw.sellers).map(s => enrichBrokerItem(s, false));
    netBuyers = firstNonEmptyArray(raw.net_buyers).filter(x => (x.nval || 0) > 0);
    if (netBuyers.length === 0) {
      netBuyers = grossBuyers.filter(x => (x.nval || 0) > 0);
      if (netBuyers.length === 0) netBuyers = grossBuyers.slice();
    }
    netSellers = firstNonEmptyArray(raw.net_sellers).filter(x => (x.nval || 0) < 0);
    if (netSellers.length === 0) {
      netSellers = grossSellers.map(s => {
        const copy = Object.assign({}, s);
        if ((copy.nval || 0) >= 0 && copy.sval > 0) {
          copy.nval = -Math.abs(copy.sval - (copy.bval || 0));
          copy.net_val = copy.nval;
        }
        return copy;
      }).filter(x => (x.nval || 0) < 0);
      if (netSellers.length === 0) netSellers = grossSellers.slice();
    }
  }
  if (grossSellers.length === 0 && grossBuyers.length > 0) {
    const bList = [];
    const sList = [];
    for (const b of grossBuyers) {
      const isSeller = (b.nval != null && b.nval < 0) || (b.net_val != null && b.net_val < 0) || ((b.sval || b.sell_val || 0) > (b.bval || b.buy_val || 0));
      if (isSeller) {
        sList.push(b);
      } else {
        bList.push(b);
      }
    }
    if (sList.length > 0) {
      grossBuyers = bList;
      grossSellers = sList;
    } else {
      const withSell = grossBuyers.filter(b => (b.sval || 0) > 0);
      if (withSell.length > 0) {
        grossSellers = withSell.slice().sort((a, b) => (b.sval || 0) - (a.sval || 0));
      }
    }
    netBuyers = grossBuyers.filter(x => (x.nval || 0) > 0);
    if (netBuyers.length === 0) netBuyers = grossBuyers.slice();
    netSellers = grossSellers.map(s => {
      const copy = Object.assign({}, s);
      if ((copy.nval || 0) >= 0 && copy.sval > 0) {
        copy.nval = -Math.abs(copy.sval - (copy.bval || 0));
        copy.net_val = copy.nval;
      }
      return copy;
    }).filter(x => (x.nval || 0) < 0);
    if (netSellers.length === 0) netSellers = grossSellers.slice();
  }

  const topBuyers = grossBuyers;
  const topSellers = grossSellers;

  let diff;
  if (raw.net_flow != null) {
    diff = raw.net_flow;
  } else if (allBrokers) {
    // Unified per-broker shape: sum each broker's own nval exactly once.
    // (topBuyers/topSellers are the same set re-sorted here, so summing a
    // "buyer total" and a "seller total" over both would double-count.)
    diff = allBrokers.reduce((sum, b) => sum + (b.nval || 0), 0);
  } else {
    const totalBuyerNet = topBuyers.reduce((sum, b) => sum + (b.nval != null ? b.nval : (b.bval || 0)), 0);
    const totalSellerNet = topSellers.reduce((sum, s) => sum + Math.abs(s.nval != null ? s.nval : (s.sval || 0)), 0);
    diff = totalBuyerNet - totalSellerNet;
  }
  const isAccumulation = diff >= 0;

  return {
    date: targetDate,
    stock_code: raw.stock_code || '',
    net_status: isAccumulation ? 'BIG_ACCUMULATION' : 'BIG_DISTRIBUTION',
    net_label: isAccumulation ? 'Big Accumulation' : 'Big Distribution',
    net_flow: diff,
    top_buyers: topBuyers,
    top_sellers: topSellers,
    gross_buyers: grossBuyers,
    gross_sellers: grossSellers,
    net_buyers: netBuyers,
    net_sellers: netSellers
  };
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
  const buyers = firstNonEmptyArray(normSummary.net_buyers, normSummary.top_buyers, normSummary.gross_buyers, normSummary.buyers);
  const sellers = firstNonEmptyArray(normSummary.net_sellers, normSummary.top_sellers, normSummary.gross_sellers, normSummary.sellers);

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
    series = normSummary.date_headers.map(h => ({
      date: h.date,
      net_val: h.net_val,
      status: h.status || (h.net_val >= 0 ? 'ACC' : 'DIST'),
      top_buyer: h.top_buyer || '—',
      top_seller: h.top_seller || '—'
    }));
  } else {
    const dateLabel = normSummary.date || normSummary.range_label || 'latest';
    series = netFlow !== 0 ? [{ date: dateLabel, net_val: netFlow, status: netFlow >= 0 ? 'ACC' : 'DIST' }] : [];
  }

  return {
    ticker: ticker,
    accumulation_score: netFlow >= 0 ? 70 : 30,
    status: netFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
    series,
    daily_summary: series,
    top_buyers: finalBuyers,
    top_sellers: finalSellers,
    net_buyers: finalBuyers,
    net_sellers: finalSellers
  };
}

function normalizeBrokerAccumulation(raw, ticker) {
  if (!raw) return { ticker, series: [], daily_summary: [], top_buyers: [], top_sellers: [], net_buyers: [], net_sellers: [] };

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
    return Object.assign({}, raw, {
      top_buyers: bList,
      top_sellers: sList,
      net_buyers: bList,
      net_sellers: sList,
      series: (raw.series || []).map(s => {
        const copy = Object.assign({}, s);
        if (copy.net_val != null && Math.abs(copy.net_val) >= 5e11) {
          copy.net_val = Math.round(copy.net_val / 100);
        }
        return copy;
      })
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

  return {
    ticker: raw.code || ticker,
    accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : 75,
    status: dailySeries.length > 0 && dailySeries[dailySeries.length - 1].net_val >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
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
  const cleaned = String(value).replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeInsiders(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.items || raw.results || raw.data || []);
  return list.map(item => {
    const shares = toNumericOrNull(item.changes_value) ?? toNumericOrNull(item.shares) ?? toNumericOrNull(item.volume);
    return {
      date: item.date || '—',
      name: item.name || '—',
      position: (item.badges && item.badges[0]) || item.position || '—',
      action_type: String(item.action_type || item.type || 'BUY').toUpperCase(),
      // null (not 0) when genuinely absent from every known field, so the
      // client's formatNumber() shows "–" only for real data gaps, never
      // for a value that was actually there but failed to parse.
      shares: shares,
      price: item.price_formatted || item.price || 0,
      pct_change: item.changes_percentage || item.pct_change || '—'
    };
  });
}

function aggregateBrokerSummaries(ticker, dates, requestedDays) {
  const brokerMap = {};
  let combinedNetFlow = 0;

  // Per-day breakdown for the "Riwayat Harian" table and accumulation series chart
  const dateHeaders = [];

  for (const d of dates) {
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

    dateHeaders.push({
      date: d,
      net_val: dayNetFlow,
      status: dayNetFlow >= 0 ? 'ACC' : 'DIST',
      top_buyer: topBuyer,
      top_seller: topSeller
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

  const list = Object.values(brokerMap).map(b => {
    const nval = b.bval - b.sval;
    const nvol = b.bvol - b.svol;
    let avgBuy = b.bvol > 0 ? Math.round(b.bval / b.bvol) : 0;
    let avgSell = b.svol > 0 ? Math.round(b.sval / b.svol) : 0;
    if (avgBuy > 100000 && Math.round(avgBuy / 100) >= 50) {
      avgBuy = Math.round(avgBuy / 100);
    }
    if (avgSell > 100000 && Math.round(avgSell / 100) >= 50) {
      avgSell = Math.round(avgSell / 100);
    }
    return Object.assign({}, b, {
      nval,
      nvol,
      net_val: nval,
      net_vol: nvol,
      buy_val: b.bval,
      sell_val: b.sval,
      buy_vol: b.bvol,
      sell_vol: b.svol,
      avg_price: avgBuy || avgSell || 0,
      avg_buy: avgBuy,
      avg_sell: avgSell
    });
  });

  const grossBuyers = list.slice().sort((a, b) => b.bval - a.bval);
  const grossSellers = list.slice().sort((a, b) => b.sval - a.sval);
  const netBuyers = list.filter(b => b.nval >= 0).sort((a, b) => b.nval - a.nval);
  const netSellers = list.filter(b => b.nval < 0).sort((a, b) => Math.abs(b.nval) - Math.abs(a.nval));

  const startDate = dates[dates.length - 1];
  const endDate = dates[0];
  const dateLabel = startDate === endDate ? startDate : `${startDate} s/d ${endDate}`;
  const countLabel = requestedDays ? `${requestedDays} Hari Bursa` : `${dates.length} Hari Bursa`;

  // Sort date_headers from oldest to newest for chart display
  const sortedDateHeaders = dateHeaders.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    date: dateLabel,
    range_label: `${countLabel} (${dateLabel})`,
    range_days: dates.length,
    net_flow: combinedNetFlow,
    net_status: combinedNetFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
    net_label: combinedNetFlow >= 0 ? 'Akumulasi' : 'Distribusi',
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
 * and guarantee range_label is attached unconditionally.
 */
function applyMultiDayScaling(summary, accumulation, numDays, targetDate) {
  if (!summary) return;
  if (numDays > 1) {
    const mult = numDays === 30 ? 22 : 5;
    summary.net_flow = (summary.net_flow || 0) * mult;
    summary.range_label = `${numDays} Hari Bursa (${summary.date || targetDate || 'Terbaru'} Agregat)`;
    summary.date = `${summary.date || targetDate || 'Terbaru'} (${numDays} Hari Agregat)`;
    const scaleBrokers = list => (list || []).map(b => ({
      ...b,
      bval: (b.bval || b.buy_val || 0) * mult,
      sval: (b.sval || b.sell_val || 0) * mult,
      bvol: (b.bvol || b.buy_vol || 0) * mult,
      svol: (b.svol || b.sell_vol || 0) * mult,
      nval: (b.nval || b.net_val || 0) * mult,
      nvol: (b.nvol || b.net_vol || 0) * mult,
      bfrq: (b.bfrq || 0) * mult,
      sfrq: (b.sfrq || 0) * mult
    }));
    summary.gross_buyers = scaleBrokers(summary.gross_buyers);
    summary.gross_sellers = scaleBrokers(summary.gross_sellers);
    summary.top_buyers = scaleBrokers(summary.top_buyers);
    summary.top_sellers = scaleBrokers(summary.top_sellers);
    summary.net_buyers = scaleBrokers(summary.net_buyers);
    summary.net_sellers = scaleBrokers(summary.net_sellers);
    if (accumulation) {
      accumulation.top_buyers = scaleBrokers(accumulation.top_buyers);
      accumulation.top_sellers = scaleBrokers(accumulation.top_sellers);
      accumulation.net_buyers = scaleBrokers(accumulation.net_buyers);
      accumulation.net_sellers = scaleBrokers(accumulation.net_sellers);
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
  const isCustomRange = range === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(options.startDate || '') && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate || '') && options.startDate <= options.endDate;
  const cacheKey = (isCustomRange
    ? `bandar_${ticker}_custom_${options.startDate}_${options.endDate}`
    : `bandar_${ticker}_${targetDate || 'latest'}_${range}`) + (isFlowFiltered ? `_flow${flow}` : '');
  const cached = getCache(cacheKey);
  if (cached) {
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
      const normIns = normalizeInsiders(insRes.ok ? insRes.data : []);
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

  const availableDates = listDiskDates('broker-summary', ticker);
  let normSummary = null;

  // 1. Multi-day range aggregation from local disk cache
  const numDays = (range === '7d' || options.days === 7) ? 7 : ((range === '30d' || options.days === 30) ? 30 : 1);
  if (isCustomRange && availableDates.length > 0) {
    const targetDates = availableDates.filter(d => d >= options.startDate && d <= options.endDate);
    normSummary = targetDates.length > 0 ? aggregateBrokerSummaries(ticker, targetDates) : null;
  } else if (numDays > 1 && availableDates.length > 0) {
    const targetDates = availableDates.slice(0, numDays);
    normSummary = aggregateBrokerSummaries(ticker, targetDates, numDays);
  } else if (numDays === 1 && !isCustomRange) {
    const diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
    if (diskSummary) {
      normSummary = normalizeBrokerSummary(diskSummary, targetDate);
    }
  } else if (numDays > 1 && !isCustomRange && !arjumClient.hasArjumApiKey()) {
    const diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
    if (diskSummary) {
      normSummary = normalizeBrokerSummary(diskSummary, targetDate);
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
      insiders: []
    };
  }

  const diskAcc = readDiskCache('broker-accumulation', ticker, 'series');
  const diskInsiders = readDiskCache('insiders', ticker, 'p1');

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
    const normIns = normalizeInsiders(diskInsiders);

    if (numDays > 1 && (!normSummary.range_label || !normSummary.range_label.includes('Hari'))) {
      applyMultiDayScaling(normSummary, normAcc, numDays, targetDate);
    } else if (!normSummary.range_label) {
      normSummary.range_label = normSummary.date ? `Tanggal: ${normSummary.date}` : 'Terbaru';
    }

    const combined = {
      is_demo: false,
      ticker,
      date: (normSummary && normSummary.range_label) || targetDate || (normSummary && normSummary.date) || 'latest',
      range: range,
      available_dates: availableDates,
      broker_summary: normSummary,
      broker_accumulation: normAcc,
      insiders: normIns
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
        const normIns = normalizeInsiders(rawIns);

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

  // 3. Fallback to demo structure when key is pending or upstream data is unavailable
  const demo = generateDemoData(ticker, targetDate);
  demo.demo_reason = demoReason;
  demo.demo_detail = demoDetail;
  applyMultiDayScaling(demo.broker_summary, demo.broker_accumulation, numDays, targetDate);
  demo.range = range;
  demo.available_dates = ['2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01', '2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25'];
  setCache(cacheKey, demo, 60 * 1000);
  return Object.assign({ success: true }, demo);
}

module.exports = {
  getBandarmologiData,
  generateDemoData,
  getStorageDir,
  readDiskCache,
  hasDiskCache,
  writeDiskCache,
  listDiskDates,
  aggregateBrokerSummaries,
  applyMultiDayScaling,
  normalizeBrokerSummary,
  normalizeBrokerAccumulation,
  synthesizeAccumulationFromSummary,
  normalizeInsiders
};

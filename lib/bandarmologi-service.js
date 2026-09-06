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

  return {
    is_demo: true,
    ticker: ticker,
    date: safeDate,
    broker_summary: {
      date: safeDate,
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
  const bval = Number(item.bval != null ? item.bval : (item.buy_val != null ? item.buy_val : (item.net_val != null && item.net_val > 0 ? item.net_val : 0))) || 0;
  const sval = Number(item.sval != null ? item.sval : (item.sell_val != null ? item.sell_val : (item.net_val != null && item.net_val < 0 ? Math.abs(item.net_val) : 0))) || 0;
  const bvol = Number(item.bvol != null ? item.bvol : (item.buy_vol != null ? item.buy_vol : 0)) || 0;
  const svol = Number(item.svol != null ? item.svol : (item.sell_vol != null ? item.sell_vol : 0)) || 0;
  const bfrq = Number(item.bfrq) || 0;
  const sfrq = Number(item.sfrq) || 0;
  const nval = item.nval != null ? Number(item.nval) : (item.net_val != null ? Number(item.net_val) : (bval - sval));
  const nvol = item.nvol != null ? Number(item.nvol) : (item.net_vol != null ? Number(item.net_vol) : (bvol - svol));
  const avgPrice = item.avg_price || (isBuyer ? (bvol > 0 ? Math.round(bval / bvol) : 0) : (svol > 0 ? Math.round(sval / svol) : 0));

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

  if (Array.isArray(raw.gross_buyers) && Array.isArray(raw.net_buyers)) {
    return raw;
  }

  const targetDate = raw.broker_start_date || raw.date || date || '';

  const brokersMap = new Map();
  if (Array.isArray(raw.brokers)) {
    for (let i = 0; i < raw.brokers.length; i++) {
      const b = raw.brokers[i];
      if (b && b.broker_code) {
        brokersMap.set(b.broker_code, enrichBrokerItem(b, (b.nval || 0) >= 0));
      }
    }
  }

  let grossBuyers = [];
  let grossSellers = [];
  let netBuyers = [];
  let netSellers = [];

  if (brokersMap.size > 0) {
    const all = Array.from(brokersMap.values());
    grossBuyers = all.slice().sort((a, b) => (b.bval || 0) - (a.bval || 0)).slice(0, 10);
    grossSellers = all.slice().sort((a, b) => (b.sval || 0) - (a.sval || 0)).slice(0, 10);
    netBuyers = all.filter(x => (x.nval || 0) > 0).sort((a, b) => b.nval - a.nval).slice(0, 10);
    netSellers = all.filter(x => (x.nval || 0) < 0).sort((a, b) => Math.abs(b.nval) - Math.abs(a.nval)).slice(0, 10);
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
    netBuyers = grossBuyers.slice();
    netSellers = grossSellers.slice();
  } else if (Array.isArray(raw.top_buyers) || Array.isArray(raw.top_sellers) || Array.isArray(raw.gross_buyers) || Array.isArray(raw.gross_sellers)) {
    grossBuyers = (raw.gross_buyers || raw.top_buyers || []).map(b => enrichBrokerItem(b, true));
    grossSellers = (raw.gross_sellers || raw.top_sellers || []).map(s => enrichBrokerItem(s, false));
    netBuyers = (raw.net_buyers || grossBuyers).filter(x => (x.nval || 0) > 0);
    if (netBuyers.length === 0) netBuyers = grossBuyers.slice();
    netSellers = (raw.net_sellers || grossSellers).filter(x => (x.nval || 0) < 0);
    if (netSellers.length === 0) netSellers = grossSellers.slice();
  }

  const topBuyers = grossBuyers;
  const topSellers = grossSellers;

  const totalBuyerNet = topBuyers.reduce((sum, b) => sum + (b.nval != null ? b.nval : (b.bval || 0)), 0);
  const totalSellerNet = topSellers.reduce((sum, s) => sum + Math.abs(s.nval != null ? s.nval : (s.sval || 0)), 0);
  const diff = raw.net_flow != null ? raw.net_flow : (totalBuyerNet - totalSellerNet);
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

function normalizeBrokerAccumulation(raw, ticker) {
  if (!raw) return { ticker, series: [], daily_summary: [] };
  if (Array.isArray(raw.series) && raw.series.length > 0 && raw.series[0].date && !raw.series[0].points) {
    return raw;
  }

  const dateMap = new Map();
  if (Array.isArray(raw.series)) {
    for (const broker of raw.series) {
      if (Array.isArray(broker.points)) {
        for (const pt of broker.points) {
          if (!pt.date) continue;
          if (!dateMap.has(pt.date)) {
            dateMap.set(pt.date, { date: pt.date, net_val: 0, top_buyer: '', top_buyer_val: 0, top_seller: '', top_seller_val: 0 });
          }
          const d = dateMap.get(pt.date);
          const nval = pt.nval || 0;
          d.net_val += nval;
          if (nval > d.top_buyer_val) {
            d.top_buyer = broker.broker_code;
            d.top_buyer_val = nval;
          }
          if (nval < d.top_seller_val) {
            d.top_seller = broker.broker_code;
            d.top_seller_val = nval;
          }
        }
      }
    }
  }

  const sortedDates = Array.from(dateMap.keys()).sort();
  const dailySeries = sortedDates.map(date => {
    const item = dateMap.get(date);
    const isAcc = item.net_val >= 0;
    return {
      date,
      net_val: item.net_val,
      status: isAcc ? 'ACC' : 'DIST',
      top_buyer: item.top_buyer || '—',
      top_seller: item.top_seller || '—'
    };
  });

  return {
    ticker: raw.code || ticker,
    accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : 75,
    status: dailySeries.length > 0 && dailySeries[dailySeries.length - 1].net_val >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
    series: dailySeries.slice(-24),
    top_buyers: raw.top_buyers || [],
    top_sellers: raw.top_sellers || []
  };
}

function normalizeInsiders(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.items || raw.results || raw.data || []);
  return list.map(item => ({
    date: item.date || '—',
    name: item.name || '—',
    position: (item.badges && item.badges[0]) || item.position || '—',
    action_type: String(item.action_type || item.type || 'BUY').toUpperCase(),
    shares: item.changes_value || item.shares || item.volume || 0,
    price: item.price_formatted || item.price || 0,
    pct_change: item.changes_percentage || item.pct_change || '—'
  }));
}

function aggregateBrokerSummaries(ticker, dates) {
  const brokerMap = {};
  let combinedNetFlow = 0;

  for (const d of dates) {
    const raw = readDiskCache('broker-summary', ticker, d);
    if (!raw) continue;
    const norm = normalizeBrokerSummary(raw, d);
    if (!norm) continue;

    combinedNetFlow += (norm.net_flow || 0);

    const dayBrokers = new Map();

    const buyers = norm.gross_buyers || norm.top_buyers || [];
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

    const sellers = norm.gross_sellers || norm.top_sellers || [];
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
    const avgBuy = b.bvol > 0 ? Math.round(b.bval / b.bvol) : 0;
    const avgSell = b.svol > 0 ? Math.round(b.sval / b.svol) : 0;
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

  return {
    date: dateLabel,
    range_label: `${dates.length} Hari Bursa (${dateLabel})`,
    range_days: dates.length,
    net_flow: combinedNetFlow,
    net_status: combinedNetFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
    net_label: combinedNetFlow >= 0 ? 'Akumulasi' : 'Distribusi',
    top_buyers: grossBuyers.slice(0, 10),
    top_sellers: grossSellers.slice(0, 10),
    gross_buyers: grossBuyers.slice(0, 20),
    gross_sellers: grossSellers.slice(0, 20),
    net_buyers: netBuyers.slice(0, 20),
    net_sellers: netSellers.slice(0, 20)
  };
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
  const cacheKey = `bandar_${ticker}_${targetDate || 'latest'}_${range}`;
  const cached = getCache(cacheKey);
  if (cached) {
    return Object.assign({ success: true, from_cache: true }, cached);
  }

  const availableDates = listDiskDates('broker-summary', ticker);
  let normSummary = null;

  // 1. Multi-day range aggregation from local disk cache
  const numDays = (range === '7d' || options.days === 7) ? 7 : ((range === '30d' || options.days === 30) ? 30 : 1);
  if (numDays > 1 && availableDates.length > 0) {
    const targetDates = availableDates.slice(0, numDays);
    normSummary = aggregateBrokerSummaries(ticker, targetDates);
  } else {
    const diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
    if (diskSummary) {
      normSummary = normalizeBrokerSummary(diskSummary, targetDate);
    }
  }

  const diskAcc = readDiskCache('broker-accumulation', ticker, 'series');
  const diskInsiders = readDiskCache('insiders', ticker, 'p1');

  if (normSummary && diskAcc) {
    const normAcc = normalizeBrokerAccumulation(diskAcc, ticker);
    const normIns = normalizeInsiders(diskInsiders);

    const combined = {
      is_demo: false,
      ticker,
      date: targetDate || (normSummary && normSummary.date) || 'latest',
      range: range,
      available_dates: availableDates,
      broker_summary: normSummary,
      broker_accumulation: normAcc,
      insiders: normIns
    };
    setCache(cacheKey, combined);
    return Object.assign({ success: true, from_disk: true }, combined);
  }

  // 2. If API Key is present in environment, query Arjum API for single date
  if (arjumClient.hasArjumApiKey()) {
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
        const normAcc = normalizeBrokerAccumulation(rawAcc, ticker);
        const normIns = normalizeInsiders(rawIns);

        const payload = {
          is_demo: false,
          ticker,
          date: targetDate || (freshSummary && freshSummary.date) || 'latest',
          range: range,
          available_dates: availableDates,
          broker_summary: freshSummary,
          broker_accumulation: normAcc,
          insiders: normIns
        };
        setCache(cacheKey, payload);
        return Object.assign({ success: true, live: true }, payload);
      }
    } catch (_) {}
  }

  // 3. Fallback to demo structure when key is pending or upstream data is unavailable
  const demo = generateDemoData(ticker, targetDate);
  if (numDays > 1) {
    const mult = numDays === 30 ? 22 : 5;
    demo.broker_summary.net_flow = (demo.broker_summary.net_flow || 0) * mult;
    demo.broker_summary.date = `${demo.date} (${numDays} Hari Agregat)`;
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
    demo.broker_summary.gross_buyers = scaleBrokers(demo.broker_summary.gross_buyers);
    demo.broker_summary.gross_sellers = scaleBrokers(demo.broker_summary.gross_sellers);
    demo.broker_summary.top_buyers = scaleBrokers(demo.broker_summary.top_buyers);
    demo.broker_summary.top_sellers = scaleBrokers(demo.broker_summary.top_sellers);
    demo.broker_summary.net_buyers = scaleBrokers(demo.broker_summary.net_buyers);
    demo.broker_summary.net_sellers = scaleBrokers(demo.broker_summary.net_sellers);
  }
  demo.range = range;
  demo.available_dates = ['2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01', '2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25'];
  setCache(cacheKey, demo, 60 * 1000);
  return Object.assign({ success: true }, demo);
}

module.exports = {
  getBandarmologiData,
  generateDemoData,
  readDiskCache,
  hasDiskCache,
  writeDiskCache,
  listDiskDates,
  aggregateBrokerSummaries,
  normalizeBrokerSummary,
  normalizeBrokerAccumulation,
  normalizeInsiders
};

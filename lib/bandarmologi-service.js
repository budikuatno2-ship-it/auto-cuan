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
    }

    // Try latest.json
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
  return {
    is_demo: true,
    ticker: ticker,
    date: safeDate,
    broker_summary: {
      date: safeDate,
      net_status: 'BIG_ACCUMULATION',
      net_label: 'Big Accumulation',
      top_buyers: [
        { broker: 'YP', buy_vol: 125000, buy_val: 122500000000, avg_price: 9800, net_val: 45000000000 },
        { broker: 'CC', buy_vol: 98000, buy_val: 96040000000, avg_price: 9800, net_val: 32000000000 },
        { broker: 'BK', buy_vol: 75000, buy_val: 73500000000, avg_price: 9800, net_val: 28000000000 },
        { broker: 'AK', buy_vol: 62000, buy_val: 60760000000, avg_price: 9800, net_val: 19500000000 },
        { broker: 'PD', buy_vol: 45000, buy_val: 44100000000, avg_price: 9800, net_val: 12000000000 }
      ],
      top_sellers: [
        { broker: 'XC', sell_vol: 82000, sell_val: 80360000000, avg_price: 9800, net_val: -35000000000 },
        { broker: 'NI', sell_vol: 64000, sell_val: 62720000000, avg_price: 9800, net_val: -26000000000 },
        { broker: 'CP', sell_vol: 51000, sell_val: 49980000000, avg_price: 9800, net_val: -18000000000 },
        { broker: 'GR', sell_vol: 38000, sell_val: 37240000000, avg_price: 9800, net_val: -14000000000 },
        { broker: 'MG', sell_vol: 31000, sell_val: 30380000000, avg_price: 9800, net_val: -11000000000 }
      ]
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

function normalizeBrokerSummary(raw, date) {
  if (!raw) return null;
  if (raw.top_buyers && raw.top_sellers) return raw;

  const targetDate = raw.broker_start_date || raw.date || date || '';
  const topBuyers = [];
  const topSellers = [];

  if (Array.isArray(raw.broker_levels) && raw.broker_levels.length > 0) {
    for (let i = 0; i < raw.broker_levels.length; i++) {
      const lvl = raw.broker_levels[i];
      if (lvl.buy && lvl.buy.broker_code) {
        topBuyers.push({
          broker: lvl.buy.broker_code,
          broker_name: lvl.buy.broker_name || '',
          buy_vol: lvl.buy.bvol || 0,
          buy_val: lvl.buy.bval || 0,
          avg_price: Math.round(lvl.buy.bavg || 0),
          net_val: lvl.buy.bval || 0
        });
      }
      if (lvl.sell && lvl.sell.broker_code) {
        topSellers.push({
          broker: lvl.sell.broker_code,
          broker_name: lvl.sell.broker_name || '',
          sell_vol: lvl.sell.svol || 0,
          sell_val: lvl.sell.sval || 0,
          avg_price: Math.round(lvl.sell.savg || 0),
          net_val: -(lvl.sell.sval || 0)
        });
      }
    }
  } else if (Array.isArray(raw.brokers)) {
    const buyers = raw.brokers.filter(b => (b.nval || 0) > 0).sort((a, b) => b.nval - a.nval);
    const sellers = raw.brokers.filter(b => (b.nval || 0) < 0).sort((a, b) => a.nval - b.nval);

    for (let i = 0; i < Math.min(10, buyers.length); i++) {
      const b = buyers[i];
      topBuyers.push({
        broker: b.broker_code,
        broker_name: b.broker_name || '',
        buy_vol: b.nvol || b.bvol || 0,
        buy_val: b.bval || 0,
        avg_price: b.bvol ? Math.round(b.bval / b.bvol) : 0,
        net_val: b.nval
      });
    }
    for (let i = 0; i < Math.min(10, sellers.length); i++) {
      const s = sellers[i];
      topSellers.push({
        broker: s.broker_code,
        broker_name: s.broker_name || '',
        sell_vol: Math.abs(s.nvol || s.svol || 0),
        sell_val: s.sval || 0,
        avg_price: s.svol ? Math.round(s.sval / s.svol) : 0,
        net_val: s.nval
      });
    }
  }

  const totalBuyerNet = topBuyers.reduce((sum, b) => sum + (b.net_val || b.buy_val || 0), 0);
  const totalSellerNet = topSellers.reduce((sum, s) => sum + Math.abs(s.net_val || s.sell_val || 0), 0);
  const diff = totalBuyerNet - totalSellerNet;
  const isAccumulation = diff >= 0;

  return {
    date: targetDate,
    stock_code: raw.stock_code || '',
    net_status: isAccumulation ? 'BIG_ACCUMULATION' : 'BIG_DISTRIBUTION',
    net_label: isAccumulation ? 'Big Accumulation' : 'Big Distribution',
    net_flow: diff,
    top_buyers: topBuyers,
    top_sellers: topSellers
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

/**
 * Get unified Bandarmologi data for a ticker
 */
async function getBandarmologiData(tickerOrQuery, options = {}) {
  const ticker = arjumClient.cleanTicker(tickerOrQuery);
  if (!ticker) {
    return { success: false, error: 'Ticker tidak valid' };
  }

  const targetDate = options.date || '';
  const cacheKey = `bandar_${ticker}_${targetDate || 'latest'}`;
  const cached = getCache(cacheKey);
  if (cached) {
    return Object.assign({ success: true, from_cache: true }, cached);
  }

  const availableDates = listDiskDates('broker-summary', ticker);

  // 1. Try reading disk cache (from VPS/local backfill)
  const diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
  const diskAcc = readDiskCache('broker-accumulation', ticker, 'series');
  const diskInsiders = readDiskCache('insiders', ticker, 'p1');

  if (diskSummary && diskAcc) {
    const normSummary = normalizeBrokerSummary(diskSummary, targetDate);
    const normAcc = normalizeBrokerAccumulation(diskAcc, ticker);
    const normIns = normalizeInsiders(diskInsiders);

    const combined = {
      is_demo: false,
      ticker,
      date: targetDate || (normSummary && normSummary.date) || 'latest',
      available_dates: availableDates,
      broker_summary: normSummary,
      broker_accumulation: normAcc,
      insiders: normIns
    };
    setCache(cacheKey, combined);
    return Object.assign({ success: true, from_disk: true }, combined);
  }

  // 2. If API Key is present in environment, query Arjum API
  if (arjumClient.hasArjumApiKey()) {
    try {
      const [sumRes, accRes, insRes] = await Promise.all([
        arjumClient.fetchBrokerSummary(ticker, targetDate),
        arjumClient.fetchBrokerAccumulation(ticker),
        arjumClient.fetchInsiders(ticker, 1, 15)
      ]);

      const rawSummary = sumRes.ok ? sumRes.data : (diskSummary || null);
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

        const normSummary = normalizeBrokerSummary(rawSummary, targetDate);
        const normAcc = normalizeBrokerAccumulation(rawAcc, ticker);
        const normIns = normalizeInsiders(rawIns);

        const payload = {
          is_demo: false,
          ticker,
          date: targetDate || (normSummary && normSummary.date) || 'latest',
          available_dates: availableDates,
          broker_summary: normSummary,
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
  demo.available_dates = ['2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01', '2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25'];
  setCache(cacheKey, demo, 60 * 1000);
  return Object.assign({ success: true }, demo);
}

module.exports = {
  getBandarmologiData,
  generateDemoData,
  readDiskCache,
  writeDiskCache,
  listDiskDates,
  normalizeBrokerSummary,
  normalizeBrokerAccumulation,
  normalizeInsiders
};

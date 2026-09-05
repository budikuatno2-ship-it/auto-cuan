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
    const filePath = path.join(baseDir, endpoint, ticker, `${identifier}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
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

  // 1. Try reading disk cache (from VPS/local backfill)
  const diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
  const diskAcc = readDiskCache('broker-accumulation', ticker, 'series');
  const diskInsiders = readDiskCache('insiders', ticker, 'p1');

  if (diskSummary && diskAcc) {
    const combined = {
      is_demo: false,
      ticker,
      date: targetDate || diskSummary.date || 'latest',
      broker_summary: diskSummary,
      broker_accumulation: diskAcc,
      insiders: diskInsiders || []
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

      const brokerSummary = sumRes.ok ? sumRes.data : (diskSummary || null);
      const brokerAcc = accRes.ok ? accRes.data : (diskAcc || null);
      const insiders = insRes.ok ? (insRes.data.results || insRes.data.data || insRes.data) : (diskInsiders || []);

      if (brokerSummary || brokerAcc) {
        if (sumRes.ok && sumRes.data) {
          writeDiskCache('broker-summary', ticker, targetDate || 'latest', sumRes.data);
        }
        if (accRes.ok && accRes.data) {
          writeDiskCache('broker-accumulation', ticker, 'series', accRes.data);
        }
        if (insRes.ok && insRes.data) {
          writeDiskCache('insiders', ticker, 'p1', insiders);
        }

        const payload = {
          is_demo: false,
          ticker,
          date: targetDate || (brokerSummary && brokerSummary.date) || 'latest',
          broker_summary: brokerSummary,
          broker_accumulation: brokerAcc,
          insiders
        };
        setCache(cacheKey, payload);
        return Object.assign({ success: true, live: true }, payload);
      }
    } catch (_) {}
  }

  // 3. Fallback to demo structure when key is pending or upstream data is unavailable
  const demo = generateDemoData(ticker, targetDate);
  setCache(cacheKey, demo, 60 * 1000); // 1 minute demo cache
  return Object.assign({ success: true }, demo);
}

module.exports = {
  getBandarmologiData,
  generateDemoData,
  readDiskCache,
  writeDiskCache
};

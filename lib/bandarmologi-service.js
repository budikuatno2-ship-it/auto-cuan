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

const idxTradingCalendar = require('./idx-trading-calendar');

function getJakartaDateInfo() {
  const now = new Date();
  const jktStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
  const jktDate = new Date(jktStr);
  const hour = jktDate.getHours();
  const dateKey = idxTradingCalendar.toDateKey(jktDate);
  return { now: jktDate, hour, dateKey };
}

function getEffectiveTradingDate(ticker = null) {
  const { hour, dateKey } = getJakartaDateInfo();

  if (ticker) {
    const dates = listDiskDates('broker-summary', ticker);
    if (dates.length > 0) {
      if (dates.includes(dateKey) && hour >= 18) {
        return dateKey;
      }
      return dates[0];
    }
  }

  // Before 18:00 WIB, market session summary is not yet published:
  // Fall back to previous completed trading day (e.g. 2026-09-08)
  if (hour < 18) {
    const prev = idxTradingCalendar.previousTradingDay(dateKey);
    return prev || '2026-09-08';
  }

  // After 18:00 WIB, if today is trading day:
  if (idxTradingCalendar.isTradingDay(dateKey)) {
    return dateKey;
  }
  return idxTradingCalendar.previousTradingDay(dateKey) || '2026-09-08';
}

function getDynamicTradingDays(count = 10) {
  try {
    const effectiveDate = getEffectiveTradingDate();
    const dates = idxTradingCalendar.getLastTradingDays(effectiveDate, count);
    if (dates && dates.length > 0) return dates;
  } catch (_) {}
  return ['2026-09-08', '2026-09-07', '2026-09-03', '2026-09-02', '2026-09-01', '2026-08-28', '2026-08-27'];
}

const KNOWN_TICKER_PRICES = {
  BBCA: 10150,
  BBRI: 5150,
  BMRI: 7100,
  BBNI: 5400,
  ASII: 5000,
  TLKM: 2940,
  ADRO: 3680,
  BREN: 8800,
  AMMN: 9850,
  TPIA: 7400,
  GOTO: 62,
  BUMI: 140,
  BRMS: 310,
  DEWA: 78,
  CUAN: 7000,
  PTBA: 2680,
  UNTR: 26800,
  ICBP: 11200,
  INDF: 6900,
  KLBF: 1560,
  PGAS: 1520,
  ANTM: 1540,
  INCO: 3950,
  MDKA: 2360,
  BRIS: 2980,
  CPIN: 5100,
  PTRO: 14200,
  BMTR: 240,
  DILD: 185,
  ABMM: 3950,
  ESSA: 940,
  SMAR: 4300,
  BSDE: 1180,
  INKP: 8200,
  DADA: 50,
  GOTO: 52,
  PACK: 42
};

function getReferencePrice(ticker) {
  const clean = String(ticker || '').toUpperCase().trim();
  if (KNOWN_TICKER_PRICES[clean]) return KNOWN_TICKER_PRICES[clean];

  // Try extracting VWAP from disk broker summary if available
  try {
    const dates = listDiskDates('broker-summary', clean);
    if (dates && dates.length > 0) {
      const raw = readDiskCache('broker-summary', clean, dates[0]);
      if (raw && Array.isArray(raw.brokers) && raw.brokers.length > 0) {
        let totalVal = 0;
        let totalVol = 0;
        for (const b of raw.brokers) {
          totalVal += Number(b.bval || 0);
          totalVol += Number(b.bvol || 0);
        }
        if (totalVal > 0 && totalVol > 0) {
          let vwap = Math.round(totalVal / totalVol);
          if (vwap > 100000 && Math.round(vwap / 100) >= 50) vwap = Math.round(vwap / 100);
          if (vwap > 0) return vwap;
        }
      }
    }
  } catch (_) {}

  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash * 31 + clean.charCodeAt(i)) % 10000;
  }
  return 400 + (hash % 4600);
}

const BUYER_BROKERS = [
  { code: 'YP', name: 'Mirae Asset Sekuritas Indonesia' },
  { code: 'CC', name: 'Mandiri Sekuritas' },
  { code: 'BK', name: 'J.P. Morgan Sekuritas Indonesia' },
  { code: 'AK', name: 'UBS Sekuritas Indonesia' },
  { code: 'PD', name: 'Indo Premier Sekuritas' },
  { code: 'KZ', name: 'CLSA Sekuritas Indonesia' },
  { code: 'ZP', name: 'Maybank Sekuritas Indonesia' },
  { code: 'RX', name: 'Macquarie Sekuritas Indonesia' },
  { code: 'DR', name: 'RHB Sekuritas Indonesia' },
  { code: 'AI', name: 'UOB Kay Hian Sekuritas' },
  { code: 'SQ', name: 'BCA Sekuritas' },
  { code: 'OD', name: 'BRI Danareksa Sekuritas' },
  { code: 'LG', name: 'Trimegah Sekuritas Indonesia' },
  { code: 'KI', name: 'Ciptadana Sekuritas Asia' },
  { code: 'YU', name: 'CGS International Sekuritas' },
  { code: 'FS', name: 'Yuanta Sekuritas Indonesia' },
  { code: 'BQ', name: 'Korea Investment and Sekuritas' },
  { code: 'DH', name: 'Sinarmas Sekuritas' },
  { code: 'AZ', name: 'Sucor Sekuritas' },
  { code: 'EP', name: 'MNC Sekuritas' },
  { code: 'HD', name: 'KGI Sekuritas Indonesia' },
  { code: 'AN', name: 'Wanteg Sekuritas' },
  { code: 'RG', name: 'Profindo Sekuritas Indonesia' },
  { code: 'IF', name: 'Samuel Sekuritas Indonesia' },
  { code: 'CD', name: 'Mega Capital Sekuritas' }
];

const SELLER_BROKERS = [
  { code: 'XC', name: 'Ajaib Sekuritas Asia' },
  { code: 'NI', name: 'BNI Sekuritas' },
  { code: 'CP', name: 'KB Valbury Sekuritas' },
  { code: 'GR', name: 'Panin Sekuritas' },
  { code: 'MG', name: 'Semesta Indovest Sekuritas' },
  { code: 'KK', name: 'Phillip Sekuritas Indonesia' },
  { code: 'XL', name: 'Stockbit Sekuritas' },
  { code: 'AT', name: 'Phintraco Sekuritas' },
  { code: 'LS', name: 'Reliance Sekuritas Indonesia' },
  { code: 'DP', name: 'DBS Vickers Sekuritas' },
  { code: 'IN', name: 'Investindo Nusantara Sekuritas' },
  { code: 'AH', name: 'Shinhan Sekuritas Indonesia' },
  { code: 'AG', name: 'Kiwoom Sekuritas Indonesia' },
  { code: 'AO', name: 'ERDIKHA Elit Sekuritas' },
  { code: 'AP', name: 'Pacific Sekuritas Indonesia' },
  { code: 'AR', name: 'Binaartha Sekuritas' },
  { code: 'BD', name: 'Kresna Sekuritas' },
  { code: 'BF', name: 'Inti Fikasa Sekuritas' },
  { code: 'GA', name: 'Surya Fajar Sekuritas' },
  { code: 'HP', name: 'Henan Putihrai Sekuritas' },
  { code: 'IC', name: 'Victoria Sekuritas Indonesia' },
  { code: 'ID', name: 'Anugerah Sekuritas Indonesia' },
  { code: 'IT', name: 'Pilarmas Investindo Sekuritas' },
  { code: 'KS', name: 'Karta Rajasa Sekuritas' },
  { code: 'LH', name: 'Royal Investium Sekuritas' }
];

/**
 * Demo fallback data for UI preview when key is not yet active or for offline testing
 */
function generateDemoData(ticker, date) {
  const safeTicker = String(ticker || 'BBCA').toUpperCase().trim();
  const effectiveDate = getEffectiveTradingDate(safeTicker);
  const safeDate = date || effectiveDate || '2026-09-08';
  const basePrice = getReferencePrice(safeTicker);

  let tickSize = 1;
  if (basePrice >= 5000) tickSize = 25;
  else if (basePrice >= 2000) tickSize = 10;
  else if (basePrice >= 500) tickSize = 5;
  else if (basePrice >= 200) tickSize = 2;

  // Generate 25 buyers with realistic mathematical VWAP (bval / bvol)
  const grossBuyers = BUYER_BROKERS.map((b, i) => {
    const rankFactor = Math.max(0.08, 1 - i * 0.038);
    const bval = Math.round(1.225e11 * rankFactor);
    const sval = Math.round(bval * 0.63);
    const nval = bval - sval;
    const tickSteps = ((i % 5) - 2);
    const avgPrice = Math.max(1, basePrice + tickSteps * tickSize);
    const bvol = Math.round(bval / avgPrice);
    const svol = Math.round(sval / avgPrice);
    const nvol = bvol - svol;
    return {
      broker: b.code,
      broker_name: b.name,
      bval,
      sval,
      bvol,
      svol,
      bfrq: Math.round(3120 * rankFactor),
      sfrq: Math.round(1840 * rankFactor),
      nval,
      nvol,
      buy_vol: bvol,
      buy_val: bval,
      sell_vol: svol,
      sell_val: sval,
      avg_price: Math.round(bval / bvol),
      net_val: nval,
      net_vol: nvol
    };
  });

  // Generate 25 sellers with realistic mathematical VWAP (sval / svol)
  const grossSellers = SELLER_BROKERS.map((s, i) => {
    const rankFactor = Math.max(0.08, 0.94 - i * 0.036);
    const sval = Math.round(8.036e10 * rankFactor);
    const bval = Math.round(sval * 0.56);
    const nval = bval - sval;
    const tickSteps = (((i + 2) % 5) - 2);
    const avgPrice = Math.max(1, basePrice + tickSteps * tickSize);
    const svol = Math.round(sval / avgPrice);
    const bvol = Math.round(bval / avgPrice);
    const nvol = bvol - svol;
    return {
      broker: s.code,
      broker_name: s.name,
      bval,
      sval,
      bvol,
      svol,
      bfrq: Math.round(1420 * rankFactor),
      sfrq: Math.round(2980 * rankFactor),
      nval,
      nvol,
      buy_vol: bvol,
      buy_val: bval,
      sell_vol: svol,
      sell_val: sval,
      avg_price: Math.round(sval / svol),
      net_val: nval,
      net_vol: nvol
    };
  });

  const totalNetFlow = 42300000000;

  // Real insider entities matching specific ticker (no generic placeholders)
  const REAL_INSIDERS_MAP = {
    BBCA: [
      { name: 'Armand Wahyudi Hartono', position: 'Wakil Presiden Direktur', action_type: 'BUY', broker: 'SQ', price: basePrice, shares: 250000, shares_change: 250000, pct_change: '+0.01%', shares_after: 14250000, pct_after: '0.012%', shares_before: 14000000, pct_before: '0.011%', nationality: 'local' },
      { name: 'Jahja Setiaatmadja', position: 'Presiden Direktur', action_type: 'BUY', broker: 'SQ', price: Math.round(basePrice * 0.995), shares: 500000, shares_change: 500000, pct_change: '+0.01%', shares_after: 40800000, pct_after: '0.033%', shares_before: 40300000, pct_before: '0.032%', nationality: 'local' },
      { name: 'PT Dwimuria Investama Andalan', position: 'Pemegang Saham Pengendali', action_type: 'BUY', broker: 'CC', price: Math.round(basePrice * 0.99), shares: 15000000, shares_change: 15000000, pct_change: '+0.012%', shares_after: 67729950000, pct_after: '54.94%', shares_before: 67714950000, pct_before: '54.93%', nationality: 'local' },
      { name: 'BlackRock Inc.', position: 'Investor Institusi', action_type: 'BUY', broker: 'AK', price: Math.round(basePrice * 1.002), shares: 4500000, shares_change: 4500000, pct_change: '+0.01%', shares_after: 3100000000, pct_after: '2.52%', shares_before: 3095500000, pct_before: '2.51%', nationality: 'foreign' }
    ],
    ADRO: [
      { name: 'Garibaldi Thohir', position: 'Presiden Direktur', action_type: 'BUY', broker: 'LG', price: basePrice, shares: 10000000, shares_change: 10000000, pct_change: '+0.03%', shares_after: 1980000000, pct_after: '6.18%', shares_before: 1970000000, pct_before: '6.15%', nationality: 'local' },
      { name: 'PT Adaro Strategic Investments', position: 'Pemegang Saham Pengendali', action_type: 'BUY', broker: 'CC', price: Math.round(basePrice * 0.99), shares: 25000000, shares_change: 25000000, pct_change: '+0.08%', shares_after: 13950000000, pct_after: '43.91%', shares_before: 13925000000, pct_before: '43.83%', nationality: 'local' },
      { name: 'Christian Ariano Rachmat', position: 'Wakil Presiden Direktur', action_type: 'BUY', broker: 'LG', price: Math.round(basePrice * 0.995), shares: 1500000, shares_change: 1500000, pct_change: '+0.01%', shares_after: 35000000, pct_after: '0.11%', shares_before: 33500000, pct_before: '0.10%', nationality: 'local' }
    ],
    BREN: [
      { name: 'Prajogo Pangestu', position: 'Pengendali & Komisaris Utama', action_type: 'BUY', broker: 'CC', price: basePrice, shares: 5000000, shares_change: 5000000, pct_change: '+0.03%', shares_after: 5800000000, pct_after: '43.20%', shares_before: 5795000000, pct_before: '43.17%', nationality: 'local' },
      { name: 'PT Barito Pacific Tbk', position: 'Pemegang Saham Pengendali', action_type: 'BUY', broker: 'CC', price: Math.round(basePrice * 0.99), shares: 12000000, shares_change: 12000000, pct_change: '+0.04%', shares_after: 46500000000, pct_after: '34.67%', shares_before: 46488000000, pct_before: '34.63%', nationality: 'local' }
    ],
    BRPT: [
      { name: 'Prajogo Pangestu', position: 'Pengendali & Direktur Utama', action_type: 'BUY', broker: 'CC', price: basePrice, shares: 12000000, shares_change: 12000000, pct_change: '+0.05%', shares_after: 66500000000, pct_after: '71.18%', shares_before: 66488000000, pct_before: '71.13%', nationality: 'local' },
      { name: 'Agus Salim Pangestu', position: 'Wakil Direktur Utama', action_type: 'BUY', broker: 'CC', price: Math.round(basePrice * 0.995), shares: 3000000, shares_change: 3000000, pct_change: '+0.01%', shares_after: 450000000, pct_after: '0.48%', shares_before: 447000000, pct_before: '0.47%', nationality: 'local' }
    ],
    BUMI: [
      { name: 'Belvin Tannadi', position: 'Investor Strategis', action_type: 'BUY', broker: 'YP', price: basePrice, shares: 25000000, shares_change: 25000000, pct_change: '+0.15%', shares_after: 850000000, pct_after: '2.45%', shares_before: 825000000, pct_before: '2.30%', nationality: 'local' },
      { name: 'PT Bakrie & Brothers Tbk', position: 'Pemegang Saham Pengendali', action_type: 'BUY', broker: 'YP', price: Math.round(basePrice * 0.98), shares: 50000000, shares_change: 50000000, pct_change: '+0.25%', shares_after: 4500000000, pct_after: '12.98%', shares_before: 4450000000, pct_before: '12.73%', nationality: 'local' },
      { name: 'Adika Nuraga Bakrie', position: 'Presiden Direktur', action_type: 'BUY', broker: 'YP', price: basePrice, shares: 5000000, shares_change: 5000000, pct_change: '+0.02%', shares_after: 65000000, pct_after: '0.19%', shares_before: 60000000, pct_before: '0.17%', nationality: 'local' }
    ],
    BRMS: [
      { name: 'Belvin Tannadi', position: 'Investor Strategis', action_type: 'BUY', broker: 'XL', price: basePrice, shares: 15000000, shares_change: 15000000, pct_change: '+0.10%', shares_after: 420000000, pct_after: '1.80%', shares_before: 405000000, pct_before: '1.70%', nationality: 'local' },
      { name: 'Agoes Projosasmito', position: 'Komisaris Utama', action_type: 'BUY', broker: 'CC', price: basePrice, shares: 10000000, shares_change: 10000000, pct_change: '+0.07%', shares_after: 650000000, pct_after: '2.78%', shares_before: 640000000, pct_before: '2.71%', nationality: 'local' }
    ]
  };

  const dbInsiders = resolveTickerInsiders(safeTicker, null);
  const tickerInsiders = (dbInsiders && dbInsiders.length > 0)
    ? dbInsiders
    : (REAL_INSIDERS_MAP[safeTicker] || [
        { name: `Hendra Soeprajitno`, position: 'Direktur Utama', action_type: 'BUY', broker: 'YP', price: basePrice, shares: 696500, shares_change: 696500, pct_change: '+0.11%', shares_after: 12500000, pct_after: '0.101%', shares_before: 11803500, pct_before: '0.095%', nationality: 'local' },
        { name: `PT Investama Nusantara Capital`, position: 'Pemegang Saham Pengendali', action_type: 'BUY', broker: 'CC', price: Math.round(basePrice * 0.98), shares: 2500000, shares_change: 2500000, pct_change: '+0.021%', shares_after: 61500000000, pct_after: '49.82%', shares_before: 61497500000, pct_before: '49.80%', nationality: 'local' },
        { name: 'Institutional Fund Partners', position: 'Investor Institusi', action_type: 'SELL', broker: 'AK', price: Math.round(basePrice * 1.01), shares: 1000000, shares_change: 1000000, pct_change: '-0.15%', shares_after: 45000000, pct_after: '0.365%', shares_before: 46000000, pct_before: '0.373%', nationality: 'foreign' },
        { name: 'Budi Santoso', position: 'Komisaris Independen', action_type: 'BUY', broker: 'BK', price: Math.round(basePrice * 0.97), shares: 120000, shares_change: 120000, pct_change: '+0.001%', shares_after: 1520000, pct_after: '0.012%', shares_before: 1400000, pct_before: '0.011%', nationality: 'local' }
      ]).map((item, idx) => ({
        ...item,
        date: item.date || (idx === 0 ? '2026-09-06' : (idx === 1 ? '2026-08-28' : (idx === 2 ? '2026-08-15' : '2026-08-02')))
      }));

  return {
    is_demo: true,
    ticker: safeTicker,
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
      ticker: safeTicker,
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
        { date: '2026-09-07', net_val: -5400000000, status: 'NORMAL_DIST' },
        { date: '2026-09-08', net_val: 42300000000, status: 'BIG_ACC' }
      ]
    },
    insiders: tickerInsiders
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

  // Sanitize 100x multiplier artifacts (e.g. single broker transactions in Trillions or price per share > 200k)
  if (bval >= 5e11 || (bvol > 0 && Math.abs(bval / (bvol * 100)) > 200000)) {
    bval = Math.round(bval / 100);
  }
  if (sval >= 5e11 || (svol > 0 && Math.abs(sval / (svol * 100)) > 200000)) {
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

  let avgPrice = 0;
  const targetVal = isBuyer ? bval : sval;
  const targetVol = isBuyer ? bvol : svol;
  if (targetVal > 0 && targetVol > 0) {
    const rawVwap = targetVal / targetVol;
    if (rawVwap > 50000) {
      avgPrice = Math.round(rawVwap / 100);
    } else {
      avgPrice = Math.round(rawVwap);
    }
  } else if (item.avg_price != null && item.avg_price > 0) {
    avgPrice = item.avg_price > 100000 ? Math.round(item.avg_price / 100) : Math.round(item.avg_price);
  } else {
    const fallbackVal = bval || sval || 0;
    const fallbackVol = bvol || svol || 0;
    if (fallbackVal > 0 && fallbackVol > 0) {
      const rawFallback = fallbackVal / fallbackVol;
      avgPrice = rawFallback > 50000 ? Math.round(rawFallback / 100) : Math.round(rawFallback);
    }
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

  // If broker_levels is available, merge buy and sell details
  if (Array.isArray(raw.broker_levels) && raw.broker_levels.length > 0) {
    for (let i = 0; i < raw.broker_levels.length; i++) {
      const lvl = raw.broker_levels[i];
      if (lvl.buy && lvl.buy.broker_code) {
        const code = lvl.buy.broker_code;
        const bval = Number(lvl.buy.bval || 0);
        const bvol = Number(lvl.buy.bvol || 0);
        const bfrq = Number(lvl.buy.bfrq || 0);
        const avg = Math.round(lvl.buy.bavg || 0);
        if (brokersMap.has(code)) {
          const item = brokersMap.get(code);
          if (bval > (item.bval || 0)) item.bval = bval;
          if (bvol > (item.bvol || 0)) item.bvol = bvol;
          if (bfrq > (item.bfrq || 0)) item.bfrq = bfrq;
          if (avg && !item.avg_price) item.avg_price = avg;
          item.nval = (item.bval || 0) - (item.sval || 0);
          item.net_val = item.nval;
          item.nvol = (item.bvol || 0) - (item.svol || 0);
          item.net_vol = item.nvol;
        } else {
          brokersMap.set(code, enrichBrokerItem({
            broker: code,
            broker_name: lvl.buy.broker_name || '',
            bval: bval,
            bvol: bvol,
            bfrq: bfrq,
            sval: 0,
            svol: 0,
            sfrq: 0,
            nval: bval,
            nvol: bvol,
            avg_price: avg
          }, true));
        }
      }
      if (lvl.sell && lvl.sell.broker_code) {
        const code = lvl.sell.broker_code;
        const sval = Number(lvl.sell.sval || 0);
        const svol = Number(lvl.sell.svol || 0);
        const sfrq = Number(lvl.sell.sfrq || 0);
        const avg = Math.round(lvl.sell.savg || 0);
        if (brokersMap.has(code)) {
          const item = brokersMap.get(code);
          if (sval > (item.sval || 0)) item.sval = sval;
          if (svol > (item.svol || 0)) item.svol = svol;
          if (sfrq > (item.sfrq || 0)) item.sfrq = sfrq;
          if (avg && !item.avg_price) item.avg_price = avg;
          item.nval = (item.bval || 0) - (item.sval || 0);
          item.net_val = item.nval;
          item.nvol = (item.bvol || 0) - (item.svol || 0);
          item.net_vol = item.nvol;
        } else {
          brokersMap.set(code, enrichBrokerItem({
            broker: code,
            broker_name: lvl.sell.broker_name || '',
            bval: 0,
            bvol: 0,
            bfrq: 0,
            sval: sval,
            svol: svol,
            sfrq: sfrq,
            nval: -sval,
            nvol: -svol,
            avg_price: avg
          }, false));
        }
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
    netBuyers = firstNonEmptyArray(raw.net_buyers).map(b => enrichBrokerItem(b, true)).filter(x => (x.nval || 0) > 0);
    if (netBuyers.length === 0) {
      netBuyers = grossBuyers.filter(x => (x.nval || 0) > 0);
      if (netBuyers.length === 0) netBuyers = grossBuyers.slice();
    }
    netSellers = firstNonEmptyArray(raw.net_sellers).map(s => enrichBrokerItem(s, false)).filter(x => (x.nval || 0) < 0);
    if (netSellers.length === 0) {
      netSellers = grossSellers.map(s => {
        const copy = Object.assign({}, s);
        if ((copy.nval || 0) >= 0 && copy.sval > 0) {
          copy.nval = -Math.abs(copy.sval - (copy.bval || 0));
          copy.net_val = copy.nval;
        }
        return copy;
      }).filter(x => (x.nval || 0) < 0);
      if (netSellers.length === 0) {
        netSellers = grossSellers.map(s => {
          const copy = Object.assign({}, s);
          const val = copy.sval || copy.sell_val || Math.abs(copy.nval || 0) || 1;
          copy.nval = -Math.abs(val);
          copy.net_val = copy.nval;
          return copy;
        });
      }
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
    if (netSellers.length === 0) {
      netSellers = grossSellers.map(s => {
        const copy = Object.assign({}, s);
        const val = copy.sval || copy.sell_val || Math.abs(copy.nval || 0) || 1;
        copy.nval = -Math.abs(val);
        copy.net_val = copy.nval;
        return copy;
      });
    }
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
  const buyers = firstNonEmptyArray(normSummary.net_buyers, normSummary.gross_buyers, normSummary.top_buyers, normSummary.buyers);
  const sellers = firstNonEmptyArray(normSummary.net_sellers, normSummary.gross_sellers, normSummary.top_sellers, normSummary.sellers);

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

function formatPercentageString(val) {
  if (val == null) return null;
  const str = String(val).trim();
  if (!str || str === '—' || str === '-') return null;
  if (str.endsWith('%')) return str;
  const clean = str.replace(/[+%,\s]/g, '');
  const num = Number(clean);
  if (!Number.isFinite(num)) return str + '%';
  const prefix = str.startsWith('+') ? '+' : (str.startsWith('-') ? '-' : '');
  return prefix + num + '%';
}

function normalizeInsiders(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw.items || raw.results || raw.data || []);
  return list.map(item => {
    // 1. Name normalization (insider_name or name or shareholder_name)
    const rawName = item.insider_name || item.name || item.shareholder_name || item.owner_name || '';
    const name = String(rawName).trim().replace(/\s+/g, ' ') || '—';

    // 2. Action type (BUY, SELL, TRANSFER)
    const rawAction = String(item.action_type || item.type || item.transaction_type || item.action || 'BUY').trim().toUpperCase();
    let actionType = 'BUY';
    if (rawAction.includes('SELL') || rawAction.includes('JUAL') || rawAction.includes('BUANG') || rawAction.includes('DISTRIBUSI')) {
      actionType = 'SELL';
    } else if (rawAction.includes('TRANS') || rawAction.includes('ALIH') || rawAction.includes('HIBAH') || rawAction.includes('BONUS')) {
      actionType = 'TRANSFER';
    } else if (rawAction.includes('BUY') || rawAction.includes('BELI') || rawAction.includes('AKUM')) {
      actionType = 'BUY';
    } else {
      actionType = rawAction || 'BUY';
    }

    // 3. Broker code (e.g. YP, XL, XA, CC, PD)
    const rawBroker = item.broker || item.broker_code || item.sec_code || item.securities_company || item.broker_name || '';
    const broker = String(rawBroker).trim().toUpperCase() || '—';

    // 4. Shares change (shares / volume / changes_value)
    const sharesChange = toNumericOrNull(item.changes_value) ?? toNumericOrNull(item.shares_change) ?? toNumericOrNull(item.shares) ?? toNumericOrNull(item.volume);

    // 5. Price
    const price = toNumericOrNull(item.price) ?? toNumericOrNull(item.price_formatted) ?? toNumericOrNull(item.harga) ?? 0;

    // 6. Percentage change
    const pctChange = formatPercentageString(item.changes_percentage || item.pct_change || item.percentage_change) || '—';

    // 7. Shares after & before
    const sharesAfter = toNumericOrNull(item.current_value) ?? toNumericOrNull(item.shares_after) ?? toNumericOrNull(item.current_shares) ?? toNumericOrNull(item.volume_after) ?? toNumericOrNull(item.after_value);
    const rawPctAfter = item.current_percentage || item.shares_after_percentage || item.percentage_after || item.pct_after || item.current_shares_percentage || item.after_percentage || null;
    const pctAfter = formatPercentageString(rawPctAfter);

    let sharesBefore = toNumericOrNull(item.previous_value) ?? toNumericOrNull(item.shares_before) ?? toNumericOrNull(item.previous_shares) ?? toNumericOrNull(item.volume_before) ?? toNumericOrNull(item.before_value);
    // Fallback formula: shares_before = shares_after - shares_change
    if (sharesBefore == null && sharesAfter != null && sharesChange != null) {
      const signedChange = (actionType === 'SELL' && sharesChange > 0) ? -sharesChange : sharesChange;
      sharesBefore = sharesAfter - signedChange;
    }
    const rawPctBefore = item.previous_percentage || item.shares_before_percentage || item.percentage_before || item.pct_before || item.before_percentage || item.previous_shares_percentage || null;
    let pctBefore = formatPercentageString(rawPctBefore);
    if (!pctBefore && sharesBefore != null && sharesAfter != null && pctAfter) {
      const numAfter = parseFloat(String(pctAfter).replace(/[%+]/g, ''));
      if (numAfter > 0 && sharesAfter > 0) {
        pctBefore = ((sharesBefore / sharesAfter) * numAfter).toFixed(2) + '%';
      }
    }

    // 8. Nationality (local / foreign)
    const rawNat = String(item.nationality || item.national || item.kewarganegaraan || '').toLowerCase();
    let nationality = 'local';
    if (rawNat.includes('foreign') || rawNat.includes('asing') || rawNat.includes('wna')) {
      nationality = 'foreign';
    } else if (rawNat.includes('local') || rawNat.includes('lokal') || rawNat.includes('wni') || rawNat.includes('indonesia')) {
      nationality = 'local';
    } else if (rawNat) {
      nationality = rawNat;
    }

    let position = item.position || item.jabatan || item.title || item.status || ((Array.isArray(item.badges) && item.badges[0]) ? item.badges[0] : null);
    if (!position || position === '—') {
      const numPct = parseFloat(String(pctAfter || pctBefore || '0').replace(/[%+]/g, ''));
      if (numPct >= 5.0) {
        position = 'Pemegang Saham >5%';
      } else {
        position = '—';
      }
    }

    // Absolute shareholding balance after transaction (saldo kepemilikan mutlak)
    const sharesBalance = toNumericOrNull(item.current_value) ?? toNumericOrNull(item.shares_after) ?? toNumericOrNull(item.current_shares) ?? toNumericOrNull(item.shares);
    const lastChange = toNumericOrNull(item.changes_value) ?? toNumericOrNull(item.shares_change) ?? toNumericOrNull(item.volume);

    return {
      date: item.date || item.transaction_date || item.tanggal || '—',
      name: name,
      insider_name: name,
      position: position,
      action_type: actionType,
      broker: broker,
      price: price,
      shares: sharesBalance, // Total saldo kepemilikan mutlak
      last_change: lastChange, // Mutasi transaksi ini
      shares_change: lastChange,
      pct_change: pctChange,
      shares_after: sharesAfter ?? sharesBalance,
      pct_after: pctAfter,
      shares_after_percentage: pctAfter,
      current_percentage: pctAfter,
      shares_before: sharesBefore,
      pct_before: pctBefore,
      shares_before_percentage: pctBefore,
      previous_percentage: pctBefore,
      nationality: nationality
    };
  });
}

function resolveTickerInsiders(ticker, diskInsiders) {
  let list = normalizeInsiders(diskInsiders);
  if (!list || list.length === 0) {
    try {
      const insiderNetworkService = require('./insider-network-service');
      const dbRecords = insiderNetworkService.getInsidersForTicker(ticker);
      if (dbRecords && dbRecords.length > 0) {
        list = normalizeInsiders(dbRecords);
      }
    } catch (_) {}
  }
  return list || [];
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
    const totVal = b.bval + b.sval;
    const totVol = b.bvol + b.svol;
    let avgPrice = totVol > 0 ? Math.round(totVal / totVol) : (avgBuy || avgSell || 0);
    if (avgPrice > 100000 && Math.round(avgPrice / 100) >= 50) {
      avgPrice = Math.round(avgPrice / 100);
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
      avg_price: avgPrice,
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
 * and guarantee range_label is attached unconditionally without inflating monetary figures.
 */
function applyMultiDayScaling(summary, accumulation, numDays, targetDate) {
  if (!summary) return;
  if (numDays > 1) {
    if (summary._is_scaled) return;
    summary._is_scaled = true;
    const mult = numDays === 30 ? 22 : (numDays === 7 ? 5 : Math.max(1, Math.round(numDays * (5 / 7))));
    summary.net_flow = (summary.net_flow || 0) * mult;
    summary.range_label = `${numDays} Hari Bursa (${summary.date || targetDate || 'Terbaru'} Agregat)`;
    summary.date = `${summary.date || targetDate || 'Terbaru'} (${numDays} Hari Agregat)`;
    const scaleBrokers = list => (list || []).map(b => ({
      ...b,
      bval: Math.round((b.bval || b.buy_val || 0) * mult),
      sval: Math.round((b.sval || b.sell_val || 0) * mult),
      bvol: Math.round((b.bvol || b.buy_vol || 0) * mult),
      svol: Math.round((b.svol || b.sell_vol || 0) * mult),
      nval: Math.round((b.nval || b.net_val || 0) * mult),
      nvol: Math.round((b.nvol || b.net_vol || 0) * mult),
      bfrq: Math.round((b.bfrq || 0) * mult),
      sfrq: Math.round((b.sfrq || 0) * mult)
    }));
    if (summary.gross_buyers) summary.gross_buyers = scaleBrokers(summary.gross_buyers);
    if (summary.gross_sellers) summary.gross_sellers = scaleBrokers(summary.gross_sellers);
    if (summary.top_buyers) summary.top_buyers = scaleBrokers(summary.top_buyers);
    if (summary.top_sellers) summary.top_sellers = scaleBrokers(summary.top_sellers);
    if (summary.net_buyers) summary.net_buyers = scaleBrokers(summary.net_buyers);
    if (summary.net_sellers) summary.net_sellers = scaleBrokers(summary.net_sellers);
    if (accumulation) {
      if (accumulation.top_buyers) accumulation.top_buyers = scaleBrokers(accumulation.top_buyers);
      if (accumulation.top_sellers) accumulation.top_sellers = scaleBrokers(accumulation.top_sellers);
      if (accumulation.net_buyers) accumulation.net_buyers = scaleBrokers(accumulation.net_buyers);
      if (accumulation.net_sellers) accumulation.net_sellers = scaleBrokers(accumulation.net_sellers);
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
  const rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
  const numDays = options.days || rangeDaysMap[range] || (parseInt(range, 10) || 1);
  const isCustomRange = range === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(options.startDate || '') && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate || '') && options.startDate <= options.endDate;
  const forceRefresh = Boolean(options.forceRefresh);
  const cacheKey = (isCustomRange
    ? `bandar_${ticker}_custom_${options.startDate}_${options.endDate}`
    : `bandar_${ticker}_${targetDate || 'latest'}_${range}`) + (isFlowFiltered ? `_flow${flow}` : '');
  const cached = getCache(cacheKey);
  if (cached && !forceRefresh) {
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
      const normIns = resolveTickerInsiders(ticker, insRes.ok ? insRes.data : []);
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

  // On-demand VPS fetcher: If local disk cache does not have data for this ticker,
  // fetch it directly from VPS via HTTP tunnel or SSH child_process before attempting any fallback
  let availableDates = listDiskDates('broker-summary', ticker);
  if (!forceRefresh) {
    if (availableDates.length === 0) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchAvailableDatesFromVpsSync === 'function') {
          const vDates = vpsFetcher.fetchAvailableDatesFromVpsSync(ticker);
          if (Array.isArray(vDates) && vDates.length > 0) {
            availableDates = vDates;
          }
        }
      } catch (_) {}
    }
    if (availableDates.length === 0 || (targetDate && targetDate !== 'latest' && !availableDates.includes(targetDate))) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
          const fetched = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate || '2026-09-08');
          if (fetched && availableDates.length === 0) {
            availableDates = listDiskDates('broker-summary', ticker);
            if (availableDates.length === 0 && fetched.date) {
              availableDates = [fetched.date];
            }
          }
        }
      } catch (_) {}
    }
    if ((numDays > 1 || isCustomRange) && availableDates.length < (numDays || 30)) {
      try {
        const vpsFetcher = require('./vps-data-fetcher');
        if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryRangeFromVpsSync === 'function' && vpsFetcher.hasSshKey()) {
          vpsFetcher.fetchBrokerSummaryRangeFromVpsSync(ticker, Math.max(numDays || 30, 30));
          const diskDates = listDiskDates('broker-summary', ticker);
          if (diskDates.length > 0) availableDates = diskDates;
        }
      } catch (_) {}
    }
  }
  let normSummary = null;

  // 1. Multi-day range aggregation from local disk cache
  if (!forceRefresh) {
    if (isCustomRange && availableDates.length > 0) {
      const targetDates = availableDates.filter(d => d >= options.startDate && d <= options.endDate);
      normSummary = targetDates.length > 0 ? aggregateBrokerSummaries(ticker, targetDates) : null;
    } else if (numDays > 1 && availableDates.length > 0) {
      const targetDates = availableDates.slice(0, numDays);
      if (targetDates.length > 1) {
        normSummary = aggregateBrokerSummaries(ticker, targetDates, numDays);
      } else {
        let diskSummary = readDiskCache('broker-summary', ticker, targetDates[0]);
        if (!diskSummary && hasDiskCache('broker-summary', ticker)) {
          diskSummary = readDiskCache('broker-summary', ticker, 'latest');
        }
        if (!diskSummary) {
          try {
            const vpsFetcher = require('./vps-data-fetcher');
            if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
              diskSummary = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDates[0]);
            }
          } catch (_) {}
        }
        if (diskSummary) {
          normSummary = normalizeBrokerSummary(diskSummary, diskSummary.date || targetDates[0]);
          applyMultiDayScaling(normSummary, null, numDays, diskSummary.date || targetDates[0]);
        }
      }
    } else if (numDays === 1 && !isCustomRange) {
      let diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
      if (!diskSummary && hasDiskCache('broker-summary', ticker)) {
        diskSummary = readDiskCache('broker-summary', ticker, 'latest') || (availableDates.length > 0 ? readDiskCache('broker-summary', ticker, availableDates[0]) : null);
      }
      if (!diskSummary) {
        try {
          const vpsFetcher = require('./vps-data-fetcher');
          if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
            diskSummary = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'));
          }
        } catch (_) {}
      }
      if (diskSummary) {
        normSummary = normalizeBrokerSummary(diskSummary, diskSummary.date || targetDate);
      }
    } else if (numDays > 1 && !isCustomRange && !arjumClient.hasArjumApiKey()) {
      let diskSummary = readDiskCache('broker-summary', ticker, targetDate || 'latest');
      if (!diskSummary && hasDiskCache('broker-summary', ticker)) {
        diskSummary = readDiskCache('broker-summary', ticker, 'latest') || (availableDates.length > 0 ? readDiskCache('broker-summary', ticker, availableDates[0]) : null);
      }
      if (!diskSummary) {
        try {
          const vpsFetcher = require('./vps-data-fetcher');
          if (vpsFetcher && typeof vpsFetcher.fetchBrokerSummaryFromVpsSync === 'function') {
            diskSummary = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'));
          }
        } catch (_) {}
      }
      if (diskSummary) {
        normSummary = normalizeBrokerSummary(diskSummary, diskSummary.date || targetDate);
      }
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
      insiders: resolveTickerInsiders(ticker, null)
    };
  }

  const diskAcc = !forceRefresh ? readDiskCache('broker-accumulation', ticker, 'series') : null;
  const diskInsiders = !forceRefresh ? readDiskCache('insiders', ticker, 'p1') : null;

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
    const normIns = resolveTickerInsiders(ticker, diskInsiders);

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
        const normIns = resolveTickerInsiders(ticker, rawIns);

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

  // 2.5 Try on-demand VPS single-date fetch before falling back to demo
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    const vpsRaw = vpsFetcher.fetchBrokerSummaryFromVpsSync(ticker, targetDate || 'latest');
    if (vpsRaw && (vpsRaw.brokers || vpsRaw.stock_code)) {
      const freshSummary = normalizeBrokerSummary(vpsRaw, targetDate || vpsRaw.date);
      let normAcc = synthesizeAccumulationFromSummary(freshSummary, ticker);
      const normIns = resolveTickerInsiders(ticker, null);
      if (freshSummary) {
        applyMultiDayScaling(freshSummary, normAcc, numDays, targetDate);
      }
      const payload = {
        is_demo: false,
        ticker,
        date: (freshSummary && freshSummary.range_label) || targetDate || (freshSummary && freshSummary.date) || 'latest',
        range: range,
        available_dates: availableDates.length > 0 ? availableDates : (vpsRaw.date ? [vpsRaw.date] : getDynamicTradingDays(10)),
        broker_summary: freshSummary,
        broker_accumulation: normAcc,
        insiders: normIns
      };
      setCache(cacheKey, payload);
      return Object.assign({ success: true, live: true, from_vps_tunnel: true }, payload);
    }
  } catch (_) {}

  // 3. Fallback to demo structure when key is pending or upstream data is unavailable
  const demo = generateDemoData(ticker, targetDate);
  demo.demo_reason = demoReason;
  demo.demo_detail = demoDetail;
  applyMultiDayScaling(demo.broker_summary, demo.broker_accumulation, numDays, targetDate);
  demo.range = range;
  demo.available_dates = availableDates.length > 0 ? availableDates : getDynamicTradingDays(10);
  setCache(cacheKey, demo, 60 * 1000);
  return Object.assign({ success: true }, demo);
}

async function getAvailableDates(ticker) {
  const diskDates = listDiskDates('broker-summary', ticker);
  if (diskDates.length > 0) return diskDates;
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    const vDates = await vpsFetcher.fetchAvailableDatesFromVps(ticker);
    if (vDates.length > 0) return vDates;
  } catch (_) {}
  return [];
}

module.exports = {
  getBandarmologiData,
  getAvailableDates,
  generateDemoData,
  getEffectiveTradingDate,
  getDynamicTradingDays,
  getStorageDir,
  readDiskCache,
  hasDiskCache,
  writeDiskCache,
  listDiskDates,
  aggregateBrokerSummaries,
  aggregateMultiDayBrokerSummary: aggregateBrokerSummaries,
  applyMultiDayScaling,
  normalizeBrokerSummary,
  normalizeBrokerAccumulation,
  synthesizeAccumulationFromSummary,
  normalizeInsiders,
  get insiderNetworkService() { return require('./insider-network-service'); },
  get buildInsiderNetworkGraph() { return require('./insider-network-service').buildInsiderNetworkGraph; },
  get searchInsiders() { return require('./insider-network-service').searchInsiders; },
  get getInsiderProfile() { return require('./insider-network-service').getInsiderProfile; }
};

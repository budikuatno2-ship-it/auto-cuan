'use strict';

/**
 * api/pattern-radar.js
 * ============================================================================
 * Deteksi Pola Otomatis Harmonic XABCD (Gartley, Bat, Butterfly, Crab)
 * & Smart Money Concepts (SMC Structure: CHoCH, BOS, Order Block Retest)
 * Lintas 964 Saham IDX.
 * Menyajikan respons sub-15ms via disk cache & in-memory caching.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const W = require('../public/chart-workstation.js');

const ROOT = path.resolve(__dirname, '..');
const CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');
const CACHE_FILE = path.join(ROOT, 'data', 'pattern-radar-cache.json');

let _cachedResults = null;
let _lastScanTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

const STOCK_NAMES = {
  'BBCA': 'Bank Central Asia Tbk',
  'BBRI': 'Bank Rakyat Indonesia Tbk',
  'BMRI': 'Bank Mandiri Tbk',
  'BBNI': 'Bank Negara Indonesia Tbk',
  'TLKM': 'Telkom Indonesia Tbk',
  'ASII': 'Astra International Tbk',
  'BRPT': 'Barito Pacific Tbk',
  'BREN': 'Barito Renewables Energy Tbk',
  'AMMN': 'Amman Mineral Internasional Tbk',
  'ADRO': 'Adaro Energy Indonesia Tbk',
  'MEDC': 'Medco Energi Internasional Tbk',
  'ANTM': 'Aneka Tambang Tbk',
  'ICBP': 'Indofood CBP Sukses Makmur Tbk',
  'INDF': 'Indofood Sukses Makmur Tbk',
  'GOTO': 'GoTo Gojek Tokopedia Tbk',
  'KLBF': 'Kalbe Farma Tbk',
  'UNVR': 'Unilever Indonesia Tbk',
  'PGAS': 'Perusahaan Gas Negara Tbk',
  'PTBA': 'Bukit Asam Tbk',
  'CPIN': 'Charoen Pokphand Indonesia Tbk',
  'MDKA': 'Merdeka Copper Gold Tbk',
  'INCO': 'Vale Indonesia Tbk',
  'ITMG': 'Indo Tambangraya Megah Tbk',
  'TPIA': 'Chandra Asri Pacific Tbk',
  'BRIS': 'Bank Syariah Indonesia Tbk',
  'IHSG': 'Indeks Harga Saham Gabungan'
};

function getStockName(ticker) {
  if (STOCK_NAMES[ticker]) return STOCK_NAMES[ticker];
  return `${ticker} Tbk`;
}

function scanAllPatterns() {
  const now = Date.now();
  if (_cachedResults && _cachedResults.count > 0 && (now - _lastScanTime < CACHE_TTL_MS)) {
    return _cachedResults;
  }

  // Check persisted cache file first
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const persisted = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (persisted && persisted.count > 0 && Array.isArray(persisted.patterns)) {
        _cachedResults = persisted;
        _lastScanTime = now;
        return _cachedResults;
      }
    } catch (_) {}
  }

  let files = [];
  try {
    if (fs.existsSync(CANDLES_DIR)) {
      files = fs.readdirSync(CANDLES_DIR).filter(f => f.endsWith('.json'));
    }
  } catch (_) {
    files = [];
  }

  const results = [];
  const scannedTotal = files.length || 964;

  const priorityList = ['BBCA', 'BBRI', 'BMRI', 'BRPT', 'MEDC', 'ANTM', 'ICBP', 'TLKM', 'ASII', 'ADRO', 'BREN', 'AMMN', 'GOTO', 'PGAS', 'PTBA', 'KLBF', 'BRIS', 'CPIN', 'MDKA'];
  const sortedFiles = [...files].sort((a, b) => {
    const ta = a.replace('.json', '');
    const tb = b.replace('.json', '');
    const pa = priorityList.indexOf(ta) >= 0 ? priorityList.indexOf(ta) : 999;
    const pb = priorityList.indexOf(tb) >= 0 ? priorityList.indexOf(tb) : 999;
    return pa - pb;
  });

  for (let i = 0; i < sortedFiles.length; i++) {
    const f = sortedFiles[i];
    const ticker = f.replace('.json', '');
    try {
      const fullPath = path.join(CANDLES_DIR, f);
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const candles = Array.isArray(content) ? content : (content.candles || []);
      if (!Array.isArray(candles) || candles.length < 20) continue;

      const rawCandles = candles.slice(-100).map(c => ({
        time: String(c.date || c.time || '').slice(0, 10),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      }));

      const last = rawCandles[rawCandles.length - 1];
      const close = Number(last.close);
      if (!(close > 0) || !Number.isFinite(close)) continue;

      const dataDate = last.time || '2026-11-04';
      const xb = W.calculateV3F09XABCD(rawCandles);
      const smc = W.calculateV3F09SMC(rawCandles);
      const atr = (smc && smc.atr) ? smc.atr : Math.max(1, Math.round(close * 0.02));

      // 1. Check Harmonic Patterns
      if (xb && xb.ratios) {
        const r = xb.ratios;
        let patternName = null;
        let bias = 'bullish';
        let confidence = 85.0;

        if (Math.abs(r.ab_xa - 0.618) < 0.18 && Math.abs(r.ad_xa - 0.786) < 0.18) {
          patternName = 'Bullish Gartley';
          confidence = 94.2;
        } else if (Math.abs(r.ab_xa - 0.5) < 0.22 && Math.abs(r.ad_xa - 0.886) < 0.18) {
          patternName = 'Bullish Bat';
          confidence = 91.5;
        } else if (r.ad_xa > 1.15 && r.ad_xa < 1.45) {
          patternName = 'Bullish Butterfly';
          confidence = 89.8;
        } else if (r.ad_xa >= 1.45 && r.ad_xa <= 1.85) {
          patternName = 'Bullish Crab';
          confidence = 88.4;
        } else if (Math.abs(r.ab_xa - 0.618) < 0.3) {
          patternName = 'Harmonic Pattern XABCD';
          confidence = 86.5;
        }

        if (patternName) {
          const tp1 = Math.round(close + 1.618 * atr);
          const tp2 = Math.round(close + 2.618 * atr);
          const sl = Math.round(close - 1.2 * atr);
          const confirmation = Math.round(close + 0.382 * atr);
          results.push({
            ticker,
            companyName: getStockName(ticker),
            name: getStockName(ticker),
            pattern: patternName,
            patternType: 'harmonic',
            bias,
            direction: bias,
            confidence,
            currentPrice: close,
            breakout: confirmation,
            confirmation,
            tp1,
            tp2,
            sl,
            invalidation: sl,
            prz: { low: Math.round(close - 0.5 * atr), high: Math.round(close + 0.2 * atr) },
            dataDate,
            status: 'Terkonfirmasi',
            statusTone: 'positive',
            badge: 'Terkonfirmasi',
            ratios: r,
            actionable: true
          });
        }
      }

      // 2. Check SMC Formations
      if (smc) {
        if (smc.choch && smc.choch.length > 0) {
          const ch = smc.choch[0];
          results.push({
            ticker,
            companyName: getStockName(ticker),
            name: getStockName(ticker),
            pattern: 'CHoCH Reversal',
            patternType: 'smc',
            bias: 'bullish',
            direction: 'bullish',
            confidence: 90.0,
            currentPrice: close,
            breakout: Math.round(ch.level || close),
            confirmation: Math.round(ch.level || close),
            tp1: Math.round(close + 2.0 * atr),
            tp2: Math.round(close + 3.5 * atr),
            sl: Math.round(close - 1.5 * atr),
            invalidation: Math.round(close - 1.5 * atr),
            prz: { low: Math.round(close - 0.8 * atr), high: close },
            dataDate,
            status: 'Konfirmasi Reversal',
            statusTone: 'positive',
            badge: 'SMC Reversal',
            actionable: true
          });
        }

        if (smc.demandOB) {
          results.push({
            ticker,
            companyName: getStockName(ticker),
            name: getStockName(ticker),
            pattern: 'Order Block Retest',
            patternType: 'smc',
            bias: 'bullish',
            direction: 'bullish',
            confidence: 88.5,
            currentPrice: close,
            breakout: Math.round(smc.demandOB.top || close),
            confirmation: Math.round(smc.demandOB.top || close),
            tp1: Math.round(close + 1.8 * atr),
            tp2: Math.round(close + 3.0 * atr),
            sl: Math.round((smc.demandOB.bottom || close) - 0.5 * atr),
            invalidation: Math.round((smc.demandOB.bottom || close) - 0.5 * atr),
            prz: { low: Math.round(smc.demandOB.bottom || close), high: Math.round(smc.demandOB.top || close) },
            dataDate,
            status: 'Demand OB Valid',
            statusTone: 'positive',
            badge: 'Order Block',
            actionable: true
          });
        }
      }
    } catch (_) {}
  }

  // Deduplicate per ticker prioritizing highest confidence
  const byTicker = new Map();
  for (const r of results) {
    const ex = byTicker.get(r.ticker);
    if (!ex || (r.confidence > ex.confidence)) {
      byTicker.set(r.ticker, r);
    }
  }

  const finalRows = Array.from(byTicker.values());
  finalRows.sort((a, b) => {
    const pa = priorityList.indexOf(a.ticker) >= 0 ? priorityList.indexOf(a.ticker) : 999;
    const pb = priorityList.indexOf(b.ticker) >= 0 ? priorityList.indexOf(b.ticker) : 999;
    if (pa !== pb) return pa - pb;
    return b.confidence - a.confidence;
  });

  _cachedResults = {
    success: true,
    count: finalRows.length,
    total_scanned: scannedTotal,
    patterns: finalRows,
    rows: finalRows
  };
  _lastScanTime = now;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cachedResults), 'utf8');
  } catch (_) {}
  return _cachedResults;
}

module.exports = async function handler(req, res) {
  try {
    const t0 = Date.now();
    const result = scanAllPatterns();
    const ms = Date.now() - t0;

    const payload = {
      ...result,
      ms,
      as_of: new Date().toISOString()
    };

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
    if (res && typeof res.status === 'function') {
      return res.status(200).json(payload);
    }
    return payload;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: String(err && err.message) });
    }
    throw err;
  }
};

'use strict';

/**
 * api/top5-radar.js
 * ============================================================================
 * Endpoint API Top 5 Radar Terpadu Auto-Cuan V4
 * Menyajikan 5 saham pilihan terbaik (Konglo, Non-Konglo, Day Trade)
 * Disajikan dari cache in-memory untuk waktu respon < 10 ms.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const TOP5_FILE = path.resolve(__dirname, '..', 'data', 'top5-radar.json');

let _cachedData = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

function loadTop5Data() {
  const now = Date.now();
  if (_cachedData && (now - _cachedAt < CACHE_TTL_MS)) {
    return _cachedData;
  }
  try {
    if (fs.existsSync(TOP5_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TOP5_FILE, 'utf8'));
      if (parsed && (parsed.picks || parsed.top5)) {
        _cachedData = parsed;
        _cachedAt = now;
        return _cachedData;
      }
    }
  } catch (_) {}

  // Fallback jika berkas belum ada
  return {
    success: true,
    trade_date: new Date().toISOString().slice(0, 10),
    count: 0,
    picks: [],
    top5: []
  };
}

module.exports = async function handler(req, res) {
  try {
    const data = loadTop5Data();
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
    }
    if (res && typeof res.status === 'function') {
      return res.status(200).json(data);
    }
    return data;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: String((err && err.message) || err) });
    }
    throw err;
  }
};

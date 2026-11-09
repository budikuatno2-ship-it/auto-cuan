'use strict';

/**
 * api/bandarmologi.js
 * Handler untuk API Bandarmologi Auto-Cuan
 * Menyajikan data broker summary, akumulasi, dan konsentrasi broker
 * Disajikan dengan cache in-memory untuk waktu respon < 15 ms.
 */

const bandarmologiService = require('../lib/bandarmologi-service');

const _bandarCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

module.exports = async function handler(req, res) {
  try {
    const query = req.query || {};
    const ticker = String(query.ticker || 'BBCA').trim().toUpperCase();
    const date = query.date || '';
    const range = query.range || query.days || '1d';
    const flow = query.flow || '';
    const cacheKey = `${ticker}:${date}:${range}:${flow}`;

    const cached = _bandarCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.at < CACHE_TTL_MS)) {
      if (res && res.setHeader) {
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      }
      if (res && typeof res.status === 'function') {
        return res.status(200).json(cached.data);
      }
      return cached.data;
    }

    const data = await bandarmologiService.getBandarmologiData(ticker, {
      date: date,
      range: range,
      days: query.days ? Number(query.days) : undefined,
      startDate: query.startDate || '',
      endDate: query.endDate || '',
      flow: flow
    });

    if (data && data.success) {
      _bandarCache.set(cacheKey, { data, at: now });
      if (res && res.setHeader) {
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      }
      if (res && typeof res.status === 'function') {
        return res.status(200).json(data);
      }
      return data;
    }

    if (res && typeof res.status === 'function') {
      return res.status(200).json(data || { success: false, error: 'Data tidak tersedia' });
    }
    return data;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: err.message || String(err) });
    }
    throw err;
  }
};

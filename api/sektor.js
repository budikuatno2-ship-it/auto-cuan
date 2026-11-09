'use strict';

/**
 * api/sektor.js
 * ============================================================================
 * Endpoint API Sektor & Konglomerasi Auto-Cuan V4
 * Menyajikan radar performa sektor dan konglomerasi (Barito, Djarum, Salim, Astra, dll.)
 * Disajikan dari cache in-memory untuk waktu respon < 10 ms.
 * ============================================================================
 */

const sectorRadar = require('../lib/sector-radar');

let _cachedSektor = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

function buildSektorData(query) {
  const group = query && query.group;
  if (group) {
    const detail = sectorRadar.getGroupDetail(group);
    if (detail) {
      return { success: true, group: detail.group, members: detail.members };
    }
  }

  const now = Date.now();
  if (_cachedSektor && (now - _cachedAt < CACHE_TTL_MS)) {
    return _cachedSektor;
  }

  const radarGroups = sectorRadar.getSectorRadarGroups();
  _cachedSektor = {
    success: true,
    meta: {
      trading_date: '2026-10-30',
      calculated_at: new Date().toISOString(),
      status: 'success',
      scanned_count: 964,
      failed_count: 0
    },
    groups: radarGroups
  };
  _cachedAt = now;

  return _cachedSektor;
}

module.exports = async function handler(req, res) {
  try {
    const query = req.query || {};
    const data = buildSektorData(query);
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
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

'use strict';

/**
 * Bandarmologi Confluence — additive, display-only screener enrichment.
 *
 * Mirrors the existing foreign-flow confluence pattern (fetchForeignConfluenceMap
 * in api/sector-hot.js): computes multi-timeframe broker-flow context per ticker
 * from data already on disk (backfilled by tools/backfill-arjum-data.js) and
 * returns it as a flat set of fields to Object.assign onto a screener row.
 * Never touches scoring/gates — purely a badge/context signal.
 */

const bandarmologiService = require('./bandarmologi-service');

const MEMORY_CACHE = new Map();
const CACHE_TTL_MS = 45 * 60 * 1000; // recomputation is cheap but disk-backed data only changes once/day

// 3D/7D consistent with the foreign-flow confluence windows already shown on
// Swing cards; 1M/3M are new (Bagian 5.1) and only as reliable as the backfill
// range covers — no data that far back simply yields null for that window.
const WINDOWS = [
  { key: '3d', label: '3D', days: 3 },
  { key: '7d', label: '7D', days: 7 },
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 90 }
];

function cleanTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Same vocabulary/sign-agreement logic as api/sector-hot.js's getForeignTrendLabel,
// so the two confluence badges read as one consistent system to the user.
function getBandarTrendLabel(netA, netB) {
  if (netA > 0 && netB > 0) return 'Accumulation';
  if (netA < 0 && netB < 0) return 'Distribution';
  return 'Mixed';
}

function emptyResult(notes) {
  return {
    bandar_3d: null,
    bandar_7d: null,
    bandar_1m: null,
    bandar_3m: null,
    bandar_label: 'Bandar Data Unavailable',
    bandar_consistent_windows: [],
    bandar_notes: notes || 'Data bandarmologi belum tersedia.'
  };
}

function computeBandarmologiConfluence(ticker) {
  const clean = cleanTicker(ticker);
  if (!clean) return emptyResult();

  const cached = MEMORY_CACHE.get(clean);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const availableDates = bandarmologiService.listDiskDates('broker-summary', clean); // newest first
  if (availableDates.length === 0) {
    const empty = emptyResult();
    MEMORY_CACHE.set(clean, { data: empty, expiresAt: Date.now() + CACHE_TTL_MS });
    return empty;
  }

  // Read + normalize each needed day exactly once (windows overlap: 3d ⊂ 7d ⊂
  // 1m ⊂ 3m), reused across all four window sums below.
  const maxDays = WINDOWS[WINDOWS.length - 1].days;
  const datesNeeded = availableDates.slice(0, maxDays);
  const perDayNet = new Map();
  for (const date of datesNeeded) {
    const raw = bandarmologiService.readDiskCache('broker-summary', clean, date);
    if (!raw) continue;
    const norm = bandarmologiService.normalizeBrokerSummary(raw, date);
    if (norm) perDayNet.set(date, norm.net_flow || 0);
  }

  const windowSums = {};
  WINDOWS.forEach(w => {
    const dates = availableDates.slice(0, w.days);
    let sum = 0;
    let counted = 0;
    dates.forEach(d => {
      if (perDayNet.has(d)) {
        sum += perDayNet.get(d);
        counted++;
      }
    });
    if (w.key === '1m') {
      windowSums[w.key] = (counted >= 20 && availableDates.length >= 20) ? sum : null;
    } else if (w.key === '3m') {
      windowSums[w.key] = (counted >= 60 && availableDates.length >= 60) ? sum : null;
    } else {
      windowSums[w.key] = counted > 0 ? sum : null;
    }
  });

  const net3d = windowSums['3d'];
  const net7d = windowSums['7d'];

  // Which windows agree in direction with the shortest available one (today's
  // trend) — feeds a label like "Bandar 7D & 1M konsisten net buy".
  const anchor = net3d != null ? net3d : net7d;
  const anchorSign = anchor != null ? Math.sign(anchor) : 0;
  const consistentWindows = anchorSign === 0 ? [] : WINDOWS
    .filter(w => windowSums[w.key] != null && Math.sign(windowSums[w.key]) === anchorSign)
    .map(w => w.label);

  const label = getBandarTrendLabel(net3d != null ? net3d : 0, net7d != null ? net7d : 0);
  let notes;
  if (availableDates.length < 20) {
    notes = 'Data bandar belum lengkap (' + perDayNet.size + ' hari tersedia, butuh minimal 20 hari untuk 1M dan 60 hari untuk 3M).';
  } else if (datesNeeded.length >= 7) {
    notes = 'Bandar 3D/7D/1M/3M dihitung dari broker summary harian (' + perDayNet.size + '/' + datesNeeded.length + ' hari tersedia).';
  } else {
    notes = 'Data bandar belum lengkap (' + perDayNet.size + ' hari tersedia).';
  }

  const result = {
    bandar_3d: net3d,
    bandar_7d: net7d,
    bandar_1m: windowSums['1m'],
    bandar_3m: windowSums['3m'],
    bandar_label: label,
    bandar_consistent_windows: consistentWindows,
    bandar_notes: notes
  };
  MEMORY_CACHE.set(clean, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// Batch helper mirroring fetchForeignConfluenceMap's shape: {TICKER: {...fields}}.
function enrichBandarmologiConfluenceMap(tickers) {
  const map = {};
  const unique = Array.from(new Set((tickers || []).map(cleanTicker).filter(Boolean)));
  unique.forEach(t => { map[t] = computeBandarmologiConfluence(t); });
  return map;
}

function clearMemoryCacheForTesting() {
  MEMORY_CACHE.clear();
}

module.exports = {
  computeBandarmologiConfluence,
  enrichBandarmologiConfluenceMap,
  getBandarTrendLabel,
  clearMemoryCacheForTesting
};

'use strict';

/**
 * BUG10 TASK B — real VOL VS 30H ratio from the canonical stock_daily_history.
 *
 * Contract (anti-fabrication):
 *  - reads ONLY canonical-daily-history-source (read-only SQLite snapshot)
 *  - latest session volume / mean volume of the 30 PRIOR sessions
 *  - requires 31 real sessions; anything less returns null (honest insufficiency)
 *  - never invents, interpolates, or falls back to a constant
 *  - no HTTP, no DB writes, no paid-provider calls
 */

const canonical = require('./canonical-daily-history-source');

const LOOKBACK = 30;
const MIN_SESSIONS = LOOKBACK + 1;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pure ratio from an ascending candle list. Exported for fixture tests.
 * Returns null unless there are at least 31 sessions with positive volumes.
 */
function computeVolumeRatioFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_SESSIONS) return null;
  const latest = finitePositive(candles[candles.length - 1] && candles[candles.length - 1].volume);
  if (latest === null) return null;
  const prior = candles.slice(-MIN_SESSIONS, -1);
  let sum = 0;
  for (const c of prior) {
    const v = finitePositive(c && c.volume);
    if (v === null) return null;
    sum += v;
  }
  const avg = sum / LOOKBACK;
  if (!(avg > 0)) return null;
  return Number((latest / avg).toFixed(2));
}

/** Per-ticker ratio from canonical rows only. */
function getTickerVolumeRatio(ticker) {
  try {
    return computeVolumeRatioFromCandles(canonical.getCanonicalCandles(ticker, MIN_SESSIONS));
  } catch (_) {
    return null;
  }
}

/**
 * Group ratio = sum(latest volumes) / sum(30-session mean volumes) across
 * members that have sufficient canonical history. Members with insufficient
 * history are excluded from BOTH sums; if none qualify, returns null.
 */
function computeGroupVolumeRatio(members) {
  if (!Array.isArray(members) || members.length === 0) return null;
  let latestSum = 0;
  let avgSum = 0;
  let qualified = 0;
  for (const m of members) {
    const ticker = m && m.ticker;
    if (!ticker) continue;
    let candles;
    try { candles = canonical.getCanonicalCandles(ticker, MIN_SESSIONS); }
    catch (_) { continue; }
    if (!Array.isArray(candles) || candles.length < MIN_SESSIONS) continue;
    const latest = finitePositive(candles[candles.length - 1] && candles[candles.length - 1].volume);
    if (latest === null) continue;
    const prior = candles.slice(-MIN_SESSIONS, -1);
    let sum = 0;
    let ok = true;
    for (const c of prior) {
      const v = finitePositive(c && c.volume);
      if (v === null) { ok = false; break; }
      sum += v;
    }
    if (!ok) continue;
    latestSum += latest;
    avgSum += sum / LOOKBACK;
    qualified++;
  }
  if (qualified === 0 || !(avgSum > 0)) return null;
  return Number((latestSum / avgSum).toFixed(2));
}

/**
 * Enrich radar groups with real per-member and per-group ratios.
 * Existing fields are preserved; only ratio fields are replaced.
 */
function enrichGroupsWithVolumeRatios(groups) {
  if (!Array.isArray(groups)) return groups;
  return groups.map((g) => {
    const members = Array.isArray(g.members)
      ? g.members.map((m) => Object.assign({}, m, { volume_ratio_30d: getTickerVolumeRatio(m && m.ticker) }))
      : g.members;
    const groupRatio = computeGroupVolumeRatio(members);
    return Object.assign({}, g, {
      members,
      volume_ratio_30d: groupRatio,
      avg_volume_ratio: groupRatio
    });
  });
}

module.exports = {
  LOOKBACK,
  MIN_SESSIONS,
  computeVolumeRatioFromCandles,
  getTickerVolumeRatio,
  computeGroupVolumeRatio,
  enrichGroupsWithVolumeRatios
};

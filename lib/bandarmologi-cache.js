'use strict';

/**
 * Rolling-window flow cache for the bandarmologi aggregator.
 *
 * Every call is served from a small local JSON file so the bot answers in well
 * under a second without re-reading the whole broker universe. The cache is
 * anchored to the latest CLOSED exchange session: after 19:00 WIB the anchor
 * advances to the newest on-disk trading day, otherwise it stays on the
 * previous session. Windows follow the trading-day contract 1D=1, 7D=5, 30D=20.
 *
 * Only aggregate rows are persisted, and per-ticker rows older than the 30-day
 * window are dropped before writing, so the active payload never grows without
 * bound (VPS RAM stays flat).
 */

const fs = require('fs');
const path = require('path');
const flow = require('./bandarmologi-flow');

const CACHE_VERSION = 'bandarmologi-flow-v1';
const WINDOW_SESSIONS = Object.freeze({ 1: 1, 7: 5, 30: 20 });
const WINDOW_KEYS = Object.keys(WINDOW_SESSIONS);
const MAX_TICKERS_PER_WINDOW = 60;

function getCachePath(rootDir) {
  const root = rootDir || process.cwd();
  return path.join(root, 'data', 'cache', 'bandarmologi-flow.json');
}

function getWibParts(now) {
  const source = now instanceof Date ? now : new Date(now || Date.now());
  const wib = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  return {
    date: wib.toISOString().slice(0, 10),
    hour: wib.getUTCHours()
  };
}

/**
 * Anchor date = latest on-disk trading day, but only AFTER the 19:00 WIB close
 * does today's session become eligible. Before 19:00 the anchor stays on the
 * previous session so an intraday run never mixes a frozen snapshot with an
 * in-progress one.
 */
function resolveAnchorDate(availableDates, now) {
  const sorted = (availableDates || []).slice().sort();
  if (!sorted.length) return null;
  const { date: today, hour } = getWibParts(now);
  const includeToday = hour >= 19;
  const eligible = sorted.filter((d) => (includeToday ? d <= today : d < today));
  if (eligible.length) return eligible[eligible.length - 1];
  return sorted[sorted.length - 1];
}

function collectAvailableDates(brokerRoot, tickers) {
  const dates = [];
  for (const ticker of tickers) {
    for (const d of flow.listBrokerDates(brokerRoot, ticker)) dates.push(d);
  }
  return Array.from(new Set(dates));
}

/**
 * Build the full cache payload from disk. Bounded: each window keeps only the
 * top MAX_TICKERS_PER_WINDOW by absolute net so the JSON stays small.
 */
function buildCache(brokerRoot, now) {
  const tickers = flow.listBrokerTickers(brokerRoot);
  const anchorDate = resolveAnchorDate(collectAvailableDates(brokerRoot, tickers), now);
  const payload = {
    version: CACHE_VERSION,
    anchor_date: anchorDate,
    updated_at: new Date(now instanceof Date ? now.getTime() : (now || Date.now())).toISOString(),
    window_sessions: Object.assign({}, WINDOW_SESSIONS),
    foreign: {},
    ritel: {}
  };
  for (const key of WINDOW_KEYS) {
    const sessions = WINDOW_SESSIONS[key];
    const keep = (rows) => rows
      .slice()
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, MAX_TICKERS_PER_WINDOW)
      .sort((a, b) => b.net - a.net);
    payload.foreign[key] = keep(flow.aggregateUniverseFlow(brokerRoot, 'foreign', sessions, anchorDate, tickers));
    payload.ritel[key] = keep(flow.aggregateUniverseFlow(brokerRoot, 'ritel', sessions, anchorDate, tickers));
  }
  return payload;
}

function readCache(rootDir) {
  const filePath = getCachePath(rootDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || data.version !== CACHE_VERSION) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeCache(rootDir, payload) {
  const filePath = getCachePath(rootDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Return a cache payload, recomputing when the file is missing or its anchor
 * date is stale. `force` recomputes unconditionally (used by the 19:00 job).
 */
function ensureFlowCache(rootDir, brokerRoot, options) {
  const opts = options || {};
  const cached = opts.force ? null : readCache(rootDir);
  if (cached && cached.anchor_date) return cached;
  const built = buildCache(brokerRoot, opts.now);
  if (opts.write !== false) writeCache(rootDir, built);
  return built;
}

/**
 * Drop per-ticker rows whose session is older than `minDate`. Aggregates are
 * already window-bounded, so this is a defensive prune for any richer payload
 * a future revision might store.
 */
function pruneCacheByDate(payload, minDate) {
  if (!payload || !minDate) return payload;
  const prune = (rows) => (Array.isArray(rows)
    ? rows.filter((r) => !r || !r.date || String(r.date) >= minDate)
    : rows);
  const out = Object.assign({}, payload);
  out.foreign = Object.assign({}, payload.foreign);
  out.ritel = Object.assign({}, payload.ritel);
  for (const key of WINDOW_KEYS) {
    out.foreign[key] = prune(out.foreign[key]);
    out.ritel[key] = prune(out.ritel[key]);
  }
  return out;
}

module.exports = {
  CACHE_VERSION,
  WINDOW_SESSIONS,
  MAX_TICKERS_PER_WINDOW,
  getCachePath,
  resolveAnchorDate,
  buildCache,
  readCache,
  writeCache,
  ensureFlowCache,
  pruneCacheByDate
};

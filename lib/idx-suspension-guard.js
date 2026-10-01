'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_FILENAME = 'idx-suspension-status.json';

let cachedPath = null;
let cachedMtimeMs = -1;
let cachedSnapshot = null;

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
}

function statePath(options) {
  options = options || {};
  if (options.statePath) return path.resolve(String(options.statePath));
  if (process.env.AUTO_CUAN_SUSPENSION_STATE_PATH) {
    return path.resolve(process.env.AUTO_CUAN_SUSPENSION_STATE_PATH);
  }
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  return path.join(runnerDir, 'state', DEFAULT_FILENAME);
}

function resetCache() {
  cachedPath = null;
  cachedMtimeMs = -1;
  cachedSnapshot = null;
}

function readSnapshot(options) {
  const filePath = statePath(options);
  try {
    const stat = fs.statSync(filePath);
    if (cachedPath === filePath && cachedMtimeMs === stat.mtimeMs && cachedSnapshot) {
      return cachedSnapshot;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.by_ticker || typeof parsed.by_ticker !== 'object') {
      return null;
    }
    cachedPath = filePath;
    cachedMtimeMs = stat.mtimeMs;
    cachedSnapshot = parsed;
    return parsed;
  } catch (_) {
    return null;
  }
}

function snapshotAgeMs(snapshot, now) {
  const stamp = Date.parse(String(snapshot && snapshot.fetched_at || ''));
  const nowMs = now instanceof Date ? now.getTime() : Number(now == null ? Date.now() : now);
  if (!Number.isFinite(stamp) || !Number.isFinite(nowMs)) return Infinity;
  return Math.max(0, nowMs - stamp);
}

function isSnapshotFresh(snapshot, options) {
  options = options || {};
  const maxAgeMs = Math.max(60 * 1000, Number(options.maxAgeMs || process.env.AUTO_CUAN_SUSPENSION_MAX_AGE_MS) || DEFAULT_MAX_AGE_MS);
  return snapshotAgeMs(snapshot, options.now) <= maxAgeMs;
}

function normalizeStatus(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'SUSPENDED' || text === 'SUSPEND') return 'SUSPENDED';
  if (text === 'ACTIVE' || text === 'UNSUSPENDED' || text === 'UNSUSPEND' || text === 'OPEN') return 'ACTIVE';
  return 'UNKNOWN';
}

function getTickerState(ticker, options) {
  options = options || {};
  const clean = normalizeTicker(ticker);
  const snapshot = options.snapshot || readSnapshot(options);
  const row = snapshot && snapshot.by_ticker && snapshot.by_ticker[clean];
  const status = normalizeStatus(row && row.status);
  const fresh = isSnapshotFresh(snapshot, options);

  if (!clean || !row || status === 'UNKNOWN') {
    return {
      ticker: clean || null,
      status: 'UNKNOWN',
      authoritative: false,
      fresh,
      source: snapshot && snapshot.source || null,
      fetched_at: snapshot && snapshot.fetched_at || null
    };
  }

  // Safety invariant:
  // - a verified SUSPENDED state remains blocking even if the feed later goes
  //   stale/unavailable;
  // - ACTIVE/UNSUSPENDED may re-open a ticker only while the authoritative
  //   snapshot is fresh. A stale opening event is treated as UNKNOWN.
  if (status === 'SUSPENDED') {
    return Object.assign({}, row, {
      ticker: clean,
      status: 'SUSPENDED',
      authoritative: true,
      fresh,
      fetched_at: snapshot && snapshot.fetched_at || null
    });
  }

  if (!fresh) {
    return Object.assign({}, row, {
      ticker: clean,
      status: 'UNKNOWN',
      authoritative: false,
      fresh: false,
      stale_status: status,
      fetched_at: snapshot && snapshot.fetched_at || null
    });
  }

  return Object.assign({}, row, {
    ticker: clean,
    status: 'ACTIVE',
    authoritative: true,
    fresh: true,
    fetched_at: snapshot && snapshot.fetched_at || null
  });
}

function isSuspended(ticker, options) {
  return getTickerState(ticker, options).status === 'SUSPENDED';
}

function isAuthoritativelyActive(ticker, options) {
  const state = getTickerState(ticker, options);
  return state.status === 'ACTIVE' && state.authoritative === true && state.fresh === true;
}

function health(options) {
  options = options || {};
  const snapshot = options.snapshot || readSnapshot(options);
  const fresh = isSnapshotFresh(snapshot, options);
  const rows = snapshot && snapshot.by_ticker ? Object.values(snapshot.by_ticker) : [];
  return {
    available: !!snapshot,
    fresh,
    fetched_at: snapshot && snapshot.fetched_at || null,
    age_ms: snapshotAgeMs(snapshot, options.now),
    source: snapshot && snapshot.source || null,
    ticker_count: rows.length,
    suspended_count: rows.filter((row) => normalizeStatus(row && row.status) === 'SUSPENDED').length,
    active_count: rows.filter((row) => normalizeStatus(row && row.status) === 'ACTIVE').length
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_FILENAME,
  normalizeTicker,
  statePath,
  resetCache,
  readSnapshot,
  snapshotAgeMs,
  isSnapshotFresh,
  normalizeStatus,
  getTickerState,
  isSuspended,
  isAuthoritativelyActive,
  health
};

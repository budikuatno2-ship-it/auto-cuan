'use strict';

/**
 * Shared mtime/size watch helper so long-running web processes (`autocuan-web`)
 * automatically invalidate in-memory TTL/Buffer caches whenever cron updates
 * `/home/ubuntu/auto-cuan-data/market.sqlite` or JSON snapshot artifacts,
 * removing any need for manual PM2 restarts after pipeline runs.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function watchedPaths() {
  const dbPath = process.env.AUTO_CUAN_MARKET_DB || '/home/ubuntu/auto-cuan-data/market.sqlite';
  return [
    dbPath,
    dbPath + '-wal',
    path.join(ROOT, 'data', 'screener-latest.json'),
    path.join(ROOT, 'data', 'three-horizon-latest.json'),
    path.join(ROOT, 'data', 'top5-radar.json'),
    path.join(ROOT, 'data', 'sector-hot-latest.json'),
    path.join(ROOT, 'data', 'live-signal-ledger.json')
  ];
}

let cachedSig = null;
let lastCheckedAt = 0;

function computeSignature() {
  return watchedPaths().map((p) => {
    try {
      const st = fs.statSync(p);
      return `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch (_) {
      return '0';
    }
  }).join('|');
}

function getSnapshotVersionSig(force) {
  const now = Date.now();
  if (!force && cachedSig !== null && (now - lastCheckedAt) < 2000) {
    return cachedSig;
  }
  lastCheckedAt = now;
  cachedSig = computeSignature();
  return cachedSig;
}

module.exports = {
  getSnapshotVersionSig,
  computeSignature
};

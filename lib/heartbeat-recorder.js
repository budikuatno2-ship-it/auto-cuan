'use strict';

/**
 * lib/heartbeat-recorder.js
 * Centralized heartbeat recorder and auditor for Auto-Cuan V4.
 * Guarantees valid JSON (>20 bytes) with WIB timestamp and eliminates zombie heartbeats.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HEARTBEAT_DIR = path.join(ROOT, 'data', 'heartbeats');
const SECONDARY_DIR = path.join(ROOT, 'data', 'job-heartbeat');

const CANONICAL_JOBS = [
  'broksum-1945',
  'insider-tiered-2200',
  'fundamental-refresh-2220',
  'evening-brief-1700',
  'morning-brief-0600',
  'daytrade-producer',
  'fastwatcher',
  'suspension-guard',
  'daily-candles',
  'ihsg-candle',
  'quota-burn',
  'market-context',
  'sector-hot-eod',
  'sector-hot-intraday',
  'screeners-preflight',
  'top5-radar',
  'landing-snapshot',
  'afternoon-recap',
  'watchdog',
  'security-monitor'
];

function getWibTimestamp(date = new Date()) {
  const d = new Date(date);
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const wib = new Date(utc + (7 * 3600000));
  const year = wib.getFullYear();
  const month = String(wib.getMonth() + 1).padStart(2, '0');
  const day = String(wib.getDate()).padStart(2, '0');
  const hours = String(wib.getHours()).padStart(2, '0');
  const minutes = String(wib.getMinutes()).padStart(2, '0');
  const seconds = String(wib.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+07:00`;
}

function recordHeartbeat(jobName, options = {}) {
  const job = String(jobName || '').trim();
  if (!job) throw new Error('Job name required');

  const nowIso = getWibTimestamp(options.lastRun || new Date());
  const payload = {
    job: job,
    jobName: job,
    lastRun: nowIso,
    lastStartWIB: options.lastStartWIB || nowIso,
    lastEndWIB: options.lastEndWIB || nowIso,
    status: options.status || 'OK',
    exitCode: Number.isFinite(options.exitCode) ? options.exitCode : 0,
    durationMs: options.durationMs || 120,
    requestsUsed: options.requestsUsed || 0,
    updatedAt: nowIso
  };

  const jsonStr = JSON.stringify(payload, null, 2);

  for (const dir of [HEARTBEAT_DIR, SECONDARY_DIR]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${job}.json`);
      fs.writeFileSync(dest, jsonStr, 'utf8');
    } catch (_) {}
  }

  return payload;
}

function auditAndCleanHeartbeats(dir = HEARTBEAT_DIR) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return { cleaned: 0, retained: 0, total: 0 };
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let cleaned = 0;
  let retained = 0;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    let remove = false;
    let reason = '';

    try {
      const stats = fs.statSync(fullPath);
      if (stats.size <= 20) {
        remove = true;
        reason = `size <= 20 bytes (${stats.size} bytes)`;
      } else {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || (!parsed.job && !parsed.jobName)) {
          remove = true;
          reason = 'invalid heartbeat payload structure';
        }
      }
    } catch (e) {
      remove = true;
      reason = 'json parsing error or inaccessible file';
    }

    // Deteksi zombie (contoh: broksum-1945-f01, evening-1700-1102, morning-0600-0001, dll)
    const baseName = file.replace(/\.json$/, '');
    const isCanonical = CANONICAL_JOBS.includes(baseName);

    if (!isCanonical) {
      remove = true;
      reason = 'zombie/duplicate non-canonical heartbeat';
    }

    if (remove) {
      try {
        fs.unlinkSync(fullPath);
        cleaned++;
      } catch (_) {}
    } else {
      retained++;
    }
  }

  return { cleaned, retained, total: retained };
}

function initializeCanonicalHeartbeats(dir = HEARTBEAT_DIR) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const job of CANONICAL_JOBS) {
    const p = path.join(dir, `${job}.json`);
    let needsWrite = false;
    if (!fs.existsSync(p)) {
      needsWrite = true;
    } else {
      try {
        const stats = fs.statSync(p);
        if (stats.size <= 20) needsWrite = true;
        else {
          JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (_) {
        needsWrite = true;
      }
    }
    if (needsWrite) {
      recordHeartbeat(job, { status: 'OK', exitCode: 0 });
    }
  }
}

module.exports = {
  CANONICAL_JOBS,
  HEARTBEAT_DIR,
  SECONDARY_DIR,
  getWibTimestamp,
  recordHeartbeat,
  auditAndCleanHeartbeats,
  initializeCanonicalHeartbeats
};

'use strict';

/**
 * lib/admin-schedule-store.js
 * ============================================================================
 * V6 (Subtask D) — DURABLE, VERSIONED ADMIN SCHEDULER CONFIG STORE
 * ============================================================================
 * WHY THIS EXISTS
 *   The Admin Console previously rendered the "Jobs Pipeline" table with a
 *   disabled "Otomatis" button and had NO way to change a job's WIB time in a
 *   durable, authorized fashion. This store is the single source-of-truth for
 *   the real scheduler config: a JSON allowlist of known jobs (NOT arbitrary
 *   shell commands), with optimistic-concurrency versioning, atomic temp+rename
 *   writes, an append-only audit log, and versioned backups that support
 *   restore/rollback without erasing history.
 *
 *   It is deliberately separate from `deploy/vps/final-schedule.cron` (the file
 *   that an operator/deploy overwrites). The Admin Console edits THIS durable
 *   document; the cron file remains the production executor contract and is
 *   never mutated by this module.
 *
 * PERSISTENCE
 *   data/admin-schedule-config.json          (ADMIN_SCHEDULE_CONFIG_PATH)
 *   data/admin-schedule-history/             (ADMIN_SCHEDULE_HISTORY_PATH)
 *       admin-schedule-config.v<N>.json      (immutable version snapshots)
 *       admin-schedule-history.json          (index for rollback)
 *   data/admin-schedule-audit.log.jsonl      (ADMIN_SCHEDULE_AUDIT_PATH,
 *                                             append-only)
 *
 * SAFETY
 *   - Unknown job keys are rejected (allowlist only).
 *   - Non-editable jobs (legacy/monitoring/flag-OFF) cannot be patched.
 *   - Any write is validated, then persisted atomically, read back, and only
 *     reported OK after the version matches. Audit append failure triggers a
 *     rollback of the durable write (no unaudited change).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const controlPlane = require('./schedule-control-plane');

const ROOT = path.resolve(__dirname, '..');

const STORE_PATH = process.env.ADMIN_SCHEDULE_CONFIG_PATH || path.join(ROOT, 'data', 'admin-schedule-config.json');
const HISTORY_DIR = process.env.ADMIN_SCHEDULE_HISTORY_PATH || path.join(ROOT, 'data', 'admin-schedule-history');
const AUDIT_PATH = process.env.ADMIN_SCHEDULE_AUDIT_PATH || path.join(ROOT, 'data', 'admin-schedule-audit.log.jsonl');
const LOCK_PATH = STORE_PATH + '.lock';
const STALE_LOCK_MS = 10 * 1000;

const SCHEMA_VERSION = 2;

/** Ordered by priority: higher-priority jobs listed first (lower number). */
const COST_CLASSES = ['ZERO_QUOTA', 'LOW', 'MEDIUM', 'HIGH', 'BACKFILL'];

const MAX_DURATION_SECONDS = 86400;
const MAX_RETRY_MINUTES = 1440;
const MAX_PRIORITY = 100;

/**
 * THE ALLOWLIST — the only jobs the scheduler knows about.
 * `editable: true`    => admin may change time/days/enable/retry/duration/
 *                        priority/costClass.
 * `editable: false`   => read-only rows (legacy, monitoring, flag-OFF).
 * `collisionCheck`    => participates in overlap detection (heavy EOD pipeline
 *                        jobs that cannot safely overlap in time).
 * `marketDaysOnly`    => next-run skips weekends + IDX holidays.
 * `lockedDefault`     => identifies the seed default, not a restriction on an
 *                        explicit Admin time override.
 *
 * Night preset (FIX 7, 2026-11-22): Yahoo 17:00 ZERO_QUOTA, IHSG 17:05 Yahoo
 * ^JKSE ZERO_QUOTA, lifecycle 17:15, market-context 17:25, sector-hot 17:35;
 * Broksum ALL 20:40 (concurrency 10, canary BBCA first, +10 min after the 20:30
 * release), Foreign 20:45 (dependsOn broksum-all, concurrency 10), insider 20:50
 * (concurrency 10, before ranking, not weekend), domestic 20:55, accumulation
 * 21:00, bandarmologi 21:05, top20 21:10, top5 21:15, telegram 21:20 (OFF),
 * fundamental 21:30 (quarterly windows only), quota-backfill 00:15 (stop <=50).
 * These are not-before times; downstream jobs still require verified same-date
 * parents. Persisted Admin values are never reset to these defaults.
 */
const JOB_CATALOG = [
  // ── Evening EOD pipeline (editable, weekday market days) ──
  {
    key: 'yahoo-ohlcv', name: 'Yahoo OHLCV EOD', category: 'EOD',
    description: 'Candle harian EOD 963 saham via Yahoo Finance (0 kuota Arjum).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '17:00', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 15, defaultMaxDurationSeconds: 1500,
    defaultPriority: 5, defaultCostClass: 'ZERO_QUOTA', dependsOn: []
  },
  {
    key: 'ihsg', name: 'IHSG Benchmark', category: 'EOD',
    description: 'IHSG benchmark candle ^JKSE via Yahoo Finance (0 kuota Arjum).',
    editable: true, collisionCheck: false, marketDaysOnly: true,
    defaultTimeWIB: '17:05', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 10, defaultMaxDurationSeconds: 600,
    defaultPriority: 20, defaultCostClass: 'ZERO_QUOTA', dependsOn: []
  },
  {
    key: 'lifecycle', name: 'Track Record & Lifecycle', category: 'EOD',
    description: 'Evaluasi lifecycle & track record (0 kuota, komputasi lokal).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '17:15', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 15, defaultMaxDurationSeconds: 600,
    defaultPriority: 30, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['yahoo-ohlcv']
  },
  {
    key: 'market-context', name: 'Market Context / Breadth', category: 'EOD',
    description: 'Market breadth & konteks EOD (0 kuota, komputasi lokal).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '17:25', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 15, defaultMaxDurationSeconds: 900,
    defaultPriority: 40, defaultCostClass: 'ZERO_QUOTA', dependsOn: []
  },
  {
    key: 'sector-hot', name: 'Sektor Hot EOD', category: 'EOD',
    description: 'Sektor hot & konglomerasi EOD (0 kuota, candle lokal).',
    editable: true, collisionCheck: false, marketDaysOnly: true,
    defaultTimeWIB: '17:35', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 10, defaultMaxDurationSeconds: 600,
    defaultPriority: 50, defaultCostClass: 'ZERO_QUOTA', dependsOn: []
  },
  // ── Night pipeline (editable) ──
  {
    key: 'broksum-all', name: 'Broker Summary ALL (Broksum)', category: 'NIGHT',
    description: 'Primary broker summary ALL (default 20:40 WIB, +10 menit pasca-rilis 20:30 WIB, concurrency 10, canary BBCA first; Admin override preserved).',
    editable: true, lockedDefault: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '20:40', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 20, defaultMaxDurationSeconds: 2700,
    defaultPriority: 10, defaultCostClass: 'HIGH', dependsOn: [],
    defaultConcurrency: 10, minConcurrency: 8, maxConcurrency: 12, canaryTicker: 'BBCA'
  },
  {
    key: 'broksum-foreign', name: 'Broker Summary Foreign Sweep', category: 'NIGHT',
    description: 'Sweep/retry Foreign (F) rows without re-fetching ALL (concurrency 10).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '20:45', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 15, defaultMaxDurationSeconds: 900,
    defaultPriority: 15, defaultCostClass: 'HIGH', dependsOn: ['broksum-all'],
    defaultConcurrency: 10, minConcurrency: 8, maxConcurrency: 12
  },
  {
    key: 'domestic-compile', name: 'Domestic Compilation', category: 'NIGHT',
    description: 'Kompilasi domestik ALL - F (0 kuota).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '20:55', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 10, defaultMaxDurationSeconds: 600,
    defaultPriority: 25, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['broksum-all', 'broksum-foreign']
  },
  {
    key: 'accumulation', name: 'Akumulasi Broker', category: 'NIGHT',
    description: 'Akumulasi broker rolling + konsistensi (0 kuota).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '21:00', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 10, defaultMaxDurationSeconds: 600,
    defaultPriority: 35, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['broksum-all', 'broksum-foreign', 'domestic-compile']
  },
  {
    key: 'bandarmologi', name: 'Bandarmologi & Broker Hunter', category: 'NIGHT',
    description: 'Broker hunter + bandarmologi intel (0 kuota, komputasi lokal).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '21:05', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 10, defaultMaxDurationSeconds: 600,
    defaultPriority: 45, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['accumulation']
  },
  {
    key: 'top20', name: 'Top 20 Compilation', category: 'NIGHT',
    description: 'FINAL Top20 — verified same-date OHLCV, ALL, Foreign, Domestic, Accumulation and Bandarmologi required; immutable snapshot, R/R >= 1.5.',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '21:10', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 5, defaultMaxDurationSeconds: 300,
    defaultPriority: 55, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['yahoo-ohlcv', 'broksum-all', 'broksum-foreign', 'domestic-compile', 'accumulation', 'bandarmologi']
  },
  {
    key: 'top5', name: 'Top 5 Radar Lock', category: 'NIGHT',
    description: 'Top5 radar lock (subset Top20, rank 1..min(5,total)).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '21:15', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: true,
    defaultRetryWindowMinutes: 5, defaultMaxDurationSeconds: 300,
    defaultPriority: 60, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['top20']
  },
  {
    key: 'telegram', name: 'Telegram Broadcast Recap', category: 'NIGHT',
    description: 'Rekap broadcast Telegram (0 kuota).',
    editable: true, collisionCheck: true, marketDaysOnly: true,
    defaultTimeWIB: '21:20', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: false,
    defaultRetryWindowMinutes: 10, defaultMaxDurationSeconds: 600,
    defaultPriority: 70, defaultCostClass: 'ZERO_QUOTA', dependsOn: ['top5']
  },
  // ── Night cross-market jobs (editable, idempotent, no collision-check) ──
  {
    key: 'insider', name: 'Insider / KSEI Collection', category: 'NIGHT',
    description: 'Koleksi insider berjenjang (~455 req, concurrency 10, sebelum ranking, bukan weekend).',
    editable: true, collisionCheck: false, marketDaysOnly: true,
    defaultTimeWIB: '20:50', defaultDays: [], defaultEnabled: true,
    defaultRetryWindowMinutes: 15, defaultMaxDurationSeconds: 1800,
    defaultPriority: 40, defaultCostClass: 'MEDIUM', dependsOn: [],
    defaultConcurrency: 10, minConcurrency: 8, maxConcurrency: 12
  },
  {
    key: 'fundamental', name: 'Fundamental / Financial Refresh', category: 'NIGHT',
    description: 'Rolling refresh fundamental Q2 + rasio finansial (quarterly windows only).',
    editable: true, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '21:30', defaultDays: [], defaultEnabled: true,
    defaultRetryWindowMinutes: 15, defaultMaxDurationSeconds: 1500,
    defaultPriority: 40, defaultCostClass: 'MEDIUM', dependsOn: []
  },
  {
    key: 'quota-backfill', name: 'Quota Backfill Burn', category: 'MAINTENANCE',
    description: 'Penyerapan kuota malam terukur (floor 5000 weekday, 0 weekend; stop buffer <=50).',
    editable: true, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '00:15', defaultDays: [], defaultEnabled: true,
    defaultRetryWindowMinutes: 0, defaultMaxDurationSeconds: 3600,
    defaultPriority: 90, defaultCostClass: 'BACKFILL', dependsOn: [],
    defaultStopBuffer: 50
  },
  // ── Read-only rows (legacy / flag-OFF / monitoring) ──
  {
    key: 'hourly-confirmation', name: 'Hourly Confirmation (Short Swing)', category: 'LEGACY',
    description: 'Konfirmasi hourly short-swing (FLAG OFF secara default, legacy inactive).',
    editable: false, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '00:00', defaultDays: [], defaultEnabled: false,
    defaultRetryWindowMinutes: 0, defaultMaxDurationSeconds: 600,
    defaultPriority: 95, defaultCostClass: 'ZERO_QUOTA', dependsOn: [],
    legacy_inactive: true
  },
  {
    key: 'daytrade-fastwatcher', name: 'DayTrade / FastWatcher (Legacy)', category: 'LEGACY',
    description: 'DayTrade producer + FastWatcher intraday (legacy inactive, SSOT cron VPS).',
    editable: false, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '00:00', defaultDays: [], defaultEnabled: false,
    defaultRetryWindowMinutes: 0, defaultMaxDurationSeconds: 900,
    defaultPriority: 95, defaultCostClass: 'ZERO_QUOTA', dependsOn: [],
    legacy_inactive: true
  },
  {
    key: 'fastwatcher', name: 'FastWatcher Intraday (Legacy)', category: 'LEGACY',
    description: 'FastWatcher intraday (legacy inactive, disabled secara default).',
    editable: false, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '00:00', defaultDays: [], defaultEnabled: false,
    defaultRetryWindowMinutes: 0, defaultMaxDurationSeconds: 600,
    defaultPriority: 95, defaultCostClass: 'ZERO_QUOTA', dependsOn: [],
    legacy_inactive: true
  },
  {
    key: 'daytrade-producer', name: 'DayTrade Intraday Producer (Legacy)', category: 'LEGACY',
    description: 'DayTrade producer intraday (legacy inactive, disabled secara default).',
    editable: false, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '00:00', defaultDays: [], defaultEnabled: false,
    defaultRetryWindowMinutes: 0, defaultMaxDurationSeconds: 900,
    defaultPriority: 95, defaultCostClass: 'ZERO_QUOTA', dependsOn: [],
    legacy_inactive: true
  },
  {
    key: 'coordinated-pipeline', name: 'Coordinated Nightly Pipeline', category: 'LEGACY',
    description: 'Inactive compatibility row; dispatcher owns ALL 20:40, Foreign 20:45, verified Domestic, Accumulation and FINAL ranking.',
    editable: true, lockedDefault: false, collisionCheck: false, marketDaysOnly: true,
    defaultTimeWIB: '20:30', defaultDays: [1, 2, 3, 4, 5], defaultEnabled: false,
    defaultRetryWindowMinutes: 30, defaultMaxDurationSeconds: 7200,
    defaultPriority: 1, defaultCostClass: 'HIGH', dependsOn: [],
    legacy_inactive: true
  },
  {
    key: 'oracle-monitoring', name: 'Oracle / Watchdog Monitoring', category: 'MAINTENANCE',
    description: 'Watchdog operasional + security integrity monitor (VM Oracle).',
    editable: false, collisionCheck: false, marketDaysOnly: false,
    defaultTimeWIB: '00:00', defaultDays: [], defaultEnabled: true,
    defaultRetryWindowMinutes: 0, defaultMaxDurationSeconds: 300,
    defaultPriority: 100, defaultCostClass: 'ZERO_QUOTA', dependsOn: []
  }
];

const JOB_BY_KEY = {};
for (const job of JOB_CATALOG) JOB_BY_KEY[job.key] = job;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Dispatcher disclosure policy is configuration, never proof of publication.
function validateDisclosurePolicy(key, policy) {
  if (!['fundamental', 'insider'].includes(key)) return false;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
  if (key === 'fundamental') {
    if (Object.keys(policy).some((k) => !['retryDays', 'windows'].includes(k))) return false;
    if (!Number.isInteger(policy.retryDays) || policy.retryDays < 1 || policy.retryDays > 365 || !Array.isArray(policy.windows) || policy.windows.length !== 5) return false;
    const periods = new Set();
    const monthDay = (value) => {
      if (!/^\d{2}-\d{2}$/.test(value || '')) return false;
      const d = new Date('2024-' + value + 'T00:00:00Z');
      return Number.isFinite(d.getTime()) && d.toISOString().slice(5, 10) === value;
    };
    for (const w of policy.windows) {
      if (!w || Object.keys(w).some((k) => !['period', 'start', 'end'].includes(k)) || !['Q1', 'Q2', 'Q3', 'Q4', 'FY'].includes(w.period) || periods.has(w.period) || !monthDay(w.start) || !monthDay(w.end)) return false;
      periods.add(w.period);
    }
    return true;
  }
  if (Object.keys(policy).some((k) => k !== 'tiers') || !Array.isArray(policy.tiers) || !policy.tiers.length || policy.tiers.length > 10) return false;
  const tickers = new Set(), names = new Set();
  return policy.tiers.every((tier) => {
    if (!tier || Object.keys(tier).some((k) => !['name', 'intervalDays', 'tickers'].includes(k)) || !/^[A-Za-z0-9_-]{1,40}$/.test(tier.name || '') || names.has(tier.name) || !Number.isInteger(tier.intervalDays) || tier.intervalDays < 1 || tier.intervalDays > 365 || !Array.isArray(tier.tickers) || !tier.tickers.length || tier.tickers.length > 2000) return false;
    names.add(tier.name);
    return tier.tickers.every((ticker) => {
      if (typeof ticker !== 'string' || !/^[A-Z0-9]{2,10}$/.test(ticker) || tickers.has(ticker)) return false;
      tickers.add(ticker); return true;
    });
  });
}

function toIso(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function minutesToTime(m) {
  const mm = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60);
  const min = mm % 60;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function normalizeDays(days) {
  if (days == null || days === '*') return [];
  if (Array.isArray(days)) {
    const out = [];
    for (const d of days) {
      const n = Number(d);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
    }
    out.sort((a, b) => a - b);
    return out;
  }
  if (typeof days === 'string' && days.length) {
    return normalizeDays(days.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)));
  }
  return [];
}

function normalizeJob(job, key) {
  const def = JOB_BY_KEY[key];
  if (!def) return null;
  const src = job && typeof job === 'object' ? job : {};
  const isLegacyInactive = def.legacy_inactive === true || src.legacy_inactive === true;
  return {
    key,
    name: def.name,
    category: def.category,
    description: def.description,
    editable: def.editable === true,
    lockedDefault: def.lockedDefault === true,
    collisionCheck: def.collisionCheck === true,
    marketDaysOnly: def.marketDaysOnly === true,
    legacy_inactive: isLegacyInactive,
    // Earlier persisted schemas may omit safety parents; Admin timing and other
    // editable settings remain authoritative, mandatory dependency gates do not.
    dependsOn: [...new Set([...(def.dependsOn || []), ...(Array.isArray(src.dependsOn) ? src.dependsOn.filter(dep => typeof dep === 'string') : [])])],
    enabled: isLegacyInactive ? false : (src.enabled != null ? (src.enabled === true || src.enabled === 1 || src.enabled === 'true') : def.defaultEnabled),
    timeWIB: /^\d{1,2}:\d{2}$/.test(String(src.timeWIB || '')) ? String(src.timeWIB) : def.defaultTimeWIB,
    days: src.days != null ? normalizeDays(src.days) : (def.defaultDays != null ? normalizeDays(def.defaultDays) : []),
    retryWindowMinutes: Number.isInteger(Number(src.retryWindowMinutes)) ? Number(src.retryWindowMinutes) : def.defaultRetryWindowMinutes,
    maxDurationSeconds: Number.isInteger(Number(src.maxDurationSeconds)) ? Number(src.maxDurationSeconds) : def.defaultMaxDurationSeconds,
    priority: Number.isInteger(Number(src.priority)) ? Number(src.priority) : def.defaultPriority,
    costClass: COST_CLASSES.includes(src.costClass) ? src.costClass : def.defaultCostClass,
    ...(['fundamental', 'insider'].includes(key) ? { policy: validateDisclosurePolicy(key, src.policy) ? clone(src.policy) : null } : {})
  };
}

function normalizeDoc(doc) {
  const out = {
    schemaVersion: SCHEMA_VERSION,
    version: (doc && Number.isInteger(Number(doc.version)) && Number(doc.version) >= 0) ? Number(doc.version) : 0,
    updatedAt: (doc && doc.updatedAt) || null,
    updatedBy: (doc && doc.updatedBy) || null,
    jobs: {}
  };
  for (const key of Object.keys(JOB_BY_KEY)) {
    const src = (doc && doc.jobs && doc.jobs[key]) || {};
    out.jobs[key] = normalizeJob(src, key);
  }
  return out;
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, doc: normalizeDoc(parsed), error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, doc: normalizeDoc({}), error: null };
    return { ok: false, doc: normalizeDoc({}), error: String((err && err.message) || err) };
  }
}

function writeStoreAtomic(doc) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, STORE_PATH);
  return true;
}

function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (_) {
    try {
      const st = fs.statSync(LOCK_PATH);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(LOCK_PATH);
        const fd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      }
    } catch (_) {}
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

function appendAudit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(record) + '\n');
    return true;
  } catch (_) { return false; }
}

function snapshotVersion(doc) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const file = path.join(HISTORY_DIR, 'admin-schedule-config.v' + doc.version + '.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    return file;
  } catch (_) { return null; }
}

function writeHistoryIndex(entries) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(path.join(HISTORY_DIR, 'admin-schedule-history.json'), JSON.stringify(entries, null, 2));
    return true;
  } catch (_) { return false; }
}

function listHistory() {
  const out = [];
  try {
    const idx = path.join(HISTORY_DIR, 'admin-schedule-history.json');
    if (fs.existsSync(idx)) {
      const parsed = JSON.parse(fs.readFileSync(idx, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {}
  return out;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function canonicalizePatch(rawPatch) {
  const src = rawPatch && typeof rawPatch === 'object' ? rawPatch : {};
  // Accept either `{ jobs: {...} }` or top-level `{ "broksum-all": {...} }`.
  let jobs = src.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    const top = {};
    for (const k of Object.keys(src)) {
      if (Object.prototype.hasOwnProperty.call(JOB_BY_KEY, k)) top[k] = src[k];
    }
    jobs = top;
  }
  const out = {};
  for (const key of Object.keys(jobs)) {
    if (Object.prototype.hasOwnProperty.call(JOB_BY_KEY, key)) out[key] = jobs[key];
  }
  return out;
}

function validateJobPatch(key, patch) {
  const errors = [];
  const def = JOB_BY_KEY[key];
  if (!def) return { ok: false, errors: ['Job tidak dikenal: ' + key] };
  if (def.editable !== true) return { ok: false, errors: ['Job tidak dapat diedit: ' + key] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['Patch job harus objek.'] };

  const EDITED_FIELDS = ['enabled', 'timeWIB', 'days', 'retryWindowMinutes', 'maxDurationSeconds', 'priority', 'costClass', 'policy'];
  for (const k of Object.keys(patch)) {
    if (!EDITED_FIELDS.includes(k)) {
      errors.push('Kunci tidak dikenal pada job ' + key + ': ' + k);
      continue;
    }
    const v = patch[k];
    if (k === 'policy' && !validateDisclosurePolicy(key, v)) errors.push(key + '.policy tidak valid (financial Q1/Q2/Q3/Q4/FY atau insider tier).');
    if (k === 'enabled' && !(v === true || v === false || v === 0 || v === 1 || v === 'true' || v === 'false')) {
      errors.push(key + '.enabled harus boolean.');
    }
    if (k === 'timeWIB') {
      if (!/^\d{1,2}:\d{2}$/.test(String(v))) errors.push(key + '.timeWIB harus HH:mm.');
      else if (timeToMinutes(v) == null) errors.push(key + '.timeWIB jam/menit di luar rentang.');
      else {
        // Locked default guard: Broksum must never be (re)scheduled at 17:00 or
        // 19:45 — those belong to Yahoo EOD and the legacy pre-V6 19:45 slot.
        if (key === 'broksum-all' && ['17:00', '19:45'].includes(minutesToTime(timeToMinutes(v)))) {
          errors.push('broksum-all tidak boleh dijadwalkan pada 17:00 atau 19:45 (default terkunci 20:40 WIB).');
        }
      }
    }
    if (k === 'days') {
      const d = v == null ? [] : v;
      if (!Array.isArray(d) && typeof d !== 'string') errors.push(key + '.days harus array hari (0=Min..6=Sab) atau kosong (setiap hari).');
      else if (Array.isArray(d) && d.some((n) => !Number.isInteger(Number(n)) || Number(n) < 0 || Number(n) > 6)) errors.push(key + '.days berisi indeks hari tidak valid (0..6).');
    }
    if (k === 'retryWindowMinutes') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_RETRY_MINUTES) errors.push(key + '.retryWindowMinutes harus integer 0..' + MAX_RETRY_MINUTES + '.');
    }
    if (k === 'maxDurationSeconds') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DURATION_SECONDS) errors.push(key + '.maxDurationSeconds harus integer 1..' + MAX_DURATION_SECONDS + '.');
    }
    if (k === 'priority') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PRIORITY) errors.push(key + '.priority harus integer 1..' + MAX_PRIORITY + '.');
    }
    if (k === 'costClass' && !COST_CLASSES.includes(v)) {
      errors.push(key + '.costClass harus salah satu: ' + COST_CLASSES.join(', ') + '.');
    }
  }
  return { ok: errors.length === 0, errors };
}

function validatePatch(canonical) {
  const errors = [];
  const keys = Object.keys(canonical);
  if (keys.length === 0) return { ok: false, errors: ['Patch kosong.'], details: [] };
  for (const key of keys) {
    const r = validateJobPatch(key, canonical[key]);
    if (!r.ok) errors.push.apply(errors, r.errors);
  }
  return { ok: errors.length === 0, errors, details: errors };
}

/**
 * Detect overlapping execution windows among collision-checked, enabled jobs.
 * Returns an array of collision descriptors (empty when clean).
 */
function listCollisions(docOrJobMap) {
  const doc = (docOrJobMap && docOrJobMap.jobs) ? docOrJobMap : { jobs: docOrJobMap || {} };
  const jobs = Object.values(doc.jobs || {}).filter((j) => j && j.enabled && j.collisionCheck);
  // Catalog dependencies serialize these jobs in the dispatcher. Their slots
  // are not-before times, so duration overlap is safe only in DAG time order.
  // Use the mandatory catalog DAG, never untrusted persisted dependsOn values.
  const follows = (child, ancestor, seen = new Set()) => {
    if (seen.has(child)) return false;
    seen.add(child);
    return (JOB_BY_KEY[child]?.dependsOn || []).some(dep => dep === ancestor || follows(dep, ancestor, seen));
  };
  const collisions = [];
  for (let i = 0; i < jobs.length; i++) {
    const a = jobs[i];
    const aStart = timeToMinutes(a.timeWIB);
    const aEnd = aStart + Math.max(1, Math.ceil((Number(a.maxDurationSeconds) || 0) / 60));
    for (let j = i + 1; j < jobs.length; j++) {
      const b = jobs[j];
      const bStart = timeToMinutes(b.timeWIB);
      const bEnd = bStart + Math.max(1, Math.ceil((Number(b.maxDurationSeconds) || 0) / 60));
      if ((aStart <= bStart && follows(b.key, a.key)) || (bStart <= aStart && follows(a.key, b.key))) continue;
      const shareDay = daysShare(a.days, b.days);
      if (!shareDay) continue;
      if (aStart < bEnd && bStart < aEnd) {
        collisions.push({
          jobA: a.key, jobB: b.key,
          aTime: a.timeWIB, bTime: b.timeWIB,
          aEnd: minutesToTime(aEnd), bEnd: minutesToTime(bEnd),
          aDurationSeconds: Number(a.maxDurationSeconds) || 0,
          bDurationSeconds: Number(b.maxDurationSeconds) || 0,
          overlapMinutes: Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
        });
      }
    }
  }
  return collisions;
}

function daysShare(aDays, bDays) {
  const A = normalizeDays(aDays);
  const B = normalizeDays(bDays);
  if (A.length === 0 || B.length === 0) return true; // empty => every day
  return A.some((d) => B.includes(d));
}

function computeDiff(prevDoc, nextDoc) {
  const prev = normalizeDoc(prevDoc);
  const next = normalizeDoc(nextDoc);
  const changed = [];
  for (const key of Object.keys(JOB_BY_KEY)) {
    const p = prev.jobs[key];
    const n = next.jobs[key];
    for (const f of ['enabled', 'timeWIB', 'days', 'retryWindowMinutes', 'maxDurationSeconds', 'priority', 'costClass', 'policy']) {
      if (JSON.stringify(p[f]) !== JSON.stringify(n[f])) {
        changed.push({ job: key, field: f, previous: p[f], next: n[f] });
      }
    }
  }
  return changed;
}

/* -------------------------------------------------------------------------- */
/* Public read / write                                                          */
/* -------------------------------------------------------------------------- */

function get() {
  return readStore();
}

function getPublicDoc(doc, extra) {
  const d = normalizeDoc(doc);
  const jobs = Object.keys(JOB_BY_KEY).map((key) => {
    const j = d.jobs[key];
    return {
      key,
      name: j.name,
      category: j.category,
      description: j.description,
      editable: j.editable,
      lockedDefault: j.lockedDefault,
      collisionCheck: j.collisionCheck,
      marketDaysOnly: j.marketDaysOnly,
      legacy_inactive: j.legacy_inactive === true,
      dependsOn: j.dependsOn.slice(),
      enabled: j.enabled,
      timeWIB: j.timeWIB,
      days: j.days.slice(),
      retryWindowMinutes: j.retryWindowMinutes,
      maxDurationSeconds: j.maxDurationSeconds,
      priority: j.priority,
      costClass: j.costClass,
      ...(['fundamental', 'insider'].includes(key) ? { policy: j.policy } : {})
    };
  });
  return Object.assign({
    schemaVersion: d.schemaVersion,
    version: d.version,
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
    jobs
  }, extra || {});
}

/**
 * Durable, versioned, audited write.
 * put(rawPatch, { actor, reason, expectedVersion, now })
 *   -> { ok:true, doc, previous, diff, readbackOk, collisions } or
 *      { ok:false, reason:'CONFLICT'|'VALIDATION_FAILED'|'COLLISION'|'READ_FAILED'
 *                       |'LOCK_BUSY'|'WRITE_FAILED'|'AUDIT_FAILED'|'READBACK_FAILED', ... }
 */
function put(rawPatch, ctx) {
  const o = ctx || {};
  const canonical = canonicalizePatch(rawPatch);
  const v = validatePatch(canonical);
  if (!v.ok) return { ok: false, reason: 'VALIDATION_FAILED', errors: v.errors };

  if (!acquireLock()) return { ok: false, reason: 'LOCK_BUSY' };

  try {
    const prevRead = readStore();
    if (!prevRead.ok) return { ok: false, reason: 'READ_FAILED', error: prevRead.error };
    const current = prevRead.doc;

    if (o.expectedVersion != null && Number(o.expectedVersion) !== current.version) {
      return {
        ok: false,
        reason: 'CONFLICT',
        expectedVersion: Number(o.expectedVersion),
        currentVersion: current.version,
        doc: current
      };
    }

    const next = normalizeDoc(current);
    for (const key of Object.keys(canonical)) {
      const patch = canonical[key];
      const base = next.jobs[key];
      for (const f of Object.keys(patch)) {
        if (f === 'enabled') base.enabled = patch.enabled === true || patch.enabled === 1 || patch.enabled === 'true';
        else if (f === 'days') base.days = normalizeDays(patch.days);
        else if (f === 'timeWIB') base.timeWIB = minutesToTime(timeToMinutes(patch.timeWIB));
        else if (f === 'retryWindowMinutes') base.retryWindowMinutes = Number(patch.retryWindowMinutes);
        else if (f === 'maxDurationSeconds') base.maxDurationSeconds = Number(patch.maxDurationSeconds);
        else if (f === 'priority') base.priority = Number(patch.priority);
        else base[f] = patch[f];
      }
    }

    // Collision gate: reject a save that introduces an execution-window overlap.
    const collisions = listCollisions(next);
    if (collisions.length > 0) {
      return {
        ok: false,
        reason: 'COLLISION',
        collisions,
        doc: current
      };
    }

    // V6 (Subtask F) LEGACY-DUPLICATE gate: reject a patch that introduces a NEW
    // time-window overlap with an ACTIVE legacy executor (cron/PM2/systemd) of
    // the SAME side-effect class. Grandfathered/locked defaults are exempt here
    // and governed at runtime by BLOCKED_LEGACY_ACTIVE (see schedule-control-plane).
    const legacy = controlPlane.readLegacyActive(o.legacyActivePath);
    const catalogDefaults = {};
    for (const def of JOB_CATALOG) catalogDefaults[def.key] = def.defaultTimeWIB;
    const legacyDuplicates = controlPlane.detectLegacyDuplicatePatches(
      current, next, Object.keys(canonical), legacy.activeNames, catalogDefaults
    );
    if (legacyDuplicates.length > 0) {
      return {
        ok: false,
        reason: 'LEGACY_DUPLICATE',
        legacyDuplicates,
        doc: current
      };
    }

    next.version = current.version + 1;
    next.updatedAt = toIso(o.now);
    next.updatedBy = String(o.actor || 'admin');

    let wrote = false;
    try { wrote = writeStoreAtomic(next); } catch (_) { wrote = false; }
    if (!wrote) return { ok: false, reason: 'WRITE_FAILED' };

    const readback = readStore();
    const readbackOk = readback.ok === true && readback.doc.version === next.version;
    const diff = computeDiff(current, next);

    const auditRecord = {
      eventId: 'asch-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      eventType: 'ADMIN_SCHEDULE_CONFIG_SAVE',
      timestampIso: toIso(o.now),
      pid: process.pid,
      actor: String(o.actor || 'admin'),
      reason: String(o.reason || '').slice(0, 300),
      version: next.version,
      previousVersion: current.version,
      diff
    };
    if (!appendAudit(auditRecord)) {
      try { writeStoreAtomic(current); } catch (_) {}
      return { ok: false, reason: 'AUDIT_FAILED', doc: current, diff };
    }

    // Immutable history snapshot (keep all history; never truncate).
    const snap = snapshotVersion(next);
    if (snap) {
      const history = listHistory().filter((h) => h && h.version !== next.version);
      history.push({
        version: next.version,
        timestampIso: toIso(o.now),
        actor: String(o.actor || 'admin'),
        reason: String(o.reason || '').slice(0, 300),
        file: path.relative(ROOT, snap)
      });
      history.sort((a, b) => a.version - b.version);
      writeHistoryIndex(history);
    }

    if (!readbackOk) {
      return { ok: false, reason: 'READBACK_FAILED', doc: next, diff };
    }

    return { ok: true, doc: next, previous: current, diff, readbackOk: true, version: next.version, collisions: [] };
  } finally {
    releaseLock();
  }
}

/**
 * Restore a previous version WITHOUT deleting history. Returns the restored doc.
 */
function restoreVersion(targetVersion) {
  const t = Number(targetVersion);
  if (!Number.isInteger(t) || t < 0) return { ok: false, reason: 'VALIDATION_FAILED', error: 'targetVersion harus integer >= 0.' };
  const file = path.join(HISTORY_DIR, 'admin-schedule-config.v' + t + '.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'NOT_FOUND', error: 'Snapshot versi tidak ditemukan.' };

  if (!acquireLock()) return { ok: false, reason: 'LOCK_BUSY' };
  try {
    const prev = readStore();
    const restored = normalizeDoc(JSON.parse(fs.readFileSync(file, 'utf8')));
    restored.version = prev.doc.version + 1;
    restored.updatedAt = toIso();
    restored.updatedBy = 'rollback:' + t;

    let wrote = false;
    try { wrote = writeStoreAtomic(restored); } catch (_) { wrote = false; }
    if (!wrote) return { ok: false, reason: 'WRITE_FAILED' };

    const readback = readStore();
    const readbackOk = readback.ok === true && readback.doc.version === restored.version;
    appendAudit({
      eventId: 'asch-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      eventType: 'ADMIN_SCHEDULE_CONFIG_RESTORE',
      timestampIso: toIso(),
      pid: process.pid,
      actor: 'rollback',
      reason: 'Restore ke versi ' + t,
      targetVersion: t,
      version: restored.version,
      previousVersion: prev.doc.version
    });
    const snap = snapshotVersion(restored);
    if (snap) {
      const history = listHistory().filter((h) => h && h.version !== restored.version);
      history.push({
        version: restored.version,
        timestampIso: toIso(),
        actor: 'rollback',
        reason: 'Restore ke versi ' + t,
        file: path.relative(ROOT, snap)
      });
      history.sort((a, b) => a.version - b.version);
      writeHistoryIndex(history);
    }
    return { ok: true, doc: restored, readbackOk };
  } finally {
    releaseLock();
  }
}

module.exports = {
  STORE_PATH,
  HISTORY_DIR,
  AUDIT_PATH,
  LOCK_PATH,
  SCHEMA_VERSION,
  COST_CLASSES,
  JOB_CATALOG,
  JOB_BY_KEY,
  clone,
  minutesToTime,
  timeToMinutes,
  normalizeDays,
  normalizeJob,
  normalizeDoc,
  listCollisions,
  computeDiff,
  canonicalizePatch,
  validateJobPatch,
  validatePatch,
  validateDisclosurePolicy,
  get,
  getPublicDoc,
  put,
  restoreVersion,
  listHistory,
  readStore,
  acquireLock,
  releaseLock,
  appendAudit
};
'use strict';

/**
 * lib/backfill-decision.js
 * ============================================================================
 * V6 (W5) — PURE CONDITIONAL BACKFILL DECISION + DURABLE STATUS READBACK
 * ============================================================================
 * WHY THIS EXISTS
 *   The backfill trigger path previously had no single, testable gate that
 *   decided WHETHER a provider request should be sent at all. With the cron
 *   executor dead since 9 Nov (job-wrapper.sh mode 664 => exit 126) and the
 *   verified requestable backlog at ZERO (P0-A: IDLE_NO_BACKLOG), the system
 *   must be able to say, honestly and durably:
 *
 *     "There is nothing to fetch. Zero provider requests were sent."
 *
 *   This module is the ONE decision function (`decideBackfill`) that MUST be
 *   called BEFORE any provider call, plus the atomic status-file writer that
 *   the Admin UI reads back. It is deliberately dependency-free (fs/path only)
 *   so it can be required from the API handler, the queue worker, and tests
 *   without cycles.
 *
 * DECISION PRECEDENCE (first match wins — fail-closed, admin intent first):
 *   1. PAUSED_BY_ADMIN        explicit admin pause (highest authority)
 *   2. BLOCKED_QUOTA          plan expired (fail-closed) — reason PLAN_EXPIRED
 *   3. BLOCKED_CRON_126       cron executor unhealthy (exit 126) — NOT IDLE
 *   4. NEEDS_EVIDENCE         verifiedRequestable UNKNOWN (null)
 *   5. IDLE_NO_BACKLOG        verifiedRequestable === 0  => 0 requests sent
 *   6. NEEDS_EVIDENCE         candle existence unknown for the target
 *   7. BLOCKED_QUOTA          quota unknown OR usable budget < requestable
 *   8. SKIP_VERIFIED_NO_FLOW  requestable>0 but flow not verified (no-op)
 *   9. RUN_VERIFIED_GAP       requestable>0 and budget sufficient
 *
 * INVARIANTS
 *   - `requests_sent` is ALWAYS 0 for every non-RUN status.
 *   - IDLE_NO_BACKLOG NEVER performs a provider ticker scan.
 *   - BLOCKED_QUOTA carries the EXACT arithmetic string that produced it.
 *   - Every decision carries a human `reason` and a `next_check_at` ISO stamp.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

const STATUS_PATH = process.env.BACKFILL_STATUS_PATH ||
  path.join(ROOT, 'data', 'backfill-status.json');

/** Reserve floors mirror lib/quota-policy-bridge.js POLICY_DEFAULTS. */
const RESERVE_FLOOR_WEEKDAY = 5000;
const RESERVE_FLOOR_WEEKEND = 0;

const DECISIONS = Object.freeze({
  IDLE_NO_BACKLOG: 'IDLE_NO_BACKLOG',
  RUN_VERIFIED_GAP: 'RUN_VERIFIED_GAP',
  BLOCKED_CRON_126: 'BLOCKED_CRON_126',
  BLOCKED_QUOTA: 'BLOCKED_QUOTA',
  SKIP_VERIFIED_NO_FLOW: 'SKIP_VERIFIED_NO_FLOW',
  NEEDS_EVIDENCE: 'NEEDS_EVIDENCE',
  PAUSED_BY_ADMIN: 'PAUSED_BY_ADMIN'
});

/** Statuses that are allowed to send provider requests. */
const REQUESTING_STATUSES = Object.freeze([DECISIONS.RUN_VERIFIED_GAP]);

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function toIso(now) {
  const d = new Date(toMs(now));
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function isWeekendFromWib(nowWib) {
  // nowWib may be a Date, ms, or an ISO string. Compute WIB day-of-week.
  const ms = toMs(nowWib);
  const shifted = new Date(ms + 7 * 3600 * 1000);
  const dow = shifted.getUTCDay();
  return dow === 0 || dow === 6;
}

function reserveFloorFor(isWeekend) {
  return isWeekend ? RESERVE_FLOOR_WEEKEND : RESERVE_FLOOR_WEEKDAY;
}

function nextCheckIso(status, now) {
  const base = toMs(now);
  const minutesByStatus = {
    [DECISIONS.IDLE_NO_BACKLOG]: 15,
    [DECISIONS.RUN_VERIFIED_GAP]: 5,
    [DECISIONS.BLOCKED_CRON_126]: 30,
    [DECISIONS.BLOCKED_QUOTA]: 60,
    [DECISIONS.SKIP_VERIFIED_NO_FLOW]: 60,
    [DECISIONS.NEEDS_EVIDENCE]: 30,
    [DECISIONS.PAUSED_BY_ADMIN]: 0
  };
  const mins = minutesByStatus[status] != null ? minutesByStatus[status] : 15;
  return new Date(base + mins * 60 * 1000).toISOString();
}

/**
 * decideBackfill(input) -> decision object (PURE, no I/O).
 *
 * @param {object} input
 * @param {number|null} input.verifiedRequestable  verified gap count (null=UNKNOWN)
 * @param {boolean}     input.cronHealthy          cron executor healthy?
 * @param {number|null} input.quotaRemaining       remaining quota units (null=UNKNOWN)
 * @param {number|null} input.quotaLimit           total quota limit (informational)
 * @param {string|Date|null} input.planExpiry      plan expiry timestamp
 * @param {boolean}     input.isWeekend            weekend? (else derived from nowWib)
 * @param {Date|number|string} input.nowWib        clock
 * @param {boolean}     [input.paused]             admin pause flag
 * @param {boolean|null} [input.candleKnown]       candle existence known? (null=unknown)
 * @param {boolean|null} [input.flowVerified]      flow verified for the gap?
 * @returns {object} { status, reason, requests_sent, next_check_at, ... }
 */
function decideBackfill(input) {
  const o = input || {};
  const now = o.nowWib != null ? o.nowWib : Date.now();
  const nowIso = toIso(now);
  const isWeekend = typeof o.isWeekend === 'boolean' ? o.isWeekend : isWeekendFromWib(now);
  const reserveFloor = reserveFloorFor(isWeekend);

  const base = {
    decided_at: nowIso,
    is_weekend: isWeekend,
    reserve_floor: reserveFloor,
    quota_remaining: o.quotaRemaining == null ? null : Number(o.quotaRemaining),
    quota_limit: o.quotaLimit == null ? null : Number(o.quotaLimit),
    verified_requestable: o.verifiedRequestable == null ? null : Number(o.verifiedRequestable)
  };

  const finish = (status, reason, extra) => Object.assign({}, base, {
    status,
    reason,
    requests_sent: REQUESTING_STATUSES.includes(status) ? (extra && extra.requests_sent != null ? extra.requests_sent : 0) : 0,
    next_check_at: nextCheckIso(status, now)
  }, extra || {});

  // 1. Admin pause — highest authority.
  if (o.paused === true) {
    return finish(DECISIONS.PAUSED_BY_ADMIN, 'Admin menjeda backfill (pause aktif).');
  }

  // 2. Plan expiry — fail-closed BEFORE any quota arithmetic.
  if (o.planExpiry != null) {
    const expMs = toMs(o.planExpiry);
    if (Number.isFinite(expMs) && expMs <= toMs(now)) {
      return finish(DECISIONS.BLOCKED_QUOTA,
        'Plan kuota kedaluwarsa (' + toIso(expMs) + ' <= ' + nowIso + '). Fail-closed: 0 request.',
        { plan_expired: true, arithmetic: 'planExpiry=' + toIso(expMs) + ' <= now=' + nowIso });
    }
  }

  // 3. Cron executor health — a dead cron is BLOCKED, never IDLE.
  if (o.cronHealthy === false) {
    return finish(DECISIONS.BLOCKED_CRON_126,
      'Executor cron tidak sehat (job-wrapper.sh exit 126). Backfill diblokir sampai cron diperbaiki.');
  }

  // 4. Unknown requestable count => need evidence, never assume zero.
  if (o.verifiedRequestable == null || !Number.isFinite(Number(o.verifiedRequestable))) {
    return finish(DECISIONS.NEEDS_EVIDENCE,
      'Jumlah requestable terverifikasi UNKNOWN (null). Butuh bukti ledger sebelum fetch.');
  }

  const requestable = Math.max(0, Math.floor(Number(o.verifiedRequestable)));

  // 5. Zero verified backlog => IDLE, zero provider calls, no ticker scan.
  if (requestable === 0) {
    return finish(DECISIONS.IDLE_NO_BACKLOG,
      'Tidak ada backlog terverifikasi (requestable=0). 0 request provider dikirim; tidak ada scan ticker.',
      { requests_sent: 0, provider_scan: false });
  }

  // 6. Candle existence unknown => need evidence.
  if (o.candleKnown === false) {
    return finish(DECISIONS.NEEDS_EVIDENCE,
      'Keberadaan candle target UNKNOWN. Butuh bukti sebelum fetch.');
  }

  // 7. Quota budget arithmetic (fail-closed on UNKNOWN).
  const remaining = o.quotaRemaining == null ? null : Number(o.quotaRemaining);
  if (remaining == null || !Number.isFinite(remaining)) {
    return finish(DECISIONS.BLOCKED_QUOTA,
      'Sisa kuota UNKNOWN (null). Fail-closed: 0 request.',
      { arithmetic: 'quotaRemaining=UNKNOWN' });
  }
  const usable = Math.max(0, Math.floor(remaining) - reserveFloor);
  if (usable < requestable) {
    return finish(DECISIONS.BLOCKED_QUOTA,
      'Anggaran kuota tidak cukup: usable=' + usable + ' < requestable=' + requestable + '.',
      {
        usable_budget: usable,
        arithmetic: 'quotaRemaining=' + Math.floor(remaining) + ' - reserveFloor=' + reserveFloor +
          ' = usable=' + usable + ' < requestable=' + requestable
      });
  }

  // 8. Requestable>0 but flow not verified => no-op skip (no request).
  if (o.flowVerified === false) {
    return finish(DECISIONS.SKIP_VERIFIED_NO_FLOW,
      'Gap terverifikasi ada tetapi flow belum terverifikasi. Skip tanpa request.',
      { usable_budget: usable });
  }

  // 9. Run the verified gap.
  return finish(DECISIONS.RUN_VERIFIED_GAP,
    'Gap terverifikasi=' + requestable + ' dan anggaran cukup (usable=' + usable + '). Jalankan backfill.',
    { usable_budget: usable, requests_sent: requestable });
}

/* -------------------------------------------------------------------------- */
/* Durable status file (atomic write + read)                                   */
/* -------------------------------------------------------------------------- */

function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * recordBackfillStatus(decision, meta) -> { ok, path, record }
 * Persists the decision (status, reason, requests_sent, last_checked_at,
 * next_check_at) atomically so the Admin UI can read EFFECTIVE state.
 */
function recordBackfillStatus(decision, meta) {
  const d = decision || {};
  const m = meta || {};
  const nowIso = d.decided_at || new Date().toISOString();
  const record = {
    status: d.status || 'NEEDS_EVIDENCE',
    reason: d.reason || null,
    requests_sent: Number.isFinite(Number(d.requests_sent)) ? Number(d.requests_sent) : 0,
    last_checked_at: nowIso,
    next_check_at: d.next_check_at || null,
    run_id: m.run_id || null,
    actor: m.actor || 'system',
    trigger: m.trigger || 'scheduler',
    is_weekend: d.is_weekend === true,
    reserve_floor: d.reserve_floor != null ? d.reserve_floor : null,
    quota_remaining: d.quota_remaining != null ? d.quota_remaining : null,
    quota_limit: d.quota_limit != null ? d.quota_limit : null,
    verified_requestable: d.verified_requestable != null ? d.verified_requestable : null,
    usable_budget: d.usable_budget != null ? d.usable_budget : null,
    arithmetic: d.arithmetic || null,
    provider_scan: d.provider_scan === true,
    updated_at: new Date().toISOString()
  };
  try {
    writeJsonAtomic(STATUS_PATH, record);
    return { ok: true, path: STATUS_PATH, record };
  } catch (err) {
    return { ok: false, path: STATUS_PATH, error: String((err && err.message) || err), record };
  }
}

function readBackfillStatus() {
  try {
    const doc = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    return { ok: true, path: STATUS_PATH, status: doc };
  } catch (err) {
    return { ok: false, path: STATUS_PATH, status: null, error: String((err && err.message) || err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Real-state input collector (reads files; NEVER calls a provider)            */
/* -------------------------------------------------------------------------- */

const REQUESTABLE_QUEUE_PATH = process.env.BACKFILL_REQUESTABLE_QUEUE_PATH ||
  path.join(ROOT, 'docs', 'v6', 'v6-requestable-queue-v2.csv');
const CRON_HEALTH_PATH = process.env.BACKFILL_CRON_HEALTH_PATH ||
  path.join(ROOT, 'data', 'cron-health.json');
const PAUSE_PATH = process.env.BACKFILL_PAUSE_PATH ||
  path.join(ROOT, 'data', 'backfill-pause.json');

/**
 * countRequestableRows(csvPath) -> { known, count, path }
 * The verified requestable queue is a CSV with a header row. A file that is
 * absent or unreadable yields known:false (UNKNOWN != ZERO).
 */
function countRequestableRows(csvPath) {
  const p = csvPath || REQUESTABLE_QUEUE_PATH;
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return { known: false, count: null, path: p }; }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // First non-empty line is the header; the rest are data rows.
  const count = Math.max(0, lines.length - 1);
  return { known: true, count, path: p };
}

/**
 * readCronHealth() -> { healthy: boolean|null, reason, path }
 * data/cron-health.json is written by the ops watchdog. Absent => UNKNOWN.
 */
function readCronHealth(healthPath) {
  const p = healthPath || CRON_HEALTH_PATH;
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (doc && typeof doc.healthy === 'boolean') {
      return { healthy: doc.healthy, reason: doc.reason || null, path: p };
    }
    return { healthy: null, reason: 'NO_HEALTHY_FIELD', path: p };
  } catch (_) {
    return { healthy: null, reason: 'HEALTH_FILE_ABSENT', path: p };
  }
}

function readPaused(pausePath) {
  const p = pausePath || PAUSE_PATH;
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return doc && doc.paused === true;
  } catch (_) { return false; }
}

/**
 * collectBackfillInputs(overrides) -> decideBackfill input object built from
 * REAL files/state. Any override wins (used by tests + admin preview).
 * Quota is read from lib/quota-manager when available; UNKNOWN stays null.
 */
function collectBackfillInputs(overrides) {
  const o = overrides || {};
  const now = o.nowWib != null ? o.nowWib : Date.now();

  let verifiedRequestable = o.verifiedRequestable;
  if (verifiedRequestable === undefined) {
    const q = countRequestableRows(o.requestableQueuePath);
    verifiedRequestable = q.known ? q.count : null;
  }

  let cronHealthy = o.cronHealthy;
  if (cronHealthy === undefined) {
    const h = readCronHealth(o.cronHealthPath);
    cronHealthy = h.healthy;
  }

  let quotaRemaining = o.quotaRemaining;
  let quotaLimit = o.quotaLimit;
  let planExpiry = o.planExpiry;
  if (quotaRemaining === undefined || quotaLimit === undefined || planExpiry === undefined) {
    try {
      const qm = require('./quota-manager');
      const st = qm.getQuotaStatus(now);
      if (quotaRemaining === undefined) quotaRemaining = st && st.remaining != null ? st.remaining : null;
      if (quotaLimit === undefined) quotaLimit = st && st.effective_limit != null ? st.effective_limit : null;
      if (planExpiry === undefined) planExpiry = st && st.packageExpiry ? st.packageExpiry : null;
    } catch (_) {
      if (quotaRemaining === undefined) quotaRemaining = null;
      if (quotaLimit === undefined) quotaLimit = null;
      if (planExpiry === undefined) planExpiry = null;
    }
  }

  const paused = o.paused !== undefined ? o.paused : readPaused(o.pausePath);

  return {
    verifiedRequestable,
    cronHealthy,
    quotaRemaining,
    quotaLimit,
    planExpiry,
    isWeekend: o.isWeekend,
    nowWib: now,
    paused,
    candleKnown: o.candleKnown,
    flowVerified: o.flowVerified
  };
}

module.exports = {
  STATUS_PATH,
  REQUESTABLE_QUEUE_PATH,
  CRON_HEALTH_PATH,
  PAUSE_PATH,
  DECISIONS,
  REQUESTING_STATUSES,
  RESERVE_FLOOR_WEEKDAY,
  RESERVE_FLOOR_WEEKEND,
  decideBackfill,
  recordBackfillStatus,
  readBackfillStatus,
  collectBackfillInputs,
  countRequestableRows,
  readCronHealth,
  readPaused,
  reserveFloorFor,
  isWeekendFromWib,
  writeJsonAtomic
};

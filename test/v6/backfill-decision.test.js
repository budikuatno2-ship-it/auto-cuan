'use strict';

/**
 * test/v6/backfill-decision.test.js
 * ============================================================================
 * V6 (W5) — CONDITIONAL BACKFILL DECISION + ADMIN EFFECTIVE READBACK
 * ============================================================================
 * Proves the pure decision function and the durable status/readback contract:
 *   (a) requestable=0            -> IDLE_NO_BACKLOG + 0 requests
 *   (b) requestable>0 + healthy  -> RUN_VERIFIED_GAP
 *   (c) cron unhealthy           -> BLOCKED_CRON_126 (NOT IDLE)
 *   (d) quota insufficient       -> BLOCKED_QUOTA with exact arithmetic
 *   (e) weekend floor 0 vs weekday floor 5000
 *   (f) plan expiry              -> fail-closed
 *   (g) unknown candle           -> NEEDS_EVIDENCE
 *   (h) paused                   -> PAUSED_BY_ADMIN
 *   (i) status file written atomically
 *   (j) admin status endpoint returns effective-vs-desired, never claims
 *       success without evidence
 *
 * NO provider calls, NO production writes (all paths redirected to tmpdir).
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-bfdec-')); }

function loadDecision(tmp) {
  const prev = process.env.BACKFILL_STATUS_PATH;
  process.env.BACKFILL_STATUS_PATH = path.join(tmp, 'backfill-status.json');
  const p = path.join(ROOT, 'lib', 'backfill-decision.js');
  delete require.cache[require.resolve(p)];
  const mod = require(p);
  return {
    mod,
    restore: () => {
      if (prev === undefined) delete process.env.BACKFILL_STATUS_PATH;
      else process.env.BACKFILL_STATUS_PATH = prev;
    }
  };
}

const D = {
  IDLE: 'IDLE_NO_BACKLOG',
  RUN: 'RUN_VERIFIED_GAP',
  CRON: 'BLOCKED_CRON_126',
  QUOTA: 'BLOCKED_QUOTA',
  SKIP: 'SKIP_VERIFIED_NO_FLOW',
  EVID: 'NEEDS_EVIDENCE',
  PAUSED: 'PAUSED_BY_ADMIN'
};

/* (a) requestable=0 -> IDLE_NO_BACKLOG + 0 requests, no provider scan */
test('(a) requestable=0 -> IDLE_NO_BACKLOG with 0 requests and no provider scan', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 0, cronHealthy: true, quotaRemaining: 10000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    assert.equal(d.status, D.IDLE);
    assert.equal(d.requests_sent, 0);
    assert.equal(d.provider_scan, false);
    assert.ok(d.reason && d.reason.length > 0);
    assert.ok(d.next_check_at);
  } finally { restore(); }
});

/* (b) requestable>0 + healthy -> RUN_VERIFIED_GAP */
test('(b) requestable>0 + healthy cron + budget -> RUN_VERIFIED_GAP', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 12, cronHealthy: true, quotaRemaining: 12000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    assert.equal(d.status, D.RUN);
    assert.equal(d.requests_sent, 12);
    assert.equal(d.usable_budget, 7000); // 12000 - 5000 weekday floor
  } finally { restore(); }
});

/* (c) cron unhealthy -> BLOCKED_CRON_126 (NOT IDLE) */
test('(c) cron unhealthy -> BLOCKED_CRON_126, never IDLE', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 0, cronHealthy: false, quotaRemaining: 10000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    assert.equal(d.status, D.CRON);
    assert.notEqual(d.status, D.IDLE);
    assert.equal(d.requests_sent, 0);
    assert.match(d.reason, /126/);
  } finally { restore(); }
});

/* (d) quota insufficient -> BLOCKED_QUOTA with exact arithmetic */
test('(d) quota insufficient -> BLOCKED_QUOTA with exact arithmetic string', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 5000, cronHealthy: true, quotaRemaining: 6000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    assert.equal(d.status, D.QUOTA);
    assert.equal(d.requests_sent, 0);
    assert.equal(d.usable_budget, 1000); // 6000 - 5000
    assert.match(d.arithmetic, /quotaRemaining=6000 - reserveFloor=5000 = usable=1000 < requestable=5000/);
  } finally { restore(); }
});

/* (e) weekend floor 0 vs weekday floor 5000 */
test('(e) weekend reserve floor 0 vs weekday reserve floor 5000', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    // Saturday 2026-11-14 is a weekend in WIB.
    const weekend = mod.decideBackfill({
      verifiedRequestable: 5000, cronHealthy: true, quotaRemaining: 6000, quotaLimit: 18080,
      planExpiry: null, isWeekend: true, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    assert.equal(weekend.reserve_floor, 0);
    assert.equal(weekend.status, D.RUN, 'weekend: usable=6000 >= 5000');
    assert.equal(weekend.usable_budget, 6000);

    // Monday 2026-11-16 is a weekday in WIB.
    const weekday = mod.decideBackfill({
      verifiedRequestable: 5000, cronHealthy: true, quotaRemaining: 6000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-16T13:00:00Z')
    });
    assert.equal(weekday.reserve_floor, 5000);
    assert.equal(weekday.status, D.QUOTA, 'weekday: usable=1000 < 5000');
  } finally { restore(); }
});

/* (f) plan expiry -> fail-closed */
test('(f) plan expiry -> BLOCKED_QUOTA fail-closed before any request', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 10, cronHealthy: true, quotaRemaining: 15000, quotaLimit: 18080,
      planExpiry: '2026-11-01T00:00:00Z', isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    assert.equal(d.status, D.QUOTA);
    assert.equal(d.plan_expired, true);
    assert.equal(d.requests_sent, 0);
  } finally { restore(); }
});

/* (g) unknown candle -> NEEDS_EVIDENCE */
test('(g) unknown candle existence -> NEEDS_EVIDENCE', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 5, cronHealthy: true, quotaRemaining: 15000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z'),
      candleKnown: false
    });
    assert.equal(d.status, D.EVID);
    assert.equal(d.requests_sent, 0);
  } finally { restore(); }
});

/* (h) paused -> PAUSED_BY_ADMIN */
test('(h) admin pause -> PAUSED_BY_ADMIN (highest precedence)', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 100, cronHealthy: true, quotaRemaining: 15000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z'),
      paused: true
    });
    assert.equal(d.status, D.PAUSED);
    assert.equal(d.requests_sent, 0);
  } finally { restore(); }
});

/* (i) status file written atomically */
test('(i) recordBackfillStatus writes data/backfill-status.json atomically', () => {
  const tmp = tmpdir();
  const { mod, restore } = loadDecision(tmp);
  try {
    const d = mod.decideBackfill({
      verifiedRequestable: 0, cronHealthy: true, quotaRemaining: 10000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    const rec = mod.recordBackfillStatus(d, { actor: 'budi', trigger: 'test' });
    assert.equal(rec.ok, true);
    assert.ok(fs.existsSync(mod.STATUS_PATH), 'status file exists');
    const onDisk = JSON.parse(fs.readFileSync(mod.STATUS_PATH, 'utf8'));
    assert.equal(onDisk.status, D.IDLE);
    assert.equal(onDisk.requests_sent, 0);
    assert.ok(onDisk.last_checked_at);
    assert.ok(onDisk.next_check_at);
    // No leftover .tmp files (atomic rename).
    const leftovers = fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, 'no temp files left behind');
    // Readback round-trips.
    const read = mod.readBackfillStatus();
    assert.equal(read.ok, true);
    assert.equal(read.status.status, D.IDLE);
  } finally { restore(); }
});

/* (j) admin status endpoint: effective-vs-desired, never claims success w/o evidence */
test('(j) admin scheduler-status returns effective-vs-desired and honest readback_ok', async () => {
  const tmp = tmpdir();
  const prevStatus = process.env.BACKFILL_STATUS_PATH;
  const prevStore = process.env.ADMIN_SCHEDULE_CONFIG_PATH;
  const prevHist = process.env.ADMIN_SCHEDULE_HISTORY_PATH;
  const prevAudit = process.env.ADMIN_SCHEDULE_AUDIT_PATH;
  const prevQueue = process.env.BACKFILL_REQUESTABLE_QUEUE_PATH;
  process.env.BACKFILL_STATUS_PATH = path.join(tmp, 'backfill-status.json');
  process.env.ADMIN_SCHEDULE_CONFIG_PATH = path.join(tmp, 'admin-schedule-config.json');
  process.env.ADMIN_SCHEDULE_HISTORY_PATH = path.join(tmp, 'history');
  process.env.ADMIN_SCHEDULE_AUDIT_PATH = path.join(tmp, 'audit.jsonl');
  process.env.BACKFILL_REQUESTABLE_QUEUE_PATH = path.join(tmp, 'queue.csv');

  // Empty queue CSV (header only) => verified_count 0.
  fs.writeFileSync(process.env.BACKFILL_REQUESTABLE_QUEUE_PATH, 'rank,ticker,trade_date,dataset,candle_volume,est_requests\n');

  // Force a fresh backfill-decision module bound to THIS tmp status path so a
  // previously-cached module (from an earlier test) cannot leak a stale file.
  const decPath = path.join(ROOT, 'lib', 'backfill-decision.js');
  delete require.cache[require.resolve(decPath)];
  const statusPath = path.join(ROOT, 'api', 'admin', 'scheduler-status.js');
  delete require.cache[require.resolve(statusPath)];
  const ep = require(statusPath);

  try {
    // Case 1: NO status file => readback_ok false, status UNKNOWN (no fake success).
    const noEvidence = ep.buildStatus(new Date('2026-11-14T13:00:00Z'));
    assert.equal(noEvidence.readback_ok, false, 'no status file => readback_ok false');
    assert.equal(noEvidence.backfill.status, 'UNKNOWN');
    assert.equal(noEvidence.backfill.last_status, 'UNKNOWN');
    assert.equal(noEvidence.queue.verified_count, 0);

    // Case 2: write a real IDLE decision => readback_ok true, last_status IDLE.
    const dec = require(path.join(ROOT, 'lib', 'backfill-decision.js'));
    const d = dec.decideBackfill({
      verifiedRequestable: 0, cronHealthy: true, quotaRemaining: 10000, quotaLimit: 18080,
      planExpiry: null, isWeekend: false, nowWib: new Date('2026-11-14T13:00:00Z')
    });
    dec.recordBackfillStatus(d, { actor: 'budi', trigger: 'test' });

    const withEvidence = ep.buildStatus(new Date('2026-11-14T13:00:00Z'));
    assert.equal(withEvidence.readback_ok, true);
    assert.equal(withEvidence.backfill.status, D.IDLE);
    assert.equal(withEvidence.backfill.last_status, 'IDLE');
    assert.equal(withEvidence.backfill.requests_sent, 0);
    // Effective-vs-desired structure present.
    assert.ok(withEvidence.desired && Array.isArray(withEvidence.desired.jobs));
    assert.ok(withEvidence.effective && Array.isArray(withEvidence.effective.jobs));
    assert.ok(withEvidence.executor && 'owner' in withEvidence.executor);
    assert.ok(withEvidence.saved_original && withEvidence.saved_original.store_path);
  } finally {
    if (prevStatus === undefined) delete process.env.BACKFILL_STATUS_PATH; else process.env.BACKFILL_STATUS_PATH = prevStatus;
    if (prevStore === undefined) delete process.env.ADMIN_SCHEDULE_CONFIG_PATH; else process.env.ADMIN_SCHEDULE_CONFIG_PATH = prevStore;
    if (prevHist === undefined) delete process.env.ADMIN_SCHEDULE_HISTORY_PATH; else process.env.ADMIN_SCHEDULE_HISTORY_PATH = prevHist;
    if (prevAudit === undefined) delete process.env.ADMIN_SCHEDULE_AUDIT_PATH; else process.env.ADMIN_SCHEDULE_AUDIT_PATH = prevAudit;
    if (prevQueue === undefined) delete process.env.BACKFILL_REQUESTABLE_QUEUE_PATH; else process.env.BACKFILL_REQUESTABLE_QUEUE_PATH = prevQueue;
  }
});

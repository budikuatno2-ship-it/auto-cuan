'use strict';
/**
 * test/v5/quota-f1-p0.test.js
 * ============================================================================
 * SUBTASK F1 — Final Closure P0 quota-safety remediation tests.
 *
 * These tests use SANDBOX FILESYSTEMS (real file IO), never mocks of the
 * helpers under test. They assert, against the real source of lib/quota-limit.js
 * and lib/quota-reservation.js, that:
 *
 *   P0-01  an admin override is an OPERATIONAL CAP, never a creator of provider
 *          capacity; a stale/absent provider truth fails closed even with an
 *          override present.
 *   P0-02  a CONSUMPTIVE reservation fails closed when the account-wide usage
 *          cannot be verified (usageKnown=false), and does NOT fall back to a
 *          local ledger to fabricate `remaining`.
 *
 * No network, no Stock Arjum quota consumption, no Telegram.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true, error: null }); }
  catch (err) { results.push({ name, ok: false, error: err }); }
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

const NOW = new Date('2026-11-05T08:00:00Z');          // Thu 15:00 WIB weekday
const NOW_MS = NOW.getTime();
const LATER = new Date(NOW_MS + 20 * 60 * 1000);        // +20 min (past 10-min TTL)
const WIB_KEY = '2026-11-05';

/* -------------------------------------------------------------------------- */
/* Sandbox builder — quota-limit.js authority                                  */
/* -------------------------------------------------------------------------- */
function makeAuthoritySandbox(seedBlob) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f1-lim-'));
  const libDir = path.join(sandbox, 'lib');
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'quota-limit.js'),
    fs.readFileSync(require.resolve('../../lib/quota-limit.js'), 'utf8'));
  if (seedBlob != null) fs.writeFileSync(path.join(dataDir, 'quota-limit.json'), JSON.stringify(seedBlob));
  const A = require(path.join(libDir, 'quota-limit.js'));
  return { A, sandbox, dataDir };
}

/* -------------------------------------------------------------------------- */
/* Sandbox builder — quota-reservation.js (persistent, with authority)         */
/* -------------------------------------------------------------------------- */
function makeReservationSandbox(opts) {
  const o = opts || {};
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f1-res-'));
  const libDir = path.join(sandbox, 'lib');
  const dataDir = path.join(sandbox, 'data');
  const configDir = path.join(sandbox, 'config');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'quota-reservation.js'),
    fs.readFileSync(require.resolve('../../lib/quota-reservation.js'), 'utf8'));
  fs.writeFileSync(path.join(libDir, 'quota-limit.js'),
    fs.readFileSync(require.resolve('../../lib/quota-limit.js'), 'utf8'));
  fs.writeFileSync(path.join(configDir, 'quota.json'), JSON.stringify(
    o.config || { maxQuota: null, reserveFloorWeekday: 0, reserveFloorWeekend: 0, planExpiresAt: null }));
  const blobPath = path.join(dataDir, 'quota-limit.json');
  if (o.blob != null) fs.writeFileSync(blobPath, JSON.stringify(o.blob));
  const statePath = path.join(dataDir, 'quota-state.json');
  if (o.state != null) fs.writeFileSync(statePath, JSON.stringify(o.state));
  const S = require(path.join(libDir, 'quota-reservation.js'));
  return { S, sandbox, blobPath, statePath, dataDir, configDir };
}

/* A fresh provider snapshot blob (limit + measured same-day usage). */
function freshBlob(limit, used, verifiedAtIso) {
  return {
    schemaVersion: 1,
    source: 'provider',
    providerLimit: limit,
    providerLimitSource: 'provider',
    providerLimitVerifiedAt: verifiedAtIso,
    providerPeriodUsed: used,
    providerPeriodUsedVerifiedAt: verifiedAtIso,
    providerPeriodUsedWibDate: WIB_KEY,
    planExpiresAt: '2026-11-17T23:59:59+07:00',
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: { limit: null, actor: null, reason: null, setAt: null },
    updatedAt: verifiedAtIso
  };
}

/* ========================================================================== */
/* P0-01 — override must never create provider capacity                        */
/* ========================================================================== */

test('P0-01 truth: provider 12752 / used 13084 / override 50000 -> remaining 0 (BLOCK consumptive), limit 12752', () => {
  const { A, sandbox } = makeAuthoritySandbox(
    Object.assign(freshBlob(12752, 13084, '2026-11-05T08:00:00Z'), {
      override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-05T07:00:00Z' }
    })
  );
  try {
    const t = A.resolveTruth({ now: NOW, state: { currentDateWIB: WIB_KEY, upstreamUsedToday: 13084 } });
    assert(t.ok === true, 'limit+usage known');
    assert(t.limit === 12752, 'override 50000 must NOT raise ceiling above provider 12752, got ' + t.limit);
    assert(t.used === 13084, 'used preserved, got ' + t.used);
    assert(t.remaining === 0, 'remaining is 0 (already over-usage), got ' + t.remaining);
    assert(t.remaining < 1, 'a consumptive request of 1 is BLOCKED');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('P0-01 truth: stale provider snapshot + override 50000 -> BLOCK (LIMIT_STALE, not capacity)', () => {
  const staleIso = new Date(NOW_MS - 27 * 60 * 60 * 1000).toISOString(); // > 26h old
  const { A, sandbox } = makeAuthoritySandbox(
    Object.assign(freshBlob(12752, 13084, staleIso), {
      override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-05T07:00:00Z' }
    })
  );
  try {
    const lim = A.resolveLimit({ now: NOW });
    assert(lim.ok === false && lim.source === 'stale' && lim.limit === null,
      'stale + override must fail closed, got ' + JSON.stringify(lim));
    const t = A.resolveTruth({ now: NOW, state: { currentDateWIB: WIB_KEY, upstreamUsedToday: 13084 } });
    assert(t.ok === false && t.remaining === null && t.limit === null,
      'resolveTruth must not report a usable limit, got ' + JSON.stringify(t));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('P0-01 truth: provider never measured + override 50000 -> BLOCK (LIMIT_UNKNOWN)', () => {
  const { A, sandbox } = makeAuthoritySandbox({
    source: 'unknown',
    override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-05T07:00:00Z' }
  });
  try {
    const lim = A.resolveLimit({ now: NOW });
    assert(lim.ok === false && lim.source === 'unknown' && lim.limit === null,
      'override without any provider measurement cannot create capacity, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('P0-01 positive: provider valid 12752 + override LOWER 10000 -> effective limit = 10000', () => {
  const { A, sandbox } = makeAuthoritySandbox(
    Object.assign(freshBlob(12752, 5000, '2026-11-05T08:00:00Z'), {
      override: { limit: 10000, actor: 'admin', reason: 'op cap', setAt: '2026-11-05T07:00:00Z' }
    })
  );
  try {
    const lim = A.resolveLimit({ now: NOW });
    assert(lim.ok === true && lim.limit === 10000 && lim.source === 'manual',
      'a LOWER override lawfully restricts capacity, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('P0-01 truth: provider valid, remaining zero (used == limit) -> BLOCK consumptive', () => {
  const { A, sandbox } = makeAuthoritySandbox(freshBlob(10000, 10000, '2026-11-05T08:00:00Z'));
  try {
    const t = A.resolveTruth({ now: NOW, state: { currentDateWIB: WIB_KEY, upstreamUsedToday: 10000 } });
    assert(t.ok === true && t.remaining === 0, 'known zero remaining, got ' + JSON.stringify(t));
    assert(t.remaining < 1, 'consumptive request of 1 is BLOCKED');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('P0-01 truth: provider valid, usage unknown -> BLOCK (USAGE_UNKNOWN)', () => {
  const { A, sandbox } = makeAuthoritySandbox(freshBlob(12752, null, '2026-11-05T08:00:00Z'));
  try {
    const t = A.resolveTruth({ now: NOW, state: { currentDateWIB: WIB_KEY } }); // no upstream witness
    assert(t.ok === false && t.usageKnown === false && t.remaining === null,
      'valid limit but unknown usage must fail closed, got ' + JSON.stringify(t));
    assert(t.reason === 'USAGE_UNKNOWN', 'reason USAGE_UNKNOWN, got ' + t.reason);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('P0-01 positive: genuine zero usage measured -> NOT misclassified as UNKNOWN', () => {
  const { A, sandbox } = makeAuthoritySandbox(freshBlob(12752, 0, '2026-11-05T08:00:00Z'));
  try {
    const t = A.resolveTruth({ now: NOW, state: { currentDateWIB: WIB_KEY, upstreamUsedToday: 0 } });
    assert(t.ok === true && t.usageKnown === true && t.measuredZero === true && t.used === 0,
      'measured zero is known-zero (full capacity available), got ' + JSON.stringify(t));
    assert(t.remaining === 12752, 'remaining = full provider capacity, got ' + t.remaining);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

/* ========================================================================== */
/* P0-02 — reservation must fail closed on UNKNOWN usage                       */
/* ========================================================================== */

test('P0-02: unknown provider usage + local ledger 0 -> reserveQuota(1) BLOCKED (USAGE_UNKNOWN, no fabricated remaining)', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, null, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: null, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'reserve must be blocked on unknown usage, got ' + JSON.stringify(r));
    assert(r.reason === 'USAGE_UNKNOWN', 'reason USAGE_UNKNOWN, got ' + r.reason);
    assert(r.used === null && r.remaining === null, 'must NOT fabricate remaining from local ledger 0');
    assert(r.granted === undefined, 'no grant returned');
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P0-02: missing provider snapshot (no data/quota-limit.json) -> reserveQuota BLOCKED (LIMIT_UNKNOWN)', () => {
  const sb = makeReservationSandbox({
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'no provider snapshot -> fail closed, got ' + JSON.stringify(r));
    assert(r.reason === 'LIMIT_UNKNOWN', 'reason LIMIT_UNKNOWN, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P0-02: stale provider snapshot -> reserveQuota BLOCKED (LIMIT_UNKNOWN, stale fails closed)', () => {
  const staleIso = new Date(NOW_MS - 27 * 60 * 60 * 1000).toISOString();
  const sb = makeReservationSandbox({
    blob: Object.assign(freshBlob(18080, 0, staleIso), {
      override: { limit: 50000, actor: 'admin', reason: 'audit', setAt: '2026-11-05T07:00:00Z' }
    }),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'stale + override must not grant, got ' + JSON.stringify(r));
    assert(r.reason === 'LIMIT_UNKNOWN', 'stale snapshot mapped to fail-closed LIMIT_UNKNOWN, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P0-02 positive: provider valid + genuine zero usage -> reserveQuota succeeds with real remaining', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(5000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === true, 'known limit + measured zero usage grants, got ' + JSON.stringify(r));
    assert(r.limit === 18080 && r.remaining === 18080, 'remaining is account-wide verified, got ' + r.remaining);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

/* ========================================================================== */
/* Concurrency, idempotence, TTL, persistence fault, account-wide lock, multi-key */
/* ========================================================================== */

test('concurrent persistent reservations (same account) -> no double-spend beyond the limit', () => {
  const LIMIT = 10000;
  const sb = makeReservationSandbox({
    blob: freshBlob(LIMIT, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    let granted = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = sb.S.reserveQuota(700, 'backfill', { now: NOW, reserveFloor: 0 });
      if (r.ok) granted += r.granted;
      else assert(r.reason === 'INSUFFICIENT_QUOTA', 'reject reason INSUFFICIENT_QUOTA, got ' + r.reason);
    }
    assert(granted === 9800, '700*14 = 9800; 15th would exceed 10000, got total ' + granted);
    assert(granted <= LIMIT, 'no double-spend');
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('account-wide: workers with DIFFERENT API keys share one budget (no per-key budget)', () => {
  const LIMIT = 10000;
  const sb = makeReservationSandbox({
    blob: freshBlob(LIMIT, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    // Worker A ('key-A') reserves 6000.
    const a = sb.S.reserveQuota(6000, 'broker-summary', { now: NOW, reserveFloor: 0, apiKey: 'key-A' });
    assert(a.ok === true, 'worker A grant');
    // Worker B ('key-B') MUST NOT get its own fresh budget: only 4000 remain.
    const b = sb.S.reserveQuota(5000, 'broker-summary', { now: NOW, reserveFloor: 0, apiKey: 'key-B' });
    assert(b.ok === false && b.reason === 'INSUFFICIENT_QUOTA',
      'worker B does not receive its own budget: account-wide truth shared, got ' + JSON.stringify(b));
    const b2 = sb.S.reserveQuota(4000, 'broker-summary', { now: NOW, reserveFloor: 0, apiKey: 'key-B' });
    assert(b2.ok === true, 'worker B can only claim the remaining 4000, got ' + JSON.stringify(b2));
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('account-wide lock: a foreign holder of the lockfile causes fail-closed (STATE_LOCK_BUSY)', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    fs.writeFileSync(sb.S.STATE_PATH + '.lock', '99999');
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false && r.reason === 'STATE_LOCK_BUSY',
      'lock held -> fail closed, got ' + JSON.stringify(r));
  } finally {
    try { fs.unlinkSync(sb.S.STATE_PATH + '.lock'); } catch (_) {}
    fs.rmSync(sb.sandbox, { recursive: true, force: true });
  }
});

test('commit/release idempotent in persistent mode (double-release frees once, double-commit no double-spend)', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    // --- release idempotency ---
    const g = sb.S.reserveQuota(10000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(g.ok === true, 'grant');
    const rel1 = sb.S.releaseQuota(g.reservationId, { now: NOW });
    assert(rel1.ok === true && rel1.released === 10000, 'first release frees 10000');
    const rel2 = sb.S.releaseQuota(g.reservationId, { now: NOW });
    assert(rel2.ok === true && rel2.alreadySettled === true, 'double release idempotent');

    // --- commit cap + idempotency ---
    const g2 = sb.S.reserveQuota(5000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(g2.ok === true, 'second grant for commit test');
    const c1 = sb.S.commitReservation(g2.reservationId, 99999, { now: NOW });
    assert(c1.ok === true && c1.committed === 5000 && c1.capped === true, 'commit capped at granted 5000');
    const c2 = sb.S.commitReservation(g2.reservationId, 1, { now: NOW });
    assert(c2.ok === true && c2.alreadyCommitted === true && c2.committed === 5000,
      'double commit idempotent (no double-spend), got ' + JSON.stringify(c2));
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('TTL expiry: expired unreserved claim frees the pool (persistent mode)', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const g1 = sb.S.reserveQuota(15000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(g1.ok === true, 'grant 15000 (3080 remain)');
    const g2 = sb.S.reserveQuota(5000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(g2.ok === false && g2.reason === 'INSUFFICIENT_QUOTA',
      'blocked while 15000 held (only 3080 remain), got ' + JSON.stringify(g2));
    const g3 = sb.S.reserveQuota(5000, 'backfill', { now: LATER, reserveFloor: 0 });
    assert(g3.ok === true, 'after TTL expiry the pool is freed, got ' + JSON.stringify(g3));
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('persistence failure (fault injection: corrupt state file) -> fail-closed, never grants', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    // Corrupt the on-disk state after a clean seed.
    fs.writeFileSync(sb.statePath, '{not valid json');
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'corrupt state must not grant, got ' + JSON.stringify(r));
    assert(r.reason === 'STATE_READ_FAILED', 'reason STATE_READ_FAILED, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('persistence failure (fault injection: write target is a directory) -> fail-closed STATE_WRITE_FAILED', () => {
  const sb = makeReservationSandbox({
    blob: freshBlob(18080, 0, '2026-11-05T08:00:00Z'),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    // Replace the state file with a DIRECTORY so the atomic tmp+rename write
    // cannot succeed; the claim must be rejected, never reported as ok.
    fs.unlinkSync(sb.statePath);
    fs.mkdirSync(sb.statePath); // directory at quota-state.json
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'write failure must fail the reservation, got ' + JSON.stringify(r));
    assert(r.reason === 'STATE_READ_FAILED' || r.reason === 'STATE_WRITE_FAILED',
      'persistence failure surfaced explicitly, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                       */
/* -------------------------------------------------------------------------- */

let failed = 0;
process.stdout.write('quota-f1-p0 (subtask F1) test suite\n');
process.stdout.write('====================================\n');
for (const r of results) {
  process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  -> ' + (r.error && r.error.message)) + '\n');
  if (!r.ok) failed += 1;
}
process.stdout.write('\n' + (results.length - failed) + '/' + results.length + ' passed\n');
if (failed > 0) process.exit(1);
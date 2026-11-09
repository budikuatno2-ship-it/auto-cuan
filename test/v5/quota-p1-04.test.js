'use strict';
/**
 * test/v5/quota-p1-04.test.js
 * ============================================================================
 * SUBTASK F2 / P1-04 — Plan expiry must not reject a reservation when a fresh
 * valid provider snapshot supersedes stale config.
 *
 * The decision source MUST be a SINGLE authority:
 *   - provider truth when FRESH + VERIFIABLE (wins over a stale planExpiresAt);
 *   - config/config-blob expiry only when NO fresher provider truth exists
 *     (stale-expired plan still fails closed);
 *   - provider UNKNOWN stays FAIL-CLOSED (harmony with F1).
 *
 * NOTE: full-provider-truth resolution lives in lib/quota-limit.resolveLimit()
 * (fresh snapshot -> provider ceiling, else expired/unknown fail-closed).
 * The change under test is lib/quota-reservation.js: the PERSISTENT path must
 * defer expiry to that single authority instead of rejecting on a stale config
 * `planExpiresAt` before any provider witness is consulted.
 *
 * These tests use SANDBOX FILESYSTEMS (real file IO) with the authority and the
 * reservation module copied into an isolated tree. No network, no quota spend,
 * no Telegram.
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = new Date('2026-11-07T08:00:00Z');         // Sat 15:00 WIB (weekend, floor 0)
const NOW_MS = NOW.getTime();
const WIB_KEY = '2026-11-07';

// A STALE plan expiry (in the past relative to NOW).
const STALE_EXPIRY = '2026-11-01T23:59:59+07:00';
// A VALID (future) plan expiry.
const VALID_EXPIRY = '2026-12-31T23:59:59+07:00';

/* Build a reservation sandbox mirroring the F1 harness: quota-reservation.js +
 * quota-limit.js copied into an isolated tree so all paths (lib/config/data)
 * resolve inside the temp dir. */
function makeReservationSandbox(opts) {
  const o = opts || {};
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f2-p104-'));
  const libDir = path.join(sandbox, 'lib');
  const dataDir = path.join(sandbox, 'data');
  const configDir = path.join(sandbox, 'config');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(require.resolve('../../lib/quota-reservation.js'), path.join(libDir, 'quota-reservation.js'));
  fs.copyFileSync(require.resolve('../../lib/quota-limit.js'), path.join(libDir, 'quota-limit.js'));
  fs.writeFileSync(path.join(configDir, 'quota.json'), JSON.stringify(
    o.config || { maxQuota: null, reserveFloorWeekday: 0, reserveFloorWeekend: 0, planExpiresAt: null }));

  const blobPath = path.join(dataDir, 'quota-limit.json');
  if (o.blob != null) fs.writeFileSync(blobPath, JSON.stringify(o.blob));
  const statePath = path.join(dataDir, 'quota-state.json');
  if (o.state != null) fs.writeFileSync(statePath, JSON.stringify(o.state));

  const S = require(path.join(libDir, 'quota-reservation.js'));
  return { S, sandbox, blobPath, statePath, dataDir, configDir };
}

/* A provider snapshot blob with explicit freshness + expiry. `verifiedAtIso`
 * MUST be an ISO string (Date.parse is used to measure staleness). */
function blobWith(limit, verifiedAtIso, planExpiresAt, used) {
  return {
    schemaVersion: 1,
    source: 'provider',
    providerLimit: limit,
    providerLimitSource: 'provider',
    providerLimitVerifiedAt: verifiedAtIso,
    providerPeriodUsed: used == null ? null : used,
    providerPeriodUsedVerifiedAt: verifiedAtIso,
    providerPeriodUsedWibDate: WIB_KEY,
    planExpiresAt: planExpiresAt,
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: { limit: null, actor: null, reason: null, setAt: null },
    updatedAt: verifiedAtIso
  };
}

/* -------------------------------------------------------------------------- */
/* Matrix                                                                      */
/* -------------------------------------------------------------------------- */

test('P1-04 stale planExpiresAt + FRESH valid provider snapshot -> reservation succeeds with provider limit', () => {
  const sb = makeReservationSandbox({
    // planExpiresAt IS in the past, but the provider snapshot is FRESH (now).
    blob: blobWith(18080, NOW.toISOString(), STALE_EXPIRY, 0),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(5000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === true, 'fresh provider truth must win over stale expiry, got ' + JSON.stringify(r));
    assert(r.limit === 18080, 'limit derives from provider snapshot, got ' + r.limit);
    assert(r.reason === 'OK', 'granted, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P1-04 stale planExpiresAt + NO fresh provider snapshot -> reservation BLOCKED (PLAN_EXPIRED, fail closed)', () => {
  // The blob has a STALE provider snapshot (verified 2 days ago) AND a past expiry.
  const staleIso = new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString();
  const sb = makeReservationSandbox({
    blob: blobWith(18080, staleIso, STALE_EXPIRY, 0),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'stale expiry without fresh provider must fail closed, got ' + JSON.stringify(r));
    assert(r.reason === 'PLAN_EXPIRED', 'reason PLAN_EXPIRED, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P1-04 stale planExpiresAt + NO blob authority witness -> reservation BLOCKED (PLAN_EXPIRED)', () => {
  // No provider blob at all; the only authority signal is the stale config expiry.
  const sb = makeReservationSandbox({
    config: { maxQuota: null, reserveFloorWeekday: 0, reserveFloorWeekend: 0, planExpiresAt: STALE_EXPIRY },
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'no fresh provider truth + stale expiry -> blocked, got ' + JSON.stringify(r));
    assert(r.reason === 'PLAN_EXPIRED', 'reason PLAN_EXPIRED, got ' + r.reason);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P1-04 plan VALID + provider FRESH -> normal success', () => {
  const sb = makeReservationSandbox({
    blob: blobWith(18080, NOW.toISOString(), VALID_EXPIRY, 0),
    state: { localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(5000, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === true, 'valid plan + fresh provider grants, got ' + JSON.stringify(r));
    assert(r.limit === 18080, 'limit from provider, got ' + r.limit);
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

test('P1-04 plan VALID + provider UNKNOWN (no usage witness) -> USAGE_FAIL_CLOSED (no F1 regression)', () => {
  // Fresh provider LIMIT but NO same-day provider usage witness -> usage unknown.
  const sb = makeReservationSandbox({
    blob: blobWith(18080, NOW.toISOString(), VALID_EXPIRY, null),
    // No upstreamUsedToday witness; explicit null usage keeps it UNKNOWN.
    state: { localUsedToday: 0, upstreamUsedToday: null, emergencyLocked: false, currentDateWIB: WIB_KEY }
  });
  try {
    const r = sb.S.reserveQuota(1, 'backfill', { now: NOW, reserveFloor: 0 });
    assert(r.ok === false, 'provider usage unknown must fail closed, got ' + JSON.stringify(r));
    assert(r.reason === 'USAGE_UNKNOWN', 'reason USAGE_UNKNOWN (F1 gate preserved), got ' + r.reason);
    assert(r.remaining === null && r.used === null, 'no fabricated remaining/used');
  } finally { fs.rmSync(sb.sandbox, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                       */
/* -------------------------------------------------------------------------- */

let failed = 0;
process.stdout.write('quota-p1-04 (plan expiry vs fresh provider snapshot) test suite\n');
process.stdout.write('==============================================================\n');
for (const r of results) {
  process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  -> ' + (r.error && r.error.message)) + '\n');
  if (!r.ok) failed += 1;
}
process.stdout.write('\n' + (results.length - failed) + '/' + results.length + ' passed\n');
if (failed > 0) process.exit(1);
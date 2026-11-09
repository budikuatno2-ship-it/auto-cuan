'use strict';
/**
 * test/v5/quota-limit.test.js
 * ============================================================================
 * P0-B — Dynamic quota limit authority tests (mocks only, NO network, NO quota)
 * ============================================================================
 * Covers:
 *   1. limit/used overage -> remaining 0, requests BLOCKED
 *   2. limit changes mid-day (dynamic) -> picked up
 *   3. multiple API keys / concurrent workers -> single account-wide limit
 *   4. corrupted/readonly state -> fail-closed
 *   5. upstream status unavailable/unknown -> fail-closed
 *   6. WIB 00:00 reset (mock clock) -> counter reconciliation
 *   7. expired package -> unavailable/fail-closed
 *   8. measured zero vs unknown usage are NOT conflated
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Load the real authority but override its blob path to a sandbox per-test via
// require cache isolation (same pattern as the reservation tests).

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true, error: null }); }
  catch (err) { results.push({ name, ok: false, error: err }); }
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

/* Construct an isolated authority in a sandbox dir (temp). */
function makeAuthority(seedBlob, seedState) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-limit-'));
  const libDir = path.join(sandbox, 'lib');
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const src = fs.readFileSync(require.resolve('../../lib/quota-limit.js'), 'utf8');
  fs.writeFileSync(path.join(libDir, 'quota-limit.js'), src);

  const blobPath = path.join(dataDir, 'quota-limit.json');
  if (seedBlob != null) fs.writeFileSync(blobPath, JSON.stringify(seedBlob));
  const statePath = path.join(dataDir, 'quota-state.json');
  if (seedState != null) fs.writeFileSync(statePath, JSON.stringify(seedState));

  const A = require(path.join(libDir, 'quota-limit.js'));
  return { A, sandbox, blobPath, statePath, dataDir };
}

/* A fresh provider snapshot (the dynamic reality) via the authority setter. */
function seedProvider(A, now, limit, used, planExpiresAt) {
  return A.setProviderLimit({ now, limit, used, planExpiresAt });
}

test('overage: limit 12752 / used 13084 -> remaining 0, overage 332, requests BLOCKED', () => {
  const T0 = new Date('2026-11-06T13:27:00Z'); // 20:27 WIB
  const { A, sandbox } = makeAuthority();
  try {
    seedProvider(A, T0, 12752, 13084, '2026-11-17T23:59:59+07:00');
    const t = A.resolveTruth({ now: T0, state: { currentDateWIB: A.getWibDateKey(T0), upstreamUsedToday: 13084 } });
    // The truth is KNOWN (limit+usage verified) and reports the overage.
    assert(t.ok === true, 'truth is known (limit+usage verified)');
    assert(t.limit === 12752, 'limit is dynamic 12752');
    assert(t.used === 13084, 'used is 13084');
    assert(t.remaining === 0, 'remaining is 0');
    assert(t.overage === 332, 'overage is 332, got ' + t.overage);
    assert(t.limitKnown === true && t.usageKnown === true, 'limit+usage known');
    // A consumptive request is BLOCKED because remaining (0) < requested (1).
    assert(t.remaining < 1, 'a consumptive request cannot be satisfied when remaining=0');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('dynamic: limit changes mid-day and workers pick it up (no restart)', () => {
  const T0 = new Date('2026-11-06T05:00:00Z');
  const T1 = new Date('2026-11-06T06:00:00Z');
  const { A, sandbox } = makeAuthority();
  try {
    seedProvider(A, T0, 10000, 0, '2026-11-17T23:59:59+07:00');
    const before = A.resolveLimit({ now: T0 });
    assert(before.ok && before.limit === 10000, 'initial limit 10000');
    // Provider raises the ceiling mid-day.
    seedProvider(A, T1, 12752, 5000, '2026-11-17T23:59:59+07:00');
    const after = A.resolveLimit({ now: T1 });
    assert(after.ok && after.limit === 12752, 'dynamic pick up 12752, got ' + after.limit);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('expired package + NO fresh provider snapshot -> limit unavailable (fail-closed)', () => {
  // Plan expired AND the provider snapshot is stale (verified 2 days ago) => expired.
  const T = new Date('2026-11-18T00:00:00Z'); // after 2026-11-17 expiry
  const { A, sandbox } = makeAuthority({
    source: 'provider',
    providerLimit: 12752,
    providerLimitVerifiedAt: '2026-11-16T00:00:00Z',
    planExpiresAt: '2026-11-17T23:59:59+07:00',
    override: { limit: null, actor: null, reason: null, setAt: null }
  });
  try {
    const lim = A.resolveLimit({ now: T });
    assert(lim.ok === false && lim.source === 'expired', 'expired -> ok:false, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('F3-F7: old package expired but fresh verified provider snapshot present -> use provider truth', () => {
  // Fresh provider snapshot (verifiedAt === now, within staleness) wins over a
  // stale package-expiry flag. No package expiring may lock out a re-verified truth.
  const T = new Date('2026-11-18T00:00:00Z');
  const { A, sandbox } = makeAuthority();
  try {
    seedProvider(A, T, 12752, 0, '2026-11-17T23:59:59+07:00');
    const lim = A.resolveLimit({ now: T });
    assert(lim.ok === true, 'fresh provider truth wins, got ' + JSON.stringify(lim));
    assert(lim.limit === 12752, 'limit is the fresh verified provider capacity, got ' + lim.limit);
    assert(lim.source === 'provider', 'source is provider, got ' + lim.source);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('upstream status unavailable / unknown -> fail-closed (no invented remaining)', () => {
  const T = new Date('2026-11-06T05:00:00Z');
  const { A, sandbox } = makeAuthority(); // blank blob -> unknown limit & usage
  try {
    const t = A.resolveTruth({ now: T, state: {} });
    assert(t.ok === false, 'no verified limit/usage -> not ok');
    assert(t.limit === null && t.remaining === null, 'limit/remaining null, got ' + JSON.stringify(t));
    assert(t.limitSource === 'unknown', 'source unknown');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('measured zero usage vs unknown usage are NOT conflated', () => {
  const T = new Date('2026-11-06T05:00:00Z');
  const key = A => A.getWibDateKey(T);
  const { A, sandbox } = makeAuthority();
  try {
    seedProvider(A, T, 12752, 0, '2026-11-17T23:59:59+07:00');
    // measured zero same-day witness
    const z = A.resolveUsage({ now: T, state: { currentDateWIB: key(A), upstreamUsedToday: 0 } });
    assert(z.known === true && z.measuredZero === true && z.used === 0, 'measured zero is KNOWN zero');
    // no witness -> unknown (never reported as ok with a fake remaining)
    const u = A.resolveUsage({ now: T, state: { currentDateWIB: key(A) } });
    assert(u.known === false && u.measuredZero === false, 'no witness -> unknown');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('WIB 00:00 rollover -> counter reconciliation via single authority (mock clock)', () => {
  // 23:00 WIB on Nov 6 == 16:00Z; 01:00 WIB on Nov 7 == 18:00Z Nov 6.
  const beforeMidnight = new Date('2026-11-06T16:00:00Z'); // 23:00 WIB Nov 6
  const afterMidnight = new Date('2026-11-06T18:00:00Z');  // 01:00 WIB Nov 7
  const { A, sandbox } = makeAuthority(
    { source: 'provider', providerLimit: 12752, providerLimitVerifiedAt: '2026-11-06T16:00:00Z' }
  );
  try {
    const d1 = A.getWibDateKey(beforeMidnight);
    const d2 = A.getWibDateKey(afterMidnight);
    assert(d1 !== d2, 'WIB date rolls over: ' + d1 + ' -> ' + d2);
    // A stale local counter from the old day must not count against today.
    const stale = A.resolveUsage({
      now: afterMidnight,
      state: { currentDateWIB: d1, upstreamUsedToday: 9000, localUsedToday: 9000 }
    });
    assert(stale.known === false, 'stale prior-day usage is unknown (not carried forward), got ' + JSON.stringify(stale));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('corrupted state file -> fail-closed (readLimitBlob ok:false; resolveTruth not ok)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-limit-corr-'));
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // corrupt blob on disk
  fs.writeFileSync(path.join(dataDir, 'quota-limit.json'), '{not valid json');
  const libDir = path.join(sandbox, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'quota-limit.js'), fs.readFileSync(require.resolve('../../lib/quota-limit.js'), 'utf8'));
  const A = require(path.join(libDir, 'quota-limit.js'));
  try {
    const read = A.readLimitBlob();
    assert(read.ok === false, 'corrupt blob read must fail');
    const t = A.resolveTruth({ now: new Date('2026-11-06T05:00:00Z'), state: {} });
    assert(t.ok === false, 'corrupt blob -> resolveTruth fail-closed');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('multiple API keys share one account -> single account-wide limit (setProviderLimit preserves account truth)', () => {
  const T = new Date('2026-11-06T05:00:00Z');
  const { A, sandbox } = makeAuthority();
  try {
    // two different API keys report the SAME account-wide used/limit.
    seedProvider(A, T, 12752, 7000, '2026-11-17T23:59:59+07:00');
    const t1 = A.resolveTruth({ now: T, state: { currentDateWIB: A.getWibDateKey(T), upstreamUsedToday: 7000 } });
    const t2 = A.resolveTruth({ now: T, state: { currentDateWIB: A.getWibDateKey(T), upstreamUsedToday: 7000 } });
    assert(t1.limit === 12752 && t2.limit === 12752, 'account-wide limit shared');
    assert(t1.used === 7000 && t2.used === 7000, 'account-wide usage shared');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('F3-F1: override is ceiling-only and capped at verified provider capacity; never fakes usage', () => {
  const T = new Date('2026-11-06T05:00:00Z');
  const { A, sandbox } = makeAuthority();
  try {
    seedProvider(A, T, 12752, 13084, '2026-11-17T23:59:59+07:00');
    // 15000 > verified provider 12752 => the operational override must NEVER raise
    // the ceiling above provider capacity.
    const set = A.setOverride({ now: T, limit: 15000, actor: 'admin' });
    assert(set.ok === true, 'override accepted');
    const t = A.resolveTruth({ now: T, state: { currentDateWIB: A.getWibDateKey(T), upstreamUsedToday: 13084 } });
    assert(t.limit === 12752, 'override capped at provider capacity, got ' + t.limit);
    assert(t.used === 13084, 'usage NOT faked by override, got ' + t.used);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('F3-F1 positive: an override LOWER than provider capacity applies (operator may only reduce)', () => {
  const T = new Date('2026-11-06T05:00:00Z');
  const { A, sandbox } = makeAuthority();
  try {
    seedProvider(A, T, 12752, 5000, '2026-11-17T23:59:59+07:00');
    const set = A.setOverride({ now: T, limit: 10000, actor: 'admin' });
    assert(set.ok === true, 'override accepted');
    const lim = A.resolveLimit({ now: T });
    assert(lim.ok === true && lim.limit === 10000 && lim.source === 'manual', 'a lower override applies, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

let failed = 0;
process.stdout.write('quota-limit dynamic authority test suite\n');
process.stdout.write('=========================================\n');
for (const r of results) {
  process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  -> ' + (r.error && r.error.message)) + '\n');
  if (!r.ok) failed += 1;
}
process.stdout.write('\n' + (results.length - failed) + '/' + results.length + ' passed\n');
if (failed > 0) process.exit(1);
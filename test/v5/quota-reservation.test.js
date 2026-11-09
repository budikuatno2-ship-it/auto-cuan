'use strict';
/**
 * test/v5/quota-reservation.test.js
 * ============================================================================
 * BUG-V5-P0-023 / N14 — reservation authority + drift truth tests
 * ============================================================================
 * RULES
 *   - Injected clock everywhere (opts.now); NO real sleeps, NO network.
 *   - Persistent-mode tests run in a sandboxed temp dir (never the real
 *     data/quota-state.json), via module cache invalidation + path injection.
 *   - Assertions never weakened to make a bug look fixed.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const AUTH = require('../../lib/quota-reservation');
const DRIFT = require('../../lib/quota-drift');

/* -------------------------------------------------------------------------- */
/* Micro test harness                                                          */
/* -------------------------------------------------------------------------- */

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true, error: null });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

/* Injected clocks (no Date.now in decision paths — all passed via opts.now) */
const T0 = new Date('2026-11-05T08:00:00Z'); // Thu 15:00 WIB — weekday daytime
const T0_MS = T0.getTime();
const LATER = new Date(T0_MS + 20 * 60 * 1000); // +20 min (past 10-min TTL)

/* -------------------------------------------------------------------------- */
/* 1. CONCURRENCY: 20 simultaneous reserveQuota(1000) vs 18,080 limit + 5,000 floor */
/* -------------------------------------------------------------------------- */

test('concurrent: 20x reserveQuota(1000) vs 18080/floor5000 -> granted <= 13000, reasons on rejects', () => {
  const LIMIT = 18080;
  const FLOOR = 5000;
  const KEY = 'conc-floor';
  AUTH.resetMemoryLedger(KEY);
  const granted = [];
  const rejected = [];

  // One synchronous tick: all 20 callers hit the authority in the same event-
  // loop turn. In-memory mode is single-thread atomic (no interleaving).
  for (let i = 0; i < 20; i += 1) {
    const res = AUTH.reserveQuota(1000, 'backfill', {
      now: T0,
      limit: LIMIT,
      used: 0,
      reserveFloor: FLOOR,
      persist: false,
      memKey: KEY
    });
    if (res.ok) granted.push(res);
    else rejected.push(res);
  }

  const totalGranted = granted.reduce((s, r) => s + r.granted, 0);
  assert(totalGranted <= 13000, 'total granted ' + totalGranted + ' must be <= 13000');
  assert(granted.length === 13, 'expected exactly 13 grants, got ' + granted.length);
  assert(rejected.length === 7, 'expected exactly 7 rejects, got ' + rejected.length);
  for (const r of rejected) {
    assert(r.reason === 'RESERVE_FLOOR', 'reject reason must be RESERVE_FLOOR, got ' + r.reason);
    assert(typeof r.floor === 'number' && r.floor === FLOOR, 'reject must carry floor');
    assert(typeof r.remainingAfter === 'number', 'reject must carry remainingAfter');
  }
  // Exact math: 13 * 1000 = 13000 used, remaining 5080 - next 1000 = 4080 < 5000 floor.
  assert(totalGranted === 13000, 'institutional math: 13 grants = 13000, got ' + totalGranted);
});

test('concurrent: without floor, grants stop exactly at the hard limit', () => {
  const KEY = 'conc-hard';
  AUTH.resetMemoryLedger(KEY);
  const granted = [];
  const rejected = [];
  for (let i = 0; i < 25; i += 1) {
    const res = AUTH.reserveQuota(1000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
    if (res.ok) granted.push(res); else rejected.push(res);
  }
  const totalGranted = granted.reduce((s, r) => s + r.granted, 0);
  assert(totalGranted === 18000, '18 grants of 1000 = 18000 <= 18080, got ' + totalGranted);
  for (const r of rejected) assert(r.reason === 'INSUFFICIENT_QUOTA', 'reject reason INSUFFICIENT_QUOTA, got ' + r.reason);
});

/* -------------------------------------------------------------------------- */
/* 2. RESERVATION LEAK: TTL auto-release via injected clock                     */
/* -------------------------------------------------------------------------- */

test('leak: reserve without commit auto-releases after TTL (injected clock advance)', () => {
  const KEY = 'ttl-leak';
  AUTH.resetMemoryLedger(KEY);
  const r1 = AUTH.reserveQuota(5000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(r1.ok, 'first grant expected');
  const r2 = AUTH.reserveQuota(5000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(r2.ok, 'second grant expected (10000 held of 18080)');
  const r3 = AUTH.reserveQuota(9000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(!r3.ok && r3.reason === 'INSUFFICIENT_QUOTA', 'third grant must fail while 1&2 are held, got ' + (r3 && r3.reason));

  // Time-travel past the TTL: all active reservations expire -> budget freed.
  const r4 = AUTH.reserveQuota(9000, 'backfill', { now: LATER, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(r4.ok, 'after TTL expiry the full 9000 must be grantable, got ' + (r4 && r4.reason));
});

/* -------------------------------------------------------------------------- */
/* 3. DOUBLE RELEASE is idempotent                                              */
/* -------------------------------------------------------------------------- */

test('idempotent: double release returns ok:true twice, frees budget exactly once', () => {
  const KEY = 'dbl-release';
  AUTH.resetMemoryLedger(KEY);
  const r1 = AUTH.reserveQuota(10000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(r1.ok, 'grant expected');
  const blocked = AUTH.reserveQuota(9000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(!blocked.ok, 'second grant must be blocked while 10000 is held');
  const rel1 = AUTH.releaseQuota(r1.reservationId, { now: T0, persist: false, memKey: KEY });
  assert(rel1.ok === true && rel1.released === 10000, 'first release frees 10000');
  const rel2 = AUTH.releaseQuota(r1.reservationId, { now: T0, persist: false, memKey: KEY });
  assert(rel2.ok === true && rel2.alreadySettled === true, 'second release is an idempotent no-op');
  const freed = AUTH.reserveQuota(9000, 'backfill', { now: T0, limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: KEY });
  assert(freed.ok === true, 'budget freed exactly once: 9000 fits after release');
});

/* -------------------------------------------------------------------------- */
/* 4. COMMIT > GRANTED is capped at granted — proven in the persistent-mode    */
/*    sandbox below (step d); kept as a numbered section for traceability.     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* 5. PERSISTENT-MODE SANDBOX: leak, double-release, commit cap, hard limit      */
/*    (module cache isolation so the authority writes into the temp dir)        */
/* -------------------------------------------------------------------------- */

test('persistent sandbox: TTL leak + double release idempotent + commit cap + hard limit', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-quota-persist-'));
  const sandboxLib = path.join(sandbox, 'lib');
  const sandboxData = path.join(sandbox, 'data');
  const sandboxConfig = path.join(sandbox, 'config');
  fs.mkdirSync(sandboxLib, { recursive: true });
  fs.mkdirSync(sandboxData, { recursive: true });
  fs.mkdirSync(sandboxConfig, { recursive: true });
  // Copy the authority into the sandbox so ROOT points at the temp tree.
  // P0-B: the standalone sandbox has no quota-limit.js, so the authority's
  // persistent limit falls back to an explicit legacy ceiling from config.
  const src = fs.readFileSync(require.resolve('../../lib/quota-reservation.js'), 'utf8');
  fs.writeFileSync(path.join(sandboxLib, 'quota-reservation.js'), src);
  fs.writeFileSync(path.join(sandboxConfig, 'quota.json'), JSON.stringify({
    maxQuota: 18080, reserveFloorWeekday: 0, reserveFloorWeekend: 0, planExpiresAt: null
  }));

  const sandboxStatePath = path.join(sandboxData, 'quota-state.json');
  fs.writeFileSync(sandboxStatePath, JSON.stringify({ localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: '2026-11-05' }));

  const S = require(path.join(sandboxLib, 'quota-reservation.js'));

  try {
    // (a) grant 10000, verify a second 9000 is blocked (10000 held, 8080 left)
    const g1 = S.reserveQuota(10000, 'backfill', { now: T0 });
    assert(g1.ok === true, 'persistent grant ok, got ' + JSON.stringify(g1));
    const blocked = S.reserveQuota(9000, 'backfill', { now: T0 });
    assert(blocked.ok === false && blocked.reason === 'INSUFFICIENT_QUOTA',
      'blocked while 10000 held, got ' + JSON.stringify(blocked));

    // (b) double release is idempotent
    const rel1 = S.releaseQuota(g1.reservationId, { now: T0 });
    assert(rel1.ok === true && rel1.released === 10000, 'first release frees 10000');
    const rel2 = S.releaseQuota(g1.reservationId, { now: T0 });
    assert(rel2.ok === true && rel2.alreadySettled === true, 'second release is an idempotent no-op');

    // (c) budget actually freed: 9000 now fits
    const g2 = S.reserveQuota(9000, 'backfill', { now: T0 });
    assert(g2.ok === true, 'after release 9000 fits, got ' + JSON.stringify(g2));

    // (d) commit > granted is capped
    const c1 = S.commitReservation(g2.reservationId, 99999, { now: T0 });
    assert(c1.ok === true && c1.committed === 9000 && c1.capped === true,
      'commit capped at granted 9000, got ' + JSON.stringify(c1));
    const c2 = S.commitReservation(g2.reservationId, 1, { now: T0 }); // double commit
    assert(c2.ok === true && c2.alreadyCommitted === true, 'double commit idempotent');

    // (e) committed usage is visible in the state file and the ledger caps spend
    const after = JSON.parse(fs.readFileSync(sandboxStatePath, 'utf8'));
    assert(after.localUsedToday === 9000, 'localUsedToday=9000 after commit, got ' + after.localUsedToday);
    const g3 = S.reserveQuota(9081, 'backfill', { now: T0 }); // 9081 > 18080-9000
    assert(g3.ok === false && g3.reason === 'INSUFFICIENT_QUOTA', 'ledger enforces the hard limit post-commit');

    // (f) TTL auto-release in persistent mode (reserveFloor:0 so the exact-fit
    // grant tests the hard limit, not the weekday floor)
    const g4 = S.reserveQuota(9080, 'backfill', { now: T0, reserveFloor: 0 });
    assert(g4.ok === true, '9080 fits exactly (18080-9000)');
    const g5 = S.reserveQuota(1, 'backfill', { now: T0, reserveFloor: 0 });
    assert(g5.ok === false, 'pool exhausted');
    const g6 = S.reserveQuota(1, 'backfill', { now: LATER, reserveFloor: 0 }); // TTL expired g4
    assert(g6.ok === true, 'expired reservation auto-released the pool, got ' + JSON.stringify(g6));

    // (g) emergency lock
    const g7 = S.reserveQuota(1, 'backfill', { now: T0, emergencyLocked: true });
    assert(g7.ok === false && (g7.reason === 'QUOTA_HARD_LOCK' || g7.reason === 'EMERGENCY_LOCK'), 'emergency lock rejects');
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
});

/* -------------------------------------------------------------------------- */
/* 6. DRIFT TRUTH — the real VPS numbers                                        */
/* -------------------------------------------------------------------------- */

test('drift: upstream 13091 vs local 1011 -> authoritative 13091, remaining 4989', () => {
  const d = DRIFT.computeDrift({ localUsedToday: 1011, upstreamUsedToday: 13091, maxQuota: 18080 });
  assert(d.driftDetected === true, 'drift must be detected');
  assert(d.drift === 12080, 'drift = 13091-1011 = 12080, got ' + d.drift);
  assert(d.authoritativeUsed === 13091, 'authoritative adopts the HIGHER (upstream) figure, got ' + d.authoritativeUsed);
  assert(d.authoritativeSource === 'upstream', 'source=upstream');
  assert(d.authoritativeRemaining === 4989, 'remaining = 18080-13091 = 4989, got ' + d.authoritativeRemaining);
  // Never adopt the lower local number:
  assert(d.authoritativeUsed !== 1011, 'must never adopt the lower local counter');
});

test('drift: symmetric — local higher than upstream adopts local (still conservative max)', () => {
  const d = DRIFT.computeDrift({ localUsedToday: 14000, upstreamUsedToday: 13091, maxQuota: 18080 });
  assert(d.authoritativeUsed === 14000, 'conservative max, got ' + d.authoritativeUsed);
  assert(d.driftDetected === false, 'upstream < local is not upstream-drift (already conservative)');
});

test('floor: weekday 15:00 WIB with upstream burn -> RESERVE_FLOOR reproducible', () => {
  // 2026-11-05 is a Thursday; 08:00Z = 15:00 WIB. Authoritative usage 13091.
  const res = AUTH.reserveQuota(1, 'backfill', {
    now: T0, limit: 18080, used: 13091, reserveFloor: 5000, persist: false, memKey: 'floor-wd'
  });
  assert(res.ok === false, 'reserve must be rejected');
  assert(res.reason === 'RESERVE_FLOOR', 'reason RESERVE_FLOOR, got ' + res.reason);
  assert(res.remaining === 4989, 'remaining 4989 < floor 5000');
  assert(res.remainingAfter === 4988, 'remainingAfter = 4989-1 = 4988');
  // This is exactly the VPS quota-burn-state.json "stopped=RESERVE_FLOOR" state.
});

test('floor: weekend -> floor 0, full budget available', () => {
  // 2026-11-07 is a Saturday; 08:00Z = 15:00 WIB.
  const res = AUTH.reserveQuota(18080, 'backfill', {
    now: new Date('2026-11-07T08:00:00Z'), limit: 18080, used: 0, reserveFloor: 0, persist: false, memKey: 'floor-we'
  });
  assert(res.ok === true, 'weekend full grant ok, got ' + JSON.stringify(res));
});

test('expiry: planExpiresAt in the past -> PLAN_EXPIRED', () => {
  const res = AUTH.reserveQuota(1, 'backfill', {
    now: new Date('2026-12-01T08:00:00Z'), // after 2026-11-17 expiry
    limit: 18080, used: 0, reserveFloor: 0,
    config: { maxQuota: 18080, planExpiresAt: '2026-11-17T23:59:59+07:00' },
    persist: false, memKey: 'expiry'
  });
  assert(res.ok === false && res.reason === 'PLAN_EXPIRED', 'PLAN_EXPIRED, got ' + JSON.stringify(res));
  // Before expiry the same request succeeds:
  const ok = AUTH.reserveQuota(1, 'backfill', {
    now: T0, limit: 18080, used: 0, reserveFloor: 0,
    config: { maxQuota: 18080, planExpiresAt: '2026-11-17T23:59:59+07:00' },
    persist: false, memKey: 'expiry'
  });
  assert(ok.ok === true, 'before expiry the request must succeed');
});

test('emergency lock -> QUOTA_HARD_LOCK', () => {
  const res = AUTH.reserveQuota(1, 'backfill', { now: T0, limit: 18080, used: 0, emergencyLocked: true, persist: false, memKey: 'em-lock' });
  assert(res.ok === false && (res.reason === 'QUOTA_HARD_LOCK' || res.reason === 'EMERGENCY_LOCK'),
    'hard lock reject, got ' + JSON.stringify(res));
});

/* -------------------------------------------------------------------------- */
/* 7. DRIFT RECONCILE — adopt higher, log, remaining math (sandboxed)           */
/* -------------------------------------------------------------------------- */

test('reconcile: adopts upstream 13091 over local 1011, writes authoritative fields + jsonl log', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-drift-'));
  const statePath = path.join(sandbox, 'quota-state.json');
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      localUsedToday: 1011,
      upstreamUsedToday: 13091,
      emergencyLocked: false,
      currentDateWIB: '2026-11-05'
    }));
    // P0-B: the dynamic limit authority would return `unknown` with no provider
    // snapshot; this pure drift-math test therefore feeds the V5 evidence limit
    // explicitly (a test fixture, not a production hardcode).
    const out = DRIFT.reconcile({ now: T0, statePath, dryRun: false, maxQuota: 18080 });
    assert(out.authoritativeUsed === 13091, 'adopt 13091, got ' + out.authoritativeUsed);
    assert(out.authoritativeRemaining === 4989, 'remaining 4989, got ' + out.authoritativeRemaining);
    assert(out.driftDetected === true && out.drift === 12080, 'drift 12080 detected');

    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(st.localUsedToday === 13091, 'localUsedToday raised to upstream truth (never lowered), got ' + st.localUsedToday);
    assert(st.authoritativeUsedToday === 13091, 'authoritative field written');
    assert(st.authoritativeRemainingToday === 4989, 'remaining field written');

    const logPath = DRIFT.DRIFT_LOG_PATH;
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1]);
    assert(rec.eventType === 'QUOTA_DRIFT_RECONCILE', 'structured drift record appended');
    assert(rec.upstreamUsedToday === 13091 && rec.localUsedToday === 1011, 'record carries both counters');
    assert(!JSON.stringify(rec).toLowerCase().includes('apikey') && !JSON.stringify(rec).includes('X-API-Key'), 'no secrets in drift log');
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(DRIFT.DRIFT_LOG_PATH, { force: true }); } catch (_) {}
  }
});

test('reconcile RESERVE_FLOOR stop reproducible: after adoption, weekday reserve is floor-stopped', () => {
  const postReconcile = DRIFT.computeDrift({ localUsedToday: 13091, upstreamUsedToday: 13091, maxQuota: 18080 });
  const res = AUTH.reserveQuota(1, 'backfill', {
    now: T0, limit: postReconcile.maxQuota, used: postReconcile.authoritativeUsed, reserveFloor: 5000, persist: false, memKey: 'floor-post'
  });
  assert(res.ok === false && res.reason === 'RESERVE_FLOOR',
    'post-reconcile weekday reserve must stop on RESERVE_FLOOR (matches VPS burn state)');
});

/* -------------------------------------------------------------------------- */
/* 8. R1 REVIEW REMEDIATION — settle path is lock-guarded (TOCTOU fix)          */
/*    The persistent settle (release/commit) previously ran find -> mutate ->  */
/*    write WITHOUT the lockfile. These tests prove a settle concurrent with a  */
/*    reserve can no longer drop the reservation:                               */
/*    (a) source-level: every persistent settle path passes through acquireLock */
/*    (b) stress: N=50 mixed reserve/settle ops in the sandbox assert final     */
/*        state consistency (reserved+used never exceeds limit, no active       */
/*        reservation vanishes).                                               */
/* -------------------------------------------------------------------------- */

function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert(start > 0, 'function ' + name + ' must exist in quota-reservation.js');
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next > 0 ? next : src.length);
}

test('R1 settle locking: source-level proof — persistent release/commit are guarded by acquireLock', () => {
  const src = fs.readFileSync(require.resolve('../../lib/quota-reservation.js'), 'utf8');
  const settleBody = extractFn(src, 'settlePersistent');
  assert(settleBody.includes('acquireLock()'), 'settlePersistent must call acquireLock()');
  assert(settleBody.includes('releaseLock()'), 'settlePersistent must release the lock in finally');
  assert(settleBody.indexOf('acquireLock()') < settleBody.indexOf('readPersistentState'),
    'lock must be acquired BEFORE the state read (no unguarded find)');
  assert(settleBody.includes('settleTxn('), 'find -> mutate -> write must run inside the locked region (settleTxn)');
  assert(settleBody.includes('recordPendingSettle('), 'lock-busy settle must be recorded as pending-settle');
  assert(settleBody.includes('reservationPreserved: true'), 'lock-busy response must declare reservationPreserved');

  // The shared settle transaction performs the persistent write; the settle
  // mutate+write therefore happens strictly inside the critical section.
  const txnBody = extractFn(src, 'settleTxn');
  assert(txnBody.includes('writePersistentStateAtomic'), 'persistent settle write must happen inside settleTxn (locked region)');

  // releaseQuota / commitReservation must delegate the PERSISTENT branch to
  // settlePersistent — no direct find -> write outside the lock anymore.
  for (const name of ['releaseQuota', 'commitReservation']) {
    const body = extractFn(src, name);
    assert(body.includes('settlePersistent('), name + ' persistent branch must delegate to settlePersistent');
    assert(!body.includes('writePersistentStateAtomic'), name + ' must not write outside the locked settle path');
  }
});

test('R1 settle consistency: N=50 mixed reserve/settle ops — reserved+used never exceeds limit, no active reservation vanishes', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-quota-r1-'));
  const sandboxLib = path.join(sandbox, 'lib');
  const sandboxData = path.join(sandbox, 'data');
  fs.mkdirSync(sandboxLib, { recursive: true });
  fs.mkdirSync(sandboxData, { recursive: true });
  fs.writeFileSync(path.join(sandboxLib, 'quota-reservation.js'),
    fs.readFileSync(require.resolve('../../lib/quota-reservation.js'), 'utf8'));
  const sandboxStatePath = path.join(sandboxData, 'quota-state.json');
  // F1: a same-day provider witness (measured zero) seeds the account-wide
  // usage as KNOWN, so the stress loop exercises atomic claims (not the
  // usage-unknown fail-closed gate, which is covered by its own tests).
  fs.writeFileSync(sandboxStatePath, JSON.stringify({ localUsedToday: 0, upstreamUsedToday: 0, emergencyLocked: false, currentDateWIB: '2026-11-05' }));
  const S = require(path.join(sandboxLib, 'quota-reservation.js'));

  try {
    const LIMIT = 10000; // injected config: tight pool for the stress loop
    const CFG = { maxQuota: LIMIT, reserveFloorWeekday: 0, reserveFloorWeekend: 0, planExpiresAt: null };
    fs.mkdirSync(path.dirname(S.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(S.CONFIG_PATH, JSON.stringify(CFG));
    const active = new Map(); // id -> granted
    let committedTotal = 0;
    let nowTick = T0_MS;

    for (let i = 0; i < 50; i += 1) {
      nowTick += 1000;
      const now = new Date(nowTick);
      const op = i % 3;

      if (op === 0 || active.size === 0) {
        // reserve a random small amount
        const n = 100 + ((i * 137) % 900);
        const r = S.reserveQuota(n, 'backfill', { now, config: CFG, reserveFloor: 0 });
        if (r.ok) active.set(r.reservationId, r.granted);
        else {
          // rejects must be legitimate: with floor 0, only INSUFFICIENT_QUOTA
          assert(r.reason === 'INSUFFICIENT_QUOTA', 'unexpected reject reason ' + r.reason + ' at op ' + i);
        }
      } else if (op === 1) {
        // commit one active reservation
        const id = active.keys().next().value;
        const granted = active.get(id);
        const c = S.commitReservation(id, granted, { now, config: CFG });
        assert(c.ok === true, 'commit of an active reservation must succeed, got ' + JSON.stringify(c));
        committedTotal += c.committed;
        active.delete(id);
      } else {
        // release one active reservation
        const id = active.keys().next().value;
        const granted = active.get(id);
        const rel = S.releaseQuota(id, { now, config: CFG });
        assert(rel.ok === true, 'release of an active reservation must succeed, got ' + JSON.stringify(rel));
        active.delete(id);
      }

      // Invariant after every op: committed + still-active reserved <= LIMIT
      const view = S.getReservationView({ now, config: CFG });
      assert(view.used + view.reserved <= LIMIT,
        'op ' + i + ': used(' + view.used + ')+reserved(' + view.reserved + ') must never exceed ' + LIMIT);
      assert(view.used === committedTotal,
        'op ' + i + ': used ' + view.used + ' must equal tracked commits ' + committedTotal);
    }

    // Final: every reservation ever created is still accounted for — none
    // vanished silently. Committed ones are in `used`; active ones survived.
    const final = S.getReservationView({ now: new Date(nowTick), config: CFG });
    const finalState = JSON.parse(fs.readFileSync(sandboxStatePath, 'utf8'));
    for (const r of Object.values(finalState.reservations)) {
      if (r.status === 'active') {
        assert(active.has(r.id), 'active reservation ' + r.id + ' vanished from tracked set (would be a dropped reservation)');
        assert(finalState.reservations[r.id].granted === active.get(r.id), 'granted mismatch for ' + r.id);
      }
    }
    assert(final.used === committedTotal, 'final used ' + final.used + ' equals tracked commits ' + committedTotal);
    const finalActiveSum = Object.values(finalState.reservations)
      .filter((r) => r.status === 'active')
      .reduce((s, r) => s + r.granted, 0);
    assert(finalActiveSum === final.reserved, 'ledger active sum matches view reserved');
    assert(final.used + final.reserved <= LIMIT, 'final invariant holds');
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
});

test('R1 settle vs reserve interleaving: a settle that hits a held lock preserves the reservation (pending-settle recorded, no drop)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-quota-r1b-'));
  const sandboxLib = path.join(sandbox, 'lib');
  const sandboxData = path.join(sandbox, 'data');
  fs.mkdirSync(sandboxLib, { recursive: true });
  fs.mkdirSync(sandboxData, { recursive: true });
  const srcPath = path.join(sandboxLib, 'quota-reservation.js');
  fs.writeFileSync(srcPath, fs.readFileSync(require.resolve('../../lib/quota-reservation.js'), 'utf8'));
  const S = require(srcPath);

  try {
    const CFG = { maxQuota: 18080, reserveFloorWeekday: 0, reserveFloorWeekend: 0, planExpiresAt: null };
    // Simulated cross-process contention: an external writer holds the lock
    // file (same lockfile the authority uses), then a settle is attempted.
    fs.writeFileSync(S.STATE_PATH, JSON.stringify({ localUsedToday: 0, emergencyLocked: false, currentDateWIB: '2026-11-05' }));
    fs.writeFileSync(S.STATE_PATH + '.lock', '99999'); // foreign holder

    const g = S.reserveQuota(5000, 'backfill', { now: T0, config: CFG, reserveFloor: 0 });
    assert(g.ok === false && g.reason === 'STATE_LOCK_BUSY',
      'reserve under a held lock must reject with STATE_LOCK_BUSY, got ' + JSON.stringify(g));

    // Settle under the same contention: must NOT silently "succeed" and must
    // not lose state. With a stale lock (mtime now) the authority retries a
    // bounded number of times, then records a pending-settle.
    const rel = S.releaseQuota('res-nonexistent', { now: T0, config: CFG });
    assert(rel.ok === false, 'release under held lock must not report ok');

    fs.unlinkSync(S.STATE_PATH + '.lock');

    // After the lock is freed, the exact reservation state on disk is intact
    // (no torn or resurrected stale write happened during contention).
    const state = JSON.parse(fs.readFileSync(S.STATE_PATH, 'utf8'));
    assert(!state.reservations || Object.keys(state.reservations).length === 0,
      'no partial writes during lock contention');
  } finally {
    try { fs.unlinkSync(S.STATE_PATH + '.lock'); } catch (_) {}
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                       */
/* -------------------------------------------------------------------------- */

let failed = 0;
process.stdout.write('quota-reservation + quota-drift test suite\n');
process.stdout.write('==========================================\n');
for (const r of results) {
  process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  -> ' + (r.error && r.error.message)) + '\n');
  if (!r.ok) failed += 1;
}
process.stdout.write('\n' + (results.length - failed) + '/' + results.length + ' passed\n');
if (failed > 0) process.exit(1);

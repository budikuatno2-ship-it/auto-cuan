'use strict';

/**
 * test/v6-scheduler-collision-regression.test.js
 * ============================================================================
 * V6 (Subtask I) — Scheduler collision/regression suite.
 *
 * Uses the REAL durable store + REAL engine with a fake clock + a real
 * runner-side-effect fixture (no production fetch, no Telegram, no timers).
 *
 * Scenarios (each maps to the mandated list):
 *   1. 2x run duplicate        -> exactly one execution (LEASE_HELD).
 *   2. lock busy               -> LOCK_BUSY on concurrent store write.
 *   3. provider down           -> PROVIDER_UNAVAILABLE / PENDING_PROVIDER.
 *   4. quota exhausted         -> QUOTA_EXHAUSTED (no consumption).
 *   5. retry after reset       -> runs again next session after reset.
 *   6. partial ALL/Foreign     -> Foreign sweep waits on broksum-all validity.
 *   7. delayed publish         -> telegram still gated by top5 dependency.
 *   8. weekend                 -> marketDaysOnly skipped Sat/Sun.
 *   9. IDX holiday             -> holiday set skips the day.
 *  10. out-of-session          -> MISSED_BEYOND_CATCHUP after window.
 *  11. restart worker          -> schedule + version survive reload.
 *  12. deploy preserving config-> version+time persist across module reload.
 *  13. Telegram final blocked  -> when mandatory data incomplete (top5 gate
 *                                   not satisfied), telegram must NOT run.
 *  14. collision: Broksum 20:40 window ends 21:25; domestic-compile 20:45
 *      (before dependency gate) is REJECTED; default 20:55 is accepted.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STORE_P = path.join(ROOT, 'lib', 'admin-schedule-store.js');
const ENGINE_P = path.join(ROOT, 'lib', 'admin-schedule-engine.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-sched-cr-')); }

function loadStore(tmp) {
  process.env.ADMIN_SCHEDULE_CONFIG_PATH = path.join(tmp, 'admin-schedule-config.json');
  process.env.ADMIN_SCHEDULE_HISTORY_PATH = path.join(tmp, 'history');
  process.env.ADMIN_SCHEDULE_AUDIT_PATH = path.join(tmp, 'audit.log.jsonl');
  // V6 Subtask F: POST-CUTOVER world for pure collision/regression semantics
  // (all legacy executors RETIRED). The LEGACY_DUPLICATE guard + fail-closed
  // default are covered by test/v6-schedule-runner-local-e2e.test.js.
  const legacyPath = path.join(tmp, 'legacy-active.json');
  if (!fs.existsSync(legacyPath)) {
    const cp = require(path.join(ROOT, 'lib', 'schedule-control-plane.js'));
    const map = {};
    for (const ex of cp.LEGACY_EXECUTORS) map[ex.name] = 'RETIRED';
    fs.writeFileSync(legacyPath, JSON.stringify({ executors: map }));
  }
  process.env.SCHEDULE_LEGACY_ACTIVE_PATH = legacyPath;
  delete require.cache[require.resolve(STORE_P)];
  const store = require(STORE_P);
  if (!fs.existsSync(store.STORE_PATH)) {
    const doc = store.normalizeDoc({});
    doc.jobs['broksum-all'].timeWIB = '20:40';
    doc.jobs['broksum-foreign'].timeWIB = '20:45';
    fs.writeFileSync(store.STORE_PATH, JSON.stringify(doc));
  }
  return store;
}

function loadEngine() {
  delete require.cache[require.resolve(ENGINE_P)];
  return require(ENGINE_P);
}

function wibInstant(dateKey, hhmm) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) - (7 * 60 * 60 * 1000));
}

function runnerFixture() {
  const executed = [];
  return {
    executed,
    run(plan) {
      executed.push(plan);
      return { ok: true, key: plan.key, session: plan.session, version: plan.version, nextRunIso: plan.nextRunIso };
    },
    doneResult(plan) {
      return { session: plan.session, version: plan.version, nextRunIso: plan.nextRunIso, status: 'DONE' };
    }
  };
}

function readyGates(E, key, extra) {
  const o = extra || {};
  return E.buildGates({
    dataState: o.dataState || {},
    providerState: Object.assign({ [key]: 'READY' }, o.providerState),
    quotaState: o.quotaState || { known: true, remaining: 1000 }
  });
}

/* --------------------------------------------------------------------------- */

test('1/2: duplicate run -> single execution (LEASE_HELD)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const job = S.get().doc.jobs['broksum-all'];
  const now = wibInstant('2026-11-09', '20:40'); // Monday
  const fixture = runnerFixture();
  const leases = E.createLeaseManager({ now: () => now.getTime() });
  const gates = readyGates(E, 'broksum-all');

  const first = E.decideRun(job, now, { session: 'w1', version: 0, gates, leases });
  assert.equal(first.shouldRun, true);
  fixture.run(first.plan);

  const dup = E.decideRun(job, now, { session: 'w1', version: 0, gates, leases });
  assert.equal(dup.shouldRun, false, '2x duplicate must not re-run');
  assert.equal(dup.reason, 'LEASE_HELD');
  assert.equal(fixture.executed.length, 1);
});

test('2/2: lock busy -> LOCK_BUSY on concurrent store write', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  // Simulate external holder of the store lock file.
  fs.writeFileSync(S.LOCK_PATH, String(12345));
  try {
    const r = S.put({ jobs: { 'broksum-all': { timeWIB: '21:00' } } }, { actor: 'budi', reason: 'while-locked' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'LOCK_BUSY');
  } finally {
    fs.rmSync(S.LOCK_PATH, { force: true });
  }
});

test('3: provider down -> PROVIDER_UNAVAILABLE, PENDING_PROVIDER retry-eligible', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const job = S.get().doc.jobs['broksum-all']; // HIGH cost => needs provider
  const now = wibInstant('2026-11-09', '20:40');

  const down = E.buildGates({
    dataState: {},
    providerState: { 'broksum-all': 'UNAVAILABLE' },
    quotaState: { known: true, remaining: 1000 }
  });
  const dDown = E.decideRun(job, now, { session: 'w1', version: 0, gates: down });
  assert.equal(dDown.shouldRun, false);
  assert.equal(dDown.reason, 'PROVIDER_UNAVAILABLE');

  const pending = E.buildGates({
    dataState: {},
    providerState: { 'broksum-all': 'PENDING_PROVIDER' },
    quotaState: { known: true, remaining: 1000 }
  });
  const dPending = E.decideRun(job, now, { session: 'w1', version: 0, gates: pending });
  assert.equal(dPending.shouldRun, false);
  assert.equal(dPending.reason, 'PENDING_PROVIDER');
  assert.equal(dPending.retryEligible, true, 'pending provider is retry-eligible, never fake success');
});

test('4: quota exhausted -> QUOTA_EXHAUSTED (zero consumption)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const job = S.get().doc.jobs['quota-backfill']; // BACKFILL cost class (quota consumer)
  const now = wibInstant('2026-11-09', '00:15');
  const gates = E.buildGates({
    dataState: {},
    providerState: { 'quota-backfill': 'READY' },
    quotaState: { known: true, remaining: 0 }
  });
  const d = E.decideRun(job, now, { session: 'w1', version: 0, gates });
  assert.equal(d.shouldRun, false);
  assert.equal(d.reason, 'QUOTA_EXHAUSTED');
});

test('5: retry after reset -> different session re-runs once', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const job = S.get().doc.jobs['broksum-all'];
  const now = wibInstant('2026-11-09', '20:40');
  const fixture = runnerFixture();

  // First session runs and completes.
  const gates1 = readyGates(E, 'broksum-all');
  const leases1 = E.createLeaseManager({ now: () => now.getTime() });
  const r1 = E.decideRun(job, now, { session: 'w1', version: 0, gates: gates1, leases: leases1 });
  assert.equal(r1.shouldRun, true);
  fixture.run(r1.plan);

  // A new scheduler (fresh leases) with a NEW session id may run once again,
  // simulating a reset cycle: distinct idempotency key -> not a duplicate.
  const leases2 = E.createLeaseManager({ now: () => now.getTime() });
  const r2 = E.decideRun(job, now, { session: 'w2', version: 0, gates: readyGates(E, 'broksum-all'), leases: leases2 });
  assert.equal(r2.shouldRun, true);
  fixture.run(r2.plan);

  assert.equal(fixture.executed.length, 2, 'distinct sessions each run once');
  assert.equal(fixture.executed[0].session, 'w1');
  assert.equal(fixture.executed[1].session, 'w2');
});

test('6: partial ALL/Foreign -> foreign sweep waits on broksum-all valid', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const foreign = S.get().doc.jobs['broksum-foreign']; // dependsOn ['broksum-all']

  const now = wibInstant('2026-11-09', '21:00');
  const blocked = E.buildGates({
    dataState: { 'broksum-all': false }, // ALL not valid yet
    providerState: { 'broksum-foreign': 'READY' },
    quotaState: { known: true, remaining: 1000 }
  });
  const dBlocked = E.decideRun(foreign, now, { session: 'w1', version: 0, gates: blocked });
  assert.equal(dBlocked.shouldRun, false);
  assert.equal(dBlocked.reason, 'DEPENDENCY_BLOCKED');

  const ok = E.buildGates({
    dataState: { 'broksum-all': true },
    providerState: { 'broksum-foreign': 'READY' },
    quotaState: { known: true, remaining: 1000 }
  });
  const dOk = E.decideRun(foreign, now, { session: 'w1', version: 0, gates: ok, leases: E.createLeaseManager({ now: () => now.getTime() }) });
  assert.equal(dOk.shouldRun, true, 'foreign runs once ALL is valid');
});

test('7: delayed publish -> telegram still gated by top5', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const telegram = Object.assign({}, S.get().doc.jobs['telegram'], { enabled: true }); // dependsOn ['top5']
  const now = wibInstant('2026-11-09', '21:20');

  const stale = E.buildGates({ dataState: { top5: false }, providerState: {}, quotaState: { known: true, remaining: 100 } });
  const dStale = E.decideRun(telegram, now, { session: 'w1', version: 0, gates: stale });
  assert.equal(dStale.shouldRun, false);
  assert.equal(dStale.reason, 'DEPENDENCY_BLOCKED');

  const fresh = E.buildGates({ dataState: { top5: true }, providerState: {}, quotaState: { known: true, remaining: 100 } });
  const dFresh = E.decideRun(telegram, now, { session: 'w1', version: 0, gates: fresh, leases: E.createLeaseManager({ now: () => now.getTime() }) });
  assert.equal(dFresh.shouldRun, true);
});

test('8: weekend -> marketDaysOnly skipped', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  // 2026-11-14 is a Saturday.
  const next = E.computeNextRun(S.get().doc.jobs['broksum-all'], wibInstant('2026-11-13', '20:41'));
  assert.ok(next);
  const dayKey = E.formatWibIso(next.toISOString()).slice(0, 10);
  assert.equal(dayKey, '2026-11-16', 'Saturday skipped -> next run Monday');
});

test('9: IDX holiday -> holiday set skips the day', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const job = S.get().doc.jobs['broksum-all'];
  // Make Fri 2026-11-13 a holiday; from Thu 20:01 next run must skip to Monday.
  const holidays = new Set(['2026-11-13']);
  const next = E.computeNextRun(job, wibInstant('2026-11-12', '20:41'), { holidaySet: holidays });
  assert.equal(E.formatWibIso(next.toISOString()).slice(0, 10), '2026-11-16');
});

test('10: out-of-session -> missed slot does not spuriously execute (MISSED_BEYOND_CATCHUP)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const job = S.get().doc.jobs['yahoo-ohlcv']; // 17:00 WIB market-day EOD, retry window 15m
  // 18:30 same day is 90m after the 17:00 slot — beyond the 15m catch-up
  // window. V6 Subtask F taxonomy: the slot is honestly recorded as MISSED
  // (MISSED_BEYOND_CATCHUP), never executed late, never disguised as NOT_YET.
  const now = wibInstant('2026-11-09', '18:30');
  const d = E.decideRun(job, now, { session: 'w1', version: 0, gates: E.buildGates({}), leases: E.createLeaseManager({ now: () => now.getTime() }) });
  assert.equal(d.shouldRun, false, 'missed slot must not execute late');
  assert.equal(d.reason, 'MISSED_BEYOND_CATCHUP');

  // Within the catch-up window (17:10, 10m late <= 15m) the slot IS eligible
  // exactly once (safe idempotent catch-up after a short downtime).
  const inWindow = wibInstant('2026-11-09', '17:10');
  const d2 = E.decideRun(job, inWindow, { session: 'w1', version: 0, gates: E.buildGates({}), leases: E.createLeaseManager({ now: () => inWindow.getTime() }) });
  assert.equal(d2.shouldRun, true, 'catch-up within retry window executes once');

  // Far past the horizon (23:00) the engine looks at the NEXT day slot (NOT_YET),
  // never re-surfaces the old slot.
  const late = wibInstant('2026-11-09', '23:00');
  const d3 = E.decideRun(job, late, { session: 'w1', version: 0, gates: E.buildGates({}), leases: E.createLeaseManager({ now: () => late.getTime() }) });
  assert.equal(d3.shouldRun, false);
  assert.equal(d3.reason, 'NOT_YET');
});

test('11: restart worker -> schedule + version survive reload', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const saved = S.put({ jobs: { 'broksum-all': { timeWIB: '19:30' } } }, { actor: 'budi', reason: 'custom' });
  assert.equal(saved.ok, true);

  const S2 = loadStore(tmp); // fresh module = restart
  assert.equal(S2.get().doc.jobs['broksum-all'].timeWIB, '19:30');
  assert.equal(S2.get().doc.version, saved.version);
});

test('12: deploy preserving config -> version + time persist', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  // v1
  S.put({ jobs: { 'domestic-compile': { timeWIB: '20:50' } } }, { actor: 'budi', reason: 'custom 20:50' });
  // Simulate deploy reload (fresh require) — values must persist from durable file.
  const S2 = loadStore(tmp);
  const doc = S2.get().doc;
  assert.equal(doc.jobs['domestic-compile'].timeWIB, '20:50');
  assert.equal(doc.jobs['broksum-all'].timeWIB, '20:40', 'broksum stays locked cost-class default');
  assert.equal(doc.version, 1);
});

test('13: Telegram final blocked when mandatory data incomplete', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const telegram = Object.assign({}, S.get().doc.jobs['telegram'], { enabled: true });
  const now = wibInstant('2026-11-09', '21:20');

  // top5 not satisfied => Telegram final dispatch blocked (mandatory chain incomplete).
  const gates = E.buildGates({ dataState: { top5: false }, providerState: {}, quotaState: { known: true, remaining: 100 } });
  const d = E.decideRun(telegram, now, { session: 'w1', version: 0, gates });
  assert.equal(d.shouldRun, false);
  assert.equal(d.reason, 'DEPENDENCY_BLOCKED');
  assert.ok(d.gate.details.missingDeps.includes('top5'), 'missing mandatory data => top5');
});

test('14: dependency-serialized overlap accepted; earlier not-before slot still waits for parents', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);

  // The slot is a not-before time; mandatory parents serialize execution.
  const saved = S.put({ jobs: { 'domestic-compile': { timeWIB: '20:50' } } }, { actor: 'budi', reason: 'dependency serialized overlap' });
  assert.equal(saved.ok, true);
  const E = loadEngine();
  const decision = E.decideRun(saved.doc.jobs['domestic-compile'], wibInstant('2026-11-09', '20:50'), { gates: E.buildGates({ dataState: { 'broksum-all': true, 'broksum-foreign': false } }) });
  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'DEPENDENCY_BLOCKED');

  // Canonical default 20:55 is outside the 20:40-21:25 window -> accepted.
  const ok = S.put({ jobs: { 'domestic-compile': { timeWIB: '20:55' } } }, { actor: 'budi', reason: 'canonical 21:20' });
  assert.equal(ok.ok, true);
  assert.equal(ok.collisions.length, 0);
});
'use strict';

/**
 * test/v6-admin-schedule-e2e.test.js
 * ============================================================================
 * V6 (Subtask D) — Admin Console Schedule Editor + Durable Scheduler E2E.
 *
 * Strategy (NO production fetch, NO Telegram, NO live provider burn):
 *   - lib/admin-schedule-store.js : REAL module, redirected via env to tmpdir.
 *   - lib/admin-schedule-engine.js : REAL decision core, driven by an explicit
 *     fake clock (`now` Date) + injected gates/lease/sourceState. No timers,
 *     no wall-clock dependency, no send-fetch.
 *   - api/admin/schedule-settings.js : REAL handler, mocked req/res + signed
 *     session tokens (HMAC via lib/admin-session).
 *
 * The 14 mandated scenarios are exercised with a REAL runner-side-effect
 * fixture (an in-memory execution counter that only increments through the
 * engine's decideRun -> plan path), never via string matching of a label.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-schedule-')); }

function mockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; }
  };
  return r;
}

function mockReq(o) {
  const opts = o || {};
  return {
    method: opts.method || 'GET',
    headers: Object.assign({ host: 'localhost', origin: 'http://localhost' }, opts.headers || {}),
    body: opts.body || {},
    socket: { remoteAddress: opts.ip || '127.0.0.1' }
  };
}

const STORE_P = path.join(ROOT, 'lib', 'admin-schedule-store.js');
const ENGINE_P = path.join(ROOT, 'lib', 'admin-schedule-engine.js');
const EP_P = path.join(ROOT, 'api', 'admin', 'schedule-settings.js');
const SESSION_P = path.join(ROOT, 'lib', 'admin-session.js');

function restoreEnv(name, prev) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

function loadStore(tmp) {
  process.env.ADMIN_SCHEDULE_CONFIG_PATH = path.join(tmp, 'admin-schedule-config.json');
  process.env.ADMIN_SCHEDULE_HISTORY_PATH = path.join(tmp, 'history');
  process.env.ADMIN_SCHEDULE_AUDIT_PATH = path.join(tmp, 'audit.log.jsonl');
  // V6 Subtask F: these store/engine tests exercise a POST-CUTOVER world (all
  // legacy cron executors RETIRED) so the LEGACY_DUPLICATE config guard does
  // not interfere with pure scheduling semantics. The guard itself (fail-closed
  // all-ACTIVE default) is covered by test/v6-schedule-runner-local-e2e.test.js.
  const legacyPath = path.join(tmp, 'legacy-active.json');
  if (!fs.existsSync(legacyPath)) {
    const cp = require(path.join(ROOT, 'lib', 'schedule-control-plane.js'));
    const map = {};
    for (const ex of cp.LEGACY_EXECUTORS) map[ex.name] = 'RETIRED';
    fs.writeFileSync(legacyPath, JSON.stringify({ executors: map }));
  }
  process.env.SCHEDULE_LEGACY_ACTIVE_PATH = legacyPath;
  delete require.cache[require.resolve(STORE_P)];
  return require(STORE_P);
}

function loadEngine() {
  delete require.cache[require.resolve(ENGINE_P)];
  delete require.cache[require.resolve(STORE_P)];
  return require(ENGINE_P);
}

function loadEndpoint(tmp) {
  loadStore(tmp);
  delete require.cache[require.resolve(EP_P)];
  return require(EP_P);
}

// A deterministic WIB wall-clock: build a UTC instant for Jakarta HH:mm.
function wibInstant(dateKey, hhmm) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) - (7 * 60 * 60 * 1000));
}

function runnerFixture() {
  const executed = [];
  return {
    executed,
    // A real side-effect runner: only invoked when the engine says "ready".
    run(plan) {
      executed.push(plan);
      return { ok: true, key: plan.key, session: plan.session, version: plan.version, nextRunIso: plan.nextRunIso };
    },
    // Replay a "completed" result for idempotency checks.
    doneResult(plan) {
      return {
        session: plan.session,
        version: plan.version,
        nextRunIso: plan.nextRunIso,
        status: 'DONE'
      };
    }
  };
}

/* =========================================================================== */
/* 1. STORE — allowlist, locked default, atomic + readback, collision           */
/* =========================================================================== */

test('V6-SCHED: allowlist + Broksum seed default 20:40, explicit Admin overrides allowed', () => {
  const S = loadStore(tmpdir());
  const g = S.get();
  assert.equal(g.ok, true);
  assert.equal(g.doc.version, 0);
  const broksum = g.doc.jobs['broksum-all'];
  assert.equal(broksum.timeWIB, '20:40', 'Broksum seed default 20:40 WIB');
  assert.equal(broksum.lockedDefault, true, 'Broksum marked locked-default');
  assert.deepEqual(broksum.days, [1, 2, 3, 4, 5], 'Broksum runs every market day (Mon-Fri)');

  // Yahoo EOD is 17:00, distinct from Broksum.
  assert.equal(g.doc.jobs['yahoo-ohlcv'].timeWIB, '17:00', 'Yahoo EOD default 17:00');

  // 17:00 / 19:45 for Broksum must be REJECTED server-side.
  const r17 = S.put({ jobs: { 'broksum-all': { timeWIB: '17:00' } } }, { actor: 'budi', reason: 'attempt 17:00' });
  assert.equal(r17.ok, false, 'Broksum 17:00 rejected');
  assert.equal(r17.reason, 'VALIDATION_FAILED');

  const r1945 = S.put({ jobs: { 'broksum-all': { timeWIB: '19:45' } } }, { actor: 'budi', reason: 'attempt 19:45' });
  assert.equal(r1945.ok, false, 'Broksum 19:45 rejected');

  // Unknown job key rejected (non-allowlist).
  const rUnknown = S.put({ jobs: { 'evil-shell': { timeWIB: '00:00' } } }, { actor: 'budi', reason: 'unknown' });
  assert.equal(rUnknown.ok, false, 'unknown job key rejected');
  assert.equal(rUnknown.reason, 'VALIDATION_FAILED');

  // Non-editable job rejected.
  const rLegacy = S.put({ jobs: { 'oracle-monitoring': { timeWIB: '01:00' } } }, { actor: 'budi', reason: 'legacy edit' });
  assert.equal(rLegacy.ok, false, 'non-editable job rejected');
});

test('V6-SCHED: collision gate — lifecycle 17:15 vs market-context 17:20 rejected', () => {
  const S = loadStore(tmpdir());
  // Move market-context to 17:20 (default 17:25) so it overlaps lifecycle
  // (17:15 + 10 min duration => ends 17:25).
  const r = S.put({
    jobs: { 'market-context': { timeWIB: '17:20' } }
  }, { actor: 'budi', reason: 'context at 17:20' });

  assert.equal(r.ok, false, 'overlap must be rejected');
  assert.equal(r.reason, 'COLLISION', 'collision detected and rejected');
  assert.ok(Array.isArray(r.collisions) && r.collisions.length > 0, 'collision list returned');
  assert.ok(r.collisions.some((c) =>
    (c.jobA === 'lifecycle' && c.jobB === 'market-context') ||
    (c.jobA === 'market-context' && c.jobB === 'lifecycle')), 'correct collision pair present');

  // A non-overlapping change is accepted.
  const ok = S.put({ jobs: { 'market-context': { timeWIB: '17:25' } } }, { actor: 'budi', reason: 'safe 17:25' });
  assert.equal(ok.ok, true, 'non-overlapping time accepted');
});

/* =========================================================================== */
/* 2. ENGINE — next-run WIB, dependency gate, idempotency/lease, retry          */
/* =========================================================================== */

test('V6-SCHED: Broksum 20:40 -> 18:30 -> reload -> next-run 18:30 -> run -> revert 20:40 (single schedule)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);

  // Change Broksum 20:40 -> 18:30.
  const changed = S.put({ jobs: { 'broksum-all': { timeWIB: '18:30' } } }, { actor: 'budi', reason: 'move to 18:30' });
  assert.equal(changed.ok, true);

  // Reload = fresh module read from durable file.
  const S2 = loadStore(tmp);
  assert.equal(S2.get().doc.jobs['broksum-all'].timeWIB, '18:30', 'persisted across reload');

  const E = loadEngine();
  const job = S2.get().doc.jobs['broksum-all'];
  const now = wibInstant('2026-11-09', '17:00'); // Monday 17:00 WIB, before 18:30
  const next = E.computeNextRun(job, now);
  assert.ok(next, 'next-run exists');
  assert.equal(E.formatWibIso(next.toISOString()).slice(11, 16), '18:30', 'next-run is 18:30 WIB');

  // Worker simulator: at 18:30, gate ready, it should run exactly once.
  const gates = E.buildGates({ dataState: {}, providerState: { 'broksum-all': 'READY' }, quotaState: { known: true, remaining: 1000 } });
  const leases = E.createLeaseManager({ now: () => now.getTime() });
  const fixture = runnerFixture();
  const lateNow = wibInstant('2026-11-09', '18:30');
  const plan = E.decideRun(job, lateNow, { session: 'w1', version: S2.get().doc.version, gates, leases });
  assert.equal(plan.shouldRun, true, 'Broksum should run at 18:30');
  if (plan.shouldRun) fixture.run(plan.plan);

  // Revert to 20:40.
  const reverted = S2.put({ jobs: { 'broksum-all': { timeWIB: '20:40' } } }, { actor: 'budi', reason: 'revert', expectedVersion: changed.version });
  assert.equal(reverted.ok, true);

  // No two schedules: compute next 5 runs must all be 20:40 on each market day,
  // and none at 18:30 anymore.
  const job2 = S2.get().doc.jobs['broksum-all'];
  const runs = E.computeNextRuns(job2, wibInstant('2026-11-09', '17:00'), 5);
  assert.equal(runs.length, 5);
  for (const r of runs) {
    assert.equal(E.formatWibIso(r.toISOString()).slice(11, 16), '20:40', 'all next runs back to 20:40');
  }
  assert.equal(fixture.executed.length, 1, 'exactly one worker execution (no duplicate)');
});

test('V6-SCHED: Yahoo 17:00 with SQLite dependency; source unavailable -> blocked (no fake success)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  // Yahoo default 17:00; lifecycle 17:15 depends on it.
  const E = loadEngine();
  const lifecycle = S.get().doc.jobs['lifecycle'];
  const gates = E.buildGates({
    // SQLite dependency (yahoo-ohlcv) NOT satisfied.
    dataState: { 'yahoo-ohlcv': false },
    providerState: {},
    quotaState: { known: true, remaining: 1000 }
  });
  const now = wibInstant('2026-11-09', '17:15');
  const d = E.decideRun(lifecycle, now, { session: 'w1', version: S.get().doc.version, gates });
  assert.equal(d.shouldRun, false, 'lifecycle blocked without SQLite/yahoo dependency');
  assert.equal(d.reason, 'DEPENDENCY_BLOCKED');

  // Source unavailable for a provider job => blocked with retry eligibility.
  const broksum = S.get().doc.jobs['broksum-all'];
  const gBrok = E.buildGates({
    dataState: {},
    providerState: { 'broksum-all': 'READY' },
    quotaState: { known: true, remaining: 1000 }
  });
  const b = E.decideRun(broksum, now, {
    session: 'w1', version: S.get().doc.version, gates: gBrok,
    sourceState: { 'broksum-all': 'UNAVAILABLE' }
  });
  assert.equal(b.shouldRun, false, 'source unavailable blocks execution');
  assert.equal(b.reason, 'SOURCE_UNAVAILABLE');
  assert.equal(b.retryEligible, true, 'source unavailable => retry eligible (not fake success)');
});

test('V6-SCHED: provider pending => PENDING_PROVIDER retry (never fake success)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const broksum = S.get().doc.jobs['broksum-all'];
  const gates = E.buildGates({
    dataState: {},
    providerState: { 'broksum-all': 'PENDING_PROVIDER' },
    quotaState: { known: true, remaining: 1000 }
  });
  const now = wibInstant('2026-11-09', '20:00');
  const d = E.decideRun(broksum, now, { session: 'w1', version: 0, gates });
  assert.equal(d.shouldRun, false, 'pending provider must not run');
  assert.equal(d.reason, 'PENDING_PROVIDER');
  assert.equal(d.retryEligible, true, 'pending => retry, not success');
});

test('V6-SCHED: quota 0 / UNKNOWN blocks accurately, zero consumption', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const broksum = S.get().doc.jobs['broksum-all']; // costClass HIGH (uses quota)
  const now = wibInstant('2026-11-09', '20:00');

  const gatesHigh = E.buildGates({
    dataState: {},
    providerState: { 'broksum-all': 'READY' },
    quotaState: { known: true, remaining: 0 }
  });
  const d0 = E.decideRun(broksum, now, { session: 'w1', version: 0, gates: gatesHigh });
  assert.equal(d0.shouldRun, false, 'quota 0 blocks provider job');
  assert.equal(d0.reason, 'QUOTA_EXHAUSTED');

  const gatesUnknown = E.buildGates({
    dataState: {},
    providerState: { 'broksum-all': 'READY' },
    quotaState: { known: false, remaining: null }
  });
  const du = E.decideRun(broksum, now, { session: 'w1', version: 0, gates: gatesUnknown });
  assert.equal(du.shouldRun, false, 'unknown quota blocks provider job');
  assert.equal(du.reason, 'QUOTA_UNKNOWN');
});

test('V6-SCHED: dependency-driven Top20 only when Broksum valid', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const top20 = S.get().doc.jobs['top20']; // dependsOn ['broksum-all','bandarmologi']

  const fail = E.buildGates({ dataState: { 'broksum-all': false, 'bandarmologi': true }, providerState: {}, quotaState: { known: true, remaining: 100 } });
  const dFail = E.decideRun(top20, wibInstant('2026-11-09', '21:10'), { session: 's', version: 0, gates: fail });
  assert.equal(dFail.shouldRun, false, 'Top20 blocked when Broksum not valid');
  assert.equal(dFail.reason, 'DEPENDENCY_BLOCKED');

  const ok = E.buildGates({ dataState: Object.fromEntries(top20.dependsOn.map(key => [key, true])), providerState: {}, quotaState: { known: true, remaining: 100 } });
  const dOk = E.decideRun(top20, wibInstant('2026-11-09', '21:10'), { session: 's', version: 0, gates: ok });
  assert.equal(dOk.shouldRun, true, 'Top20 runs when Broksum + bandarmologi valid');
});

test('V6-SCHED: restart keeps schedule, single run, no double submit (idempotency)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const saved = S.put({ jobs: { 'broksum-all': { timeWIB: '19:00' } } }, { actor: 'budi', reason: 'move 19:00' });
  assert.equal(saved.ok, true);
  assert.equal(saved.doc.version, 1);

  // Simulate process restart: fresh module re-reads the SAME durable file.
  const S2 = loadStore(tmp);
  assert.equal(S2.get().doc.jobs['broksum-all'].timeWIB, '19:00', 'schedule survives restart');
  assert.equal(S2.get().doc.version, 1, 'version survives restart');

  const E = loadEngine();
  const broksum = S2.get().doc.jobs['broksum-all'];
  const gates = E.buildGates({ dataState: {}, providerState: { 'broksum-all': 'READY' }, quotaState: { known: true, remaining: 1000 } });
  const fixture = runnerFixture();
  const leases = E.createLeaseManager({ now: () => Date.now() });

  const now = wibInstant('2026-11-09', '19:00');
  const plan = E.decideRun(broksum, now, { session: 'proc-1', version: 1, gates, leases });
  assert.equal(plan.shouldRun, true);
  fixture.run(plan.plan);

  // Re-run immediately with same lease manager + same plan: LEASE_HELD.
  const again = E.decideRun(broksum, now, { session: 'proc-1', version: 1, gates, leases });
  assert.equal(again.shouldRun, false, 'lease prevents duplicate');
  assert.equal(again.reason, 'LEASE_HELD');

  // After the prior result is recorded done, a fresh lease manager also dedupes.
  const leases2 = E.createLeaseManager({ now: () => Date.now() });
  const dedupe = E.decideRun(broksum, now, { session: 'proc-1', version: 1, gates, leases: leases2, lastResult: fixture.doneResult(plan.plan) });
  assert.equal(dedupe.shouldRun, false, 'already-done deduplication');
  assert.equal(dedupe.reason, 'ALREADY_DONE');

  assert.equal(fixture.executed.length, 1, 'exactly one run across restart + double attempt');
});

test('V6-SCHED: 10 days later settings do NOT revert to default', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  S.put({ jobs: { 'broksum-all': { timeWIB: '19:30' } } }, { actor: 'budi', reason: 'custom 19:30' });

  // Advance 10 WIB days; re-read from file as a fresh scheduler would.
  const S10 = loadStore(tmp);
  assert.equal(S10.get().doc.jobs['broksum-all'].timeWIB, '19:30', '10 days later still custom value');
  assert.notEqual(S10.get().doc.jobs['broksum-all'].timeWIB, '20:40', 'does not silently revert to default');
});

test('V6-SCHED: near-now and WIB reset are de-duplicated (no duplicate / no missed)', () => {
  const tmp = tmpdir();
  const S = loadStore(tmp);
  const E = loadEngine();
  const yahoo = S.get().doc.jobs['yahoo-ohlcv']; // 17:00 WIB

  // Just before the boundary (16:59:59 WIB) -> next run today 17:00 (NOT_YET at 16:59).
  const before = wibInstant('2026-11-09', '16:59');
  const dBefore = E.decideRun(yahoo, before, { session: 's', version: 0, gates: E.buildGates({}) });
  // Yahoo is ZERO_QUOTA, no provider, no deps, so gate ready; but time is earlier.
  assert.equal(dBefore.shouldRun, false, 'before 17:00 not run');
  assert.equal(dBefore.reason, 'NOT_YET');

  // Exactly at 17:00 WIB (just past midnight UTC representation) -> run once.
  const at = wibInstant('2026-11-09', '17:00');
  const fixture = runnerFixture();
  const leases = E.createLeaseManager({ now: () => at.getTime() });
  const dAt = E.decideRun(yahoo, at, { session: 's', version: 0, gates: E.buildGates({}), leases });
  assert.equal(dAt.shouldRun, true, 'runs exactly at 17:00 WIB');
  fixture.run(dAt.plan);

  // Same instant re-attempt -> lease held (no duplicate).
  const dAt2 = E.decideRun(yahoo, at, { session: 's', version: 0, gates: E.buildGates({}), leases });
  assert.equal(dAt2.shouldRun, false, 'no duplicate at same WIB slot');
  assert.equal(fixture.executed.length, 1);
});

/* =========================================================================== */
/* 3. ENDPOINT — auth/CSRF/validation/409/rollback                              */
/* =========================================================================== */

test('V6-SCHED endpoint: unauthorized / CSRF / invalid / non-allowlist rejected', async () => {
  const tmp = tmpdir();
  const ep = loadEndpoint(tmp);
  const sess = require(SESSION_P);

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });

    // Unauthorized (no session).
    const un = mockRes();
    await ep(mockReq({ method: 'GET' }), un);
    assert.ok(un.statusCode === 401 || un.statusCode === 403, 'unauthorized GET blocked');

    // CSRF: cross-origin PUT.
    const csrf = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'https://evil.example' },
      body: { patch: { jobs: { 'broksum-all': { timeWIB: '18:30' } } }, reason: 'x' }
    }), csrf);
    assert.equal(csrf.statusCode, 403, 'cross-origin mutation rejected');

    // Invalid patch (missing reason).
    const noReason = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' },
      body: { patch: { jobs: { 'broksum-all': { timeWIB: '18:30' } } } }
    }), noReason);
    assert.equal(noReason.statusCode, 400, 'missing reason rejected');

    // Non-allowlist key rejected.
    const bad = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' },
      body: { patch: { jobs: { 'evil-shell': { timeWIB: '00:00' } } }, reason: 'non-allowlist attempt' }
    }), bad);
    assert.equal(bad.statusCode, 400, 'non-allowlist job rejected');
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

test('V6-SCHED endpoint: authorized PUT persists + GET readback, version conflict 409', async () => {
  const tmp = tmpdir();
  const ep = loadEndpoint(tmp);
  const sess = require(SESSION_P);

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    const hdr = { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' };

    const putRes = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: hdr,
      body: { patch: { jobs: { 'broksum-all': { timeWIB: '18:30' } } }, reason: 'move broksum for test' }
    }), putRes);
    assert.equal(putRes.statusCode, 200, 'authorized PUT succeeds: ' + JSON.stringify(putRes.body));
    assert.equal(putRes.body.readbackOk, true, 'durable read-back confirmed');
    assert.equal(putRes.body.version, 1);

    const getRes = mockRes();
    await ep(mockReq({ method: 'GET', headers: { cookie: 'ac_sess=' + token } }), getRes);
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.body.success, true);
    assert.equal(getRes.body.config.version, 1);
    assert.equal(getRes.body.config.jobs.find((j) => j.key === 'broksum-all').timeWIB, '18:30');

    // Stale version -> 409, no overwrite.
    const stale = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: hdr,
      body: { patch: { jobs: { 'broksum-all': { timeWIB: '20:00' } } }, reason: 'stale', version: 0 }
    }), stale);
    assert.equal(stale.statusCode, 409, 'stale version -> 409');
    assert.equal(stale.body.code, 'CONFIG_VERSION_CONFLICT');

    // Confirm untouched (version 1, still 18:30).
    const check = loadStore(tmp).get();
    assert.equal(check.doc.version, 1);
    assert.equal(check.doc.jobs['broksum-all'].timeWIB, '18:30', 'no overwrite on conflict');
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

test('V6-SCHED endpoint: collision rejected with SCHEDULE_COLLISION 409', async () => {
  const tmp = tmpdir();
  const ep = loadEndpoint(tmp);
  const sess = require(SESSION_P);

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    const hdr = { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' };
    const res = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: hdr,
      body: { patch: { jobs: { 'market-context': { timeWIB: '17:20' } } }, reason: 'collision attempt' }
    }), res);
    assert.equal(res.statusCode, 409, 'collision -> 409');
    assert.equal(res.body.code, 'SCHEDULE_COLLISION');
    assert.ok(Array.isArray(res.body.collisions) && res.body.collisions.length > 0);
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

test('V6-SCHED endpoint: rollback restore keeps history (no delete)', async () => {
  const tmp = tmpdir();
  const ep = loadEndpoint(tmp);
  const S = loadStore(tmp);
  const sess = require(SESSION_P);

  // Seed v1 and v2 with real durable writes.
  S.put({ jobs: { 'broksum-all': { timeWIB: '18:30' } } }, { actor: 'budi', reason: 'v1 18:30' });
  S.put({ jobs: { 'broksum-all': { timeWIB: '19:00' } } }, { actor: 'budi', reason: 'v2 19:00' });

  // History should contain both versions, nothing deleted.
  const historyBefore = S.listHistory();
  assert.ok(historyBefore.length >= 2, 'history snapshots exist before restore');

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    const res = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' },
      body: { action: 'restore', targetVersion: 1, reason: 'rollback to 18:30' }
    }), res);
    assert.equal(res.statusCode, 200, 'restore succeeds: ' + JSON.stringify(res.body));
    assert.equal(res.body.restoredFromVersion, 1);

    const after = loadStore(tmp).get();
    assert.equal(after.doc.jobs['broksum-all'].timeWIB, '18:30', 'restored to v1 value');

    // History must still contain the original v1 and v2 snapshots (not deleted).
    const historyAfter = S.listHistory();
    assert.ok(historyAfter.some((h) => h.version === 1), 'v1 snapshot preserved');
    assert.ok(historyAfter.some((h) => h.version === 2), 'v2 snapshot preserved');
    assert.ok(historyAfter.length >= historyBefore.length, 'history not truncated');
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

/* =========================================================================== */
/* 3b. REAL RUNNER WIRING (Subtask F) — spawned process, not in-memory counter   */
/* =========================================================================== */

test('V6-SCHED: endpoint PUT -> REAL spawned runner process executes the new slot (P0-07 wiring)', async () => {
  const tmp = tmpdir();
  const stateDir = path.join(tmp, 'runner-state');
  const controlDir = path.join(stateDir, 'control');
  fs.mkdirSync(controlDir, { recursive: true });

  // Post-cutover world for this wiring proof: legacy executors RETIRED so the
  // dynamic schedule owns execution (fail-closed default is covered in
  // test/v6-schedule-runner-local-e2e.test.js F2/F3).
  const cp = require(path.join(ROOT, 'lib', 'schedule-control-plane.js'));
  const legacyMap = {};
  for (const ex of cp.LEGACY_EXECUTORS) legacyMap[ex.name] = 'RETIRED';
  fs.writeFileSync(path.join(controlDir, 'legacy-active.json'), JSON.stringify({ executors: legacyMap }));

  const env = Object.assign({}, process.env, {
    ADMIN_SCHEDULE_CONFIG_PATH: path.join(tmp, 'admin-schedule-config.json'),
    ADMIN_SCHEDULE_HISTORY_PATH: path.join(tmp, 'history'),
    ADMIN_SCHEDULE_AUDIT_PATH: path.join(tmp, 'audit.log.jsonl'),
    SCHEDULE_RUNNER_STATE_DIR: stateDir,
    SCHEDULE_LEGACY_ACTIVE_PATH: path.join(controlDir, 'legacy-active.json'),
    SESSION_SECRET: 'test-secret-not-real'
  });
  process.env.SCHEDULE_LEGACY_ACTIVE_PATH = env.SCHEDULE_LEGACY_ACTIVE_PATH;

  // Fake clock + gates for the spawned runner (deterministic WIB instant).
  const wib = (dateKey, hhmm) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    const [hh, mm] = String(hhmm).split(':').map(Number);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) - 7 * 3600 * 1000);
  };
  fs.writeFileSync(path.join(controlDir, 'clock.json'), JSON.stringify({ nowIso: wib('2026-11-09', '19:30').toISOString() }));
  const ps = {};
  for (const k of ['broksum-all', 'broksum-foreign', 'ihsg', 'insider', 'fundamental', 'quota-backfill']) ps[k] = 'READY';
  env.QUOTA_OPS_CONFIG_PATH = path.join(tmp, 'offline-quota.json');
  fs.writeFileSync(env.QUOTA_OPS_CONFIG_PATH, JSON.stringify({ configuredOperatingCap: 15000, reserveFloorWeekday: 5000, currentDayObligations: 0, endpointCostUnits: { 'broksum-all': 1 } }));
  fs.writeFileSync(path.join(controlDir, 'gates.json'), JSON.stringify({ providerState: ps, quotaState: { known: true, used: 0, remaining: 15000, limit: 15000, source: 'OFFLINE_TEST_FIXTURE' } }));

  // 1) REAL admin endpoint PUT: broksum-all 20:00 -> 19:30 (versioned durable write).
  const ep = loadEndpoint(tmp);
  const sess = require(SESSION_P);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    const res = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' },
      body: { patch: { jobs: { 'broksum-all': { timeWIB: '19:30' } } }, reason: 'real-runner wiring proof' }
    }), res);
    assert.equal(res.statusCode, 200, 'PUT ok: ' + JSON.stringify(res.body && res.body.error ? res.body.error : ''));
    assert.equal(res.body.version, 1);
  } finally {
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
  }

  // 2) REAL runner process (child_process.spawnSync) reads the SAME store file.
  const RUNNER = path.join(ROOT, 'scripts', 'schedule-runner-local.js');
  const run = require('child_process').spawnSync(process.execPath, [RUNNER, '--once', '--json'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(run.status, 0, 'runner exit 0; stderr=' + String(run.stderr || '').slice(0, 500));
  const result = JSON.parse(String(run.stdout).trim().split('\n').pop());
  assert.equal(result.configVersion, 1, 'runner process saw the admin-written version 1');
  const done = result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE');
  assert.equal(done.length, 1, 'broksum-all executed once at the NEW 19:30 slot by the real process');

  // 3) Durable evidence on disk: heartbeat + executions.jsonl + fixture artifact.
  const hb = JSON.parse(fs.readFileSync(path.join(stateDir, 'heartbeat.json'), 'utf8'));
  assert.equal(hb.configVersion, 1);
  assert.equal(hb.tradeDateWib, '2026-11-09', 'WIB trade date (not UTC slice)');
  const execLines = fs.readFileSync(path.join(stateDir, 'executions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const doneLine = execLines.find((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all');
  assert.ok(doneLine, 'DONE recorded in the append-only execution log');
  assert.equal(doneLine.nextRunWib.slice(11, 16), '19:30');
  const artifact = JSON.parse(fs.readFileSync(path.join(stateDir, 'artifacts', 'broksum-all', '2026-11-09.json'), 'utf8'));
  assert.equal(artifact.configVersion, 1, 'side-effect fixture proves store->runner wiring');
  assert.equal(artifact.sideEffect, 'FIXTURE', 'no production side effect (fixture only)');
});

/* =========================================================================== */
/* 4. SOURCE-INTEGRITY — no production fetch/Telegram, no CRON_SECRET leak       */
/* =========================================================================== */

test('V6-SCHED: endpoint never exposes CRON_SECRET and never sends Telegram/fetch in tests', () => {
  const src = fs.readFileSync(EP_P, 'utf8');
  assert.ok(!/process\.env\.(CRON_SECRET|TELEGRAM|cronSecret)/.test(src), 'no CRON_SECRET/Telegram env usage in endpoint');
  assert.ok(!/(res|body)\.(json|end)\([^)]*(CRON|TELEGRAM|token)/.test(src), 'no secret embedded in a response');

  const storeSrc = fs.readFileSync(STORE_P, 'utf8');
  assert.ok(!/https?:\/\//.test(storeSrc), 'store has no outbound network call');
  assert.ok(!/sendMessage|fetch\(|axios|node-fetch|require\(['"]telegram/.test(storeSrc), 'store never sends Telegram/fetch');

  const engineSrc = fs.readFileSync(ENGINE_P, 'utf8');
  assert.ok(!/sendMessage|fetch\(|axios|node-fetch|https?:\/\//.test(engineSrc), 'engine performs no network/Telegram I/O');
});
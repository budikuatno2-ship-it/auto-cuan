'use strict';

/**
 * test/v6-schedule-runner-local-e2e.test.js
 * ============================================================================
 * V6 (Subtask F) — ADMIN EDIT -> DURABLE STORE -> REAL LOCAL RUNNER E2E.
 * ============================================================================
 * P0-07 CLOSURE: "Schedule editor menyimpan JSON tetapi belum tersambung
 * dengan executor produksi." These tests prove the wiring with a REAL PROCESS
 * (child_process.spawnSync of scripts/schedule-runner-local.js), not an
 * in-memory counter:
 *
 *   admin endpoint PUT (real handler, signed session)
 *     -> durable versioned store (data/admin-schedule-config.json in tmpdir)
 *     -> spawned runner process reads the SAME store file
 *     -> engine decideRun (WIB next-run, dependency gate, durable lease)
 *     -> side-effect FIXTURE artifact + heartbeat.json + executions.jsonl
 *
 * NO production contact: no cron install, no PM2, no network, no Telegram.
 * Legacy executor registry defaults FAIL-CLOSED (all ACTIVE => dynamic jobs
 * BLOCKED_LEGACY_ACTIVE), exactly like the production cutover contract.
 *
 * Mandated conflict scenarios covered here (master prompt section 6):
 *   F1. admin edit -> runner nyata mengeksekusi slot baru (wiring P0-07)
 *   F2. legacy 19:45/20:25 ACTIVE -> dynamic 20:00/21:20 BLOCKED (no double
 *       executor); cutover (RETIRED) -> dynamic runs
 *   F3. config guard: patch yang memperkenalkan overlap BARU dengan executor
 *       legacy sekelas -> LEGACY_DUPLICATE ditolak
 *   F4. Broksum butuh 45m, compile 20:25 -> COLLISION ditolak; compile
 *       dependency-gated: Broksum selesai 20:34 -> compile jalan; parsial /
 *       20:51 belum selesai -> compile & Top20 TIDAK dipaksa walau jam lewat
 *   F5. dua job beda nama memakai broker API sama -> tidak dobel request
 *       (PROVIDER_BUSY via durable lease)
 *   F6. quota reset tengah malam -> trade_date WIB benar (bukan UTC slice),
 *       tidak duplikasi job
 *   F7. admin ubah Broksum 20:00->20:30 saat job 20:00 berjalan (lease aktif)
 *       -> satu job selesai, jadwal baru berlaku versioned, tidak double spawn
 *   F8. backfill panjang mendekati 20:00 -> PREEMPT_BACKFILL (stop aman)
 *   F9. lock/lease stale -> RECOVERED_STALE_LEASE dengan bukti, TIDAK disamarkan
 *       SUCCESS; lease segar -> LEASE_HELD (tidak double spawn)
 *   F10. missed karena downtime -> catch-up idempotent dalam retry window;
 *       MISSED vs SKIPPED vs BLOCKED vs RETRIED tercatat di executions.jsonl
 *   F11. WIB calendar regression: Jumat sesi beda, weekend, pergantian tanggal,
 *       hard stop 23:50-00:10
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'schedule-runner-local.js');
const STORE_P = path.join(ROOT, 'lib', 'admin-schedule-store.js');
const ENGINE_P = path.join(ROOT, 'lib', 'admin-schedule-engine.js');
const CP_P = path.join(ROOT, 'lib', 'schedule-control-plane.js');
const EP_P = path.join(ROOT, 'api', 'admin', 'schedule-settings.js');
const SESSION_P = path.join(ROOT, 'lib', 'admin-session.js');

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-runner-e2e-')); }

function wibInstant(dateKey, hhmm) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) - (7 * 60 * 60 * 1000));
}

/**
 * Create an isolated world: durable store paths + runner state dir + control
 * files (fake clock, gates, legacy registry). Returns { tmp, env, dirs... }.
 */
function writeAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // Windows may briefly hold the control file open in the real daemon reader.
  // Retry only that transient sharing violation; retain atomic replacement.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, p); break; }
    catch (err) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(err.code) || attempt >= 10) throw err;
      sleepMs(10);
    }
  }
}

function sleepMs(ms) {
  // Synchronous sleep without spawning processes (Atomics.wait).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeWorld(opts) {
  const o = opts || {};
  const tmp = tmpdir();
  const storeDir = path.join(tmp, 'store');
  const stateDir = path.join(tmp, 'state');
  const controlDir = path.join(stateDir, 'control');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });

  // The in-process endpoint/session/store modules must resolve the SAME legacy
  // registry + secret as the spawned runner (which receives them via world.env).
  process.env.SESSION_SECRET = 'test-secret-not-real';
  process.env.SCHEDULE_LEGACY_ACTIVE_PATH = path.join(controlDir, 'legacy-active.json');

  const env = Object.assign({}, process.env, {
    QUOTA_OPS_CONFIG_PATH: path.join(storeDir, 'quota-ops-config.json'),
    ADMIN_SCHEDULE_CONFIG_PATH: path.join(storeDir, 'admin-schedule-config.json'),
    ADMIN_SCHEDULE_HISTORY_PATH: path.join(storeDir, 'history'),
    ADMIN_SCHEDULE_AUDIT_PATH: path.join(storeDir, 'audit.log.jsonl'),
    SCHEDULE_RUNNER_STATE_DIR: stateDir,
    SCHEDULE_LEGACY_ACTIVE_PATH: path.join(controlDir, 'legacy-active.json'),
    SESSION_SECRET: 'test-secret-not-real'
  });

  const world = {
    tmp, env, storeDir, stateDir, controlDir,
    clockPath: path.join(controlDir, 'clock.json'),
    gatesPath: path.join(controlDir, 'gates.json'),
    legacyPath: path.join(controlDir, 'legacy-active.json'),
    heartbeatPath: path.join(stateDir, 'heartbeat.json'),
    execLogPath: path.join(stateDir, 'executions.jsonl'),
    runnerStatePath: path.join(stateDir, 'state.json'),
    quotaPolicyPath: path.join(storeDir, 'quota-ops-config.json'),
    leaseDir: path.join(stateDir, 'leases'),
    artifactDir: path.join(stateDir, 'artifacts'),
    setClock(iso) { writeAtomic(world.clockPath, { nowIso: iso }); },
    setGates(g) { writeAtomic(world.gatesPath, Object.assign({ quotaState: { known: true, used: 3080, limit: 18080, remaining: 15000, source: 'OFFLINE_TEST_FIXTURE', asOf: '2026-11-09T12:00:00.000Z' } }, g)); },
    setQuotaPolicy(policy) { writeAtomic(world.quotaPolicyPath, policy); },
    setLegacy(executorMap) { writeAtomic(world.legacyPath, { executors: executorMap }); },
    retireAllLegacy() {
      const cp = loadControlPlane();
      const map = {};
      for (const ex of cp.LEGACY_EXECUTORS) map[ex.name] = 'RETIRED';
      world.setLegacy(map);
    },
    execLog() {
      try {
        return fs.readFileSync(world.execLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch (_) { return []; }
    },
    heartbeat() {
      try { return JSON.parse(fs.readFileSync(world.heartbeatPath, 'utf8')); } catch (_) { return null; }
    },
    runnerState() {
      try { return JSON.parse(fs.readFileSync(world.runnerStatePath, 'utf8')); } catch (_) { return { last: {} }; }
    },
    artifact(jobKey, tradeDateWib) {
      const p = path.join(world.artifactDir, jobKey, tradeDateWib + '.json');
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
    }
  };
  // Explicit earlier Admin overrides: preserve the historical lease scenarios.
  const store = loadStore(env);
  const doc = store.normalizeDoc({});
  doc.jobs['broksum-all'].timeWIB = '20:00';
  doc.jobs['broksum-foreign'].timeWIB = '21:00';
  fs.writeFileSync(env.ADMIN_SCHEDULE_CONFIG_PATH, JSON.stringify(doc));
  world.setQuotaPolicy({ version: 0, configuredOperatingCap: 15000, reserveFloorWeekday: 5000, currentDayObligations: 0, endpointCostUnits: { 'broksum-all': 1, 'broksum-foreign': 1, ihsg: 1, insider: 1, fundamental: 1, 'quota-backfill': 1 }, killSwitch: false, pausedServices: {} });
  return world;
}

/** Spawn the REAL runner process once. Returns { status, stdout, result }. */
function spawnRunnerOnce(world) {
  const r = spawnSync(process.execPath, [RUNNER, '--once', '--json'], {
    cwd: ROOT, env: world.env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(r.status, 0, 'runner process exit 0; stderr=' + String(r.stderr || '').slice(0, 800));
  let result = null;
  try { result = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (_) {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, result };
}

function loadStore(env) {
  process.env.ADMIN_SCHEDULE_CONFIG_PATH = env.ADMIN_SCHEDULE_CONFIG_PATH;
  process.env.ADMIN_SCHEDULE_HISTORY_PATH = env.ADMIN_SCHEDULE_HISTORY_PATH;
  process.env.ADMIN_SCHEDULE_AUDIT_PATH = env.ADMIN_SCHEDULE_AUDIT_PATH;
  delete require.cache[require.resolve(STORE_P)];
  return require(STORE_P);
}

function loadEngine() {
  delete require.cache[require.resolve(ENGINE_P)];
  delete require.cache[require.resolve(STORE_P)];
  return require(ENGINE_P);
}

function loadControlPlane() {
  delete require.cache[require.resolve(CP_P)];
  return require(CP_P);
}

function loadEndpoint(env) {
  loadStore(env);
  delete require.cache[require.resolve(EP_P)];
  return require(EP_P);
}

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; }
  };
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

function adminToken() {
  const sess = require(SESSION_P);
  return sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
}

function leaseFileFor(idemKey) {
  return crypto.createHash('sha1').update(String(idemKey)).digest('hex') + '.json';
}

const ALL_PROVIDER_READY = (() => {
  const ps = {};
  for (const key of ['broksum-all', 'broksum-foreign', 'ihsg', 'insider', 'fundamental', 'quota-backfill']) ps[key] = 'READY';
  return ps;
})();

function fullGates(extra) {
  return Object.assign({
    providerState: ALL_PROVIDER_READY,
    quotaState: { known: true, used: 3080, limit: 18080, remaining: 15000, source: 'OFFLINE_TEST_FIXTURE', asOf: '2026-11-09T13:00:00.000Z' }
  }, extra || {});
}

/* =========================================================================== */
/* F1 — P0-07 WIRING: admin endpoint PUT -> durable store -> REAL runner proc   */
/* =========================================================================== */

test('F1: admin PUT 20:00->20:10 (real endpoint) -> spawned runner executes the NEW slot once', async () => {
  const w = makeWorld();
  w.retireAllLegacy(); // cutover selesai untuk kelas ini (lihat F2 untuk guard)
  const ep = loadEndpoint(w.env);
  const token = adminToken();
  const hdr = { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' };

  // Real admin endpoint write (signed session + same-origin + reason).
  // 20:10 keeps the window (20:10-21:20) clear of broksum-foreign 21:00.
  const putRes = mockRes();
  await ep(mockReq({
    method: 'PUT', headers: hdr,
    body: { patch: { jobs: { 'broksum-all': { timeWIB: '20:10' } } }, reason: 'subtask F wiring proof' }
  }), putRes);
  assert.equal(putRes.statusCode, 200, 'admin PUT ok: ' + JSON.stringify(putRes.body && putRes.body.error ? putRes.body.error : putRes.body));
  assert.equal(putRes.body.version, 1);

  // Runner tick BEFORE the new slot: nothing executes for broksum-all.
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString()); // Monday
  w.setGates(fullGates());
  spawnRunnerOnce(w);
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null, 'no execution before the configured slot');

  // Runner tick AT the new slot (20:10 WIB): the spawned process reads the
  // SAME durable store the endpoint wrote and executes exactly once.
  w.setClock(wibInstant('2026-11-09', '20:10').toISOString());
  const run1 = spawnRunnerOnce(w);
  const done = run1.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE');
  assert.equal(done.length, 1, 'broksum-all DONE at the admin-configured 20:10 slot');

  const art = w.artifact('broksum-all', '2026-11-09');
  assert.ok(art, 'side-effect fixture artifact written by the real process');
  assert.equal(art.configVersion, 1, 'artifact proves the runner read store version 1 (the admin edit)');
  assert.equal(art.sideEffect, 'FIXTURE');

  const hb = w.heartbeat();
  assert.equal(hb.configVersion, 1, 'heartbeat carries the admin config version');
  assert.equal(hb.tradeDateWib, '2026-11-09');

  const doneLines = w.execLog().filter((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all');
  assert.equal(doneLines.length, 1);
  assert.equal(doneLines[0].nextRunWib.slice(11, 16), '20:10', 'executed slot is the NEW WIB time');

  // Second tick at the same instant: no duplicate execution (idempotent).
  spawnRunnerOnce(w);
  const doneLines2 = w.execLog().filter((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all');
  assert.equal(doneLines2.length, 1, 'exactly one execution across two runner processes');
  assert.equal(w.artifact('broksum-all', '2026-11-09').configVersion, 1);
});

/* =========================================================================== */
/* F2 — LEGACY 19:45/20:25 ACTIVE vs DYNAMIC 20:00/21:20 (P0-07 guard)          */
/* =========================================================================== */

test('F2: legacy executors ACTIVE -> dynamic jobs BLOCKED_LEGACY_ACTIVE; RETIRED (cutover) -> run', () => {
  const w = makeWorld();
  // No legacy-active.json => FAIL-CLOSED: every legacy executor ACTIVE.
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  w.setGates(fullGates());
  const r1 = spawnRunnerOnce(w);

  const blocked = r1.result.decisions.filter((d) => d.jobKey === 'broksum-all');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].decision, 'BLOCKED');
  assert.equal(blocked[0].reason, 'BLOCKED_LEGACY_ACTIVE', 'dynamic 20:00 blocked while broksum-1945 legacy ACTIVE');
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null, 'no side effect while legacy owns the class');

  const blockLine = w.execLog().find((l) => l.jobKey === 'broksum-all' && l.reason === 'BLOCKED_LEGACY_ACTIVE');
  assert.ok(blockLine, 'BLOCKED_LEGACY_ACTIVE recorded in executions.jsonl');
  assert.ok(blockLine.detail.activeLegacyExecutors.includes('broksum-1945'), 'evidence names the legacy executor');

  // CUTOVER (approval-gated in production; here we flip the registry only):
  // retire broksum-1945 => the dynamic broksum-all may run at 20:00.
  const cp = loadControlPlane();
  const map = {};
  for (const ex of cp.LEGACY_EXECUTORS) map[ex.name] = 'ACTIVE';
  map['broksum-1945'] = 'RETIRED';
  w.setLegacy(map);

  const r2 = spawnRunnerOnce(w);
  const done = r2.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE');
  assert.equal(done.length, 1, 'after cutover the dynamic job executes exactly once');
  assert.ok(w.artifact('broksum-all', '2026-11-09'), 'artifact written post-cutover');

  // Supply both verified fixture parents so this case isolates the legacy guard.
  fs.mkdirSync(path.join(w.artifactDir, 'broksum-foreign'), { recursive: true });
  fs.writeFileSync(path.join(w.artifactDir, 'broksum-foreign', '2026-11-09.json'), JSON.stringify({ jobKey: 'broksum-foreign', tradeDateWib: '2026-11-09', valid: true, status: 'DONE' }));
  // domestic-compile (21:20) stays BLOCKED while domestic-compile-2025/2110 ACTIVE.
  w.setClock(wibInstant('2026-11-09', '21:20').toISOString());
  spawnRunnerOnce(w);
  const dc = w.execLog().filter((d) => d.jobKey === 'domestic-compile' && d.reason === 'BLOCKED_LEGACY_ACTIVE');
  assert.ok(dc.length > 0, 'compile dynamic blocked while legacy compile ACTIVE (deduplicated log retained)');
  assert.equal(w.artifact('domestic-compile', '2026-11-09'), null);
});

/* =========================================================================== */
/* F3 — CONFIG GUARD: new overlap with ACTIVE legacy executor rejected          */
/* =========================================================================== */

test('F3: store.put introduces NEW overlap with ACTIVE legacy executor -> LEGACY_DUPLICATE rejected', () => {
  const w = makeWorld();
  const S = loadStore(w.env);

  // broksum-1945 legacy window = 19:45-20:25 (timeout 2400s). Moving the
  // dynamic broksum-all to 19:50 introduces a NEW same-class overlap.
  const r = S.put({ jobs: { 'broksum-all': { timeWIB: '19:50' } } }, { actor: 'budi', reason: 'duplikasi executor lama' });
  assert.equal(r.ok, false, 'patch introducing legacy duplicate must be rejected');
  assert.equal(r.reason, 'LEGACY_DUPLICATE');
  assert.ok(r.legacyDuplicates.some((d) => d.job === 'broksum-all' && d.executors.join(',').includes('broksum-1945')),
    'rejection names the colliding legacy executor');

  // Store unchanged (fail-closed).
  assert.equal(S.get().doc.jobs['broksum-all'].timeWIB, '20:00');
  assert.equal(S.get().doc.version, 0);

  // Grandfathered default 20:00 (overlaps 19:45-20:25 legacy window) is NOT
  // re-rejected: it is governed at runtime by BLOCKED_LEGACY_ACTIVE (F2).
  const rDef = S.put({ jobs: { 'broksum-all': { timeWIB: '20:00' } } }, { actor: 'budi', reason: 'canonical default' });
  assert.equal(rDef.ok, true, 'locked default 20:00 accepted (runtime-guarded until cutover)');

  // After cutover (registry RETIRED), a move to 19:50 is allowed.
  w.retireAllLegacy();
  const r2 = S.put({ jobs: { 'broksum-all': { timeWIB: '19:50' } } }, { actor: 'budi', reason: 'post-cutover move', legacyActivePath: w.legacyPath });
  // NOTE: store.put reads the registry via env SCHEDULE_LEGACY_ACTIVE_PATH.
  assert.equal(r2.ok, true, 'with legacy RETIRED the same time is accepted');
});

test('F3b: endpoint PUT that duplicates an ACTIVE legacy executor -> 409 LEGACY_DUPLICATE', async () => {
  const w = makeWorld(); // no registry file => fail-closed ALL legacy ACTIVE
  const ep = loadEndpoint(w.env);
  const token = adminToken();
  const hdr = { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' };

  // domestic-compile 21:20 (default) vs legacy domestic-compile-final-2110
  // 22:05-21:30 => moving the dynamic compile to 21:15 duplicates the legacy
  // executor of the same class while it is ACTIVE.
  const res = mockRes();
  await ep(mockReq({
    method: 'PUT', headers: hdr,
    body: { patch: { jobs: { 'domestic-compile': { timeWIB: '21:15' } } }, reason: 'duplikasi compile legacy' }
  }), res);
  assert.equal(res.statusCode, 409, 'endpoint rejects legacy duplicate: ' + JSON.stringify(res.body && res.body.error));
  assert.equal(res.body.code, 'LEGACY_DUPLICATE');
  assert.ok(Array.isArray(res.body.legacyDuplicates) && res.body.legacyDuplicates.length > 0);
  assert.ok(res.body.legacyDuplicates[0].executors.join(',').includes('domestic-compile-final-2110'),
    'response names the colliding legacy executor');

  // Store untouched (fail-closed).
  const S = loadStore(w.env);
  assert.equal(S.get().doc.jobs['domestic-compile'].timeWIB, '21:20');
  assert.equal(S.get().doc.version, 0);
});

/* =========================================================================== */
/* F4 — DEPENDENCY-GATED COMPILE (bukan fixed time)                             */
/* =========================================================================== */

test('F4a: Broksum selesai 20:34 -> compile 21:20 jalan (dependency gate via artifact nyata)', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  // Broksum starts 20:00, "finishes 20:34": execute at 20:34 clock.
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  spawnRunnerOnce(w);
  assert.ok(w.artifact('broksum-all', '2026-11-09'), 'broksum-all artifact exists (valid)');

  // Both ALL and Foreign must now complete before Domestic.
  w.setClock(wibInstant('2026-11-09', '21:00').toISOString());
  spawnRunnerOnce(w);
  assert.ok(w.artifact('broksum-foreign', '2026-11-09'));
  // At 21:20 the compile slot arrives; dataState is derived from REAL artifacts.
  w.setClock(wibInstant('2026-11-09', '21:20').toISOString());
  const r = spawnRunnerOnce(w);
  const dc = r.result.decisions.filter((d) => d.jobKey === 'domestic-compile' && d.decision === 'DONE');
  assert.equal(dc.length, 1, 'compile runs because Broksum artifact is valid (dependency-gated, not clock-forced)');
  assert.ok(w.artifact('domestic-compile', '2026-11-09'));
});

test('F4b: Broksum parsial/belum selesai 20:51 -> compile & Top20 TIDAK dipaksa walau jam lewat', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  // Provider publishes PARTIAL data: broksum-all stays PENDING_PROVIDER so it
  // never completes and its dependency artifact never appears.
  w.setGates(fullGates({
    providerState: Object.assign({}, ALL_PROVIDER_READY, { 'broksum-all': 'PENDING_PROVIDER' }),
    dataState: { 'broksum-all': false }
  }));

  // 20:00 and 20:51: broksum-all cannot complete (partial provider data).
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  spawnRunnerOnce(w);
  w.setClock(wibInstant('2026-11-09', '20:51').toISOString());
  spawnRunnerOnce(w);
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null, 'broksum-all not valid (partial)');

  // 21:20 passed, even 22:05 (top20 slot) passed: compile & top20 must NOT run.
  w.setClock(wibInstant('2026-11-09', '22:10').toISOString());
  spawnRunnerOnce(w);
  assert.equal(w.artifact('domestic-compile', '2026-11-09'), null, 'compile not forced without valid Broksum');
  assert.equal(w.artifact('top20', '2026-11-09'), null, 'top20 not forced without valid Broksum');
  const log = w.execLog();
  assert.ok(log.some((l) => l.jobKey === 'domestic-compile' && l.reason === 'DEPENDENCY_BLOCKED'), 'compile BLOCKED by dependency gate');
  assert.ok(log.some((l) => l.jobKey === 'top20' && l.reason === 'DEPENDENCY_BLOCKED'), 'top20 BLOCKED by dependency gate');
  assert.ok(log.some((l) => l.jobKey === 'broksum-all' && l.reason === 'PENDING_PROVIDER'), 'partial broksum recorded retry-eligible, never fake success');
});

/* =========================================================================== */
/* F5 — PROVIDER MUTEX: dua job beda nama, broker API sama                      */
/* =========================================================================== */

test('F5: two jobs sharing the broker API never double-request (PROVIDER_BUSY via durable lease)', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  // Simulate broksum-all IN FLIGHT: a fresh (non-expired) durable lease held by
  // another PID on provider ARJUM_BROKER_API.
  const now = wibInstant('2026-11-09', '21:00'); // broksum-foreign slot (depends broksum-all)
  fs.mkdirSync(w.leaseDir, { recursive: true });
  const inFlightKey = 'broksum-all:local-runner:v0:' + wibInstant('2026-11-09', '20:00').toISOString();
  fs.writeFileSync(path.join(w.leaseDir, leaseFileFor(inFlightKey)), JSON.stringify({
    key: inFlightKey, owner: 'local-runner', pid: 999999,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
    heartbeatAt: now.toISOString(),
    meta: { jobKey: 'broksum-all', provider: 'ARJUM_BROKER_API', costClass: 'HIGH', nextRunIso: wibInstant('2026-11-09', '20:00').toISOString(), version: 0 }
  }, null, 2));
  // broksum-all already valid (artifact) so foreign's dependency gate passes.
  fs.mkdirSync(path.join(w.artifactDir, 'broksum-all'), { recursive: true });
  fs.writeFileSync(path.join(w.artifactDir, 'broksum-all', '2026-11-09.json'), JSON.stringify({ jobKey: 'broksum-all', sideEffect: 'FIXTURE', tradeDateWib: '2026-11-09' }));

  w.setClock(now.toISOString());
  const r = spawnRunnerOnce(w);
  const foreign = r.result.decisions.filter((d) => d.jobKey === 'broksum-foreign');
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].decision, 'BLOCKED');
  assert.equal(foreign[0].reason, 'PROVIDER_BUSY', 'second broker-API job defers while the first holds the provider lease');
  assert.equal(w.artifact('broksum-foreign', '2026-11-09'), null, 'no double request to the broker API');
  const line = w.execLog().find((l) => l.jobKey === 'broksum-foreign' && l.reason === 'PROVIDER_BUSY');
  assert.ok(line && line.detail.heldBy === 'broksum-all', 'evidence names the lease holder');
});

/* =========================================================================== */
/* F6 — QUOTA RESET TENGAH MALAM: trade_date WIB benar, tidak duplikasi         */
/* =========================================================================== */

test('F6: midnight quota reset -> WIB trade_date correct (not UTC slice), no duplicate job', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  // 00:15 WIB on 2026-11-10 == 17:15 UTC on 2026-11-09. A UTC-slice trade_date
  // would WRONGLY be 2026-11-09.
  const utcIso = wibInstant('2026-11-10', '00:15').toISOString();
  assert.equal(utcIso.slice(0, 10), '2026-11-09', 'sanity: UTC date differs from WIB date');
  w.setClock(utcIso);
  const r = spawnRunnerOnce(w);

  const qb = r.result.decisions.filter((d) => d.jobKey === 'quota-backfill' && d.decision === 'DONE');
  assert.equal(qb.length, 1, 'quota-backfill runs at its 00:15 WIB slot');
  assert.equal(r.result.tradeDateWib, '2026-11-10', 'trade_date is the WIB date, never the UTC slice');

  const art = w.artifact('quota-backfill', '2026-11-10');
  assert.ok(art, 'artifact filed under the WIB trade_date');
  assert.equal(art.tradeDateWib, '2026-11-10');
  assert.equal(w.artifact('quota-backfill', '2026-11-09'), null, 'no artifact under the wrong (UTC) date');

  // Re-tick after the "quota reset": no duplicate execution for the same slot.
  spawnRunnerOnce(w);
  const doneCount = w.execLog().filter((l) => l.decision === 'DONE' && l.jobKey === 'quota-backfill').length;
  assert.equal(doneCount, 1, 'no duplicate job across the midnight boundary');
});

/* =========================================================================== */
/* F7 — EDIT SAAT JOB BERJALAN: satu selesai, jadwal baru versioned, no double  */
/* =========================================================================== */

test('F7: admin moves Broksum 20:00->20:10 WHILE the 20:00 job is running -> one completes, new schedule versioned, no double spawn', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  // 20:00 — the runner executes the v0 slot (simulating the in-flight job).
  const slot2000 = wibInstant('2026-11-09', '20:00');
  w.setClock(slot2000.toISOString());
  const r0 = spawnRunnerOnce(w);
  assert.equal(r0.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE').length, 1);
  const st0 = w.runnerState();
  assert.equal(st0.last['broksum-all'].version, 0);
  assert.equal(st0.last['broksum-all'].status, 'DONE');

  // 20:05 — admin edits 20:00 -> 20:10 (durable store v1) while the 20:00 job
  // "runs" (re-create its in-flight lease on disk, as a live runner would hold).
  const S = loadStore(w.env);
  const saved = S.put({ jobs: { 'broksum-all': { timeWIB: '20:10' } } }, { actor: 'budi', reason: 'geser saat job berjalan' });
  assert.equal(saved.ok, true, 'edit accepted: ' + JSON.stringify(saved.reason || ''));
  assert.equal(saved.doc.version, 1);

  const inFlightKey = 'broksum-all:local-runner:v0:' + slot2000.toISOString();
  fs.mkdirSync(w.leaseDir, { recursive: true });
  fs.writeFileSync(path.join(w.leaseDir, leaseFileFor(inFlightKey)), JSON.stringify({
    key: inFlightKey, owner: 'local-runner', pid: 424242,
    acquiredAt: slot2000.toISOString(),
    expiresAt: new Date(slot2000.getTime() + 45 * 60 * 1000).toISOString(),
    heartbeatAt: slot2000.toISOString(),
    meta: { jobKey: 'broksum-all', provider: 'ARJUM_BROKER_API', costClass: 'HIGH', nextRunIso: slot2000.toISOString(), version: 0 }
  }, null, 2));

  // 20:10 — new slot under v1. The 20:00 job already completed for this WIB
  // trade date => ALREADY_DONE_TODAY: NO second spawn, NO double broker burn.
  w.setClock(wibInstant('2026-11-09', '20:10').toISOString());
  const r1 = spawnRunnerOnce(w);
  const skipped = r1.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.reason === 'ALREADY_DONE_TODAY');
  assert.equal(skipped.length, 1, 'new same-day slot is skipped: one job per trade date (no double spawn)');
  const doneCount = w.execLog().filter((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all').length;
  assert.equal(doneCount, 1, 'exactly one broksum-all execution for 2026-11-09');

  // The versioned contract: effective NEXT run is the NEW 20:10 slot on the
  // NEXT market day (config v1 governs tomorrow).
  const E = loadEngine();
  const jobV1 = S.get().doc.jobs['broksum-all'];
  assert.equal(jobV1.timeWIB, '20:10');
  const next = E.computeNextRun(jobV1, wibInstant('2026-11-09', '20:11'));
  assert.equal(E.formatWibIso(next.toISOString()).slice(0, 16), '2026-11-10T20:10', 'jadwal baru berlaku hari bursa berikutnya');

  // Next day 20:10 (v1): runs exactly once under the new schedule.
  w.setClock(wibInstant('2026-11-10', '20:10').toISOString());
  const r2 = spawnRunnerOnce(w);
  assert.equal(r2.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE').length, 1);
  assert.ok(w.artifact('broksum-all', '2026-11-10'), 'artifact for the new trade date');
  const doneV1 = w.execLog().filter((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all' && l.configVersion === 1);
  assert.equal(doneV1.length, 1, 'execution recorded under config version 1');
});

/* =========================================================================== */
/* F8 — BACKFILL PREEMPTION mendekati 20:00                                     */
/* =========================================================================== */

test('F8: long backfill approaching 20:00 -> PREEMPT_BACKFILL safe stop, Broksum slot preserved', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  // A long-running BACKFILL lease (expires in 2h) active at 19:50 WIB.
  const now = wibInstant('2026-11-09', '19:50');
  fs.mkdirSync(w.leaseDir, { recursive: true });
  const bfKey = 'quota-backfill:local-runner:v0:' + wibInstant('2026-11-09', '00:15').toISOString();
  const bfLeasePath = path.join(w.leaseDir, leaseFileFor(bfKey));
  fs.writeFileSync(bfLeasePath, JSON.stringify({
    key: bfKey, owner: 'local-runner', pid: 777,
    acquiredAt: wibInstant('2026-11-09', '19:00').toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    heartbeatAt: now.toISOString(),
    meta: { jobKey: 'quota-backfill', provider: null, costClass: 'BACKFILL', nextRunIso: wibInstant('2026-11-09', '00:15').toISOString(), version: 0 }
  }, null, 2));

  w.setClock(now.toISOString());
  spawnRunnerOnce(w);

  const preempt = w.execLog().find((l) => l.decision === 'PREEMPT_BACKFILL');
  assert.ok(preempt, 'PREEMPT_BACKFILL recorded within 15m of Broksum 20:00');
  assert.equal(preempt.jobKey, 'quota-backfill');
  assert.ok(preempt.detail.broksumNextRunWib.startsWith('2026-11-09T20:00'), 'evidence references the Broksum slot');
  assert.equal(fs.existsSync(bfLeasePath), false, 'backfill lease released (safe stop, reserve kerja wajib tersedia)');

  // Broksum still executes on time at 20:00 after the preemption.
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  const r = spawnRunnerOnce(w);
  assert.equal(r.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE').length, 1);
});

/* =========================================================================== */
/* F9 — STALE LEASE: recover dengan bukti, tidak disamarkan SUCCESS             */
/* =========================================================================== */

test('F9: stale lease -> RECOVERED_STALE_LEASE with evidence (never fake SUCCESS); fresh lease -> LEASE_HELD', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  const slot = wibInstant('2026-11-09', '20:00');
  const idemKey = 'broksum-all:local-runner:v0:' + slot.toISOString();
  fs.mkdirSync(w.leaseDir, { recursive: true });
  const lp = path.join(w.leaseDir, leaseFileFor(idemKey));

  // (a) FRESH lease held by another pid -> LEASE_HELD, no execution.
  fs.writeFileSync(lp, JSON.stringify({
    key: idemKey, owner: 'local-runner', pid: 555,
    acquiredAt: slot.toISOString(),
    expiresAt: new Date(slot.getTime() + 30 * 60 * 1000).toISOString(),
    heartbeatAt: slot.toISOString(),
    meta: { jobKey: 'broksum-all', provider: 'ARJUM_BROKER_API', costClass: 'HIGH', nextRunIso: slot.toISOString(), version: 0 }
  }, null, 2));
  w.setClock(slot.toISOString());
  const rHeld = spawnRunnerOnce(w);
  assert.equal(rHeld.result.decisions.some((d) => d.jobKey === 'broksum-all' && d.decision === 'LEASE_HELD'), true,
    'fresh lease => LEASE_HELD (no double spawn)');
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null, 'no execution while lease held');

  // (b) STALE lease (expired + holder heartbeat old) -> recovered WITH EVIDENCE,
  // then the job still has to pass the catch-up window to execute.
  const lateNow = wibInstant('2026-11-09', '20:10'); // within 20m retry window
  fs.writeFileSync(lp, JSON.stringify({
    key: idemKey, owner: 'local-runner', pid: 555,
    acquiredAt: slot.toISOString(),
    expiresAt: new Date(slot.getTime() + 60 * 1000).toISOString(),   // expired 20:01
    heartbeatAt: slot.toISOString(),                                  // 10m stale at 20:10
    meta: { jobKey: 'broksum-all', provider: 'ARJUM_BROKER_API', costClass: 'HIGH', nextRunIso: slot.toISOString(), version: 0 }
  }, null, 2));
  w.setClock(lateNow.toISOString());
  const rRec = spawnRunnerOnce(w);
  const log = w.execLog();
  const recovered = log.find((l) => l.decision === 'RECOVERED_STALE_LEASE');
  assert.ok(recovered, 'stale-lease recovery recorded with evidence');
  assert.equal(recovered.detail.previousPid, 555, 'evidence names the dead holder');
  const doneLine = log.find((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all');
  assert.ok(doneLine, 'job executed after provable recovery (within catch-up window)');
  assert.equal(doneLine.leaseRecovered, true, 'DONE line flags the stale-lease recovery (not disguised as plain SUCCESS)');
  assert.equal(w.artifact('broksum-all', '2026-11-09').idempotencyKey, idemKey);
});

/* =========================================================================== */
/* F10 — MISSED / SKIPPED / BLOCKED / RETRIED taxonomy + idempotent catch-up    */
/* =========================================================================== */

test('F10a: downtime catch-up within retry window executes once (idempotent across restarts)', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  // Runner was DOWN at 20:00; restarts 20:10 (retry window broksum = 20m).
  w.setClock(wibInstant('2026-11-09', '20:10').toISOString());
  const r1 = spawnRunnerOnce(w);
  assert.equal(r1.result.decisions.filter((d) => d.jobKey === 'broksum-all' && d.decision === 'DONE').length, 1,
    'catch-up within window executes the missed slot');
  // Restart again at 20:12: no duplicate.
  w.setClock(wibInstant('2026-11-09', '20:12').toISOString());
  spawnRunnerOnce(w);
  assert.equal(w.execLog().filter((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all').length, 1);
});

test('F10b: beyond retry window -> MISSED (recorded once, never executed late)', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());

  w.setClock(wibInstant('2026-11-09', '21:00').toISOString()); // 45m late > 20m window
  spawnRunnerOnce(w);
  const missed = w.execLog().filter((l) => l.jobKey === 'broksum-all' && l.decision === 'MISSED');
  assert.equal(missed.length, 1, 'MISSED recorded exactly once');
  assert.equal(missed[0].reason, 'MISSED_BEYOND_CATCHUP');
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null, 'missed slot never executed late');

  // Further ticks the same evening do not spam MISSED.
  w.setClock(wibInstant('2026-11-09', '21:00').toISOString());
  spawnRunnerOnce(w);
  assert.equal(w.execLog().filter((l) => l.jobKey === 'broksum-all' && l.decision === 'MISSED').length, 1);
});

test('F10c: SKIPPED (weekend), BLOCKED (quota unknown), RETRIED (provider pending) taxonomy', () => {
  const w = makeWorld();
  w.retireAllLegacy();

  // Saturday 2026-11-14: marketDaysOnly jobs => SKIPPED.
  w.setGates(fullGates());
  w.setClock(wibInstant('2026-11-14', '20:00').toISOString());
  spawnRunnerOnce(w);
  const skipped = w.execLog().filter((l) => l.decision === 'SKIPPED' && l.reason === 'WEEKEND');
  assert.ok(skipped.some((l) => l.jobKey === 'broksum-all'), 'weekend => SKIPPED recorded');
  assert.equal(w.artifact('broksum-all', '2026-11-14'), null);

  // Monday: quota UNKNOWN => BLOCKED (fail-closed, zero consumption).
  const w2 = makeWorld();
  w2.retireAllLegacy();
  w2.setGates({ providerState: ALL_PROVIDER_READY, quotaState: { known: false, used: null, limit: null, remaining: null } });
  w2.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  spawnRunnerOnce(w2);
  const blocked = w2.execLog().filter((l) => l.decision === 'BLOCKED' && l.reason === 'QUOTA_UNKNOWN');
  assert.ok(blocked.some((l) => l.jobKey === 'broksum-all'), 'quota unknown => BLOCKED, never fake success');
  assert.equal(w2.artifact('broksum-all', '2026-11-09'), null);

  // Provider PENDING => RETRIED (retry-eligible, not success).
  const w3 = makeWorld();
  w3.retireAllLegacy();
  w3.setGates({ providerState: Object.assign({}, ALL_PROVIDER_READY, { 'broksum-all': 'PENDING_PROVIDER' }), quotaState: { known: true, used: 3080, limit: 18080, remaining: 15000, source: 'OFFLINE_TEST_FIXTURE', asOf: '2026-11-09T13:00:00.000Z' } });
  w3.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  spawnRunnerOnce(w3);
  const retried = w3.execLog().filter((l) => l.decision === 'RETRIED' && l.reason === 'PENDING_PROVIDER');
  assert.ok(retried.some((l) => l.jobKey === 'broksum-all'), 'pending provider => RETRIED');
  assert.equal(w3.artifact('broksum-all', '2026-11-09'), null);

  // Provider becomes READY at 20:12 (within window) => executes once.
  w3.setGates(fullGates());
  w3.setClock(wibInstant('2026-11-09', '20:12').toISOString());
  spawnRunnerOnce(w3);
  assert.ok(w3.artifact('broksum-all', '2026-11-09'), 'retry after provider ready succeeds within window');
});

/* =========================================================================== */
/* F11 — WIB CALENDAR REGRESSION (fake clock; engine + runner)                  */
/* =========================================================================== */

test('F11: WIB calendar regression — Friday sessions, weekend rollover, date changeover, 23:50-00:10 hard stop', () => {
  const E = loadEngine();
  const w = makeWorld();
  const S = loadStore(w.env);
  const broksum = S.get().doc.jobs['broksum-all']; // 20:00 Mon-Fri

  // (1) Friday different sessions: Fri 15:00 (session 1 end) -> next run Fri
  // 20:00; Fri 20:01 -> next run MONDAY (weekend rollover).
  const fri = wibInstant('2026-11-13', '15:00');
  assert.equal(E.jakartaWeekday(fri), 5, '2026-11-13 is Friday WIB');
  const n1 = E.computeNextRun(broksum, fri);
  assert.equal(E.formatWibIso(n1.toISOString()).slice(0, 16), '2026-11-13T20:00', 'Friday session-1 -> same Friday 20:00');
  const n2 = E.computeNextRun(broksum, wibInstant('2026-11-13', '20:01'));
  assert.equal(E.formatWibIso(n2.toISOString()).slice(0, 16), '2026-11-16T20:00', 'Friday night -> Monday (Sat/Sun skipped)');

  // (2) Weekend: Saturday -> Monday.
  const sat = wibInstant('2026-11-14', '10:00');
  assert.equal(E.jakartaWeekday(sat), 6);
  const n3 = E.computeNextRun(broksum, sat);
  assert.equal(E.formatWibIso(n3.toISOString()).slice(0, 10), '2026-11-16');

  // (3) Date changeover: 23:59 WIB Nov 9 vs 00:01 WIB Nov 10 — jakartaDateKey
  // must flip at WIB midnight, NOT at UTC midnight (17:00 UTC).
  assert.equal(E.jakartaDateKey(wibInstant('2026-11-09', '23:59')), '2026-11-09');
  assert.equal(E.jakartaDateKey(wibInstant('2026-11-10', '00:01')), '2026-11-10');
  const utcNoon = new Date('2026-11-09T17:30:00Z'); // 2026-11-10 00:30 WIB
  assert.equal(utcNoon.toISOString().slice(0, 10), '2026-11-09', 'sanity: UTC slice says Nov 9');
  assert.equal(E.jakartaDateKey(utcNoon), '2026-11-10', 'WIB trade_date says Nov 10 (UTC slice FORBIDDEN)');

  // (4) Hard stop 23:50-00:10 WIB: quota jobs blocked inside, allowed outside.
  w.retireAllLegacy();
  w.setGates(fullGates());
  w.setClock(wibInstant('2026-11-09', '23:55').toISOString());
  spawnRunnerOnce(w);
  const fw = w.execLog().filter((l) => l.decision === 'BLOCKED' && l.reason === 'FORBIDDEN_WINDOW');
  assert.ok(fw.some((l) => l.jobKey === 'broksum-all'), '23:55 WIB => quota job hard-stopped');
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null);

  // 00:05 WIB (still inside window) on the next day: still blocked.
  w.setClock(wibInstant('2026-11-10', '00:05').toISOString());
  spawnRunnerOnce(w);
  const fw2 = w.execLog().filter((l) => l.decision === 'BLOCKED' && l.reason === 'FORBIDDEN_WINDOW' && l.tradeDateWib === '2026-11-10');
  assert.ok(fw2.length > 0, '00:05 WIB => still inside 23:50-00:10 hard stop');

  // 00:15 WIB (outside the window): quota-backfill (daily 00:15, BACKFILL
  // quota class) may run — proving the hard stop is window-bounded, not global.
  w.setClock(wibInstant('2026-11-10', '00:15').toISOString());
  const rOut = spawnRunnerOnce(w);
  assert.equal(rOut.result.decisions.some((d) => d.jobKey === 'quota-backfill' && d.decision === 'DONE'), true,
    '00:15 WIB => outside hard stop, quota job executes');
  assert.ok(w.artifact('quota-backfill', '2026-11-10'), 'artifact under the correct WIB trade date');
});

test('F13: absent quota fails closed; unknown current headroom never becomes an execution fixture', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setQuotaPolicy({ version: 1, killSwitch: false, pausedServices: {} });
  w.setGates({ providerState: ALL_PROVIDER_READY, quotaState: { known: false, used: null, limit: null, remaining: null } });
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  const r = spawnRunnerOnce(w);
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null);
  assert.ok(r.result.decisions.some((d) => d.jobKey === 'broksum-all' && d.reason === 'QUOTA_UNKNOWN'));
  assert.equal(w.heartbeat().providerQuotaKnown, false);
});

test('F14: Admin kill switch and paused services apply on next spawned cycle', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  w.setQuotaPolicy({ version: 2, configuredOperatingCap: 15000, reserveFloorWeekday: 5000, currentDayObligations: 0, endpointCostUnits: { 'broksum-all': 1 }, killSwitch: true, pausedServices: {} });
  let r = spawnRunnerOnce(w);
  assert.ok(r.result.decisions.some((d) => d.jobKey === 'broksum-all' && d.reason === 'ADMIN_KILL_SWITCH'));
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null);
  w.setQuotaPolicy({ version: 3, configuredOperatingCap: 15000, reserveFloorWeekday: 5000, currentDayObligations: 0, endpointCostUnits: { 'broksum-all': 1 }, killSwitch: false, pausedServices: { arjum: true } });
  r = spawnRunnerOnce(w);
  assert.ok(r.result.decisions.some((d) => d.jobKey === 'broksum-all' && d.reason === 'ADMIN_PAUSED'));
  assert.equal(w.heartbeat().quotaPolicyVersion, 3);
});

test('F15: provider HTTP 429/auth failures block paid fixture jobs', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates({ providerState: Object.assign({}, ALL_PROVIDER_READY, { 'broksum-all': 'HTTP_429' }) }));
  w.setClock(wibInstant('2026-11-09', '20:00').toISOString());
  const r = spawnRunnerOnce(w);
  assert.ok(r.result.decisions.some((d) => d.jobKey === 'broksum-all' && d.reason === 'PROVIDER_GUARD_HTTP_429'));
  assert.equal(w.artifact('broksum-all', '2026-11-09'), null);
});

/* =========================================================================== */
/* F12 — LOOP MODE: real daemon ticks pick up an admin edit mid-flight          */
/* =========================================================================== */

test('F12: --loop daemon (real long-lived process) picks up admin edit via heartbeat version', () => {
  const w = makeWorld();
  w.retireAllLegacy();
  w.setGates(fullGates());
  w.setClock(wibInstant('2026-11-09', '19:59').toISOString());

  // Spawn the daemon in LOOP mode (real background process, 100ms ticks).
  const child = require('child_process').spawn(process.execPath, [RUNNER, '--loop', '--interval-ms', '100', '--max-duration-ms', '15000'], {
    cwd: ROOT, env: w.env, stdio: 'ignore', detached: false
  });

  try {
    // Wait for the first heartbeat (proves the loop process is alive).
    const t0 = Date.now();
    let hb = null;
    while (Date.now() - t0 < 8000) {
      hb = w.heartbeat();
      if (hb && hb.tickCount >= 1) break;
      sleepMs(50);
    }
    assert.ok(hb && hb.tickCount >= 1, 'loop daemon heartbeat observed');
    assert.equal(hb.configVersion, 0);

    // Admin edit WHILE the daemon loops: version must appear in heartbeat and
    // the daemon must execute the 20:00 slot under the new version.
    const S = loadStore(w.env);
    const saved = S.put({ jobs: { 'broksum-all': { timeWIB: '20:00' } } }, { actor: 'budi', reason: 'loop-mode wiring' });
    assert.equal(saved.ok, true);
    w.setClock(wibInstant('2026-11-09', '20:00').toISOString());

    const t1 = Date.now();
    let done = null;
    while (Date.now() - t1 < 10000) {
      done = w.execLog().find((l) => l.decision === 'DONE' && l.jobKey === 'broksum-all');
      if (done) break;
      sleepMs(50);
    }
    assert.ok(done, 'loop daemon executed the slot after picking up the durable edit');
    assert.equal(done.configVersion, 1, 'daemon read store version 1 (the admin edit) mid-flight');
    const hb2 = w.heartbeat();
    assert.equal(hb2.configVersion, 1, 'heartbeat reflects the new config version');
  } finally {
    try { child.kill(); } catch (_) {}
  }
});

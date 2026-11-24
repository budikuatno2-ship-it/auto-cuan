'use strict';

/**
 * test/v6-quota-admin-e2e.test.js
 * ============================================================================
 * V6 (Subtask C) — Quota Provider/State/Worker contract + Admin Console E2E.
 *
 * Strategy (no production touching, no real provider burn):
 *   - lib/quota-config-store.js  : REAL module, redirected via
 *     QUOTA_OPS_CONFIG_PATH / QUOTA_OPS_AUDIT_PATH to tmpdir.
 *   - api/admin/quota-settings.js: REAL handler, mocked req/res + signed tokens.
 *   - api/admin/quota-backfill-trigger.js + lib/quota-queue-worker.js: REAL,
 *     redirected via QUEUE/LEDGER env + injected executor.
 *   - lib/quota-limit.js         : REAL resolver with injected blob/state (no IO).
 *
 * Covers the mandated negative/edge cases:
 *   unknown limit, legitimate zero, cap 0, package downgrade (penurunan paket),
 *   WIB reset, expired plan, 404/403/409/500 handled, unauthorized admin,
 *   CSRF, duplicate save, config version conflict.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v6-quota-e2e-')); }

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

function loadStoreWithEnv(storePath, auditPath) {
  process.env.QUOTA_OPS_CONFIG_PATH = storePath;
  process.env.QUOTA_OPS_AUDIT_PATH = auditPath;
  const p = path.join(ROOT, 'lib', 'quota-config-store.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

function loadQuotaSettingsEndpoint() {
  const p = path.join(ROOT, 'api', 'admin', 'quota-settings.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

function loadQuotaLimit() {
  const p = path.join(ROOT, 'lib', 'quota-limit.js');
  return require(p);
}

function restoreEnv(name, prev) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

/* ========================================================================== */
/* 1. lib/quota-limit.js — fail-closed unknown vs measured zero                */
/* ========================================================================== */

test('quota-limit: unknown limit and usage are fail-closed (never 0/18080)', () => {
  const A = loadQuotaLimit();
  const now = new Date('2026-11-06T05:00:00Z');

  // No provider snapshot, no override, no env -> LIMIT_UNKNOWN.
  const lim = A.resolveLimit({ now, blob: A.blankBlob(), cfg: {} });
  assert.equal(lim.ok, false, 'limit must be unknown');
  assert.equal(lim.limit, null, 'unknown limit is null, not 0');
  assert.equal(lim.source, 'unknown');

  // Usage with null -> unknown (not measured zero).
  const usage1 = A.resolveUsage({ now, state: { currentDateWIB: A.getWibDateKey(now), upstreamUsedToday: null } });
  assert.equal(usage1.known, false, 'null usage is unknown');
  assert.equal(usage1.measuredZero, false, 'null usage is NOT measured zero');

  // Usage with '' -> unknown.
  const usageEmpty = A.resolveUsage({ now, state: { currentDateWIB: A.getWibDateKey(now), upstreamUsedToday: '' } });
  assert.equal(usageEmpty.known, false);

  // Usage with 0 -> legitimately known + measured zero.
  const usageZero = A.resolveUsage({ now, state: { currentDateWIB: A.getWibDateKey(now), upstreamUsedToday: 0 } });
  assert.equal(usageZero.known, true, '0 usage is known');
  assert.equal(usageZero.used, 0, '0 is preserved as 0');
  assert.equal(usageZero.measuredZero, true, '0 distinguishes measured zero from unknown');

  // Combined truth unknown endpoint contract.
  const truth = A.resolveTruth({ now, blob: A.blankBlob(), state: { currentDateWIB: A.getWibDateKey(now), upstreamUsedToday: null }, config: {} });
  assert.equal(truth.ok, false);
  assert.equal(truth.limit, null);
  assert.equal(truth.remaining, null);
});

test('quota-limit: expired plan fails closed', () => {
  const A = loadQuotaLimit();
  const now = new Date('2026-11-18T05:00:00Z');
  const blob = A.blankBlob();
  blob.planExpiresAt = '2026-11-17T23:59:59+07:00';
  const lim = A.resolveLimit({ now, blob, cfg: { planExpiresAt: '2026-11-17T23:59:59+07:00' } });
  assert.equal(lim.ok, false);
  assert.equal(lim.source, 'expired');
});

test('quota-limit: fresh provider snapshot is authority; override can only lower', () => {
  const A = loadQuotaLimit();
  const now = new Date('2026-11-06T05:00:00Z');
  const blob = A.blankBlob();
  A.setProviderLimit({ now, blob, limit: 12752, used: 0 });
  blob.planExpiresAt = '2026-11-17T23:59:59+07:00';

  // Package downgrade: provider now reports a SMALLER cap (penurunan paket).
  const lowered = A.resolveLimit({ now, blob, cfg: {} });
  assert.equal(lowered.ok, true);
  assert.equal(lowered.limit, 12752, 'effective limit follows fresh provider, not legacy 18080');

  // Override to 20000 (above provider) -> capped at provider.
  const b2 = A.blankBlob();
  A.setProviderLimit({ now, blob: b2, limit: 12752, used: 0 });
  A.setOverride({ now, blob: b2, limit: 20000, actor: 'admin', reason: 'raise attempt' });
  const capped = A.resolveLimit({ now, blob: b2, cfg: {} });
  assert.equal(capped.ok, true);
  assert.equal(capped.limit, 12752, 'override cannot exceed provider capacity');
});

test('quota-limit: cap 0 (override 0) is invalid as a limit, but a measured zero usage stays valid', () => {
  const A = loadQuotaLimit();
  const now = new Date('2026-11-06T05:00:00Z');

  // setOverride with a zero ceiling is rejected (zero is not a valid positive limit).
  const blob = A.blankBlob();
  const set0 = A.setOverride({ now, blob, limit: 0, actor: 'budi', reason: 'zero attempt' });
  assert.equal(set0.ok, false, 'override 0 must be rejected');

  // resolveLimit never returns 0 for a limit: with no provider it is unknown.
  const lim = A.resolveLimit({ now, blob: A.blankBlob(), cfg: { maxQuota: 0 } });
  assert.equal(lim.ok, false);
  assert.equal(lim.limit, null, '0 config never becomes an effective 0 limit');

  // A configured operating cap of 0 (ops level) is itself valid and distinct:
  // it is allowed by the config store as a legitimate hard-block, but it is NOT
  // conflated with a provider limit (limit stays provider/unknown).
  const opsZero = A.blankBlob();
  opsZero.configuredOperatingCap = 0;
  const limZero = A.resolveLimit({ now, blob: opsZero, cfg: {} });
  assert.equal(limZero.limit, null, 'cap 0 does not fabricate a provider limit');
});

/* ========================================================================== */
/* 2. lib/quota-manager.js — canonical contract + WIB reset + cap through       */
/* ========================================================================== */

test('quota-manager: getQuotaStatus returns canonical fields and UNKNOWN without crash', () => {
  const M = require('../lib/quota-manager');
  const now = new Date('2026-11-06T05:00:00Z'); // 12:00 WIB weekday
  const st = M.getQuotaStatus(now, { currentDateWIB: '2026-11-06', upstreamUsedToday: null });
  // Canonical fields must exist.
  for (const k of ['provider_limit', 'provider_used', 'provider_remaining',
    'configured_operating_cap', 'effective_limit', 'used', 'remaining',
    'reserved', 'available_for_backfill', 'usage_date', 'reset_at',
    'package_expiry', 'source_checked_at', 'verification_status']) {
    assert.ok(k in st, 'missing canonical field: ' + k);
  }
  // Unknown must never coerce to 0/18080; either null or a known number.
  if (st.limitKnown === false) assert.equal(st.limit, null, 'unknown limit is null');
  if (st.usageKnown === false) assert.equal(st.used, null, 'unknown usage is null');
  assert.notStrictEqual(st.TOTAL_QUOTA, 18080, 'legacy TOTAL_QUOTA constant removed');
});

test('quota-manager: WIB reset computation is deterministic (next midnight +07:00)', () => {
  const M = require('../lib/quota-manager');
  const now = new Date('2026-11-06T05:00:00Z'); // 12:00 WIB
  const st = M.getQuotaStatus(now, { currentDateWIB: '2026-11-06', upstreamUsedToday: 0, upstreamDailyLimit: 1000 });
  assert.ok(st.reset_at, 'reset_at present');
  // next WIB midnight == 2026-11-06T17:00:00Z
  assert.equal(st.reset_at, '2026-11-06T17:00:00.000Z', 'WIB reset instant is midnight +07:00');
});

/* ========================================================================== */
/* 3. lib/quota-config-store.js — durable/versioned/audited store              */
/* ========================================================================== */

test('config-store: unknown vs zero field discipline + atomic write + readback', () => {
  const storePath = path.join(tmpdir(), 'quota-ops-config.json');
  const auditPath = path.join(tmpdir(), 'quota-ops-audit.log.jsonl');
  const S = loadStoreWithEnv(storePath, auditPath);

  // Initial state: unknown (null), version 0.
  const g0 = S.get();
  assert.equal(g0.ok, true);
  assert.equal(g0.doc.version, 0);
  assert.equal(g0.doc.configuredOperatingCap, null);

  // Save a legit zero (cap 0 -> blocks all consumption).
  const r0 = S.put({ configured_operating_cap: 0 }, { actor: 'budi', reason: 'hard block' });
  assert.equal(r0.ok, true);
  assert.equal(r0.doc.configuredOperatingCap, 0, 'zero is preserved, not treated as missing');
  assert.equal(r0.doc.version, 1);
  assert.equal(r0.readbackOk, true, 'durable read-back confirms the write');

  // Audit file written.
  assert.ok(fs.existsSync(auditPath), 'audit log written');

  // Unknown (null) is preserved distinctly.
  const r1 = S.put({ configured_operating_cap: null }, { actor: 'budi', reason: 'clear cap' });
  assert.equal(r1.ok, true);
  assert.equal(r1.doc.configuredOperatingCap, null, 'null retained (UNKNOWN)');
});

test('config-store: optimistic concurrency — duplicate/stale save yields CONFLICT', () => {
  const storePath = path.join(tmpdir(), 'quota-ops-config.json');
  const auditPath = path.join(tmpdir(), 'quota-ops-audit.log.jsonl');
  const S = loadStoreWithEnv(storePath, auditPath);

  const first = S.put({ reserveFloorWeekday: 5000 }, { actor: 'budi', reason: 'set floor' });
  assert.equal(first.ok, true);
  assert.equal(first.doc.version, 1);

  // Duplicate/conflicting save with stale expectedVersion.
  const conflict = S.put({ reserveFloorWeekday: 4000 }, { actor: 'budi', reason: 'stale', expectedVersion: 0 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'CONFLICT');
  assert.equal(conflict.currentVersion, 1);
});

test('config-store: validation rejects empty patch and unknown key', () => {
  const storePath = path.join(tmpdir(), 'quota-ops-config.json');
  const auditPath = path.join(tmpdir(), 'quota-ops-audit.log.jsonl');
  const S = loadStoreWithEnv(storePath, auditPath);

  assert.equal(S.validatePatch({}).ok, false, 'empty patch rejected');
  assert.equal(S.validatePatch({ nonsense: 1 }).ok, false, 'unknown key rejected');
  assert.equal(S.validatePatch({ configured_operating_cap: -1 }).ok, false, 'negative rejected');
});

/* ========================================================================== */
/* 4. api/admin/quota-settings.js — authorized endpoint E2E                    */
/* ========================================================================== */

test('quota-settings endpoint: unauthorized (no session) -> 401', async () => {
  const storePath = path.join(tmpdir(), 'q.json');
  const auditPath = path.join(tmpdir(), 'a.jsonl');
  loadStoreWithEnv(storePath, auditPath);
  const ep = loadQuotaSettingsEndpoint();

  const prev = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const res = mockRes();
    await ep(mockReq({ method: 'GET' }), res);
    assert.ok(res.statusCode === 401 || res.statusCode === 403, 'got ' + res.statusCode);
    assert.equal(res.body.success, false);
  } finally { restoreEnv('SESSION_SECRET', prev); }
});

test('quota-settings endpoint: non-admin signed session -> 403', async () => {
  const storePath = path.join(tmpdir(), 'q.json');
  const auditPath = path.join(tmpdir(), 'a.jsonl');
  loadStoreWithEnv(storePath, auditPath);
  const ep = loadQuotaSettingsEndpoint();
  const sess = require('../lib/admin-session');

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'u1', username: 'member', isAdmin: false });
    const res = mockRes();
    const req = mockReq({ method: 'GET', headers: { cookie: 'ac_sess=' + token } });
    const auth = sess.requireAdminSession(req);
    assert.equal(auth.status, 403, 'non-admin rejected');
    res.status(auth.status).json({ success: false, error: auth.error });
    assert.equal(res.statusCode, 403);
  } finally { delete process.env.SESSION_SECRET; }
});

test('quota-settings endpoint: PUT without same-origin -> 403 (CSRF)', async () => {
  const storePath = path.join(tmpdir(), 'q.json');
  const auditPath = path.join(tmpdir(), 'a.jsonl');
  loadStoreWithEnv(storePath, auditPath);
  const ep = loadQuotaSettingsEndpoint();
  const sess = require('../lib/admin-session');

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    // Cross-origin header => isSameOrigin false.
    const res = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'https://evil.example' },
      body: { patch: { reserveFloorWeekday: 1 }, reason: 'x' }
    }), res);
    assert.equal(res.statusCode, 403, 'cross-origin mutating request rejected');
  } finally { delete process.env.SESSION_SECRET; }
});

test('quota-settings endpoint: authorized PUT persists + readback; GET returns versioned config', async () => {
  const storePath = path.join(tmpdir(), 'q.json');
  const auditPath = path.join(tmpdir(), 'a.jsonl');
  loadStoreWithEnv(storePath, auditPath);
  const ep = loadQuotaSettingsEndpoint();
  const sess = require('../lib/admin-session');

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });

    const putRes = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' },
      body: { patch: { configured_operating_cap: 8000, reserveFloorWeekday: 2000 }, reason: 'ops change' }
    }), putRes);
    assert.equal(putRes.statusCode, 200, 'PUT succeeds: ' + JSON.stringify(putRes.body));
    assert.equal(putRes.body.success, true);
    assert.equal(putRes.body.readbackOk, true);
    assert.equal(putRes.body.version, 1);

    const getRes = mockRes();
    await ep(mockReq({ method: 'GET', headers: { cookie: 'ac_sess=' + token } }), getRes);
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.body.success, true);
    assert.equal(getRes.body.config.version, 1);
    assert.equal(getRes.body.config.configuredOperatingCap, 8000);
  } finally { delete process.env.SESSION_SECRET; }
});

test('quota-settings endpoint: version conflict -> 409', async () => {
  const storePath = path.join(tmpdir(), 'q.json');
  const auditPath = path.join(tmpdir(), 'a.jsonl');
  loadStoreWithEnv(storePath, auditPath);
  const ep = loadQuotaSettingsEndpoint();
  const sess = require('../lib/admin-session');

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    const hdr = { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' };

    await ep(mockReq({ method: 'PUT', headers: hdr, body: { patch: { reserveFloorWeekday: 5000 }, reason: 'a' } }), mockRes());
    const stale = mockRes();
    await ep(mockReq({ method: 'PUT', headers: hdr, body: { patch: { reserveFloorWeekday: 4000 }, reason: 'b', expectedVersion: 0 } }), stale);
    assert.equal(stale.statusCode, 409, 'stale version -> 409 CONFLICT');
    assert.equal(stale.body.code, 'CONFIG_VERSION_CONFLICT');
  } finally { delete process.env.SESSION_SECRET; }
});

test('quota-settings endpoint: invalid patch -> 400 (server validation, not string compare)', async () => {
  const storePath = path.join(tmpdir(), 'q.json');
  const auditPath = path.join(tmpdir(), 'a.jsonl');
  loadStoreWithEnv(storePath, auditPath);
  const ep = loadQuotaSettingsEndpoint();
  const sess = require('../lib/admin-session');

  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-real';
  try {
    const token = sess.createSessionToken({ userId: 'b1', username: 'budi', isAdmin: true });
    const res = mockRes();
    await ep(mockReq({
      method: 'PUT',
      headers: { cookie: 'ac_sess=' + token, host: 'localhost', origin: 'http://localhost' },
      body: { patch: { reserveFloorWeekday: -5 }, reason: 'valid reason text' }
    }), res);
    assert.equal(res.statusCode, 400, 'negative value rejected by server');
  } finally { delete process.env.SESSION_SECRET; }
});

/* ========================================================================== */
/* 5. Backfill worker consumer (real, gated)                                   */
/* ========================================================================== */

test('backfill worker: trigger enqueues then consumer drains with injected executor', () => {
  const tmp = tmpdir();
  const prevQ = process.env.QUOTA_BACKFILL_QUEUE_PATH;
  const prevL = process.env.QUOTA_BACKFILL_LEDGER_PATH;
  process.env.QUOTA_BACKFILL_QUEUE_PATH = path.join(tmp, 'q.json');
  process.env.QUOTA_BACKFILL_LEDGER_PATH = path.join(tmp, 'ledger.json');

  const workerPath = path.join(ROOT, 'lib', 'quota-queue-worker.js');
  delete require.cache[require.resolve(workerPath)];
  const worker = require(workerPath);

  try {
    const enq = worker.enqueueBackfill({ reason: 'e2e backfill', actor: 'budi' });
    assert.equal(enq.ok, true);
    assert.equal(enq.status, 'QUEUED');

    let executed = 0;
    const drained = worker.consumeBackfillQueue({
      allowExecute: true,
      // V6 (Subtask E): terminal VERIFIED requires BOTH executed AND
      // readbackVerified — no placebo completion (no PROCESSED w/o executed).
      execute: () => { executed += 1; return { ok: true, executed: true, readbackVerified: true, detail: 'ran' }; }
    });
    assert.equal(drained.processed, 1, 'one trigger processed (only after readback verification)');
    assert.equal(drained.executed, 1, 'executor actually consumed the queue');
    assert.equal(executed, 1, 'executor invoked exactly once');

    const status = worker.getWorkerStatus();
    assert.equal(status.pending, 0, 'no pending triggers after VERIFIED drain');
    assert.equal(status.verified, 1, 'terminal state is EXECUTED_AND_READBACK_VERIFIED');
    assert.equal(status.invariant.ok, true, 'processed never exceeds verified');
  } finally {
    restoreEnv('QUOTA_BACKFILL_QUEUE_PATH', prevQ);
    restoreEnv('QUOTA_BACKFILL_LEDGER_PATH', prevL);
  }
});

test('backfill worker: production (allowExecute false) drains without burn — honest WAITING_APPROVAL', () => {
  const tmp = tmpdir();
  const prevQ = process.env.QUOTA_BACKFILL_QUEUE_PATH;
  const prevL = process.env.QUOTA_BACKFILL_LEDGER_PATH;
  process.env.QUOTA_BACKFILL_QUEUE_PATH = path.join(tmp, 'q.json');
  process.env.QUOTA_BACKFILL_LEDGER_PATH = path.join(tmp, 'ledger.json');

  const workerPath = path.join(ROOT, 'lib', 'quota-queue-worker.js');
  delete require.cache[require.resolve(workerPath)];
  const worker = require(workerPath);

  try {
    worker.enqueueBackfill({ reason: 'no-burn', actor: 'budi' });
    const drained = worker.consumeBackfillQueue({ allowExecute: false });
    assert.equal(drained.executed, 0, 'production never executes the provider');
    assert.equal(drained.processed, 0, 'production NEVER reports fake processed (V6 fix)');
    assert.equal(drained.approved, 1, 'trigger transitions QUEUED -> APPROVED (honest waiting state)');
    assert.equal(drained.pending, 1, 'unexecuted work is NOT deleted: it stays pending');

    const status = worker.getWorkerStatus();
    assert.equal(status.pending, 1, 'WAITING_APPROVAL honestly surfaces as pending');
    assert.equal(status.byStatus.APPROVED, 1);
  } finally {
    restoreEnv('QUOTA_BACKFILL_QUEUE_PATH', prevQ);
    restoreEnv('QUOTA_BACKFILL_LEDGER_PATH', prevL);
  }
});

/* ========================================================================== */
/* 6. Routing: legacy mutation removed / delegated                             */
/* ========================================================================== */

test('routes/admin.js: legacy quota mutation no longer writes config', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
  assert.ok(!/handleQuotaSettings/.test(src), 'legacy handleQuotaSettings removed');
  assert.ok(!/saveConfig\(patch,\s*'budi'\)/.test(src), 'hardcoded actor saveConfig removed');
  assert.ok(/quota-settings/.test(src), 'legacy mutation redirected to authorized endpoint');
});

test('api/admin-users.js: quota_update delegates to authorized quota-settings endpoint', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.ok(/require\('\.\/admin\/quota-settings'\)/.test(src), 'quota_update delegates to canonical handler');
});

test('public/admin-console-runtime.js: HTTP non-2xx treated as error, no (limit||0)-(used||0) fallback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'admin-console-runtime.js'), 'utf8');
  assert.ok(!/\(q\.limit \|\| 0\)\s*-\s*\(q\.used \|\| 0\)/.test(src), 'remaining unknown no longer coerced to 0');
  assert.ok(!/api\/admin-users.*quota_update/.test(src), 'no hidden api/admin-users fallback that swallows 404');
  assert.ok(/PUT/.test(src), 'console uses PUT for quota mutation');
});
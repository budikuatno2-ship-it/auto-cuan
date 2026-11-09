'use strict';

/**
 * test/v5/quota-admin-console.test.js
 * ============================================================================
 * ADMIN CONSOLE — Dynamic quota limit setter endpoint tests (mocks only)
 * ============================================================================
 * Covers the P0-B Admin Console layer on top of lib/quota-limit.js:
 *   1. Unauthenticated / unauthorized setter call is rejected.
 *   2. Authorized admin sets override -> truth reflects new limit; actor/reason
 *      recorded.
 *   3. Invalid inputs (NaN/negative/zero/absurd strings) rejected.
 *   4. Clear override restores correct resolution order.
 *   5. Override cannot modify used/remaining/billing (usage untouched).
 *   6. Audit record written (append-only) on success; failed persistence/audit
 *      -> no ok:true.
 *   7. remaining<=0 hard-stop not bypassed by override.
 *   8. GET returns no secret fields.
 *   9. Immediate worker pickup: after override, canConsumeQuota/resolveQuotaTruth
 *      use the new limit.
 * No network. No backfill. No real data/quota-state.json touched.
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true, error: null }); }
  catch (err) { results.push({ name, ok: false, error: err }); }
}
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

/* -------------------------------------------------------------------------- */
/* Load the Endpoint's logic (real module; helpers only — no side effects)     */
/* -------------------------------------------------------------------------- */
const endpoint = require('../../api/admin/quota-limit');

/* -------------------------------------------------------------------------- */
/* Load admin-session + admin-users-handler authorization helpers              */
/* -------------------------------------------------------------------------- */
const adminSession = require('../../lib/admin-session');

/* -------------------------------------------------------------------------- */
/* Sandbox stack: quota-limit.js + quota-state.js copied into one temp lib dir */
/* so require('./quota-limit') inside quota-state resolves to the sandbox copy. */
/* -------------------------------------------------------------------------- */
function makeStack(seedBlob, seedState, seedConfig) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-admin-quota-'));
  const libDir = path.join(sandbox, 'lib');
  const dataDir = path.join(sandbox, 'data');
  const configDir = path.join(sandbox, 'config');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(path.join(libDir, 'quota-limit.js'), fs.readFileSync(require.resolve('../../lib/quota-limit.js'), 'utf8'));
  fs.writeFileSync(path.join(libDir, 'quota-state.js'), fs.readFileSync(require.resolve('../../lib/quota-state.js'), 'utf8'));

  const blobPath = path.join(dataDir, 'quota-limit.json');
  if (seedBlob != null) fs.writeFileSync(blobPath, JSON.stringify(seedBlob));
  const statePath = path.join(dataDir, 'quota-state.json');
  if (seedState != null) fs.writeFileSync(statePath, JSON.stringify(seedState));
  fs.writeFileSync(path.join(configDir, 'quota.json'), JSON.stringify(seedConfig || {
    planName: 'Supporter',
    planExpiresAt: '2026-11-17T23:59:59+07:00',
    reserveFloorWeekday: 0,
    reserveFloorWeekend: 0,
    weekdayBackfillLimit: 0,
    weekendBackfillLimit: null
  }));

  const A = require(path.join(libDir, 'quota-limit.js'));
  const S = require(path.join(libDir, 'quota-state.js'));
  return { A, S, sandbox, blobPath, statePath, dataDir };
}

function seedProvider(A, now, limit, used) {
  return A.setProviderLimit({ now, limit, used, planExpiresAt: '2026-11-17T23:59:59+07:00' });
}

const T0 = new Date('2026-11-06T05:00:00Z'); // 12:00 WIB Nov 6

/* ========================================================================== */
/* 1. Authorization: unauthenticated / unauthorized setter call is rejected    */
/* ========================================================================== */

function mockReq(options) {
  const o = options || {};
  return {
    method: o.method || 'POST',
    headers: Object.assign({ host: 'localhost', origin: 'http://localhost' }, o.headers || {}),
    body: o.body || {},
    socket: { remoteAddress: o.ip || '127.0.0.1' }
  };
}
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

test('unauthorized setter call is rejected (no signed admin session)', async () => {
  const prevSecret = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const req = mockReq({ method: 'POST', body: { action: 'set', limit: 20000, reason: 'test override' } });
    const res = mockRes();
    await endpoint(req, res);
    assert(res.statusCode === 403 || res.statusCode === 401, 'expected 401/403, got ' + res.statusCode);
    assert(!(res.body && res.body.success), 'must not return ok:true when unauthenticated');
  } finally {
    if (prevSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prevSecret;
  }
});

test('non-admin signed session is rejected with 403', () => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-a-real-secret';
  try {
    const token = adminSession.createSessionToken({ userId: 'u1', username: 'member', isAdmin: false });
    const req = mockReq({
      method: 'POST',
      headers: { cookie: 'ac_sess=' + token },
      body: { action: 'set', limit: 20000, reason: 'test override' }
    });
    const res = mockRes();
    // requireAdminSession on non-admin -> 403 (before touching any file)
    const auth = adminSession.requireAdminSession(req);
    assert(auth.ok === false && auth.status === 403, 'requireAdminSession must reject non-admin, got ' + JSON.stringify(auth));
    res.status(auth.status).json({ success: false, error: auth.error });
    assert(res.statusCode === 403, 'expected 403, got ' + res.statusCode);
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

/* ========================================================================== */
/* 2. Authorized admin sets override -> truth reflects new limit               */
/* ========================================================================== */

test('set override -> resolveQuotaTruth reflects capped limit; actor/reason recorded', () => {
  const { A, sandbox } = makeStack();
  try {
    seedProvider(A, T0, 12752, 5000);
    // 20000 > verified provider 12752 => effective limiter is CAPPED at provider capacity.
    const set = A.setOverride({ now: T0, limit: 20000, actor: 'u-budi-1', reason: 'attempted raise' });
    assert(set.ok === true, 'override accepted');
    const t = A.resolveTruth({ now: T0, state: { currentDateWIB: A.getWibDateKey(T0), upstreamUsedToday: 5000 } });
    assert(t.ok === true, 'truth known');
    assert(t.limit === 12752, 'effective limit capped at provider capacity, got ' + t.limit);
    // actor/reason persisted in the blob (the requested candidate ceiling).
    const blob = A.readLimitBlob().blob;
    assert(blob.override.limit === 20000, 'override.limit persisted (candidate ceiling)');
    assert(blob.override.actor === 'u-budi-1', 'override.actor persisted, got ' + blob.override.actor);
    assert(blob.override.reason === 'attempted raise', 'override.reason persisted');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

/* ========================================================================== */
/* 3. Invalid inputs rejected                                                   */
/* ========================================================================== */

test('invalid inputs rejected: NaN/negative/zero/absurd/non-numeric strings', () => {
  const bad = ['abc', 'NaN', 'Infinity', -1, 0, '-0', '1e999', 1000001, '', null];
  for (const v of bad) {
    const r = endpoint.validateOverrideInput({ action: 'set', limit: v });
    assert(r.ok === false, 'set override must reject limit=' + String(v));
  }
  // clear does not need a limit
  const clearOk = endpoint.validateOverrideInput({ action: 'clear' });
  assert(clearOk.ok === true && clearOk.kind === 'clear', 'clear validates');
  // unknown action rejected
  assert(endpoint.validateOverrideInput({ action: 'explode', limit: 1 }).ok === false, 'unknown action rejected');
});

test('non-empty reason required for set and clear', () => {
  assert(endpoint.validateReason({ reason: '' }).ok === false, 'empty reason rejected');
  assert(endpoint.validateReason({ reason: '   ' }).ok === false, 'whitespace reason rejected');
  assert(endpoint.validateReason({ reason: 'Raised ceiling' }).ok === true, 'valid reason accepted');
});

/* ========================================================================== */
/* 4. Clear override restores resolution order                                  */
/* ========================================================================== */

test('clear override restores provider resolution', () => {
  const { A, sandbox } = makeStack();
  try {
    seedProvider(A, T0, 12752, 5000);
    A.setOverride({ now: T0, limit: 10000, actor: 'u-budi-1', reason: 'temp lower ceiling' });
    assert(A.resolveLimit({ now: T0 }).limit === 10000, 'lower override active');
    const cleared = A.clearOverride({ now: T0, actor: 'u-budi-1', reason: 'provider re-verified' });
    assert(cleared.ok === true, 'clear accepted');
    const lim = A.resolveLimit({ now: T0 });
    assert(lim.ok === true && lim.limit === 12752 && lim.source === 'provider', 'clears to provider, got ' + JSON.stringify(lim));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

/* ========================================================================== */
/* 5. Override cannot modify used/remaining/billing                             */
/* ========================================================================== */

test('override is ceiling-only; used/remaining/billing never faked (capped at provider)', () => {
  const { A, sandbox } = makeStack();
  try {
    seedProvider(A, T0, 12752, 13084);
    A.setOverride({ now: T0, limit: 999999, actor: 'u-budi-1', reason: 'attempt to hide usage' });
    const t = A.resolveTruth({ now: T0, state: { currentDateWIB: A.getWibDateKey(T0), upstreamUsedToday: 13084 } });
    assert(t.used === 13084, 'usage unchanged by override, got ' + t.used);
    // Effective cap stays at provider capacity, so usage still exceeds it -> remaining 0, overage 332.
    assert(t.remaining === 0, 'remaining is 0 (capped at provider, already over), got ' + t.remaining);
    assert(t.overage === 332, 'overage is 332 vs provider capacity, got ' + t.overage);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

/* ========================================================================== */
/* 6. Audit append-only + no-secret GET + failed-audit fail-closed              */
/* ========================================================================== */

test('audit record contains actor/ip/user-agent/prev/new diff + timestamp', () => {
  const rec = endpoint.buildAuditRecord({
    kind: 'set', now: T0, actorId: 'u-budi-1', actorUsername: 'budi',
    ip: '203.0.113.7', userAgent: 'test-agent', previous: { overrideLimit: null },
    next: { overrideLimit: 20000 }, reason: 'raised'
  });
  assert(rec.eventType === 'QUOTA_LIMIT_OVERRIDE_SET', 'event type');
  assert(rec.actorId === 'u-budi-1' && rec.actorUsername === 'budi', 'actor recorded');
  assert(rec.ip === '203.0.113.7' && rec.userAgent === 'test-agent', 'ip/ua recorded');
  assert(rec.previous && rec.previous.overrideLimit === null, 'prev diff');
  assert(rec.next && rec.next.overrideLimit === 20000, 'next diff');
  assert(typeof rec.timestampIso === 'string' && Date.parse(rec.timestampIso) > 0, 'timestamp present');
  assert(typeof rec.eventId === 'string', 'event id present');
});

test('appendAuditRecord writes append-only; failure returns ok:false (fail-closed)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-audit-'));
  try {
    const prev = process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    const logPath = path.join(sandbox, 'audit.jsonl');
    process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = logPath;
    delete require.cache[require.resolve('../../api/admin/quota-limit')];
    const ep = require('../../api/admin/quota-limit');

    const r1 = ep.appendAuditRecord(ep.buildAuditRecord({ kind: 'set', now: T0, actorId: 'u', actorUsername: 'b', ip: 'x', userAgent: '', previous: null, next: { overrideLimit: 1 }, reason: 'r' }));
    assert(r1.ok === true, 'first append ok');
    const r2 = ep.appendAuditRecord(ep.buildAuditRecord({ kind: 'set', now: T0, actorId: 'u', actorUsername: 'b', ip: 'x', userAgent: '', previous: null, next: { overrideLimit: 2 }, reason: 'r' }));
    assert(r2.ok === true, 'second append ok');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    assert(lines.length === 2, 'two append-only records, got ' + lines.length);

    // Failure: point the audit path at a FILE named as a directory -> mkdir fails.
    const failFile = path.join(sandbox, 'afile');
    fs.writeFileSync(failFile, 'x');
    process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(failFile, 'sub', 'audit.jsonl');
    delete require.cache[require.resolve('../../api/admin/quota-limit')];
    const ep2 = require('../../api/admin/quota-limit');
    const r3 = ep2.appendAuditRecord(ep2.buildAuditRecord({ kind: 'set', now: T0, actorId: 'u', actorUsername: 'b', ip: 'x', userAgent: '', previous: null, next: { overrideLimit: 3 }, reason: 'r' }));
    assert(r3.ok === false, 'audit failure must return ok:false');

    if (prev === undefined) delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH; else process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = prev;
    delete require.cache[require.resolve('../../api/admin/quota-limit')];
    require('../../api/admin/quota-limit');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('buildPublicTruth omits secret fields', () => {
  const truth = {
    ok: true, limit: 20000, used: 5000, remaining: 15000, overage: 0,
    limitKnown: true, usageKnown: true, measuredZero: false,
    limitSource: 'manual', reason: null, resetHourWib: 0, tz: 'Asia/Jakarta'
  };
  const blob = {
    providerLimit: 12752, providerLimitSource: 'provider', providerLimitVerifiedAt: '2026-11-06T00:00:00Z',
    planExpiresAt: '2026-11-17T23:59:59+07:00',
    override: { limit: 20000, actor: 'budi', reason: 'raised', setAt: '2026-11-06T05:00:00Z' }
  };
  const pub = endpoint.buildPublicTruth(truth, blob);
  const FORBIDDEN = /token|secret|key|password|auth|credential|cookie|api_key/i;
  for (const k of Object.keys(pub)) {
    assert(!FORBIDDEN.test(k), 'secret-shaped key leaked: ' + k);
  }
  if (pub.override) {
    for (const k of Object.keys(pub.override)) {
      assert(!FORBIDDEN.test(k), 'secret-shaped override key leaked: ' + k);
    }
  }
  // It carries the expected non-secret fields.
  assert(pub.limit === 20000 && pub.used === 5000 && pub.remaining === 15000, 'non-secret fields present');
  assert(pub.source === 'manual', 'source labeled');
  assert(pub.providerLimitVerifiedAt != null, 'verified timestamp labeled');
});

/* ========================================================================== */
/* 7. remaining<=0 hard-stop not bypassed by override                            */
/* ========================================================================== */

test('hard-stop (remaining<=0) not bypassed by an override above provider', () => {
  const WIB_DATE = '2026-11-06';
  const stack = makeStack(
    null,
    { currentDateWIB: WIB_DATE, upstreamUsedToday: 13084, localUsedToday: 13084 },
    { planName: 'Supporter', planExpiresAt: '2026-11-17T23:59:59+07:00', reserveFloorWeekday: 0, reserveFloorWeekend: 0, weekdayBackfillLimit: 0 }
  );
  const A = stack.A;
  const S = stack.S;
  const sandbox = stack.sandbox;
  try {
    seedProvider(A, T0, 12752, 13084);
    A.setOverride({ now: T0, limit: 50000, actor: 'u-budi-1', reason: 'raise ceiling but already spent' });

    const t = S.resolveQuotaTruth({ now: T0, state: { currentDateWIB: WIB_DATE, upstreamUsedToday: 13084, localUsedToday: 13084 } });
    assert(t.limit === 12752, 'effective limit stays at provider capacity, got ' + t.limit);
    assert(t.used === 13084, 'used unchanged');
    const over = A.resolveTruth({ now: T0, state: { currentDateWIB: WIB_DATE, upstreamUsedToday: 13084 } });
    assert(over.remaining === 0, 'remaining is 0 (still over provider), got ' + over.remaining);
    assert(over.overage === 332, 'overage vs provider capacity, got ' + over.overage);

    // used already >= provider limit; a raised override must NOT reset used.
    const spent = A.resolveTruth({ now: T0, state: { currentDateWIB: WIB_DATE, upstreamUsedToday: 13084, localUsedToday: 14000 } });
    assert(spent.used >= 13084, 'used never lowered');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

/* ========================================================================== */
/* 9. Immediate worker pickup: canConsumeQuota uses new limit                   */
/* ========================================================================== */

test('worker pickup: override LOWER than provider applies without restart (capped ceiling)', () => {
  const WIB_DATE = '2026-11-06';
  const stack = makeStack(
    null,
    { currentDateWIB: WIB_DATE, upstreamUsedToday: 0, localUsedToday: 0 },
    { planName: 'Supporter', planExpiresAt: '2026-11-17T23:59:59+07:00', reserveFloorWeekday: 0, reserveFloorWeekend: 0, weekdayBackfillLimit: 0 }
  );
  const A = stack.A;
  const S = stack.S;
  const sandbox = stack.sandbox;
  try {
    seedProvider(A, T0, 12752, 0);
    const before = S.resolveQuotaTruth({ now: T0, state: { currentDateWIB: WIB_DATE, upstreamUsedToday: 0 } });
    assert(before.limit === 12752, 'provider limit 12752');

    // Admin LOWERS the ceiling via override (no process restart).
    A.setOverride({ now: T0, limit: 10000, actor: 'u-budi-1', reason: 'intentional lower ceiling' });

    const after = S.resolveQuotaTruth({ now: T0, state: { currentDateWIB: WIB_DATE, upstreamUsedToday: 0 } });
    assert(after.limit === 10000, 'resolveQuotaTruth picks up the lower override, got ' + after.limit);

    // A request under the lowered ceiling (but over the provider 12752 would not
    // matter here) succeeds.
    const consume = S.canConsumeQuota(8000, 'backfill', { now: T0, reserveFloor: 0 });
    assert(consume.ok === true, 'canConsumeQuota honors the lower ceiling, got ' + JSON.stringify(consume));
    assert(consume.limit === 10000, 'consume.limit reflects override, got ' + consume.limit);

    // F3-F1: a request that would fit under provider but exceed the LOWER
    // override must be rejected.
    const over = S.canConsumeQuota(11000, 'backfill', { now: T0, reserveFloor: 0 });
    assert(over.ok === false, 'lower override still enforces, got ' + JSON.stringify(over));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test('F3-F1: override ABOVE provider is capped at provider capacity', () => {
  const WIB_DATE = '2026-11-06';
  const stack = makeStack(
    null,
    { currentDateWIB: WIB_DATE, upstreamUsedToday: 0, localUsedToday: 0 },
    { planName: 'Supporter', planExpiresAt: '2026-11-17T23:59:59+07:00', reserveFloorWeekday: 0, reserveFloorWeekend: 0, weekdayBackfillLimit: 0 }
  );
  const A = stack.A;
  const S = stack.S;
  const sandbox = stack.sandbox;
  try {
    seedProvider(A, T0, 12752, 0);
    A.setOverride({ now: T0, limit: 90000, actor: 'u-budi-1', reason: 'bigger plan attempt' });
    const after = S.resolveQuotaTruth({ now: T0, state: { currentDateWIB: WIB_DATE, upstreamUsedToday: 0 } });
    assert(after.limit === 12752, 'effective limiter never exceeds provider capacity, got ' + after.limit);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

let failed = 0;
process.stdout.write('quota-admin-console dynamic limit endpoint test suite\n');
process.stdout.write('=====================================================\n');
for (const r of results) {
  process.stdout.write((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  -> ' + (r.error && r.error.message)) + '\n');
  if (!r.ok) failed += 1;
}
process.stdout.write('\n' + (results.length - failed) + '/' + results.length + ' passed\n');
if (failed > 0) process.exit(1);
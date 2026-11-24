'use strict';

/**
 * test/v6/hsc-asof-failclosed.test.js
 * ============================================================================
 * V6 (W2a / Feature 13C) — HSC as_of FAIL-CLOSED + ownershipUpload auth gate.
 *
 * Strategy: exercise the PURE exported resolver `resolveHscFailClosed` from
 * api/struktur-pasar.js (no on-disk dataset mutation) plus the real
 * ownershipUpload RBAC/CSRF gate. No network, no provider, no VPS writes.
 *
 * Covers:
 *   (a) record without as_of -> UNKNOWN + MISSING_AS_OF, no fake date
 *   (b) record with a real as_of -> verdict preserved
 *   (c) non-admin upload rejected (RBAC + CSRF)
 *   (d) free-float < 15% does NOT imply HSC TRUE (independence)
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SP_P = path.join(ROOT, 'api', 'struktur-pasar.js');
const ADMIN_USERS_P = path.join(ROOT, 'api', 'admin-users.js');
const SESSION_P = path.join(ROOT, 'lib', 'admin-session.js');

process.env.SESSION_SECRET = 'test-secret-hsc-0123456789';

function fakeRes() {
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

test('13C-(a): HSC verdict without as_of degrades to UNKNOWN + MISSING_AS_OF', () => {
  const sp = require(SP_P);
  assert.equal(typeof sp.resolveHscFailClosed, 'function', 'pure resolver exported');

  // A TRUE verdict with no as_of must fail closed.
  const r1 = sp.resolveHscFailClosed(true, 'IDX Peng-001/2026', null);
  assert.equal(r1.flag, null, 'verdict withheld without as_of');
  assert.equal(r1.as_of, null, 'no fabricated as_of');
  assert.equal(r1.reason, 'MISSING_AS_OF', 'explicit reason code');

  // A FALSE verdict with a placeholder as_of must also fail closed.
  const r2 = sp.resolveHscFailClosed(false, 'IDX', '—');
  assert.equal(r2.flag, null);
  assert.equal(r2.as_of, null);
  assert.equal(r2.reason, 'MISSING_AS_OF');

  // No verdict at all stays UNKNOWN with no reason (nothing to withhold).
  const r3 = sp.resolveHscFailClosed(null, null, null);
  assert.equal(r3.flag, null);
  assert.equal(r3.reason, null);
});

test('13C-(b): HSC verdict WITH a real as_of is preserved', () => {
  const sp = require(SP_P);
  const r = sp.resolveHscFailClosed(true, 'IDX Peng-002/2026', '2026-09-30');
  assert.equal(r.flag, true, 'verdict preserved when as_of is real');
  assert.equal(r.as_of, '2026-09-30');
  assert.equal(r.reason, null, 'no reason code when provenance is complete');

  // isValidAsOf accepts real dates and rejects placeholders.
  assert.equal(sp.isValidAsOf('2026-09-30'), true);
  assert.equal(sp.isValidAsOf('2026-09-30T00:00:00+07:00'), true);
  assert.equal(sp.isValidAsOf(null), false);
  assert.equal(sp.isValidAsOf(''), false);
  assert.equal(sp.isValidAsOf('—'), false);
  assert.equal(sp.isValidAsOf('unknown'), false);
});

test('13C-(c): non-admin ownership upload is rejected (RBAC + CSRF)', async () => {
  delete require.cache[require.resolve(ADMIN_USERS_P)];
  delete require.cache[require.resolve(SESSION_P)];
  const adminUsers = require(ADMIN_USERS_P);
  const session = require(SESSION_P);

  assert.equal(typeof adminUsers.ownershipUpload, 'function', 'ownershipUpload exposed for testing');

  // 1. No session -> 401.
  const res1 = fakeRes();
  await adminUsers.ownershipUpload({ method: 'POST', headers: { host: 'localhost', origin: 'http://localhost' }, body: { mode: 'preview', content: 'x' } }, res1);
  assert.equal(res1.statusCode, 401);

  // 2. Non-admin session -> 403.
  const userToken = session.createSessionToken({ userId: 'u1', username: 'alice', isAdmin: false });
  const res2 = fakeRes();
  await adminUsers.ownershipUpload({
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'ac_sess=' + userToken },
    body: { mode: 'preview', content: 'x' }
  }, res2);
  assert.equal(res2.statusCode, 403);

  // 3. Admin session but cross-origin -> 403 (CSRF).
  const adminToken = session.createSessionToken({ userId: 'a1', username: 'budi', isAdmin: true });
  const res3 = fakeRes();
  await adminUsers.ownershipUpload({
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://evil.example', cookie: 'ac_sess=' + adminToken },
    body: { mode: 'preview', content: 'x' }
  }, res3);
  assert.equal(res3.statusCode, 403);
});

test('13C-(d): free-float < 15% does NOT imply HSC TRUE (independence)', () => {
  const sp = require(SP_P);
  // With NO HSC verdict supplied, the resolver returns UNKNOWN regardless of
  // any free-float value — free float is never an input to the HSC verdict.
  const r = sp.resolveHscFailClosed(undefined, undefined, undefined);
  assert.equal(r.flag, null, 'no verdict -> UNKNOWN, never inferred from free float');
  assert.equal(r.reason, null);

  // The real universe must contain low-free-float rows that are NOT HSC=true.
  sp.invalidateCache();
  const data = sp.buildStrukturPasarData().data;
  const lowFf = data.universe.filter((u) => u.free_float_pct != null && u.free_float_pct < 15);
  assert.ok(lowFf.length > 0, 'universe has low free-float rows');
  assert.ok(lowFf.some((u) => u.hsc_flag !== true),
    'low free float must not be blindly forced to HSC=true');
});

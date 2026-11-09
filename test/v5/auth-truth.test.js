'use strict';

/**
 * test/v5/auth-truth.test.js — V5 security package
 * ============================================================================
 * Pure-function truth gate for the signed-session authentication layer.
 * Adapted to the workspace seams: `lib/admin-session.js` exports the inspectable
 * functions (verifySessionToken / requireAdminSession) directly, and the
 * insecure "dev-preview zero-auth" path in `lib/admin-notes-handler.js` must be
 * gone from source. No network, no filesystem writes.
 * Run: node test/v5/auth-truth.test.js
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const session = require(path.join(ROOT, 'lib', 'admin-session'));

const failures = [];
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures.push(label + ' :: ' + e.message); console.log('  FAIL ' + label + ' :: ' + e.message); }
}

const NOW_MS = Date.UTC(2026, 10, 6, 0, 0, 0);
const realNow = Date.now;
Date.now = function () { return NOW_MS; };

const TEST_SECRET = 'v5-auth-truth-test-secret-DO-NOT-USE-IN-PRODUCTION';
process.env.SESSION_SECRET = TEST_SECRET;

function b64(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signPayload(payloadObj, secret) {
  const payloadB64 = b64(Buffer.from(JSON.stringify(payloadObj)));
  const signingInput = 'v1.' + payloadB64;
  const sig = b64(crypto.createHmac('sha256', secret).update(signingInput).digest());
  return signingInput + '.' + sig;
}
function fakeReqWithCookie(token) {
  return { headers: { cookie: session.SESSION_COOKIE_NAME + '=' + token } };
}

check('verifySessionToken fails closed when SESSION_SECRET is unset', function () {
  delete process.env.SESSION_SECRET;
  const r = session.verifySessionToken('v1.abc.def');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'no_secret');
});
process.env.SESSION_SECRET = TEST_SECRET;

check('forged unsigned-identity token is rejected (bad signature)', function () {
  const forged = 'v1.' + b64(Buffer.from(JSON.stringify({ uid: 'attacker', un: 'attacker', adm: true, iat: 1, exp: 9999999999 }))) + '.deadbeef';
  const r = session.verifySessionToken(forged);
  assert.strictEqual(r.valid, false, 'forged token accepted: ' + JSON.stringify(r));
});

check('localStorage-shaped string is rejected as a session', function () {
  const r = session.verifySessionToken('autocuan_logged_in=true');
  assert.strictEqual(r.valid, false);
});

check('expired token is rejected', function () {
  const iat = Math.floor(NOW_MS / 1000) - 40000;
  const exp = iat + 36000;
  const token = signPayload({ uid: 'budi', un: 'budi', adm: true, iat, exp }, TEST_SECRET);
  const r = session.verifySessionToken(token);
  assert.strictEqual(r.valid, false, 'expired token accepted');
  assert.strictEqual(r.reason, 'expired');
});

check('role escalation re-signed with a wrong key is rejected', function () {
  const iat = Math.floor(NOW_MS / 1000);
  const escalated = { uid: 'regularuser', un: 'regularuser', adm: true, iat, exp: iat + 3600 };
  const token = signPayload(escalated, 'attacker-controlled-key-not-the-server-secret-longer');
  const r = session.verifySessionToken(token);
  assert.strictEqual(r.valid, false, 'escalated token accepted: ' + JSON.stringify(r));
});

check('valid signed admin token is accepted with verified payload', function () {
  const iat = Math.floor(NOW_MS / 1000);
  const token = signPayload({ uid: 'budi-id', un: 'budi', adm: true, iat, exp: iat + 3600 }, TEST_SECRET);
  const r = session.verifySessionToken(token);
  assert.strictEqual(r.valid, true, 'valid token rejected');
  assert.strictEqual(r.payload.adm, true);
  assert.strictEqual(r.payload.uid, 'budi-id');
});

check('valid signed NON-admin token is accepted but cannot grant admin', function () {
  const iat = Math.floor(NOW_MS / 1000);
  const token = signPayload({ uid: 'u1', un: 'u1', adm: false, iat, exp: iat + 3600 }, TEST_SECRET);
  const r = session.verifySessionToken(token);
  assert.strictEqual(r.valid, true);
  const auth = session.requireAdminSession(fakeReqWithCookie(token));
  assert.strictEqual(auth.ok, false, 'non-admin session granted admin');
  assert.strictEqual(auth.status, 403);
});

check('token claiming exp-iat beyond the session window is rejected', function () {
  const iat = Math.floor(NOW_MS / 1000);
  const token = signPayload({ uid: 'budi', un: 'budi', adm: true, iat, exp: iat + 99999999 }, TEST_SECRET);
  const r = session.verifySessionToken(token);
  assert.strictEqual(r.valid, false, 'overlong token accepted');
  assert.strictEqual(r.reason, 'bad_times');
});

check('requireAdminSession rejects a request with NO credentials at all', function () {
  const auth = session.requireAdminSession({ headers: {} });
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.status, 401);
});

check('requireAdminSession grants ONLY via the signed admin session cookie', function () {
  const iat = Math.floor(NOW_MS / 1000);
  const token = signPayload({ uid: 'budi-id', un: 'budi', adm: true, iat, exp: iat + 3600 }, TEST_SECRET);
  const auth = session.requireAdminSession(fakeReqWithCookie(token));
  assert.strictEqual(auth.ok, true, 'signed admin session rejected');
  assert.strictEqual(auth.session.uid, 'budi-id');
});

check('admin-notes-handler source: insecure dev-preview zero-auth path is gone', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'admin-notes-handler.js'), 'utf8');
  assert.ok(src.indexOf("x-autocuan-preview') === '1'") === -1, 'dev-preview zero-auth bypass still present');
  assert.ok(src.indexOf("x-admin'] === '1'") === -1, 'x-admin zero-auth bypass still present');
  assert.ok(src.indexOf("requireAdminSession(req)") !== -1, 'checkAdminAuth does not route through requireAdminSession');
});

/* restore clock + secret */
Date.now = realNow;
delete process.env.SESSION_SECRET;

if (failures.length > 0) {
  console.error('\n[auth-truth] ' + failures.length + ' failure(s)');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n[auth-truth] all assertions passed');
process.exit(0);
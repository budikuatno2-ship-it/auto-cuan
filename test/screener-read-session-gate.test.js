'use strict';

// ===========================================================================
// The premium screener reads are gated on the signed ac_sess session, not on
// the X-User-Id / X-Username request headers.
//
// Why this file exists
// --------------------
// handleScreenerRead() and handleNkScreenerResults() used to open with an
// account lookup driven by X-User-Id / X-Username. It reads like an
// impersonation hole: name an approved user and you appear to be them.
//
// It never was one. api/sector-hot.js applies requirePremiumEntitlement() at the
// top of the handler — before any action routing — to exactly the premium browser
// reads (null, 'screener', 'nk-screener-results', 'daytrade-screener'). That gate
// resolves identity through requireAuthenticatedSession(), i.e. the HMAC-signed
// HttpOnly cookie and nothing else, then re-checks the app_users row for username
// match, is_blocked and is_approved. A spoofed header with no cookie is refused
// there with 401 and never reaches the handler.
//
// Measured against the real exported handler with a deliberately permissive
// Supabase stub (it returns the approved account for ANY lookup, so a 200 could
// only come from trusting headers):
//
//   spoofed X-Username, no cookie      401   401
//   spoofed X-User-Id,  no cookie      401   401
//   anonymous                          401   401
//   valid session, cookie only         403 -> 200   <-- the actual defect
//   valid session + legacy headers     200   200
//
// So the inner lookup was not a hole; it was a false negative. It rejected a
// correctly authenticated caller who sent only the session cookie, meaning the
// endpoint silently depended on the browser also sending legacy identity headers.
// It has been removed in favour of a fail-closed assertion on the upstream gate.
//
// LOCAL / STATIC ONLY. No network.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const adminSession = require('../lib/admin-session');

const SECRET = 'test-secret-for-screener-gate';
const APPROVED = {
  id: '11111111-2222-4333-8444-555555555555',
  username: 'approveduser',
  is_approved: true,
  is_blocked: false
};

// Permissive on purpose: every lookup resolves to the approved account, so any
// 200 below would prove the handler trusted the caller's headers.
function permissiveSupabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    limit: () => chain,
    order: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: APPROVED, error: null })
  };
  return { from: () => chain };
}

function loadHandler() {
  const resolved = require.resolve('../api/sector-hot.js');
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') return { createClient: () => permissiveSupabase() };
    return original.call(Module, request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = original;
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.payload = body; return res; },
    setHeader() { return res; },
    end() { return res; }
  };
  return res;
}

function withEnv(fn) {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET',
    'CRON_SECRET', 'ADMIN_USERNAMES', 'ADMIN_LEGACY_BUDI_PREVIEW'];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; });
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
  process.env.SESSION_SECRET = SECRET;
  process.env.CRON_SECRET = 'stub-cron-secret';
  delete process.env.ADMIN_USERNAMES;
  delete process.env.ADMIN_LEGACY_BUDI_PREVIEW;
  return Promise.resolve(fn()).finally(() => {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });
}

function call(handler, action, headers) {
  const res = makeRes();
  return handler({
    method: 'GET',
    query: { action },
    headers: Object.assign({ host: 'autocuan.web.id' }, headers || {}),
    body: {}
  }, res).then(() => res);
}

function validCookie() {
  const token = adminSession.createSessionToken({
    userId: APPROVED.id, username: APPROVED.username, isAdmin: false
  });
  assert.ok(token, 'creating a session token requires SESSION_SECRET');
  return adminSession.SESSION_COOKIE_NAME + '=' + token;
}

const PREMIUM_READS = ['screener', 'nk-screener-results', 'daytrade-screener'];
const REFUSED = [401, 403];

// ---------------------------------------------------------------------------
// Headers alone must never open the door
// ---------------------------------------------------------------------------

for (const action of PREMIUM_READS) {
  test('action=' + action + ' refuses a spoofed X-Username with no session', () => withEnv(async () => {
    const res = await call(loadHandler(), action, { 'x-username': APPROVED.username });
    assert.ok(
      REFUSED.includes(res.statusCode),
      'naming an approved user must not read premium data, got ' + res.statusCode
    );
  }));

  test('action=' + action + ' refuses a spoofed X-User-Id with no session', () => withEnv(async () => {
    const res = await call(loadHandler(), action, { 'x-user-id': APPROVED.id });
    assert.ok(REFUSED.includes(res.statusCode), 'knowing a real UUID must not authenticate anyone');
  }));

  test('action=' + action + ' refuses both spoofed headers together', () => withEnv(async () => {
    const res = await call(loadHandler(), action, {
      'x-user-id': APPROVED.id, 'x-username': APPROVED.username
    });
    assert.ok(REFUSED.includes(res.statusCode));
  }));

  test('action=' + action + ' refuses an anonymous caller', () => withEnv(async () => {
    const res = await call(loadHandler(), action, {});
    assert.ok(REFUSED.includes(res.statusCode));
  }));
}

test('a bare X-Username: budi does not open a premium read', () => withEnv(async () => {
  process.env.ADMIN_USERNAMES = 'budi';
  process.env.ADMIN_LEGACY_BUDI_PREVIEW = 'true';
  const res = await call(loadHandler(), 'screener', { 'x-username': 'budi' });
  assert.ok(
    REFUSED.includes(res.statusCode),
    'the legacy budi header predicate must not grant a read'
  );
}));

test('a tampered session cookie does not open a premium read', () => withEnv(async () => {
  const good = adminSession.createSessionToken({
    userId: APPROVED.id, username: APPROVED.username, isAdmin: false
  });
  const res = await call(loadHandler(), 'screener', {
    cookie: adminSession.SESSION_COOKIE_NAME + '=' + good.slice(0, -3) + 'AAA'
  });
  assert.ok(REFUSED.includes(res.statusCode));
}));

test('an expired session does not open a premium read', () => withEnv(async () => {
  const token = adminSession.createSessionToken(
    { userId: APPROVED.id, username: APPROVED.username, isAdmin: false },
    { maxAgeSeconds: 1 }
  );
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(adminSession.verifySessionToken(token).valid, false, 'token should have expired');
  const res = await call(loadHandler(), 'screener', {
    cookie: adminSession.SESSION_COOKIE_NAME + '=' + token
  });
  assert.ok(REFUSED.includes(res.statusCode));
}));

// ---------------------------------------------------------------------------
// A real session must work — with or without the legacy headers
// ---------------------------------------------------------------------------

test('a valid session works with the cookie alone', () => withEnv(async () => {
  const res = await call(loadHandler(), 'screener', { cookie: validCookie() });
  assert.ok(
    !REFUSED.includes(res.statusCode),
    'the endpoint must not require legacy identity headers on top of a valid '
    + 'session; it answered ' + res.statusCode
  );
}));

test('a valid session still works alongside the legacy headers', () => withEnv(async () => {
  // This is what the browser currently sends. It must keep working unchanged.
  const res = await call(loadHandler(), 'screener', {
    cookie: validCookie(), 'x-user-id': APPROVED.id, 'x-username': APPROVED.username
  });
  assert.ok(!REFUSED.includes(res.statusCode), 'the production browser path must not regress');
}));

test('the non-konglo read behaves the same way', () => withEnv(async () => {
  const cookieOnly = await call(loadHandler(), 'nk-screener-results', { cookie: validCookie() });
  assert.ok(!REFUSED.includes(cookieOnly.statusCode), 'cookie-only must be accepted');
  const spoofed = await call(loadHandler(), 'nk-screener-results', { 'x-username': APPROVED.username });
  assert.ok(REFUSED.includes(spoofed.statusCode), 'headers alone must be refused');
}));

// ---------------------------------------------------------------------------
// Source-level guards
// ---------------------------------------------------------------------------

const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');

test('the premium gate still covers every premium browser read', () => {
  const gate = src.indexOf('const premiumBrowserRead =');
  assert.ok(gate > 0, 'the premium read gate must exist');

  const window = src.slice(gate, gate + 400);
  for (const action of PREMIUM_READS) {
    assert.match(window, new RegExp("'" + action + "'"), action + ' must be listed in the gate');
  }
  assert.match(window, /action === null/, 'the default Sektor Hot list must stay gated too');
  assert.ok(gate < src.indexOf("if (action === 'screener')"), 'the gate must precede routing');
  assert.match(src.slice(gate, gate + 700), /requirePremiumEntitlement\(req, supabase\)/);
});

test('the screener handlers no longer resolve identity from request headers', () => {
  // The whole point of the change: no account lookup keyed off a client header.
  assert.doesNotMatch(
    src,
    /rawUserId\s*=\s*\(req\.headers\['x-user-id'\]/,
    'no handler may resolve an account from X-User-Id'
  );
  assert.ok(
    src.indexOf('function isLegacyBudiReadAllowed') === -1,
    'the bare X-Username: budi predicate must stay deleted, not dormant'
  );
});

test('both screener handlers keep a fail-closed backstop', () => {
  for (const fn of ['async function handleScreenerRead(', 'async function handleNkScreenerResults(']) {
    const at = src.indexOf(fn);
    assert.ok(at > 0, fn + ' must exist');
    const body = src.slice(at, at + 1600);
    assert.match(
      body,
      /req\._premiumAccessGranted !== true && !verifyCronSecret\(req\)/,
      fn + ' must refuse if it is ever reached without the upstream gate'
    );
  }
});

test('the premium gate resolves identity only from the signed session', () => {
  const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subscription-auth.js'), 'utf8');
  assert.match(auth, /requireAuthenticatedSession\(req\)/, 'identity comes from the signed cookie');
  assert.doesNotMatch(
    auth,
    /x-username|x-user-id/i,
    'the identity boundary must never read client-supplied identity headers'
  );
});

'use strict';

// Focused mocked tests for the server-side signed-session admin authentication.
// Local/mocked only: @supabase/supabase-js is stubbed via Module._load (it is not
// installed in this sandbox), and no production endpoint or real record is touched.
// No real password, token, device id, hash, or secret is used or printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'unit-test-session-secret-value';

// Load the session helper with a secret configured.
function loadSession() {
  process.env.SESSION_SECRET = SECRET;
  const abs = require.resolve('../lib/admin-session');
  delete require.cache[abs];
  return require('../lib/admin-session');
}

function requireApiWithSupabaseStub(relPath, createClientImpl) {
  const origLoad = Module._load;
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: createClientImpl || function () { return {}; } };
    return origLoad.apply(this, arguments);
  };
  try { return require(relPath); }
  finally { Module._load = origLoad; delete require.cache[abs]; }
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

function withEnv(extra, fn) {
  const keys = ['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NODE_ENV', 'VERCEL_ENV', 'TELEGRAM_VERIFY_CODE_SECRET'];
  const prev = {};
  keys.forEach(k => { prev[k] = process.env[k]; });
  process.env.SESSION_SECRET = SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  // v2 registration/pending-login issue a one-time Telegram code (HMAC keyed by
  // this secret). Provide a fixed test secret so the register endpoint is not in
  // its fail-closed state during these existing-behavior checks.
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'unit-test-verify-code-secret';
  Object.keys(extra || {}).forEach(k => { process.env[k] = extra[k]; });
  return Promise.resolve(fn()).finally(() => {
    keys.forEach(k => { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; });
  });
}

function supabaseWithUser(user, capture) {
  return function () {
    return {
      from() {
        const q = {
          select() { return q; }, eq() { return q; }, order() { return q; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: user || null, error: null }); },
          update(p) { if (capture) capture.updated = p; return q; },
          insert(p) { if (capture) capture.inserted = p; return { select() { return Promise.resolve({ data: [{ id: 'u1', username: p && p.username }], error: null }); } }; }
        };
        return q;
      },
      // v2 endpoints call service-role RPCs. Provide minimal happy-path returns so
      // the existing login/register behavior checks continue to pass.
      rpc(name, args) {
        if (capture) { capture.rpc = capture.rpc || []; capture.rpc.push({ name: name, args: args }); }
        if (name === 'register_pending_user_with_telegram_challenge') {
          return Promise.resolve({ data: [{ id: 'u1', username: args && args.p_username, created_at: new Date().toISOString(), challenge_id: 'ch1' }], error: null });
        }
        if (name === 'issue_telegram_challenge') {
          return Promise.resolve({ data: [{ challenge_id: 'ch1', expires_at: new Date().toISOString() }], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
    };
  };
}

function cookieFromRes(res) {
  const sc = res.headers['Set-Cookie'];
  return typeof sc === 'string' ? sc : (Array.isArray(sc) ? sc[0] : '');
}
function tokenFromCookie(cookieStr) {
  const m = /ac_sess=([^;]*)/.exec(cookieStr || '');
  return m ? m[1] : '';
}
function sameOriginHeaders(cookie) {
  return { host: 'app.test', origin: 'https://app.test', 'content-type': 'application/json', cookie: cookie || '' };
}

const S = loadSession();
const knownUser = { id: 'u1', username: 'alice', password_hash: 'goodhash', devices: ['dev_known'], is_blocked: false, is_approved: true };
const budiUser = { id: 'uadmin', username: 'budi', password_hash: 'goodhash', devices: ['dev_known'], is_blocked: false, is_approved: true };

// ============ SESSION CREATION (login) ============

// 1. Login success sets an HttpOnly session cookie
test('login success sets an HttpOnly, Path-scoped, Max-Age session cookie', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
    assert.equal(res.body.success, true);
    const cookie = cookieFromRes(res);
    assert.match(cookie, /ac_sess=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d+/);
  });
});

// 2. Production cookie includes Secure
test('production login cookie includes Secure', async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
    assert.match(cookieFromRes(res), /Secure/);
  });
});

// 3. Cookie uses SameSite protection
test('session cookie uses SameSite=Strict', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
    assert.match(cookieFromRes(res), /SameSite=Strict/);
  });
});

// 4 + 5. Token contains no plaintext password and no raw device id
test('session token embeds neither the password hash nor the raw device id', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
    const token = tokenFromCookie(cookieFromRes(res));
    assert.ok(token.length > 0);
    assert.equal(token.indexOf('goodhash'), -1, 'no password hash in token');
    assert.equal(token.indexOf('dev_known'), -1, 'no raw device id in token');
    const verified = S.verifySessionToken(token);
    assert.equal(verified.valid, true);
    assert.ok(!('password' in verified.payload) && !('password_hash' in verified.payload));
    assert.ok(!('deviceId' in verified.payload));
    assert.ok(verified.payload.dvh && verified.payload.dvh !== 'dev_known', 'device is stored only as a non-reversible hash');
  });
});

// Server derives admin from the DB username (never from the client)
test('login as DB user budi yields a server-signed admin session; normal user does not', async () => {
  await withEnv({}, async () => {
    let handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(budiUser));
    let res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'budi', passwordHash: 'goodhash', deviceId: 'dev_known', isAdmin: false, is_admin: false } }, res);
    assert.equal(S.verifySessionToken(tokenFromCookie(cookieFromRes(res))).payload.adm, true);
    assert.equal(res.body.isAdmin, true);

    handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known', is_admin: true, isAdmin: true } }, res);
    assert.equal(S.verifySessionToken(tokenFromCookie(cookieFromRes(res))).payload.adm, false);
    assert.equal(res.body.isAdmin, false);
  });
});

// ============ SESSION VERIFICATION HELPER ============

test('9-12: helper rejects malformed, tampered payload, tampered signature, and expired tokens', () => {
  process.env.SESSION_SECRET = SECRET;
  const good = S.createSessionToken({ userId: 'u1', username: 'alice', isAdmin: true, deviceId: 'd' });
  assert.equal(S.verifySessionToken('garbage').valid, false);              // malformed
  assert.equal(S.verifySessionToken('v1.only-two').valid, false);         // malformed
  const parts = good.split('.');
  const badPayload = [parts[0], parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A'), parts[2]].join('.');
  assert.equal(S.verifySessionToken(badPayload).valid, false);            // tampered payload
  const badSig = [parts[0], parts[1], parts[2].slice(0, -1) + (parts[2].slice(-1) === 'A' ? 'B' : 'A')].join('.');
  assert.equal(S.verifySessionToken(badSig).valid, false);                // tampered signature
  const expired = S.createSessionToken({ userId: 'u1', username: 'alice', isAdmin: true }, { maxAgeSeconds: -10 });
  assert.equal(S.verifySessionToken(expired).reason, 'expired');          // expired
  // a valid token round-trips
  assert.equal(S.verifySessionToken(good).valid, true);
});

test('no SESSION_SECRET => tokens cannot be created or verified (fail-closed)', () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
  const t = S.createSessionToken({ userId: 'u1', username: 'a', isAdmin: true });
  delete process.env.SESSION_SECRET;
  assert.equal(S.createSessionToken({ userId: 'u1', username: 'a', isAdmin: true }), null);
  assert.equal(S.verifySessionToken(t).valid, false);
  if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev;
});

// ============ ADMIN AUTHORIZATION ============

function adminReq(cookie, body, headerOverrides) {
  return { method: 'POST', headers: Object.assign(sameOriginHeaders(cookie), headerOverrides || {}), body: body || {} };
}

// 6. Valid signed admin session is accepted
test('valid signed admin session is accepted by admin-users', async () => {
  await withEnv({}, async () => {
    const token = S.createSessionToken({ userId: 'uadmin', username: 'budi', isAdmin: true, deviceId: 'd' });
    const handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    const res = makeRes();
    await handler(adminReq('ac_sess=' + token, { action: 'list' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  });
});

// 7. Valid normal-user session receives 403
test('normal-user session receives 403 from admin-users', async () => {
  await withEnv({}, async () => {
    const token = S.createSessionToken({ userId: 'u1', username: 'alice', isAdmin: false, deviceId: 'd' });
    const handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    const res = makeRes();
    await handler(adminReq('ac_sess=' + token, { action: 'list' }), res);
    assert.equal(res.statusCode, 403);
  });
});

// 8. Missing session receives 401
test('missing session receives 401 from all hardened admin endpoints', async () => {
  await withEnv({}, async () => {
    for (const ep of ['../api/admin-users', '../api/admin-logs']) {
      const handler = requireApiWithSupabaseStub(ep, supabaseWithUser(null));
      const res = makeRes();
      await handler(adminReq('', { action: 'list' }), res);
      assert.equal(res.statusCode, 401, ep + ' should 401 without a session');
    }
    const maint = requireApiWithSupabaseStub('../api/maintenance-settings', supabaseWithUser(null));
    const res = makeRes();
    await maint(adminReq('', { action: 'save', config: {} }), res);
    assert.equal(res.statusCode, 401);
  });
});

// 9-12 at the endpoint level: malformed / tampered / expired cookie => 401
test('malformed/tampered/expired session cookies are rejected by admin-users (401)', async () => {
  await withEnv({}, async () => {
    const expired = S.createSessionToken({ userId: 'u', username: 'budi', isAdmin: true }, { maxAgeSeconds: -5 });
    for (const cookieVal of ['ac_sess=garbage', 'ac_sess=v1.aaa.bbb', 'ac_sess=' + expired]) {
      const handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
      const res = makeRes();
      await handler(adminReq(cookieVal, { action: 'list' }), res);
      assert.equal(res.statusCode, 401, cookieVal + ' should be rejected');
    }
  });
});

// 13. adminName:"budi" WITHOUT a signed session is rejected
test('adminName:"budi" in the body without a signed session is rejected (401)', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    const res = makeRes();
    await handler(adminReq('', { adminName: 'budi', action: 'list' }), res);
    assert.equal(res.statusCode, 401);
  });
});

// 14. Client-supplied is_admin:true is ignored
test('client-supplied is_admin/isAdmin flags are ignored (still 401 without a real session)', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    const res = makeRes();
    await handler(adminReq('', { adminName: 'budi', is_admin: true, isAdmin: true, role: 'admin', action: 'list' }), res);
    assert.equal(res.statusCode, 401);
  });
});

// 15. Device ID alone cannot access admin endpoints
test('device id alone (no admin session) cannot access admin-users', async () => {
  await withEnv({}, async () => {
    // no session at all, but a device id supplied
    let handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    let res = makeRes();
    await handler(adminReq('', { deviceId: 'dev_known', action: 'list' }), res);
    assert.equal(res.statusCode, 401);
    // a normal-user session + device id => still 403 (not admin)
    const token = S.createSessionToken({ userId: 'u1', username: 'alice', isAdmin: false, deviceId: 'dev_known' });
    handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    res = makeRes();
    await handler(adminReq('ac_sess=' + token, { deviceId: 'dev_known', action: 'list' }), res);
    assert.equal(res.statusCode, 403);
  });
});

// 16. Logout clears the cookie
test('logout action clears the session cookie (Max-Age=0) without needing a valid token', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(null));
    const res = makeRes();
    await handler({ method: 'POST', headers: { host: 'app.test' }, body: { action: 'logout' } }, res);
    assert.equal(res.body.success, true);
    const cookie = cookieFromRes(res);
    assert.match(cookie, /ac_sess=;/);
    assert.match(cookie, /Max-Age=0/);
  });
});

// 17. Invalid username and invalid password return the same generic response
test('invalid username and invalid password return an identical generic error', async () => {
  await withEnv({}, async () => {
    let handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(null)); // unknown username
    let r1 = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'ghost', passwordHash: 'x', deviceId: 'd' } }, r1);

    handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser)); // wrong password
    let r2 = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'WRONG', deviceId: 'd' } }, r2);

    assert.equal(r1.statusCode, 400);
    assert.equal(r2.statusCode, 400);
    assert.equal(r1.body.error, r2.body.error);
    assert.equal(r1.body.error, 'Username atau password salah.');
  });
});

// 18. SESSION_SECRET is never returned in responses, embedded in tokens, or logged
test('SESSION_SECRET is never returned, embedded, or logged', async () => {
  await withEnv({}, async () => {
    const captured = [];
    const origErr = console.error, origLog = console.log;
    console.error = function () { captured.push(Array.from(arguments).join(' ')); };
    console.log = function () { captured.push(Array.from(arguments).join(' ')); };
    try {
      const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
      const res = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
      const cookie = cookieFromRes(res);
      assert.equal(JSON.stringify(res.body).indexOf(SECRET), -1, 'secret not in response body');
      assert.equal(cookie.indexOf(SECRET), -1, 'secret not embedded in cookie/token');
      // trigger a logged error path too
      const h2 = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
      const r2 = makeRes();
      await h2({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'WRONG', deviceId: 'd' } }, r2);
    } finally {
      console.error = origErr; console.log = origLog;
    }
    const all = captured.join('\n');
    assert.equal(all.indexOf(SECRET), -1, 'secret must never be logged');
    assert.equal(all.indexOf('goodhash'), -1, 'password hash must never be logged');
  });
  // the helper source performs no console logging at all
  const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'admin-session.js'), 'utf8');
  assert.doesNotMatch(libSrc, /console\./);
});

// 19. Cross-origin state-changing admin requests are rejected
test('cross-origin admin request is rejected even with a valid admin cookie', async () => {
  await withEnv({}, async () => {
    const token = S.createSessionToken({ userId: 'uadmin', username: 'budi', isAdmin: true, deviceId: 'd' });
    const handler = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    const res = makeRes();
    await handler({ method: 'POST', headers: { host: 'app.test', origin: 'https://evil.test', cookie: 'ac_sess=' + token }, body: { action: 'list' } }, res);
    assert.equal(res.statusCode, 403);
  });
});

// maintenance GET stays public (non-sensitive maintenance message)
test('maintenance-settings GET remains public (no session required)', async () => {
  await withEnv({}, async () => {
    const handler = requireApiWithSupabaseStub('../api/maintenance-settings', supabaseWithUser(null));
    const res = makeRes();
    await handler({ method: 'POST', headers: { host: 'app.test' }, body: { action: 'get' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  });
});

// 20. Existing valid login + register behavior remains passing
test('existing valid login and register still succeed', async () => {
  await withEnv({}, async () => {
    const login = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    let res = makeRes();
    await login({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.userId, 'u1');

    const capture = {};
    const reg = requireApiWithSupabaseStub('../api/register-user', supabaseWithUser(null, capture));
    res = makeRes();
    await reg({ method: 'POST', headers: sameOriginHeaders(), body: { username: 'newuser', passwordHash: 'h', deviceId: 'dev_x', userAgent: 'ua' } }, res);
    assert.equal(res.body.success, true);
    assert.ok(!('password' in res.body));
  });
});

// 21 + 22. The existing Chart and Portfolio test files remain present (untouched)
test('existing Chart and Portfolio test files are still present', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'chart-export-and-responsive.test.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'portfolio-and-security.test.js')));
});

// 23. API endpoint count remains exactly 12 (session helper lives in lib/, not api/)
test('api/ still exposes exactly 12 endpoint JS files', () => {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 12, 'found: ' + files.join(', '));
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'admin-session.js')), 'session helper must live under lib/');
});

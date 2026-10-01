'use strict';

// ===========================================================================
// Security tests for api/log.js.
//
// Before hardening, this endpoint was an unauthenticated, unbounded write port:
// any host on the internet could POST {action:'login', username:'budi',
// isAdmin:true} and forge an admin login row in the audit trail an operator
// reads when deciding whether an account was compromised — and could POST an
// arbitrary-length fullResultHtml into ai_analysis_logs at the project's
// storage expense.
//
// The contract these tests pin down:
//   - a signed session decides identity; the body can never upgrade it
//   - is_admin comes from the session's signed flag and from nothing else
//   - anonymous callers may still log, but always as guests
//   - persisted strings are length-capped
//   - cross-origin callers are refused
//   - failures stay fail-soft (200 + success:false), so logging never breaks
//     the UI
//
// LOCAL / STATIC ONLY. Supabase is stubbed; no network.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const adminSession = require('../lib/admin-session');

const SECRET = 'test-secret-for-log-endpoint';

// Load api/log.js with @supabase/supabase-js swapped for a capturing stub.
function loadHandler(capture) {
  const resolved = require.resolve('../api/log.js');
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') {
      return {
        createClient() {
          return {
            from(table) {
              capture.table = table;
              return {
                insert(row) {
                  capture.inserted = row;
                  return { select: () => Promise.resolve({ data: [row], error: null }) };
                }
              };
            }
          };
        }
      };
    }
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
    json(body) { res.payload = body; return res; }
  };
  return res;
}

function withEnv(fn) {
  const saved = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SESSION_SECRET: process.env.SESSION_SECRET
  };
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
  process.env.SESSION_SECRET = SECRET;
  return Promise.resolve(fn()).finally(() => {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });
}

function sessionCookie(input) {
  const token = adminSession.createSessionToken(input);
  assert.ok(token, 'a session token requires SESSION_SECRET');
  return adminSession.SESSION_COOKIE_NAME + '=' + token;
}

// A unique client IP per test keeps the per-instance rate limiter from
// leaking state between cases.
let ipCounter = 0;
function req(body, headers) {
  ipCounter += 1;
  return {
    method: 'POST',
    body,
    headers: Object.assign({ 'x-forwarded-for': '203.0.113.' + (ipCounter % 250) }, headers || {})
  };
}

// ---------------------------------------------------------------------------
// Identity cannot be forged
// ---------------------------------------------------------------------------

test('a body cannot claim admin identity without a signed session', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const res = makeRes();

  await handler(req({ action: 'login', username: 'budi', isAdmin: true, isGuest: false }), res);

  assert.equal(capture.table, 'login_logs');
  assert.equal(capture.inserted.is_admin, false, 'a body-claimed admin flag must be ignored');
  assert.equal(capture.inserted.is_guest, true, 'no session means the caller is a guest');
}));

test('a signed session decides the username, overriding the body', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const res = makeRes();

  await handler(req(
    { action: 'search', username: 'someone-else', ticker: 'bbca' },
    { cookie: sessionCookie({ userId: 'u-1', username: 'alice', isAdmin: false }) }
  ), res);

  assert.equal(capture.inserted.username, 'alice', 'identity comes from the session, not the body');
  assert.equal(capture.inserted.ticker, 'BBCA');
}));

test('is_admin is true only when the signed session carries the admin flag', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);

  await handler(req(
    { action: 'login', username: 'ignored', isAdmin: false },
    { cookie: sessionCookie({ userId: 'u-2', username: 'budi', isAdmin: true }) }
  ), makeRes());

  assert.equal(capture.inserted.username, 'budi');
  assert.equal(capture.inserted.is_admin, true);
  assert.equal(capture.inserted.is_guest, false);
}));

test('a tampered session cookie is treated as anonymous, not as its payload', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const good = adminSession.createSessionToken({ userId: 'u-3', username: 'budi', isAdmin: true });
  const tampered = good.slice(0, -3) + 'AAA';

  await handler(req(
    { action: 'login', username: 'budi', isAdmin: true },
    { cookie: adminSession.SESSION_COOKIE_NAME + '=' + tampered }
  ), makeRes());

  assert.equal(capture.inserted.is_admin, false, 'a bad signature must not grant admin');
  assert.equal(capture.inserted.is_guest, true);
}));

test('anonymous callers can still log, as guests', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const res = makeRes();

  await handler(req({ action: 'login', username: 'visitor', userAgent: 'ua' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(capture.inserted.username, 'visitor', 'guest analytics is the point of this endpoint');
  assert.equal(capture.inserted.is_guest, true);
}));

// ---------------------------------------------------------------------------
// Size and content bounds
// ---------------------------------------------------------------------------

test('persisted strings are length-capped', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const { LIMITS } = handler.__test;

  await handler(req({
    action: 'analysis',
    username: 'x'.repeat(500),
    ticker: 'y'.repeat(500),
    mode: 'z'.repeat(500),
    resultSummary: 'a'.repeat(50000),
    fullResultHtml: 'b'.repeat(500000)
  }), makeRes());

  assert.equal(capture.inserted.username.length, LIMITS.username);
  assert.equal(capture.inserted.ticker.length, LIMITS.ticker);
  assert.equal(capture.inserted.mode.length, LIMITS.mode);
  assert.equal(capture.inserted.result_summary.length, LIMITS.resultSummary);
  assert.equal(
    capture.inserted.full_result_html.length,
    LIMITS.fullResultHtml,
    'an unbounded html field is free storage for anyone who finds the endpoint'
  );
}));

test('control characters are stripped from persisted values', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const DEL = String.fromCharCode(127);

  await handler(req({
    action: 'search',
    username: 'a' + NUL + 'bc' + ESC,
    ticker: 'bbca',
    source: 'xy' + DEL
  }), makeRes());

  const control = /[\u0000-\u001F\u007F]/;
  assert.doesNotMatch(capture.inserted.username, control, "a log row must not carry terminal escapes");
  assert.doesNotMatch(capture.inserted.source, control);
}));

test('secrets in the body are never persisted', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);

  await handler(req({ action: 'login', username: 'alice', password: 'sneaky', token: 'sneaky' }), makeRes());

  assert.ok(!('password' in capture.inserted));
  assert.ok(!('token' in capture.inserted));
}));

// ---------------------------------------------------------------------------
// Request-level guards
// ---------------------------------------------------------------------------

test('a cross-origin caller is refused', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const res = makeRes();

  await handler(req(
    { action: 'login', username: 'attacker' },
    { host: 'autocuan.web.id', origin: 'https://evil.example' }
  ), res);

  assert.equal(res.statusCode, 403);
  assert.equal(capture.inserted, undefined, 'nothing may be written for a cross-origin caller');
}));

test('a same-origin caller is accepted', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const res = makeRes();

  await handler(req(
    { action: 'login', username: 'visitor' },
    { host: 'autocuan.web.id', origin: 'https://autocuan.web.id' }
  ), res);

  assert.equal(res.statusCode, 200);
  assert.ok(capture.inserted);
}));

test('rotating body.username does NOT mint a fresh rate-limit bucket', () => withEnv(async () => {
  // The limiter used to key on the resolved `username`, which for an anonymous
  // caller comes straight from the request body. Rotating it gave every request
  // its own bucket, so one IP could exceed MAX_PER_WINDOW without bound just by
  // counting upwards. The same-username test below could never catch this,
  // because it reuses one name.
  const capture = {};
  const handler = loadHandler(capture);
  const headers = { 'x-forwarded-for': '198.51.100.42' };
  const max = handler.__test.MAX_PER_WINDOW;

  let limited = 0;
  for (let i = 0; i < max + 10; i++) {
    const res = makeRes();
    await handler({
      method: 'POST',
      // A different identity on every single request.
      body: { action: 'search', username: 'rotate-' + i, ticker: 'BBCA' },
      headers
    }, res);
    if (res.statusCode === 429) limited += 1;
  }

  assert.ok(
    limited >= 10,
    'a single IP rotating body.username must still be limited; only ' + limited
    + ' of ' + (max + 10) + ' requests were refused'
  );
}));

test('the rate-limit key is derived only from server-observed values', () => withEnv(async () => {
  const handler = loadHandler({});
  const { rateLimitKey } = handler.__test;
  const req = (ip) => ({ headers: { 'x-forwarded-for': ip } });

  // Anonymous: the body cannot influence the key at all, so it is not passed in.
  assert.equal(rateLimitKey(req('1.2.3.4'), null), 'anon|1.2.3.4');
  assert.equal(
    rateLimitKey(req('1.2.3.4'), null),
    rateLimitKey(req('1.2.3.4'), null),
    'two anonymous requests from one IP share a bucket'
  );
  assert.notEqual(
    rateLimitKey(req('1.2.3.4'), null),
    rateLimitKey(req('5.6.7.8'), null),
    'different IPs get different buckets'
  );

  // Authenticated: uid comes from the signed cookie, which cannot be forged.
  assert.equal(rateLimitKey(req('1.2.3.4'), { uid: 'u-1' }), 'uid:u-1|1.2.3.4');
  assert.notEqual(
    rateLimitKey(req('1.2.3.4'), { uid: 'u-1' }),
    rateLimitKey(req('1.2.3.4'), { uid: 'u-2' }),
    'one account cannot exhaust another account behind the same NAT'
  );
  assert.notEqual(
    rateLimitKey(req('1.2.3.4'), { uid: 'u-1' }),
    rateLimitKey(req('9.9.9.9'), { uid: 'u-1' }),
    'one account cannot multiply its budget by hopping addresses'
  );
}));

test('the rate-limit key never contains a body-supplied value', () => withEnv(async () => {
  const handler = loadHandler({});
  const { rateLimitKey } = handler.__test;
  const key = rateLimitKey({ headers: { 'x-forwarded-for': '203.0.113.9' } }, null);
  assert.doesNotMatch(key, /rotate|attacker|budi/, 'the key is IP-derived only');
  assert.equal(rateLimitKey.length, 2, 'it takes (req, session) — no body parameter to trust');
}));

test('an authenticated flood is limited on its own session bucket', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const cookie = sessionCookie({ userId: 'u-flood', username: 'alice', isAdmin: false });
  const headers = { 'x-forwarded-for': '198.51.100.77', cookie };
  const max = handler.__test.MAX_PER_WINDOW;

  let limited = 0;
  for (let i = 0; i < max + 5; i++) {
    const res = makeRes();
    // Rotate the body identity here too; the session must decide the bucket.
    await handler({ method: 'POST', body: { action: 'search', username: 'x' + i, ticker: 'BBCA' }, headers }, res);
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 5, 'a signed-in flood must be refused past the budget, got ' + limited);
}));

test('a flood from one caller is rate limited', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const headers = { 'x-forwarded-for': '198.51.100.7' };
  const max = handler.__test.MAX_PER_WINDOW;

  let limited = 0;
  for (let i = 0; i < max + 5; i++) {
    const res = makeRes();
    await handler({ method: 'POST', body: { action: 'search', username: 'flooder', ticker: 'BBCA' }, headers }, res);
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 5, 'requests past the window budget must be refused, got ' + limited);
}));

test('non-POST methods are rejected', () => withEnv(async () => {
  const handler = loadHandler({});
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
}));

test('an unknown action is rejected without writing', () => withEnv(async () => {
  const capture = {};
  const handler = loadHandler(capture);
  const res = makeRes();
  await handler(req({ action: 'drop-table', username: 'x' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(capture.inserted, undefined);
}));

// ---------------------------------------------------------------------------
// Fail-soft contract
// ---------------------------------------------------------------------------

test('a missing database configuration stays fail-soft', () => withEnv(async () => {
  const handler = loadHandler({});
  delete process.env.SUPABASE_URL;
  const res = makeRes();
  await handler(req({ action: 'login', username: 'x' }), res);
  assert.equal(res.statusCode, 200, 'telemetry problems must never surface as a broken UI');
  assert.equal(res.payload.success, false);
}));

test('the endpoint never returns a stack trace or the service key', () => withEnv(async () => {
  const handler = loadHandler({});
  const res = makeRes();
  await handler(req({ action: 'login', username: 'x' }), res);
  const serialised = JSON.stringify(res.payload || {});
  assert.doesNotMatch(serialised, /stub-service-key/);
  assert.doesNotMatch(serialised, /at .*\.js:\d+/);
}));

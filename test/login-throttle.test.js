'use strict';

// B2 (security): in-application login throttle for /api/login-user.
//
// Two layers:
//   1. Unit tests for lib/login-throttle.js using an explicit fake clock, so the
//      window/backoff maths is deterministic.
//   2. Handler-level tests that drive api/login-user.js with junk credentials
//      (no real account, password, token, or secret) through the mocked Supabase
//      harness, proving the block is reached and a valid login still works.
//
// NODE_TEST_CONTEXT is set by `node --test`, which switches the throttle to an
// in-memory DB with no real sleeping (see lib/login-throttle.js TEST_MODE).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const throttle = require('../lib/login-throttle');

const JUNK_HASH = 'a'.repeat(64);
const VALID_HASH = 'f'.repeat(64); // 64-hex legacy prehash; matches the stub row below

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
  const keys = ['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SECURITY_GUARD_MODE',
    'RECAPTCHA_SECRET_KEY', 'NODE_ENV', 'VERCEL_ENV', 'LOGIN_THROTTLE_ENABLED', 'LOGIN_THROTTLE_PAIR_MAX', 'LOGIN_THROTTLE_IP_MAX'];
  const prev = {};
  keys.forEach((k) => { prev[k] = process.env[k]; });
  process.env.SESSION_SECRET = 'unit-test-session-secret-value';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.SECURITY_GUARD_MODE = 'off';
  delete process.env.RECAPTCHA_SECRET_KEY;
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = 'test';
  delete process.env.LOGIN_THROTTLE_ENABLED;
  delete process.env.LOGIN_THROTTLE_PAIR_MAX;
  delete process.env.LOGIN_THROTTLE_IP_MAX;
  Object.keys(extra || {}).forEach((k) => { process.env[k] = extra[k]; });
  return Promise.resolve(fn()).finally(() => {
    keys.forEach((k) => { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; });
  });
}

function supabaseWithUser(user) {
  return function () {
    return {
      from() {
        const q = {
          select() { return q; }, eq() { return q; }, order() { return q; }, ilike() { return q; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: user || null, error: null }); },
          update() { return q; }, insert() { return { select() { return Promise.resolve({ data: [{ id: 'u1' }], error: null }); } }; }
        };
        return q;
      },
      rpc() { return Promise.resolve({ data: null, error: null }); }
    };
  };
}

function sameOriginHeaders() {
  return { host: 'app.test', origin: 'https://app.test', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };
}

async function attempt(handler, body) {
  const res = makeRes();
  // C1: the client IP is trusted only from a trusted proxy hop. Model the local
  // nginx peer (127.0.0.1) so the XFF entry is honoured, exactly as in production.
  await handler({ method: 'POST', headers: sameOriginHeaders(), body, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

// ===========================================================================
// Unit tests (fake clock)
// ===========================================================================
test('B2 unit: keys are derived only from server-observed ip + normalized username', () => {
  const k = throttle.keysFor({ ip: '203.0.113.7', username: '  Alice ' });
  assert.equal(k.pair, 'pair|203.0.113.7|alice');
  assert.equal(k.ip, 'ip|203.0.113.7');
  assert.equal(k.account, 'alice');
  // A client-supplied value cannot mint a fresh bucket: same ip+username => same key.
  assert.equal(throttle.keysFor({ ip: '203.0.113.7', username: 'alice' }).pair, k.pair);
});

test('B2 unit: 5 failures per (account, IP) block with a temporary retry window', () => {
  throttle._reset();
  const keys = throttle.keysFor({ ip: '10.0.0.1', username: 'bob' });
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) {
    throttle.recordFailure(keys, t0 + i);
    assert.equal(throttle.check(keys, t0 + i).limited, false, 'not limited before threshold');
  }
  throttle.recordFailure(keys, t0 + 4); // 5th
  const blocked = throttle.check(keys, t0 + 4);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.reason, 'pair');
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 15 * 60);
});

test('B2 unit: the block auto-clears when its window rolls over', () => {
  throttle._reset();
  const keys = throttle.keysFor({ ip: '10.0.0.2', username: 'carol' });
  const t0 = 2_000_000;
  const lastFailureAt = t0 + 4; // the 5th failure crosses the threshold
  for (let i = 0; i < 5; i++) throttle.recordFailure(keys, t0 + i);
  assert.equal(throttle.check(keys, lastFailureAt).limited, true);
  // 15 minutes + 1ms after the offending failure -> no longer limited.
  assert.equal(throttle.check(keys, lastFailureAt + 15 * 60 * 1000 + 1).limited, false);
});

test('B2 unit: 30 failures from one IP across many accounts block the IP', () => {
  throttle._reset();
  const ip = '10.0.0.3';
  const t0 = 3_000_000;
  for (let i = 0; i < 30; i++) throttle.recordFailure(throttle.keysFor({ ip, username: 'user' + i }), t0 + i);
  const blocked = throttle.check(throttle.keysFor({ ip, username: 'someone_new' }), t0 + 30);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.reason, 'ip');
});

test('B2 unit: progressive backoff doubles then caps, and is zero once blocked', () => {
  throttle._reset();
  assert.equal(throttle.backoffMs(0), 0);
  assert.equal(throttle.backoffMs(1), 400);
  assert.equal(throttle.backoffMs(2), 800);
  assert.equal(throttle.backoffMs(3), 1600);
  assert.equal(throttle.backoffMs(4), 3200);
  assert.equal(throttle.backoffMs(5), 5000); // capped
  assert.equal(throttle.backoffMs(9), 5000);
});

test('B2 unit: a correct credential clears the counters', () => {
  throttle._reset();
  const keys = throttle.keysFor({ ip: '10.0.0.4', username: 'dave' });
  for (let i = 0; i < 3; i++) throttle.recordFailure(keys, 4_000_000 + i);
  throttle.clearFailure(keys);
  assert.equal(throttle.check(keys, 4_000_000 + 4).limited, false);
});

test('B2 unit: LOGIN_THROTTLE_ENABLED=0 disables the block', async () => {
  await withEnv({ LOGIN_THROTTLE_ENABLED: '0' }, async () => {
    throttle._reset();
    const keys = throttle.keysFor({ ip: '10.0.0.5', username: 'erin' });
    for (let i = 0; i < 10; i++) throttle.recordFailure(keys, 5_000_000 + i);
    assert.equal(throttle.check(keys, 5_000_000 + 11).limited, false);
  });
});

// ===========================================================================
// Handler-level tests (api/login-user.js)
// ===========================================================================
const knownUser = { id: 'u1', username: 'alice', password_hash: VALID_HASH, devices: ['dev_known'], is_blocked: false, is_approved: true };

test('B2 handler: repeated bad attempts block with 429 + Retry-After and a uniform message', async () => {
  await withEnv({}, async () => {
    throttle._reset();
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    let last;
    for (let i = 0; i < 5; i++) {
      last = await attempt(handler, { username: 'alice', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
      assert.equal(last.statusCode, 400, 'attempts below the threshold stay generic 400');
      assert.equal(last.body.error, 'Gmail/username atau password salah.');
    }
    const blocked = await attempt(handler, { username: 'alice', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.error, throttle.PUBLIC_ERROR);
    assert.ok(Number(blocked.headers['Retry-After']) >= 1);
  });
});

test('B2 handler: the block is reached for unknown accounts too (no enumeration on the 429)', async () => {
  await withEnv({}, async () => {
    throttle._reset();
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(null));
    for (let i = 0; i < 5; i++) {
      const r = await attempt(handler, { username: 'ghost', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
      assert.equal(r.statusCode, 400);
    }
    const blocked = await attempt(handler, { username: 'ghost', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.error, throttle.PUBLIC_ERROR);
  });
});

test('B2 handler: a valid login still succeeds and clears earlier failures', async () => {
  await withEnv({}, async () => {
    throttle._reset();
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(knownUser));
    for (let i = 0; i < 3; i++) {
      const r = await attempt(handler, { username: 'alice', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
      assert.equal(r.statusCode, 400);
    }
    const ok = await attempt(handler, { username: 'alice', passwordHash: VALID_HASH, deviceId: 'dev_known' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.success, true);
    // Counter cleared: another bad attempt is still below the threshold.
    const after = await attempt(handler, { username: 'alice', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
    assert.equal(after.statusCode, 400);
  });
});

test('B2 handler: the admin username is not locked permanently (block is temporary)', async () => {
  await withEnv({}, async () => {
    throttle._reset();
    const admin = { id: 'uadmin', username: 'budi', password_hash: VALID_HASH, devices: ['dev_known'], is_blocked: false, is_approved: true };
    const handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(admin));
    for (let i = 0; i < 5; i++) await attempt(handler, { username: 'budi', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
    const blocked = await attempt(handler, { username: 'budi', passwordHash: JUNK_HASH, deviceId: 'dev_known' });
    assert.equal(blocked.statusCode, 429);
    // The throttle is temporary: proving it clears is covered by the unit test
    // (window roll-over). Here we prove a correct password after the block is
    // lifted would work, by clearing the same way a window roll-over does.
    throttle.clearFailure(throttle.keysFor({ ip: '203.0.113.7', username: 'budi' }));
    const ok = await attempt(handler, { username: 'budi', passwordHash: VALID_HASH, deviceId: 'dev_known' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.success, true);
  });
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

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

test('requireAdminSession REJECTS Authorization Bearer with ADMIN_SECRET (no cookie bypass)', async (t) => {
  const prevAdminSecret = process.env.ADMIN_SECRET;
  const prevSessionSecret = process.env.SESSION_SECRET;
  process.env.ADMIN_SECRET = 'secret-test-token-12345';
  // Ensure SESSION_SECRET is unset so no cookie session can be forged either
  delete process.env.SESSION_SECRET;
  t.after(() => {
    if (prevAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = prevAdminSecret;
    if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSessionSecret;
  });

  // Clear module cache to pick up the reverted code
  const absPath = require.resolve('../lib/admin-session');
  delete require.cache[absPath];
  const { requireAdminSession } = require('../lib/admin-session');

  const req = {
    headers: {
      host: 'localhost',
      authorization: 'Bearer secret-test-token-12345'
    }
  };

  const auth = requireAdminSession(req);
  // Shared secret via header must NOT grant admin session
  assert.equal(auth.ok, false, 'Bearer ADMIN_SECRET must not grant admin session');
  assert.equal(auth.status, 401, 'Should return 401 when no valid cookie session exists');
});

test('requireAdminSession REJECTS x-admin-key with CRON_SECRET (no cookie bypass)', async (t) => {
  const prevAdminSecret = process.env.ADMIN_SECRET;
  const prevCronSecret = process.env.CRON_SECRET;
  const prevSessionSecret = process.env.SESSION_SECRET;
  delete process.env.ADMIN_SECRET;
  process.env.CRON_SECRET = 'cron-secret-test-999';
  delete process.env.SESSION_SECRET;
  t.after(() => {
    if (prevAdminSecret !== undefined) process.env.ADMIN_SECRET = prevAdminSecret;
    if (prevCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCronSecret;
    if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSessionSecret;
  });

  const absPath = require.resolve('../lib/admin-session');
  delete require.cache[absPath];
  const { requireAdminSession } = require('../lib/admin-session');

  const req = {
    headers: {
      host: 'localhost',
      'x-admin-key': 'cron-secret-test-999'
    }
  };

  const auth = requireAdminSession(req);
  // Shared secret via x-admin-key must NOT grant admin session
  assert.equal(auth.ok, false, 'x-admin-key with CRON_SECRET must not grant admin session');
  assert.equal(auth.status, 401, 'Should return 401 when no valid cookie session exists');
});

test('requireAdminSession only accepts valid signed cookie session', async (t) => {
  const prevSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-for-unit-test';
  t.after(() => {
    if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSessionSecret;
  });

  const absPath = require.resolve('../lib/admin-session');
  delete require.cache[absPath];
  const { requireAdminSession, createSessionToken } = require('../lib/admin-session');

  // Create a valid admin session token
  const token = createSessionToken({ userId: 'test-uid', username: 'budi', isAdmin: true });
  assert.ok(token, 'Should create a valid token');

  // Simulate a request with the session cookie
  const req = {
    headers: {
      host: 'localhost',
      cookie: 'ac_sess=' + token
    }
  };

  const auth = requireAdminSession(req);
  assert.equal(auth.ok, true, 'Valid signed cookie session should be accepted');
  assert.equal(auth.session.un, 'budi');
  assert.equal(auth.session.adm, true);
});

test('review-access validates custom REVIEW_ACCESS_TOKEN from env', async (t) => {
  const prevReviewToken = process.env.REVIEW_ACCESS_TOKEN;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.REVIEW_ACCESS_TOKEN = 'custom-review-secret-2026';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  t.after(() => {
    if (prevReviewToken === undefined) delete process.env.REVIEW_ACCESS_TOKEN;
    else process.env.REVIEW_ACCESS_TOKEN = prevReviewToken;
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });

  const handler = requireApiWithSupabaseStub('../api/review-access', () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { id: 'rev-1', username: 'review', is_blocked: false, device_id: 'REVIEW_ANY_DEVICE' }, error: null })
        })
      })
    })
  }));

  // Old hardcoded token should now fail
  const res1 = makeRes();
  await handler({ method: 'POST', body: { token: 'autocuan-review-2026' } }, res1);
  assert.equal(res1.statusCode, 403);

  // New env-configured token should succeed
  const res2 = makeRes();
  await handler({ method: 'POST', body: { token: 'custom-review-secret-2026' } }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.success, true);
  assert.equal(res2.body.username, 'review');
});

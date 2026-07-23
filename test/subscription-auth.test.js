'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const session = require('../lib/admin-session');
const auth = require('../lib/subscription-auth');
const { getEntitlements } = require('../lib/entitlements');

const ROOT = path.resolve(__dirname, '..');

function request(token, extra) {
  return Object.assign({ headers: token ? { cookie: session.SESSION_COOKIE_NAME + '=' + token } : {} }, extra || {});
}
function withSecret(fn) {
  const old = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'phase-1-test-secret';
  try { return fn(); } finally { if (old === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = old; }
}
function token(userId, username, opts) { return session.createSessionToken({ userId: userId, username: username, isAdmin: username === 'budi' }, opts); }

test('signed regular-user session accepts only a valid cookie and ignores forged headers', () => withSecret(() => {
  const valid = token('user-a', 'alice');
  assert.deepEqual(auth.getAuthenticatedUser(request(valid, { headers: { cookie: session.SESSION_COOKIE_NAME + '=' + valid, 'x-user-id': 'user-b', 'x-username': 'budi' } })), { id: 'user-a', username: 'alice', isAdmin: false });
  assert.equal(auth.getAuthenticatedUser(request(null)), null);
  assert.equal(auth.getAuthenticatedUser(request(valid.slice(0, -1) + 'x')), null);
  assert.equal(auth.getAuthenticatedUser(request(token('user-a', 'alice', { maxAgeSeconds: -1 }))), null);
}));

test('phase 1 entitlement defaults are safe and preserve protected budi', () => {
  assert.equal(getEntitlements({ username: 'alice' }, { username: 'alice', is_blocked: false }).premium, false);
  const blocked = getEntitlements({ username: 'alice' }, { username: 'alice', is_blocked: true });
  assert.equal(blocked.premium, false);
  assert.equal(blocked.entitlement_status, 'blocked');
  const budi = getEntitlements({ username: 'budi' }, { username: 'budi', is_blocked: true });
  assert.equal(budi.access_level, 'admin');
  assert.equal(budi.premium, true);
});

function loadHandler(createClient) {
  const original = Module._load;
  const filename = require.resolve('../api/login-user');
  delete require.cache[filename];
  Module._load = function (name) {
    if (name === '@supabase/supabase-js') return { createClient: createClient };
    return original.apply(this, arguments);
  };
  try { return require('../api/login-user'); } finally { Module._load = original; delete require.cache[filename]; }
}
function response() { return { statusCode: null, body: null, status(n) { this.statusCode = n; return this; }, json(o) { this.body = o; return this; } }; }
function clientFor(account, capture) {
  return function () { return { from() { return { select() { return this; }, eq(field, value) { capture.eq = [field, value]; return this; }, maybeSingle() { return Promise.resolve({ data: account, error: null }); } }; } }; };
}

test('subscription-status uses the signed identity and returns safe fields only', async () => {
  const oldSecret = process.env.SESSION_SECRET, oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SESSION_SECRET = 'phase-1-test-secret'; process.env.SUPABASE_URL = 'https://example.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret';
  try {
    const capture = {};
    const handler = loadHandler(clientFor({ id: 'user-a', username: 'alice', is_blocked: false, is_approved: true, password_hash: 'must-not-leak', telegram_user_id: 'must-not-leak' }, capture));
    const res = response();
    const valid = token('user-a', 'alice');
    await handler(request(valid, { method: 'POST', query: { action: 'subscription-status' }, body: { action: 'subscription-status', username: 'budi' }, headers: { cookie: session.SESSION_COOKIE_NAME + '=' + valid, 'x-user-id': 'budi-id', 'x-username': 'budi' } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(capture.eq, ['id', 'user-a']);
    assert.deepEqual(Object.keys(res.body).sort(), ['account', 'entitlement', 'success']);
    assert.equal(res.body.account.username, 'alice');
    assert.equal(res.body.entitlement.premium, false);
    assert.equal(JSON.stringify(res.body).includes('must-not-leak'), false);
  } finally {
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});

test('subscription safety invariants retain 12 API files and no delete-user capability', () => {
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter((name) => name.endsWith('.js'));
  assert.equal(apiFiles.length, 12);
  const handlers = apiFiles.map((name) => fs.readFileSync(path.join(ROOT, 'api', name), 'utf8')).join('\n');
  assert.doesNotMatch(handlers, /action\s*===\s*['"]delete|action\s*:\s*['"]delete/i);
});

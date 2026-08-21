'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const GOOD_HASH = 'a'.repeat(64);
const BAD_HASH = 'b'.repeat(64);

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function sameOriginHeaders(cookie) {
  return {
    host: 'app.test',
    origin: 'https://app.test',
    'content-type': 'application/json',
    cookie: cookie || ''
  };
}

function withEnv(fn) {
  const keys = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SESSION_SECRET',
    'TELEGRAM_VERIFY_CODE_SECRET',
    'SECURITY_GUARD_MODE'
  ];
  const previous = {};
  keys.forEach(function (key) { previous[key] = process.env[key]; });
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  process.env.SESSION_SECRET = 'session-secret-for-auth-recovery-tests';
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'telegram-recovery-secret-for-tests';
  process.env.SECURITY_GUARD_MODE = 'off';
  return Promise.resolve(fn()).finally(function () {
    keys.forEach(function (key) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  });
}

function createDb(options) {
  const opts = options || {};
  const captures = opts.captures || [];
  return {
    from(table) {
      const query = {
        table: table,
        operation: 'select',
        payload: null,
        filters: [],
        select() { return query; },
        eq(column, value) {
          query.filters.push([column, value]);
          if (query.operation === 'update') {
            captures.push({ table: table, operation: 'update', payload: query.payload, filters: query.filters.slice() });
          }
          return query;
        },
        maybeSingle() {
          if (table === 'app_users') {
            return Promise.resolve({ data: opts.user || null, error: opts.findError || null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(payload) {
          query.operation = 'update';
          query.payload = payload;
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
      };
      return query;
    },
    rpc(name, args) {
      captures.push({ operation: 'rpc', name: name, args: args });
      if (typeof opts.rpc === 'function') return Promise.resolve(opts.rpc(name, args));
      return Promise.resolve({ data: null, error: null });
    }
  };
}

function requireApiWithDb(db) {
  const originalLoad = Module._load;
  const apiPath = require.resolve('../api/reset-password');
  delete require.cache[apiPath];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') {
      return { createClient: function () { return db; } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require('../api/reset-password');
  } finally {
    Module._load = originalLoad;
    delete require.cache[apiPath];
  }
}

function cookieValue(res) {
  const value = res.headers['Set-Cookie'];
  return Array.isArray(value) ? value[0] : String(value || '');
}

test('recovery enrollment code is normalized and HMACed without storing raw code', async function () {
  await withEnv(function () {
    const recovery = require('../lib/auth-recovery');
    const code = recovery.generateEnrollmentCode();
    assert.match(code, /^AR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(recovery.normalizeEnrollmentCode(code.toLowerCase()), code.replace(/[^A-Z0-9]/g, '').slice(2));
    const hash = recovery.hashEnrollmentCode(code);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash.includes(code.replace(/-/g, '')), false);
  });
});

test('login succeeds without deviceId and issues a signed HttpOnly cookie', async function () {
  await withEnv(async function () {
    const captures = [];
    const db = createDb({
      captures: captures,
      user: {
        id: 'user-1',
        username: 'alice',
        password_hash: GOOD_HASH,
        is_blocked: false,
        is_approved: true,
        created_at: new Date().toISOString()
      }
    });
    const handler = requireApiWithDb(db);
    const res = makeRes();
    await handler({
      method: 'POST',
      headers: sameOriginHeaders(),
      body: { action: 'login', username: 'alice', passwordHash: GOOD_HASH, userAgent: 'test-agent' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.match(cookieValue(res), /^ac_sess=/);
    assert.match(cookieValue(res), /HttpOnly/);
    assert.equal(captures.some(function (entry) {
      return entry.operation === 'update' && entry.payload && Object.prototype.hasOwnProperty.call(entry.payload, 'devices');
    }), false, 'login must not append or require a device');
  });
});

test('wrong password stays generic and issues no cookie', async function () {
  await withEnv(async function () {
    const db = createDb({
      user: {
        id: 'user-1',
        username: 'alice',
        password_hash: GOOD_HASH,
        is_blocked: false,
        is_approved: true,
        created_at: new Date().toISOString()
      }
    });
    const handler = requireApiWithDb(db);
    const res = makeRes();
    await handler({
      method: 'POST',
      headers: sameOriginHeaders(),
      body: { action: 'login', username: 'alice', passwordHash: BAD_HASH }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, error: 'Username atau password salah.' });
    assert.equal(cookieValue(res), '');
  });
});

test('deleted account makes session-status fail closed and clear the cookie', async function () {
  await withEnv(async function () {
    const sessionPath = require.resolve('../lib/admin-session');
    delete require.cache[sessionPath];
    const session = require('../lib/admin-session');
    const token = session.createSessionToken({ userId: 'deleted-id', username: 'abigail', isAdmin: false });
    const db = createDb({ user: null });
    const handler = requireApiWithDb(db);
    const res = makeRes();
    await handler({
      method: 'POST',
      headers: sameOriginHeaders('ac_sess=' + token),
      body: { action: 'session-status' }
    }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.match(cookieValue(res), /ac_sess=;/);
    assert.match(cookieValue(res), /Max-Age=0/);
  });
});

test('approved Telegram callback stores only a reset-token HMAC and sends a one-time website link', async function () {
  await withEnv(async function () {
    const recovery = require('../lib/auth-recovery');
    const captures = [];
    const db = createDb({
      captures: captures,
      rpc: function (name, args) {
        if (name === 'claim_auth_recovery_webhook_update') {
          return { data: [{ claimed: true }], error: null };
        }
        if (name === 'approve_auth_password_reset_request_v2') {
          return { data: [{ result_code: 'ok', user_id: 'u1', username: 'budi', telegram_private_chat_id: 77 }], error: null };
        }
        if (name === 'complete_auth_recovery_webhook_update') {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
    });
    const edits = [];
    const bot = {
      answerCallbackQuery: async function () {},
      editMessageText: async function (chatId, messageId, text) { edits.push({ chatId: chatId, messageId: messageId, text: text }); },
      sendMessage: async function () {}
    };
    const result = await recovery.handleRecoveryUpdate({
      update_id: 101,
      callback_query: {
        id: 'cb1',
        data: recovery.CALLBACK_APPROVE_PREFIX + 'RequestRef_123',
        from: { id: 88 },
        message: { message_id: 9, chat: { id: 77, type: 'private' } }
      }
    }, { db: db, bot: bot, baseUrl: 'https://autocuan.web.id' });

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'reset_approved');
    const approval = captures.find(function (entry) { return entry.name === 'approve_auth_password_reset_request_v2'; });
    assert.ok(approval);
    assert.match(approval.args.p_reset_token_hash, /^[a-f0-9]{64}$/);
    assert.equal(edits.length, 1);
    assert.match(edits[0].text, /https:\/\/autocuan\.web\.id\/\?reset_token=/);
    assert.equal(edits[0].text.includes(approval.args.p_reset_token_hash), false);
  });
});

test('frontend and SQL contracts remove device authority and keep browser access service-role only', function () {
  const frontend = fs.readFileSync(path.join(ROOT, 'public', 'auth-v2.js'), 'utf8');
  // api/reset-password.js is now a thin routing gateway (shared Vercel Function
  // slot); the actual reset logic lives in lib/reset-password-legacy-handler.js.
  const endpoint = fs.readFileSync(path.join(ROOT, 'lib', 'reset-password-legacy-handler.js'), 'utf8');
  const migration = fs.readFileSync(path.join(ROOT, 'supabase', 'auth-telegram-recovery-v1-migration.sql'), 'utf8');
  // website-approved-access.js is now a thin bootstrapper; it loads auth-v2.js
  // (which owns session restore) rather than doing localStorage session writes itself.
  const loader = fs.readFileSync(path.join(ROOT, 'public', 'website-approved-access.js'), 'utf8');

  assert.match(frontend, /authRequest\('login'/);
  assert.doesNotMatch(frontend, /deviceId\s*:/);
  assert.match(frontend, /session-status/);
  assert.match(frontend, /clearLocalAuthState/);
  assert.match(endpoint, /createSessionToken/);
  assert.doesNotMatch(endpoint, /matchesLegacyBudiPassword|LEGACY_BUDI_PASSWORD_HASH/);
  assert.doesNotMatch(endpoint, /\.select\([^\n]*device_id/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.auth_recovery_requests FROM anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE .* TO service_role/);
  assert.match(loader, /auth-v2\.js/);
  assert.doesNotMatch(loader, /localStorage\.setItem\('autocuan_logged_in'/);
});

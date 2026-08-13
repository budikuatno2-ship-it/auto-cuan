'use strict';

// Focused tests for Issue B: registration must never insert a null device_id,
// and the client password-eye toggles must work. No DB/schema changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registerModule = require('../api/register-user');
const { normalizeDeviceId } = registerModule.__test;

// ---- normalizeDeviceId (server-side normalize + fallback) ----

test('normalizeDeviceId keeps a valid client device id', () => {
  assert.equal(normalizeDeviceId('dev_abc-123'), 'dev_abc-123');
});

test('normalizeDeviceId generates a non-empty fallback when omitted', () => {
  ['', '   ', null, undefined, 42, {}].forEach(function(input) {
    var id = normalizeDeviceId(input);
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0, 'fallback must be non-empty for input ' + JSON.stringify(input));
    assert.ok(id.indexOf('srv_') === 0, 'server fallback should be prefixed with srv_');
  });
});

test('normalizeDeviceId fallbacks are unique', () => {
  assert.notEqual(normalizeDeviceId(''), normalizeDeviceId(''));
});

test('normalizeDeviceId strips control characters and caps length', () => {
  assert.equal(normalizeDeviceId('  dev_x\u0000\u0007y  '), 'dev_xy');
  var long = 'd'.repeat(500);
  assert.equal(normalizeDeviceId(long).length, 128);
});

// ---- Registration handler integration (mocked supabase) ----

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

// Registration is atomic (v2): the handler calls the
// register_pending_user_with_telegram_challenge RPC instead of a raw insert.
function makeSupabaseMock(opts) {
  opts = opts || {};
  var captured = { inserted: null, rpcName: null, rpcArgs: null };
  var client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: opts.existingUser || null, error: opts.findError || null }); },
        insert(row) {
          captured.inserted = row;
          return { select() { return Promise.resolve({ data: [{ id: 1, username: row.username, created_at: 'now' }], error: opts.insertError || null }); } };
        }
      };
    },
    rpc(name, args) {
      captured.rpcName = name;
      captured.rpcArgs = args;
      if (opts.rpcError) return Promise.resolve({ data: null, error: opts.rpcError });
      return Promise.resolve({
        data: [{ id: 1, username: args.p_username, created_at: 'now', challenge_id: 'ch-1' }],
        error: null
      });
    }
  };
  return { client: client, captured: captured };
}

// Load a fresh copy of the register handler with @supabase/supabase-js mocked.
function loadHandlerWithMock(mock) {
  var supabasePath = require.resolve('@supabase/supabase-js');
  var registerPath = require.resolve('../api/register-user');
  var prevSupabase = require.cache[supabasePath];
  delete require.cache[registerPath];
  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: function() { return mock.client; } }
  };
  var handler = require('../api/register-user');
  // Restore for other tests.
  delete require.cache[registerPath];
  if (prevSupabase) require.cache[supabasePath] = prevSupabase; else delete require.cache[supabasePath];
  return handler;
}

function withEnv(fn) {
  var prevUrl = process.env.SUPABASE_URL;
  var prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var prevCode = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'register-test-code-secret';
  return Promise.resolve(fn()).finally(function() {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevCode === undefined) delete process.env.TELEGRAM_VERIFY_CODE_SECRET; else process.env.TELEGRAM_VERIFY_CODE_SECRET = prevCode;
  });
}

test('registration with a valid client device id succeeds and inserts that id', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({});
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'alice', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_client-1', userAgent: 'ua' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(mock.captured.rpcName, 'register_pending_user_with_telegram_challenge');
    assert.equal(mock.captured.rpcArgs.p_device_id, 'dev_client-1');
  });
});

test('registration without a device id receives a server-generated fallback', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({});
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'bob', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(mock.captured.rpcArgs.p_device_id, 'device_id must be present');
    assert.ok(mock.captured.rpcArgs.p_device_id.indexOf('srv_') === 0);
  });
});

test('the database insert never receives a null device_id', async () => {
  await withEnv(async function() {
    var inputs = [
      { username: 'c1', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_ok' },
      { username: 'c2', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4' },
      { username: 'c3', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: '' },
      { username: 'c4', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: null }
    ];
    for (var i = 0; i < inputs.length; i++) {
      var mock = makeSupabaseMock({});
      var handler = loadHandlerWithMock(mock);
      var res = makeRes();
      await handler({ method: 'POST', body: inputs[i] }, res);
      assert.notEqual(mock.captured.rpcArgs.p_device_id, null);
      assert.notEqual(mock.captured.rpcArgs.p_device_id, undefined);
      assert.ok(String(mock.captured.rpcArgs.p_device_id).length > 0);
    }
  });
});

test('existing username validation remains intact', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({ existingUser: { id: 9, username: 'taken' } });
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'taken', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_x' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /sudah digunakan/);
    assert.equal(mock.captured.rpcName, null, 'must not register when username exists');
  });
});

test('username length validation remains intact', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({});
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'a', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_x' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /minimal 2 karakter/);
  });
});

test('missing password is still rejected as incomplete data', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({});
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'nopass' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Data tidak lengkap/);
  });
});

test('raw database constraint text is never shown to the user', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({ rpcError: { code: '23502', message: 'null value in column "device_id" of relation "app_users" violates not-null constraint' } });
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'dave', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_x' } }, res);
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(res.body.error, /device_id|not-null|constraint|null value/i);
    assert.match(res.body.error, /Gagal membuat akun/);
  });
});

test('a duplicate username from the atomic RPC maps to the friendly 400', async () => {
  await withEnv(async function() {
    var mock = makeSupabaseMock({ rpcError: { code: '23505', message: 'duplicate key value violates unique constraint "app_users_username_key"' } });
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'dupe', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_x' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /sudah digunakan/);
    assert.doesNotMatch(res.body.error, /constraint|duplicate key/i);
  });
});

test('login-user remains compatible: register still stores device in devices array', async () => {
  // login-user.js matches against the `devices` array; registration must keep it populated.
  await withEnv(async function() {
    var mock = makeSupabaseMock({});
    var handler = loadHandlerWithMock(mock);
    var res = makeRes();
    await handler({ method: 'POST', body: { username: 'eve', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'dev_login' } }, res);
    assert.equal(mock.captured.rpcArgs.p_device_id, 'dev_login');
    var loginSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'login-user.js'), 'utf8');
    assert.ok(loginSrc.indexOf('currentDevices.includes(deviceId)') >= 0, 'login still matches devices array');
  });
});

// ---- Client password-eye toggle behavior ----

function extractFunction(src, signature) {
  var start = src.indexOf(signature);
  if (start < 0) return null;
  var i = src.indexOf('{', start);
  var depth = 0;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

test('password fields default to hidden with type="button" eye toggles and aria labels', () => {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  // Both password inputs default to type="password".
  assert.match(html, /id="regPassword"[^>]*type="password"|type="password"[^>]*id="regPassword"/);
  assert.match(html, /id="regPasswordConfirm"[^>]*type="password"|type="password"[^>]*id="regPasswordConfirm"/);
  // Two independent toggle buttons, both type="button" so they never submit.
  assert.match(html, /id="regPasswordToggle"[\s\S]*?type="button"|type="button"[\s\S]*?id="regPasswordToggle"/);
  assert.match(html, /id="regPasswordConfirmToggle"[\s\S]*?type="button"|type="button"[\s\S]*?id="regPasswordConfirmToggle"/);
  assert.ok(html.indexOf("togglePasswordVisibility('regPassword'") >= 0);
  assert.ok(html.indexOf("togglePasswordVisibility('regPasswordConfirm'") >= 0);
  assert.ok(html.indexOf('aria-label="Show password"') >= 0);
});

test('togglePasswordVisibility flips type and updates aria without submitting', () => {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  var fnSrc = extractFunction(html, 'function togglePasswordVisibility');
  assert.ok(fnSrc, 'togglePasswordVisibility must exist');

  var input = { type: 'password', value: 'Secret123', selectionStart: 2, selectionEnd: 2, focus() {}, setSelectionRange() {} };
  var btn = { _attrs: {}, innerHTML: '', setAttribute(k, v) { this._attrs[k] = v; } };
  var fakeDoc = { getElementById: function() { return input; } };
  var factory = new Function('document', fnSrc + '\nreturn togglePasswordVisibility;');
  var toggle = factory(fakeDoc);

  // Reveal
  toggle('regPassword', btn);
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'Secret123', 'value preserved');
  assert.equal(btn._attrs['aria-pressed'], 'true');
  assert.equal(btn._attrs['aria-label'], 'Hide password');

  // Hide again (independent, back to secure default)
  toggle('regPassword', btn);
  assert.equal(input.type, 'password');
  assert.equal(btn._attrs['aria-pressed'], 'false');
  assert.equal(btn._attrs['aria-label'], 'Show password');
});

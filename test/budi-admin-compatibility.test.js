'use strict';

// Compatibility audit for the EXISTING `budi` administrator account under the new
// signed-session model. Mocked/local only: @supabase/supabase-js is stubbed via
// Module._load and NO real record, endpoint, or database is touched. Every mock
// records any update/insert so we can prove the budi account is never mutated
// (no password reset, no device change, no approval/block change).
//
// No real password, hash, token, device id, or secret appears here — the values
// below are inert test placeholders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'unit-test-session-secret-value';
const LEGACY_DOT_HASH = crypto.createHash('sha256').update('._autocuan_salt_2024', 'utf8').digest('hex');

function loadFrontendHashPassword() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('async function hashPassword(password)');
  assert.ok(start >= 0, 'frontend hashPassword function must exist');
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) {
      const source = html.slice(start, i + 1);
      return vm.runInNewContext('(' + source + ')', {
        TextEncoder: TextEncoder,
        crypto: crypto.webcrypto,
        Uint8Array: Uint8Array
      });
    }
  }
  throw new Error('frontend hashPassword function has unbalanced braces');
}

// Inert placeholder budi record (NOT real data).
const BUDI_HASH = 'PLACEHOLDER_BUDI_HASH';
function freshBudi(devices) {
  const registeredDevices = devices || ['budi_dev_1', 'budi_dev_2'];
  return {
    id: 'budi-immutable-id',
    username: 'budi',
    password_hash: BUDI_HASH,
    device_id: registeredDevices[0] || 'budi_primary_device',
    devices: registeredDevices,
    is_blocked: false,
    is_approved: true
  };
}

function loadSession() {
  process.env.SESSION_SECRET = SECRET;
  const abs = require.resolve('../lib/admin-session');
  delete require.cache[abs];
  return require('../lib/admin-session');
}
const S = loadSession();

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
  const keys = ['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NODE_ENV', 'VERCEL_ENV'];
  const prev = {};
  keys.forEach(k => { prev[k] = process.env[k]; });
  process.env.SESSION_SECRET = SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  Object.keys(extra || {}).forEach(k => { if (extra[k] === undefined) delete process.env[k]; else process.env[k] = extra[k]; });
  return Promise.resolve(fn()).finally(() => {
    keys.forEach(k => { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; });
  });
}

// Supabase mock that returns a per-table row for maybeSingle() and records every
// mutation (update/insert) into `sink` so tests can assert immutability.
function trackingSupabase(rowByTable, sink) {
  return function () {
    return {
      from(table) {
        const q = {
          _t: table,
          select() { return q; },
          eq() { return q; },
          order() { return q; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: Object.prototype.hasOwnProperty.call(rowByTable, table) ? rowByTable[table] : null, error: null }); },
          update(payload) { sink.push({ table: table, op: 'update', payload: payload }); return q; },
          insert(payload) { sink.push({ table: table, op: 'insert', payload: payload }); return { select() { return Promise.resolve({ data: [{ id: 'x' }], error: null }); } }; }
        };
        return q;
      }
    };
  };
}

const SENSITIVE_ACCOUNT_FIELDS = ['password_hash', 'devices', 'is_blocked', 'is_approved'];
function assertNoBudiAccountMutation(sink) {
  sink.filter(m => m.table === 'app_users').forEach(function (m) {
    SENSITIVE_ACCOUNT_FIELDS.forEach(function (f) {
      assert.ok(!(m.payload && Object.prototype.hasOwnProperty.call(m.payload, f)),
        'budi account field "' + f + '" must never be written (found in ' + m.op + ')');
    });
  });
}

function sameOrigin(cookie) {
  return { host: 'app.test', origin: 'https://app.test', 'content-type': 'application/json', cookie: cookie || '' };
}
function setCookie(res) {
  const sc = res.headers['Set-Cookie'];
  return typeof sc === 'string' ? sc : (Array.isArray(sc) ? sc[0] : '');
}
function forwardCookie(res) {
  const m = /(ac_sess=[^;]*)/.exec(setCookie(res) || '');
  return m ? m[1] : '';
}

// Perform a real budi login through the (mocked) server and return { res, sink }.
async function loginBudi(devices, deviceId) {
  const sink = [];
  const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: freshBudi(devices) }, sink));
  const res = makeRes();
  await handler({ method: 'POST', headers: sameOrigin(), body: { username: 'budi', passwordHash: BUDI_HASH, deviceId: deviceId || 'budi_dev_1', userAgent: 'ua' } }, res);
  return { res, sink };
}

async function loginLegacyBudi(options) {
  const opts = options || {};
  const sink = [];
  const user = Object.prototype.hasOwnProperty.call(opts, 'user') ? opts.user : freshBudi();
  const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: user }, sink));
  const res = makeRes();
  const body = Object.assign({
    username: 'budi',
    passwordHash: LEGACY_DOT_HASH,
    deviceId: 'budi_dev_1',
    userAgent: 'legacy-test-ua'
  }, opts.body || {});
  await handler({ method: 'POST', headers: sameOrigin(), body: body }, res);
  return { res, sink, user };
}

function assertGenericRejection(result) {
  assert.equal(result.res.statusCode, 400);
  assert.deepEqual(result.res.body, { success: false, error: 'Username atau password salah.' });
  assert.equal(setCookie(result.res), '', 'failed compatibility login must issue no cookie');
  assert.equal(result.sink.length, 0, 'failed compatibility login must not mutate the database');
}

// ============================================================

// Focused legacy compatibility matrix required by the production regression.
test('legacy budi + dot hash succeeds only on an already-registered devices[] entry', async () => {
  await withEnv({}, async () => {
    const result = await loginLegacyBudi({
      user: Object.assign(freshBudi(['primary-device', 'array-device']), { device_id: 'primary-device' }),
      body: { deviceId: 'array-device' }
    });
    assert.equal(result.res.statusCode, 200);
    assert.deepEqual(result.res.body, {
      success: true,
      username: 'budi',
      userId: 'budi-immutable-id',
      isAdmin: true
    });
    assert.equal(result.sink.length, 0, 'compatibility success must perform no database write');
  });
});

test('legacy hash contract executes the production frontend algorithm and normalizes budi username', async () => {
  await withEnv({}, async () => {
    const frontendHashPassword = loadFrontendHashPassword();
    const frontendDotHash = await frontendHashPassword('.');
    assert.equal(frontendDotHash, LEGACY_DOT_HASH, 'server compatibility hash must match the production client algorithm');
    const result = await loginLegacyBudi({ body: { username: '  BuDi  ', passwordHash: frontendDotHash } });
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.res.body.username, 'budi');
    assert.equal(result.sink.length, 0);
  });
});

test('database-password match takes precedence even when the stored hash equals the legacy dot hash', async () => {
  await withEnv({}, async () => {
    const sink = [];
    const user = Object.assign(freshBudi(['registered-device']), { password_hash: LEGACY_DOT_HASH });
    const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: user }, sink));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOrigin(), body: {
      username: 'budi', passwordHash: LEGACY_DOT_HASH, deviceId: 'normal-path-new-device', userAgent: 'ua'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(sink.length, 1, 'normal login path must retain its existing device update behavior');
    assert.deepEqual(sink[0].payload.devices, ['registered-device', 'normal-path-new-device']);
  });
});

test('legacy compatibility fails generically when a signed cookie cannot be attached', async () => {
  await withEnv({}, async () => {
    const sink = [];
    const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: freshBudi() }, sink));
    const res = makeRes();
    res.setHeader = function () { throw new Error('simulated cookie header failure'); };
    await handler({ method: 'POST', headers: sameOrigin(), body: {
      username: 'budi', passwordHash: LEGACY_DOT_HASH, deviceId: 'budi_dev_1'
    } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, error: 'Username atau password salah.' });
    assert.deepEqual(res.headers, {});
    assert.equal(sink.length, 0);
  });
});

test('legacy budi compatibility accepts the existing primary device_id without appending it', async () => {
  await withEnv({}, async () => {
    const result = await loginLegacyBudi({
      user: Object.assign(freshBudi([]), { device_id: 'primary-only', devices: [] }),
      body: { deviceId: 'primary-only' }
    });
    assert.equal(result.res.body.success, true);
    assert.equal(result.sink.length, 0, 'primary device compatibility must remain read-only');
  });
});

test('legacy compatibility sets the signed HttpOnly admin cookie with adm=true', async () => {
  await withEnv({}, async () => {
    const result = await loginLegacyBudi();
    const cookie = setCookie(result.res);
    assert.match(cookie, /^ac_sess=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const token = /^ac_sess=([^;]+)/.exec(cookie)[1];
    const verified = S.verifySessionToken(token);
    assert.equal(verified.valid, true);
    assert.equal(verified.payload.adm, true);
    assert.equal(verified.payload.un, 'budi');
    assert.equal(verified.payload.uid, 'budi-immutable-id');
    assert.equal(token.includes(LEGACY_DOT_HASH), false, 'legacy hash must not enter the token');
    assert.equal(token.includes('budi_dev_1'), false, 'raw device id must not enter the token');
  });
});

test('legacy compatibility never updates a budi field or inserts/appends a device', async () => {
  await withEnv({}, async () => {
    const user = freshBudi();
    const before = JSON.stringify(user);
    const result = await loginLegacyBudi({ user: user });
    assert.equal(result.res.body.success, true);
    assert.equal(result.sink.length, 0, 'no update or insert of any kind is allowed');
    assert.equal(JSON.stringify(user), before, 'mocked budi row must remain byte-for-byte unchanged');
  });
});

test('legacy budi rejects unknown and missing devices generically without mutation', async () => {
  await withEnv({}, async () => {
    assertGenericRejection(await loginLegacyBudi({ body: { deviceId: 'never-registered' } }));
    assertGenericRejection(await loginLegacyBudi({ body: { deviceId: '' } }));
  });
});

test('legacy budi fails closed without SESSION_SECRET', async () => {
  await withEnv({ SESSION_SECRET: undefined }, async () => {
    assertGenericRejection(await loginLegacyBudi());
  });
});

test('legacy budi requires an existing approved and unblocked database account', async () => {
  await withEnv({}, async () => {
    assertGenericRejection(await loginLegacyBudi({ user: null }));
    assertGenericRejection(await loginLegacyBudi({ user: Object.assign(freshBudi(), { is_blocked: true }) }));
    assertGenericRejection(await loginLegacyBudi({ user: Object.assign(freshBudi(), { is_approved: false }) }));
  });
});

test('wrong budi password, normal-user dot hash, and client admin flags cannot enter compatibility', async () => {
  await withEnv({}, async () => {
    assertGenericRejection(await loginLegacyBudi({ body: { passwordHash: 'not-the-legacy-hash' } }));

    const alice = {
      id: 'alice-id', username: 'alice', password_hash: 'alice-db-hash',
      device_id: 'alice-device', devices: ['alice-device'], is_blocked: false, is_approved: true
    };
    assertGenericRejection(await loginLegacyBudi({
      user: alice,
      body: { username: 'alice', deviceId: 'alice-device', is_admin: true, isAdmin: true, adminName: 'budi' }
    }));

    assertGenericRejection(await loginLegacyBudi({
      body: { deviceId: 'never-registered', is_admin: true, isAdmin: true, adminName: 'budi' }
    }));
  });
});

// ============================================================

// 1 + 2. Existing budi credentials still authenticate; password validation unchanged.
test('1&2: existing budi credentials authenticate; wrong password rejected with no mutation', async () => {
  await withEnv({}, async () => {
    const ok = await loginBudi();
    assert.equal(ok.res.body.success, true);
    assert.equal(ok.res.body.isAdmin, true);
    assert.equal(ok.res.body.userId, 'budi-immutable-id');
    assertNoBudiAccountMutation(ok.sink);

    // Wrong password => generic rejection, no session, no account write at all.
    const sink = [];
    const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: freshBudi() }, sink));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOrigin(), body: { username: 'budi', passwordHash: 'WRONG', deviceId: 'budi_dev_1' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Username atau password salah.');
    assert.ok(!setCookie(res), 'no session cookie on failed auth');
    assert.equal(sink.length, 0, 'no DB write on failed auth');
  });
});

// 3. Existing device validation unchanged.
test('3: budi device binding unchanged (known device ok; device-limit still enforced)', async () => {
  await withEnv({}, async () => {
    // Known device -> success, and devices array is NOT modified.
    const known = await loginBudi(['budi_dev_1', 'budi_dev_2'], 'budi_dev_1');
    assert.equal(known.res.body.success, true);
    assertNoBudiAccountMutation(known.sink);

    // New device when already at MAX_DEVICES (3) -> rejected, no mutation.
    const sink = [];
    const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: freshBudi(['d1', 'd2', 'd3']) }, sink));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOrigin(), body: { username: 'budi', passwordHash: BUDI_HASH, deviceId: 'd4_new', userAgent: 'ua' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /perangkat/i);
    assertNoBudiAccountMutation(sink);
  });
});

// 4. Successful budi login creates an admin session with adm=true.
test('4: budi login sets an HttpOnly admin session cookie with adm=true', async () => {
  await withEnv({}, async () => {
    const { res } = await loginBudi();
    const cookie = setCookie(res);
    assert.match(cookie, /ac_sess=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const token = /ac_sess=([^;]*)/.exec(cookie)[1];
    const v = S.verifySessionToken(token);
    assert.equal(v.valid, true);
    assert.equal(v.payload.adm, true);
    assert.equal(v.payload.un, 'budi');
    assert.equal(v.payload.uid, 'budi-immutable-id');
    // token embeds neither the password hash nor a raw device id
    assert.equal(token.indexOf(BUDI_HASH), -1);
    assert.equal(token.indexOf('budi_dev_1'), -1);
  });
});

// 5, 6, 7. End-to-end: the budi session opens the protected admin endpoints.
test('5,6,7: budi session can list users, read logs, and save maintenance settings', async () => {
  await withEnv({}, async () => {
    const login = await loginBudi();
    const cookie = forwardCookie(login.res);
    assert.ok(cookie, 'budi login must yield a session cookie');

    // 5. list users
    let sink = [];
    let h = requireApiWithSupabaseStub('../api/admin-users', trackingSupabase({}, sink));
    let res = makeRes();
    await h({ method: 'POST', headers: sameOrigin(cookie), body: { action: 'list' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assertNoBudiAccountMutation(sink);

    // 6. read admin logs
    sink = [];
    h = requireApiWithSupabaseStub('../api/admin-logs', trackingSupabase({}, sink));
    res = makeRes();
    await h({ method: 'POST', headers: sameOrigin(cookie), body: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // 7. save maintenance settings (writes app_settings, never app_users)
    sink = [];
    h = requireApiWithSupabaseStub('../api/maintenance-settings', trackingSupabase({ app_settings: null }, sink));
    res = makeRes();
    await h({ method: 'POST', headers: sameOrigin(cookie), body: { action: 'save', config: { maintenanceMode: false, message: 'x' } } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assertNoBudiAccountMutation(sink); // only app_settings touched, never budi's app_users row
    assert.ok(sink.every(m => m.table === 'app_settings'));
  });
});

// 8. Authenticated non-budi users receive 403.
test('8: an authenticated normal-user session is denied admin (403)', async () => {
  await withEnv({}, async () => {
    const token = S.createSessionToken({ userId: 'u9', username: 'alice', isAdmin: false, deviceId: 'd' });
    const h = requireApiWithSupabaseStub('../api/admin-users', trackingSupabase({}, []));
    const res = makeRes();
    await h({ method: 'POST', headers: sameOrigin('ac_sess=' + token), body: { action: 'list' } }, res);
    assert.equal(res.statusCode, 403);
  });
});

// 9. Unauthenticated adminName:"budi" requests receive 401.
test('9: forged adminName:"budi" without a session receives 401', async () => {
  await withEnv({}, async () => {
    const sink = [];
    const h = requireApiWithSupabaseStub('../api/admin-users', trackingSupabase({}, sink));
    const res = makeRes();
    await h({ method: 'POST', headers: sameOrigin(''), body: { adminName: 'budi', is_admin: true, action: 'list' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(sink.length, 0, 'must not reach any DB operation');
  });
});

// 10. Failed session creation (missing SESSION_SECRET) does not modify the budi account.
test('10: missing SESSION_SECRET does not damage the budi account (fail-closed, no cookie)', async () => {
  await withEnv({ SESSION_SECRET: undefined }, async () => {
    const budi = freshBudi();
    const before = JSON.stringify(budi);
    const sink = [];
    const handler = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: budi }, sink));
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOrigin(), body: { username: 'budi', passwordHash: BUDI_HASH, deviceId: 'budi_dev_1', userAgent: 'ua' } }, res);
    // Login still succeeds at the account level, but NO session cookie is issued.
    assert.equal(res.body.success, true);
    const cookie = setCookie(res);
    assert.ok(!cookie || cookie.indexOf('ac_sess=') === -1 || /ac_sess=;/.test(cookie), 'no signed session token issued without a secret');
    // The budi record itself is untouched (object identity of sensitive fields).
    assert.equal(JSON.stringify(budi), before);
    assertNoBudiAccountMutation(sink);
    // And with no session, the admin endpoint fails closed (401), not an account change.
    const h = requireApiWithSupabaseStub('../api/admin-users', trackingSupabase({}, []));
    const r2 = makeRes();
    await h({ method: 'POST', headers: sameOrigin(forwardCookie(res)), body: { action: 'list' } }, r2);
    assert.equal(r2.statusCode, 401);
  });
});

// 11. Logout clears only the session cookie and does not modify the budi account.
test('11: logout clears the cookie and touches no database', async () => {
  await withEnv({}, async () => {
    // createClient throws if invoked -> proves logout never reaches the DB.
    const handler = requireApiWithSupabaseStub('../api/login-user', function () { throw new Error('DB must not be touched on logout'); });
    const res = makeRes();
    await handler({ method: 'POST', headers: sameOrigin(), body: { action: 'logout' } }, res);
    assert.equal(res.body.success, true);
    const cookie = setCookie(res);
    assert.match(cookie, /ac_sess=;/);
    assert.match(cookie, /Max-Age=0/);
  });
});

// 12. No mutation occurs across the compatibility flows (aggregate guard).
test('12: no password/device/approval/block mutation of budi across all flows', async () => {
  await withEnv({}, async () => {
    const aggregate = [];
    // successful login
    let sink = [];
    let h = requireApiWithSupabaseStub('../api/login-user', trackingSupabase({ app_users: freshBudi() }, sink));
    let res = makeRes();
    await h({ method: 'POST', headers: sameOrigin(), body: { username: 'budi', passwordHash: BUDI_HASH, deviceId: 'budi_dev_1' } }, res);
    aggregate.push.apply(aggregate, sink);
    // list via session
    const cookie = forwardCookie(res);
    sink = [];
    h = requireApiWithSupabaseStub('../api/admin-users', trackingSupabase({}, sink));
    res = makeRes();
    await h({ method: 'POST', headers: sameOrigin(cookie), body: { action: 'list' } }, res);
    aggregate.push.apply(aggregate, sink);
    assertNoBudiAccountMutation(aggregate);
    // Confirm admin-users has hard guards that refuse to mutate budi even if asked.
    const src = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
    ['block', 'reset password', 'reset', 'reject'].forEach(() => {});
    assert.match(src, /Tidak dapat memblokir admin/);
    assert.match(src, /Tidak dapat mereset password admin/);
    assert.match(src, /Tidak dapat reset perangkat admin/);
    assert.match(src, /Tidak dapat reject admin/);
  });
});

// The legacy local-only budi shortcut has been removed: budi now authenticates
// through the real server login, and admin is derived from the server response.
test('budi login is routed through the real server (no local-only admin shortcut)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // The local-only "budi + ." admin shortcut must no longer exist.
  assert.doesNotMatch(html, /if \(password === '\.'\)/);
  // No code path unconditionally grants admin in localStorage anymore.
  assert.doesNotMatch(html, /autocuan_is_admin', 'true'\)/);
  // Admin is derived from the server response, gated on the server-identified username.
  assert.match(html, /data\.isAdmin === true && String\(data\.username[^)]*\)\.toLowerCase\(\) === 'budi'/);
  // budi is exempt from the bad-username block (parity with prior behavior).
  assert.match(html, /usernameLower !== 'review' && usernameLower !== 'budi' && isBadUsername/);
});

// API endpoint count remains exactly 12.
test('api endpoint count remains exactly 12', () => {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 12, 'found: ' + files.join(', '));
});

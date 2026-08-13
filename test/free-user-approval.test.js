'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const SESSION_SECRET = 'free-user-approval-local-test-secret';
const approval = require('../lib/free-user-approval');
const notifier = require('../lib/telegram-notifier');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function loadApiWithSupabase(relPath, createClient) {
  const absolute = require.resolve(relPath);
  // api/admin-users.js delegates to lib/admin-users-handler.js; both must be
  // reloaded so the injected supabase stub reaches the legacy actions too.
  const handlerAbsolute = require.resolve('../lib/admin-users-handler');
  const originalLoad = Module._load;
  delete require.cache[absolute];
  delete require.cache[handlerAbsolute];
  Module._load = function(request) {
    if (request === '@supabase/supabase-js') return { createClient: createClient };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(relPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[absolute];
    delete require.cache[handlerAbsolute];
  }
}

async function withEnv(values, fn) {
  const keys = [
    'SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'TELEGRAM_FREE_CHANNEL_URL', 'TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED',
    'TELEGRAM_APPROVAL_CHAT_ID', 'TELEGRAM_ENABLED', 'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID'
  ];
  keys.push('TELEGRAM_VERIFY_CODE_SECRET');
  const previous = {};
  keys.forEach(function(key) { previous[key] = process.env[key]; delete process.env[key]; });
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key';
  // v2: registration and pending-login issue a one-time Telegram code (HMAC keyed
  // by this secret). Provide a fixed test secret so those endpoints are not in
  // their fail-closed state during these tests.
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'free-user-approval-verify-secret';
  Object.keys(values || {}).forEach(function(key) {
    if (values[key] !== undefined) process.env[key] = String(values[key]);
  });
  try {
    return await fn();
  } finally {
    keys.forEach(function(key) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let i = opening; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

// Approval-code and masking helpers are pure and use no database, network, or secrets.
test('approval code is deterministic for the same immutable user', function() {
  const user = { id: 'immutable-user-17', username: 'alice', created_at: '2026-07-20T00:00:00Z' };
  assert.equal(approval.generateApprovalCode(user), approval.generateApprovalCode(Object.assign({}, user)));
  assert.equal(approval.generateApprovalCode(user), 'AC-685B42', 'v1 code contract must remain stable');
  assert.match(approval.generateApprovalCode(user), /^AC-[A-F0-9]{6}$/);
});

test('different immutable users normally receive different approval codes', function() {
  assert.notEqual(
    approval.generateApprovalCode({ id: 'user-a' }),
    approval.generateApprovalCode({ id: 'user-b' })
  );
});

test('approval code excludes password, hash, token, and device material', function() {
  const base = { id: 'immutable-user-88', username: 'safeuser', created_at: '2026-07-20T00:00:00Z' };
  const sensitive = Object.assign({}, base, {
    password: 'RawPassword123', password_hash: 'hash-secret-987',
    token: 'token-secret-654', device_id: 'device-secret-321'
  });
  const code = approval.generateApprovalCode(sensitive);
  assert.equal(code, approval.generateApprovalCode(base), 'sensitive fields must not influence the code');
  ['RawPassword123', 'hash-secret-987', 'token-secret-654', 'device-secret-321'].forEach(function(value) {
    assert.equal(code.includes(value), false);
  });
});

test('approval-code fallback is stable for normalized username and created timestamp', function() {
  assert.equal(
    approval.generateApprovalCode({ username: ' Alice ', created_at: '2026-07-20T00:00:00Z' }),
    approval.generateApprovalCode({ username: 'alice', created_at: '2026-07-20T00:00:00Z' })
  );
});

test('username masking handles short and long usernames without publishing the full value', function() {
  assert.equal(approval.maskUsername('budi'), 'bu*i');
  assert.equal(approval.maskUsername('maxphillips'), 'ma********s');
  assert.equal(approval.maskUsername('andi123'), 'an****3');
  assert.equal(approval.maskUsername('a'), '*');
  assert.equal(approval.maskUsername('ab'), 'a*');
  assert.equal(approval.maskUsername('abc'), 'a*c');
  assert.equal(approval.maskUsername('a\nbc'), 'a*c');
  assert.equal(approval.maskUsername('ab\u202Ecd'), 'ab*d');
  assert.doesNotMatch(approval.maskUsername('a\nbc'), /[\r\n\u202E]/);
  ['budi', 'maxphillips', 'andi123', 'a', 'ab', 'abc'].forEach(function(username) {
    assert.notEqual(approval.maskUsername(username), username);
  });
});

function registrationSupabase(row) {
  const captured = { inserted: null, rpc: [] };
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(inserted) {
          captured.inserted = inserted;
          return {
            select() {
              return Promise.resolve({
                data: [row || { id: 'registered-id-1', username: inserted.username, created_at: '2026-07-20T00:00:00Z' }],
                error: null
              });
            }
          };
        }
      };
    },
    // v2: registration uses an atomic service-role RPC (pending user + first
    // one-time challenge). Only the HMAC is passed to SQL.
    rpc(name, args) {
      captured.rpc.push({ name: name, args: args });
      if (name === 'register_pending_user_with_telegram_challenge') {
        const r = row || { id: 'registered-id-1', username: args.p_username, created_at: '2026-07-20T00:00:00Z' };
        return Promise.resolve({ data: [{ id: r.id, username: r.username, created_at: r.created_at, challenge_id: 'ch-1' }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
  };
  return { client: client, captured: captured };
}

async function registerWith(channelUrl) {
  return withEnv({ TELEGRAM_FREE_CHANNEL_URL: channelUrl }, async function() {
    const mock = registrationSupabase();
    const handler = loadApiWithSupabase('../api/register-user', function() { return mock.client; });
    const res = makeRes();
    await handler({
      method: 'POST',
      body: { username: 'newuser', passwordHash: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', deviceId: 'local-device', userAgent: 'local-test' }
    }, res);
    return { res: res, captured: mock.captured };
  });
}

test('successful registration returns pending status, deterministic code, and a one-time verification code (no channel URL)', async function() {
  const result = await registerWith('https://t.me/auto_cuan_free'); // any channel env is ignored by v2
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.success, true);
  assert.equal(result.res.body.pending, true);
  assert.equal(result.res.body.approval_status, 'pending');
  assert.equal(result.res.body.approval_code, approval.generateApprovalCode({ id: 'registered-id-1' }));
  // v2: a separate one-time verification code + the fixed bot URL; never a channel link.
  assert.match(result.res.body.telegram_verification_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(result.res.body.telegram_bot_url, 'https://t.me/AutoCuanVerificationBot');
  assert.equal(Object.prototype.hasOwnProperty.call(result.res.body, 'telegram_channel_url'), false);
  // Only the HMAC reaches SQL — never the raw/display code.
  const rpcCall = result.captured.rpc.find(function(c) { return c.name === 'register_pending_user_with_telegram_challenge'; });
  assert.match(rpcCall.args.p_code_hash, /^[0-9a-f]{64}$/);
});

test('registration response never returns password hash, internal user id, device id, or session data', async function() {
  const result = await registerWith('https://t.me/auto_cuan_free');
  const serialized = JSON.stringify(result.res.body);
  assert.equal(serialized.includes('local-hash'), false);
  assert.equal(serialized.includes('registered-id-1'), false);
  assert.equal(serialized.includes('local-device'), false);
  ['password', 'password_hash', 'id', 'device_id', 'session', 'token'].forEach(function(field) {
    assert.equal(Object.prototype.hasOwnProperty.call(result.res.body, field), false, field + ' must not be returned');
  });
});

test('registration succeeds and never exposes a channel URL (v2)', async function() {
  let result = await registerWith(undefined);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.approval_status, 'pending');
  assert.ok(result.res.body.telegram_verification_code, 'one-time code present');
  assert.equal(Object.prototype.hasOwnProperty.call(result.res.body, 'telegram_channel_url'), false);

  result = await registerWith('https://example.test/not-telegram');
  assert.equal(result.res.statusCode, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(result.res.body, 'telegram_channel_url'), false);
});

test('registration UI contains the pending approval panel with recognition + one-time verification codes', function() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.match(html, /id="registerApprovalPanel"/);
  assert.match(html, /Pendaftaran berhasil/);
  assert.match(html, /Akun Anda sedang menunggu persetujuan admin\./);
  assert.match(html, /Kode pengguna:/);
  assert.match(html, /id="registerVerificationCode"/);
  assert.match(html, /id="openVerificationBot"/);
  assert.match(html, />Salin Kode Verifikasi</);
  // v2: the private channel link element must no longer exist on the website.
  assert.doesNotMatch(html, /joinFreeTelegramChannel/);
  assert.ok(extractFunction(html, 'function displayApprovalPanel').includes("textContent = code"));
  const doRegister = extractFunction(html, 'async function doRegister');
  assert.doesNotMatch(doRegister, /setTimeout|openAuthChoiceModal|doLogin/);
  const clearPasswords = doRegister.indexOf("if (data.success) { document.getElementById('regPassword').value = '';");
  const validateApprovalPayload = doRegister.indexOf("if (data.success && data.approval_status === 'pending'");
  assert.ok(clearPasswords >= 0 && clearPasswords < validateApprovalPayload, 'every successful response clears password fields');
});

function makeElement(initialClasses) {
  const classes = new Set(initialClasses || []);
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    value: 'Secret123', textContent: '', href: '',
    removeAttribute(name) { if (name === 'href') this.href = ''; }
  };
}

function makeApprovalUi(html) {
  const elements = {
    registerApprovalCode: makeElement(),
    registerVerificationCode: makeElement(),
    registerVerificationExpiry: makeElement(),
    regPassword: makeElement(),
    regPasswordConfirm: makeElement(),
    registerFormFields: makeElement(),
    registerApprovalPanel: makeElement(['hidden']),
    openVerificationBot: makeElement(['hidden'])
  };
  const source = extractFunction(html, 'function validVerificationBotUrl') + '\n' +
    extractFunction(html, 'function formatVerificationExpiry') + '\n' +
    extractFunction(html, 'function displayApprovalPanel') + '\n' +
    extractFunction(html, 'function showRegistrationApproval') + '\nreturn showRegistrationApproval;';
  const show = new Function('document', 'URL', source)(
    { getElementById(id) { return elements[id]; } },
    URL
  );
  return { elements: elements, show: show };
}

test('registration UI shows the verification-bot button only for a valid bot URL and shows the one-time code', function() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  let ui = makeApprovalUi(html);
  ui.show({ approval_code: 'AC-7F3A2C', telegram_verification_code: 'ABCD-2345', telegram_verification_expires_at: new Date(Date.now() + 900000).toISOString(), telegram_bot_url: 'https://t.me/AutoCuanVerificationBot' });
  assert.equal(ui.elements.registerApprovalCode.textContent, 'AC-7F3A2C');
  assert.equal(ui.elements.registerVerificationCode.textContent, 'ABCD-2345');
  assert.equal(ui.elements.registerApprovalPanel.classList.contains('hidden'), false);
  assert.equal(ui.elements.openVerificationBot.classList.contains('hidden'), false);
  assert.equal(ui.elements.openVerificationBot.href, 'https://t.me/AutoCuanVerificationBot');
  assert.equal(ui.elements.regPassword.value, '');
  assert.equal(ui.elements.regPasswordConfirm.value, '');

  // A non-Telegram / unsafe / missing bot URL hides the button (and no channel link exists at all).
  ['https://example.test/channel', 'javascript:alert(1)', '', null].forEach(function(url) {
    ui = makeApprovalUi(html);
    ui.show({ approval_code: 'AC-7F3A2C', telegram_verification_code: 'ABCD-2345', telegram_bot_url: url });
    assert.equal(ui.elements.openVerificationBot.classList.contains('hidden'), true);
    assert.equal(ui.elements.openVerificationBot.href, '');
  });
});

test('password confirmation remains required before password hashing and registration request', function() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const register = extractFunction(html, 'async function doRegister');
  const mismatch = register.indexOf('password !== passwordConfirm');
  const hash = register.indexOf('hashPassword(password)');
  const request = register.indexOf("fetch('/api/register-user'");
  assert.ok(mismatch >= 0 && mismatch < hash && hash < request);
  assert.match(register, /Konfirmasi password tidak sama\./);
});

function createApprovalDatabase(row) {
  const state = {
    // v2 approval gate: an approvable account is Telegram-verified with a bound
    // identity and a known private chat. These fields let the eligibility check
    // pass so the existing conditional-transition + notification assertions hold.
    row: Object.assign({
      id: 'approval-user-id', username: 'maxphillips',
      created_at: '2026-07-20T00:00:00Z', is_approved: false, is_blocked: false,
      telegram_verified_at: '2026-07-20T00:00:00Z', telegram_user_id: 4242, telegram_private_chat_id: 5252
    }, row || {}),
    updates: [],
    approvalFilters: []
  };

  const client = {
    from(table) {
      const query = {
        _update: null,
        _filters: [],
        update(values) { this._update = values; state.updates.push({ table: table, values: values }); return this; },
        select() { return this; },
        eq(column, value) { this._filters.push([column, value]); return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        maybeSingle() {
          if (this._update && this._update.is_approved === true) {
            state.approvalFilters.push(this._filters.slice());
            const usernameMatch = this._filters.some(function(filter) { return filter[0] === 'username' && filter[1] === state.row.username; });
            const pendingPredicate = this._filters.some(function(filter) { return filter[0] === 'is_approved' && filter[1] === false; });
            if (usernameMatch && pendingPredicate && state.row.is_approved === false) {
              state.row.is_approved = true;
              return Promise.resolve({
                data: { id: state.row.id, username: state.row.username, created_at: state.row.created_at },
                error: null
              });
            }
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: state.row, error: null });
        },
        then(resolve, reject) {
          if (this._update) Object.assign(state.row, this._update);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
      };
      return query;
    }
  };
  return { state: state, createClient: function() { return client; } };
}

function adminRequest(body) {
  const sessionPath = require.resolve('../lib/admin-session');
  delete require.cache[sessionPath];
  const sessions = require('../lib/admin-session');
  const token = sessions.createSessionToken({ userId: 'admin-id', username: 'budi', isAdmin: true, deviceId: 'admin-device' });
  return {
    method: 'POST',
    headers: { host: 'app.test', origin: 'https://app.test', cookie: 'ac_sess=' + token },
    body: body
  };
}

async function runAdmin(database, body, sendImpl, env) {
  return withEnv(env || {}, async function() {
    const originalSend = notifier.sendTelegramMessage;
    const calls = [];
    notifier.sendTelegramMessage = async function(message, options) {
      calls.push({ message: message, options: options });
      return sendImpl ? sendImpl(message, options) : { sent: true, skipped: false };
    };
    try {
      const handler = loadApiWithSupabase('../api/admin-users', database.createClient);
      const res = makeRes();
      await handler(adminRequest(body), res);
      return { res: res, calls: calls };
    } finally {
      notifier.sendTelegramMessage = originalSend;
    }
  });
}

test('pending to approved uses a conditional transition and sends exactly one message', async function() {
  const db = createApprovalDatabase();
  const result = await runAdmin(db, { action: 'approve', username: 'MAXPHILLIPS' }, null, {
    TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
    TELEGRAM_APPROVAL_CHAT_ID: '-1001approval'
  });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.approval_transitioned, true);
  assert.deepEqual(result.res.body.approval_notification, { status: 'sent' });
  assert.equal(db.state.row.is_approved, true);
  assert.equal(result.calls.length, 1);
  assert.ok(db.state.approvalFilters[0].some(function(filter) { return filter[0] === 'is_approved' && filter[1] === false; }));
});

test('repeated approval sends no duplicate message', async function() {
  const db = createApprovalDatabase();
  const first = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, { TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1', TELEGRAM_APPROVAL_CHAT_ID: '-1001approval' });
  const second = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, { TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1', TELEGRAM_APPROVAL_CHAT_ID: '-1001approval' });
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  assert.equal(second.res.body.approval_transitioned, false);
  assert.deepEqual(second.res.body.approval_notification, { status: 'skipped', reason: 'no_approval_transition' });
});

test('concurrent approval requests cannot produce two transition notifications', async function() {
  await withEnv({ TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1', TELEGRAM_APPROVAL_CHAT_ID: '-1001approval' }, async function() {
    const db = createApprovalDatabase();
    const calls = [];
    const originalSend = notifier.sendTelegramMessage;
    notifier.sendTelegramMessage = async function(message) { calls.push(message); return { sent: true, skipped: false }; };
    try {
      const handler = loadApiWithSupabase('../api/admin-users', db.createClient);
      const resA = makeRes();
      const resB = makeRes();
      await Promise.all([
        handler(adminRequest({ action: 'approve', username: 'maxphillips' }), resA),
        handler(adminRequest({ action: 'approve', username: 'maxphillips' }), resB)
      ]);
      assert.equal(calls.length, 1);
      assert.equal([resA.body.approval_transitioned, resB.body.approval_transitioned].filter(Boolean).length, 1);
    } finally {
      notifier.sendTelegramMessage = originalSend;
    }
  });
});

test('blocking, editing, and rejecting never send approval notifications', async function() {
  for (const action of ['block', 'unblock', 'reject']) {
    const db = createApprovalDatabase();
    const result = await runAdmin(db, { action: action, username: 'maxphillips' }, null, {
      TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
      TELEGRAM_APPROVAL_CHAT_ID: '-1001approval'
    });
    assert.equal(result.res.statusCode, 200, action);
    assert.equal(result.calls.length, 0, action);
  }
});

test('approval Telegram message contains only masked username, code, status, and canonical URL', async function() {
  const db = createApprovalDatabase({
    password_hash: 'never-publish-hash', device_id: 'never-publish-device',
    token: 'never-publish-token', email: 'private@example.test'
  });
  const result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, {
    TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
    TELEGRAM_APPROVAL_CHAT_ID: '-1001approval'
  });
  const expectedCode = approval.generateApprovalCode({ id: 'approval-user-id' });
  assert.equal(result.calls[0].message,
    '✅ AKUN DISETUJUI\n\n' +
    'Username: ma********s\n' +
    'Kode: ' + expectedCode + '\n' +
    'Status: Aktif\n\n' +
    'Silakan login:\n' +
    'https://autocuan.web.id');
  assert.doesNotMatch(result.calls[0].message, /maxphillips|never-publish|private@example|approval-user-id/);
});

test('Telegram failure does not undo successful database approval', async function() {
  const db = createApprovalDatabase();
  const result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, function() {
    return { sent: false, skipped: false, reason: 'fetch_error', error_message: 'sensitive provider response' };
  }, { TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1', TELEGRAM_APPROVAL_CHAT_ID: '-1001approval' });
  assert.equal(db.state.row.is_approved, true);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.approval_transitioned, true);
  assert.deepEqual(result.res.body.approval_notification, { status: 'failed' });
  assert.doesNotMatch(JSON.stringify(result.res.body), /sensitive provider response|fetch_error/);
});

test('disabled or misconfigured approval notifications skip safely', async function() {
  let db = createApprovalDatabase();
  let result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, {});
  assert.equal(db.state.row.is_approved, true);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.res.body.approval_notification, { status: 'skipped', reason: 'approval_notifications_disabled' });

  db = createApprovalDatabase();
  result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, function() {
    return { sent: false, skipped: true, reason: 'missing_chat_id' };
  }, { TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1', TELEGRAM_APPROVAL_CHAT_ID: '-1001approval' });
  assert.equal(db.state.row.is_approved, true);
  assert.deepEqual(result.res.body.approval_notification, { status: 'skipped', reason: 'telegram_disabled_or_misconfigured' });
  assert.doesNotMatch(JSON.stringify(result.res.body), /missing_chat_id/);
});

// ===== Backward compatibility: existing approved users are untouched =====

test('an approval request for an already-approved budi does not transition, notify, or mutate', async function() {
  const db = createApprovalDatabase({
    id: 'budi-immutable-id', username: 'budi', is_approved: true, is_blocked: false,
    password_hash: 'budi-hash', devices: ['budi_dev_1']
  });
  const before = JSON.stringify(db.state.row);
  const result = await runAdmin(db, { action: 'approve', username: 'budi' }, null, {
    TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
    TELEGRAM_APPROVAL_CHAT_ID: '-1001approval'
  });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.approval_transitioned, false);
  assert.deepEqual(result.res.body.approval_notification, { status: 'skipped', reason: 'no_approval_transition' });
  assert.equal(result.calls.length, 0, 'no notification for an already-approved account');
  assert.equal(db.state.row.is_approved, true);
  assert.equal(JSON.stringify(db.state.row), before, 'the already-approved budi row is untouched');
});

test('existing approved users never trigger an approval notification', async function() {
  for (const username of ['budi', 'alice']) {
    const db = createApprovalDatabase({ id: username + '-id', username: username, is_approved: true });
    const before = JSON.stringify(db.state.row);
    const result = await runAdmin(db, { action: 'approve', username: username }, null, {
      TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
      TELEGRAM_APPROVAL_CHAT_ID: '-1001approval'
    });
    assert.equal(result.res.body.approval_transitioned, false, username);
    assert.equal(result.calls.length, 0, username);
    assert.equal(JSON.stringify(db.state.row), before, username + ' row untouched');
  }
});

// ===== Channel safety: dedicated approval chat is mandatory =====

test('missing TELEGRAM_APPROVAL_CHAT_ID skips the notification without calling the notifier', async function() {
  const db = createApprovalDatabase();
  const result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, {
    TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1'
  });
  assert.equal(result.res.body.approval_transitioned, true);
  assert.deepEqual(result.res.body.approval_notification, { status: 'skipped', reason: 'missing_approval_chat_id' });
  assert.equal(result.calls.length, 0, 'notifier must not be called without a dedicated approval chat');
  assert.equal(db.state.row.is_approved, true);
});

test('TELEGRAM_CHAT_ID alone is never used for approval notifications', async function() {
  const db = createApprovalDatabase();
  const result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, {
    TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
    TELEGRAM_ENABLED: '1',
    TELEGRAM_BOT_TOKEN: 'operational-token',
    TELEGRAM_CHAT_ID: '-1001operational'
  });
  assert.deepEqual(result.res.body.approval_notification, { status: 'skipped', reason: 'missing_approval_chat_id' });
  assert.equal(result.calls.length, 0, 'approval must never be sent to the operational/monitor chat');
});

test('the dedicated approval chat id is passed to the notifier when configured', async function() {
  const db = createApprovalDatabase();
  const result = await runAdmin(db, { action: 'approve', username: 'maxphillips' }, null, {
    TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED: '1',
    TELEGRAM_APPROVAL_CHAT_ID: '-1001approval',
    TELEGRAM_CHAT_ID: '-1001operational'
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].options.chat_id, '-1001approval');
  assert.deepEqual(result.res.body.approval_notification, { status: 'sent' });
});

// ===== Pre-feature pending users recover their code through login =====

function loginSupabase(user) {
  return function() {
    return {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          maybeSingle() { return Promise.resolve({ data: user || null, error: null }); },
          update() { return { eq() { return Promise.resolve({ data: null, error: null }); } }; }
        };
        return query;
      },
      // v2: pending login issues a fresh one-time challenge via this RPC.
      rpc(name) {
        if (name === 'issue_telegram_challenge') {
          return Promise.resolve({ data: [{ challenge_id: 'ch-login-1', expires_at: new Date(Date.now() + 900000).toISOString() }], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
    };
  };
}

async function runLogin(user, body, env) {
  return withEnv(env || {}, async function() {
    const handler = loadApiWithSupabase('../api/login-user', loginSupabase(user));
    const res = makeRes();
    await handler({ method: 'POST', body: body }, res);
    return res;
  });
}

function pendingUser(overrides) {
  return Object.assign({
    id: 'old-pending-id', username: 'olduser', password_hash: 'correct-hash',
    devices: ['dev1'], is_blocked: false, is_approved: false
  }, overrides || {});
}

test('a pre-feature pending user with the correct password receives a fresh verification code and no session', async function() {
  const res = await runLogin(
    pendingUser(),
    { username: 'olduser', passwordHash: 'correct-hash', deviceId: 'dev1', userAgent: 'ua' },
    {}
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(res.body.approval_status, 'pending');
  assert.equal(res.body.approval_code, approval.generateApprovalCode({ id: 'old-pending-id' }));
  // v2: a fresh one-time verification code + the fixed bot URL; never a channel link.
  assert.match(res.body.telegram_verification_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(res.body.telegram_bot_url, 'https://t.me/AutoCuanVerificationBot');
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'telegram_channel_url'), false);
  // No session is issued and the user is not logged in.
  assert.ok(!res.headers['Set-Cookie'], 'a pending login must not set a session cookie');
  assert.equal(res.body.userId, undefined);
  assert.equal(res.body.isAdmin, undefined);
});

test('a pending login never returns a channel URL (v2)', async function() {
  const res = await runLogin(
    pendingUser(),
    { username: 'olduser', passwordHash: 'correct-hash', deviceId: 'dev1', userAgent: 'ua' },
    {}
  );
  assert.equal(res.body.approval_status, 'pending');
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'telegram_channel_url'), false);
  assert.ok(res.body.telegram_verification_code, 'a fresh one-time code is issued');
});

test('a wrong password reveals no approval information and no session', async function() {
  const res = await runLogin(
    pendingUser(),
    { username: 'olduser', passwordHash: 'WRONG-HASH', deviceId: 'dev1', userAgent: 'ua' },
    {}
  );
  assert.equal(res.body.success, false);
  ['approval_status', 'approval_code', 'telegram_channel_url'].forEach(function(field) {
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, field), false, field + ' must not leak');
  });
  assert.ok(!res.headers['Set-Cookie']);
  assert.match(res.body.error, /Username atau password salah\./);
});

test('an unknown username reveals no approval information', async function() {
  const res = await runLogin(
    null,
    { username: 'ghost', passwordHash: 'anything', deviceId: 'dev1', userAgent: 'ua' },
    {}
  );
  assert.equal(res.body.success, false);
  ['approval_status', 'approval_code', 'telegram_channel_url'].forEach(function(field) {
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, field), false, field + ' must not leak');
  });
  assert.match(res.body.error, /Username atau password salah\./);
});

test('unknown username and wrong password produce an identical generic error (no enumeration)', async function() {
  const wrong = await runLogin(pendingUser(), { username: 'olduser', passwordHash: 'WRONG', deviceId: 'dev1' }, {});
  const unknown = await runLogin(null, { username: 'ghost', passwordHash: 'WRONG', deviceId: 'dev1' }, {});
  assert.equal(wrong.body.error, unknown.body.error);
  assert.equal(wrong.statusCode, unknown.statusCode);
});

// ===== Pending-login UI reuses the approval panel =====

function makePendingLoginUi(html) {
  const elements = {
    loginModal: makeElement(),
    loginPassword: makeElement(),
    registerModal: makeElement(['hidden']),
    registerError: makeElement(),
    registerSuccess: makeElement(),
    registerApprovalCode: makeElement(),
    registerVerificationCode: makeElement(),
    registerVerificationExpiry: makeElement(),
    registerFormFields: makeElement(),
    registerApprovalPanel: makeElement(['hidden']),
    openVerificationBot: makeElement(['hidden'])
  };
  const source =
    extractFunction(html, 'function validVerificationBotUrl') + '\n' +
    extractFunction(html, 'function formatVerificationExpiry') + '\n' +
    extractFunction(html, 'function displayApprovalPanel') + '\n' +
    extractFunction(html, 'function closeLoginModal') + '\n' +
    extractFunction(html, 'function showPendingLoginApproval') + '\nreturn showPendingLoginApproval;';
  const show = new Function('document', 'URL', source)(
    { getElementById(id) { return elements[id]; } },
    URL
  );
  return { elements: elements, show: show };
}

test('pending-login UI shows the codes and the verification-bot button and clears the password', function() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const ui = makePendingLoginUi(html);
  ui.elements.loginPassword.value = 'MyLoginP@ss1';
  ui.show({ approval_status: 'pending', approval_code: 'AC-123ABC', telegram_verification_code: 'WXYZ-2345', telegram_bot_url: 'https://t.me/AutoCuanVerificationBot' });
  assert.equal(ui.elements.registerApprovalCode.textContent, 'AC-123ABC');
  assert.equal(ui.elements.registerVerificationCode.textContent, 'WXYZ-2345');
  assert.equal(ui.elements.registerApprovalPanel.classList.contains('hidden'), false);
  assert.equal(ui.elements.registerModal.classList.contains('hidden'), false);
  assert.equal(ui.elements.loginModal.classList.contains('hidden'), true);
  assert.equal(ui.elements.openVerificationBot.classList.contains('hidden'), false);
  assert.equal(ui.elements.openVerificationBot.href, 'https://t.me/AutoCuanVerificationBot');
  assert.equal(ui.elements.loginPassword.value, '', 'login password cleared after a pending login');
});

test('doLogin routes a valid pending response to the approval panel and never logs in', function() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const doLogin = extractFunction(html, 'async function doLogin');
  const loginSuccess = doLogin.indexOf('autocuan_logged_in');
  const pendingBranch = doLogin.indexOf("data.approval_status === 'pending'");
  assert.ok(pendingBranch >= 0, 'doLogin must handle a pending response');
  assert.ok(loginSuccess >= 0 && loginSuccess < pendingBranch, 'the pending branch must be separate from the logged-in path');
  assert.match(doLogin, /showPendingLoginApproval\(data\)/);
});

test('API endpoint JavaScript count remains exactly 12', function() {
  const endpoints = fs.readdirSync(path.join(ROOT, 'api')).filter(function(file) { return file.endsWith('.js'); });
  assert.equal(endpoints.length, 12, endpoints.join(', '));
});

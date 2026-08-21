'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const maintenanceCode = require('../lib/admin-maintenance-code');
const maintenanceState = require('../lib/maintenance-state');

function makeBot() {
  const sent = [];
  const deleted = [];
  return {
    sent,
    deleted,
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: 321 };
    },
    async deleteMessage(chatId, messageId) {
      deleted.push({ chatId, messageId });
      return true;
    }
  };
}

function emptyCleanupQuery() {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    is() { return chain; },
    neq() { return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: [], error: null }); },
    update() { return chain; }
  };
  return chain;
}

function maintenanceSettingsQuery(enabled) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    maybeSingle() {
      return Promise.resolve({
        data: { value: { maintenanceMode: enabled === true, message: 'test' } },
        error: null
      });
    }
  };
  return chain;
}

function makeDb(options) {
  const opts = options || {};
  const maintenanceEnabled = opts.maintenanceEnabled !== false;
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'get_admin_maintenance_code_status') {
        return Promise.resolve({ data: [{ result_code: 'idle', active: false, expires_at: null }], error: null });
      }
      if (name === 'claim_auth_recovery_webhook_update') {
        return Promise.resolve({ data: [{ claimed: true }], error: null });
      }
      if (name === 'complete_auth_recovery_webhook_update') {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'issue_admin_maintenance_code') {
        return Promise.resolve({ data: [{
          result_code: 'ok',
          grant_id: '11111111-1111-4111-8111-111111111111',
          user_id: 'user-budi',
          username: 'budi',
          expires_at: new Date(Date.now() + 120000).toISOString()
        }], error: null });
      }
      if (name === 'record_admin_maintenance_code_message') {
        return Promise.resolve({ data: [{ result_code: 'ok' }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      if (table === 'app_settings') return maintenanceSettingsQuery(maintenanceEnabled);
      return emptyCleanupQuery();
    }
  };
}

function accessUpdate() {
  return {
    update_id: 9001,
    message: {
      message_id: 10,
      chat: { id: 777, type: 'private' },
      from: { id: 999 },
      text: '/akses'
    }
  };
}

test('maintenance state parser only enables explicit maintenanceMode true', function () {
  assert.equal(maintenanceState.parseMaintenanceValue({ maintenanceMode: true }).enabled, true);
  assert.equal(maintenanceState.parseMaintenanceValue({ maintenanceMode: false }).enabled, false);
  assert.equal(maintenanceState.parseMaintenanceValue('{"maintenanceMode":true}').enabled, true);
  assert.equal(maintenanceState.parseMaintenanceValue('bad-json').enabled, false);
});

test('maintenance code is six digits and stored only as server-HMAC digest', function () {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  try {
    const code = maintenanceCode.generateCode();
    assert.match(code, /^\d{6}$/);
    const digest = maintenanceCode.hashCode('123456');
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(digest, '123456');
    assert.equal(digest, maintenanceCode.hashCode('123456'));
  } finally {
    if (previous == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('/akses sends one-time code only while maintenance is enabled and deletes command best-effort', async function () {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  try {
    const db = makeDb({ maintenanceEnabled: true });
    const bot = makeBot();
    const result = await maintenanceCode.handleUpdate(accessUpdate(), { db, bot });

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'admin_maintenance_code_sent');
    assert.equal(bot.sent.length, 1);
    assert.match(bot.sent[0].text, /Kode: \d{6}/);
    assert.match(bot.sent[0].text, /menampilkan kolom kode otomatis/i);
    assert.match(bot.sent[0].text, /Tidak perlu refresh/i);
    assert.match(bot.sent[0].text, /digit ke-6/i);
    assert.match(bot.sent[0].text, /maksimal 5 percobaan/i);
    assert.doesNotMatch(bot.sent[0].text, /https?:\/\//);
    assert.deepEqual(bot.deleted, [{ chatId: 777, messageId: 10 }]);

    const issue = db.calls.find(function (call) { return call.name === 'issue_admin_maintenance_code'; });
    assert.ok(issue);
    assert.equal(issue.args.p_telegram_user_id, 999);
    assert.match(issue.args.p_token_hash, /^[a-f0-9]{64}$/);

    const record = db.calls.find(function (call) { return call.name === 'record_admin_maintenance_code_message'; });
    assert.ok(record);
    assert.equal(record.args.p_telegram_chat_id, 777);
    assert.equal(record.args.p_telegram_message_id, 321);
  } finally {
    if (previous == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('/akses is rejected and no code is issued while maintenance is off', async function () {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  try {
    const db = makeDb({ maintenanceEnabled: false });
    const bot = makeBot();
    const result = await maintenanceCode.handleUpdate(accessUpdate(), { db, bot });

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'admin_maintenance_code_not_in_maintenance');
    assert.deepEqual(bot.deleted, [{ chatId: 777, messageId: 10 }]);
    assert.equal(db.calls.some(function (call) { return call.name === 'issue_admin_maintenance_code'; }), false);
    assert.equal(bot.sent.length, 1);
    assert.match(bot.sent[0].text, /hanya tersedia saat Auto-Cuan sedang maintenance/i);
  } finally {
    if (previous == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('missing maintenance-code schema falls back instead of stealing /akses', async function () {
  const db = {
    rpc(name) {
      if (name === 'get_admin_maintenance_code_status') {
        return Promise.resolve({ data: null, error: { code: '42883', message: 'function does not exist' } });
      }
      throw new Error('unexpected rpc ' + name);
    }
  };
  const result = await maintenanceCode.handleUpdate(accessUpdate(), { db, bot: makeBot() });
  assert.equal(result.handled, false);
  assert.equal(result.outcome, 'admin_maintenance_code_schema_unavailable');
});

test('browser live-polls maintenance state, reveals active code without refresh, and auto-submits six digits', function () {
  const api = fs.readFileSync(path.join(ROOT, 'api', 'reset-password.js'), 'utf8');
  const maintenanceApi = fs.readFileSync(path.join(ROOT, 'api', 'maintenance-settings.js'), 'utf8');
  const browser = fs.readFileSync(path.join(ROOT, 'lib', 'admin-maintenance-code-browser.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'admin-maintenance-code.js'), 'utf8');
  const pairingUi = fs.readFileSync(path.join(ROOT, 'public', 'admin-zero-link-pairing.js'), 'utf8');
  const loader = fs.readFileSync(path.join(ROOT, 'public', 'website-approved-access.js'), 'utf8');
  const access = fs.readFileSync(path.join(ROOT, 'lib', 'admin-access.js'), 'utf8');

  assert.match(api, /admin-maintenance-code-consume/);
  assert.match(api, /admin-maintenance-code-cleanup/);
  assert.match(maintenanceApi, /get_admin_maintenance_code_status/);
  assert.match(maintenanceApi, /adminCode/);
  assert.match(browser, /readMaintenanceState/);
  assert.match(browser, /not_maintenance/);
  assert.match(browser, /consume_admin_maintenance_code/);
  assert.match(browser, /buildSessionCookie/);
  assert.match(browser, /deleteMessageSafely/);
  assert.match(browser, /telegram_success_message_id/);

  assert.match(ui, /MAINTENANCE_API = '\/api\/maintenance-settings'/);
  assert.match(ui, /IDLE_POLL_MS = 1200/);
  assert.match(ui, /function readMaintenanceStatus/);
  assert.match(ui, /function checkLiveStatus/);
  assert.match(ui, /scheduleStatusCheck\(nextDelay\)/);
  assert.match(ui, /visibilitychange/);
  assert.match(ui, /window\.addEventListener\('focus'/);
  assert.match(ui, /scheduleStatusCheck\(100\)/);
  assert.doesNotMatch(ui, /function checkOnLoad/);
  assert.match(ui, /window\.getComputedStyle/);
  assert.match(ui, /data-admin-code-host-outer/);
  assert.match(ui, /function renderIdleCode/);
  assert.match(ui, /removeCodeUi\(scope\)/);
  assert.match(ui, /this\.value\.length === 6 && !submitting/);
  assert.match(ui, /submitCode\(scope\)/);
  assert.doesNotMatch(ui, /data-code-submit/);
  assert.match(ui, /validateAutocuanSession/);

  assert.match(pairingUi, /__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__/);
  assert.match(loader, /admin-maintenance-code\.js\?v=20260821-v6/);
  assert.match(access, /maintenanceCode\.handleUpdate/);
});

test('migration enforces two-minute one-time code semantics and keeps server audit state', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-maintenance-code-migration.sql'), 'utf8');
  assert.match(sql, /grant_purpose text NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /grant_purpose = 'maintenance_code'/);
  assert.match(sql, /code_attempts >= 5/);
  assert.match(sql, /consume_admin_maintenance_code/);
  assert.match(sql, /state = 'consumed'/);
  assert.match(sql, /telegram_messages_cleaned_at/);
  assert.doesNotMatch(sql, /raw_code|plain_code|code_value/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.consume_admin_maintenance_code\(text\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.consume_admin_maintenance_code\(text\) TO service_role/);
});

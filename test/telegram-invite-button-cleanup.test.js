'use strict';

// ===========================================================================
// Mocked tests for the Telegram "Ajukan Bergabung" button cleanup fix.
//
// LOCAL / MOCKED ONLY: no live Telegram, no Supabase, no network. The verify
// bot's HTTP layer is exercised via a stubbed global.fetch; no real token is
// used or printed. Source-scan guards protect the isolation + earlier features.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// editMessageReplyMarkup helper: verify-token only, EMPTY inline keyboard.
// ---------------------------------------------------------------------------
test('editMessageReplyMarkup sends an empty inline keyboard using the verify bot token', async function () {
  const savedFetch = global.fetch;
  const savedVerify = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  const savedMain = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'verify-token-xyz';
  process.env.TELEGRAM_BOT_TOKEN = 'MAIN-BOT-TOKEN-SHOULD-NOT-BE-USED';
  const captured = [];
  global.fetch = async function (url, init) {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async function () { return { ok: true, result: true }; } };
  };
  try {
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
    const bot = require('../lib/telegram-verify-bot');
    await bot.editMessageReplyMarkup(-100123, 4567);
    assert.equal(captured.length, 1);
    assert.ok(captured[0].url.indexOf('/editMessageReplyMarkup') !== -1, 'calls editMessageReplyMarkup');
    // Uses the VERIFY token in the URL, never the recommendation bot token.
    assert.ok(captured[0].url.indexOf('verify-token-xyz') !== -1, 'verify token used');
    assert.ok(captured[0].url.indexOf('MAIN-BOT-TOKEN-SHOULD-NOT-BE-USED') === -1, 'main bot token NEVER used');
    assert.deepEqual(captured[0].body.reply_markup, { inline_keyboard: [] }, 'empty inline keyboard removes the button');
    assert.equal(captured[0].body.chat_id, -100123);
    assert.equal(captured[0].body.message_id, 4567);
  } finally {
    global.fetch = savedFetch;
    if (savedVerify === undefined) delete process.env.TELEGRAM_VERIFY_BOT_TOKEN; else process.env.TELEGRAM_VERIFY_BOT_TOKEN = savedVerify;
    if (savedMain === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedMain;
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
  }
});

test('editMessageReplyMarkup surfaces only a sanitized error (no token, no raw body) on API failure', async function () {
  const savedFetch = global.fetch;
  const savedVerify = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'verify-token-secret-1234';
  global.fetch = async function () {
    return { ok: false, json: async function () { return { ok: false, description: 'Bad Request: message to edit not found', error_code: 400 }; } };
  };
  try {
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
    const bot = require('../lib/telegram-verify-bot');
    let err = null;
    try { await bot.editMessageReplyMarkup(1, 2); } catch (e) { err = e; }
    assert.ok(err, 'throws on API error');
    const serialized = String(err && err.code) + '|' + String(err && err.message);
    assert.ok(serialized.indexOf('verify-token-secret-1234') === -1, 'no token leaked');
    assert.ok(serialized.indexOf('message to edit not found') === -1, 'no raw Telegram body leaked');
  } finally {
    global.fetch = savedFetch;
    if (savedVerify === undefined) delete process.env.TELEGRAM_VERIFY_BOT_TOKEN; else process.env.TELEGRAM_VERIFY_BOT_TOKEN = savedVerify;
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
  }
});

// ---------------------------------------------------------------------------
// Isolation / regression source-scan guards.
// ---------------------------------------------------------------------------
test('verify bot + verification never reference TELEGRAM_BOT_TOKEN (recommendation bot isolation)', function () {
  ['lib/telegram-verify-bot.js', 'lib/telegram-verification.js'].forEach(function (rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Must never READ the recommendation bot token from the environment.
    assert.equal(src.indexOf('process.env.TELEGRAM_BOT_TOKEN') !== -1, false, rel + ' must not read process.env.TELEGRAM_BOT_TOKEN');
    assert.equal(/require\(['"][^'"]*telegram-notifier/.test(src), false, rel + ' must not import the recommendation bot');
  });
});

test('verify bot exposes editMessageReplyMarkup in its factory and module exports', function () {
  const bot = require('../lib/telegram-verify-bot');
  assert.equal(typeof bot.editMessageReplyMarkup, 'function');
  assert.equal(typeof bot.createVerifyBot().editMessageReplyMarkup, 'function');
});

test('the completed cleanup message text matches the required copy', function () {
  const tv = require('../lib/telegram-verification');
  assert.equal(
    tv.MSG.channelAccessActive,
    '\u2705 Akses channel sudah aktif\n\nPermintaan bergabung kamu telah disetujui.\nSelamat bergabung di channel Auto-Cuan.'
  );
});

test('API JavaScript file count remains exactly 12', function () {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'API JS file count must remain 12; got ' + files.length);
});

test('Delete User is admin-gated and protects system accounts (no extra endpoint)', function () {
  const adminApi = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.ok(/action === 'delete_user'/.test(adminApi), 'delete_user action exists');
  assert.ok(/requireAdminSession\(req\)/.test(adminApi), 'delete requires a signed admin session');
  assert.ok(/isSameOrigin\(req\)/.test(adminApi), 'delete requires a same-origin request');
  assert.ok(/targetUsername === 'budi' \|\| targetUsername === 'review'/.test(adminApi), 'budi/review cannot be deleted');
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.ok(!apiFiles.some(function (f) { return /delete/i.test(f); }), 'no separate delete-user API function');
});

test('Approved Users view remains intact (filter, device helpers, safe actions)', function () {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/key:\s*'approved'\s*,\s*label:\s*'Sudah Di-approve'/.test(html), 'Sudah Di-approve filter present');
  assert.ok(html.indexOf('APPROVED-USERS-HELPERS-START') !== -1, 'approved-view helpers present');
  assert.ok(html.indexOf('function maskDeviceId') !== -1, 'masked device details present');
  assert.ok(html.indexOf('function renderApprovedUsersTable') !== -1, 'approved table renderer present');
  const start = html.indexOf('function renderApprovedUsersTable');
  const end = html.indexOf('// ===== APPROVED-USERS-HELPERS-END =====');
  const approvedSrc = html.slice(start, end);
  assert.equal(/delete/i.test(approvedSrc), false, 'approved table renders no delete control');
});

// ---------------------------------------------------------------------------
// SQL hotfix guard: additive column + service-role-only RPCs.
// ---------------------------------------------------------------------------
test('invite-message cleanup SQL hotfix is additive and service-role only', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'telegram-invite-message-cleanup-hotfix.sql'), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS invite_message_id bigint/.test(sql), 'additive column');
  assert.ok(/save_invite_message_id\(/.test(sql) && /clear_invite_message_id\(/.test(sql), 'both RPCs defined');
  assert.ok(/SECURITY DEFINER SET search_path = pg_catalog, public/.test(sql), 'fixed safe search_path');
  assert.ok(/REVOKE ALL ON FUNCTION .* FROM PUBLIC, anon, authenticated/.test(sql), 'revoked from PUBLIC/anon/authenticated');
  assert.ok(/GRANT  EXECUTE ON FUNCTION .* TO service_role/.test(sql), 'granted to service_role only');
  // No destructive statements.
  assert.equal(/DROP\s+(TABLE|COLUMN|FUNCTION)/i.test(sql), false, 'no destructive DROP');
});

test('main migration includes the new column + RPCs for fresh installs', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'telegram-verification-v2-migration.sql'), 'utf8');
  assert.ok(/invite_message_id\s+bigint/.test(sql), 'column present in table def');
  assert.ok(/save_invite_message_id\(uuid,bigint\)/.test(sql), 'save RPC in grant loop');
  assert.ok(/clear_invite_message_id\(uuid\)/.test(sql), 'clear RPC in grant loop');
});

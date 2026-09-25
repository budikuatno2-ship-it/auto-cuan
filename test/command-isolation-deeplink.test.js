'use strict';

/**
 * Command isolation + deep-link UX flow contract.
 *
 * Bot 1 (Signal Saham Bot, lib/telegram-interactive-bot.js) owns every market
 * command and refuses unverified senders with a deep-linked hold CTA.
 *
 * Bot 2 (AutoCuan Verification Bot, lib/telegram-verification.js) owns ACCOUNT
 * commands only. A member arriving from the group deep-link gets the
 * registration form CTA and NEVER the legacy "copy the code from the website"
 * instructions. A signal command typed in the verification bot is redirected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const tv = require('../lib/telegram-verification');
const { createInteractiveBot } = require('../lib/telegram-interactive-bot');
const registerToken = require('../lib/telegram-register-token');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Fake verify bot (records calls; no network)
// ---------------------------------------------------------------------------
function makeFakeBot(opts) {
  opts = opts || {};
  const calls = {
    sendMessage: [], editMessageText: [], editMessageReplyMarkup: [],
    answerCallbackQuery: [], getChatMember: [], createChatInviteLink: [],
    revokeChatInviteLink: [], approveChatJoinRequest: [], declineChatJoinRequest: []
  };
  let msgId = 100;
  return {
    calls: calls,
    sendMessage: async function (chatId, text, options) {
      calls.sendMessage.push({ chatId, text, options });
      return { message_id: ++msgId };
    },
    editMessageText: async function (chatId, messageId, text, options) {
      calls.editMessageText.push({ chatId, messageId, text, options });
      return {};
    },
    editMessageReplyMarkup: async function (chatId, messageId) {
      calls.editMessageReplyMarkup.push({ chatId, messageId });
      return {};
    },
    answerCallbackQuery: async function (id, options) {
      calls.answerCallbackQuery.push({ id, options });
      return {};
    },
    getChatMember: async function (chatId, userId) {
      calls.getChatMember.push({ chatId, userId });
      return { status: 'member' };
    },
    createChatInviteLink: async function (chatId, options) {
      calls.createChatInviteLink.push({ chatId, options });
      return 'https://t.me/+dynamicPerUser';
    },
    revokeChatInviteLink: async function (chatId, link) {
      calls.revokeChatInviteLink.push({ chatId, link });
      return {};
    },
    approveChatJoinRequest: async function (chatId, userId) {
      calls.approveChatJoinRequest.push({ chatId, userId });
      return true;
    },
    declineChatJoinRequest: async function (chatId, userId) {
      calls.declineChatJoinRequest.push({ chatId, userId });
      return true;
    }
  };
}

// Minimal Supabase stub: a bot_users reader for /akun and /cek plus the coarse
// webhook claim/complete RPCs used by processWebhookUpdate.
function makeAccountDb(rows) {
  const table = new Map((rows || []).map(function (r) { return [String(r.telegram_id), r]; }));
  const claimed = new Map();
  return {
    from: function (name) {
      const b = { _name: name, _filters: [] };
      b.select = function () { return b; };
      b.eq = function (col, val) { b._filters.push([col, String(val)]); return b; };
      b.maybeSingle = function () {
        if (name !== 'bot_users') return Promise.resolve({ data: null, error: null });
        for (const row of table.values()) {
          const match = b._filters.every(function (f) { return String(row[f[0]]) === f[1]; });
          if (match) return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      return b;
    },
    rpc: function (name, args) {
      const a = args || {};
      if (name === 'claim_telegram_webhook_update') {
        if (claimed.has(a.p_update_id)) {
          return Promise.resolve({ data: [{ claim_state: 'already_processed' }], error: null });
        }
        claimed.set(a.p_update_id, 'tok-' + a.p_update_id);
        return Promise.resolve({
          data: [{ claim_state: 'claimed', processing_token: 'tok-' + a.p_update_id }],
          error: null
        });
      }
      if (name === 'complete_telegram_webhook_update') {
        return Promise.resolve({ data: [true], error: null });
      }
      if (name === 'check_telegram_sender_limit') {
        return Promise.resolve({ data: [{ locked: false, locked_until: null }], error: null });
      }
      return Promise.resolve({ data: [null], error: null });
    }
  };
}

function privateMessage(updateId, senderId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: senderId, type: 'private' },
      from: { id: senderId, username: 'member' },
      text: text
    }
  };
}

function flatButtons(options) {
  const kb = options && options.reply_markup && options.reply_markup.inline_keyboard;
  return kb ? kb.flat() : [];
}

// ===========================================================================
// KONDISI A — deep-link from the group
// ===========================================================================
test('deeplink: /start verify_<id> sends the registration form CTA with user_id and NO web-code text', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  const res = await tv.processWebhookUpdate(
    privateMessage(1, 42, '/start verify_42'),
    { supabase: db, bot: bot }
  );
  assert.equal(res.outcome, 'registration_form');
  assert.equal(bot.calls.sendMessage.length, 1);
  const msg = bot.calls.sendMessage[0];
  assert.equal(msg.text, tv.REGISTER_FORM_MESSAGE);
  assert.match(msg.text, /Nama Lengkap & Gmail/);
  // The legacy copy-the-code instruction must never be produced on this path.
  assert.doesNotMatch(msg.text, /Salin kode/i);
  assert.doesNotMatch(msg.text, /15 menit/);
  const button = flatButtons(msg.options)[0];
  assert.equal(button.text, '📝 Buka Formulir Pendaftaran');
  assert.match(button.url, /^https:\/\/autocuan\.web\.id\/register\.html\?/);
  assert.match(button.url, /user_id=42/);
});

test('deeplink: the payload id wins over the sender id and is forwarded verbatim', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  await tv.processWebhookUpdate(privateMessage(2, 42, '/start verify_98765'), { supabase: db, bot: bot });
  const button = flatButtons(bot.calls.sendMessage[0].options)[0];
  assert.match(button.url, /user_id=98765/);
});

test('deeplink: /verifikasi and /daftar follow the same registration path', async function () {
  for (const [idx, command] of ['/verifikasi', '/daftar'].entries()) {
    const bot = makeFakeBot();
    const db = makeAccountDb([]);
    const res = await tv.processWebhookUpdate(privateMessage(10 + idx, 77, command), { supabase: db, bot: bot });
    assert.equal(res.outcome, 'registration_form', command + ' routes to the form');
    assert.equal(bot.calls.sendMessage[0].text, tv.REGISTER_FORM_MESSAGE);
    const button = flatButtons(bot.calls.sendMessage[0].options)[0];
    assert.match(button.url, /user_id=77/);
  }
});

test('deeplink: a one-time token is minted when the store is available', async function () {
  registerToken.clearMemoryStoreForTesting();
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  await tv.processWebhookUpdate(privateMessage(3, 55, '/start verify_55'), {
    supabase: db,
    bot: bot,
    registerTokenStore: registerToken
  });
  const button = flatButtons(bot.calls.sendMessage[0].options)[0];
  assert.match(button.url, /user_id=55/);
  assert.match(button.url, /token=/);
});

// ===========================================================================
// KONDISI B — plain /start
// ===========================================================================
test('kondisi B: a bare /start still shows the legacy guide plus the registration CTA', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  const res = await tv.processWebhookUpdate(privateMessage(4, 11, '/start'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'start');
  const msg = bot.calls.sendMessage[0];
  assert.equal(msg.text, tv.MSG.start);
  assert.match(msg.text, /Salin kode verifikasi dari halaman pendaftaran website/);
  const button = flatButtons(msg.options)[0];
  assert.equal(button.text, '📝 Buka Formulir Pendaftaran');
  assert.match(button.url, /user_id=11/);
});

// ===========================================================================
// KONDISI C — account status
// ===========================================================================
test('kondisi C: /akun reports name, masked email, status and remaining quota', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([{
    telegram_id: '42',
    username: 'trader',
    full_name: 'Budi Santoso',
    gmail: 'budisantoso@gmail.com',
    status: 'active',
    daily_limit: 15,
    daily_usage: 3,
    last_usage_date: tv.wibDayKey()
  }]);
  const res = await tv.processWebhookUpdate(privateMessage(5, 42, '/akun'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'account_status');
  const text = bot.calls.sendMessage[0].text;
  assert.match(text, /Budi Santoso/);
  assert.match(text, /bu\*+@gmail\.com/);
  assert.doesNotMatch(text, /budisantoso@gmail\.com/, 'the full address is never echoed');
  assert.match(text, /Status: Aktif/);
  assert.match(text, /Sisa Kuota Hari Ini: 12\/15/);
});

test('kondisi C: /cek is an alias of /akun and a pending account is labelled Pending', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([{
    telegram_id: '43', full_name: 'Siti', gmail: 'siti@gmail.com', status: 'pending',
    daily_limit: 15, daily_usage: 0, last_usage_date: tv.wibDayKey()
  }]);
  const res = await tv.processWebhookUpdate(privateMessage(6, 43, '/cek'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'account_status');
  const text = bot.calls.sendMessage[0].text;
  assert.match(text, /Status: Pending/);
  assert.match(text, /sedang ditinjau admin/);
});

test('kondisi C: an unknown sender is told to register, without leaking anything', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  const res = await tv.processWebhookUpdate(privateMessage(7, 99, '/akun'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'account_not_registered');
  const text = bot.calls.sendMessage[0].text;
  assert.match(text, /Belum Terdaftar/);
  assert.match(text, /\/daftar/);
});

test('kondisi C: a stale last_usage_date reports a full quota (reset semantics)', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([{
    telegram_id: '44', full_name: 'Andi', gmail: 'andi@gmail.com', status: 'active',
    daily_limit: 20, daily_usage: 20, last_usage_date: '2020-01-01'
  }]);
  await tv.processWebhookUpdate(privateMessage(8, 44, '/akun'), { supabase: db, bot: bot });
  assert.match(bot.calls.sendMessage[0].text, /Sisa Kuota Hari Ini: 20\/20/);
});

// ===========================================================================
// Guard command asing
// ===========================================================================
test('guard: every signal command typed in the verification bot is redirected', async function () {
  const signals = ['/bandar', '/bd', '/foreign', '/ritel', '/tanya', '/opini', '/screener', '/status', '/analisa', '/scan', '/insider', '/broksum'];
  for (const [idx, command] of signals.entries()) {
    const bot = makeFakeBot();
    const db = makeAccountDb([]);
    const res = await tv.processWebhookUpdate(privateMessage(100 + idx, 42, command), { supabase: db, bot: bot });
    assert.equal(res.outcome, 'foreign_command', command + ' is refused');
    assert.equal(bot.calls.sendMessage.length, 1, command + ' produces exactly one reply');
    assert.equal(bot.calls.sendMessage[0].text, tv.FOREIGN_COMMAND_MESSAGE);
    assert.match(bot.calls.sendMessage[0].text, /khusus pendaftaran & akun/);
    assert.match(bot.calls.sendMessage[0].text, /Signal Saham Bot/);
    // No loading message, no code hashing path.
    assert.equal(bot.calls.editMessageText.length, 0);
  }
});

test('guard: a signal command with a @BotName suffix is still recognised', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  const res = await tv.processWebhookUpdate(
    privateMessage(200, 42, '/bandar@AutoCuanVerificationBot BBCA'),
    { supabase: db, bot: bot }
  );
  assert.equal(res.outcome, 'foreign_command');
});

test('guard: /help lists only account commands and points at the signal bot', async function () {
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  const res = await tv.processWebhookUpdate(privateMessage(9, 42, '/help'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'help');
  const text = bot.calls.sendMessage[0].text;
  assert.match(text, /\/daftar/);
  assert.match(text, /\/akun/);
  assert.match(text, /\/cek/);
  assert.doesNotMatch(text, /\/bandar/);
  assert.match(text, /Signal Saham Bot/);
});

test('guard: a valid verification code is still consumed after the command guard', async function () {
  // The command guard must not swallow a real code: a non-command token keeps
  // flowing into the hashing path (it just fails as an unknown code here).
  const bot = makeFakeBot();
  const db = makeAccountDb([]);
  const res = await tv.processWebhookUpdate(privateMessage(11, 42, 'ABCD2345'), { supabase: db, bot: bot });
  assert.notEqual(res.outcome, 'foreign_command');
  assert.equal(bot.calls.sendMessage[0].text, tv.MSG.loading);
});

// ===========================================================================
// Signal bot: gatekeeper guard + admin auto-delete
// ===========================================================================
function createCtx(overrides) {
  const sent = [];
  const deleted = [];
  const ctx = Object.assign({
    from: { id: 42, username: 'trader' },
    chat: { id: -100, type: 'supergroup' },
    message: { text: '' },
    sent,
    deleted,
    async reply(text, extra) {
      const message = { message_id: sent.length + 1, text, extra };
      sent.push(message);
      return message;
    },
    async deleteMessage(messageId) { deleted.push(messageId); return true; },
    telegram: {
      async sendMessage(chatId, text, extra) {
        const message = { message_id: 900 + sent.length, chatId, text, extra };
        sent.push(message);
        return message;
      },
      async editMessageText() { return true; },
      async deleteMessage() { return true; }
    },
    async answerCbQuery() {},
    async editMessageText() {}
  }, overrides || {});
  return ctx;
}

function memoryDb(initial) {
  const rows = new Map((initial || []).map((r) => [String(r.telegram_id), Object.assign({}, r)]));
  return {
    rows,
    from() {
      const api = {
        select() { return api; },
        eq() { return api; },
        then(resolve) { return api.maybeSingle().then(resolve); },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert(patch) {
          rows.set(String(patch.telegram_id), Object.assign({}, rows.get(String(patch.telegram_id)) || {}, patch));
          return { data: null, error: null };
        },
        delete() { return api; }
      };
      return api;
    }
  };
}

test('signal bot: every unverified market command yields ONLY the hold CTA with the deep link', async function () {
  const commands = ['/bandar BBCA', '/bd BBCA', '/foreign', '/ritel', '/tanya prospek', '/opini', '/screener daytrade', '/analisa BBCA'];
  for (const [idx, text] of commands.entries()) {
    const bot = createInteractiveBot({
      db: memoryDb([]),
      env: { ADMIN_TELEGRAM_ID: '7', VERIFY_BOT_USERNAME: 'AutoCuanVerificationBot' },
      delays: { denial: 15, result: 15, welcome: 15, vps: 15 }
    });
    const ctx = createCtx({ message: { text } });
    await bot.handleUpdate(ctx);
    assert.equal(ctx.sent.length, 1, text + ' → exactly one reply');
    assert.match(ctx.sent[0].text, /Akun Anda belum terverifikasi/, text);
    const button = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
    assert.equal(button.text, '🔐 Verifikasi Akses Sekarang', text);
    assert.equal(button.url, 'https://t.me/AutoCuanVerificationBot?start=verify_42', text);
    // The reply is auto-deleted in a group.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(ctx.deleted, [1], text + ' → hold message auto-deleted');
  }
});

test('signal bot: admin /status in a group is validated and auto-deleted after 60s', async function () {
  const bot = createInteractiveBot({
    db: memoryDb([]),
    env: { ADMIN_TELEGRAM_ID: '7' },
    delays: { denial: 20, result: 20, welcome: 20, vps: 30 },
    systemStatus() {
      return { uptimeSec: 10, ramUsedMb: 80, ramTotalMb: 4096, cpuLoad: 0.1, processes: [], wibTime: '2026-09-25 16:00 WIB' };
    }
  });
  // An unverified member typing an admin command gets nothing: admin commands are
  // never a gatekeeper CTA (they are not market commands either).
  const member = createCtx({ from: { id: 42 }, message: { text: '/status' } });
  await bot.handleUpdate(member);
  assert.equal(member.sent.length, 0, 'non-admin gets nothing');

  const admin = createCtx({ from: { id: 7 }, message: { text: '/status' } });
  await bot.handleUpdate(admin);
  assert.match(admin.sent[0].text, /Status VPS/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(admin.deleted, [1], 'admin group reply auto-deleted');
});

test('signal bot: /logs and /restart stay admin-private in a group', async function () {
  let restarted = 0;
  const bot = createInteractiveBot({
    db: memoryDb([]),
    env: { ADMIN_TELEGRAM_ID: '7' },
    delays: { denial: 15, result: 15, welcome: 15, vps: 15 },
    restartFn() { restarted += 1; return { ok: true }; }
  });

  const memberLogs = createCtx({ from: { id: 42 }, message: { text: '/logs' } });
  await bot.handleUpdate(memberLogs);
  assert.equal(memberLogs.sent.length, 0, 'non-admin /logs is silent');

  const adminLogs = createCtx({ from: { id: 7 }, message: { text: '/logs' } });
  await bot.handleUpdate(adminLogs);
  assert.equal(adminLogs.sent.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(adminLogs.deleted, [1], 'admin /logs auto-deleted in group');

  const memberRestart = createCtx({ from: { id: 42 }, message: { text: '/restart' } });
  await bot.handleUpdate(memberRestart);
  assert.equal(restarted, 0, 'non-admin cannot restart PM2');

  const adminRestart = createCtx({ from: { id: 7 }, message: { text: '/restart' } });
  await bot.handleUpdate(adminRestart);
  assert.equal(restarted, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(adminRestart.deleted, [1], 'admin /restart auto-deleted in group');
});

// ===========================================================================
// Source-level isolation contracts
// ===========================================================================
test('isolation: the signal bot advertises /opini and /screener and keeps the 60s admin TTL', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-interactive-bot.js'), 'utf8');
  assert.match(src, /'\/opini — Opini AI kondisi market hari ini\\n'/);
  assert.match(src, /'\/screener <daytrade\|swing\|top5> — Sama dengan \/scan\\n'/);
  assert.match(src, /const ADMIN_GROUP_TTL_MS = 60 \* 1000;/);
  assert.match(src, /'scan', 'screener', 'tanya', 'opini', 'foreign', 'ritel'/);
});

test('isolation: the verification lib owns no market command and never advertises one', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verification.js'), 'utf8');
  // The signal-command set exists ONLY as a refusal list.
  assert.match(src, /const SIGNAL_ONLY_COMMANDS = new Set\(\[/);
  assert.match(src, /FOREIGN_COMMAND_MESSAGE/);
  // No market command is ever offered as a bot capability in a keyboard.
  assert.doesNotMatch(src, /callback_data: '(bandar|analisa|scan|tanya|flow):/);
});

test('isolation: the register form deep link is the canonical /register.html URL', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verification.js'), 'utf8');
  // FASE 2: the ORIGIN is resolved at call time (lib/public-web-base.js) so the
  // bot keeps working while the Vercel deployment is paused; the PATH remains the
  // canonical /register.html contract.
  assert.match(src, /const REGISTER_FORM_PATH = '\/register\.html';/);
  assert.match(src, /publicWebBase\.getPublicWebBase\(\)/);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'register.html'), 'utf8');
  assert.match(html, /params\.get\('user_id'\)/);
  assert.match(html, /action=mint-token/);
});

test('isolation: public web base falls back to the canonical domain and rejects bad overrides', function () {
  const webBase = require('../lib/public-web-base');
  // A malformed or non-https override must never reach a Telegram button.
  assert.equal(webBase.normalizeBaseUrl('http://autocuan.web.id'), null);
  assert.equal(webBase.normalizeBaseUrl('not a url'), null);
  assert.equal(webBase.normalizeBaseUrl(''), null);
  assert.equal(webBase.normalizeBaseUrl('https://a.trycloudflare.com/'), 'https://a.trycloudflare.com');
  // No override + no tunnel file -> canonical domain (previous behaviour).
  webBase.clearCache();
  const resolved = webBase.resolvePublicWebBase({}, { bypassCache: true });
  assert.equal(resolved.base_url, webBase.CANONICAL_BASE_URL);
  assert.equal(resolved.source, 'canonical');
  // An explicit override wins.
  const overridden = webBase.resolvePublicWebBase(
    { PUBLIC_WEB_BASE_URL: 'https://live.trycloudflare.com' },
    { bypassCache: true }
  );
  assert.equal(overridden.base_url, 'https://live.trycloudflare.com');
  assert.equal(overridden.source, 'env:PUBLIC_WEB_BASE_URL');
  webBase.clearCache();
});

test('isolation: the VPS local server serves /register like the Vercel rewrite', function () {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');
  assert.match(src, /'\/register': '\/register\.html'/);
});

test('hybrid: the AI evaluator falls back on 402/503/timeout and never throws', function () {
  const evaluator = require('../lib/ai-evaluator');
  for (const status of [402, 503, 500, 502, 504]) {
    assert.equal(evaluator.shouldFallback(status, 'http_error'), true, 'status ' + status + ' falls back');
  }
  assert.equal(evaluator.shouldFallback(0, 'timeout'), true);
  assert.equal(evaluator.shouldFallback(0, 'network_error'), true);
  // Caller errors must NOT be retried on the fallback.
  assert.equal(evaluator.shouldFallback(400, 'http_error'), false);
  assert.equal(evaluator.shouldFallback(401, 'http_error'), false);
  assert.equal(evaluator.shouldFallback(403, 'http_error'), false);
});

test('hybrid: evaluate() returns a result object instead of throwing on total failure', async function () {
  const evaluator = require('../lib/ai-evaluator');
  const result = await evaluator.evaluate('test prompt', {
    env: {
      AI_EVAL_PRIMARY_URL: 'https://primary.invalid/api/analyze',
      AI_EVAL_FALLBACK_URL: 'http://127.0.0.1:1/api/ai-eval'
    },
    fetchFn: async function () { throw new Error('boom'); },
    primaryTimeoutMs: 50,
    fallbackTimeoutMs: 50
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2, 'primary then fallback');
  assert.ok(result.code);
});

test('hybrid: evaluate() succeeds on the fallback when the primary times out', async function () {
  const evaluator = require('../lib/ai-evaluator');
  const seen = [];
  const result = await evaluator.evaluate('test prompt', {
    env: { AI_EVAL_PRIMARY_URL: 'https://primary/api', AI_EVAL_FALLBACK_URL: 'http://vps/api/ai-eval' },
    primaryTimeoutMs: 50,
    fallbackTimeoutMs: 50,
    fetchFn: async function (url) {
      seen.push(url);
      if (url.indexOf('primary') !== -1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        ok: true,
        status: 200,
        text: async function () { return JSON.stringify({ text: 'fallback answer' }); }
      };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'vps');
  assert.equal(result.text, 'fallback answer');
  assert.deepEqual(seen, ['https://primary/api', 'http://vps/api/ai-eval']);
});

test('hybrid: evaluateWithPrimary falls back only on an unavailable primary', async function () {
  const evaluator = require('../lib/ai-evaluator');
  let fallbackCalled = 0;
  const result = await evaluator.evaluateWithPrimary(
    async function () { return { ok: false, code: 'network_error', status: 0 }; },
    'prompt',
    {
      env: { AI_EVAL_FALLBACK_URL: 'http://vps/api/ai-eval' },
      fallbackTimeoutMs: 50,
      fetchFn: async function () {
        fallbackCalled += 1;
        return { ok: true, status: 200, text: async function () { return JSON.stringify({ answer: 'vps answer' }); } };
      }
    }
  );
  assert.equal(fallbackCalled, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'vps');
  assert.equal(result.text, 'vps answer');
});

test('hybrid: switch-verify-webhook only ever selects a public VPS origin', async function () {
  const sw = require('../tools/switch-verify-webhook');
  // The tunnel resolver is injected so the assertions are identical on a laptop
  // and on the VPS (where a live cloudflared tunnel file legitimately wins).
  const noTunnel = async function () { return null; };
  const liveTunnel = async function () { return 'https://live-tunnel.trycloudflare.com/api/reset-password?action=telegram-verify-webhook-v3'; };

  // An explicit public URL always wins and is returned verbatim.
  assert.equal(
    await sw.resolveVpsPublicUrl({ VPS_WEBHOOK_URL: 'https://tunnel.example/api/reset-password?action=telegram-verify-webhook-v3' }, noTunnel),
    'https://tunnel.example/api/reset-password?action=telegram-verify-webhook-v3'
  );
  // A discovered tunnel origin is used when no explicit URL is configured.
  assert.equal(
    await sw.resolveVpsPublicUrl({}, liveTunnel),
    'https://live-tunnel.trycloudflare.com/api/reset-password?action=telegram-verify-webhook-v3'
  );
  // A derived origin is built from an explicitly configured public app base.
  assert.equal(
    await sw.resolveVpsPublicUrl({ VPS_PUBLIC_BASE_URL: 'https://vps.example/' }, noTunnel),
    'https://vps.example/api/reset-password?action=telegram-verify-webhook-v3'
  );
  // A bare localhost base is never promoted to a webhook target.
  assert.equal(
    await sw.resolveVpsPublicUrl({ APP_BASE_URL: 'http://127.0.0.1:3000' }, noTunnel),
    null,
    'a localhost base must never become a webhook target'
  );
  // Nothing configured anywhere → fail closed (no failover target).
  assert.equal(await sw.resolveVpsPublicUrl({}, noTunnel), null);
  // A throwing resolver must not break the derivation chain.
  const throwing = async function () { throw new Error('boom'); };
  assert.equal(
    await sw.resolveVpsPublicUrl({ VPS_PUBLIC_BASE_URL: 'https://vps.example' }, throwing),
    'https://vps.example/api/reset-password?action=telegram-verify-webhook-v3'
  );

  assert.equal(sw.DEFAULT_VERCEL_URL, 'https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3');
  assert.equal(sw.VALID_TARGETS.has('vercel'), true);
  assert.equal(sw.VALID_TARGETS.has('vps'), true);
  assert.equal(sw.VALID_TARGETS.has('auto'), true);
});

test('hybrid: the sector-hot runner is Vercel-first with a local fallback', function () {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-sector-hot.sh'), 'utf8');
  assert.match(src, /SECTOR_HOT_VERCEL_URL/);
  assert.match(src, /run-screener\.js/);
  assert.match(src, /VERCEL_CODE" = "200"/);
  const cron = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');
  assert.match(cron, /run-sector-hot\.sh/);
  assert.match(cron, /run-webhook-failover\.sh/);
});

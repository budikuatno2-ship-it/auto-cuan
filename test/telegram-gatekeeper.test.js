'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createInteractiveBot } = require('../lib/telegram-interactive-bot');
const registerToken = require('../lib/telegram-register-token');
const botRegister = require('../api/bot-register');

function memoryDb(initial) {
  const rows = new Map((initial || []).map((row) => [String(row.telegram_id), Object.assign({}, row)]));
  const credentials = new Map();
  function matches(row, filters) {
    return filters.every(([column, value]) => String(row[column]) === value);
  }
  return {
    rows,
    from(table) {
      const filters = [];
      const api = {
        select() { return api; },
        eq(column, value) { filters.push([column, String(value)]); return api; },
        then(resolve, reject) { return api.maybeSingle().then(resolve, reject); },
        async maybeSingle() {
          const source = table === 'user_ai_credentials' ? credentials.values() : rows.values();
          for (const row of source) if (matches(row, filters)) return { data: Object.assign({}, row), error: null };
          return { data: null, error: null };
        },
        async insert(patch) {
          if (table === 'bot_registration_tokens') return { data: patch, error: null };
          return { data: patch, error: null };
        },
        async upsert(patch) {
          const id = String(patch.telegram_id);
          rows.set(id, Object.assign({}, rows.get(id) || {}, patch));
          return { data: rows.get(id), error: null };
        },
        update(patch) {
          return { eq() { return Promise.resolve({ data: patch, error: null }); } };
        },
        delete() { return api; }
      };
      return api;
    }
  };
}

function createCtx(overrides) {
  const sent = [];
  const edits = [];
  const callbacks = [];
  const ctx = Object.assign({
    from: { id: 42, username: 'trader' },
    chat: { id: 42, type: 'private' },
    message: { text: '' },
    sent,
    edits,
    callbacks,
    async reply(text, extra) {
      const message = { message_id: sent.length + 1, text, extra };
      sent.push(message);
      return message;
    },
    async deleteMessage() { return true; },
    telegram: {
      async sendMessage(chatId, text, extra) {
        const message = { message_id: 900 + sent.length, chatId, text, extra };
        sent.push(message);
        return message;
      },
      async editMessageText(chatId, messageId, _unused, text, extra) {
        edits.push({ chatId, messageId, text, extra });
        return true;
      },
      async deleteMessage() { return true; }
    },
    async answerCbQuery(text) { callbacks.push(text); },
    async editMessageText(text, extra) {
      edits.push({ chatId: ctx.chat && ctx.chat.id, text, extra });
    }
  }, overrides || {});
  return ctx;
}

function botWith(db, env) {
  return createInteractiveBot({
    db,
    env: env || { ADMIN_TELEGRAM_ID: '7', VERIFY_BOT_USERNAME: 'AutoCuanVerificationBot' },
    delays: { denial: 20, result: 20, welcome: 20, vps: 20 },
    skipProbe: true
  });
}

test('gatekeeper: unverified group /start shows the hold CTA and no commands', async () => {
  const bot = botWith(memoryDb([]));
  const ctx = createCtx({ chat: { id: -100, type: 'supergroup' }, message: { text: '/start' } });
  await bot.handleUpdate(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Akun Anda belum terverifikasi/);
  assert.doesNotMatch(ctx.sent[0].text, /\/analisa/);
  const button = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🔐 Verifikasi Akses Sekarang');
  assert.equal(button.url, 'https://t.me/AutoCuanVerificationBot?start=verify_42');
});

test('gatekeeper: active user gets the full guide including /bandar', async () => {
  const db = memoryDb([{ telegram_id: '42', status: 'active', provider: 'gemini', daily_limit: 15 }]);
  const bot = botWith(db);
  const ctx = createCtx({ message: { text: '/start' } });
  await bot.handleUpdate(ctx);
  const text = ctx.sent[0].text;
  assert.match(text, /Status Akun & BYOK/);
  assert.match(text, /\/bandar <KODE_SAHAM>/);
  assert.match(text, /\/foreign — Top 10 Foreign Flow/);
  assert.match(text, /Hasil analisa di grup akan otomatis dihapus setelah 5 menit/);
});

test('gatekeeper: verify deep-link issues a one-time registration URL', async () => {
  const bot = botWith(memoryDb([]));
  const ctx = createCtx({
    message: { text: '/start verify_42' },
    startPayload: 'verify_42'
  });
  await bot.handleUpdate(ctx);
  const button = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '📝 Buka Formulir Pendaftaran');
  assert.match(button.url, /^https:\/\/autocuan\.web\.id\/register\?token=/);
});

test('gatekeeper: verify deep-link for an active user without gmail asks to complete email', async () => {
  const db = memoryDb([{ telegram_id: '42', status: 'active', username: 'trader' }]);
  const bot = botWith(db);
  const ctx = createCtx({ message: { text: '/start verify_42' }, startPayload: 'verify_42' });
  await bot.handleUpdate(ctx);
  assert.match(ctx.sent[0].text, /email Gmail belum lengkap/);
});

test('approval moves the user to active and triggers the BYOK wizard', async () => {
  const db = memoryDb([{ telegram_id: '42', status: 'pending', username: 'trader' }]);
  const bot = botWith(db, { ADMIN_TELEGRAM_ID: '7', VERIFY_BOT_USERNAME: 'AutoCuanVerificationBot' });
  const admin = createCtx({
    from: { id: 7, username: 'admin' },
    chat: { id: 7, type: 'private' },
    callbackQuery: { id: 'cb', data: 'approve:42', message: { message_id: 3 } }
  });
  await bot.handleUpdate(admin);
  assert.equal(db.rows.get('42').status, 'active');
  const wizard = admin.sent.find((m) => m.chatId === '42' || m.chatId === 42);
  assert.ok(wizard, 'member must receive the BYOK wizard');
  const provider = wizard.extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data);
  assert.deepEqual(provider, ['byok:gemini', 'byok:openai']);
});

test('one-time registration token is single-use and expires', async () => {
  registerToken.clearMemoryStoreForTesting();
  let now = 1000;
  const token = await registerToken.issueToken(null, '42', { ttlMs: 1000, now: () => now });
  const first = await registerToken.consumeToken(null, token, { now: () => now });
  assert.equal(first.ok, true);
  const second = await registerToken.consumeToken(null, token, { now: () => now });
  assert.equal(second.ok, false);

  const fresh = await registerToken.issueToken(null, '7', { ttlMs: 1000, now: () => now });
  now += 2000;
  const expired = await registerToken.consumeToken(null, fresh, { now: () => now });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
});

test('register endpoint rejects invalid Gmail and burns a valid token', async () => {
  registerToken.clearMemoryStoreForTesting();
  const token = await registerToken.issueToken(null, '42');

  function mockRes() {
    return {
      statusCode: 0,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };
  }

  const badReq = { method: 'POST', body: { token, name: 'Budi', email: 'budi@yahoo.com' }, headers: {} };
  const badRes = mockRes();
  await botRegister(badReq, badRes);
  assert.equal(badRes.statusCode, 400);
  assert.match(badRes.body.error, /Gmail/);

  // The token must NOT be consumed by a validation failure.
  const okReq = { method: 'POST', body: { token, name: 'Budi Santoso', email: 'budi@gmail.com' }, headers: {} };
  const okRes = mockRes();
  await botRegister(okReq, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.success, true);

  // Replay is rejected.
  const replayRes = mockRes();
  await botRegister({ method: 'POST', body: { token, name: 'Budi', email: 'budi@gmail.com' }, headers: {} }, replayRes);
  assert.equal(replayRes.statusCode, 400);
  assert.equal(replayRes.body.code, 'TOKEN_INVALID');
});

test('bandar command renders CR3/CR5 from the local broker snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-bandar-cmd-'));
  const brokerDir = path.join(root, 'data', 'arjum-data', 'broker-summary', 'BBCA');
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.writeFileSync(path.join(brokerDir, '2026-09-24.json'), JSON.stringify({
    brokers: [
      { broker_code: 'BK', bname: 'J.P. Morgan', bval: 500000000000, bvol: 50000000, sval: 100000000000, nval: 400000000000 },
      { broker_code: 'AK', bval: 300000000000, bvol: 30000000, sval: 0, nval: 300000000000 },
      { broker_code: 'YP', bval: 0, sval: 200000000000, nval: -200000000000 }
    ]
  }));
  const db = memoryDb([{ telegram_id: '42', status: 'active', provider: 'gemini', daily_limit: 15 }]);
  const bot = createInteractiveBot({
    db, rootDir: root,
    env: { ADMIN_TELEGRAM_ID: '7' },
    credentials: {
      async getUserApiKey() { return { hasKey: true, apiKey: 'AIzaSyTestKey123456789012345678901234567', maskedKey: 'x' }; }
    },
    skipProbe: true
  });
  const ctx = createCtx({ chat: { id: -100, type: 'supergroup' }, message: { text: '/bandar BBCA' } });
  await bot.handleUpdate(ctx);
  const card = ctx.edits.at(-1).text;
  assert.match(card, /Bandarmologi BBCA/);
  assert.match(card, /CR3/);
  assert.match(card, /CR5/);
  assert.deepEqual(
    ctx.edits.at(-1).extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    ['bandar:BBCA:1', 'bandar:BBCA:7', 'bandar:BBCA:30']
  );
});

test('expired BYOK session asks the member to refresh', async () => {
  const db = memoryDb([{ telegram_id: '42', status: 'active', provider: 'gemini', daily_limit: 15 }]);
  let now = 1000;
  const bot = createInteractiveBot({
    db,
    env: { ADMIN_TELEGRAM_ID: '7', VERIFY_BOT_USERNAME: 'AutoCuanVerificationBot' },
    now: () => now,
    delays: { denial: 20, result: 20, welcome: 20 },
    credentials: {
      async getUserApiKey() { return { hasKey: true, apiKey: 'AIzaSyTestKey123456789012345678901234567', maskedKey: 'x' }; }
    },
    gemini: {
      async generateGeminiContent() { return { text: 'Opini AI mock' }; }
    },
    skipProbe: true
  });
  // Open a session, then jump past the 6-hour TTL.
  const fistCtx = createCtx({ message: { text: '/start' } });
  await bot.handleUpdate(fistCtx);
  now += bot.constants.KEY_SESSION_TTL_MS + 1;

  const ctx = createCtx({ chat: { id: -100, type: 'supergroup' }, message: { text: '/analisa BBCA' } });
  await bot.handleUpdate(ctx);
  assert.match(ctx.sent[0].text, /Sesi API Key Anda telah berakhir/);
  const button = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🔄 Refresh Sesi Kunci');
  assert.match(button.url, /start=refresh_42$/);
});

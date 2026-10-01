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


function durableTokenDb() {
  const tokens = new Map();
  return {
    tokens,
    from(table) {
      const filters = [];
      const api = {
        select() { return api; },
        eq(column, value) { filters.push([column, String(value)]); return api; },
        async maybeSingle() {
          if (table !== 'bot_registration_tokens') return { data: null, error: null };
          for (const row of tokens.values()) {
            if (filters.every(([column, value]) => String(row[column]) === value)) return { data: Object.assign({}, row), error: null };
          }
          return { data: null, error: null };
        },
        async insert(row) {
          if (table === 'bot_registration_tokens') tokens.set(String(row.token), Object.assign({}, row));
          return { data: row, error: null };
        },
        update(patch) {
          const chain = {
            eq(column, value) { filters.push([column, String(value)]); return chain; },
            select() { return chain; },
            async maybeSingle() {
              if (table !== 'bot_registration_tokens') return { data: null, error: null };
              for (const row of tokens.values()) {
                if (!filters.every(([column, value]) => String(row[column]) === value)) continue;
                Object.assign(row, patch);
                return { data: Object.assign({}, row), error: null };
              }
              return { data: null, error: null };
            },
            then(resolve, reject) { return chain.maybeSingle().then((result) => resolve({ data: result.data, error: result.error }), reject); }
          };
          return chain;
        }
      };
      return api;
    }
  };
}

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
test('registration token issued by the bot survives a process restart for two hours', async () => {
  registerToken.clearMemoryStoreForTesting();
  const durable = durableTokenDb();
  const now = 1700000000000;
  const issuer = createInteractiveBot({
    db: durable,
    env: { ADMIN_TELEGRAM_ID: '7' },
    now: () => now,
    registerTokenStore: registerToken,
    skipProbe: true
  });
  const token = await issuer.issueRegistrationToken('42');
  assert.equal(issuer.constants.REGISTER_TTL_MS, 2 * 60 * 60 * 1000);
  registerToken.clearMemoryStoreForTesting();
  const restarted = createInteractiveBot({
    db: durable,
    env: { ADMIN_TELEGRAM_ID: '7' },
    now: () => now + 90 * 60 * 1000,
    registerTokenStore: registerToken,
    skipProbe: true
  });
  const consumed = await restarted.consumeRegistrationToken(token);
  assert.equal(consumed.ok, true);
  assert.equal(consumed.telegramId, '42');
});

test('verify bot: verified /start shows the account summary and web screener, never the registration form', async () => {
  const tv = require('../lib/telegram-verification');
  const bot = {
    sent: [],
    sendMessage: async (chatId, text, options) => {
      bot.sent.push({ chatId, text, options });
      return { message_id: 1 };
    }
  };
  const db = {
    from: (table) => ({
      select: () => ({
        eq: (col, val) => ({
          maybeSingle: async () => {
            if (table === 'bot_users' && String(val) === '42') {
              return {
                data: {
                  telegram_id: '42', username: 'budi', full_name: 'Budi Santoso',
                  status: 'active', gmail: 'budi@gmail.com',
                  subscription_status: 'Premium aktif sampai 2026-12-31',
                  channel_access: 'Aktif'
                },
                error: null
              };
            }
            return { data: null, error: null };
          }
        })
      })
    }),
    rpc: (name) => {
      if (name === 'claim_telegram_webhook_update') return Promise.resolve({ data: [{ claim_state: 'claimed', processing_token: 'tok' }], error: null });
      if (name === 'complete_telegram_webhook_update') return Promise.resolve({ data: [true], error: null });
      return Promise.resolve({ data: null, error: null });
    }
  };
  const update = {
    update_id: 101,
    message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start' }
  };
  const res = await tv.processWebhookUpdate(update, { supabase: db, bot });
  assert.equal(res.outcome, 'start_verified');
  assert.equal(bot.sent.length, 1);
  const text = bot.sent[0].text;
  assert.match(text, /Username:\s*budi/);
  assert.match(text, /Status:\s*Disetujui/);
  assert.match(text, /Akses Channel:\s*Aktif/);
  assert.match(text, /Subscription:\s*Premium aktif sampai 2026-12-31/);
  assert.doesNotMatch(text, /Formulir Pendaftaran|mendaftar|\/daftar/i);
  const button = bot.sent[0].options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🌐 Buka Web Screener');
  assert.match(button.url, /^https?:\/\//);
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
  const okReq = { method: 'POST', body: { token, name: 'Budi Santoso', email: 'budi@gmail.com', password: 'rahasia-aman' }, headers: {} };
  const okRes = mockRes();
  await botRegister(okReq, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.success, true);

  // Replay is rejected.
  const replayRes = mockRes();
  await botRegister({ method: 'POST', body: { token, name: 'Budi', email: 'budi@gmail.com', password: 'rahasia-aman' }, headers: {} }, replayRes);
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

test('expired BYOK session remains active (persistent BYOK, no auto-expire)', async () => {
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
  // Open a session, then jump past the old 6-hour TTL — with persistent BYOK it should still be active.
  const fistCtx = createCtx({ message: { text: '/start' } });
  await bot.handleUpdate(fistCtx);
  now += bot.constants.KEY_SESSION_TTL_MS + 1;

  const ctx = createCtx({ chat: { id: -100, type: 'supergroup' }, message: { text: '/analisa BBCA' } });
  await bot.handleUpdate(ctx);
  // Persistent BYOK: no refresh prompt, command should proceed (progress edits)
  const hasRefreshPrompt = ctx.sent.some(m => /Sesi API Key Anda telah berakhir|Refresh Sesi Kunci/.test(m.text || ''));
  assert.equal(hasRefreshPrompt, false, 'persistent BYOK should not send refresh prompt');
  assert.ok(ctx.edits.length > 0, 'should proceed to analysis');
});

test('new registration stores a protected password hash and notifies the admin', async () => {
  registerToken.clearMemoryStoreForTesting();
  const durable = durableTokenDb();
  const users = memoryDb([]);
  const db = {
    rows: users.rows,
    from(table) { return table === 'bot_registration_tokens' ? durable.from(table) : users.from(table); }
  };
  const now = Date.now();
  const issuer = createInteractiveBot({ db, env: { ADMIN_TELEGRAM_ID: '7' }, now: () => now, registerTokenStore: registerToken, skipProbe: true });
  const token = await issuer.issueRegistrationToken('4242');
  const adminMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    adminMessages.push(body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  process.env.ADMIN_TELEGRAM_ID = '7';
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = '123456:test-verify-token';
  const passwordHash = 'a'.repeat(64);
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  try {
    await botRegister({ method: 'POST', supabase: db, body: { token, user_id: '4242', name: 'Sari Baru', email: 'sari.baru@gmail.com', password: 'rahasia-aman', passwordHash }, headers: {} }, res);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /Pendaftaran berhasil dikirim/);
  const saved = users.rows.get('4242');
  assert.equal(saved.full_name, 'Sari Baru');
  assert.equal(saved.gmail, 'sari.baru@gmail.com');
  assert.equal(saved.status, 'pending');
  assert.match(saved.password_hash, /^k1[a-f0-9]{62}$/i);
  assert.notEqual(saved.password_hash, passwordHash);
  assert.equal(adminMessages.length, 1);
  assert.equal(String(adminMessages[0].chat_id), '7');
  assert.match(adminMessages[0].text, /Pendaftaran Akun Baru Masuk/);
  assert.match(adminMessages[0].text, /Sari Baru/);
  assert.match(adminMessages[0].text, /sari\.baru@gmail\.com/);
  assert.match(adminMessages[0].text, /4242/);
  assert.match(adminMessages[0].text, /\/approve_4242/);
  assert.doesNotMatch(adminMessages[0].text, /rahasia-aman|password_hash/);
});

test('expired registration token returns the friendly browser message', async () => {
  registerToken.clearMemoryStoreForTesting();
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  await botRegister({ method: 'POST', body: { token: 'missing-token', name: 'Sari Baru', email: 'sari.baru@gmail.com', password: 'rahasia-aman', passwordHash: 'b'.repeat(64) }, headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Token pendaftaran tidak valid atau sudah kedaluwarsa. Silakan ketik /start di bot Telegram untuk mendapatkan tautan baru.');
});

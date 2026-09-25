'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  createInteractiveBot,
  loadRuntimeEnv,
  PROGRESS_STEPS
} = require('../lib/telegram-interactive-bot');

function mockCredentials() {
  const store = new Map();
  return {
    store,
    saveUserApiKey(_db, userId, apiKey, provider = 'gemini') {
      store.set(String(userId) + ':' + provider, { apiKey, maskedKey: '****' + String(apiKey).slice(-4) });
      return Promise.resolve({ ok: true, maskedKey: '****' + String(apiKey).slice(-4) });
    },
    getUserApiKey(_db, userId, provider = 'gemini') {
      const record = store.get(String(userId) + ':' + provider);
      return record
        ? Promise.resolve({ hasKey: true, apiKey: record.apiKey, maskedKey: record.maskedKey })
        : Promise.resolve({ hasKey: false, apiKey: null, maskedKey: null });
    },
    deleteUserApiKey(_db, userId, provider = 'gemini') {
      store.delete(String(userId) + ':' + provider);
      return Promise.resolve({ ok: true });
    }
  };
}

test.beforeEach(() => {
  try { require('../lib/user-ai-credentials').clearMemoryStoreForTesting(); } catch (_) {}
});

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
        eq(column, value) {
          filters.push([column, String(value)]);
          return api;
        },
        then(resolve, reject) {
          return api.maybeSingle().then(resolve, reject);
        },
        async maybeSingle() {
          const source = table === 'user_ai_credentials' ? credentials.values() : rows.values();
          for (const row of source) {
            if (matches(row, filters)) return { data: Object.assign({}, row), error: null };
          }
          return { data: null, error: null };
        },
        async upsert(patch) {
          if (table === 'user_ai_credentials') {
            const key = patch.user_id + ':' + patch.provider;
            credentials.set(key, Object.assign({}, credentials.get(key) || {}, patch));
            return { data: credentials.get(key), error: null };
          }
          const id = String(patch.telegram_id);
          rows.set(id, Object.assign({}, rows.get(id) || {}, patch));
          return { data: rows.get(id), error: null };
        },
        update(patch) {
          return {
            eq(column, value) {
              const source = table === 'user_ai_credentials' ? credentials : rows;
              for (const [key, row] of source) {
                if (String(row[column]) === String(value)) {
                  source.set(key, Object.assign({}, row, patch));
                  return Promise.resolve({ data: source.get(key), error: null });
                }
              }
              return Promise.resolve({ data: null, error: null });
            }
          };
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
  const deleted = [];
  const callbacks = [];
  const ctx = Object.assign({
    from: { id: 42, username: 'trader' },
    chat: { id: -100, type: 'supergroup' },
    message: { text: '' },
    sent,
    edits,
    deleted,
    callbacks,
    async reply(text, extra) {
      const message = { message_id: sent.length + 1, text, extra };
      sent.push(message);
      return message;
    },
    async deleteMessage(messageId) {
      deleted.push(messageId);
      return true;
    },
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
      async deleteMessage(chatId, messageId) {
        deleted.push([chatId, messageId]);
        return true;
      }
    },
    async answerCbQuery(text) {
      callbacks.push(text);
    },
    async editMessageText(text, extra) {
      const message = ctx.callbackQuery && ctx.callbackQuery.message;
      edits.push({
        chatId: ctx.chat && ctx.chat.id,
        messageId: message && message.message_id,
        text,
        extra
      });
    }
  }, overrides || {});
  return ctx;
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-bot-'));
  const candleDir = path.join(root, 'data', 'daily-candles');
  const brokerDir = path.join(root, 'data', 'arjum-data', 'broker-summary', 'BBCA');
  fs.mkdirSync(candleDir, { recursive: true });
  fs.mkdirSync(brokerDir, { recursive: true });
  fs.writeFileSync(path.join(candleDir, 'BBCA.json'), JSON.stringify({
    candles: [
      { date: '2026-09-22', open: 100, high: 110, low: 95, close: 100, volume: 1000 },
      { date: '2026-09-23', open: 100, high: 120, low: 99, close: 110, volume: 2000 },
      { date: '2026-09-24', open: 110, high: 130, low: 108, close: 120, volume: 3000 }
    ]
  }));
  fs.writeFileSync(path.join(brokerDir, '2026-09-24.json'), JSON.stringify({
    brokers: [
      { broker_code: 'YP', nval: 1500000000, investor_type: 'foreign' },
      { broker_code: 'CC', nval: -500000000, investor_type: 'local' }
    ]
  }));
  const insider = path.join(root, 'data', 'insider-network');
  fs.mkdirSync(insider, { recursive: true });
  fs.writeFileSync(path.join(insider, 'roster.json'), JSON.stringify({
    tickers: { BBCA: [{ name: 'Tester', percentage_formatted: '1%', category: 'Direktur' }] }
  }));
  fs.writeFileSync(path.join(insider, 'network.json'), JSON.stringify({ networks_by_ticker: {} }));
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [{ ticker: 'BBCA', score: 80 }],
    swing: [],
    top5: [{ ticker: 'BBCA', fusion_score: 77 }]
  }));
  return root;
}

test('pending group command returns the verification bot link and schedules deletion', async () => {
  const db = memoryDb([]);
  const bot = createInteractiveBot({
    db,
    env: { ADMIN_TELEGRAM_ID: '7', VERIFY_BOT_USERNAME: 'AutoCuanVerificationBot' },
    delays: { denial: 20, result: 20, welcome: 20 }
  });
  const ctx = createCtx({ message: { text: '/analisa BBCA' } });
  await bot.handleUpdate(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].text, 'Akses Belum Terverifikasi');
  const button = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, 'Verifikasi akses');
  assert.equal(button.url, 'https://t.me/AutoCuanVerificationBot?start=verify_42');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(ctx.deleted, [1]);
});

test('start guide shows quota, real examples, and the five-minute privacy note', async () => {
  const today = new Date(Date.now() + (7 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  const db = memoryDb([{
    telegram_id: '42',
    status: 'approved',
    provider: 'gemini',
    daily_usage: 4,
    daily_limit: 15,
    last_usage_date: today
  }]);
  const bot = createInteractiveBot({
    db,
    env: {}
  });
  const ctx = createCtx({
    chat: { id: 42, type: 'private' },
    message: { text: '/start' },
    startPayload: ''
  });
  await bot.handleUpdate(ctx);
  const text = ctx.sent[0].text;
  assert.match(text, /Status Akun & BYOK/);
  assert.match(text, /Sisa Kuota Hari Ini: 11\/15 \(Reset 00:00 WIB\)/);
  assert.match(text, /\/analisa <KODE_SAHAM> — Analisa chart \+ bandar flow \(Contoh: \/analisa BBCA\)/);
  assert.match(text, /\/broksum <KODE_SAHAM> — Rangkuman broker asing \(Contoh: \/broksum BBRI\)/);
  assert.match(text, /\/insider <KODE_SAHAM> — Jaringan kepemilikan orang dalam \(Contoh: \/insider BREN\)/);
  assert.match(text, /\/scan <daytrade\|swing\|top5> — Screener saham otomatis \(Contoh: \/scan daytrade\)/);
  assert.match(text, /\/tanya <pertanyaan> — Tanya AI seputar market \(Contoh: \/tanya prospek IHSG\)/);
  assert.match(text, /Hasil analisa di grup akan otomatis dihapus setelah 5 menit demi privasi\./);
  assert.doesNotMatch(text, /\[TANGGAL\]/);
});

test('verification token cannot be replayed', () => {
  let now = 1_000;
  const bot = createInteractiveBot({ db: memoryDb([]), env: {}, now: () => now });
  const token = bot.issueVerifyToken(42);
  assert.equal(bot.consumeVerifyToken(token, 42).ok, true);
  assert.equal(bot.consumeVerifyToken(token, 42).ok, false);
  const second = bot.issueVerifyToken(42);
  now += bot.constants.VERIFY_TTL_MS + 1;
  assert.equal(bot.consumeVerifyToken(second, 42).ok, false);
});

// Health-check is skipped in test mode via skipProbe option.
test('registration notifies only the admin and approval is admin-private', async () => {
  const mock = mockCredentials();
  const db = memoryDb([]);
  const env = { ADMIN_TELEGRAM_ID: '7', BOT_GROUP_ID: '-100' };
  const bot = createInteractiveBot({ db, env, delays: { denial: 20, result: 20, welcome: 20 }, credentials: mock, skipProbe: true });
  const ctx = createCtx({
    chat: { id: 42, type: 'private' },
    message: { text: 'trader@gmail.com\nGEMINI AIzaSyTestKeyForBotUser123456' }
  });
  await bot.handleUpdate(ctx);
  // First sent message is the credential deletion confirmation.
  const confirmMsg = ctx.sent.find((message) => message.text && message.text.includes('Kunci AI berhasil disimpan'));
  assert.ok(confirmMsg, 'Credential storage confirmation should be sent');
  // Then admin notification should be sent.
  const adminMessage = ctx.sent.find((message) => String(message.chatId) === '7');
  assert.ok(adminMessage);
  assert.match(adminMessage.text, /trader@gmail\.com/);
  assert.doesNotMatch(adminMessage.text, /AIza/);
  assert.equal(ctx.sent.some((message) => String(message.chatId) === '-100'), false);

  mock.store.set('42:gemini', { apiKey: 'AIzaSyTestKeyForBotUser123456', maskedKey: '****3456' });
  const stranger = createCtx({
    from: { id: 99 },
    chat: { id: -100, type: 'supergroup' },
    callbackQuery: { data: 'approve:42', id: 'cb1' }
  });
  await bot.handleUpdate(stranger);
  assert.equal(stranger.callbacks[0], 'Tidak diizinkan.');
  assert.equal(db.rows.get('42').status, 'pending');

  const admin = createCtx({
    from: { id: 7, username: 'admin' },
    chat: { id: 7, type: 'private' },
    callbackQuery: { data: 'approve:42', id: 'cb2', message: { message_id: 5 } }
  });
  await bot.handleUpdate(admin);
  assert.equal(db.rows.get('42').status, 'approved');
  assert.equal(admin.edits[0].text, '✅ Disetujui oleh Admin');
  const welcome = admin.sent.find((message) => String(message.chatId) === '-100');
  assert.ok(welcome);
  assert.match(welcome.text, /Selamat bergabung @trader/);
});

test('approved analysis uses progress edits, local data, and a one-time webview', async () => {
  const root = fixtureRoot();
  const db = memoryDb([{ telegram_id: '42', status: 'approved', provider: 'gemini', username: 'trader' }]);
  const mock = mockCredentials();
  mock.store.set('42:gemini', { apiKey: 'AIzaSyTestKeyForBotUser123456', maskedKey: '****3456' });
  const prompts = [];
  const bot = createInteractiveBot({
    db,
    rootDir: root,
    env: { ADMIN_TELEGRAM_ID: '7', BOT_PUBLIC_BASE_URL: 'http://127.0.0.1:9' },
    delays: { denial: 20, result: 20, welcome: 20 },
    credentials: mock,
    gemini: {
      async generateGeminiContent(options) {
        prompts.push(options.prompt);
        assert.equal(options.apiKey, 'AIzaSyTestKeyForBotUser123456');
        return { text: 'Kesimpulan lokal.' };
      }
    }
  });
  const ctx = createCtx({ message: { text: '/analisa BBCA' } });
  await bot.handleUpdate(ctx);
  assert.deepEqual(ctx.edits.map((edit) => edit.text).slice(0, 2), [
    '60% Menghitung flow dan teknikal...',
    '100% Menyusun kesimpulan final...'
  ]);
  const finalEdit = ctx.edits.at(-1);
  const finalText = finalEdit.text;
  assert.match(finalText, /BBCA/);
  assert.match(finalText, /Rentang: 1D/);
  assert.match(finalText, /Hasil analisa di grup akan otomatis dihapus setelah 5 menit demi privasi\./);
  assert.deepEqual(
    finalEdit.extra.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    ['tf:analisa:BBCA:1', 'tf:analisa:BBCA:7', 'tf:analisa:BBCA:30']
  );
  assert.equal(bot.constants.GROUP_RESULT_TTL_MS, 300000);
  assert.match(finalText, /Kesimpulan lokal/);
  assert.match(prompts[0], /BBCA/);
  const token = finalText.split('/webview/')[1].split(/\s/)[0];
  const server = bot.createWebServer();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const first = await fetch('http://127.0.0.1:' + port + '/webview/' + token);
    assert.equal(first.status, 200);
    const html = await first.text();
    assert.match(html, /BBCA/);
    const second = await fetch('http://127.0.0.1:' + port + '/webview/' + token);
    assert.equal(second.status, 410);
  } finally {
    server.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(ctx.deleted.includes(1));
});

test('timeframe buttons edit the existing analysis and broker cards', async () => {
  const root = fixtureRoot();
  const db = memoryDb([{ telegram_id: '42', status: 'approved', provider: 'gemini', username: 'trader' }]);
  const mock = mockCredentials();
  mock.store.set('42:gemini', { apiKey: 'AIzaSyTestKeyForBotUser123456', maskedKey: '****3456' });
  const bot = createInteractiveBot({
    db,
    rootDir: root,
    env: { ADMIN_TELEGRAM_ID: '7' },
    credentials: mock,
    gemini: {
      async generateGeminiContent() {
        return { text: 'Kesimpulan 30 hari.' };
      }
    }
  });

  const analysis = createCtx({
    callbackQuery: {
      id: 'tf1',
      data: 'tf:analisa:BBCA:30',
      message: { message_id: 17, text: 'kartu lama' }
    }
  });
  await bot.handleUpdate(analysis);
  assert.equal(analysis.sent.length, 0);
  assert.equal(analysis.edits.length, 1);
  assert.equal(analysis.edits[0].messageId, 17);
  assert.match(analysis.edits[0].text, /Rentang: 30D/);
  assert.match(analysis.edits[0].text, /Kesimpulan 30 hari/);
  assert.equal(analysis.callbacks[0], 'Rentang 30D');

  const broker = createCtx({
    message: { text: '/broksum BBCA' }
  });
  await bot.handleUpdate(broker);
  const brokerEdit = broker.edits.at(-1);
  assert.match(brokerEdit.text, /Rentang: 1D/);
  assert.deepEqual(
    brokerEdit.extra.reply_markup.inline_keyboard[0].map((button) => button.text),
    ['✅ 📊 1D (Hari Ini)', '📅 7D', '📈 30D']
  );

  const switched = createCtx({
    callbackQuery: {
      id: 'tf2',
      data: 'tf:broksum:BBCA:7',
      message: { message_id: 1 }
    }
  });
  await bot.handleUpdate(switched);
  assert.equal(switched.sent.length, 0);
  assert.match(switched.edits[0].text, /Rentang: 7D/);
  assert.equal(switched.callbacks[0], 'Rentang 7D');
});

test('custom provider rejects non-https endpoints before calling fetch', async () => {
  const db = memoryDb([{ telegram_id: '42', status: 'approved', provider: 'custom' }]);
  const mock = mockCredentials();
  mock.store.set('42:custom', { apiKey: 'sk-custom-key', maskedKey: '****-key' });
  let called = false;
  const bot = createInteractiveBot({
    db,
    env: { CUSTOM_AI_BASE_URL: 'http://169.254.169.254/latest' },
    credentials: mock,
    delays: { denial: 20, result: 20, welcome: 20 },
    fetchFn: async () => {
      called = true;
      return { ok: true, json: async () => ({ text: 'nope' }) };
    }
  });
  const ctx = createCtx({
    chat: { id: 42, type: 'private' },
    message: { text: '/tanya apa kabar BBCA' }
  });
  await bot.handleUpdate(ctx);
  assert.equal(called, false);
  const finalText = ctx.edits.at(-1).text;
  assert.match(finalText, /HTTPS/);
});

test('runtime env loader fills only missing keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-env-'));
  fs.writeFileSync(path.join(dir, '.env'), 'BOT_TOKEN=from-env\nADMIN_TELEGRAM_ID=1\n');
  fs.writeFileSync(path.join(dir, '.env.intraday-runtime'), 'SUPABASE_URL=https://example.supabase.co\nBOT_TOKEN=ignored\n');
  const env = { BOT_TOKEN: 'already' };
  loadRuntimeEnv(dir, env);
  assert.equal(env.BOT_TOKEN, 'already');
  assert.equal(env.ADMIN_TELEGRAM_ID, '1');
  assert.equal(env.SUPABASE_URL, 'https://example.supabase.co');
});

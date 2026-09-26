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

test('pending group command returns the verification bot deep-link hold and schedules deletion', async () => {
  const db = memoryDb([]);
  const bot = createInteractiveBot({
    db,
    env: { ADMIN_TELEGRAM_ID: '7', VERIFY_BOT_USERNAME: 'AutoCuanVerificationBot' },
    delays: { denial: 20, result: 20, welcome: 20 }
  });
  const ctx = createCtx({ message: { text: '/analisa BBCA' } });
  await bot.handleUpdate(ctx);
  assert.equal(ctx.sent.length, 1);
  // Gatekeeper guard: ONLY the hold response, never a processed command.
  assert.match(ctx.sent[0].text, /Akun Anda belum terverifikasi/);
  assert.doesNotMatch(ctx.sent[0].text, /\/analisa/);
  const button = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🔐 Verifikasi Akses Sekarang');
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
  const wibDay = new Date(Date.now() + (7 * 60 * 60 * 1000)).getUTCDay();
  const weekend = wibDay === 0 || wibDay === 6;
  const expectedRemaining = weekend ? '16/20' : '11/15';
  assert.match(text, /Status Akun & BYOK/);
  assert.match(text, new RegExp('Sisa Kuota Hari Ini: ' + expectedRemaining.replace('/', '\\/') + ' \\(Reset 00:00 WIB\\)'));
  assert.match(text, /\/analisa <KODE_SAHAM> — Analisa chart \+ bandar flow \(Contoh: \/analisa BBCA\)/);
  assert.match(text, /\/bandar <KODE_SAHAM> — Analisis bandarmologi & konsentrasi CR3\/CR5 \(Contoh: \/bandar BBRI\)/);
  assert.match(text, /\/broksum <KODE_SAHAM> — Rangkuman broker asing \(Contoh: \/broksum BBRI\)/);
  assert.match(text, /\/insider <KODE_SAHAM> — Jaringan kepemilikan orang dalam \(Contoh: \/insider BREN\)/);
  assert.match(text, /\/scan <daytrade\|swing\|top5> — Screener saham otomatis \(Contoh: \/scan daytrade\)/);
  assert.match(text, /\/tanya <pertanyaan> — Tanya AI seputar market \(Contoh: \/tanya prospek perbankan\)/);
  assert.match(text, /\/foreign — Top 10 Foreign Flow \(Buy\/Sell\)/);
  assert.match(text, /\/ritel — Top 10 Akumulasi Ritel/);
  assert.match(text, /privasi terjaga/);
  assert.match(text, /15x weekday \/ 20x weekend/);
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
  assert.equal(db.rows.get('42').status, 'active');
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

test('vps status is admin-only and group cards expire after 60 seconds', async () => {
  const bot = createInteractiveBot({
    db: memoryDb([]),
    env: { ADMIN_TELEGRAM_ID: '7' },
    delays: { denial: 20, result: 20, welcome: 20, vps: 30 },
    systemStatus() {
      return {
        uptimeSec: 3661,
        ramUsedMb: 512,
        ramTotalMb: 2048,
        cpuLoad: 0.42,
        processes: [
          { name: 'autocuan-bot', status: 'online' },
          { name: 'vps-api-server', status: 'online' },
          { name: 'ai-eval-once-supervisor', status: 'online' }
        ],
        wibTime: '2026-09-25 08:39 WIB'
      };
    }
  });
  const member = createCtx({ from: { id: 42 }, message: { text: '/vps' } });
  await bot.handleUpdate(member);
  assert.equal(member.sent.length, 0);

  const admin = createCtx({
    from: { id: 7 },
    chat: { id: -1003755658635, type: 'supergroup' },
    message: { text: '/status' }
  });
  await bot.handleUpdate(admin);
  assert.match(admin.sent[0].text, /Uptime: 1j 1m/);
  assert.match(admin.sent[0].text, /RAM: 512 \/ 2048 MB/);
  assert.match(admin.sent[0].text, /autocuan-bot: online/);
  assert.match(admin.sent[0].text, /08:39 WIB/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(admin.deleted, [1]);
});

test('sensitive admin controls stay private and update member access', async () => {
  const db = memoryDb([
    { telegram_id: '42', status: 'pending', username: 'trader', provider: 'gemini', daily_limit: 15, daily_usage: 2, last_usage_date: '2099-01-01' },
    { telegram_id: '77', status: 'approved', username: 'member', provider: 'gemini', daily_limit: 15, daily_usage: 1, last_usage_date: '2099-01-01' }
  ]);
  const bot = createInteractiveBot({ db, env: { ADMIN_TELEGRAM_ID: '7' } });
  const group = createCtx({
    from: { id: 7 },
    chat: { id: -100, type: 'supergroup' },
    message: { text: '/pending' }
  });
  await bot.handleUpdate(group);
  assert.equal(group.sent.length, 0);

  const pending = createCtx({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    message: { text: '/pending' }
  });
  await bot.handleUpdate(pending);
  assert.match(pending.sent[0].text, /42/);
  assert.deepEqual(
    pending.sent[0].extra.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    ['approve:42', 'reject:42']
  );

  const limit = createCtx({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    message: { text: '/limit 77 25' }
  });
  await bot.handleUpdate(limit);
  assert.equal(db.rows.get('77').daily_limit, 25);

  const ban = createCtx({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    message: { text: '/ban 77' }
  });
  await bot.handleUpdate(ban);
  assert.equal(db.rows.get('77').status, 'banned');
  const unban = createCtx({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    message: { text: '/unban 77' }
  });
  await bot.handleUpdate(unban);
  assert.equal(db.rows.get('77').status, 'approved');
});

test('foreign and retail flows use trading-day windows and edit in place', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-flow-'));
  const brokerRoot = path.join(root, 'data', 'arjum-data', 'broker-summary');
  const dates = ['2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
  for (const ticker of ['BBCA', 'BBRI']) {
    fs.mkdirSync(path.join(brokerRoot, ticker), { recursive: true });
    dates.forEach((date, index) => {
      const sign = ticker === 'BBCA' ? 1 : -1;
      fs.writeFileSync(path.join(brokerRoot, ticker, date + '.json'), JSON.stringify({
        brokers: [
          { broker_code: 'YP', nval: sign * (index + 1) * 1000000000, investor_type: 'foreign' },
          { broker_code: 'AK', nval: sign * 100000000, investor_type: 'local' }
        ]
      }));
    });
  }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify({
    daytrade: [{ ticker: 'BBCA', score: 88, sector: 'Bank' }]
  }));
  const db = memoryDb([{ telegram_id: '42', status: 'approved', provider: 'gemini' }]);
  const mock = mockCredentials();
  mock.store.set('42:gemini', { apiKey: 'AIzaSyTestKeyForBotUser123456', maskedKey: '****3456' });
  const bot = createInteractiveBot({
    db,
    rootDir: root,
    env: { ADMIN_TELEGRAM_ID: '7' },
    credentials: mock,
    now: () => Date.parse('2026-09-24T12:30:00Z'),
    gemini: { async generateGeminiContent() { return { text: 'Opini objektif.' }; } }
  });
  const ctx = createCtx({ message: { text: '/foreign' } });
  await bot.handleUpdate(ctx);
  const card = ctx.sent.at(-1);
  assert.match(card.text, /Top 10 Net Foreign Buy/);
  assert.match(card.text, /BBCA/);
  assert.match(card.text, /Top 10 Net Foreign Sell/);
  assert.match(card.text, /BBRI/);
  assert.match(card.text, /Opini objektif/);
  assert.match(card.text, /Sinyal aktif: BBCA/);
  assert.deepEqual(
    card.extra.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    ['flow:foreign:1', 'flow:foreign:7', 'flow:foreign:30']
  );

  const retail = createCtx({
    callbackQuery: { id: 'flow1', data: 'flow:ritel:7', message: { message_id: 9 } }
  });
  await bot.handleUpdate(retail);
  assert.equal(retail.sent.length, 0);
  assert.equal(retail.edits[0].messageId, 9);
  assert.match(retail.edits[0].text, /Top 10 Saham Akumulasi Ritel/);
  assert.match(retail.edits[0].text, /5 hari perdagangan/);
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

test('state-machine: Kondisi 4 in group chat notifies user to set key in DM', async () => {
  const db = memoryDb([{
    telegram_id: '100',
    username: 'approved_user',
    status: 'approved',
    email: 'user@gmail.com',
    byok_active: false
  }]);
  const bot = createInteractiveBot({
    db,
    env: { ADMIN_TELEGRAM_ID: '7' }
  });
  const ctx = createCtx({
    chat: { id: -100123, type: 'supergroup' },
    from: { id: 100, username: 'approved_user' },
    message: { text: '/analisa BBCA' }
  });
  await bot.handleUpdate(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Kunci AI \(BYOK\) Anda belum dipasang/);
  assert.match(ctx.sent[0].text, /\/setkey/);
  const btn = ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.match(btn.text, /Pasang Kunci AI/);
});

test('state-machine: direct /setkey <key> activates BYOK and allows group commands', async () => {
  const db = memoryDb([{
    telegram_id: '200',
    username: 'test_trader',
    status: 'approved',
    email: 'trader@gmail.com',
    byok_active: false
  }]);
  const mock = mockCredentials();
  const bot = createInteractiveBot({
    db,
    credentials: mock,
    gemini: {
      async generateGeminiContent() { return { text: 'Ulasan BBCA mantap' }; }
    },
    env: { ADMIN_TELEGRAM_ID: '7' },
    delays: { denial: 20, result: 20, welcome: 20 }
  });

  // User sets key directly in DM
  const dmCtx = createCtx({
    chat: { id: 200, type: 'private' },
    from: { id: 200, username: 'test_trader' },
    message: { message_id: 11, text: '/setkey AIzaSyTestKey123456789012345678901234567' }
  });
  await bot.handleUpdate(dmCtx);
  assert.equal(dmCtx.sent.length, 1);
  assert.match(dmCtx.sent[0].text, /Kunci AI Berhasil Diaktifkan/);

  // Check database updated
  const user = await db.from('bot_users').select('*').eq('telegram_id', '200').maybeSingle();
  assert.equal(user.data.status, 'approved');
  assert.equal(user.data.provider, 'gemini');

  // Now user calls in group chat
  const groupCtx = createCtx({
    chat: { id: -100222, type: 'supergroup' },
    from: { id: 200, username: 'test_trader' },
    message: { text: '/analisa BBCA' }
  });
  await bot.handleUpdate(groupCtx);
  assert.notEqual(groupCtx.sent[0].text.indexOf('Kunci AI (BYOK) Anda belum dipasang'), 0);
  assert.match(groupCtx.edits.at(-1).text, /BBCA/);
});

test('state-machine: /setkey wizard step-by-step Official Provider flow', async () => {
  const db = memoryDb([{
    telegram_id: '300',
    username: 'wizard_user',
    status: 'approved',
    email: 'wiz@gmail.com',
    byok_active: false
  }]);
  const mock = mockCredentials();
  const bot = createInteractiveBot({
    db,
    credentials: mock,
    env: { ADMIN_TELEGRAM_ID: '7' },
    fetchFn: async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      return { ok: false };
    }
  });

  // Step 1: User types /setkey
  const step1Ctx = createCtx({
    chat: { id: 300, type: 'private' },
    from: { id: 300, username: 'wizard_user' },
    message: { text: '/setkey' }
  });
  await bot.handleUpdate(step1Ctx);
  assert.match(step1Ctx.sent[0].text, /Wizard Pengaturan Kunci AI/);
  const catBtn = step1Ctx.sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(catBtn.callback_data, 'setkey:cat:official');

  // Step 2A: User clicks Official Provider
  const step2Ctx = createCtx({
    chat: { id: 300, type: 'private' },
    from: { id: 300, username: 'wizard_user' },
    callbackQuery: { id: 'cb1', data: 'setkey:cat:official' }
  });
  await bot.handleUpdate(step2Ctx);
  assert.match(step2Ctx.edits[0].text, /Pilih Provider Resmi/);
  const geminiBtn = step2Ctx.edits[0].extra.reply_markup.inline_keyboard[0][0];
  assert.equal(geminiBtn.callback_data, 'setkey:prov:gemini');

  // Step 2B: User selects Google Gemini
  const step3Ctx = createCtx({
    chat: { id: 300, type: 'private' },
    from: { id: 300, username: 'wizard_user' },
    callbackQuery: { id: 'cb2', data: 'setkey:prov:gemini' }
  });
  await bot.handleUpdate(step3Ctx);
  assert.match(step3Ctx.edits[0].text, /Kirimkan API Key resmi Anda/);

  // Step 2C: User sends Gemini API key text
  const step4Ctx = createCtx({
    chat: { id: 300, type: 'private' },
    from: { id: 300, username: 'wizard_user' },
    message: { message_id: 15, text: 'AIzaSyTestOfficialKey12345678901234567' }
  });
  await bot.handleUpdate(step4Ctx);
  // Verify model buttons presented via editMessageText or reply
  const lastEditOrSent = step4Ctx.edits[0] || step4Ctx.sent.at(-1);
  assert.match(lastEditOrSent.text, /pilih model/i);
  const modelBtns = (lastEditOrSent.extra && lastEditOrSent.extra.reply_markup && lastEditOrSent.extra.reply_markup.inline_keyboard) ||
    (lastEditOrSent.reply_markup && lastEditOrSent.reply_markup.inline_keyboard);
  assert.ok(modelBtns.length >= 1);
  assert.equal(modelBtns[0][0].callback_data, 'setkey:model:0');

  // Step 3: User clicks chosen model
  const step5Ctx = createCtx({
    chat: { id: 300, type: 'private' },
    from: { id: 300, username: 'wizard_user' },
    callbackQuery: { id: 'cb3', data: 'setkey:model:0' }
  });
  await bot.handleUpdate(step5Ctx);
  assert.match(step5Ctx.edits[0].text, /Kunci AI Berhasil Diaktifkan/);
  assert.match(step5Ctx.edits[0].text, /gemini-2\.5-flash/);
  assert.match(step5Ctx.edits[0].text, /Status BYOK: <b>Aktif ✅<\/b>/);
});

test('state-machine: /setkey wizard Custom Provider flow with model fetching and pagination', async () => {
  const db = memoryDb([{
    telegram_id: '400',
    username: 'custom_wiz_user',
    status: 'approved',
    email: 'custom@gmail.com',
    byok_active: false
  }]);
  const mock = mockCredentials();
  const bot = createInteractiveBot({
    db,
    credentials: mock,
    env: { ADMIN_TELEGRAM_ID: '7' },
    fetchFn: async (url) => {
      if (url.includes('api.9router.com/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'deepseek/deepseek-r1' },
              { id: 'deepseek/deepseek-chat' },
              { id: 'openai/gpt-4o' },
              { id: 'openai/gpt-4o-mini' },
              { id: 'anthropic/claude-3-5-sonnet' },
              { id: 'google/gemini-2.5-flash' },
              { id: 'meta-llama/llama-3.3-70b-instruct' }
            ]
          })
        };
      }
      return { ok: false };
    }
  });

  // Step 1: User types /setkey
  const step1Ctx = createCtx({
    chat: { id: 400, type: 'private' },
    from: { id: 400, username: 'custom_wiz_user' },
    message: { text: '/setkey' }
  });
  await bot.handleUpdate(step1Ctx);

  // Step 2A: User selects Custom Provider
  const step2Ctx = createCtx({
    chat: { id: 400, type: 'private' },
    from: { id: 400, username: 'custom_wiz_user' },
    callbackQuery: { id: 'cb_custom', data: 'setkey:cat:custom' }
  });
  await bot.handleUpdate(step2Ctx);
  assert.match(step2Ctx.edits[0].text, /Custom \/ 3rd Party Provider/);
  assert.match(step2Ctx.edits[0].text, /Kirimkan Base URL API Anda/);

  // Step 2B: User sends Base URL
  const step3Ctx = createCtx({
    chat: { id: 400, type: 'private' },
    from: { id: 400, username: 'custom_wiz_user' },
    message: { text: 'https://api.9router.com/v1' }
  });
  await bot.handleUpdate(step3Ctx);
  assert.match(step3Ctx.sent[0].text, /Base URL disimpan/);
  assert.match(step3Ctx.sent[0].text, /Kirimkan API Key Anda/);

  // Step 2C: User sends API key
  const step4Ctx = createCtx({
    chat: { id: 400, type: 'private' },
    from: { id: 400, username: 'custom_wiz_user' },
    message: { message_id: 20, text: 'sk-9router-secret-key-12345678' }
  });
  await bot.handleUpdate(step4Ctx);

  const lastEditOrSent = step4Ctx.edits[0] || step4Ctx.sent.at(-1);
  assert.match(lastEditOrSent.text, /pilih model/i);
  const modelBtns = (lastEditOrSent.extra && lastEditOrSent.extra.reply_markup && lastEditOrSent.extra.reply_markup.inline_keyboard) ||
    (lastEditOrSent.reply_markup && lastEditOrSent.reply_markup.inline_keyboard);
  assert.ok(modelBtns.length >= 1);
  assert.equal(modelBtns[0][0].callback_data, 'setkey:model:0');

  // Step 3: User selects model (0 -> deepseek/deepseek-r1)
  const step5Ctx = createCtx({
    chat: { id: 400, type: 'private' },
    from: { id: 400, username: 'custom_wiz_user' },
    callbackQuery: { id: 'cb_m0', data: 'setkey:model:0' }
  });
  await bot.handleUpdate(step5Ctx);
  assert.match(step5Ctx.edits[0].text, /Kunci AI Berhasil Diaktifkan/);
  assert.match(step5Ctx.edits[0].text, /deepseek\/deepseek-r1/);

  // Verify DB updated with custom settings
  const userRow = await db.from('bot_users').select('*').eq('telegram_id', '400').maybeSingle();
  assert.equal(userRow.data.status, 'approved');
  assert.equal(userRow.data.provider, 'custom');
  assert.equal(userRow.data.provider_settings.ai_model, 'deepseek/deepseek-r1');
  assert.equal(userRow.data.provider_settings.ai_base_url, 'https://api.9router.com/v1');
});

test('state-machine: @Donaldtrumpssss (Telegram ID 6396446903) is recognized as verified admin', async () => {
  const db = memoryDb([{
    telegram_id: '6396446903',
    username: 'Donaldtrumpssss',
    status: 'approved',
    email: 'budi@autocuan.com',
    byok_active: true
  }]);
  const bot = createInteractiveBot({
    db,
    env: { ADMIN_TELEGRAM_ID: '6396446903' },
    gemini: {
      async generateGeminiContent() { return { text: 'Analisa admin ok' }; }
    }
  });

  const groupCtx = createCtx({
    chat: { id: -100999, type: 'supergroup' },
    from: { id: 6396446903, username: 'Donaldtrumpssss' },
    message: { text: '/analisa BBCA' }
  });
  await bot.handleUpdate(groupCtx);
  // Must not be rejected with unverified or need byok hold
  assert.equal(groupCtx.sent.length > 0, true);
  assert.doesNotMatch(groupCtx.sent[0].text, /belum terverifikasi/i);
  assert.doesNotMatch(groupCtx.sent[0].text, /Kunci AI \(BYOK\) Anda belum dipasang/i);
  assert.match(groupCtx.edits.at(-1).text, /BBCA/);
});

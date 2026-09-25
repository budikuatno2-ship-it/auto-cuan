'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const tv = require('../lib/telegram-verification');
const registerToken = require('../lib/telegram-register-token');
const botRegister = require('../api/bot-register');
const passwordCredential = require('../lib/password-credential');
const vpsKeepalive = require('../tools/vps-keepalive');

function mockFakeBot() {
  const sent = [];
  const edits = [];
  return {
    sent,
    edits,
    sendMessage: async (chatId, text, options) => {
      const msg = { message_id: sent.length + 1, chatId: String(chatId), text, options };
      sent.push(msg);
      return msg;
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId: String(chatId), messageId, text, options });
      return true;
    },
    answerCallbackQuery: async () => true
  };
}

function mockDatabase(users, verifications) {
  const userMap = new Map((users || []).map((u) => [String(u.id || u.telegram_id), Object.assign({}, u)]));
  const botUsers = new Map((users || []).map((u) => [String(u.telegram_id || u.id), Object.assign({}, u)]));
  const verMap = new Map((verifications || []).map((v) => [String(v.telegram_user_id), Object.assign({}, v)]));

  return {
    userMap,
    botUsers,
    from: (table) => {
      const filters = [];
      const query = {
        select: () => query,
        eq: (col, val) => {
          filters.push([col, String(val)]);
          return query;
        },
        maybeSingle: async () => {
          if (table === 'bot_users') {
            for (const row of botUsers.values()) {
              if (filters.every(([c, v]) => String(row[c]) === v)) {
                return { data: Object.assign({}, row), error: null };
              }
            }
          }
          if (table === 'app_user_telegram_verifications') {
            for (const row of verMap.values()) {
              if (filters.every(([c, v]) => String(row[c]) === v)) {
                return { data: Object.assign({}, row), error: null };
              }
            }
          }
          if (table === 'app_users') {
            for (const row of userMap.values()) {
              if (filters.every(([c, v]) => String(row[c]) === v)) {
                return { data: Object.assign({}, row), error: null };
              }
            }
          }
          return { data: null, error: null };
        },
        update: (patch) => {
          const updateChain = {
            eq: (col, val) => {
              if (table === 'bot_users') {
                const row = botUsers.get(String(val));
                if (row) Object.assign(row, patch);
              }
              return Promise.resolve({ data: patch, error: null });
            }
          };
          return updateChain;
        },
        upsert: async (row) => {
          if (table === 'bot_users') {
            botUsers.set(String(row.telegram_id), Object.assign({}, row));
            return { data: row, error: null };
          }
          return { data: row, error: null };
        }
      };
      return query;
    },
    rpc: (name) => {
      if (name === 'claim_telegram_webhook_update') {
        return Promise.resolve({ data: [{ claim_state: 'claimed', processing_token: 't' }], error: null });
      }
      if (name === 'complete_telegram_webhook_update') {
        return Promise.resolve({ data: [true], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
  };
}

test('Smart /start: ID "budi" immediately receives account summary & Web Screener button, without registration form', async () => {
  const bot = mockFakeBot();
  const db = mockDatabase([]);
  const update = {
    update_id: 201,
    message: { chat: { id: 999, type: 'private' }, from: { id: 999, username: 'budi' }, text: '/start' }
  };

  const res = await tv.processWebhookUpdate(update, { supabase: db, bot, registerTokenStore: registerToken });
  assert.equal(res.outcome, 'start_verified');
  assert.equal(bot.sent.length, 1);
  const msg = bot.sent[0];
  assert.match(msg.text, /Ringkasan Akun/);
  assert.match(msg.text, /Username:\s*budi/i);
  assert.match(msg.text, /Status:\s*Disetujui/);
  assert.match(msg.text, /Akses Channel:\s*Aktif/);
  assert.match(msg.text, /Subscription:\s*Lifetime Admin/);
  assert.doesNotMatch(msg.text, /Formulir Pendaftaran|\/daftar/);

  const button = msg.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🌐 Buka Web Screener');
  assert.match(button.url, /^https?:\/\//);
});

test('Smart /start: Active registered member receives account summary & Web Screener button, without registration form', async () => {
  const bot = mockFakeBot();
  const db = mockDatabase([{
    telegram_id: '12345',
    username: 'cuan_trader',
    full_name: 'Budi Hartono',
    status: 'active',
    channel_access: 'Aktif',
    subscription_status: 'Premium 1 Bulan'
  }]);
  const update = {
    update_id: 202,
    message: { chat: { id: 12345, type: 'private' }, from: { id: 12345, username: 'cuan_trader' }, text: '/start' }
  };

  const res = await tv.processWebhookUpdate(update, { supabase: db, bot, registerTokenStore: registerToken });
  assert.equal(res.outcome, 'start_verified');
  assert.equal(bot.sent.length, 1);
  const msg = bot.sent[0];
  assert.match(msg.text, /Ringkasan Akun/);
  assert.match(msg.text, /Username:\s*cuan_trader/);
  assert.match(msg.text, /Status:\s*Disetujui/);
  assert.match(msg.text, /Akses Channel:\s*Aktif/);
  assert.match(msg.text, /Subscription:\s*Premium 1 Bulan/);
  assert.doesNotMatch(msg.text, /Formulir Pendaftaran|\/daftar/);

  const button = msg.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🌐 Buka Web Screener');
  assert.match(button.url, /^https?:\/\//);
});

test('Smart /start: New unregistered user receives fresh 2-hour token and "📝 Buka Formulir Pendaftaran" button', async () => {
  registerToken.clearMemoryStoreForTesting();
  const bot = mockFakeBot();
  const db = mockDatabase([]);
  const update = {
    update_id: 203,
    message: { chat: { id: 777888, type: 'private' }, from: { id: 777888, username: 'newuser' }, text: '/start' }
  };

  const res = await tv.processWebhookUpdate(update, { supabase: db, bot, registerTokenStore: registerToken });
  assert.equal(res.outcome, 'start');
  assert.equal(bot.sent.length, 1);
  const msg = bot.sent[0];
  const button = msg.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '📝 Buka Formulir Pendaftaran');
  assert.match(button.url, /user_id=777888/);
  assert.match(button.url, /token=/);

  // Extract token from URL and verify it is valid in registerTokenStore
  const tokenMatch = button.url.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(tokenMatch, 'Token must be present in registration URL');
  const token = tokenMatch[1];
  const consumed = await registerToken.consumeToken(null, token);
  assert.equal(consumed.ok, true);
  assert.equal(consumed.telegramId, '777888');
});

test('Register submit: Invalid or expired token gives friendly error message', async () => {
  registerToken.clearMemoryStoreForTesting();
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };

  await botRegister({
    method: 'POST',
    body: {
      token: 'token-kadaluarsa-123',
      name: 'User Baru',
      email: 'userbaru@gmail.com',
      password: 'password123',
      passwordConfirm: 'password123'
    }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, 'Token pendaftaran tidak valid atau sudah kedaluwarsa. Silakan ketik /start di bot Telegram untuk mendapatkan tautan baru.');
});

test('Register submit: Valid form hashes password, saves account, and dispatches instant Telegram admin notification', async () => {
  registerToken.clearMemoryStoreForTesting();
  const db = mockDatabase([]);
  const token = await registerToken.issueToken(null, '555666');

  const adminNotifications = [];
  const origFetch = global.fetch;
  global.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    adminNotifications.push(payload);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  };

  process.env.ADMIN_TELEGRAM_ID = '111222';
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = '123456:dummy-token';

  const clientHash = crypto.createHash('sha256').update('passwordRahasia123', 'utf8').digest('hex');
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };

  try {
    await botRegister({
      method: 'POST',
      supabase: db,
      body: {
        token,
        user_id: '555666',
        name: 'Ahmad Subandi',
        email: 'ahmad.subandi@gmail.com',
        passwordHash: clientHash
      }
    }, res);
  } finally {
    global.fetch = origFetch;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'Pendaftaran berhasil dikirim! Menunggu persetujuan admin.');

  // Verify saved in DB with protected scrypt hash
  const saved = db.botUsers.get('555666');
  assert.ok(saved, 'User row must be saved');
  assert.equal(saved.full_name, 'Ahmad Subandi');
  assert.equal(saved.gmail, 'ahmad.subandi@gmail.com');
  assert.equal(saved.status, 'pending');
  assert.ok(passwordCredential.isProtectedCredential(saved.password_hash), 'Password must be stored as protected k1 scrypt hash');

  // Verify Admin Notification
  assert.equal(adminNotifications.length, 1);
  const adminMsg = adminNotifications[0];
  assert.equal(String(adminMsg.chat_id), '111222');
  assert.match(adminMsg.text, /🔔 Pendaftaran Akun Baru Masuk!/);
  assert.match(adminMsg.text, /Nama: Ahmad Subandi/);
  assert.match(adminMsg.text, /Email: ahmad\.subandi@gmail\.com/);
  assert.match(adminMsg.text, /Telegram ID: 555666/);
  assert.match(adminMsg.text, /Aksi: \/approve_555666 atau tolak/);
  assert.doesNotMatch(adminMsg.text, /password/i);

  // Verify inline buttons
  const buttons = adminMsg.reply_markup.inline_keyboard[0];
  assert.equal(buttons[0].text, '✅ Setujui');
  assert.equal(buttons[0].callback_data, 'approve:555666');
  assert.equal(buttons[1].text, '❌ Tolak');
  assert.equal(buttons[1].callback_data, 'reject:555666');
});

test('Admin approval: /approve_<id> command approves the pending account and notifies user', async () => {
  const bot = mockFakeBot();
  const db = mockDatabase([{
    telegram_id: '555666',
    full_name: 'Ahmad Subandi',
    status: 'pending'
  }]);
  process.env.ADMIN_TELEGRAM_ID = '111222';

  const update = {
    update_id: 301,
    message: { chat: { id: 111222, type: 'private' }, from: { id: 111222 }, text: '/approve_555666' }
  };

  const res = await tv.processWebhookUpdate(update, { supabase: db, bot });
  assert.equal(res.outcome, 'admin_approved');

  // Check DB state
  assert.equal(db.botUsers.get('555666').status, 'approved');

  // Check user received congratulatory notification
  const userMsg = bot.sent.find((m) => m.chatId === '555666');
  assert.ok(userMsg, 'User must receive approval DM');
  assert.match(userMsg.text, /Pendaftaran Anda disetujui/);

  // Check admin received confirmation
  const adminMsg = bot.sent.find((m) => m.chatId === '111222');
  assert.ok(adminMsg, 'Admin must receive confirmation');
  assert.match(adminMsg.text, /berhasil disetujui/);
});

test('Oracle Keepalive Watchdog: duty cycle completes 1000ms burn with negligible memory', async () => {
  const memBefore = process.memoryUsage().heapUsed;
  await new Promise((resolve) => {
    vpsKeepalive.runDutyCycleBurn(1000, null, (totalElapsed, totalIters) => {
      assert.ok(totalElapsed >= 950, 'Must run close to target duration');
      assert.ok(totalIters >= 8, 'Must execute duty cycle iterations');
      const memAfter = process.memoryUsage().heapUsed;
      const memDiffMb = Math.abs(memAfter - memBefore) / (1024 * 1024);
      assert.ok(memDiffMb < 15, 'Memory delta must remain under 15MB');
      resolve();
    });
  });
});

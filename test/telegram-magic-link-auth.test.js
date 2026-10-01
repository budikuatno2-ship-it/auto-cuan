'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const magicToken = require('../lib/telegram-magic-token');
const tv = require('../lib/telegram-verification');
const registerToken = require('../lib/telegram-register-token');
const loginUserHandler = require('../api/login-user');

function mockFakeBot() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, options) => {
      const msg = { message_id: sent.length + 1, chatId: String(chatId), text, options };
      sent.push(msg);
      return msg;
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
      let updatePayload = null;
      let insertPayload = null;
      const query = {
        select: () => query,
        eq: (col, val) => {
          filters.push([col, String(val).toLowerCase()]);
          return query;
        },
        ilike: (col, val) => {
          filters.push([col, String(val).toLowerCase()]);
          return query;
        },
        update: (data) => {
          updatePayload = data;
          return query;
        },
        insert: (data) => {
          insertPayload = data;
          return query;
        },
        upsert: (data) => {
          insertPayload = data;
          return Promise.resolve({ error: null, data });
        },
        maybeSingle: async () => {
          let rows = [];
          if (table === 'app_users') rows = Array.from(userMap.values());
          else if (table === 'bot_users') rows = Array.from(botUsers.values());
          else if (table === 'app_user_telegram_verifications') rows = Array.from(verMap.values());

          for (const [col, val] of filters) {
            rows = rows.filter((r) => {
              const actual = String(r[col] || '').toLowerCase();
              return actual === val;
            });
          }
          const row = rows[0] || null;
          if (updatePayload && row) {
            Object.assign(row, updatePayload);
          }
          return { data: row ? Object.assign({}, row) : null, error: null };
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

function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(data) {
      this.body = data;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
  return res;
}

test('Magic Token: Issue and consume token lifecycle (single use)', async () => {
  magicToken.clearMemoryStoreForTesting();
  const token = await magicToken.issueToken(null, '888999', 'budi');
  assert.ok(token);
  assert.ok(token.startsWith('mgt_'));

  // First consume succeeds
  const res1 = await magicToken.consumeToken(null, token, '888999');
  assert.equal(res1.ok, true);
  assert.equal(res1.telegramId, '888999');
  assert.equal(res1.username, 'budi');

  // Second consume (replay) fails
  const res2 = await magicToken.consumeToken(null, token, '888999');
  assert.equal(res2.ok, false);
});

test('Magic Token: Rejects identity mismatch', async () => {
  magicToken.clearMemoryStoreForTesting();
  const token = await magicToken.issueToken(null, '111222', 'trader_one');

  // Consume with wrong telegramId
  const res = await magicToken.consumeToken(null, token, '999999');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'identity_mismatch');
});

test('Magic Token: Rejects tampered signature', async () => {
  magicToken.clearMemoryStoreForTesting();
  const token = await magicToken.issueToken(null, '111222', 'trader_one');
  const tampered = token.slice(0, -5) + 'xxxxx';

  const res = await magicToken.consumeToken(null, tampered, '111222');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'signature_mismatch');
});

test('Magic Token: Rejects expired token', async () => {
  magicToken.clearMemoryStoreForTesting();
  const past = Date.now() - 3600000;
  const token = await magicToken.issueToken(null, '111222', 'trader_one', { ttlMs: -1000, now: () => past });

  const res = await magicToken.consumeToken(null, token, '111222');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'expired');
});

test('Smart /start: Active user receives Web Screener URL with auth_token and user_id', async () => {
  magicToken.clearMemoryStoreForTesting();
  const bot = mockFakeBot();
  const db = mockDatabase([{
    telegram_id: '998877',
    username: 'budi_cuan',
    full_name: 'Budi Cuan',
    status: 'active',
    channel_access: 'Aktif',
    subscription_status: 'Premium'
  }]);

  const update = {
    update_id: 301,
    message: { chat: { id: 998877, type: 'private' }, from: { id: 998877, username: 'budi_cuan' }, text: '/start' }
  };

  const res = await tv.processWebhookUpdate(update, {
    supabase: db,
    bot,
    registerTokenStore: registerToken,
    magicTokenStore: magicToken
  });

  assert.equal(res.outcome, 'start_verified');
  assert.equal(bot.sent.length, 1);
  const msg = bot.sent[0];
  const button = msg.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🌐 Buka Web Screener');
  assert.match(button.url, /auth_token=mgt_/);
  assert.match(button.url, /user_id=998877/);
});

test('Smart /start: Admin Budi receives Web Screener URL with auth_token and user_id', async () => {
  magicToken.clearMemoryStoreForTesting();
  const bot = mockFakeBot();
  const db = mockDatabase([{
    telegram_id: '12345',
    username: 'budi',
    full_name: 'Budi Admin',
    status: 'active'
  }]);

  const update = {
    update_id: 302,
    message: { chat: { id: 12345, type: 'private' }, from: { id: 12345, username: 'budi' }, text: '/start' }
  };

  const res = await tv.processWebhookUpdate(update, {
    supabase: db,
    bot,
    registerTokenStore: registerToken,
    magicTokenStore: magicToken
  });

  assert.equal(res.outcome, 'start_verified');
  assert.equal(bot.sent.length, 1);
  const msg = bot.sent[0];
  const button = msg.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '🌐 Buka Web Screener');
  assert.match(button.url, /auth_token=mgt_/);
  assert.match(button.url, /user_id=12345/);
});

test('api/login-user magic-login: Consumes token, issues session cookie and bypasses 3-device limit', async () => {
  magicToken.clearMemoryStoreForTesting();
  process.env.SESSION_SECRET = 'test-session-secret-for-magic-login-auth-testing-only-12345';
  const token = await magicToken.issueToken(null, '555666', 'budi');

  const req = {
    method: 'POST',
    headers: { host: 'localhost:3000' },
    query: { action: 'magic-login' },
    body: {
      action: 'magic-login',
      authToken: token,
      userId: '555666',
      deviceId: 'new-device-4'
    }
  };
  const res = mockResponse();

  await loginUserHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.username, 'budi');
  assert.equal(res.body.isAdmin, true);
  assert.ok(res.headers['set-cookie']);
  assert.match(res.headers['set-cookie'], /ac_sess=/);
});

test('api/login-user magic-login: GET request redirects to /?magic_login=1 and sets session cookie', async () => {
  magicToken.clearMemoryStoreForTesting();
  process.env.SESSION_SECRET = 'test-session-secret-for-magic-login-auth-testing-only-12345';
  const token = await magicToken.issueToken(null, '777888', 'budi');

  const req = {
    method: 'GET',
    headers: { host: 'localhost:3000' },
    query: {
      action: 'magic-login',
      auth_token: token,
      user_id: '777888'
    }
  };
  const res = mockResponse();

  await loginUserHandler(req, res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers['location'], '/?magic_login=1');
  assert.ok(res.headers['set-cookie']);
  assert.match(res.headers['set-cookie'], /ac_sess=/);
});

test('api/login-user magic-login: Rejects already consumed token', async () => {
  magicToken.clearMemoryStoreForTesting();
  process.env.SESSION_SECRET = 'test-session-secret-for-magic-login-auth-testing-only-12345';
  const token = await magicToken.issueToken(null, '555666', 'budi');

  // First consumption
  await magicToken.consumeToken(null, token, '555666');

  // Second consumption via API
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3000' },
    query: { action: 'magic-login' },
    body: {
      action: 'magic-login',
      authToken: token,
      userId: '555666',
      deviceId: 'dev-123'
    }
  };
  const res = mockResponse();

  await loginUserHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /tidak valid atau sudah kedaluwarsa/i);
});

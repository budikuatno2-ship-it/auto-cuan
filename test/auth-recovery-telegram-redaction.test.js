'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function withSecret(fn) {
  const previous = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'redaction-test-secret';
  return Promise.resolve(fn()).finally(function () {
    if (previous === undefined) delete process.env.TELEGRAM_VERIFY_CODE_SECRET;
    else process.env.TELEGRAM_VERIFY_CODE_SECRET = previous;
  });
}

test('password completion edits the exact verification-bot message and removes the reset link', async function () {
  const recovery = require('../lib/auth-recovery');
  const edits = [];
  const bot = {
    editMessageText: async function (chatId, messageId, text, options) {
      edits.push({ chatId: chatId, messageId: messageId, text: text, options: options });
    },
    sendMessage: async function () { throw new Error('fallback must not run'); }
  };

  const result = await recovery.notifyPasswordResetCompleted(bot, 77, 9, 'budi');
  assert.deepEqual(result, { updated: true, fallbackSent: false });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].chatId, 77);
  assert.equal(edits[0].messageId, 9);
  assert.match(edits[0].text, /Password berhasil diubah/);
  assert.match(edits[0].text, /Silakan login kembali/);
  assert.equal(edits[0].text.includes('reset_token'), false);
  assert.equal(edits[0].text.includes('https://'), false);
  assert.deepEqual(edits[0].options.reply_markup, { inline_keyboard: [] });
});

test('password completion sends a clean fallback confirmation when Telegram cannot edit', async function () {
  const recovery = require('../lib/auth-recovery');
  const sent = [];
  const bot = {
    editMessageText: async function () { throw new Error('edit failed'); },
    sendMessage: async function (chatId, text) { sent.push({ chatId: chatId, text: text }); }
  };

  const result = await recovery.notifyPasswordResetCompleted(bot, 77, 9, 'budi');
  assert.deepEqual(result, { updated: false, fallbackSent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.includes('reset_token'), false);
  assert.equal(sent[0].text.includes('https://'), false);
});

test('Telegram approval stores the exact private chat and message id through the v2 RPC', async function () {
  await withSecret(async function () {
    const recovery = require('../lib/auth-recovery');
    const captures = [];
    const db = {
      rpc: async function (name, args) {
        captures.push({ name: name, args: args });
        if (name === 'claim_auth_recovery_webhook_update') {
          return { data: [{ claimed: true }], error: null };
        }
        if (name === 'approve_auth_password_reset_request_v2') {
          return { data: [{ result_code: 'ok', user_id: 'u1', username: 'budi', telegram_private_chat_id: 77 }], error: null };
        }
        return { data: null, error: null };
      }
    };
    const bot = {
      answerCallbackQuery: async function () {},
      editMessageText: async function () {},
      sendMessage: async function () {}
    };

    const result = await recovery.handleRecoveryUpdate({
      update_id: 501,
      callback_query: {
        id: 'cb-redaction',
        data: recovery.CALLBACK_APPROVE_PREFIX + 'RequestRef_456',
        from: { id: 88 },
        message: { message_id: 19, chat: { id: 77, type: 'private' } }
      }
    }, { db: db, bot: bot, baseUrl: 'https://autocuan.web.id' });

    assert.equal(result.outcome, 'reset_approved');
    const approval = captures.find(function (entry) {
      return entry.name === 'approve_auth_password_reset_request_v2';
    });
    assert.ok(approval);
    assert.equal(approval.args.p_message_chat_id, 77);
    assert.equal(approval.args.p_message_id, 19);
    assert.match(approval.args.p_reset_token_hash, /^[a-f0-9]{64}$/);
  });
});

test('SQL and endpoint contracts preserve device retirement and redact Telegram after completion', function () {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'auth-recovery-v1-telegram-message-redaction-hotfix.sql'),
    'utf8'
  );
  // api/reset-password.js is now a thin routing gateway (shared Vercel Function
  // slot); the actual reset logic lives in lib/reset-password-legacy-handler.js.
  const endpoint = fs.readFileSync(path.join(ROOT, 'lib', 'reset-password-legacy-handler.js'), 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS reset_message_chat_id bigint/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reset_message_id bigint/);
  assert.match(sql, /approve_auth_password_reset_request_v2/);
  assert.match(sql, /consume_auth_password_reset_v2/);
  assert.match(sql, /device_id = 'retired_'/);
  assert.equal(sql.includes("devices = '[]'::jsonb"), true);
  assert.equal(sql.includes('REVOKE ALL ON FUNCTION public.approve_auth_password_reset_request_v2'), true);
  assert.equal(sql.includes('REVOKE ALL ON FUNCTION public.consume_auth_password_reset_v2'), true);
  assert.equal(sql.includes('FROM PUBLIC, anon, authenticated;'), true);
  assert.equal(sql.includes('TO service_role;'), true);
  assert.match(endpoint, /consume_auth_password_reset_v2/);
  assert.match(endpoint, /notifyPasswordResetCompleted/);
  assert.match(endpoint, /telegram_completion_notified_at/);
});

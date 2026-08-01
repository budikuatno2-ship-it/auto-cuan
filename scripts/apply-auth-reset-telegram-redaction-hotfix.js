'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(ROOT, rel), content, 'utf8');
  console.log('UPDATED=' + rel);
}

function replaceOnce(rel, before, after) {
  const current = read(rel);
  if (current.includes(after)) {
    console.log('ALREADY_PATCHED=' + rel);
    return;
  }
  const count = current.split(before).length - 1;
  if (count !== 1) {
    throw new Error(rel + ': expected replacement count 1, got ' + count);
  }
  write(rel, current.replace(before, after));
}

function writeNew(rel, content) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) {
    const current = fs.readFileSync(full, 'utf8');
    if (current === content) {
      console.log('ALREADY_PRESENT=' + rel);
      return;
    }
    throw new Error(rel + ': already exists with different content');
  }
  fs.writeFileSync(full, content, 'utf8');
  console.log('CREATED=' + rel);
}

const completedHelpers = `function passwordResetCompletedMessage(username) {
  return [
    '✅ Password berhasil diubah',
    '',
    'Akun Auto-Cuan: ' + String(username || '').trim().toLowerCase(),
    'Silakan login kembali ke website menggunakan password baru.'
  ].join('\\n');
}

async function notifyPasswordResetCompleted(bot, chatId, messageId, username) {
  const numericChatId = Number(chatId);
  const numericMessageId = Number(messageId);
  const result = { updated: false, fallbackSent: false };
  if (!bot || !Number.isSafeInteger(numericChatId) || !Number.isSafeInteger(numericMessageId)) {
    return result;
  }

  const text = passwordResetCompletedMessage(username);
  try {
    await bot.editMessageText(numericChatId, numericMessageId, text, {
      reply_markup: { inline_keyboard: [] }
    });
    result.updated = true;
    return result;
  } catch (_) {}

  try {
    await bot.sendMessage(numericChatId, text);
    result.fallbackSent = true;
  } catch (_) {}
  return result;
}

`;

replaceOnce(
  'lib/auth-recovery.js',
  `async function createPasswordResetRequest(db, bot, username) {`,
  completedHelpers + `async function createPasswordResetRequest(db, bot, username) {`
);

replaceOnce(
  'lib/auth-recovery.js',
  `  const row = await rpc(db, 'approve_auth_password_reset_request', {
    p_request_ref: requestRef,
    p_telegram_user_id: from.id,
    p_reset_token_hash: resetTokenHash,
    p_reset_expires_at: resetExpiresAt
  });`,
  `  const row = await rpc(db, 'approve_auth_password_reset_request_v2', {
    p_request_ref: requestRef,
    p_telegram_user_id: from.id,
    p_reset_token_hash: resetTokenHash,
    p_reset_expires_at: resetExpiresAt,
    p_message_chat_id: chat.id,
    p_message_id: message.message_id
  });`
);

replaceOnce(
  'lib/auth-recovery.js',
  `  createPasswordResetRequest,
  createAdminEnrollment,
  handleRecoveryUpdate,`,
  `  createPasswordResetRequest,
  createAdminEnrollment,
  passwordResetCompletedMessage,
  notifyPasswordResetCompleted,
  handleRecoveryUpdate,`
);

replaceOnce(
  'api/reset-password.js',
  `  const result = await db.rpc('consume_auth_password_reset', {`,
  `  const result = await db.rpc('consume_auth_password_reset_v2', {`
);

replaceOnce(
  'api/reset-password.js',
  `  clearSession(res);
  return res.status(200).json({
    success: true,
    username: row.username,
    message: 'Password berhasil diperbarui. Silakan login menggunakan password baru.'
  });`,
  `  let telegramNotice = { updated: false, fallbackSent: false };
  try {
    telegramNotice = await recovery.notifyPasswordResetCompleted(
      createVerifyBot(),
      row.reset_message_chat_id,
      row.reset_message_id,
      row.username
    );
  } catch (_) {}

  if (telegramNotice.updated || telegramNotice.fallbackSent) {
    try {
      await db
        .from('auth_recovery_requests')
        .update({ telegram_completion_notified_at: new Date().toISOString() })
        .eq('id', row.request_id);
    } catch (_) {}
  }

  clearSession(res);
  return res.status(200).json({
    success: true,
    username: row.username,
    telegram_confirmation_updated: telegramNotice.updated === true,
    message: 'Password berhasil diperbarui. Silakan login menggunakan password baru.'
  });`
);

const migration = `-- =========================================================================
-- Authentication recovery v1 — Telegram reset-link redaction hotfix
--
-- Apply AFTER:
--   1. auth-telegram-recovery-v1-migration.sql
--   2. auth-telegram-recovery-v1-device-retirement-hotfix.sql
--
-- Stores the exact private Telegram message that contains the one-time reset
-- link. After the website consumes the reset token, the API edits that message
-- into a password-changed confirmation so the token is no longer displayed.
-- Existing v1 RPCs remain available for rollback compatibility.
-- =========================================================================

BEGIN;

ALTER TABLE public.auth_recovery_requests
  ADD COLUMN IF NOT EXISTS reset_message_chat_id bigint,
  ADD COLUMN IF NOT EXISTS reset_message_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_completion_notified_at timestamptz;

CREATE OR REPLACE FUNCTION public.approve_auth_password_reset_request_v2(
  p_request_ref text,
  p_telegram_user_id bigint,
  p_reset_token_hash text,
  p_reset_expires_at timestamptz,
  p_message_chat_id bigint,
  p_message_id bigint
)
RETURNS TABLE (
  result_code text,
  user_id uuid,
  username text,
  telegram_private_chat_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.auth_recovery_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
  v_ver public.app_user_telegram_verifications%ROWTYPE;
BEGIN
  SELECT r.* INTO v_request
    FROM public.auth_recovery_requests AS r
   WHERE r.request_ref = p_request_ref
     AND r.purpose = 'password_reset'
     AND r.state = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.auth_recovery_requests AS r
       SET state = 'expired', updated_at = now()
     WHERE r.id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT v.* INTO v_ver
    FROM public.app_user_telegram_verifications AS v
   WHERE v.user_id = v_request.user_id
     AND v.telegram_user_id = p_telegram_user_id
     AND v.telegram_private_chat_id = p_message_chat_id
     AND v.telegram_verified_at IS NOT NULL;

  IF NOT FOUND OR p_message_id IS NULL OR p_message_id <= 0 THEN
    RETURN QUERY SELECT 'identity_mismatch'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT u.* INTO v_user
    FROM public.app_users AS u
   WHERE u.id = v_request.user_id
     AND u.is_blocked IS DISTINCT FROM TRUE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.auth_recovery_requests AS r
     SET state = 'approved',
         reset_token_hash = p_reset_token_hash,
         reset_message_chat_id = p_message_chat_id,
         reset_message_id = p_message_id,
         expires_at = LEAST(p_reset_expires_at, now() + interval '15 minutes'),
         approved_at = now(),
         updated_at = now()
   WHERE r.id = v_request.id;

  RETURN QUERY SELECT 'ok'::text, v_user.id, v_user.username, v_ver.telegram_private_chat_id;
END
$$;

CREATE OR REPLACE FUNCTION public.consume_auth_password_reset_v2(
  p_reset_token_hash text,
  p_new_password_hash text
)
RETURNS TABLE (
  result_code text,
  request_id uuid,
  user_id uuid,
  username text,
  reset_message_chat_id bigint,
  reset_message_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.auth_recovery_requests%ROWTYPE;
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT r.* INTO v_request
    FROM public.auth_recovery_requests AS r
   WHERE r.purpose = 'password_reset'
     AND r.state = 'approved'
     AND r.reset_token_hash = p_reset_token_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF v_request.expires_at <= now() THEN
    UPDATE public.auth_recovery_requests AS r
       SET state = 'expired', updated_at = now()
     WHERE r.id = v_request.id;
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  SELECT u.* INTO v_user
    FROM public.app_users AS u
   WHERE u.id = v_request.user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.is_blocked IS TRUE THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.app_users AS u
     SET password_hash = p_new_password_hash,
         device_id = 'retired_' || pg_catalog.gen_random_uuid()::text,
         devices = '[]'::jsonb,
         last_login_at = now()
   WHERE u.id = v_user.id;

  UPDATE public.auth_recovery_requests AS r
     SET state = 'consumed',
         consumed_at = now(),
         updated_at = now()
   WHERE r.id = v_request.id;

  RETURN QUERY SELECT 'ok'::text,
                      v_request.id,
                      v_user.id,
                      v_user.username,
                      v_request.reset_message_chat_id,
                      v_request.reset_message_id;
END
$$;

REVOKE ALL ON FUNCTION public.approve_auth_password_reset_request_v2(
  text,bigint,text,timestamptz,bigint,bigint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_auth_password_reset_request_v2(
  text,bigint,text,timestamptz,bigint,bigint
) TO service_role;

REVOKE ALL ON FUNCTION public.consume_auth_password_reset_v2(text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_auth_password_reset_v2(text,text)
  TO service_role;

COMMIT;
`;

writeNew('supabase/auth-recovery-v1-telegram-message-redaction-hotfix.sql', migration);

const testFile = `'use strict';

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
  assert.doesNotMatch(edits[0].text, /reset_token|https:\/\//);
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
  assert.doesNotMatch(sent[0].text, /reset_token|https:\/\//);
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
  const endpoint = fs.readFileSync(path.join(ROOT, 'api', 'reset-password.js'), 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS reset_message_chat_id bigint/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reset_message_id bigint/);
  assert.match(sql, /approve_auth_password_reset_request_v2/);
  assert.match(sql, /consume_auth_password_reset_v2/);
  assert.match(sql, /device_id = 'retired_'/);
  assert.equal(sql.includes("devices = '[]'::jsonb"), true);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(endpoint, /consume_auth_password_reset_v2/);
  assert.match(endpoint, /notifyPasswordResetCompleted/);
  assert.match(endpoint, /telegram_completion_notified_at/);
});
`;

writeNew('test/auth-recovery-telegram-redaction.test.js', testFile);

console.log('PATCH_STATUS=PASS');
console.log('PRODUCTION_CHANGE=NONE');
console.log('DATABASE_CHANGE=NONE');

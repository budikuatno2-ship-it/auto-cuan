'use strict';

const crypto = require('crypto');

const COMMAND_RE = /^\/akses(?:@[\w_]+)?$/i;
const CODE_TTL_MS = 2 * 60 * 1000;

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function codeSecret() {
  const value = process.env.SESSION_SECRET;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(value) {
  const secret = codeSecret();
  if (!secret || !/^\d{6}$/.test(String(value || ''))) return null;
  return crypto
    .createHmac('sha256', secret)
    .update('autocuan-admin-maintenance-code-v1:' + String(value), 'utf8')
    .digest('hex');
}

async function rpc(db, name, args) {
  const result = await db.rpc(name, args || {});
  if (result && result.error) {
    const error = new Error('rpc_error');
    error.rpc = name;
    error.code = result.error.code || null;
    throw error;
  }
  return firstRow(result && result.data);
}

async function featureAvailable(db) {
  try {
    const result = await db.rpc('get_admin_maintenance_code_status');
    return !(result && result.error);
  } catch (_) {
    return false;
  }
}

async function claimWebhookUpdate(db, updateId) {
  const row = await rpc(db, 'claim_auth_recovery_webhook_update', { p_update_id: updateId });
  return !!(row && row.claimed);
}

async function completeWebhookUpdate(db, updateId, outcome) {
  try {
    await db.rpc('complete_auth_recovery_webhook_update', {
      p_update_id: updateId,
      p_outcome_code: String(outcome || 'unknown').slice(0, 80)
    });
  } catch (_) {}
}

function formatWibTimestamp(date) {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(date) + ' WIB';
  } catch (_) {
    return date.toISOString();
  }
}

function codeMessage(code, expiresAt) {
  const expiry = expiresAt ? formatWibTimestamp(new Date(expiresAt)) : 'sekitar 2 menit';
  return [
    '🔐 Kode akses administrator Auto-Cuan',
    '',
    'Kode: ' + code,
    '',
    'Masukkan 6 digit ini di halaman maintenance autocuan.web.id.',
    'Berlaku sampai: ' + expiry,
    'Kode hanya bisa dipakai sekali dan maksimal 5 percobaan.',
    '',
    'Setelah login berhasil, pesan kode akan dihapus otomatis.'
  ].join('\n');
}

async function cleanupOldMessages(db, bot, telegramUserId, keepGrantId) {
  try {
    const result = await db
      .from('admin_command_login_grants')
      .select('id,telegram_code_chat_id,telegram_code_message_id,telegram_success_message_id')
      .eq('telegram_user_id', telegramUserId)
      .eq('grant_purpose', 'maintenance_code')
      .is('telegram_messages_cleaned_at', null)
      .neq('id', keepGrantId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (result.error) return;

    for (const row of result.data || []) {
      const chatId = Number(row.telegram_code_chat_id);
      if (Number.isSafeInteger(chatId)) {
        for (const messageId of [row.telegram_code_message_id, row.telegram_success_message_id]) {
          if (!Number.isSafeInteger(Number(messageId))) continue;
          try { await bot.deleteMessage(chatId, Number(messageId)); } catch (_) {}
        }
      }
      try {
        await db
          .from('admin_command_login_grants')
          .update({ telegram_messages_cleaned_at: new Date().toISOString() })
          .eq('id', row.id);
      } catch (_) {}
    }
  } catch (_) {}
}

function matchesUpdate(update) {
  if (!update || !Number.isSafeInteger(update.update_id)) return false;
  const message = update.message;
  return !!(
    message && message.chat && message.chat.type === 'private' &&
    typeof message.text === 'string' && COMMAND_RE.test(message.text.trim())
  );
}

async function handleUpdate(update, options) {
  const db = options && options.db;
  const bot = options && options.bot;
  if (!db || !bot || !matchesUpdate(update)) {
    return { handled: false, outcome: 'not_admin_maintenance_code' };
  }

  // Safe rollout: before the SQL migration exists, return handled:false so the
  // established zero-link /akses flow continues to work unchanged.
  if (!(await featureAvailable(db))) {
    return { handled: false, outcome: 'admin_maintenance_code_schema_unavailable' };
  }

  const message = update.message;
  const from = message.from || {};
  const chat = message.chat || {};
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id)) {
    return { handled: false, outcome: 'not_admin_maintenance_code' };
  }

  const claimed = await claimWebhookUpdate(db, update.update_id);
  if (!claimed) return { handled: true, outcome: 'duplicate' };

  let outcome = 'admin_maintenance_code_failed';
  try {
    const code = generateCode();
    const tokenHash = hashCode(code);
    if (!tokenHash) {
      try { await bot.sendMessage(chat.id, 'Akses admin sementara belum tersedia.'); } catch (_) {}
      outcome = 'admin_maintenance_code_secret_missing';
      return { handled: true, outcome };
    }

    const row = await rpc(db, 'issue_admin_maintenance_code', {
      p_telegram_user_id: from.id,
      p_token_hash: tokenHash,
      p_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString()
    });

    if (!row || row.result_code !== 'ok' || !row.grant_id) {
      const text = row && row.result_code === 'identity_mismatch'
        ? 'Perintah ini hanya tersedia untuk administrator terverifikasi.'
        : 'Kode akses sementara belum bisa dibuat. Coba /akses lagi.';
      try { await bot.sendMessage(chat.id, text); } catch (_) {}
      outcome = 'admin_maintenance_code_' + String(row && row.result_code || 'issue_failed');
      return { handled: true, outcome };
    }

    await cleanupOldMessages(db, bot, from.id, row.grant_id);

    const sent = await bot.sendMessage(chat.id, codeMessage(code, row.expires_at));
    if (sent && Number.isSafeInteger(Number(sent.message_id))) {
      try {
        await rpc(db, 'record_admin_maintenance_code_message', {
          p_grant_id: row.grant_id,
          p_telegram_user_id: from.id,
          p_telegram_chat_id: chat.id,
          p_telegram_message_id: Number(sent.message_id)
        });
      } catch (_) {}
    }

    outcome = 'admin_maintenance_code_sent';
    return { handled: true, outcome };
  } catch (_) {
    try { await bot.sendMessage(chat.id, 'Kode akses sementara belum tersedia. Coba lagi sebentar.'); } catch (_) {}
    return { handled: true, outcome };
  } finally {
    await completeWebhookUpdate(db, update.update_id, outcome);
  }
}

module.exports = {
  COMMAND_RE,
  CODE_TTL_MS,
  generateCode,
  hashCode,
  featureAvailable,
  codeMessage,
  matchesUpdate,
  handleUpdate,
  __test: {
    cleanupOldMessages,
    formatWibTimestamp
  }
};

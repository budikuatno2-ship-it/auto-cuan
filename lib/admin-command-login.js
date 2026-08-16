'use strict';

// Telegram-command-first administrator login.
//
// /akses is accepted only from the Telegram identity already verified for the
// existing admin account `budi`. The website itself never triggers a Telegram
// message. The command returns two choices:
//   - HP: a short-lived one-time URL that issues the existing signed ac_sess.
//   - Laptop: a short-lived grant for the single trusted laptop device. The
//     maintenance tab polls with an HttpOnly device cookie and unlocks itself.
//
// A laptop is paired once, without typing a code: if no laptop is bound yet,
// choosing Laptop returns a one-time pairing URL that must be opened on that
// laptop. Pairing both binds the random device cookie and logs in immediately.

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://autocuan.web.id';
const LOGIN_TTL_MS = 2 * 60 * 1000;
const COMMAND_RE = /^\/akses(?:@[\w_]+)?$/i;
const LAPTOP_CALLBACK = 'admin_cmd_laptop';
const TOKEN_RE = /^[A-Za-z0-9_-]{32,100}$/;

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function rpc(db, name, args) {
  const result = await db.rpc(name, args);
  if (result && result.error) {
    const error = new Error('rpc_error');
    error.rpc = name;
    error.code = result.error.code || null;
    throw error;
  }
  return firstRow(result && result.data);
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalBaseUrl() {
  const configured = String(process.env.AUTH_RECOVERY_BASE_URL || '').trim();
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === 'https:' && u.hostname === 'autocuan.web.id') return 'https://autocuan.web.id';
    } catch (_) {}
  }
  return DEFAULT_BASE_URL;
}

function loginUrl(token) {
  return canonicalBaseUrl() + '/api/reset-password?action=admin-command-login&token=' + encodeURIComponent(token);
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

async function adminContext(db, telegramUserId) {
  return await rpc(db, 'get_admin_command_login_context', {
    p_telegram_user_id: telegramUserId
  });
}

async function createGrant(db, telegramUserId, target, rawToken) {
  const tokenHash = rawToken ? hashToken(rawToken) : null;
  if (rawToken && !tokenHash) return null;
  return await rpc(db, 'create_admin_command_login_grant', {
    p_telegram_user_id: telegramUserId,
    p_target: target,
    p_token_hash: tokenHash,
    p_expires_at: new Date(Date.now() + LOGIN_TTL_MS).toISOString()
  });
}

function commandKeyboard(hpToken) {
  return {
    inline_keyboard: [
      [{ text: '📱 Buka di HP', url: loginUrl(hpToken) }],
      [{ text: '💻 Buka di Laptop', callback_data: LAPTOP_CALLBACK }]
    ]
  };
}

function pairKeyboard(pairToken) {
  return {
    inline_keyboard: [[
      { text: '💻 Hubungkan & Buka Auto-Cuan', url: loginUrl(pairToken) }
    ]]
  };
}

async function answerCallback(bot, callbackId, text) {
  try { await bot.answerCallbackQuery(callbackId, { text: text }); } catch (_) {}
}

async function handleAccessCommand(update, db, bot, message) {
  const from = message.from || {};
  const chat = message.chat || {};
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id)) {
    return { handled: false, outcome: 'not_admin_command_login' };
  }

  const claimed = await claimWebhookUpdate(db, update.update_id);
  if (!claimed) return { handled: true, outcome: 'duplicate' };

  let outcome = 'admin_command_login_failed';
  try {
    const ctx = await adminContext(db, from.id);
    if (!ctx || ctx.result_code !== 'ok') {
      try { await bot.sendMessage(chat.id, 'Perintah ini hanya tersedia untuk administrator terverifikasi.'); } catch (_) {}
      outcome = 'admin_command_login_identity_mismatch';
      return { handled: true, outcome: outcome };
    }

    // Create the HP link only because the verified admin explicitly sent
    // /akses. Merely loading the public website can never create this grant.
    const hpToken = randomToken();
    const grant = await createGrant(db, from.id, 'direct', hpToken);
    if (!grant || grant.result_code !== 'ok') {
      try { await bot.sendMessage(chat.id, 'Akses sementara belum bisa dibuat. Coba /akses lagi.'); } catch (_) {}
      outcome = 'admin_command_login_grant_failed';
      return { handled: true, outcome: outcome };
    }

    const laptopText = ctx.device_bound === true
      ? 'Laptop utama sudah terhubung.'
      : 'Laptop utama belum terhubung. Saat pertama memilih Laptop, bot akan memberi satu tombol untuk menghubungkannya tanpa kode.';

    await bot.sendMessage(
      chat.id,
      ['🔐 Akses administrator Auto-Cuan', '', 'Identitas admin terverifikasi.', laptopText, '', 'Pilih perangkat yang ingin dibuka:'].join('\n'),
      { reply_markup: commandKeyboard(hpToken) }
    );
    outcome = 'admin_command_login_menu_sent';
    return { handled: true, outcome: outcome };
  } catch (_) {
    try { await bot.sendMessage(chat.id, 'Akses sementara belum tersedia. Coba lagi sebentar.'); } catch (_) {}
    return { handled: true, outcome: outcome };
  } finally {
    await completeWebhookUpdate(db, update.update_id, outcome);
  }
}

async function handleLaptopCallback(update, db, bot, callback) {
  const from = callback.from || {};
  const message = callback.message || {};
  const chat = message.chat || {};
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(message.message_id)) {
    return { handled: false, outcome: 'not_admin_command_login' };
  }

  const claimed = await claimWebhookUpdate(db, update.update_id);
  if (!claimed) {
    await answerCallback(bot, callback.id, 'Sudah diproses.');
    return { handled: true, outcome: 'duplicate' };
  }

  let outcome = 'admin_command_laptop_failed';
  try {
    const ctx = await adminContext(db, from.id);
    if (!ctx || ctx.result_code !== 'ok') {
      await answerCallback(bot, callback.id, 'Akun Telegram ini bukan admin terverifikasi.');
      outcome = 'admin_command_laptop_identity_mismatch';
      return { handled: true, outcome: outcome };
    }

    if (ctx.device_bound === true) {
      const grant = await createGrant(db, from.id, 'device', null);
      if (!grant || grant.result_code !== 'ok') {
        await answerCallback(bot, callback.id, 'Laptop belum bisa dibuka. Coba /akses lagi.');
        outcome = 'admin_command_laptop_grant_failed';
        return { handled: true, outcome: outcome };
      }

      await answerCallback(bot, callback.id, 'Perintah dikirim ke Laptop utama.');
      try {
        await bot.editMessageText(
          chat.id,
          message.message_id,
          '✅ Perintah login dikirim ke Laptop utama.\n\nJika autocuan.web.id sedang terbuka di laptop, tab akan masuk otomatis beberapa detik lagi.',
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch (_) {}
      outcome = 'admin_command_laptop_granted';
      return { handled: true, outcome: outcome };
    }

    // First-use bootstrap only. No numeric code: the verified admin gets one
    // short-lived URL and opens it on the laptop to bind its HttpOnly device
    // cookie. Future /akses -> Laptop is one tap and fully automatic.
    const pairToken = randomToken();
    const grant = await createGrant(db, from.id, 'pair', pairToken);
    if (!grant || grant.result_code !== 'ok') {
      await answerCallback(bot, callback.id, 'Laptop belum bisa dihubungkan. Coba /akses lagi.');
      outcome = 'admin_command_laptop_pair_failed';
      return { handled: true, outcome: outcome };
    }

    await answerCallback(bot, callback.id, 'Hubungkan laptop satu kali.');
    try {
      await bot.editMessageText(
        chat.id,
        message.message_id,
        '💻 Laptop utama belum terhubung.\n\nBuka tombol di bawah dari laptop ini satu kali. Tidak ada kode yang perlu diketik. Setelah terhubung, pilihan Laptop berikutnya akan otomatis membuka tab Auto-Cuan yang sedang aktif.',
        { reply_markup: pairKeyboard(pairToken) }
      );
    } catch (_) {}
    outcome = 'admin_command_laptop_pair_ready';
    return { handled: true, outcome: outcome };
  } catch (_) {
    await answerCallback(bot, callback.id, 'Terjadi gangguan. Coba /akses lagi.');
    return { handled: true, outcome: outcome };
  } finally {
    await completeWebhookUpdate(db, update.update_id, outcome);
  }
}

function matchesUpdate(update) {
  if (!update || !Number.isSafeInteger(update.update_id)) return false;
  const callback = update.callback_query;
  if (callback && callback.data === LAPTOP_CALLBACK) return true;
  const message = update.message;
  return !!(
    message && message.chat && message.chat.type === 'private' &&
    typeof message.text === 'string' && COMMAND_RE.test(message.text.trim())
  );
}

async function handleUpdate(update, options) {
  const db = options && options.db;
  const bot = options && options.bot;
  if (!db || !bot || !matchesUpdate(update)) return { handled: false, outcome: 'not_admin_command_login' };

  if (update.callback_query && update.callback_query.data === LAPTOP_CALLBACK) {
    return handleLaptopCallback(update, db, bot, update.callback_query);
  }
  return handleAccessCommand(update, db, bot, update.message);
}

module.exports = {
  DEFAULT_BASE_URL,
  LOGIN_TTL_MS,
  COMMAND_RE,
  LAPTOP_CALLBACK,
  TOKEN_RE,
  randomToken,
  hashToken,
  loginUrl,
  matchesUpdate,
  handleUpdate,
  __test: {
    commandKeyboard,
    pairKeyboard,
    canonicalBaseUrl,
    adminContext,
    createGrant
  }
};

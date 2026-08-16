'use strict';

// Zero-link first pairing layer for Telegram /akses.
//
// Existing paired-device and direct-HP login behavior stays in
// admin-command-login.js. This layer only replaces the FIRST laptop pairing:
// the already-open /dashboard maintenance tab registers a hashed browser
// pairing request, and the verified admin approves that exact request via a
// Telegram callback. No URL or numeric code is used for laptop pairing.

const commandLogin = require('./admin-command-login');

const PAIR_CALLBACK_PREFIX = 'admin_pair:';
const REQUEST_REF_RE = /^[A-Za-z0-9_-]{20,60}$/;

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

async function pairCandidate(db, telegramUserId) {
  return rpc(db, 'get_admin_command_pair_candidate', {
    p_telegram_user_id: telegramUserId
  });
}

async function approvePair(db, telegramUserId, requestRef) {
  return rpc(db, 'approve_admin_command_pair_request', {
    p_telegram_user_id: telegramUserId,
    p_request_ref: requestRef
  });
}

async function answerCallback(bot, callbackId, text) {
  try { await bot.answerCallbackQuery(callbackId, { text: text }); } catch (_) {}
}

function hpButton(hpToken) {
  return { text: '📱 Buka di HP', url: commandLogin.loginUrl(hpToken) };
}

function pairButton(candidate) {
  return {
    text: '💻 Hubungkan Laptop · ' + candidate.display_tag,
    callback_data: PAIR_CALLBACK_PREFIX + candidate.request_ref
  };
}

async function sendUnpairedMenu(update, options, message, ctx) {
  const db = options.db;
  const bot = options.bot;
  const from = message.from || {};
  const chat = message.chat || {};

  const claimed = await claimWebhookUpdate(db, update.update_id);
  if (!claimed) return { handled: true, outcome: 'duplicate' };

  let outcome = 'admin_zero_link_menu_failed';
  try {
    if (!ctx || ctx.result_code !== 'ok') {
      try { await bot.sendMessage(chat.id, 'Perintah ini hanya tersedia untuk administrator terverifikasi.'); } catch (_) {}
      outcome = 'admin_zero_link_identity_mismatch';
      return { handled: true, outcome: outcome };
    }

    const hpToken = commandLogin.randomToken();
    const grant = await commandLogin.__test.createGrant(db, from.id, 'direct', hpToken);
    if (!grant || grant.result_code !== 'ok') {
      try { await bot.sendMessage(chat.id, 'Akses sementara belum bisa dibuat. Coba /akses lagi.'); } catch (_) {}
      outcome = 'admin_zero_link_hp_grant_failed';
      return { handled: true, outcome: outcome };
    }

    const candidate = await pairCandidate(db, from.id);
    const keyboard = [[hpButton(hpToken)]];
    let laptopText;

    if (candidate && candidate.result_code === 'ok' && REQUEST_REF_RE.test(String(candidate.request_ref || ''))) {
      keyboard.push([pairButton(candidate)]);
      laptopText = [
        '💻 Laptop siap dihubungkan: ' + String(candidate.device_label || 'Laptop utama'),
        'ID perangkat: ' + String(candidate.display_tag || ''),
        'Pastikan ID ini sama dengan yang tampil di halaman maintenance laptop.'
      ].join('\n');
    } else if (candidate && candidate.result_code === 'ambiguous') {
      laptopText = [
        '⚠️ Ada lebih dari satu browser yang sedang meminta pairing.',
        'Tutup tab Auto-Cuan lain, tunggu sekitar 2 menit, lalu kirim /akses lagi.',
        'Tidak ada perangkat yang dihubungkan.'
      ].join('\n');
    } else {
      laptopText = [
        '💻 Laptop belum terdeteksi.',
        'Buka autocuan.web.id/dashboard di laptop dan biarkan halaman maintenance terbuka beberapa detik, lalu kirim /akses lagi.'
      ].join('\n');
    }

    await bot.sendMessage(
      chat.id,
      ['🔐 Akses administrator Auto-Cuan', '', 'Identitas admin terverifikasi.', '', laptopText, '', 'Pilih perangkat:'].join('\n'),
      { reply_markup: { inline_keyboard: keyboard } }
    );
    outcome = 'admin_zero_link_menu_sent';
    return { handled: true, outcome: outcome };
  } catch (_) {
    try { await bot.sendMessage(chat.id, 'Akses sementara belum tersedia. Coba lagi sebentar.'); } catch (_) {}
    return { handled: true, outcome: outcome };
  } finally {
    await completeWebhookUpdate(db, update.update_id, outcome);
  }
}

async function finishPairCallback(update, options, callback, requestRef) {
  const db = options.db;
  const bot = options.bot;
  const from = callback.from || {};
  const message = callback.message || {};
  const chat = message.chat || {};

  const claimed = await claimWebhookUpdate(db, update.update_id);
  if (!claimed) {
    await answerCallback(bot, callback.id, 'Sudah diproses.');
    return { handled: true, outcome: 'duplicate' };
  }

  let outcome = 'admin_zero_link_pair_failed';
  try {
    const approved = await approvePair(db, from.id, requestRef);
    if (!approved || approved.result_code !== 'ok') {
      const code = approved && approved.result_code;
      const text = code === 'ambiguous'
        ? 'Ada lebih dari satu browser. Pairing dibatalkan demi keamanan.'
        : 'Permintaan laptop sudah tidak aktif. Buka dashboard lalu /akses lagi.';
      await answerCallback(bot, callback.id, text);
      outcome = 'admin_zero_link_pair_' + String(code || 'failed');
      return { handled: true, outcome: outcome };
    }

    await answerCallback(bot, callback.id, 'Laptop disetujui.');
    try {
      await bot.editMessageText(
        chat.id,
        message.message_id,
        [
          '✅ Laptop disetujui.',
          '',
          String(approved.device_label || 'Laptop utama') + ' · ID ' + String(approved.display_tag || ''),
          'Tab Auto-Cuan yang sedang terbuka akan terhubung dan login otomatis dalam beberapa detik.',
          '',
          'Tidak ada link atau kode yang perlu dibuka.'
        ].join('\n'),
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) {}
    outcome = 'admin_zero_link_pair_approved';
    return { handled: true, outcome: outcome };
  } catch (_) {
    await answerCallback(bot, callback.id, 'Pairing sementara gagal. Coba /akses lagi.');
    return { handled: true, outcome: outcome };
  } finally {
    await completeWebhookUpdate(db, update.update_id, outcome);
  }
}

async function handleOldLaptopCallback(update, options, callback, ctx) {
  // Once paired, preserve the established device-grant flow exactly.
  if (ctx && ctx.result_code === 'ok' && ctx.device_bound === true) {
    return commandLogin.handleUpdate(update, options);
  }

  const candidate = await pairCandidate(options.db, callback.from.id);
  if (candidate && candidate.result_code === 'ok' && REQUEST_REF_RE.test(String(candidate.request_ref || ''))) {
    // Old Telegram messages that still contain the pre-zero-link Laptop button
    // can safely approve the one live browser request instead of generating the
    // old pairing URL.
    return finishPairCallback(update, options, callback, candidate.request_ref);
  }

  const claimed = await claimWebhookUpdate(options.db, update.update_id);
  if (!claimed) {
    await answerCallback(options.bot, callback.id, 'Sudah diproses.');
    return { handled: true, outcome: 'duplicate' };
  }
  let outcome = 'admin_zero_link_pair_not_ready';
  try {
    const msg = candidate && candidate.result_code === 'ambiguous'
      ? 'Ada beberapa browser menunggu. Tutup tab lain dan coba /akses lagi.'
      : 'Buka autocuan.web.id/dashboard di laptop, tunggu beberapa detik, lalu /akses lagi.';
    await answerCallback(options.bot, callback.id, msg);
    return { handled: true, outcome: outcome };
  } finally {
    await completeWebhookUpdate(options.db, update.update_id, outcome);
  }
}

function pairRequestRef(callbackData) {
  if (typeof callbackData !== 'string' || !callbackData.startsWith(PAIR_CALLBACK_PREFIX)) return null;
  const ref = callbackData.slice(PAIR_CALLBACK_PREFIX.length);
  return REQUEST_REF_RE.test(ref) ? ref : null;
}

function matchesUpdate(update) {
  if (!update || !Number.isSafeInteger(update.update_id)) return false;
  const callback = update.callback_query;
  if (callback) {
    if (callback.data === commandLogin.LAPTOP_CALLBACK) return true;
    if (pairRequestRef(callback.data)) return true;
  }
  const message = update.message;
  return !!(
    message && message.chat && message.chat.type === 'private' &&
    typeof message.text === 'string' && commandLogin.COMMAND_RE.test(message.text.trim())
  );
}

async function handleUpdate(update, options) {
  const db = options && options.db;
  const bot = options && options.bot;
  if (!db || !bot || !matchesUpdate(update)) return { handled: false, outcome: 'not_admin_zero_link_pairing' };

  if (update.message) {
    const from = update.message.from || {};
    if (!Number.isSafeInteger(from.id)) return { handled: false, outcome: 'not_admin_zero_link_pairing' };
    const ctx = await commandLogin.__test.adminContext(db, from.id);
    if (ctx && ctx.result_code === 'ok' && ctx.device_bound === true) {
      return commandLogin.handleUpdate(update, options);
    }
    return sendUnpairedMenu(update, options, update.message, ctx);
  }

  const callback = update.callback_query;
  const from = callback.from || {};
  if (!Number.isSafeInteger(from.id)) return { handled: false, outcome: 'not_admin_zero_link_pairing' };

  const ref = pairRequestRef(callback.data);
  if (ref) return finishPairCallback(update, options, callback, ref);

  if (callback.data === commandLogin.LAPTOP_CALLBACK) {
    const ctx = await commandLogin.__test.adminContext(db, from.id);
    return handleOldLaptopCallback(update, options, callback, ctx);
  }

  return { handled: false, outcome: 'not_admin_zero_link_pairing' };
}

module.exports = {
  PAIR_CALLBACK_PREFIX,
  REQUEST_REF_RE,
  pairRequestRef,
  pairCandidate,
  approvePair,
  matchesUpdate,
  handleUpdate,
  __test: {
    hpButton,
    pairButton
  }
};

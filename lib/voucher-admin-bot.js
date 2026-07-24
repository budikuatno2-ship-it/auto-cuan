'use strict';

const crypto = require('crypto');
const vouchers = require('./vouchers');
const { isVoucherAdminBotEnabled, getVoucherAdminCapability } = require('./subscription-capability');
const { createVoucherAdminSender } = require('./voucher-admin-sender');

const SESSION_TTL_MS = 20 * 60 * 1000;
const CHUNK_SIZE = 100;
const MESSAGE_CODE_LIMIT = 40;
const DOCUMENT_BYTES = 900000;
const TYPES = ['PERCENT_30', 'PERCENT_50', 'PERCENT_100', 'LIFETIME'];
const TERM_PLANS = ['PREMIUM_1_MONTH', 'PREMIUM_2_MONTHS', 'PREMIUM_3_MONTHS'];
const MENU = '🔐 <b>Admin Voucher</b>\nPilih menu atau gunakan /buatvoucher, /daftarvoucher, /detailvoucher, /nonaktifkanvoucher, /auditvoucher, /statistiklifetime, /batal.';

function typeLabel(type) {
  return type === 'LIFETIME' ? 'Lifetime' : type.replace('PERCENT_', '') + '%';
}

function menuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Buat Voucher', callback_data: 'v:begin' }],
      [{ text: 'Daftar Voucher', callback_data: 'v:list' }],
      [{ text: 'Detail Voucher', callback_data: 'v:detail' }],
      [{ text: 'Nonaktifkan Voucher', callback_data: 'v:disable' }],
      [{ text: 'Audit Voucher', callback_data: 'v:audit' }],
      [{ text: 'Statistik Lifetime', callback_data: 'v:stats' }]
    ]
  };
}

function safeReference(prefix) {
  return prefix + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function validRef(value) {
  return typeof value === 'string' && /^(?:VB|VV)-[A-F0-9]{12}$/.test(value);
}

function adminUpdate(update) {
  const q = update && update.callback_query;
  const m = update && (update.message || (q && q.message));
  const from = (q && q.from) || (m && m.from);
  const chat = m && m.chat;
  if (!Number.isSafeInteger(update && update.update_id) || !m || !from || !chat || chat.type !== 'private' ||
      !Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || chat.id !== from.id ||
      !vouchers.isVoucherAdminTelegramUser(from.id) || m.forward_from || m.forward_sender_name || m.sender_chat) return null;
  return { message: m, from, chat, callback: q || null };
}

function parseCommand(text) {
  const match = /^\/(start|menu|buatvoucher|daftarvoucher|detailvoucher|nonaktifkanvoucher|auditvoucher|statistiklifetime|batal)(?:@\w+)?(?:\s+([A-Za-z0-9-]+))?\s*$/i.exec(typeof text === 'string' ? text : '');
  return match && { name: match[1].toLowerCase(), argument: match[2] || null };
}

function formatCodes(codes, batch) {
  return codes.map(code => code + ' | ' + batch.voucher_type + ' | ' + batch.plan_code).join('\n');
}

async function safeRpc(db, name, args) {
  try {
    return await db.rpc(name, args);
  } catch (_) {
    return { error: true, data: null };
  }
}

function attemptArgs(batch, chunk) {
  return {
    p_batch_reference: batch.batch_reference,
    p_chunk_index: chunk.chunk_index,
    p_attempt_id: chunk.attempt_id,
    p_claim_token: chunk.claim_token
  };
}

async function cancelAttempt(db, batch, chunk, reason) {
  if (!chunk || typeof chunk.attempt_id !== 'string' || typeof chunk.claim_token !== 'string' || !Number.isSafeInteger(chunk.chunk_index)) return false;
  const result = await safeRpc(db, 'cancel_voucher_admin_batch_chunk', Object.assign(attemptArgs(batch, chunk), { p_reason: reason }));
  return !result.error && result.data && result.data.cancelled === true;
}

async function markAttemptUncertain(db, batch, chunk) {
  const result = await safeRpc(db, 'mark_voucher_admin_chunk_delivery_uncertain', attemptArgs(batch, chunk));
  return !result.error && result.data && result.data.uncertain === true;
}

async function finalizeAttempt(db, batch, chunk) {
  const result = await safeRpc(db, 'finalize_voucher_admin_batch_chunk', attemptArgs(batch, chunk));
  return !result.error && result.data && result.data.finalized === true ? result.data : null;
}

async function processVoucherAdminUpdate(update, deps) {
  const d = deps || {};
  const db = d.db;
  const sender = d.sender || createVoucherAdminSender(d);
  const cap = d.capability || await getVoucherAdminCapability(db, d.env);
  if (!isVoucherAdminBotEnabled(d.env) || !cap.ready || !db) return { outcome: 'unavailable' };

  const input = adminUpdate(update);
  if (!input) return { outcome: 'ignored' };

  // RPC deliberately stores only update id/outcome, never update/text/callback data.
  const claimed = await db.rpc('claim_voucher_admin_webhook_update', { p_update_id: update.update_id });
  if (claimed.error || claimed.data === false) return { outcome: 'duplicate' };

  const reply = async (text, extra) => sender.sendMessage(input.chat.id, text, extra);
  const command = parseCommand(input.message.text);
  if (command) {
    if (command.name === 'start' || command.name === 'menu') {
      await reply(MENU, { reply_markup: menuKeyboard() });
      return { outcome: 'menu' };
    }
    if (command.name === 'batal') {
      await db.rpc('clear_voucher_admin_session', { p_telegram_user_id: input.from.id });
      await reply('Percakapan voucher dibatalkan.');
      return { outcome: 'cancelled' };
    }
    if (command.name === 'buatvoucher') {
      const result = await db.rpc('start_voucher_admin_session', { p_telegram_user_id: input.from.id, p_expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
      if (result.error) return { outcome: 'failed' };
      await reply('Pilih tipe voucher.', { reply_markup: { inline_keyboard: [TYPES.map(type => ({ text: typeLabel(type), callback_data: 'v:type:' + type }))] } });
      return { outcome: 'started' };
    }
    if (['daftarvoucher', 'detailvoucher', 'nonaktifkanvoucher', 'auditvoucher', 'statistiklifetime'].includes(command.name)) {
      const result = await db.rpc('voucher_admin_command', { p_command: command.name, p_reference: command.argument && validRef(command.argument) ? command.argument : null });
      const message = result.data && typeof result.data.message === 'string' ? result.data.message : 'Operasi admin tidak tersedia.';
      await reply(message);
      return { outcome: result.error ? 'failed' : 'command' };
    }
  }

  if (!input.callback) {
    const quantity = typeof input.message.text === 'string' && /^[1-9][0-9]*$/.test(input.message.text.trim()) ? Number(input.message.text.trim()) : 0;
    if (!Number.isSafeInteger(quantity) || quantity < 1) return { outcome: 'ignored' };
    const advanced = await db.rpc('set_voucher_admin_quantity', { p_telegram_user_id: input.from.id, p_requested_quantity: quantity, p_confirmation_key: crypto.randomUUID() });
    if (advanced.error || !advanced.data) {
      await reply('Jumlah tidak dapat digunakan. Mulai ulang dengan /buatvoucher.');
      return { outcome: 'invalid_quantity' };
    }
    const session = advanced.data;
    const lifetime = session.voucher_type === 'LIFETIME';
    const validSession = TYPES.includes(session.voucher_type) && ((lifetime && session.plan_code === 'LIFETIME') || (!lifetime && TERM_PLANS.includes(session.plan_code)));
    if (!validSession) {
      await reply('Sesi voucher tidak valid. Mulai ulang dengan /buatvoucher.');
      return { outcome: 'invalid_session' };
    }
    const activation = session.voucher_type === 'PERCENT_30' || session.voucher_type === 'PERCENT_50'
      ? 'setelah pembayaran terverifikasi'
      : 'saat voucher digunakan';
    const duration = lifetime ? 'tanpa kedaluwarsa' : session.plan_code.replace('PREMIUM_', '').replace('_MONTHS', ' bulan').replace('_MONTH', ' bulan');
    const summary = '<b>Konfirmasi batch</b>\nTipe: ' + session.voucher_type + '\nPaket: ' + session.plan_code + '\nJumlah: ' + quantity + '\nAktivasi akses: ' + activation + '\nDurasi akses: ' + duration + '\nMaks/kode: 1\nMaks/pengguna: 1' + (lifetime ? '\nJumlah pengguna lifetime tidak dibatasi.' : '');
    await reply(summary, { reply_markup: { inline_keyboard: [[{ text: 'Konfirmasi buat', callback_data: 'v:confirm:' + session.confirmation_key }, { text: 'Batal', callback_data: 'v:cancel' }]] } });
    return { outcome: 'quantity' };
  }

  const data = input.callback.data;
  if (typeof data !== 'string' || !/^v:(?:begin|list|detail|disable|audit|stats|continue:VB-[A-F0-9]{12}|type:(?:PERCENT_30|PERCENT_50|PERCENT_100|LIFETIME)|plan:[A-Z0-9_]+|confirm:[A-Fa-f0-9-]{16,64}|cancel)$/.test(data)) {
    await sender.answerCallbackQuery(input.callback.id, { text: 'Tombol kedaluwarsa.' });
    return { outcome: 'stale' };
  }
  await sender.answerCallbackQuery(input.callback.id);

  if (data === 'v:begin') {
    const result = await db.rpc('start_voucher_admin_session', { p_telegram_user_id: input.from.id, p_expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    if (result.error) return { outcome: 'failed' };
    await reply('Pilih tipe voucher.', { reply_markup: { inline_keyboard: [TYPES.map(type => ({ text: typeLabel(type), callback_data: 'v:type:' + type }))] } });
    return { outcome: 'started' };
  }
  if (data.startsWith('v:type:')) {
    const type = data.slice(7);
    const lifetime = type === 'LIFETIME';
    const result = await db.rpc('advance_voucher_admin_session', { p_telegram_user_id: input.from.id, p_step: lifetime ? 'quantity' : 'plan', p_voucher_type: type, p_plan_code: lifetime ? 'LIFETIME' : null });
    if (result.error) return { outcome: 'failed' };
    if (lifetime) {
      await reply('Paket Lifetime dipilih otomatis. Kirim jumlah voucher sebagai angka bulat positif.');
      return { outcome: 'type' };
    }
    await reply('Pilih paket.', { reply_markup: { inline_keyboard: [TERM_PLANS.map(plan => ({ text: plan, callback_data: 'v:plan:' + plan }))] } });
    return { outcome: 'type' };
  }
  if (data.startsWith('v:plan:')) {
    const plan = data.slice(7);
    if (!TERM_PLANS.includes(plan)) return { outcome: 'stale' };
    const result = await db.rpc('advance_voucher_admin_session', { p_telegram_user_id: input.from.id, p_step: 'quantity', p_voucher_type: null, p_plan_code: plan });
    if (result.error) return { outcome: 'failed' };
    await reply('Kirim jumlah voucher sebagai angka bulat positif.');
    return { outcome: 'plan' };
  }
  if (['v:list', 'v:detail', 'v:disable', 'v:audit'].includes(data)) {
    const commandName = { 'v:list': 'daftarvoucher', 'v:detail': 'detailvoucher', 'v:disable': 'nonaktifkanvoucher', 'v:audit': 'auditvoucher' }[data];
    const result = await db.rpc('voucher_admin_command', { p_command: commandName, p_reference: null });
    await reply(result.data && result.data.message || 'Tidak ada data voucher yang dapat ditampilkan.');
    return { outcome: result.error ? 'failed' : 'command' };
  }
  if (data.startsWith('v:continue:')) return continueBatch(input, d, reply, sender, data.slice(11));
  if (data === 'v:stats') {
    const result = await db.rpc('voucher_admin_command', { p_command: 'statistiklifetime', p_reference: null });
    await reply(result.data && result.data.message || 'Statistik lifetime tidak tersedia.');
    return { outcome: result.error ? 'failed' : 'command' };
  }
  if (data === 'v:cancel') {
    await db.rpc('clear_voucher_admin_session', { p_telegram_user_id: input.from.id });
    await reply('Percakapan voucher dibatalkan.');
    return { outcome: 'cancelled' };
  }
  if (data.startsWith('v:confirm:')) return confirm(input, d, reply, data.slice(10), sender);
  return { outcome: 'menu' };
}

async function deliverOneChunk(input, d, reply, sender, batch) {
  const claim = await safeRpc(d.db, 'claim_voucher_admin_batch_chunk', { p_batch_reference: batch.batch_reference });
  if (claim.error || !claim.data) return { outcome: 'claim_failed', generated: 0 };
  if (claim.data.done === true) return { outcome: 'complete', generated: 0 };

  const chunk = claim.data;
  const count = chunk.expected_count;
  const validClaim = Number.isSafeInteger(count) && count >= 1 && count <= CHUNK_SIZE && Number.isSafeInteger(chunk.chunk_index) && chunk.chunk_index >= 0 && typeof chunk.attempt_id === 'string' && typeof chunk.claim_token === 'string';
  if (!validClaim) {
    await cancelAttempt(d.db, batch, chunk, 'claim_invalid');
    return { outcome: 'claim_invalid', generated: 0 };
  }

  const codes = [];
  let items;
  try {
    for (let i = 0; i < count; i++) codes.push(vouchers.generateVoucherCode());
    items = codes.map(code => ({ code_hash: vouchers.voucherCodeHash(code), code_hint: vouchers.voucherCodeHint(code) }));
  } catch (_) {
    await cancelAttempt(d.db, batch, chunk, 'prepare_input_failed');
    return { outcome: 'prepare_failed', generated: 0 };
  }

  const saved = await safeRpc(d.db, 'prepare_voucher_admin_batch_chunk', Object.assign(attemptArgs(batch, chunk), { p_items: items }));
  if (saved.error || !saved.data || saved.data.prepared !== true || saved.data.attempt_id !== chunk.attempt_id || saved.data.expected_count !== count || saved.data.stored_count !== count) {
    await cancelAttempt(d.db, batch, chunk, 'prepare_failed');
    return { outcome: 'prepare_failed', generated: 0 };
  }

  let sent;
  try {
    sent = count <= MESSAGE_CODE_LIMIT
      ? await reply('<b>' + batch.batch_reference + '</b>\n<pre>' + formatCodes(codes, batch) + '</pre>')
      : await sender.sendDocument(input.chat.id, 'vouchers-' + batch.batch_reference + '-' + chunk.chunk_index + '.txt', Buffer.from(formatCodes(codes, batch), 'utf8'));
  } catch (_) {
    await markAttemptUncertain(d.db, batch, chunk);
    return { outcome: 'delivery_uncertain', generated: 0 };
  }

  const messageId = Number(sent && sent.message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    await markAttemptUncertain(d.db, batch, chunk);
    return { outcome: 'delivery_uncertain', generated: 0 };
  }

  const receipt = await safeRpc(d.db, 'record_voucher_admin_chunk_delivery', Object.assign(attemptArgs(batch, chunk), {
    p_delivery_method: count <= MESSAGE_CODE_LIMIT ? 'message' : 'document',
    p_telegram_message_id: messageId,
    p_delivered_count: count
  }));
  if (receipt.error || !receipt.data || receipt.data.recorded !== true) {
    await markAttemptUncertain(d.db, batch, chunk);
    const reconciled = await finalizeAttempt(d.db, batch, chunk);
    if (reconciled) return { outcome: 'delivered', generated: count, message: reconciled.complete ? '' : ' Lanjutkan: /menu' };
    return { outcome: 'delivery_uncertain', generated: 0 };
  }

  let finalized = await finalizeAttempt(d.db, batch, chunk);
  if (!finalized) finalized = await finalizeAttempt(d.db, batch, chunk);
  if (!finalized) {
    await markAttemptUncertain(d.db, batch, chunk);
    return { outcome: 'delivery_uncertain', generated: 0 };
  }

  return { outcome: 'delivered', generated: count, message: finalized.complete ? '' : ' Lanjutkan: /menu' };
}

async function confirm(input, d, reply, key, sender) {
  const made = await d.db.rpc('create_voucher_admin_batch', { p_telegram_user_id: input.from.id, p_confirmation_key: key });
  if (made.error || !made.data) return { outcome: 'failed' };
  const result = await deliverOneChunk(input, d, reply, sender, made.data);
  if (result.outcome === 'delivered' && result.message) {
    await reply('Bagian dikirim. Gunakan tombol lanjutkan.', { reply_markup: { inline_keyboard: [[{ text: 'Lanjutkan batch', callback_data: 'v:continue:' + made.data.batch_reference }]] } });
  }
  if (made.data.already_exists) result.duplicate_confirmation = true;
  return result;
}

async function continueBatch(input, d, reply, sender, reference) {
  const result = await d.db.rpc('get_voucher_admin_batch_progress', { p_batch_reference: reference });
  if (result.error || !result.data) return { outcome: 'failed' };
  const delivery = await deliverOneChunk(input, d, reply, sender, result.data);
  if (delivery.outcome === 'delivered' && delivery.message) {
    await reply('Bagian dikirim. Lanjutkan batch.', { reply_markup: { inline_keyboard: [[{ text: 'Lanjutkan batch', callback_data: 'v:continue:' + reference }]] } });
  }
  return delivery;
}

module.exports = {
  SESSION_TTL_MS,
  CHUNK_SIZE,
  MESSAGE_CODE_LIMIT,
  DOCUMENT_BYTES,
  TYPES,
  TERM_PLANS,
  MENU,
  typeLabel,
  menuKeyboard,
  safeReference,
  validRef,
  adminUpdate,
  parseCommand,
  processVoucherAdminUpdate,
  confirm,
  continueBatch,
  deliverOneChunk
};

'use strict';

const vouchers = require('./vouchers');
const voucherAdminBot = require('./voucher-admin-bot');
const {
  isVoucherAdminBotEnabled,
  getVoucherAdminCapability
} = require('./subscription-capability');
const { createVoucherAdminSender } = require('./voucher-admin-sender');

const HIDDEN_ADMIN_COMMAND_RE = /^\/(?:voucheradmin|buatvoucher|daftarvoucher|detailvoucher|nonaktifkanvoucher|auditvoucher|statistiklifetime|batal)(?:@[\w_]+)?(?:\s+([A-Za-z0-9-]+))?\s*$/i;
const ADMIN_CALLBACK_RE = /^v:/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;

function privateInput(update) {
  const q = update && update.callback_query;
  const message = update && (update.message || (q && q.message));
  const from = (q && q.from) || (message && message.from);
  const chat = message && message.chat;
  if (!message || !from || !chat || chat.type !== 'private') return null;
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || from.id !== chat.id) return null;
  return { q: q || null, message, from, chat };
}

function isHiddenAdminShape(input) {
  if (!input) return false;
  if (input.q && typeof input.q.data === 'string' && ADMIN_CALLBACK_RE.test(input.q.data)) return true;
  const text = typeof input.message.text === 'string' ? input.message.text.trim() : '';
  return HIDDEN_ADMIN_COMMAND_RE.test(text);
}

async function activeQuantitySession(db, telegramUserId) {
  if (!db || typeof db.from !== 'function' || !Number.isSafeInteger(telegramUserId)) return false;
  try {
    const result = await db.from('voucher_admin_sessions')
      .select('step, expires_at')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (!result || result.error || !result.data) return false;
    if (String(result.data.step || '') !== 'quantity') return false;
    const expiresAt = Date.parse(result.data.expires_at || '');
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  } catch (_) {
    return false;
  }
}

async function safeDelete(bot, chatId, messageId) {
  if (!bot || typeof bot.deleteMessage !== 'function') return false;
  if (!Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return false;
  try {
    await bot.deleteMessage(Number(chatId), Number(messageId));
    return true;
  } catch (_) {
    return false;
  }
}

async function sendPlain(bot, chatId, text) {
  if (!bot || typeof bot.sendMessage !== 'function') return null;
  try { return await bot.sendMessage(chatId, text); } catch (_) { return null; }
}

async function handleUpdate(update, options) {
  const opts = options || {};
  const input = privateInput(update);
  if (!input || !Number.isSafeInteger(update && update.update_id)) {
    return { handled: false, outcome: 'not_voucher_admin_continuation' };
  }

  const admin = vouchers.isVoucherAdminTelegramUser(input.from.id);
  const hiddenShape = isHiddenAdminShape(input);

  // Hidden voucher-admin commands/callbacks must not fall through into public
  // verification when a non-admin somehow types or replays one of the shapes.
  // The normal unified subscription router gets first chance to handle the real
  // admin; this boundary is only the fail-closed backstop.
  if (hiddenShape && !admin) {
    return { handled: true, outcome: 'voucher_admin_hidden_ignored' };
  }

  if (!admin || input.q || typeof input.message.text !== 'string') {
    return { handled: false, outcome: 'not_voucher_admin_continuation' };
  }

  const text = input.message.text.trim();
  if (!text || text.startsWith('/')) {
    return { handled: false, outcome: 'not_voucher_admin_continuation' };
  }

  const quantitySession = await activeQuantitySession(opts.db, input.from.id);
  if (!quantitySession) {
    return { handled: false, outcome: 'no_voucher_quantity_session' };
  }

  // Once the verified admin is explicitly inside the quantity step, own all
  // plain-text input for that step so accidental text cannot be misinterpreted
  // as an account verification code by the downstream legacy handler.
  if (!POSITIVE_INTEGER_RE.test(text)) {
    await sendPlain(opts.bot, input.chat.id, 'Jumlah voucher harus berupa angka bulat positif. Contoh: 1, 10, atau 100.\n\nKetik /batal untuk membatalkan.');
    await safeDelete(opts.bot, input.chat.id, input.message.message_id);
    return { handled: true, outcome: 'voucher_admin_quantity_invalid' };
  }

  if (!isVoucherAdminBotEnabled(opts.env)) {
    await sendPlain(opts.bot, input.chat.id, 'Fitur admin voucher sementara tidak tersedia.');
    await safeDelete(opts.bot, input.chat.id, input.message.message_id);
    return { handled: true, outcome: 'voucher_admin_disabled' };
  }

  let capability = opts.voucherAdminCapability || null;
  if (!capability) {
    try { capability = await getVoucherAdminCapability(opts.db, opts.env); }
    catch (_) { capability = null; }
  }
  if (!capability || capability.ready !== true) {
    await sendPlain(opts.bot, input.chat.id, 'Fitur admin voucher sementara tidak tersedia.');
    await safeDelete(opts.bot, input.chat.id, input.message.message_id);
    return { handled: true, outcome: 'voucher_admin_unavailable' };
  }

  const sender = opts.voucherAdminSender || createVoucherAdminSender({ env: opts.env });
  const result = await voucherAdminBot.processVoucherAdminUpdate(update, {
    db: opts.db,
    capability,
    env: opts.env,
    sender
  });

  await safeDelete(opts.bot, input.chat.id, input.message.message_id);
  return {
    handled: true,
    outcome: result && result.outcome ? result.outcome : 'voucher_admin_quantity'
  };
}

module.exports = {
  HIDDEN_ADMIN_COMMAND_RE,
  ADMIN_CALLBACK_RE,
  POSITIVE_INTEGER_RE,
  privateInput,
  isHiddenAdminShape,
  activeQuantitySession,
  handleUpdate
};

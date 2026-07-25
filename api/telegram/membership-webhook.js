'use strict';

const core = require('../../lib/telegram-membership');
const service = require('../../lib/telegram-membership-service');
const bot = require('../../lib/telegram-verify-bot');

function textOf(update) { return String(update.message && update.message.text || '').trim(); }
function telegramId(update) { return update.message && update.message.from && update.message.from.id || update.callback_query && update.callback_query.from && update.callback_query.from.id; }
async function respond(chatId, text, markup) { return bot.sendMessage(chatId, text, markup ? { reply_markup: markup } : undefined); }

async function processUpdate(update, deps) {
  const db = deps || service;
  if (!update || !Number.isSafeInteger(update.update_id)) return 'malformed';
  if (!core.isPrivate(update)) return 'private_only';
  if (!await db.claimUpdate(update.update_id)) return 'duplicate';
  const id = telegramId(update);
  const chatId = update.message ? update.message.chat.id : update.callback_query.message.chat.id;
  let callback = null;
  if (update.callback_query) {
    const data = update.callback_query.data;
    if (!core.validCallback(data)) { await bot.answerCallbackQuery(update.callback_query.id, { text: 'Pilihan tidak valid.' }); return 'bad_callback'; }
    await bot.answerCallbackQuery(update.callback_query.id);
    callback = data.split(':');
  }
  const command = textOf(update);
  if (command === '/start' || command === '/menu') { await respond(chatId, 'Menu Keanggotaan Auto-Cuan', core.menuKeyboard()); return 'menu'; }
  if (command === 'Paket') {
    const rows = await db.packages();
    const buttons = rows.map(p => [{ text: `Beli ${p.name}`, callback_data: `buy:${p.id}` }]);
    await respond(chatId, rows.map(p => `${p.name} — Rp${Number(p.price_idr).toLocaleString('id-ID')}\n${p.description}`).join('\n\n'), { inline_keyboard: buttons });
    return 'packages';
  }
  const acct = await db.account(id);
  const access = core.accessFor(acct);
  if (command === 'Verifikasi Akun') { await respond(chatId, 'Verifikasi dilakukan dengan kode sekali pakai dari website. Kode hanya berlaku di chat pribadi ini.'); return 'verify'; }
  if (command === 'Akun Saya') { await respond(chatId, `Status: ${access.reason}`); return 'account'; }
  if (callback && callback[0] === 'buy' && acct && acct.verified) {
    const purchase = await db.createPurchase(id, callback[1], null);
    await respond(chatId, `Pesanan dibuat. Total: Rp${Number(purchase.finalAmount).toLocaleString('id-ID')}\n${purchase.bankInstructions}\n\nUnggah JPG/PNG/PDF dengan caption: BUKTI ${purchase.purchaseId}\nPembayaran diperiksa manual oleh admin.`);
    return 'purchase_created';
  }
  const voucherPurchase = /^VOUCHER\s+(\S+)\s+([0-9a-f-]{36})$/i.exec(command);
  if (voucherPurchase && acct && acct.verified) {
    const purchase = await db.createPurchase(id, voucherPurchase[2], voucherPurchase[1]);
    await respond(chatId, `Voucher diterapkan oleh server. Total: Rp${Number(purchase.finalAmount).toLocaleString('id-ID')}\n${purchase.bankInstructions}\n\nUnggah bukti dengan caption: BUKTI ${purchase.purchaseId}`);
    return 'voucher_purchase_created';
  }
  if ((command === 'Beli / Perpanjang' || command === 'Gunakan Voucher') && acct && acct.verified) { await respond(chatId, 'Buka Paket untuk membeli. Untuk voucher kirim: VOUCHER KODE ID_PAKET. Nominal dan diskon selalu dihitung server.'); return 'purchase'; }
  if (command === 'Akses Channel' && access.channel) { await db.channelGrant(id); await respond(chatId, 'Permintaan akses dibuat. Tautan terbatas akan dikirim oleh server.'); return 'channel'; }
  if (command === 'Cara Pakai') { await respond(chatId, 'Daftar di website, verifikasi Telegram, beli paket, unggah bukti transfer, lalu tunggu tinjauan admin.'); return 'help'; }
  if (command === 'Hubungi Admin') { await respond(chatId, process.env.MEMBERSHIP_ADMIN_CONTACT || 'Hubungi admin Auto-Cuan melalui kontak resmi website.'); return 'admin'; }
  const doc = update.message && update.message.document;
  const photo = update.message && update.message.photo && update.message.photo.at(-1);
  const file = doc || photo;
  if (file && update.message.caption) {
    const match = /^BUKTI\s+([0-9a-f-]{36})$/i.exec(update.message.caption.trim());
    if (!match || !acct || !acct.verified) return 'proof_rejected';
    const checked = core.validateProof({ file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: file.file_size, mime_type: doc ? doc.mime_type : 'image/jpeg' });
    if (!checked.ok) { await respond(chatId, 'Bukti ditolak. Gunakan JPG, PNG, atau PDF maksimal 8 MB.'); return 'proof_invalid'; }
    await db.submitProof(id, match[1], checked.metadata); await respond(chatId, 'Bukti diterima dan menunggu tinjauan admin. Pembayaran belum diverifikasi otomatis.'); return 'proof';
  }
  await respond(chatId, acct && acct.verified ? 'Gunakan menu untuk melanjutkan.' : 'Verifikasi akun terlebih dahulu. Fitur berbayar belum dapat digunakan.');
  return 'locked';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const length = Number(req.headers['content-length'] || 0);
  if (length > core.MAX_UPDATE_BYTES) return res.status(413).json({ error: 'payload_too_large' });
  if (!core.safeEqual(req.headers['x-telegram-bot-api-secret-token'], process.env.TELEGRAM_MEMBERSHIP_WEBHOOK_SECRET)) return res.status(401).json({ error: 'unauthorized' });
  try {
    await processUpdate(req.body);
  } catch (error) {
    if (req.body && Number.isSafeInteger(req.body.update_id)) await service.releaseUpdate(req.body.update_id).catch(function () {});
    // Never log update content, proof metadata, codes, or tokens.
  }
  return res.status(200).json({ ok: true });
};
module.exports.processUpdate = processUpdate;

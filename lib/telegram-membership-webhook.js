'use strict';

const core = require('./telegram-membership');
const service = require('./telegram-membership-service');
const bot = require('./telegram-verify-bot');
const env = require('./runtime-env');

function textOf(update) { return String(update.message && update.message.text || '').trim(); }
function telegramId(update) { return update.message && update.message.from && update.message.from.id || update.callback_query && update.callback_query.from && update.callback_query.from.id; }
async function respond(chatId, text, markup) { return bot.sendMessage(chatId, text, markup ? { reply_markup: markup } : undefined); }
function isMembershipUpdate(update) {
  if (!core.isPrivate(update)) return false;
  const text = textOf(update);
  if (/^ADMIN\s+\S+$/i.test(text) || /^VOUCHER\s+\S+\s+(channel-30|channel-90|lifetime)$/i.test(text)) return true;
  if (update.message && (update.message.document || update.message.photo)) return true;
  if (update.callback_query && core.validCallback(update.callback_query.data)) return true;
  return ['/start', '/menu', 'Verifikasi Akun', 'Akun Saya', 'Paket', 'Paket Aktif', 'Beli Paket', 'Beli / Perpanjang', 'Gunakan Voucher', 'Akses Channel', 'Cara Pakai', 'Hubungi Admin'].includes(text);
}
async function processChannelJoinRequest(update, deps) {
  const request = update && update.chat_join_request;
  const invite = request && request.invite_link && request.invite_link.invite_link;
  if (!request || !invite || !request.from || !request.chat) return false;
  const db = deps && deps.db || service;
  const membershipBot = deps && deps.bot || bot;
  const grant = await db.claimChannelJoin(request.from.id, invite);
  if (!grant) return false;
  if (grant.invalid === true) {
    await membershipBot.declineChatJoinRequest(request.chat.id, request.from.id).catch(function () {});
    await membershipBot.revokeChatInviteLink(request.chat.id, invite).catch(function () {});
    return 'membership_join_denied';
  }
  try {
    await membershipBot.approveChatJoinRequest(request.chat.id, request.from.id);
  } catch (error) {
    await db.releaseChannelJoin(grant.grantId, grant.claimToken).catch(function () {});
    throw error;
  }
  const finalized = await db.finalizeChannelJoin(grant.grantId, grant.claimToken);
  if (!finalized) {
    await db.releaseChannelJoin(grant.grantId, grant.claimToken).catch(function () {});
    await membershipBot.revokeChatInviteLink(request.chat.id, invite).catch(function () {});
    await membershipBot.banChatMember(request.chat.id, request.from.id).catch(function () {});
    await membershipBot.unbanChatMember(request.chat.id, request.from.id).catch(function () {});
    throw new Error('channel_join_finalize_conflict');
  }
  await membershipBot.revokeChatInviteLink(request.chat.id, invite).catch(function () {});
  return 'membership_join_approved';
}

function accountMessage(account) {
  const entitlement = account && account.entitlement;
  const pending = account && account.pendingPurchase;
  return [
    'Akun: ' + String(account && (account.maskedUsername || account.username) || 'Tidak tersedia'),
    'Status akun: ' + (account && account.blocked ? 'Tidak tersedia — hubungi admin' : account && account.accountStatus === 'pending' ? 'Menunggu aktivasi' : 'Aktif'),
    'Telegram: ' + (account && account.verified ? 'Terverifikasi' : 'Belum terverifikasi'),
    'Paket: ' + String(entitlement && entitlement.packageName || 'Tidak aktif'),
    'Status paket: ' + String(entitlement && entitlement.status || 'Tidak aktif'),
    'Aktivasi: ' + String(entitlement && entitlement.startsAt || '-'),
    'Berakhir: ' + (entitlement && entitlement.lifetime ? 'Lifetime' : String(entitlement && entitlement.endsAt || '-')),
    'Akses channel: ' + (account && account.channelAccess ? 'Aktif' : 'Tidak aktif'),
    'Akses dashboard: ' + (account && account.dashboardAccess ? 'Aktif' : 'Tidak aktif'),
    'Pembayaran: ' + (pending ? 'Menunggu tinjauan admin' : 'Tidak ada yang menunggu')
  ].join('\n');
}

async function processUpdate(update, deps) {
  const db = deps || service;
  if (!update || !Number.isSafeInteger(update.update_id)) return 'malformed';
  if (!core.isPrivate(update)) return 'private_only';
  if (!isMembershipUpdate(update)) return 'not_membership';
  if (!await db.claimUpdate(update.update_id)) return 'duplicate';
  try {
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
  const adminBind = /^ADMIN\s+(\S+)$/i.exec(command);
  if (adminBind) {
    const result = await db.bindAdmin(id, chatId, adminBind[1]);
    await respond(chatId, result ? 'Telegram admin berhasil ditautkan.' : 'Kode admin tidak valid atau kedaluwarsa.');
    return result ? 'admin_bound' : 'admin_bind_failed';
  }
  const acct = await db.account(id);
  if (command === '/start' || command === '/menu') {
    const intro = acct && acct.verified ? 'Menu Keanggotaan Auto-Cuan' : 'Menu Keanggotaan Auto-Cuan\n\nDaftar di website, lalu kirim kode verifikasi sekali pakai langsung ke chat pribadi ini.';
    await respond(chatId, intro, core.menuKeyboard(acct)); return 'menu';
  }
  if (command === 'Paket') {
    const rows = await db.packages();
    const buttons = rows.map(p => [{ text: `Beli ${p.name}`, callback_data: `package:${p.slug}` }]);
    await respond(chatId, rows.map(p => `${p.name} (${p.slug}) — Rp${Number(p.price_idr).toLocaleString('id-ID')}\n${p.description}`).join('\n\n'), { inline_keyboard: buttons });
    return 'packages';
  }
  const access = core.accessFor(acct);
  if (command === 'Verifikasi Akun') { await respond(chatId, 'Verifikasi dilakukan dengan kode sekali pakai dari website. Kode hanya berlaku di chat pribadi ini.'); return 'verify'; }
  if (command === 'Akun Saya' || command === 'Paket Aktif') { await respond(chatId, accountMessage(acct)); return 'account'; }
  if (callback && callback[0] === 'package' && core.canPurchase(acct)) {
    const packageRow = await db.packageBySlug(callback[1]);
    const purchase = await db.createPurchase(id, packageRow.id, null);
    await respond(chatId, `Pesanan dibuat. Total: Rp${Number(purchase.finalAmount).toLocaleString('id-ID')}\n${purchase.bankInstructions}\n\nUnggah JPG/PNG/PDF dengan caption: BUKTI ${purchase.purchaseId}\nPembayaran diperiksa manual oleh admin.`);
    return 'purchase_created';
  }
  const voucherPurchase = /^VOUCHER\s+(\S+)\s+(channel-30|channel-90|lifetime)$/i.exec(command);
  if (voucherPurchase && core.canPurchase(acct)) {
    const packageRow = await db.packageBySlug(voucherPurchase[2]);
    const purchase = await db.createPurchase(id, packageRow.id, voucherPurchase[1]);
    await respond(chatId, `Voucher diterapkan oleh server. Total: Rp${Number(purchase.finalAmount).toLocaleString('id-ID')}\n${purchase.bankInstructions}\n\nUnggah bukti dengan caption: BUKTI ${purchase.purchaseId}`);
    return 'voucher_purchase_created';
  }
  if ((command === 'Beli Paket' || command === 'Beli / Perpanjang' || command === 'Gunakan Voucher') && acct && acct.verified) { await respond(chatId, 'Buka Paket untuk membeli. Untuk voucher kirim: VOUCHER KODE PACKAGE_SLUG, contoh VOUCHER HEMAT channel-30. Nominal dan diskon selalu dihitung server.'); return 'purchase'; }
  if (command === 'Akses Channel' && access.channel) {
    const grant = await db.channelGrant(id);
    const invite = await bot.createChatInviteLink(env.optional('TELEGRAM_VERIFY_CHANNEL_ID'), { expireSeconds: 15 * 60, name: 'Auto-Cuan Membership' });
    await db.recordChannelInvite(grant.grantId, id, invite);
    await respond(chatId, 'Tautan permintaan bergabung (15 menit): ' + invite);
    return 'channel';
  }
  if (command === 'Cara Pakai') { await respond(chatId, 'Daftar di website, verifikasi Telegram, beli paket, unggah bukti transfer, lalu tunggu tinjauan admin.'); return 'help'; }
  if (command === 'Hubungi Admin') { await respond(chatId, env.optional('MEMBERSHIP_ADMIN_CONTACT') || 'Hubungi admin Auto-Cuan melalui kontak resmi website.'); return 'admin'; }
  const doc = update.message && update.message.document;
  const photo = update.message && update.message.photo && update.message.photo.at(-1);
  const file = doc || photo;
  if (file && update.message.caption) {
    const match = /^BUKTI\s+([0-9a-f-]{36})$/i.exec(update.message.caption.trim());
    if (!match || !core.canPurchase(acct)) return 'proof_rejected';
    const checked = core.validateProof({ file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: file.file_size, mime_type: doc ? doc.mime_type : 'image/jpeg' });
    if (!checked.ok) { await respond(chatId, 'Bukti ditolak. Gunakan JPG, PNG, atau PDF maksimal 8 MB.'); return 'proof_invalid'; }
    await db.submitProof(id, match[1], checked.metadata); await respond(chatId, 'Bukti diterima dan menunggu tinjauan admin. Pembayaran belum diverifikasi otomatis.'); return 'proof';
  }
  await respond(chatId, acct && acct.verified ? 'Gunakan menu untuk melanjutkan.' : 'Verifikasi akun terlebih dahulu. Fitur berbayar belum dapat digunakan.');
  return 'locked';
  } catch (error) {
    await db.releaseUpdate(update.update_id).catch(function () {});
    throw error;
  }
}

module.exports = { processUpdate, processChannelJoinRequest, isMembershipUpdate, accountMessage };

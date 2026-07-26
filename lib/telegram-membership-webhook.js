'use strict';

const core = require('./telegram-membership');
const service = require('./telegram-membership-service');
const bot = require('./telegram-verify-bot');
const env = require('./runtime-env');

function textOf(update) {
  return String(update && update.message && update.message.text || '').trim();
}

function slash(update) {
  const match = /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(textOf(update));
  return match ? { name: match[1].toLowerCase(), args: String(match[2] || '').trim() } : null;
}

function verificationCodeFromCommand(update) {
  const parsed = slash(update);
  return parsed && parsed.name === 'verifikasi' && parsed.args && !/\s/.test(parsed.args)
    ? parsed.args
    : null;
}

function canonicalCommand(update) {
  const parsed = slash(update);
  if (!parsed) return textOf(update);
  const aliases = {
    start: '/menu', menu: '/menu', verifikasi: 'Verifikasi Akun', akun: 'Akun Saya',
    paket: 'Paket', beli: 'Beli / Perpanjang', pesanan: 'Pesanan Saya',
    pembayaran: 'Pesanan Saya', status: 'Pesanan Saya', channel: 'Akses Channel',
    bantuan: 'Cara Pakai', admin: 'Hubungi Admin'
  };
  if (parsed.name === 'voucher') return parsed.args ? 'VOUCHER ' + parsed.args : 'Gunakan Voucher';
  return aliases[parsed.name] || '/unknown';
}

function telegramId(update) {
  return update && update.message && update.message.from && update.message.from.id ||
    update && update.callback_query && update.callback_query.from && update.callback_query.from.id;
}

async function respond(chatId, text, markup) {
  return bot.sendMessage(chatId, text, markup ? { reply_markup: markup } : undefined);
}

async function screen(update, chatId, text, markup) {
  const messageId = update && update.callback_query && update.callback_query.message && update.callback_query.message.message_id;
  if (messageId && typeof bot.editMessageText === 'function') {
    try {
      await bot.editMessageText(chatId, messageId, text, { reply_markup: markup || { inline_keyboard: [] } });
      return;
    } catch (_) {}
  }
  await respond(chatId, text, markup);
}

function showProcessing(chatId) {
  if (typeof bot.sendChatAction === 'function') bot.sendChatAction(chatId).catch(function () {});
}
function money(value) { return 'Rp' + Number(value || 0).toLocaleString('id-ID'); }
function dateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}
function packageEmoji(slug) { return slug === 'channel-30' ? '🤖' : slug === 'channel-90' ? '🚀' : slug === 'lifetime' ? '♾️' : '📣'; }
function cleanPackageName(row) {
  if (!row) return 'Paket Auto-Cuan';
  const slug = row.slug || row.packageSlug;
  if (slug === 'channel-30') return 'Bot 30 Hari';
  if (slug === 'channel-90') return 'Bot 90 Hari';
  if (slug === 'lifetime') return 'Lifetime';
  if (slug === 'channel-addon-30') return 'Perpanjangan Channel 30 Hari';
  return row.name || row.packageName || 'Paket Auto-Cuan';
}
function packageBenefits(row) {
  const slug = row && (row.slug || row.packageSlug);
  if (slug === 'channel-30') return ['✅ Akses bot Auto-Cuan selama 30 hari','❌ Tidak termasuk akses channel','❌ Tidak termasuk dashboard web'];
  if (slug === 'channel-90') return ['✅ Akses bot Auto-Cuan selama 90 hari','✅ Akses channel untuk 30 hari pertama','➕ Bulan kedua: perpanjangan channel Rp10.000','➕ Bulan ketiga: perpanjangan channel Rp10.000','❌ Tidak termasuk dashboard web'];
  if (slug === 'lifetime') return ['✅ Akses bot selamanya','✅ Akses channel bebas selamanya','✅ Akses dashboard web selamanya'];
  if (slug === 'channel-addon-30') return ['✅ Tambahan akses channel selama 30 hari','🔒 Khusus paket Bot 90 Hari yang masih aktif','⛔ Tidak menambah masa aktif bot'];
  return [row && row.description || 'Detail paket tersedia pada halaman checkout.'];
}
function statusLabel(status) {
  return ({ awaiting_payment:'Menunggu pembayaran', proof_submitted:'Bukti sudah diterima', awaiting_admin_review:'Menunggu pemeriksaan admin', approved:'Disetujui', rejected:'Bukti ditolak', expired:'Kedaluwarsa', cancelled:'Dibatalkan' })[status] || String(status || '-');
}

function mainMenuText(account, purchase) {
  const entitlement = account && account.entitlement;
  const lines = ['🏠 MENU UTAMA AUTO-CUAN','','Pilih menu melalui tombol di bawah. Semua transaksi menggunakan transfer bank dan baru aktif setelah bukti diperiksa admin.','','Status akun: ' + (account && account.verified ? 'Terverifikasi' : 'Belum terverifikasi'),'Paket aktif: ' + (entitlement ? cleanPackageName(entitlement) : 'Belum ada')];
  if (purchase) lines.push('Pesanan aktif: ' + cleanPackageName(purchase) + ' — ' + statusLabel(purchase.status));
  return lines.join('\n');
}
function mainMenuMarkup(account, purchase) {
  const rows = [];
  if (purchase) rows.push([{ text:'💳 Lanjutkan Pesanan', callback_data:'current:purchase' }]);
  rows.push([{ text:'📦 Lihat Paket', callback_data:'nav:packages' }]);
  rows.push([{ text:'👤 Akun Saya', callback_data:'menu:account' },{ text:'📣 Akses Channel', callback_data:'menu:channel' }]);
  rows.push([{ text:'📖 Cara Pakai', callback_data:'menu:help' },{ text:'☎️ Hubungi Admin', callback_data:'menu:admin' }]);
  if (!account || account.verified !== true) rows.unshift([{ text:'✅ Verifikasi Akun', callback_data:'menu:verify' }]);
  return { inline_keyboard: rows };
}
function packageListText(rows) {
  return ['📦 PILIH PAKET AUTO-CUAN','',...rows.flatMap(row => [`${packageEmoji(row.slug)} ${cleanPackageName(row)} — ${money(row.price_idr)}`,row.description || '','']),'Tekan salah satu paket untuk melihat detail lengkap. Pada tahap ini belum ada pesanan yang dibuat.'].join('\n').trim();
}
function packageListMarkup(rows) {
  return { inline_keyboard:[...rows.map(row => [{ text:`${packageEmoji(row.slug)} ${cleanPackageName(row)} · ${money(row.price_idr)}`, callback_data:`package:${row.slug}` }]),[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function packageDetailText(row) {
  return [`${packageEmoji(row.slug)} DETAIL ${cleanPackageName(row).toUpperCase()}`,'',`Harga: ${money(row.price_idr)}`,'',...packageBenefits(row),'','ALUR PEMBAYARAN','1. Lanjut ke checkout.','2. Pilih menggunakan voucher atau tanpa voucher.','3. Periksa total dan rekening tujuan.','4. Buat pesanan lalu transfer sesuai nominal.','5. Kirim bukti JPG/PNG/PDF melalui bot.','6. Paket aktif setelah admin menyetujui bukti.','','Kamu dapat kembali atau membatalkan proses kapan saja sebelum pesanan dibuat.'].join('\n');
}
function packageDetailMarkup(row) {
  return { inline_keyboard:[[{ text:'🛒 Lanjut Checkout', callback_data:`checkout:${row.slug}` }],[{ text:'⬅️ Kembali ke Paket', callback_data:'nav:packages' },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function checkoutChoiceText(row, instructions) {
  return ['🧾 CHECKOUT — PILIH VOUCHER','',`Paket: ${cleanPackageName(row)}`,`Harga awal: ${money(row.price_idr || row.priceIdr)}`,'','REKENING PEMBAYARAN',instructions,'','Apakah kamu mempunyai kode voucher?','Harga akhir selalu dihitung oleh server. Jangan transfer sebelum halaman konfirmasi akhir muncul.'].join('\n');
}
function checkoutChoiceMarkup(row) {
  const slug = row.slug || row.packageSlug;
  return { inline_keyboard:[[{ text:'🎟️ Punya Voucher', callback_data:`voucher:${slug}` }],[{ text:'➡️ Tidak Punya Voucher', callback_data:`novoucher:${slug}` }],[{ text:'⬅️ Kembali', callback_data:`package:${slug}` },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function voucherPromptText(row) {
  return ['🎟️ MASUKKAN KODE VOUCHER','',`Paket: ${cleanPackageName(row)}`,`Harga awal: ${money(row.price_idr || row.priceIdr)}`,'','Balas pesan ini dengan kode voucher.','Kode akan diperiksa oleh server dan tidak mengubah harga secara manual.','Sesi berlaku 10 menit.'].join('\n');
}
function voucherNavigationMarkup(row) {
  const slug = row.slug || row.packageSlug;
  return { inline_keyboard:[[{ text:'⬅️ Kembali ke Checkout', callback_data:`checkout:${slug}` },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function isVoucherReply(update) {
  const prompt = String(update && update.message && update.message.reply_to_message && update.message.reply_to_message.text || '');
  return prompt.startsWith('🎟️ MASUKKAN KODE VOUCHER');
}
function confirmationText(quote) {
  return ['✅ KONFIRMASI CHECKOUT','',`Paket: ${cleanPackageName(quote)}`,`Harga awal: ${money(quote.subtotal)}`,`Diskon: ${money(quote.discount)}`,`TOTAL TRANSFER: ${money(quote.finalAmount)}`,'','REKENING TUJUAN',quote.bankInstructions,'',quote.voucherApplied ? '🎟️ Voucher berhasil diterapkan.' : 'Tanpa voucher.','','Pastikan paket, nominal, dan rekening sudah benar. Tekan Buat Pesanan untuk mengunci nominal selama 24 jam.','Belum ada pembayaran yang perlu dilakukan sebelum tombol Buat Pesanan ditekan.'].join('\n');
}
function confirmationMarkup(quote) {
  const slug = quote.packageSlug || quote.slug;
  return { inline_keyboard:[[{ text:'✅ Buat Pesanan', callback_data:'confirm:order' }],[{ text:'⬅️ Ubah Voucher', callback_data:`checkout:${slug}` },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function purchaseText(purchase, heading) {
  return [heading || '💳 PESANAN AKTIF','',`Paket: ${cleanPackageName(purchase)}`,`Status: ${statusLabel(purchase.status || 'awaiting_payment')}`,`Total transfer: ${money(purchase.finalAmount)}`,purchase.discount ? `Diskon: ${money(purchase.discount)}` : null,`Batas pembayaran: ${dateTime(purchase.expiresAt)}`,'','REKENING TUJUAN',purchase.bankInstructions,'',`ID pesanan: ${purchase.purchaseId}`,'','Transfer tepat sesuai nominal. Setelah transfer, tekan Sudah Transfer lalu kirim bukti JPG, PNG, atau PDF.','Paket belum aktif sebelum bukti disetujui admin.'].filter(Boolean).join('\n');
}
function purchaseMarkup(purchase) {
  return { inline_keyboard:[[{ text:'✅ Sudah Transfer — Kirim Bukti', callback_data:`proof:${purchase.purchaseId}` }],[{ text:'⏳ Belum Transfer', callback_data:`notpaid:${purchase.purchaseId}` }],[{ text:'❌ Batalkan Pesanan', callback_data:`cancelpurchase:${purchase.purchaseId}` }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function notPaidText(purchase) {
  return ['⏳ BELUM TRANSFER','',`Paket: ${cleanPackageName(purchase)}`,`Total: ${money(purchase.finalAmount)}`,`Batas pembayaran: ${dateTime(purchase.expiresAt)}`,'','Tidak masalah. Pesanan masih tersimpan sampai batas waktu di atas.','Jangan mengirim bukti sebelum transfer dilakukan.','Setelah transfer, buka kembali pesanan ini lalu tekan Sudah Transfer.','','REKENING TUJUAN',purchase.bankInstructions].join('\n');
}
function notPaidMarkup(purchase) {
  return { inline_keyboard:[[{ text:'✅ Saya Sudah Transfer', callback_data:`proof:${purchase.purchaseId}` }],[{ text:'⬅️ Kembali ke Pesanan', callback_data:'current:purchase' }],[{ text:'❌ Batalkan Pesanan', callback_data:`cancelpurchase:${purchase.purchaseId}` }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function proofPromptText(purchase) {
  return ['📤 KIRIM BUKTI PEMBAYARAN','',`Paket: ${cleanPackageName(purchase)}`,`Total yang seharusnya ditransfer: ${money(purchase.finalAmount)}`,`ID pesanan: ${purchase.purchaseId}`,'','Sekarang kirim satu file bukti berupa:','• JPG','• PNG','• PDF','Maksimal 8 MB.','','Tidak perlu menulis caption atau UUID. Bot akan menghubungkan file ke pesanan ini secara otomatis.','Setelah diterima, bukti diteruskan ke admin untuk disetujui atau ditolak.'].join('\n');
}
function proofPromptMarkup(purchase) {
  return { inline_keyboard:[[{ text:'⬅️ Kembali ke Pesanan', callback_data:'current:purchase' }],[{ text:'❌ Batalkan Pesanan', callback_data:`cancelpurchase:${purchase.purchaseId}` }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] };
}
function waitingReviewText(purchase) {
  return ['🕵️ BUKTI MENUNGGU PEMERIKSAAN ADMIN','',`Paket: ${cleanPackageName(purchase)}`,`Total: ${money(purchase.finalAmount)}`,`Status: ${statusLabel(purchase.status)}`,`ID pesanan: ${purchase.purchaseId}`,'','Bukti sudah diteruskan ke admin.','Paket baru aktif setelah admin menekan Setujui.','Bila ditolak, bot akan memberitahukan agar kamu dapat mengirim bukti yang benar.'].join('\n');
}
function reviewMarkup() { return { inline_keyboard:[[{ text:'🔄 Cek Status', callback_data:'current:purchase' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] }; }
function channelText(account) {
  const entitlement = account && account.entitlement;
  if (!entitlement) return '📣 AKSES CHANNEL\n\nAkses channel tersedia untuk paket Bot 90 Hari dan Lifetime.';
  if (entitlement.lifetime) return '📣 AKSES CHANNEL\n\n✅ Paket Lifetime memiliki akses channel bebas selamanya.';
  if (Number(entitlement.durationDays) === 90) return ['📣 AKSES CHANNEL','','Paket Bot 90 Hari aktif.','Channel termasuk untuk 30 hari pertama.',`Akses channel saat ini sampai: ${dateTime(account.channelCoverageEndsAt)}`,'','Bulan kedua dan ketiga dapat diperpanjang Rp10.000 per 30 hari.'].join('\n');
  return '📣 AKSES CHANNEL\n\nPaket Bot 30 Hari tidak termasuk channel. Upgrade minimal ke Bot 90 Hari atau Lifetime.';
}
function channelMarkup(account) {
  const rows = [];
  if (account && account.channelAccess === true) rows.push([{ text:'🔗 Buat Link Channel', callback_data:'channel:invite' }]);
  if (account && account.channelAddonAvailable === true) rows.push([{ text:'➕ Perpanjang 30 Hari · Rp10.000', callback_data:'package:channel-addon-30' }]);
  rows.push([{ text:'⬅️ Kembali ke Menu', callback_data:'nav:menu' }]);
  return { inline_keyboard:rows };
}
function accountMessage(account) {
  const entitlement = account && account.entitlement;
  return ['👤 AKUN SAYA','','Akun: ' + String(account && (account.maskedUsername || account.username) || 'Tidak tersedia'),'Status akun: ' + (account && account.blocked ? 'Diblokir' : account && account.accountStatus === 'pending' ? 'Menunggu aktivasi' : 'Aktif'),'Telegram: ' + (account && account.verified ? 'Terverifikasi' : 'Belum terverifikasi'),'Paket: ' + (entitlement ? cleanPackageName(entitlement) : 'Tidak aktif'),'Aktif sejak: ' + dateTime(entitlement && entitlement.startsAt),'Berakhir: ' + (entitlement && entitlement.lifetime ? 'Lifetime' : dateTime(entitlement && entitlement.endsAt)),'Akses bot: ' + (account && account.botAccess ? 'Aktif' : 'Tidak aktif'),'Akses channel: ' + (account && account.channelAccess ? 'Aktif' : 'Tidak aktif'),'Akses dashboard: ' + (account && account.dashboardAccess ? 'Aktif' : 'Tidak aktif'),'Pembayaran: ' + (account && account.pendingPurchase ? 'Ada yang sedang diproses' : 'Tidak ada yang menunggu')].join('\n');
}
function userError(error) {
  const reason = error && error.reason;
  if (reason === 'voucher_unavailable') return 'Voucher tidak valid, tidak berlaku untuk paket ini, sudah habis, sudah pernah digunakan, atau sudah kedaluwarsa.';
  if (reason === 'voucher_pepper_missing') return 'Sistem voucher staging belum dikonfigurasi. Gunakan Tanpa Voucher atau hubungi admin.';
  if (reason === 'purchase_pending') return 'Masih ada pesanan aktif. Selesaikan atau batalkan pesanan tersebut sebelum membuat pesanan baru.';
  if (reason === 'channel_addon_requires_90_day') return 'Perpanjangan channel Rp10.000 hanya tersedia untuk paket Bot 90 Hari yang masih aktif.';
  if (reason === 'channel_already_covered') return 'Akses channel sudah mencakup seluruh sisa masa aktif paket 90 hari.';
  if (reason === 'channel_addon_purchase_pending') return 'Masih ada pembayaran perpanjangan channel yang belum selesai.';
  if (reason === 'channel_extension_required') return 'Masa akses channel sudah habis. Pilih perpanjangan 30 hari seharga Rp10.000.';
  if (reason === 'channel_not_included') return 'Paket Bot 30 Hari tidak termasuk channel. Upgrade minimal ke Bot 90 Hari atau Lifetime.';
  if (reason === 'checkout_session_expired') return 'Sesi checkout sudah kedaluwarsa. Buka Paket lalu mulai lagi.';
  if (reason === 'bank_instructions_missing' || reason === 'bank_instructions_unavailable') return 'Rekening pembayaran belum dikonfigurasi. Jangan transfer dan hubungi admin.';
  if (reason === 'package_unavailable') return 'Paket tidak tersedia atau sedang dinonaktifkan.';
  if (reason === 'purchase_state_conflict') return 'Pesanan tidak dapat diproses pada status saat ini. Buka Pesanan Saya untuk melihat status terbaru.';
  return 'Maaf, proses belum selesai. Tidak ada pembayaran baru yang perlu dilakukan. Silakan buka menu dan coba lagi.';
}
function isMembershipUpdate(update) {
  if (!core.isPrivate(update)) return false;
  const text = textOf(update);
  if (/^ADMIN\s+\S+$/i.test(text) || /^VOUCHER\s+\S+/i.test(text)) return true;
  if (update.message && (update.message.document || update.message.photo)) return true;
  if (update.callback_query && core.validCallback(update.callback_query.data)) return true;
  if (isVoucherReply(update)) return true;
  if (text.startsWith('/')) return true;
  return ['Verifikasi Akun','Akun Saya','Paket','Paket Aktif','Beli Paket','Beli / Perpanjang','Gunakan Voucher','Pesanan Saya','Akses Channel','Cara Pakai','Hubungi Admin','Batalkan','Kembali'].includes(text);
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
  try { await membershipBot.approveChatJoinRequest(request.chat.id, request.from.id); }
  catch (error) { await db.releaseChannelJoin(grant.grantId, grant.claimToken).catch(function () {}); throw error; }
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

async function showMenu(update, chatId, id, db) {
  const [account, purchase] = await Promise.all([db.account(id), typeof db.currentPurchase === 'function' ? db.currentPurchase(id) : null]);
  await screen(update, chatId, mainMenuText(account, purchase), mainMenuMarkup(account, purchase));
  return 'menu';
}
async function showPackages(update, chatId, db) {
  const rows = await db.packages() || [];
  if (!rows.length) {
    await screen(update, chatId, 'Paket belum tersedia. Silakan coba lagi nanti.', { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
    return 'packages_unavailable';
  }
  await screen(update, chatId, packageListText(rows), packageListMarkup(rows));
  return 'packages';
}
async function showCurrentPurchase(update, chatId, id, db, notice) {
  const purchase = await db.currentPurchase(id);
  if (!purchase) {
    await screen(update, chatId, notice || 'Tidak ada pesanan aktif. Silakan pilih paket untuk membuat pesanan baru.', { inline_keyboard:[[{ text:'📦 Lihat Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
    return 'no_current_purchase';
  }
  const prefix = notice ? notice + '\n\n' : '';
  if (purchase.status === 'proof_submitted' || purchase.status === 'awaiting_admin_review') {
    await screen(update, chatId, prefix + waitingReviewText(purchase), reviewMarkup());
    return 'purchase_review';
  }
  await screen(update, chatId, prefix + purchaseText(purchase), purchaseMarkup(purchase));
  return 'current_purchase';
}

async function processUpdate(update, deps) {
  const db = deps || service;
  if (!update || !Number.isSafeInteger(update.update_id)) return 'malformed';
  if (!core.isPrivate(update)) return 'private_only';
  if (!isMembershipUpdate(update)) return 'not_membership';
  if (!await db.claimUpdate(update.update_id)) return 'duplicate';
  const id = telegramId(update);
  const chatId = update.message ? update.message.chat.id : update.callback_query.message.chat.id;

  try {
    showProcessing(chatId);
    let callback = null;
    if (update.callback_query) {
      const data = String(update.callback_query.data || '');
      if (!core.validCallback(data)) { await bot.answerCallbackQuery(update.callback_query.id, { text:'Pilihan tidak valid.' }); return 'bad_callback'; }
      await bot.answerCallbackQuery(update.callback_query.id);
      callback = data.split(':');
    }

    if (callback) {
      const action = callback[0], value = callback.slice(1).join(':');
      if (action === 'nav' && value === 'menu') { await db.cancelCheckout(id).catch(function () {}); return showMenu(update, chatId, id, db); }
      if (action === 'nav' && value === 'packages') { await db.cancelCheckout(id).catch(function () {}); return showPackages(update, chatId, db); }
      if (action === 'current') return showCurrentPurchase(update, chatId, id, db);

      if (action === 'menu') {
        const account = await db.account(id);
        if (value === 'account') {
          await screen(update, chatId, accountMessage(account), { inline_keyboard:[[{ text:'💳 Pesanan Saya', callback_data:'current:purchase' }],[{ text:'📦 Lihat Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
          return 'account';
        }
        if (value === 'channel') { await screen(update, chatId, channelText(account), channelMarkup(account)); return 'channel_menu'; }
        if (value === 'help') {
          await screen(update, chatId, '📖 CARA PAKAI\n\n1. Verifikasi akun Telegram.\n2. Pilih paket.\n3. Lihat detail.\n4. Pilih voucher atau tanpa voucher.\n5. Periksa rekening dan total.\n6. Buat pesanan.\n7. Transfer tepat sesuai nominal.\n8. Tekan Sudah Transfer dan kirim bukti.\n9. Tunggu admin menyetujui atau menolak bukti.\n10. Paket aktif hanya setelah disetujui.', { inline_keyboard:[[{ text:'📦 Pilih Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
          return 'help';
        }
        if (value === 'admin') {
          await screen(update, chatId, '☎️ HUBUNGI ADMIN\n\n' + (env.optional('MEMBERSHIP_ADMIN_CONTACT') || 'Hubungi admin Auto-Cuan melalui kontak resmi website.'), { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
          return 'admin';
        }
        if (value === 'verify') {
          await screen(update, chatId, '✅ VERIFIKASI AKUN\n\nLogin di website untuk mendapatkan kode sekali pakai, lalu kirim dengan format:\n/verifikasi KODE\n\nKode berlaku singkat dan hanya boleh dikirim di chat pribadi ini.', { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
          return 'verify';
        }
      }

      if (action === 'cancel' && value === 'checkout') {
        await db.cancelCheckout(id).catch(function () {});
        await screen(update, chatId, '❌ PROSES DIBATALKAN\n\nTidak ada pesanan baru yang dibuat dan tidak ada pembayaran yang perlu dilakukan.', { inline_keyboard:[[{ text:'📦 Lihat Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
        return 'checkout_cancelled';
      }
      if (action === 'cancelpurchase') {
        if (!/^[0-9a-f-]{36}$/i.test(value)) return 'bad_callback';
        const cancelled = await db.cancelPurchase(id, value);
        await screen(update, chatId, cancelled ? '✅ PESANAN DIBATALKAN\n\nPesanan sudah dibatalkan. Tidak ada paket yang diaktifkan dan voucher reservasi dilepaskan.' : 'Pesanan tidak dapat dibatalkan karena sudah diproses, kedaluwarsa, atau tidak ditemukan.', { inline_keyboard:[[{ text:'📦 Pilih Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
        return 'purchase_cancelled';
      }
      if (action === 'package') {
        const current = await db.currentPurchase(id);
        if (current) return showCurrentPurchase(update, chatId, id, db, '⚠️ Kamu masih mempunyai pesanan aktif. Selesaikan atau batalkan pesanan ini sebelum memilih paket lain.');
        const row = await db.packageBySlug(value);
        await screen(update, chatId, packageDetailText(row), packageDetailMarkup(row));
        return 'package_detail';
      }
      if (action === 'checkout') {
        await db.cancelCheckout(id).catch(function () {});
        const row = await db.packageBySlug(value);
        await db.beginCheckout(id, value);
        await screen(update, chatId, checkoutChoiceText(row, env.optional('MEMBERSHIP_BANK_INSTRUCTIONS') || 'Rekening belum tersedia.'), checkoutChoiceMarkup(row));
        return 'checkout';
      }
      if (action === 'voucher') {
        const row = await db.packageBySlug(value);
        await db.beginCheckout(id, value);
        await respond(chatId, 'Gunakan tombol di bawah untuk kembali atau membatalkan.', voucherNavigationMarkup(row));
        await bot.sendMessage(chatId, voucherPromptText(row), { reply_markup:{ force_reply:true, selective:true, input_field_placeholder:'Ketik kode voucher' } });
        return 'voucher_prompt';
      }
      if (action === 'novoucher') {
        await db.beginCheckout(id, value);
        const quote = await db.prepareCheckout(id, null);
        await screen(update, chatId, confirmationText(quote), confirmationMarkup(quote));
        return 'checkout_confirm';
      }
      if (action === 'confirm' && value === 'order') {
        const purchase = await db.confirmCheckout(id);
        await screen(update, chatId, purchaseText(purchase, '✅ PESANAN BERHASIL DIBUAT'), purchaseMarkup(purchase));
        return 'purchase_created';
      }
      if (action === 'proof') {
        if (!/^[0-9a-f-]{36}$/i.test(value)) return 'bad_callback';
        const purchase = await db.beginProofUpload(id, value);
        await screen(update, chatId, proofPromptText(purchase), proofPromptMarkup(purchase));
        return 'proof_prompt';
      }
      if (action === 'notpaid') {
        if (!/^[0-9a-f-]{36}$/i.test(value)) return 'bad_callback';
        const purchase = await db.currentPurchase(id);
        if (!purchase || purchase.purchaseId !== value) return showCurrentPurchase(update, chatId, id, db);
        await screen(update, chatId, notPaidText(purchase), notPaidMarkup(purchase));
        return 'not_paid';
      }
      if (action === 'channel' && value === 'invite') {
        const grant = await db.channelGrant(id);
        const invite = await bot.createChatInviteLink(env.optional('TELEGRAM_VERIFY_CHANNEL_ID'), { expireSeconds:15*60, name:'Auto-Cuan Membership' });
        await db.recordChannelInvite(grant.grantId, id, invite);
        await screen(update, chatId, '🔗 LINK CHANNEL\n\nLink berlaku 15 menit, hanya untuk akun Telegram ini, dan membuat permintaan bergabung yang akan diperiksa bot.\n\n' + invite, { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
        return 'channel';
      }
    }

    const command = canonicalCommand(update);
    const adminBind = /^ADMIN\s+(\S+)$/i.exec(command);
    if (adminBind) {
      const result = await db.bindAdmin(id, chatId, adminBind[1]);
      await respond(chatId, result ? 'Telegram admin berhasil ditautkan.' : 'Kode admin tidak valid atau sudah kedaluwarsa.');
      return result ? 'admin_bound' : 'admin_bind_failed';
    }

    const account = await db.account(id);
    const session = typeof db.checkoutSession === 'function' ? await db.checkoutSession(id) : null;
    if (session && isVoucherReply(update) && !update.message.document && !update.message.photo) {
      const code = core.normalizeVoucher(textOf(update));
      if (!/^[A-Z0-9]{8,64}$/.test(code)) {
        await respond(chatId, 'Kode voucher harus terdiri dari 8–64 huruf atau angka. Balas prompt voucher sekali lagi atau batalkan.', voucherNavigationMarkup(session));
        return 'voucher_invalid';
      }
      const quote = await db.prepareCheckout(id, code);
      await respond(chatId, confirmationText(quote), confirmationMarkup(quote));
      return 'voucher_prepared';
    }

    if (command === '/menu') return showMenu(update, chatId, id, db);
    if (command === 'Paket' || command === 'Beli Paket' || command === 'Beli / Perpanjang' || command === 'Gunakan Voucher') {
      const current = await db.currentPurchase(id);
      return current ? showCurrentPurchase(update, chatId, id, db, '⚠️ Selesaikan atau batalkan pesanan aktif sebelum membuat pesanan baru.') : showPackages(update, chatId, db);
    }
    if (command === 'Pesanan Saya') return showCurrentPurchase(update, chatId, id, db);
    if (command === 'Verifikasi Akun') {
      await respond(chatId, '✅ VERIFIKASI AKUN\n\nLogin di website untuk memperoleh kode baru, lalu kirim:\n/verifikasi KODE', { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
      return 'verify';
    }
    if (command === 'Akun Saya' || command === 'Paket Aktif') {
      await respond(chatId, accountMessage(account), { inline_keyboard:[[{ text:'💳 Pesanan Saya', callback_data:'current:purchase' }],[{ text:'📦 Lihat Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
      return 'account';
    }
    if (command === 'Akses Channel') { await respond(chatId, channelText(account), channelMarkup(account)); return 'channel_menu'; }
    if (/^VOUCHER\s+/i.test(command)) {
      await respond(chatId, 'Untuk keamanan, voucher hanya dapat digunakan melalui alur Paket → Checkout → Punya Voucher.', { inline_keyboard:[[{ text:'📦 Buka Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
      return 'voucher_guided_only';
    }
    if (command === 'Cara Pakai') {
      await respond(chatId, '📖 CARA PAKAI\n\n1. Pilih Paket.\n2. Baca detail.\n3. Pilih voucher atau tanpa voucher.\n4. Periksa rekening dan total.\n5. Buat pesanan.\n6. Transfer.\n7. Tekan Sudah Transfer.\n8. Kirim bukti.\n9. Tunggu admin menyetujui atau menolak.', { inline_keyboard:[[{ text:'📦 Pilih Paket', callback_data:'nav:packages' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
      return 'help';
    }
    if (command === 'Hubungi Admin') {
      await respond(chatId, '☎️ HUBUNGI ADMIN\n\n' + (env.optional('MEMBERSHIP_ADMIN_CONTACT') || 'Hubungi admin Auto-Cuan melalui kontak resmi website.'), { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
      return 'admin';
    }
    if (command === '/unknown') {
      await respond(chatId, 'Perintah tidak dikenal. Gunakan tombol menu agar alur tetap aman.', { inline_keyboard:[[{ text:'🏠 Buka Menu', callback_data:'nav:menu' }]] });
      return 'unknown_command';
    }

    const document = update.message && update.message.document;
    const photo = update.message && update.message.photo && update.message.photo.at(-1);
    const file = document || photo;
    if (file) {
      const captionMatch = /^BUKTI\s+([0-9a-f-]{36})$/i.exec(String(update.message.caption || '').trim());
      const activeSession = typeof db.checkoutSession === 'function' ? await db.checkoutSession(id) : null;
      const current = typeof db.currentPurchase === 'function' ? await db.currentPurchase(id) : null;
      const purchaseId = captionMatch && captionMatch[1] || activeSession && activeSession.state === 'proof_upload' && activeSession.purchaseId || current && ['awaiting_payment','rejected'].includes(current.status) && current.purchaseId;
      if (!purchaseId || !core.canPurchase(account)) {
        await respond(chatId, 'Bukti belum dapat diproses karena tidak ada pesanan aktif. Buka Pesanan Saya lalu tekan Sudah Transfer.', { inline_keyboard:[[{ text:'💳 Pesanan Saya', callback_data:'current:purchase' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
        return 'proof_rejected';
      }
      const checked = core.validateProof({ file_id:file.file_id, file_unique_id:file.file_unique_id, file_size:file.file_size, mime_type:document ? document.mime_type : 'image/jpeg' });
      if (!checked.ok) {
        await respond(chatId, 'Bukti ditolak. Gunakan JPG, PNG, atau PDF maksimal 8 MB.', { inline_keyboard:[[{ text:'📤 Coba Kirim Lagi', callback_data:`proof:${purchaseId}` }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
        return 'proof_invalid';
      }
      const submitted = await db.submitProof(id, purchaseId, checked.metadata);
      await db.cancelCheckout(id).catch(function () {});
      await respond(chatId, '✅ BUKTI BERHASIL DIKIRIM\n\nBukti pembayaran sudah diterima dan otomatis diteruskan ke admin.\nStatus: Menunggu pemeriksaan admin.\nPaket belum aktif sebelum admin menyetujui bukti.', { inline_keyboard:[[{ text:'🔄 Cek Status', callback_data:'current:purchase' }],[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
      if (typeof db.notifyAdminsOfProof === 'function') await db.notifyAdminsOfProof(submitted, checked.metadata).catch(function () {});
      return 'proof';
    }

    await respond(chatId, account && account.verified ? 'Gunakan tombol menu untuk melanjutkan.' : 'Verifikasi akun terlebih dahulu.', { inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]] });
    return 'locked';
  } catch (error) {
    if (error && error.reason === 'purchase_pending' && typeof db.currentPurchase === 'function') {
      try { return await showCurrentPurchase(update, chatId, id, db, '⚠️ Masih ada pesanan aktif. Selesaikan atau batalkan pesanan ini terlebih dahulu.'); }
      catch (_) {}
    }
    const session = typeof db.checkoutSession === 'function' ? await db.checkoutSession(id).catch(function () { return null; }) : null;
    const rows = [];
    if (error && error.reason === 'voucher_unavailable' && session) {
      rows.push([{ text:'🎟️ Coba Voucher Lagi', callback_data:`voucher:${session.packageSlug}` }]);
      rows.push([{ text:'➡️ Lanjut Tanpa Voucher', callback_data:`novoucher:${session.packageSlug}` }]);
    }
    rows.push([{ text:'⬅️ Kembali ke Paket', callback_data:'nav:packages' },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }]);
    rows.push([{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]);
    await screen(update, chatId, userError(error), { inline_keyboard:rows }).catch(function () {});
    return 'handled_error';
  }
}

module.exports = { processUpdate, processChannelJoinRequest, isMembershipUpdate, accountMessage, verificationCodeFromCommand, canonicalCommand, showProcessing, packageListText, packageDetailText, checkoutChoiceText, confirmationText, purchaseText, userError, isVoucherReply };

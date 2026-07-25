'use strict';

const core = require('./telegram-membership');
const service = require('./telegram-membership-service');
const bot = require('./telegram-verify-bot');
const env = require('./runtime-env');

function textOf(update) { return String(update.message && update.message.text || '').trim(); }
function slash(update) {
  const match = /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(textOf(update));
  return match ? { name: match[1].toLowerCase(), args: String(match[2] || '').trim() } : null;
}
function verificationCodeFromCommand(update) {
  const parsed = slash(update);
  return parsed && parsed.name === 'verifikasi' && parsed.args && !/\s/.test(parsed.args) ? parsed.args : null;
}
function canonicalCommand(update) {
  const parsed = slash(update);
  if (!parsed) return textOf(update);
  const aliases = { start:'/menu',menu:'/menu',verifikasi:'Verifikasi Akun',akun:'Akun Saya',paket:'Paket',beli:'Beli / Perpanjang',channel:'Akses Channel',bantuan:'Cara Pakai',admin:'Hubungi Admin' };
  if (parsed.name === 'voucher') return parsed.args ? 'VOUCHER ' + parsed.args : 'Gunakan Voucher';
  return aliases[parsed.name] || '/unknown';
}
function telegramId(update) { return update.message && update.message.from && update.message.from.id || update.callback_query && update.callback_query.from && update.callback_query.from.id; }
async function respond(chatId, text, markup) { return bot.sendMessage(chatId, text, markup ? { reply_markup: markup } : undefined); }
function showProcessing(chatId) { if (typeof bot.sendChatAction === 'function') bot.sendChatAction(chatId).catch(function () {}); }
function money(value) { return 'Rp' + Number(value || 0).toLocaleString('id-ID'); }
function packageEmoji(slug) { return slug === 'channel-30' ? '🤖' : slug === 'channel-90' ? '🚀' : slug === 'lifetime' ? '♾️' : '📣'; }
function cleanPackageName(row) {
  if (!row) return 'Paket';
  if (row.slug === 'channel-30') return 'Bot 30 Hari';
  if (row.slug === 'channel-90') return 'Bot 90 Hari';
  if (row.slug === 'lifetime') return 'Lifetime';
  if (row.slug === 'channel-addon-30') return 'Perpanjangan Channel 30 Hari';
  return row.name || 'Paket';
}
function packageBenefits(row) {
  if (row.slug === 'channel-30') return ['✅ Akses bot selama 30 hari','❌ Tidak termasuk channel','❌ Tidak termasuk dashboard web'];
  if (row.slug === 'channel-90') return ['✅ Akses bot selama 90 hari','✅ Channel 30 hari pertama','➕ Channel bulan kedua dan ketiga: Rp10.000 per 30 hari','❌ Tidak termasuk dashboard web'];
  if (row.slug === 'lifetime') return ['✅ Akses bot selamanya','✅ Channel bebas selamanya','✅ Dashboard web selamanya'];
  if (row.slug === 'channel-addon-30') return ['✅ Tambahan akses channel 30 hari','🔒 Khusus paket Bot 90 Hari yang masih aktif','⛔ Tidak menambah masa aktif bot'];
  return [row.description || 'Detail paket tersedia saat checkout.'];
}
function packageListText(rows) {
  return ['✨ PILIH PAKET AUTO-CUAN','',...rows.map(row => `${packageEmoji(row.slug)} ${cleanPackageName(row)} — ${money(row.price_idr)}`),'','Pilih salah satu paket untuk melihat detail. Belum ada transaksi yang dibuat pada tahap ini.'].join('\n');
}
function packageListMarkup(rows) {
  return { inline_keyboard:[
    ...rows.map(row => [{ text:`${packageEmoji(row.slug)} ${cleanPackageName(row)} · ${money(row.price_idr)}`, callback_data:`package:${row.slug}` }]),
    [{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]
  ] };
}
function packageDetailText(row) {
  return [`${packageEmoji(row.slug)} ${cleanPackageName(row)}`,'',`Harga: ${money(row.price_idr)}`,'',...packageBenefits(row),'','Pembayaran dilakukan melalui transfer bank dan baru aktif setelah diperiksa admin.'].join('\n');
}
function packageDetailMarkup(row) {
  return { inline_keyboard:[
    [{ text:'🛒 Lanjut Checkout', callback_data:`checkout:${row.slug}` }],
    [{ text:'⬅️ Kembali ke Paket', callback_data:'nav:packages' },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }]
  ] };
}
function checkoutText(row) {
  return ['🧾 CHECKOUT', '', `${cleanPackageName(row)} — ${money(row.price_idr)}`, '', 'Apakah kamu mempunyai kode voucher?', 'Harga akhir selalu dihitung oleh server.'].join('\n');
}
function checkoutMarkup(row) {
  return { inline_keyboard:[
    [{ text:'🎟️ Punya Voucher', callback_data:`voucher:${row.slug}` }],
    [{ text:'➡️ Tidak Punya Voucher', callback_data:`novoucher:${row.slug}` }],
    [{ text:'⬅️ Kembali', callback_data:`package:${row.slug}` },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }]
  ] };
}
function voucherPromptText(row) {
  return ['🎟️ MASUKKAN KODE VOUCHER','',`Paket: ${cleanPackageName(row)}`,`Harga awal: ${money(row.price_idr)}`,'','Ketik kode voucher lalu kirim sebagai pesan biasa. Sesi ini berlaku 10 menit.'].join('\n');
}
function voucherPromptMarkup(row) {
  return { inline_keyboard:[
    [{ text:'⬅️ Kembali', callback_data:`checkout:${row.slug}` },{ text:'❌ Batalkan', callback_data:'cancel:checkout' }]
  ] };
}
function purchaseText(purchase) {
  return ['✅ PESANAN DIBUAT','',`Paket: ${purchase.packageName || 'Paket Auto-Cuan'}`,`Total transfer: ${money(purchase.finalAmount)}`,'',purchase.bankInstructions,'',`ID pesanan: ${purchase.purchaseId}`,'','Kirim JPG, PNG, atau PDF dengan caption:',`BUKTI ${purchase.purchaseId}`,'','Paket belum aktif sebelum bukti disetujui admin.'].join('\n');
}
function purchaseMarkup(purchase) {
  return { inline_keyboard:[
    [{ text:'❌ Batalkan Pesanan', callback_data:`cancelpurchase:${purchase.purchaseId}` }],
    [{ text:'🏠 Menu Utama', callback_data:'nav:menu' }]
  ] };
}
function channelText(account) {
  const e = account && account.entitlement;
  if (!e) return '📣 AKSES CHANNEL\n\nAkses channel hanya tersedia untuk paket Bot 90 Hari dan Lifetime.';
  if (e.lifetime) return '📣 AKSES CHANNEL\n\n✅ Lifetime: akses channel bebas selamanya.';
  if (Number(e.durationDays) === 90) {
    const end = account.channelCoverageEndsAt ? new Date(account.channelCoverageEndsAt).toLocaleString('id-ID') : '-';
    return ['📣 AKSES CHANNEL','','Paket Bot 90 Hari aktif.','Channel termasuk untuk 30 hari pertama.',`Akses channel saat ini sampai: ${end}`,'','Bulan kedua dan ketiga dapat diperpanjang Rp10.000 per 30 hari.'].join('\n');
  }
  return '📣 AKSES CHANNEL\n\nPaket Bot 30 Hari tidak termasuk channel. Upgrade minimal ke Bot 90 Hari atau Lifetime.';
}
function channelMarkup(account) {
  const rows=[];
  if (account && account.channelAccess === true) rows.push([{text:'🔗 Buat Link Channel',callback_data:'channel:invite'}]);
  if (account && account.channelAddonAvailable === true) rows.push([{text:'➕ Perpanjang 30 Hari · Rp10.000',callback_data:'package:channel-addon-30'}]);
  rows.push([{text:'⬅️ Kembali',callback_data:'nav:menu'},{text:'❌ Tutup',callback_data:'cancel:checkout'}]);
  return {inline_keyboard:rows};
}
function userError(error) {
  const reason=error && error.reason;
  if (reason==='voucher_unavailable') return 'Voucher tidak valid, tidak berlaku untuk paket ini, sudah habis, atau sudah kedaluwarsa. Kamu dapat mencoba kode lain atau kembali memilih Tanpa Voucher.';
  if (reason==='channel_addon_requires_90_day') return 'Perpanjangan channel Rp10.000 hanya tersedia untuk paket Bot 90 Hari yang masih aktif.';
  if (reason==='channel_already_covered') return 'Akses channel sudah mencakup seluruh sisa masa aktif paket 90 hari.';
  if (reason==='channel_addon_purchase_pending') return 'Masih ada pembayaran perpanjangan channel yang belum selesai.';
  if (reason==='channel_extension_required') return 'Masa akses channel saat ini sudah habis. Pilih perpanjangan 30 hari seharga Rp10.000.';
  if (reason==='channel_not_included') return 'Paket Bot 30 Hari tidak termasuk channel. Upgrade minimal ke Bot 90 Hari atau Lifetime.';
  if (reason==='checkout_session_expired') return 'Sesi voucher sudah kedaluwarsa. Buka Paket lalu mulai checkout lagi.';
  if (reason==='bank_instructions_missing' || reason==='bank_instructions_unavailable') return 'Instruksi pembayaran belum tersedia. Hubungi admin sebelum melakukan transfer.';
  if (reason==='package_unavailable') return 'Paket tidak tersedia atau sedang dinonaktifkan.';
  return 'Maaf, proses belum selesai. Tidak ada pembayaran yang perlu dilakukan. Coba lagi atau hubungi admin.';
}
function isMembershipUpdate(update) {
  if (!core.isPrivate(update)) return false;
  const text = textOf(update);
  if (/^ADMIN\s+\S+$/i.test(text) || /^VOUCHER\s+\S+\s+(channel-30|channel-90|lifetime|channel-addon-30)$/i.test(text)) return true;
  if (update.message && (update.message.document || update.message.photo)) return true;
  if (update.callback_query && core.validCallback(update.callback_query.data)) return true;
  if (text.startsWith('/')) return true;
  return ['Verifikasi Akun','Akun Saya','Paket','Paket Aktif','Beli Paket','Beli / Perpanjang','Gunakan Voucher','Akses Channel','Cara Pakai','Hubungi Admin','Batalkan','Kembali'].includes(text) || text.length>0;
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
function accountMessage(account) {
  const entitlement = account && account.entitlement;
  const pending = account && account.pendingPurchase;
  return [
    '👤 AKUN SAYA','',
    'Akun: ' + String(account && (account.maskedUsername || account.username) || 'Tidak tersedia'),
    'Status: ' + (account && account.blocked ? 'Diblokir — hubungi admin' : account && account.accountStatus === 'pending' ? 'Menunggu aktivasi' : 'Aktif'),
    'Telegram: ' + (account && account.verified ? 'Terverifikasi' : 'Belum terverifikasi'),
    'Paket: ' + String(entitlement && entitlement.packageName || 'Tidak aktif'),
    'Berakhir: ' + (entitlement && entitlement.lifetime ? 'Lifetime' : String(entitlement && entitlement.endsAt || '-')),
    'Akses channel: ' + (account && account.channelAccess ? 'Aktif' : 'Tidak aktif'),
    'Akses dashboard: ' + (account && account.dashboardAccess ? 'Aktif' : 'Tidak aktif'),
    'Pembayaran: ' + (pending ? 'Menunggu tinjauan admin' : 'Tidak ada yang menunggu')
  ].join('\n');
}
async function showPackages(chatId,db) {
  const rows=await db.packages()||[];
  if(!rows.length){await respond(chatId,'Paket belum tersedia. Silakan coba lagi nanti.',{inline_keyboard:[[{text:'🏠 Menu Utama',callback_data:'nav:menu'}]]});return 'packages_unavailable';}
  await respond(chatId,packageListText(rows),packageListMarkup(rows));return 'packages';
}
async function createAndShowPurchase(chatId,id,db,packageRow,voucherCode) {
  const purchase=voucherCode===undefined
    ? await db.createPurchase(id,packageRow.id,null)
    : await db.checkoutPurchase(id,voucherCode);
  await respond(chatId,purchaseText(purchase),purchaseMarkup(purchase));
  return purchase;
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
    let callback=null;
    if(update.callback_query){
      const data=String(update.callback_query.data||'');
      if(!core.validCallback(data)){await bot.answerCallbackQuery(update.callback_query.id,{text:'Pilihan tidak valid.'});return 'bad_callback';}
      await bot.answerCallbackQuery(update.callback_query.id);
      callback=data.split(':');
    }

    if(callback){
      const action=callback[0],value=callback.slice(1).join(':');
      if(action==='nav'&&value==='menu'){
        await db.cancelCheckout(id).catch(function(){});
        const acct=await db.account(id);
        await respond(chatId,'🏠 Menu Keanggotaan Auto-Cuan',core.menuKeyboard(acct));return 'menu';
      }
      if(action==='nav'&&value==='packages'){await db.cancelCheckout(id).catch(function(){});return showPackages(chatId,db);}
      if(action==='cancel'&&value==='checkout'){
        await db.cancelCheckout(id).catch(function(){});
        await respond(chatId,'❌ Proses dibatalkan. Tidak ada pesanan baru yang dibuat.',{inline_keyboard:[[{text:'📦 Lihat Paket',callback_data:'nav:packages'},{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'checkout_cancelled';
      }
      if(action==='cancelpurchase'){
        const cancelled=await db.cancelPurchase(id,value);
        await respond(chatId,cancelled?'Pesanan dibatalkan. Tidak ada paket yang diaktifkan.':'Pesanan tidak dapat dibatalkan karena sudah diproses atau tidak ditemukan.',{inline_keyboard:[[{text:'📦 Lihat Paket',callback_data:'nav:packages'},{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'purchase_cancelled';
      }
      if(action==='package'){
        const row=await db.packageBySlug(value);
        await respond(chatId,packageDetailText(row),packageDetailMarkup(row));return 'package_detail';
      }
      if(action==='checkout'){
        await db.cancelCheckout(id).catch(function(){});
        const row=await db.packageBySlug(value);
        await respond(chatId,checkoutText(row),checkoutMarkup(row));return 'checkout';
      }
      if(action==='voucher'){
        const row=await db.packageBySlug(value);
        await db.beginCheckout(id,value);
        await respond(chatId,voucherPromptText(row),voucherPromptMarkup(row));return 'voucher_prompt';
      }
      if(action==='novoucher'){
        await db.cancelCheckout(id).catch(function(){});
        const row=await db.packageBySlug(value);
        await createAndShowPurchase(chatId,id,db,row,undefined);return 'purchase_created';
      }
      if(action==='channel'&&value==='invite'){
        const grant=await db.channelGrant(id);
        const invite=await bot.createChatInviteLink(env.optional('TELEGRAM_VERIFY_CHANNEL_ID'),{expireSeconds:15*60,name:'Auto-Cuan Membership'});
        await db.recordChannelInvite(grant.grantId,id,invite);
        await respond(chatId,'🔗 LINK CHANNEL\n\nLink berlaku 15 menit dan hanya dapat digunakan oleh akun Telegram ini.\n\n'+invite,{inline_keyboard:[[{text:'⬅️ Kembali',callback_data:'nav:menu'}]]});return 'channel';
      }
    }

    const command=canonicalCommand(update);
    const adminBind=/^ADMIN\s+(\S+)$/i.exec(command);
    if(adminBind){const result=await db.bindAdmin(id,chatId,adminBind[1]);await respond(chatId,result?'Telegram admin berhasil ditautkan.':'Kode admin tidak valid atau kedaluwarsa.');return result?'admin_bound':'admin_bind_failed';}
    const acct=await db.account(id);

    const session=typeof db.checkoutSession==='function'?await db.checkoutSession(id):null;
    if(session&&update.message&&!slash(update)&&!update.message.document&&!update.message.photo){
      const raw=textOf(update);
      if(/^(?:batalkan|batal|cancel)$/i.test(raw)){await db.cancelCheckout(id);await respond(chatId,'❌ Checkout dibatalkan.',{inline_keyboard:[[{text:'📦 Kembali ke Paket',callback_data:'nav:packages'}]]});return 'checkout_cancelled';}
      const code=core.normalizeVoucher(raw);
      if(!/^[A-Z0-9]{8,64}$/.test(code)){await respond(chatId,'Kode voucher harus terdiri dari 8–64 huruf atau angka. Coba lagi atau batalkan.',voucherPromptMarkup(session));return 'voucher_invalid';}
      const purchase=await db.checkoutPurchase(id,code);
      await respond(chatId,purchaseText(purchase),purchaseMarkup(purchase));return 'voucher_purchase_created';
    }

    if(command==='/menu'){const intro=acct&&acct.verified?'🏠 Menu Keanggotaan Auto-Cuan':'🏠 Menu Keanggotaan Auto-Cuan\n\nDaftar di website, lalu verifikasi Telegram.';await respond(chatId,intro,core.menuKeyboard(acct));return 'menu';}
    if(command==='Paket'||command==='Beli Paket'||command==='Beli / Perpanjang'||command==='Gunakan Voucher')return showPackages(chatId,db);
    if(command==='Verifikasi Akun'){await respond(chatId,'Verifikasi dilakukan dengan kode sekali pakai dari website. Kode hanya berlaku di chat pribadi ini.',{inline_keyboard:[[{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'verify';}
    if(command==='Akun Saya'||command==='Paket Aktif'){await respond(chatId,accountMessage(acct),{inline_keyboard:[[{text:'📦 Lihat Paket',callback_data:'nav:packages'}],[{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'account';}
    if(command==='Akses Channel'){await respond(chatId,channelText(acct),channelMarkup(acct));return 'channel_menu';}
    const voucherPurchase=/^VOUCHER\s+(\S+)\s+(channel-30|channel-90|lifetime|channel-addon-30)$/i.exec(command);
    if(voucherPurchase&&core.canPurchase(acct)){const row=await db.packageBySlug(voucherPurchase[2]);const purchase=await db.createPurchase(id,row.id,voucherPurchase[1]);await respond(chatId,purchaseText(purchase),purchaseMarkup(purchase));return 'voucher_purchase_created';}
    if(command==='Cara Pakai'){await respond(chatId,'1. Pilih Paket.\n2. Lihat detail lalu Checkout.\n3. Pilih Punya Voucher atau Tanpa Voucher.\n4. Transfer sesuai nominal.\n5. Unggah bukti dan tunggu admin.',{inline_keyboard:[[{text:'📦 Pilih Paket',callback_data:'nav:packages'}],[{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'help';}
    if(command==='Hubungi Admin'){await respond(chatId,env.optional('MEMBERSHIP_ADMIN_CONTACT')||'Hubungi admin Auto-Cuan melalui kontak resmi website.',{inline_keyboard:[[{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'admin';}
    if(command==='/unknown'){await respond(chatId,'Perintah tidak dikenal.',{inline_keyboard:[[{text:'🏠 Buka Menu',callback_data:'nav:menu'}]]});return 'unknown_command';}

    const doc=update.message&&update.message.document;
    const photo=update.message&&update.message.photo&&update.message.photo.at(-1);
    const file=doc||photo;
    if(file&&update.message.caption){
      const match=/^BUKTI\s+([0-9a-f-]{36})$/i.exec(update.message.caption.trim());
      if(!match||!core.canPurchase(acct)){await respond(chatId,'Caption bukti tidak valid atau akun belum dapat membeli paket.');return 'proof_rejected';}
      const checked=core.validateProof({file_id:file.file_id,file_unique_id:file.file_unique_id,file_size:file.file_size,mime_type:doc?doc.mime_type:'image/jpeg'});
      if(!checked.ok){await respond(chatId,'Bukti ditolak. Gunakan JPG, PNG, atau PDF maksimal 8 MB.');return 'proof_invalid';}
      const submitted=await db.submitProof(id,match[1],checked.metadata);
      await respond(chatId,'✅ Bukti diterima dan menunggu tinjauan admin. Pembayaran belum diverifikasi otomatis.',{inline_keyboard:[[{text:'👤 Cek Akun',callback_data:'nav:menu'}]]});
      if(typeof db.notifyAdminsOfProof==='function')await db.notifyAdminsOfProof(submitted,checked.metadata).catch(function(){});
      return 'proof';
    }
    await respond(chatId,acct&&acct.verified?'Gunakan tombol menu untuk melanjutkan.':'Verifikasi akun terlebih dahulu.',{inline_keyboard:[[{text:'🏠 Menu',callback_data:'nav:menu'}]]});return 'locked';
  }catch(error){
    await respond(chatId,userError(error),{inline_keyboard:[[{text:'⬅️ Kembali ke Paket',callback_data:'nav:packages'},{text:'❌ Batalkan',callback_data:'cancel:checkout'}]]}).catch(function(){});
    await db.releaseUpdate(update.update_id).catch(function(){});
    return 'handled_error';
  }
}

module.exports={processUpdate,processChannelJoinRequest,isMembershipUpdate,accountMessage,verificationCodeFromCommand,canonicalCommand,showProcessing,packageListText,packageDetailText,checkoutText,userError};

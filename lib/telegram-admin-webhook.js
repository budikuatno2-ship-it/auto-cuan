'use strict';

const crypto = require('crypto');
const env = require('./runtime-env');
const service = require('./telegram-admin-service');
const bot = require('./telegram-admin-bot');
const customerBot = require('./telegram-verify-bot');
const core = require('./telegram-membership');

const MAX_BODY = 32 * 1024;
const REJECTION_REASON = 'Ditolak admin melalui bot.';
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  if (x.length !== y.length) { crypto.timingSafeEqual(y, y); return false; }
  return crypto.timingSafeEqual(x, y);
}
function command(text) {
  const match = /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(String(text || '').trim());
  return match ? { name: match[1].toLowerCase(), args: String(match[2] || '').trim() } : null;
}
function money(value) { return 'Rp' + Number(value || 0).toLocaleString('id-ID'); }
function short(id) { return String(id || '').slice(0, 8); }
function reviewButtons(id) { return { inline_keyboard: [[{ text:'✅ SETUJUI', callback_data:'approve:' + id }, { text:'❌ TOLAK', callback_data:'reject:' + id }],[{text:'⬅️ Menu Admin',callback_data:'admin:menu'}]] }; }
function backMenu() { return { inline_keyboard:[[{text:'⬅️ Menu Admin',callback_data:'admin:menu'},{text:'❌ Tutup',callback_data:'admin:close'}]] }; }
function menuMarkup() { return { inline_keyboard:[
  [{text:'💳 Pembayaran',callback_data:'admin:payments'}],
  [{text:'🎟️ Daftar Voucher',callback_data:'admin:vouchers'},{text:'🧾 Audit',callback_data:'admin:audit'}],
  [{text:'❓ Bantuan',callback_data:'admin:help'},{text:'❌ Tutup',callback_data:'admin:close'}]
] }; }
function menuText() { return ['🛡️ MENU ADMIN AUTO-CUAN','','Kelola pembayaran, voucher, pengguna, dan audit dari staging.','','Perintah dengan input:','/voucher_buat KODE percent|fixed NILAI PAKET LIMIT HARI','/voucher_detail UUID_ATAU_HINT','/voucher_nonaktifkan UUID','/pengguna USERNAME_ATAU_TELEGRAM_ID'].join('\n'); }
function paymentText(row) {
  return ['💳 PEMBAYARAN #' + short(row.purchase_id),'','Akun: ' + (row.masked_username || '****'),'Paket: ' + (row.package_name || '-'),
    'Jumlah: ' + money(row.final_amount_idr),'Dikirim: ' + (row.submitted_at || row.created_at || '-'),
    'Bukti: ' + (row.mime_type || '-') + ' · ' + Number(row.file_size || 0) + ' byte'].join('\n');
}
function voucherText(v) {
  return ['🎟️ Voucher #' + short(v.id),'Hint: ' + (v.code_hint || '****'),'Diskon: ' + v.discount_type + ' ' + v.discount_value,
    'Paket: ' + (v.package_slugs || 'all'),'Aktif: ' + (v.active ? 'ya' : 'tidak'),'Berlaku hingga: ' + (v.valid_until || '-'),
    'Limit: ' + (v.total_limit == null ? 'tanpa batas' : v.total_limit),'Dipakai: ' + Number(v.redemption_count || 0)].join('\n');
}
function help() { return ['❓ BANTUAN ADMIN','','/pembayaran','/voucher_buat HEMAT30 percent 30 channel-90 100 30','/voucher_detail UUID_ATAU_HINT','/voucher_nonaktifkan UUID','/pengguna username','/audit [PURCHASE_UUID]','','Pilihan paket voucher: channel-30, channel-90, lifetime, channel-addon-30, atau all.'].join('\n'); }
function parseVoucher(args) {
  const p = String(args || '').split(/\s+/); if (p.length !== 6) return null;
  const code = core.normalizeVoucher(p[0]); const type = p[1].toLowerCase(); const value = Number(p[2]); const packageSlug = p[3].toLowerCase(); const limit = Number(p[4]); const days = Number(p[5]);
  if (!/^[A-Z0-9]{8,64}$/.test(code) || !['percent','fixed'].includes(type) || !['channel-30','channel-90','lifetime','channel-addon-30','all'].includes(packageSlug)) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > (type === 'percent' ? 100 : 1000000000)) return null;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000000 || !Number.isSafeInteger(days) || days < 0 || days > 3650) return null;
  return { code, type, value, package:packageSlug, limit, days };
}
function showProcessing(botClient, chatId) { if (botClient && typeof botClient.sendChatAction === 'function') botClient.sendChatAction(chatId).catch(function () {}); }
async function notifyCustomer(result, approve, deps) {
  if (!result || !result.customer_chat_id || result.duplicate) return;
  let text;
  if (!approve) text='Bukti pembayaran ditolak. Alasan: '+REJECTION_REASON+'\nGunakan /admin untuk menghubungi admin.';
  else if (result.product_type==='channel_addon') text='✅ Perpanjangan channel disetujui. Akses channel aktif sampai '+(result.ends_at||result.channelEndsAt||'-')+'.\nGunakan /channel untuk membuat link.';
  else text='✅ Pembayaran disetujui. Paket '+(result.package_name||'')+' aktif'+(result.lifetime?' Lifetime.':' sampai '+result.ends_at+'.')+'\nGunakan /menu untuk melanjutkan.';
  await deps.customerBot.sendMessage(result.customer_chat_id,text).catch(function () {});
}
async function sendPayments(chatId,deps) {
  const rows=(await deps.service.pending()||[]).slice(0,10);
  if(!rows.length){await deps.bot.sendMessage(chatId,'✅ Tidak ada pembayaran menunggu tinjauan.',{reply_markup:backMenu()});return 'payments';}
  for(const row of rows) await deps.bot.sendMessage(chatId,paymentText(row),{reply_markup:reviewButtons(row.purchase_id)});
  return 'payments';
}
async function sendVouchers(chatId,deps) {
  const rows=(await deps.service.vouchers()||[]).slice(0,20);
  await deps.bot.sendMessage(chatId,rows.length?rows.map(voucherText).join('\n\n'):'Belum ada voucher.',{reply_markup:backMenu()});return 'vouchers';
}
async function sendAudit(chatId,deps,purchaseId) {
  const rows=(await deps.service.audit(purchaseId||null)||[]).slice(0,20);
  await deps.bot.sendMessage(chatId,rows.length?rows.map(x=>(x.created_at||'-')+' · '+(x.event_type||'-')+' · #'+short(x.purchase_id)).join('\n'):'Audit tidak ditemukan.',{reply_markup:backMenu()});return 'audit';
}
async function processUpdate(update, deps) {
  if (!update || typeof update.update_id !== 'number' || !Number.isFinite(update.update_id)) return 'malformed';
  const origin = update.callback_query || update.message; const from = origin && origin.from;
  const chat = update.message && update.message.chat || update.callback_query && update.callback_query.message && update.callback_query.message.chat;
  if (!from || !chat || chat.type !== 'private') return 'private_only';
  const context = await deps.service.authorize(from.id);
  if (!context || context.authorized !== true) { await deps.bot.sendMessage(chat.id, 'Akses tidak tersedia.'); return 'unauthorized'; }
  if (!await deps.service.claimUpdate(update.update_id)) return 'duplicate';
  try {
    showProcessing(deps.bot, chat.id);
    if (update.callback_query) {
      const data=String(update.callback_query.data||'');
      const review=/^(approve|reject):([0-9a-f-]{36})$/i.exec(data);
      const navigation=/^admin:(menu|payments|vouchers|audit|help|close)$/.exec(data);
      if(navigation){
        await deps.bot.answerCallbackQuery(update.callback_query.id);
        if(navigation[1]==='menu'){await deps.bot.sendMessage(chat.id,menuText(),{reply_markup:menuMarkup()});return 'menu';}
        if(navigation[1]==='payments')return sendPayments(chat.id,deps);
        if(navigation[1]==='vouchers')return sendVouchers(chat.id,deps);
        if(navigation[1]==='audit')return sendAudit(chat.id,deps,null);
        if(navigation[1]==='help'){await deps.bot.sendMessage(chat.id,help(),{reply_markup:backMenu()});return 'help';}
        await deps.bot.sendMessage(chat.id,'Menu admin ditutup. Gunakan /menu untuk membukanya lagi.');return 'closed';
      }
      if (!review || !deps.service.UUID.test(review[2])) { await deps.bot.answerCallbackQuery(update.callback_query.id, { text:'Pilihan tidak valid.' }); return 'bad_callback'; }
      const approve = review[1] === 'approve';
      const result = await deps.service.review(review[2], approve, approve ? null : REJECTION_REASON, context.user_id, 'tgadmin-' + update.update_id);
      await deps.bot.answerCallbackQuery(update.callback_query.id, { text: result && result.duplicate ? 'Sudah diproses.' : (approve ? 'Disetujui.' : 'Ditolak.') });
      await notifyCustomer(result, approve, deps);
      await deps.bot.sendMessage(chat.id, result && result.duplicate ? 'Pembayaran sudah diproses sebelumnya.' : (approve ? '✅ Pembayaran disetujui.' : '❌ Pembayaran ditolak.'),{reply_markup:backMenu()});
      return approve ? 'approved' : 'rejected';
    }
    const parsed = command(update.message && update.message.text);
    if (!parsed) { await deps.bot.sendMessage(chat.id, help(),{reply_markup:backMenu()}); return 'help'; }
    if (parsed.name === 'start' || parsed.name === 'menu') { await deps.bot.sendMessage(chat.id, menuText(),{reply_markup:menuMarkup()}); return 'menu'; }
    if (parsed.name === 'bantuan') { await deps.bot.sendMessage(chat.id, help(),{reply_markup:backMenu()}); return 'help'; }
    if (parsed.name === 'pembayaran') return sendPayments(chat.id,deps);
    if (parsed.name === 'voucher_buat') {
      const input = parseVoucher(parsed.args); if (!input) { await deps.bot.sendMessage(chat.id, 'Format voucher tidak valid.\n\n' + help(),{reply_markup:backMenu()}); return 'voucher_invalid'; }
      await deps.service.createVoucher(input, context.user_id);
      await deps.bot.sendMessage(chat.id, '✅ Voucher berhasil dibuat.\n\nKode: ' + input.code + '\n\nSimpan kode ini dengan aman; kode tidak dapat ditampilkan kembali.',{reply_markup:backMenu()}); return 'voucher_created';
    }
    if (parsed.name === 'voucher_daftar') return sendVouchers(chat.id,deps);
    if (parsed.name === 'voucher_detail') { if (!parsed.args) { await deps.bot.sendMessage(chat.id, 'Gunakan /voucher_detail IDENTIFIER',{reply_markup:backMenu()}); return 'voucher_invalid'; } const v=await deps.service.voucherDetail(parsed.args); await deps.bot.sendMessage(chat.id, v ? voucherText(v) : 'Voucher tidak ditemukan atau identifier tidak unik.',{reply_markup:backMenu()}); return 'voucher_detail'; }
    if (parsed.name === 'voucher_nonaktifkan') { if (!deps.service.UUID.test(parsed.args)) { await deps.bot.sendMessage(chat.id, 'UUID voucher tidak valid.',{reply_markup:backMenu()}); return 'voucher_invalid'; } const v=await deps.service.deactivateVoucher(parsed.args,context.user_id); await deps.bot.sendMessage(chat.id,v&&v.already_inactive?'Voucher sudah nonaktif.':'✅ Voucher dinonaktifkan.',{reply_markup:backMenu()}); return 'voucher_deactivated'; }
    if (parsed.name === 'pengguna') { if (!/^(?:[A-Za-z0-9_.-]{3,64}|[0-9]{1,20})$/.test(parsed.args)) { await deps.bot.sendMessage(chat.id,'Query pengguna tidak valid.',{reply_markup:backMenu()}); return 'user_invalid'; } const u=await deps.service.userLookup(parsed.args); await deps.bot.sendMessage(chat.id,u ? ['👤 PENGGUNA','Akun: '+u.masked_username,'Disetujui: '+!!u.approved,'Diblokir: '+!!u.blocked,'Telegram: '+(u.telegram_verified?'terverifikasi':'belum'),'Paket: '+(u.package_name||'-'),'Berakhir: '+(u.lifetime?'Lifetime':u.ends_at||'-'),'Pembayaran: '+(u.pending_payment_status||'-'),'Channel: '+!!u.channel_access,'Dashboard: '+!!u.dashboard_access].join('\n'):'Pengguna tidak ditemukan.',{reply_markup:backMenu()}); return 'user'; }
    if (parsed.name === 'audit') { if (parsed.args && !deps.service.UUID.test(parsed.args)) { await deps.bot.sendMessage(chat.id,'UUID pembelian tidak valid.',{reply_markup:backMenu()}); return 'audit_invalid'; } return sendAudit(chat.id,deps,parsed.args||null); }
    await deps.bot.sendMessage(chat.id, 'Perintah tidak dikenal.',{reply_markup:menuMarkup()}); return 'unknown';
  } catch (error) {
    await deps.bot.sendMessage(chat.id, 'Maaf, proses belum selesai. Coba kembali ke menu dan ulangi sekali lagi.',{reply_markup:backMenu()}).catch(function () {});
    await deps.service.releaseUpdate(update.update_id).catch(function(){});
    return 'handled_error';
  }
}
async function handle(req, res, injected) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false });
  let config; try { config=env.adminTelegramConfig(); } catch (_) { return res.status(503).json({ ok:false }); }
  if (!equalSecret(req.headers && req.headers['x-telegram-bot-api-secret-token'],config.webhookSecret)) return res.status(401).json({ ok:false });
  const length=Number(req.headers && req.headers['content-length']||0); if(Number.isFinite(length)&&length>MAX_BODY)return res.status(413).json({ok:false});
  try { if(Buffer.byteLength(JSON.stringify(req.body||{}))>MAX_BODY)return res.status(413).json({ok:false}); } catch(_){return res.status(400).json({ok:false});}
  if(typeof (req.body||{}).update_id!=='number'||!Number.isFinite(req.body.update_id))return res.status(200).json({ok:true,ignored:true});
  const deps=injected||{service,bot,customerBot};
  try { const outcome=await processUpdate(req.body,deps); return res.status(200).json({ok:true,outcome}); }
  catch (_) { return res.status(500).json({ok:false,retryable:true}); }
}
module.exports={handle,processUpdate,command,parseVoucher,paymentText,voucherText,equalSecret,buttons:reviewButtons,showProcessing,MAX_BODY,menuMarkup,backMenu};

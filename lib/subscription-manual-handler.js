'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireSubscriptionOnboardingUser } = require('../lib/subscription-auth');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');
const vouchers = require('../lib/vouchers');
const { createVoucherAdminSender } = require('../lib/voucher-admin-sender');

const ADMIN_TELEGRAM_ID = vouchers.VOUCHER_ADMIN_TELEGRAM_USER_ID;
const PAYMENT_REF_RE = /^PAY-[A-F0-9]{12}$/;
const PLAN_CODES = new Set(['PREMIUM_1_MONTH','PREMIUM_2_MONTHS','PREMIUM_3_MONTHS','LIFETIME']);

function dbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession:false, autoRefreshToken:false } });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch];
  });
}

function rupiah(value) {
  const n = Number(value);
  return Number.isFinite(n) ? 'Rp ' + Math.round(n).toLocaleString('id-ID') : '—';
}

function wib(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  try { return d.toLocaleString('id-ID', { timeZone:'Asia/Jakarta' }) + ' WIB'; }
  catch (_) { return d.toISOString(); }
}

function safeNote(value, max) {
  const s = String(value == null ? '' : value).trim();
  return s.slice(0, max || 500);
}

function publicBaseUrl(req) {
  const configured = String(process.env.SUBSCRIPTION_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? proto + '://' + host : 'https://autocuan.web.id';
}

async function bankSettings(db) {
  try {
    const result = await db.from('subscription_payment_settings')
      .select('bank_name,account_number,account_holder,active')
      .eq('singleton_key','bank_transfer')
      .eq('active',true)
      .maybeSingle();
    if (!result.error && result.data && result.data.bank_name && result.data.account_number && result.data.account_holder) {
      return {
        bank_name:String(result.data.bank_name),
        account_number:String(result.data.account_number),
        account_holder:String(result.data.account_holder)
      };
    }
  } catch (_) {}

  const bank = String(process.env.SUBSCRIPTION_BANK_NAME || '').trim();
  const number = String(process.env.SUBSCRIPTION_BANK_ACCOUNT || '').trim();
  const holder = String(process.env.SUBSCRIPTION_BANK_HOLDER || '').trim();
  if (bank && number && holder) return { bank_name:bank, account_number:number, account_holder:holder };
  return null;
}

async function requireUser(req, db) {
  const auth = await requireSubscriptionOnboardingUser(req, db);
  if (!auth.ok) return auth;
  return auth;
}

function requireBudi(req) {
  const auth = requireAdminSession(req);
  if (!auth.ok) return auth;
  if (String(auth.session.un || '').trim().toLowerCase() !== 'budi') {
    return { ok:false, status:403, error:'Akses admin ditolak.' };
  }
  return { ok:true, session:auth.session };
}

async function paymentRow(db, reference) {
  const result = await db.from('subscription_manual_payments').select('*').eq('payment_reference',reference).maybeSingle();
  return result && !result.error ? result.data : null;
}

async function usernameFor(db, userId) {
  const result = await db.from('app_users').select('username').eq('id',userId).maybeSingle();
  return result && !result.error && result.data ? String(result.data.username || '') : 'akun';
}

async function userTelegramChat(db, userId) {
  try {
    const linked = await db.from('telegram_subscription_links')
      .select('telegram_private_chat_id,telegram_user_id')
      .eq('user_id',userId).eq('link_state','linked').maybeSingle();
    if (!linked.error && linked.data) {
      const chat = Number(linked.data.telegram_private_chat_id || linked.data.telegram_user_id);
      if (Number.isSafeInteger(chat)) return chat;
    }
  } catch (_) {}
  try {
    const legacy = await db.from('app_user_telegram_verifications')
      .select('telegram_user_id').eq('user_id',userId).not('telegram_verified_at','is',null).maybeSingle();
    const chat = legacy && !legacy.error && legacy.data ? Number(legacy.data.telegram_user_id) : NaN;
    if (Number.isSafeInteger(chat)) return chat;
  } catch (_) {}
  return null;
}

function paymentAdminText(row, username, state) {
  const status = state || row.status;
  const lines = [
    status === 'submitted' ? '💳 <b>KONFIRMASI PEMBAYARAN</b>' : '💳 <b>PEMBAYARAN ' + escapeHtml(String(status || '').toUpperCase()) + '</b>',
    '',
    'User: <b>' + escapeHtml(username) + '</b>',
    'Paket: <b>' + escapeHtml(row.plan_code) + '</b>',
    'Nominal: <b>' + escapeHtml(rupiah(row.amount_due_idr)) + '</b>',
    'Pengirim: ' + escapeHtml(row.transfer_sender_name || '—'),
    'Voucher: ' + escapeHtml(row.voucher_code_hint ? '••••' + row.voucher_code_hint + (row.discount_percent ? ' (' + row.discount_percent + '%)' : '') : 'Tidak ada'),
    'Referensi: <code>' + escapeHtml(row.payment_reference) + '</code>',
    'Dikirim: ' + escapeHtml(wib(row.submitted_at || row.created_at))
  ];
  if (row.transfer_note) lines.push('Catatan: ' + escapeHtml(row.transfer_note));
  if (status === 'approved') lines.push('', '✅ Sudah dikonfirmasi admin.');
  if (status === 'rejected') lines.push('', '❌ Ditolak admin.');
  return lines.join('\n');
}

async function notifyAdminSubmitted(req, db, row) {
  const sender = createVoucherAdminSender();
  const username = await usernameFor(db, row.user_id);
  const reviewUrl = publicBaseUrl(req) + '/dashboard?paymentReview=' + encodeURIComponent(row.payment_reference);
  try {
    const sent = await sender.sendMessage(ADMIN_TELEGRAM_ID, paymentAdminText(row, username, 'submitted'), {
      reply_markup:{ inline_keyboard:[[{ text:'Buka & Konfirmasi', url:reviewUrl }]] }
    });
    const messageId = Number(sent && sent.message_id);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      await db.from('subscription_manual_payments').update({ admin_telegram_message_id:messageId, updated_at:new Date().toISOString() }).eq('id',row.id);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function updateAdminNotification(db, row, status) {
  const messageId = Number(row.admin_telegram_message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return false;
  const sender = createVoucherAdminSender();
  const username = await usernameFor(db, row.user_id);
  try {
    await sender.editMessageText(ADMIN_TELEGRAM_ID, messageId, paymentAdminText(row, username, status), { reply_markup:{ inline_keyboard:[] } });
    return true;
  } catch (_) { return false; }
}

async function notifyUserReview(db, row, result) {
  const chatId = await userTelegramChat(db, row.user_id);
  if (!chatId) return false;
  const sender = createVoucherAdminSender();
  let text;
  if (result.status === 'approved') {
    const expiry = result.lifetime ? 'Lifetime' : wib(result.expires_at);
    text = '✅ <b>Subscription Auto-Cuan aktif</b>\n\nPaket: ' + escapeHtml(result.plan_code || row.plan_code) + '\nBerlaku sampai: ' + escapeHtml(expiry) + '\nReferensi: <code>' + escapeHtml(row.payment_reference) + '</code>\n\nWebsite akan memperbarui akses secara otomatis.';
  } else {
    text = '❌ <b>Konfirmasi pembayaran belum disetujui</b>\n\nReferensi: <code>' + escapeHtml(row.payment_reference) + '</code>\nSilakan periksa kembali transfer atau hubungi admin.';
  }
  try { await sender.sendMessage(chatId, text); return true; } catch (_) { return false; }
}

async function cleanupVoucherDeliveryIfConsumed(db, voucherId) {
  if (!voucherId) return false;
  try {
    const voucher = await db.from('subscription_vouchers').select('id,attempt_id').eq('id',voucherId).maybeSingle();
    if (voucher.error || !voucher.data || !voucher.data.attempt_id) return false;
    const attemptId = voucher.data.attempt_id;
    const attempt = await db.from('voucher_batch_chunk_attempts').select('telegram_message_id,delivery_method').eq('id',attemptId).maybeSingle();
    if (attempt.error || !attempt.data || attempt.data.delivery_method !== 'message') return false;
    const messageId = Number(attempt.data.telegram_message_id);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return false;
    const siblings = await db.from('subscription_vouchers').select('id,redemption_count,max_redemptions,active,revoked_at').eq('attempt_id',attemptId);
    if (siblings.error || !Array.isArray(siblings.data) || !siblings.data.length) return false;
    const allFinished = siblings.data.every(function (v) {
      return v.active === false || Boolean(v.revoked_at) || Number(v.redemption_count) >= Number(v.max_redemptions);
    });
    if (!allFinished) return false;
    const sender = createVoucherAdminSender();
    await sender.deleteMessage(ADMIN_TELEGRAM_ID, messageId);
    return true;
  } catch (_) { return false; }
}

async function notifyVoucherClaim(db, row, username) {
  if (!row.voucher_id || !row.voucher_code_hint) return false;
  const sender = createVoucherAdminSender();
  const text = [
    '🎟️ <b>VOUCHER DIGUNAKAN</b>',
    '',
    'User: <b>' + escapeHtml(username) + '</b>',
    'Voucher: ••••' + escapeHtml(row.voucher_code_hint),
    'Diskon: ' + escapeHtml(String(row.discount_percent || '—')) + '%',
    'Paket: ' + escapeHtml(row.plan_code),
    'Pembayaran: <code>' + escapeHtml(row.payment_reference) + '</code>',
    'Waktu: ' + escapeHtml(wib(new Date().toISOString()))
  ].join('\n');
  try { await sender.sendMessage(ADMIN_TELEGRAM_ID, text); return true; } catch (_) { return false; }
}

function safePayment(row) {
  if (!row) return null;
  return {
    payment_reference:row.payment_reference,
    plan_code:row.plan_code,
    price_idr:Number(row.price_idr),
    discount_percent:row.discount_percent == null ? null : Number(row.discount_percent),
    amount_due_idr:Number(row.amount_due_idr),
    voucher_code_hint:row.voucher_code_hint || null,
    status:row.status,
    transfer_sender_name:row.transfer_sender_name || null,
    transfer_note:row.transfer_note || null,
    submitted_at:row.submitted_at || null,
    reviewed_at:row.reviewed_at || null,
    created_at:row.created_at
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control','private, no-store, no-cache, must-revalidate, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ success:false, error:'Method not allowed' });
  if (!isSameOrigin(req)) return res.status(403).json({ success:false, error:'Permintaan ditolak.' });

  const db = dbClient();
  if (!db) return res.status(503).json({ success:false, error:'Pembayaran belum tersedia.' });
  const action = String(req.body && req.body.action || '').trim();

  try {
    if (action === 'admin-detail' || action === 'admin-review') {
      const admin = requireBudi(req);
      if (!admin.ok) return res.status(admin.status || 403).json({ success:false, error:admin.error || 'Akses admin ditolak.' });
      const reference = String(req.body && req.body.payment_reference || '').trim().toUpperCase();
      if (!PAYMENT_REF_RE.test(reference)) return res.status(400).json({ success:false, error:'Referensi tidak valid.' });
      let row = await paymentRow(db, reference);
      if (!row) return res.status(404).json({ success:false, error:'Pembayaran tidak ditemukan.' });
      const username = await usernameFor(db, row.user_id);
      if (action === 'admin-detail') return res.status(200).json({ success:true, payment:safePayment(row), username:username });

      const decision = String(req.body && req.body.decision || '').toLowerCase();
      if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ success:false, error:'Keputusan tidak valid.' });
      const reviewed = await db.rpc('review_manual_subscription_payment', {
        p_payment_reference:reference,
        p_admin_telegram_user_id:ADMIN_TELEGRAM_ID,
        p_decision:decision
      });
      if (reviewed.error || !reviewed.data) return res.status(409).json({ success:false, error:'Pembayaran belum dapat dikonfirmasi.' });
      row = await paymentRow(db, reference) || row;
      await updateAdminNotification(db, row, reviewed.data.status);
      await notifyUserReview(db, row, reviewed.data);
      if (reviewed.data.status === 'approved' && row.voucher_id) {
        await notifyVoucherClaim(db, row, username);
        await cleanupVoucherDeliveryIfConsumed(db, row.voucher_id);
      }
      return res.status(200).json({ success:true, result:reviewed.data, payment:safePayment(row) });
    }

    const auth = await requireUser(req, db);
    if (!auth.ok) return res.status(auth.status || 401).json({ success:false, error:auth.error || 'Sesi tidak valid.' });

    if (action === 'create') {
      const bank = await bankSettings(db);
      if (!bank) return res.status(503).json({ success:false, code:'BANK_CONFIG_MISSING', error:'Rekening pembayaran belum tersedia.' });
      const planCode = String(req.body && req.body.plan_code || '').trim().toUpperCase();
      if (!PLAN_CODES.has(planCode)) return res.status(400).json({ success:false, error:'Paket tidak valid.' });
      const idempotencyKey = String(req.body && req.body.idempotency_key || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) return res.status(400).json({ success:false, error:'Permintaan tidak valid.' });
      const rawVoucher = safeNote(req.body && req.body.voucher_code, 64).toUpperCase();
      let voucherHash = null;
      if (rawVoucher) {
        try { voucherHash = vouchers.voucherCodeHash(rawVoucher); }
        catch (_) { return res.status(400).json({ success:false, error:'Voucher tidak valid.' }); }
        const quote = await db.rpc('quote_subscription_voucher', { p_user_id:auth.account.id, p_voucher_code_hash:voucherHash, p_redemption_idempotency_key:null });
        if (quote.error || !quote.data) return res.status(409).json({ success:false, error:'Voucher tidak dapat digunakan.' });
        const type = String(quote.data.voucher_type || '');
        if (type !== 'PERCENT_30' && type !== 'PERCENT_50') {
          return res.status(409).json({ success:false, code:'DIRECT_VOUCHER', error:'Voucher ini mengaktifkan akses langsung. Gunakan tombol Aktivkan voucher di bagian Voucher.' });
        }
      }
      const made = await db.rpc('create_manual_subscription_payment', {
        p_user_id:auth.account.id,
        p_plan_code:planCode,
        p_voucher_code_hash:voucherHash,
        p_request_idempotency_key:idempotencyKey
      });
      if (made.error || !made.data) return res.status(409).json({ success:false, error:'Permintaan pembayaran tidak dapat dibuat.' });
      return res.status(200).json({ success:true, payment:made.data, bank:bank });
    }

    if (action === 'submit') {
      const reference = String(req.body && req.body.payment_reference || '').trim().toUpperCase();
      if (!PAYMENT_REF_RE.test(reference)) return res.status(400).json({ success:false, error:'Referensi tidak valid.' });
      const senderName = safeNote(req.body && req.body.transfer_sender_name, 100);
      const note = safeNote(req.body && req.body.transfer_note, 500);
      const submitted = await db.rpc('submit_manual_subscription_payment', {
        p_user_id:auth.account.id,
        p_payment_reference:reference,
        p_transfer_sender_name:senderName,
        p_transfer_note:note
      });
      if (submitted.error || !submitted.data) return res.status(409).json({ success:false, error:'Konfirmasi transfer belum dapat dikirim.' });
      const row = await paymentRow(db, reference);
      const notified = row ? await notifyAdminSubmitted(req, db, row) : false;
      return res.status(200).json({ success:true, payment:row ? safePayment(row) : submitted.data, admin_notified:notified });
    }

    if (action === 'status') {
      const reference = String(req.body && req.body.payment_reference || '').trim().toUpperCase();
      if (!PAYMENT_REF_RE.test(reference)) return res.status(400).json({ success:false, error:'Referensi tidak valid.' });
      const row = await paymentRow(db, reference);
      if (!row || String(row.user_id) !== String(auth.account.id)) return res.status(404).json({ success:false, error:'Pembayaran tidak ditemukan.' });
      return res.status(200).json({ success:true, payment:safePayment(row) });
    }

    return res.status(400).json({ success:false, error:'Aksi tidak valid.' });
  } catch (_) {
    return res.status(500).json({ success:false, error:'Pembayaran sedang bermasalah. Silakan coba lagi.' });
  }
};

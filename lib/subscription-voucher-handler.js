'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireSubscriptionOnboardingUser } = require('../lib/subscription-auth');
const { isSameOrigin } = require('../lib/admin-session');
const vouchers = require('../lib/vouchers');
const { notifyClaim } = require('../lib/subscription-voucher-claim');

function dbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth:{ persistSession:false, autoRefreshToken:false } });
}

function uuid() {
  try { return crypto.randomUUID(); } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control','private, no-store, no-cache, must-revalidate, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ success:false, error:'Method not allowed' });
  if (!isSameOrigin(req)) return res.status(403).json({ success:false, error:'Permintaan ditolak.' });
  const db = dbClient();
  if (!db) return res.status(503).json({ success:false, error:'Voucher belum tersedia.' });

  try {
    const auth = await requireSubscriptionOnboardingUser(req, db);
    if (!auth.ok) return res.status(auth.status || 401).json({ success:false, error:auth.error || 'Sesi tidak valid.' });
    const raw = String(req.body && req.body.voucher_code || '').trim().toUpperCase();
    let hash;
    try { hash = vouchers.voucherCodeHash(raw); }
    catch (_) { return res.status(400).json({ success:false, error:'Voucher tidak valid.' }); }

    const quote = await db.rpc('quote_subscription_voucher', {
      p_user_id:auth.account.id,
      p_voucher_code_hash:hash,
      p_redemption_idempotency_key:null
    });
    if (quote.error || !quote.data) return res.status(409).json({ success:false, error:'Voucher tidak dapat digunakan.' });
    const type = String(quote.data.voucher_type || '');
    if (type === 'PERCENT_30' || type === 'PERCENT_50') {
      return res.status(409).json({ success:false, code:'PAYMENT_REQUIRED', error:'Voucher diskon digunakan saat checkout transfer manual.' });
    }

    const key = String(req.body && req.body.idempotency_key || '') || uuid();
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
      return res.status(400).json({ success:false, error:'Permintaan tidak valid.' });
    }
    const redeemed = await db.rpc('redeem_subscription_voucher', {
      p_user_id:auth.account.id,
      p_voucher_code_hash:hash,
      p_redemption_idempotency_key:key
    });
    if (redeemed.error || !redeemed.data || redeemed.data.redeemed !== true) {
      return res.status(409).json({ success:false, error:'Voucher tidak dapat diaktifkan.' });
    }
    const notification = await notifyClaim({ db, userId:auth.account.id, voucherHash:hash, redeemed:redeemed.data, source:'web' });
    return res.status(200).json({
      success:true,
      voucher:redeemed.data,
      admin_notified:notification.notified === true,
      user_notified:notification.user_notified === true
    });
  } catch (_) {
    return res.status(500).json({ success:false, error:'Voucher sedang bermasalah. Silakan coba lagi.' });
  }
};
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { createSessionToken, buildSessionCookie, buildClearCookie, getSessionSecret, buildClearOnboardingCookie, isSameOrigin } = require('../lib/admin-session');
const { requireUserSession, requireNonBlockedUser, requireSubscriptionOnboardingUser, resolvePremiumAccess } = require('../lib/subscription-auth');
const identity = require('../lib/subscription-identity');
const { resolveEntitlements } = require('../lib/entitlements');
const { isSubscriptionFeatureEnabled, getSubscriptionCapability, isVoucherAdminBotEnabled, getVoucherAdminCapability } = require('../lib/subscription-capability');
const voucherAdminBot = require('../lib/voucher-admin-bot');
const vouchers = require('../lib/vouchers');
const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');
const telegramVerification = require('../lib/telegram-verification');
const { createVerifyBot } = require('../lib/telegram-verify-bot');

const MAX_DEVICES = 3;

// Max accepted webhook body size (bytes). A normal Telegram update is well under
// this; anything larger is rejected before parsing/processing.
const MAX_WEBHOOK_BODY_BYTES = 32 * 1024;

// Constant-time secret comparison that never short-circuits on length.
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Compare against itself to keep timing roughly constant, then fail.
    try { crypto.timingSafeEqual(b, b); } catch (e) {}
    return false;
  }
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// Isolated Telegram verification webhook handler. It runs BEFORE any login /
// logout / session logic, validates its own secret, and never touches cookies,
// sessions, or CRON_SECRET. It uses TELEGRAM_VERIFY_BOT_TOKEN only (via the
// verify bot) and never imports the recommendation notifier.
async function handleVerifyWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  // Fail-closed secret validation BEFORE parsing/processing the update.
  const expectedSecret = process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!expectedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return res.status(401).json({ ok: false });
  }

  // Strict request-size limit (header-based, then serialized-body based).
  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return res.status(413).json({ ok: false });
  }
  const update = req.body || {};
  try {
    if (JSON.stringify(update).length > MAX_WEBHOOK_BODY_BYTES) {
      return res.status(413).json({ ok: false });
    }
  } catch (e) {
    return res.status(400).json({ ok: false });
  }

  // Require a numeric update_id (needed for durable idempotency).
  if (typeof update.update_id !== 'number' || !Number.isFinite(update.update_id)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    // Cannot process without the DB; ack so Telegram does not hammer retries.
    return res.status(200).json({ ok: true });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const bot = createVerifyBot();
    const result = await telegramVerification.processWebhookUpdate(update, { supabase, bot });
    // Only a coarse outcome code is returned/logged — never raw user input.
    return res.status(200).json({ ok: true, outcome: result && result.outcome });
  } catch (e) {
    // Never leak internals; still ack to avoid unbounded Telegram retries.
    return res.status(200).json({ ok: true });
  }
}
async function subscriptionDb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function safeRequestId(prefix) { return prefix + '_' + crypto.randomBytes(16).toString('base64url'); }
async function subscriptionAccount(req, db) { return requireSubscriptionOnboardingUser(req, db); }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
async function handleSubscriptionTelegramWebhook(req, res) {
  if (!isSubscriptionFeatureEnabled()) return res.status(404).json({ ok: false });
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const expected = process.env.TELEGRAM_SUBSCRIPTION_WEBHOOK_SECRET;
  if (!expected || !secretsMatch(req.headers['x-telegram-bot-api-secret-token'], expected)) return res.status(401).json({ ok: false });
  if (Number(req.headers['content-length'] || 0) > MAX_WEBHOOK_BODY_BYTES) return res.status(413).json({ ok: false });
  const update = req.body || {}; let body;
  try { body = JSON.stringify(update); } catch (_) { return res.status(400).json({ ok: false }); }
  if (body.length > MAX_WEBHOOK_BODY_BYTES || !Number.isSafeInteger(update.update_id)) return res.status(200).json({ ok: true });
  const message = update.message || {}, from = message.from || {}, chat = message.chat || {};
  if (chat.type !== 'private' || !Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || typeof message.text !== 'string') return res.status(200).json({ ok: true });
  const text = message.text.trim(); const match = /^\/start\s+([A-Za-z0-9_-]{20,200})$/.exec(text);
  const db = await subscriptionDb(); if (!db) return res.status(200).json({ ok: true });
  if (/^\/trial(?:@\w+)?$/i.test(text)) {
    // Telegram sender identity is read only from this authenticated private update.
    const link=await db.from('telegram_subscription_links').select('user_id').eq('telegram_user_id',from.id).eq('link_state','linked').maybeSingle();
    if (!link.error && link.data) { try { await db.rpc('activate_subscription_trial',{p_user_id:link.data.user_id,p_activation_idempotency_key:crypto.createHash('sha256').update('telegram-update:'+update.update_id).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5'),p_activation_time:new Date().toISOString()}); } catch (_) {} }
    return res.status(200).json({ok:true});
  }
  if (!match) return res.status(200).json({ ok: true });
  let tokenHash; try { tokenHash = identity.linkTokenHash(match[1]); } catch (_) { return res.status(200).json({ ok: true }); }
  try { await db.rpc('consume_subscription_telegram_link', { p_token_hash: tokenHash, p_telegram_user_id: from.id, p_chat_id: chat.id, p_update_id: update.update_id }); } catch (_) { /* generic ack only */ }
  return res.status(200).json({ ok: true });
}
async function handleVoucherAdminTelegramWebhook(req,res) {
  // Dedicated route and dedicated secret: it never shares a verification or customer-bot secret. The retired TELEGRAM_VOUCHER_ADMIN_WEBHOOK_SECRET is intentionally not read.
  if (!isVoucherAdminBotEnabled()) return res.status(404).json({ok:false});
  if (req.method !== 'POST') return res.status(405).json({ok:false});
  const expected=process.env.VOUCHER_ADMIN_TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !secretsMatch(req.headers['x-telegram-bot-api-secret-token'],expected)) return res.status(401).json({ok:false});
  if (Number(req.headers['content-length']||0)>MAX_WEBHOOK_BODY_BYTES) return res.status(413).json({ok:false});
  const update=req.body; let serialized;
  try { serialized=JSON.stringify(update); } catch (_) { return res.status(400).json({ok:false}); }
  if (!update || serialized.length>MAX_WEBHOOK_BODY_BYTES || !Number.isSafeInteger(update.update_id)) return res.status(200).json({ok:true});
  const db=await subscriptionDb(); const capability=await getVoucherAdminCapability(db);
  if (!capability.ready) return res.status(200).json({ok:true});
  // The bot boundary does not log raw updates, commands, codes, or Telegram identities.
  try { await voucherAdminBot.processVoucherAdminUpdate(update,{db,capability}); } catch (_) { /* generic Telegram acknowledgement */ }
  return res.status(200).json({ok:true});
}
async function subscriptionLinkStatus(db, userId) {
  const r=await db.from('telegram_subscription_links').select('link_state').eq('user_id',userId).maybeSingle();
  return !r.error && !!r.data && r.data.link_state === 'linked';
}
async function handleSubscriptionAction(req, res, action) {
  if (!isSubscriptionFeatureEnabled()) return res.status(503).json({ success:false, error:'Fitur langganan belum tersedia.' });
  const db = await subscriptionDb(); if (!db) return res.status(503).json({ success:false, error:'Fitur langganan belum tersedia.' });
  const capability = await getSubscriptionCapability(db); if (!capability.ready) return res.status(503).json({ success:false, error:'Fitur langganan belum tersedia.' });
  const auth = await subscriptionAccount(req, db); if (!auth.ok) return res.status(auth.status).json({ success:false, error:auth.error });
  const account = auth.account;
  if (action === 'subscription-telegram-link-status') return res.status(200).json({success:true,linked:await subscriptionLinkStatus(db,account.id)});
  if (action === 'subscription-telegram-link-token-create') { let token,hash; try { token=identity.createLinkToken();hash=identity.linkTokenHash(token); } catch (_) { return res.status(503).json({success:false,error:'Tautan Telegram tidak tersedia.'}); } const requestId=safeRequestId('telegram'); const issued=await db.rpc('issue_subscription_telegram_link_token',{p_user_id:account.id,p_token_hash:hash,p_request_id:requestId,p_expires_at:new Date(Date.now()+identity.LINK_TTL_MS).toISOString()}); if(issued.error)return res.status(503).json({success:false,error:'Tautan Telegram tidak tersedia.'}); if(issued.data==='rate_limited') return res.status(429).json({success:false,error:'Tunggu sebentar sebelum membuat tautan baru.'}); const bot=String(process.env.TELEGRAM_SUBSCRIPTION_BOT_USERNAME||'').replace(/^@/,''); return res.status(200).json({success:true,telegram_link:bot?'https://t.me/'+encodeURIComponent(bot)+'?start='+token:token}); }
  const rows=await db.from('user_entitlements').select('source,status,starts_at,expires_at,lifetime').eq('user_id',account.id);
  const entitlement=await resolveEntitlements(auth.user,account,db);
  const trial=(rows.data||[]).filter(r=>r.source==='trial')[0]; const linked=await subscriptionLinkStatus(db,account.id);
  if(action==='subscription-trial-status') return res.status(200).json({success:true,available:auth.user.username==='budi'?false:!trial,consumed:!!trial,active:entitlement.trial_state==='active',starts_at:trial&&trial.starts_at||null,expires_at:trial&&trial.expires_at||null,duration_days:10,telegram_link_required:!linked,account_approval_state:account.is_approved===true?'approved':'pending',admin:auth.user.username==='budi'});
  if(action==='subscription-trial-activate') {
    if(!isSameOrigin(req)) return res.status(403).json({success:false,error:'Permintaan ditolak.'});
    const id=req.body&&req.body.idempotency_key; if(!isUuid(id)) return res.status(400).json({success:false,error:'Permintaan tidak valid.'});
    if(!linked) return res.status(409).json({success:false,error:'Hubungkan Telegram terlebih dahulu.'});
    const activated=await db.rpc('activate_subscription_trial',{p_user_id:account.id,p_activation_idempotency_key:id,p_activation_time:new Date().toISOString()});
    if(activated.error || !activated.data) return res.status(409).json({success:false,error:'Trial tidak dapat diaktifkan.'});
    if(auth.onboarding) res.setHeader('Set-Cookie',buildClearOnboardingCookie());
    return res.status(200).json({success:true,active:activated.data.active===true,starts_at:activated.data.starts_at,expires_at:activated.data.expires_at,duration_days:10,normal_login_required:auth.onboarding===true});
  }
  if(action==='voucher-quote'||action==='voucher-redeem') {
    if(!isSameOrigin(req)) return res.status(403).json({success:false,error:'Permintaan ditolak.'});
    let hash; try { hash=vouchers.voucherCodeHash(req.body&&req.body.voucher_code); } catch (_) { return res.status(400).json({success:false,error:'Voucher tidak valid.'}); }
    const result=await db.rpc(action==='voucher-quote'?'quote_subscription_voucher':'redeem_subscription_voucher',{p_user_id:account.id,p_voucher_code_hash:hash,p_redemption_idempotency_key:action==='voucher-redeem'?req.body&&req.body.idempotency_key:null});
    if(result.error||!result.data) return res.status(409).json({success:false,error:'Voucher tidak dapat digunakan.'});
    return res.status(200).json({success:true,voucher:result.data});
  }
  return res.status(400).json({success:false,error:'Aksi tidak valid.'});
}

const LEGACY_BUDI_PASSWORD_HASH = crypto
  .createHash('sha256')
  .update('._autocuan_salt_2024', 'utf8')
  .digest('hex');

function matchesLegacyBudiPassword(passwordHash) {
  if (typeof passwordHash !== 'string') return false;
  const supplied = Buffer.from(passwordHash, 'utf8');
  const expected = Buffer.from(LEGACY_BUDI_PASSWORD_HASH, 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isRegisteredDevice(user, deviceId) {
  if (typeof deviceId !== 'string' || !deviceId) return false;
  const currentDevices = Array.isArray(user.devices) ? user.devices : [];
  return user.device_id === deviceId || currentDevices.includes(deviceId);
}

// Generic credential error to prevent username enumeration (invalid username and
// invalid password produce the identical public response).
const GENERIC_CREDENTIAL_ERROR = 'Username atau password salah.';

// Issue the signed session cookie on a successful, DB-authenticated login.
// Admin is derived SERVER-SIDE only (never from client input). Fail-closed: if no
// SESSION_SECRET is configured, no cookie is set and admin endpoints stay locked.
function issueSessionCookie(res, user, usernameLower, deviceId) {
  const result = { isAdmin: usernameLower === 'budi', issued: false };
  try {
    const token = createSessionToken({ userId: user.id, username: usernameLower, isAdmin: result.isAdmin, deviceId: deviceId });
    if (token) {
      res.setHeader('Set-Cookie', buildSessionCookie(token));
      result.issued = true;
    }
  } catch (e) {
    // Never log token/secret/device. Fail-closed: no session is considered issued.
  }
  return result;
}

module.exports = async function handler(req, res) {
  // === TELEGRAM VERIFICATION WEBHOOK ===
  // This isolated action runs FIRST, before logout / password / session / normal
  // login handling. It validates its own secret, never issues or reads browser
  // sessions, never touches CRON_SECRET, and uses TELEGRAM_VERIFY_BOT_TOKEN only.
  if (req.query && req.query.action === 'subscription-telegram-webhook') {
    return await handleSubscriptionTelegramWebhook(req, res);
  }
  if (req.query && req.query.action === 'voucher-admin-telegram-webhook') return await handleVoucherAdminTelegramWebhook(req,res);

  if (req.query && req.query.action === 'telegram-verify-webhook') {
    return await handleVerifyWebhook(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent, action } = req.body || {};

    const subscriptionAction = (req.query && req.query.action) || action;
    if (subscriptionAction === 'subscription-capability') {
      if (!isSubscriptionFeatureEnabled()) return res.status(200).json({ success: true, enabled: false, ready: false });
      const db = await subscriptionDb();
      const capability = await getSubscriptionCapability(db);
      return res.status(200).json({ success: true, enabled: capability.enabled, ready: capability.ready });
    }
    if (subscriptionAction === 'premium-access-status') {
      res.setHeader('Cache-Control', 'private, no-store');
      const db = await subscriptionDb();
      if (!db) return res.status(503).json({ success:false, error:'Status akses tidak tersedia.' });
      const access = await resolvePremiumAccess(req, db);
      if (!access.ok) return res.status(access.status || 403).json({ success:false, error:access.error || 'Akses ditolak.' });
      return res.status(200).json({ success:true, premium:access.premium === true, access_level:access.access_level,
        entitlement_status:access.entitlement && access.entitlement.entitlement_status || 'none',
        current_plan:access.entitlement && access.entitlement.current_plan || null,
        expires_at:access.entitlement && access.entitlement.expires_at || null });
    }

    if (/^(subscription-(telegram-link-token-create|telegram-link-status|trial-status|trial-activate)|voucher-(quote|redeem))$/.test(subscriptionAction || '')) {
      return await handleSubscriptionAction(req, res, subscriptionAction);
    }

    // Public, deliberately narrow catalog. It only reads active catalog rows and
    // server-resolves the effective price at this instant.
    if ((req.query && req.query.action === 'subscription-plans') || action === 'subscription-plans') {
      if (!isSubscriptionFeatureEnabled()) return res.status(503).json({ success: false, error: 'Fitur langganan belum tersedia.' });
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return res.status(503).json({ success: false, error: 'Katalog tidak tersedia.' });
      const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const capability = await getSubscriptionCapability(db);
      if (!capability.ready) return res.status(503).json({ success: false, error: 'Fitur langganan belum tersedia.' });
      const result = await db.from('subscription_plans').select('code, display_name, kind, duration_months, subscription_plan_prices!inner(normal_price_idr, promo_price_idr, promo_enabled, promo_starts_at, promo_ends_at, active)')
        .eq('active', true).eq('subscription_plan_prices.active', true).order('sort_order');
      if (result.error) return res.status(503).json({ success: false, error: 'Katalog tidak tersedia.' });
      const now = Date.now();
      const plans = (result.data || []).map(plan => {
        const price = Array.isArray(plan.subscription_plan_prices) ? plan.subscription_plan_prices[0] : plan.subscription_plan_prices;
        const promotionActive = Boolean(price && price.promo_enabled && price.promo_price_idr != null && price.promo_starts_at && new Date(price.promo_starts_at).getTime() <= now && (!price.promo_ends_at || now < new Date(price.promo_ends_at).getTime()));
        return { code: plan.code, display_name: plan.display_name, kind: plan.kind, duration_months: plan.duration_months,
          normal_price_idr: price.normal_price_idr, promotional_price_idr: promotionActive ? price.promo_price_idr : null,
          promotion_active: promotionActive, promo_starts_at: price.promo_starts_at, promo_ends_at: price.promo_ends_at, currency: 'IDR' };
      });
      return res.status(200).json({ success: true, plans: plans });
    }

    // Read-only Phase 1 entitlement endpoint. The identity comes only from the
    // signed HttpOnly session; request headers and body claims are ignored.
    if ((req.query && req.query.action === 'subscription-status') || action === 'subscription-status') {
      if (!isSubscriptionFeatureEnabled()) return res.status(503).json({ success: false, error: 'Fitur langganan belum tersedia.' });
      const auth = requireUserSession(req);
      if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ success: false, error: 'Status akun tidak tersedia.' });
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const capability = await getSubscriptionCapability(supabase);
      if (!capability.ready) return res.status(503).json({ success: false, error: 'Fitur langganan belum tersedia.' });
      const { data: account, error } = await supabase.from('app_users')
        .select('id, username, is_blocked, is_approved')
        .eq('id', auth.user.id)
        .maybeSingle();
      if (error || !account || String(account.username || '').trim().toLowerCase() !== auth.user.username) {
        return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
      }
      const entitlement = await resolveEntitlements(auth.user, account, supabase);
      return res.status(200).json({
        success: true,
        account: { username: account.username, approved: account.is_approved === true, blocked: account.is_blocked === true },
        entitlement: entitlement
      });
    }

    // === LOGOUT === (explicit; does not require a valid token or DB access)
    if (action === 'logout') {
      res.setHeader('Set-Cookie', [buildClearCookie(), buildClearOnboardingCookie()]);
      return res.status(200).json({ success: true });
    }

    // Validate inputs. A legacy-shaped budi request with no device must fail with
    // the same generic credential response as every other compatibility failure.
    if (!username || !passwordHash) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    const usernameLower = String(username).trim().toLowerCase();

    if (!deviceId) {
      if (usernameLower === 'budi' && matchesLegacyBudiPassword(passwordHash)) {
        return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
      }
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    if (!usernameLower || usernameLower.length < 2) {
      return res.status(400).json({ success: false, error: 'Username tidak valid.' });
    }

    // Supabase setup
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Find user by username
    const { data: user, error: findError } = await supabase
      .from('app_users')
      .select('id, username, password_hash, device_id, devices, is_blocked, is_approved')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError) {
      console.error('login-user find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa akun.' });
    }

    // Verify credentials FIRST with a single generic message so an attacker cannot
    // distinguish "unknown username" from "wrong password" (anti-enumeration).
    // Account-state messages (blocked / not approved) are only revealed AFTER the
    // correct password is provided.
    if (!user) {
      console.error('login-user: authentication failed (unknown account)');
      return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
    }

    const databasePasswordMatches = user.password_hash === passwordHash;

    if (!databasePasswordMatches) {
      // Narrow compatibility for the historical budi + "." login. The browser
      // still hashes the entered password through the shared client algorithm;
      // the legacy hash alone is insufficient and never bypasses device binding.
      const legacyBudiPasswordMatches = usernameLower === 'budi' && matchesLegacyBudiPassword(passwordHash);
      const legacyBudiMayLogin = legacyBudiPasswordMatches &&
        Boolean(getSessionSecret()) &&
        user.is_blocked === false &&
        user.is_approved === true &&
        isRegisteredDevice(user, deviceId);

      if (!legacyBudiMayLogin) {
        console.error('login-user: authentication failed (bad password)');
        return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
      }

      // Compatibility success is deliberately read-only: do not update login
      // metadata and never append/trust a device. Admin is derived server-side.
      const legacySession = issueSessionCookie(res, user, usernameLower, deviceId);
      if (!legacySession.issued) {
        return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
      }
      return res.status(200).json({
        success: true,
        username: usernameLower,
        userId: user.id,
        isAdmin: legacySession.isAdmin
      });
    }

    // Database credentials are valid from here on; preserve the existing normal
    // login, account-state, and device-registration behavior unchanged.

    // Check if blocked
    if (user.is_blocked) {
      return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
    }

    // Check approval status (skip for review user — review bypasses approval).
    // Reaching here guarantees the submitted password already matched, so it is
    // safe to reveal pending-approval details. Users who registered before this
    // feature never received their recognition code; surface it now WITHOUT
    // issuing a session or logging them in. The AC-XXXXXX value is a public
    // recognition code, not an authentication credential.
    if (usernameLower !== 'review' && user.is_approved === false) {
      // v2: issue a FRESH one-time verification code (rotating/revoking any prior
      // active challenge) for this pending user. No session is issued and no
      // channel link is exposed. The raw code is returned only after the RPC
      // commits. If issuance is unavailable (e.g. secret not configured), we
      // still surface the recognition code without a verification code.
      const pendingResponse = {
        success: false,
        approval_status: 'pending',
        approval_code: generateApprovalCode({ id: user.id, username: user.username, created_at: user.created_at }),
        masked_username: maskUsername(user.username),
        telegram_bot_url: telegramVerification.BOT_URL
      };
      try {
        if (telegramVerification.hasCodeSecret()) {
          const issued = await telegramVerification.issueChallengeForUser(supabase, user.id);
          if (issued) {
            pendingResponse.telegram_verification_code = issued.displayCode;
            pendingResponse.telegram_verification_expires_at = issued.expiresAt;
          }
        }
      } catch (e) {
        console.error('login-user: pending challenge issuance failed');
      }
      // Subscription onboarding is disabled until its server capability is provisioned.
      // Do not issue a cookie that could make unfinished subscription actions available.
      return res.status(403).json(pendingResponse);
    }

    // === REVIEW USER: bypass device binding ===
    if (usernameLower === 'review') {
      const { error: updateError } = await supabase
        .from('app_users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', user.id);

      if (updateError) {
        console.error('login-user review update error:', updateError);
      }

      issueSessionCookie(res, user, usernameLower, deviceId);
      return res.status(200).json({
        success: true,
        username: 'review',
        userId: user.id,
        isAdmin: false,
        isReview: true
      });
    }

    // === MULTI-DEVICE BINDING (max 3 devices) ===
    const currentDevices = Array.isArray(user.devices) ? user.devices : [];

    // Check if this device is already registered for this user
    if (currentDevices.includes(deviceId)) {
      // Device already known — just update last_login_at
      const { error: updateError } = await supabase
        .from('app_users')
        .update({
          last_login_at: new Date().toISOString(),
          user_agent: userAgent || ''
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('login-user update error:', updateError);
      }

      const knownDeviceSession = issueSessionCookie(res, user, usernameLower, deviceId);
      return res.status(200).json({
        success: true,
        username: usernameLower,
        userId: user.id,
        isAdmin: knownDeviceSession.isAdmin
      });
    }

    // Device is new — check if there's room
    if (currentDevices.length >= MAX_DEVICES) {
      return res.status(400).json({
        success: false,
        error: 'Batas perangkat tercapai. Hubungi admin untuk reset perangkat.'
      });
    }

    // Add new device to the array
    const updatedDevices = [...currentDevices, deviceId];

    const { error: updateError } = await supabase
      .from('app_users')
      .update({
        devices: updatedDevices,
        user_agent: userAgent || '',
        last_login_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('login-user device add error:', updateError);
      return res.status(500).json({ success: false, error: 'Gagal memperbarui perangkat.' });
    }

    const newDeviceSession = issueSessionCookie(res, user, usernameLower, deviceId);
    return res.status(200).json({
      success: true,
      username: usernameLower,
      userId: user.id,
      isAdmin: newDeviceSession.isAdmin
    });
  } catch (e) {
    console.error('login-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};

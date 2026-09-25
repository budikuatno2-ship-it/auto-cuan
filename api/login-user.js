const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { createSessionToken, buildSessionCookie, buildClearCookie, buildClearOnboardingCookie, isSameOrigin } = require('../lib/admin-session');
const { requireUserSession, requireNonBlockedUser, requireSubscriptionOnboardingUser, resolvePremiumAccess } = require('../lib/subscription-auth');
const identity = require('../lib/subscription-identity');
const { resolveEntitlements } = require('../lib/entitlements');
const { isSubscriptionFeatureEnabled, getSubscriptionCapability, isVoucherAdminBotEnabled, getVoucherAdminCapability } = require('../lib/subscription-capability');
const voucherAdminBot = require('../lib/voucher-admin-bot');
const vouchers = require('../lib/vouchers');
const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');
const telegramVerification = require('../lib/telegram-verification');
const { createVerifyBot } = require('../lib/telegram-verify-bot');
const securityGuard = require('../lib/security-guard');
const passwordCredential = require('../lib/password-credential');
const adminDeviceApproval = require('../lib/admin-device-approval');
const accountTerms = require('../lib/account-terms');
const { verifyRecaptcha } = require('../lib/recaptcha-verify');
const { clientAddress } = require('../lib/request-rate-limit');
const telegramMagicToken = require('../lib/telegram-magic-token');

const MAX_DEVICES = 3;

// Preview detection must not trust client-controlled headers. `Origin` is set by
// the caller, so `Origin: https://anything.vercel.app` used to mark a production
// login as "preview" and skip the 3-device binding. The only trustworthy signal
// is the host the platform actually routed the request to (req.headers.host),
// compared against the official production domain.
const OFFICIAL_HOSTS = ['autocuan.web.id', 'www.autocuan.web.id'];
function isVercelPreviewRequest(req) {
  if (!req || !req.headers) return false;
  const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (!host) return false;
  if (OFFICIAL_HOSTS.includes(host)) return false;
  return host.endsWith('.vercel.app');
}

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
    const result = await telegramVerification.processWebhookUpdate(update, {
      supabase,
      bot,
      magicTokenStore: telegramMagicToken,
      registerTokenStore: require('../lib/telegram-register-token')
    });
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
    if(action==='voucher-redeem') {
      const termsCheck = accountTerms.paymentAcceptance(req.body);
      if(!termsCheck.ok) return res.status(400).json({success:false,error:'Anda wajib menyetujui ketentuan aktivasi voucher.'});
    }
    let hash; try { hash=vouchers.voucherCodeHash(req.body&&req.body.voucher_code); } catch (_) { return res.status(400).json({success:false,error:'Voucher tidak valid.'}); }
    const result=await db.rpc(action==='voucher-quote'?'quote_subscription_voucher':'redeem_subscription_voucher',{p_user_id:account.id,p_voucher_code_hash:hash,p_redemption_idempotency_key:action==='voucher-redeem'?req.body&&req.body.idempotency_key:null});
    if(result.error||!result.data) return res.status(409).json({success:false,error:'Voucher tidak dapat digunakan.'});
    if(action==='voucher-redeem') {
      await accountTerms.recordTermsAcceptance(db, account.id, 'voucher');
    }
    return res.status(200).json({success:true,voucher:result.data});
  }
  return res.status(400).json({success:false,error:'Aksi tidak valid.'});
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

async function handleMagicLogin(req, res) {
  const body = req.body || {};
  const query = req.query || {};
  const authToken = String(body.authToken || body.auth_token || query.auth_token || query.authToken || '').trim();
  const userId = String(body.userId || body.user_id || query.user_id || query.userId || '').trim();
  const deviceId = String(body.deviceId || body.device_id || 'dev_' + crypto.randomBytes(8).toString('hex')).trim();
  const userAgent = String(body.userAgent || req.headers['user-agent'] || '');

  if (!authToken || !userId) {
    if (req.method === 'GET') {
      res.statusCode = 302;
      res.setHeader('Location', '/?login=expired');
      return res.end();
    }
    return res.status(400).json({
      success: false,
      error: 'Data login otomatis tidak lengkap. Silakan ketik /start di bot Telegram.'
    });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let supabase = null;
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  // Consume and burn magic token atomically (single use)
  const consumed = await telegramMagicToken.consumeToken(supabase, authToken, userId);
  if (!consumed || !consumed.ok) {
    if (req.method === 'GET') {
      res.statusCode = 302;
      res.setHeader('Location', '/?login=expired');
      return res.end();
    }
    return res.status(400).json({
      success: false,
      error: 'Tautan login tidak valid atau sudah kedaluwarsa. Silakan ketik /start di bot Telegram untuk mendapatkan tautan baru.'
    });
  }

  const telegramId = String(consumed.telegramId || userId).trim();
  const usernameClaim = String(consumed.username || '').trim().toLowerCase();
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || process.env.TELEGRAM_VERIFY_ADMIN_CHAT_ID || '').trim();
  const isBudi = usernameClaim === 'budi' || telegramId.toLowerCase() === 'budi' || (adminId && (telegramId === adminId || (Number(telegramId) && Number(telegramId) === Number(adminId))));

  let user = null;
  if (supabase) {
    if (isBudi) {
      const { data: budiUser } = await supabase.from('app_users')
        .select('id, username, email, devices, is_blocked, is_approved')
        .eq('username', 'budi')
        .maybeSingle();
      user = budiUser;
    } else {
      // 1. Check via app_user_telegram_verifications
      try {
        const { data: ver } = await supabase.from('app_user_telegram_verifications')
          .select('user_id')
          .eq('telegram_user_id', Number(telegramId) || telegramId)
          .maybeSingle();
        if (ver && ver.user_id) {
          const { data: linkedUser } = await supabase.from('app_users')
            .select('id, username, email, devices, is_blocked, is_approved')
            .eq('id', ver.user_id)
            .maybeSingle();
          if (linkedUser) user = linkedUser;
        }
      } catch (_) {}

      // 2. Check via bot_users
      if (!user) {
        try {
          const { data: botUser } = await supabase.from('bot_users')
            .select('telegram_id, username, full_name, gmail, status')
            .eq('telegram_id', telegramId)
            .maybeSingle();

          if (botUser) {
            const candidateUname = String(botUser.username || '').toLowerCase();
            const candidateEmail = String(botUser.gmail || '').toLowerCase();
            if (candidateEmail && candidateEmail.includes('@')) {
              const { data: matched } = await supabase.from('app_users')
                .select('id, username, email, devices, is_blocked, is_approved')
                .ilike('email', candidateEmail)
                .maybeSingle();
              if (matched) user = matched;
            }
            if (!user && candidateUname) {
              const { data: matched } = await supabase.from('app_users')
                .select('id, username, email, devices, is_blocked, is_approved')
                .eq('username', candidateUname)
                .maybeSingle();
              if (matched) user = matched;
            }

            // If not found in app_users, provision row for this verified bot user
            if (!user) {
              const newUserId = crypto.randomUUID();
              const newUsername = (candidateUname || ('user_' + telegramId)).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
              const insertPayload = {
                id: newUserId,
                username: newUsername,
                email: candidateEmail || null,
                is_approved: true,
                is_blocked: false,
                devices: [deviceId],
                created_at: new Date().toISOString()
              };
              const { error: insErr } = await supabase.from('app_users').insert(insertPayload);
              if (!insErr) {
                user = insertPayload;
                try {
                  await supabase.from('app_user_telegram_verifications').upsert({
                    user_id: newUserId,
                    telegram_user_id: Number(telegramId) || 0,
                    telegram_verified_at: new Date().toISOString()
                  }, { onConflict: 'user_id' });
                } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }

      // 3. Fallback: match by usernameClaim
      if (!user && usernameClaim) {
        try {
          const { data: claimUser } = await supabase.from('app_users')
            .select('id, username, email, devices, is_blocked, is_approved')
            .eq('username', usernameClaim)
            .maybeSingle();
          if (claimUser) user = claimUser;
        } catch (_) {}
      }
    }
  } else {
    // Test environment without Supabase
    user = {
      id: 'usr_' + (isBudi ? 'budi' : telegramId),
      username: isBudi ? 'budi' : (usernameClaim || 'member'),
      devices: [deviceId],
      is_approved: true,
      is_blocked: false
    };
  }

  if (!user) {
    if (req.method === 'GET') {
      res.statusCode = 302;
      res.setHeader('Location', '/?login=user_not_found');
      return res.end();
    }
    return res.status(404).json({
      success: false,
      error: 'Akun tidak ditemukan. Silakan hubungi admin di Telegram.'
    });
  }

  if (user.is_blocked === true) {
    if (req.method === 'GET') {
      res.statusCode = 302;
      res.setHeader('Location', '/?login=blocked');
      return res.end();
    }
    return res.status(403).json({
      success: false,
      error: 'Akun sedang diblokir.'
    });
  }

  const effectiveUsername = String(user.username || (isBudi ? 'budi' : 'member')).toLowerCase();

  // Multi-device handling for verified magic session:
  // User verified ownership via official Telegram bot DM -> register device automatically
  // without triggering device limit warnings or Telegram re-approval prompts!
  const currentDevices = Array.isArray(user.devices) ? user.devices : [];
  let updatedDevices = currentDevices;
  if (!currentDevices.includes(deviceId)) {
    if (currentDevices.length >= MAX_DEVICES) {
      updatedDevices = [...currentDevices.slice(-(MAX_DEVICES - 1)), deviceId];
    } else {
      updatedDevices = [...currentDevices, deviceId];
    }
    if (supabase && typeof supabase.from === 'function') {
      try {
        await supabase.from('app_users').update({
          devices: updatedDevices,
          user_agent: userAgent,
          last_login_at: new Date().toISOString()
        }).eq('id', user.id);
      } catch (_) {}
    }
  } else {
    if (supabase && typeof supabase.from === 'function') {
      try {
        await supabase.from('app_users').update({
          last_login_at: new Date().toISOString()
        }).eq('id', user.id);
      } catch (_) {}
    }
  }

  const session = issueSessionCookie(res, user, effectiveUsername, deviceId);

  if (req.method === 'GET') {
    res.statusCode = 302;
    res.setHeader('Location', '/?magic_login=1');
    return res.end();
  }

  return res.status(200).json({
    success: true,
    username: effectiveUsername,
    userId: user.id,
    isAdmin: session.isAdmin
  });
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

  if ((req.query && req.query.action === 'device-approval-status') || (req.body && req.body.action === 'device-approval-status')) {
    const token = (req.query && req.query.token) || (req.body && req.body.token);
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let supabase = null;
    if (SUPABASE_URL && SUPABASE_KEY) {
      supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }
    const result = await adminDeviceApproval.checkDeviceApprovalStatus(token, res, { supabase });
    return res.status(result.ok ? 200 : 400).json(result);
  }

  if ((req.query && req.query.action === 'magic-login') || (req.body && req.body.action === 'magic-login')) {
    return await handleMagicLogin(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Same-origin gate for the credential/session-issuing path below (login,
  // logout, and every subscription/voucher action dispatched from here).
  // Mirrors api/reset-password.js's equivalent login/logout handler — without
  // this, a cross-site page can silently POST credentials here and have the
  // resulting Set-Cookie land in the victim's browser (login CSRF).
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent, action } = req.body || {};

    const magicAction = (req.query && req.query.action) || (req.body && req.body.action);
    if (magicAction === 'magic-login') {
      return await handleMagicLogin(req, res);
    }

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
      if (!capability.ready) return res.status(503).json({ success: false, error: 'Status akun tidak tersedia.' });
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

    // === LOGOUT === (clears cookies and cleans up device slot)
    if (action === 'logout') {
      try {
        const auth = requireUserSession(req);
        const targetDeviceId = (req.body && req.body.deviceId) || (auth.ok && auth.session && auth.session.dev);
        const targetUserId = (auth.ok && auth.user && auth.user.id) || null;
        if (targetUserId && targetDeviceId) {
          const db = await subscriptionDb();
          if (db) {
            const { data: userRow } = await db.from('app_users').select('devices').eq('id', targetUserId).maybeSingle();
            if (userRow && Array.isArray(userRow.devices) && userRow.devices.includes(targetDeviceId)) {
              const remaining = userRow.devices.filter(d => d !== targetDeviceId);
              await db.from('app_users').update({ devices: remaining }).eq('id', targetUserId);
            }
          }
        }
      } catch (_) {}
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
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    if (!usernameLower || usernameLower.length < 2) {
      return res.status(400).json({ success: false, error: 'Username tidak valid.' });
    }

    // Google reCAPTCHA v3 Invisible (threshold 0.5, fail-open, review bypass)
    const recaptchaToken = req.body && (req.body.recaptchaToken || req.body.recaptcha_token);
    const recaptchaResult = await verifyRecaptcha({
      token: recaptchaToken,
      remoteIp: clientAddress(req),
      expectedAction: 'login',
      username: usernameLower
    });
    if (!recaptchaResult.ok) {
      return res.status(400).json({
        success: false,
        error: recaptchaResult.error || 'Verifikasi keamanan reCAPTCHA gagal.'
      });
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

    // Durable pre-auth guard. It is disabled by default and becomes enforcing only
    // after the additive Supabase migration and SECURITY_GUARD_MODE=enforce are set.
    const loginGuard = await securityGuard.beginLogin({ req, db: supabase, username: usernameLower });
    if (loginGuard.deny) {
      if (loginGuard.retryAfterSeconds > 0) res.setHeader('Retry-After', String(loginGuard.retryAfterSeconds));
      return res.status(loginGuard.httpStatus || 429).json({
        success: false,
        error: loginGuard.publicError || 'Terlalu banyak percobaan login. Coba lagi nanti.'
      });
    }

    // Find user by username or email
    const isEmailInput = usernameLower.includes("@");
    let userLookup = supabase
      .from("app_users")
      .select("id, username, email, password_hash, device_id, devices, is_blocked, is_approved, created_at");
    if (isEmailInput) {
      userLookup = userLookup.ilike("email", usernameLower);
    } else {
      userLookup = userLookup.eq("username", usernameLower);
    }
    const { data: user, error: findError } = await userLookup.maybeSingle();
    const effectiveUsername = user && user.username ? String(user.username).toLowerCase() : usernameLower;

    if (findError) {
      console.error('login-user find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa akun.' });
    }

    // Verify credentials FIRST with a single generic message so an attacker cannot
    // distinguish "unknown username" from "wrong password" (anti-enumeration).
    // Account-state messages (blocked / not approved) are only revealed AFTER the
    // correct password is provided.
    if (!user) {
      await loginGuard.failure('unknown_account');
      console.error('login-user: authentication failed (unknown account)');
      return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
    }

    const credentialCheck = passwordCredential.verifyStoredCredential(user.password_hash, passwordHash);

    // Every account, including the historical `budi` admin, authenticates through
    // the standard database credential check. The old hardcoded legacy hash path
    // was a backdoor whose accepted value was published in source.
    if (!credentialCheck.ok) {
      await loginGuard.failure('bad_password');
      console.error('login-user: authentication failed (bad password)');
      return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
    }

    // Transparent migration from the historical raw client prehash. The update
    // is compare-and-swap so concurrent successful logins cannot clobber a newer
    // credential. Migration failure does not lock the user out; it can retry on
    // the next successful login.
    if (credentialCheck.needsUpgrade) {
      try {
        const protectedCredential = passwordCredential.protectClientHash(passwordHash);
        const upgraded = await supabase
          .from('app_users')
          .update({ password_hash: protectedCredential })
          .eq('id', user.id)
          .eq('password_hash', user.password_hash);
        if (upgraded.error) console.error('login-user credential migration failed');
      } catch (_) {
        console.error('login-user credential migration failed');
      }
    }

    // Database credentials are valid from here on. Clear account/pair failure
    // state before existing account-state and device rules are evaluated.
    await loginGuard.credentialAccepted('credentials_valid');

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
      // Fire-and-forget: the login response must not wait on this timestamp write.
      void (async () => {
        try {
          const { error: updateError } = await supabase
            .from('app_users')
            .update({ last_login_at: new Date().toISOString() })
            .eq('id', user.id);
          if (updateError) {
            console.error('login-user review update error:', updateError);
          }
        } catch (err) {
          console.error('Silent login timestamp update error:', err);
        }
      })();

      issueSessionCookie(res, user, effectiveUsername, deviceId);
      return res.status(200).json({
        success: true,
        username: 'review',
        userId: user.id,
        isAdmin: false,
        isReview: true
      });
    }

    // === VERCEL PREVIEW URL BYPASS ===
    // Logins from *.vercel.app preview URLs do not count towards device slots
    if (isVercelPreviewRequest(req)) {
      const previewSession = issueSessionCookie(res, user, effectiveUsername, deviceId);
      return res.status(200).json({
        success: true,
        username: effectiveUsername,
        userId: user.id,
        isAdmin: previewSession.isAdmin,
        preview_mode: true
      });
    }

    // === MULTI-DEVICE BINDING (max 3 devices) ===
    const currentDevices = Array.isArray(user.devices) ? user.devices : [];

    // Check if this device is already registered for this user
    if (currentDevices.includes(deviceId)) {
      // Device already known — just update last_login_at. Fire-and-forget: the
      // login response must not be blocked by this non-critical timestamp write.
      void (async () => {
        try {
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
        } catch (err) {
          console.error('Silent login timestamp update error:', err);
        }
      })();

      const knownDeviceSession = issueSessionCookie(res, user, effectiveUsername, deviceId);
      return res.status(200).json({
        success: true,
        username: effectiveUsername,
        userId: user.id,
        isAdmin: knownDeviceSession.isAdmin
      });
    }

    // Device is new — check if there's room
    if (currentDevices.length >= MAX_DEVICES) {
      if (effectiveUsername === 'budi') {
        const bot = createVerifyBot();
        const approval = await adminDeviceApproval.createDeviceApprovalRequest(
          { supabase, bot },
          { userId: user.id, username: 'budi', deviceId, userAgent }
        );
        return res.status(400).json({
          success: false,
          code: 'DEVICE_APPROVAL_PENDING',
          approval_token: approval.token,
          expires_in_seconds: approval.expiresInSeconds,
          error: 'Batas perangkat tercapai (3/3). Konfirmasi verifikasi telah dikirim ke Telegram admin. Buka Telegram dan tap "Izinkan" untuk masuk otomatis.'
        });
      }
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

    const newDeviceSession = issueSessionCookie(res, user, effectiveUsername, deviceId);
    return res.status(200).json({
      success: true,
      username: effectiveUsername,
      userId: user.id,
      isAdmin: newDeviceSession.isAdmin
    });
  } catch (e) {
    console.error('login-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error. Silakan coba lagi.' });
  }
};

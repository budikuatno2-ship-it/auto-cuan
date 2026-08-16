const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  generateApprovalCode,
  maskUsername
} = require('../lib/free-user-approval');
const telegramVerification = require('../lib/telegram-verification');
const { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');
const accountTerms = require('../lib/account-terms');

// Registration is far more expensive than a read: it writes an app_users row
// and mints a one-time Telegram verification challenge. It had no limit at all,
// so a script could create pending accounts and walk the username namespace as
// fast as the database would accept writes.
//
// Keyed on the address the platform edge observed, never on anything in the
// body — a body-keyed bucket is minted fresh on every request and bounds
// nothing. Per-instance, with the same honest caveat as api/log.js: this blunts
// floods, it is not a hard global guarantee (see lib/request-rate-limit.js).
const registrationLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 8 });

// Bounds on values that are stored. passwordHash arrives from the client and
// went straight into the database with no length or format check, so a caller
// could push an arbitrarily large string into the row. The client always sends
// a hex SHA-256 digest.
const PASSWORD_HASH_RE = /^[a-f0-9]{64}$/i;
const MAX_USER_AGENT = 256;

// Normalize a client-provided device ID and generate a secure server-side
// fallback when an older client omits it. Keeps the NOT NULL `device_id`
// column satisfied without exposing device ID as a required user input.
function normalizeDeviceId(rawDeviceId) {
  var id = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';
  // Strip control characters and cap length so the value is storage-safe.
  id = id.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 128);
  if (!id) {
    id = 'srv_' + crypto.randomUUID();
  }
  return id;
}

async function rollbackIncompleteRegistration(supabase, userId) {
  if (!userId) return;
  try {
    // Verification challenge rows cascade with app_users. If this cleanup ever
    // fails, never expose database detail to the browser; the registration still
    // returns a generic failure and the inconsistency is visible to operators.
    await supabase.from('app_users').delete().eq('id', userId);
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!registrationLimiter.check(clientAddress(req))) {
    // Deliberately identical to no other branch: it says nothing about whether
    // any username exists.
    return res.status(429).json({ success: false, error: 'Terlalu banyak percobaan pendaftaran. Coba lagi dalam beberapa menit.' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent } = req.body || {};

    // Validate required inputs. Device ID is auto-managed by the client and
    // backfilled server-side, so it is NOT a required user input.
    if (!username || !passwordHash) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    // The agreement is a server contract, not a cosmetic checkbox. An older or
    // modified client cannot create an account unless it explicitly accepts the
    // exact current terms version published by this deployment.
    const termsAcceptance = accountTerms.registrationAcceptance(req.body);
    if (!termsAcceptance.ok) {
      return res.status(400).json({
        success: false,
        code: 'TERMS_ACCEPTANCE_REQUIRED',
        error: 'Baca dan setujui Peraturan & Ketentuan sebelum mendaftar.',
        terms: accountTerms.publicTermsMetadata()
      });
    }

    // Ensure we always have a non-null device ID for the NOT NULL column.
    const normalizedDeviceId = normalizeDeviceId(deviceId);

    const usernameLower = String(username).trim().toLowerCase();

    // Reject empty or too long
    if (!usernameLower || usernameLower.length < 2) {
      return res.status(400).json({ success: false, error: 'Username minimal 2 karakter.' });
    }
    if (usernameLower.length > 30) {
      return res.status(400).json({ success: false, error: 'Username maksimal 30 karakter.' });
    }

    if (typeof passwordHash !== 'string' || !PASSWORD_HASH_RE.test(passwordHash)) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    // Reject reserved usernames
    if (usernameLower === 'budi' || usernameLower === 'review') {
      return res.status(400).json({ success: false, error: 'Username tidak tersedia.' });
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

    // Check if username already exists
    const { data: existingUser, error: findError } = await supabase
      .from('app_users')
      .select('id, username')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError) {
      console.error('register-user find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa username.' });
    }

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Username sudah digunakan.' });
    }

    // v2: Atomically create the pending user AND its first one-time verification
    // challenge. The raw code is generated in Node; ONLY its HMAC is passed to
    // SQL. Fail closed if the code secret is not configured — no user is created.
    if (!telegramVerification.hasCodeSecret()) {
      return res.status(500).json({ success: false, error: 'Verifikasi belum dikonfigurasi. Coba lagi nanti.' });
    }

    let registration;
    try {
      registration = await telegramVerification.registerPendingUser(supabase, {
        username: usernameLower,
        passwordHash: passwordHash,
        deviceId: normalizedDeviceId,
        userAgent: String(userAgent || '').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, MAX_USER_AGENT)
      });
    } catch (rpcError) {
      // Never surface raw database constraint text. A username/device duplicate
      // arrives as SQLSTATE 23505 (active-hash collisions are retried internally).
      if (rpcError && rpcError.pgcode === '23505') {
        return res.status(400).json({ success: false, error: 'Username sudah digunakan.' });
      }
      console.error('register-user rpc failed');
      return res.status(500).json({ success: false, error: 'Gagal membuat akun. Silakan coba lagi beberapa saat lagi.' });
    }

    if (!registration || !registration.id) {
      console.error('register-user rpc returned no public approval source');
      return res.status(500).json({ success: false, error: 'Akun dibuat, tetapi kode verifikasi belum tersedia. Hubungi admin.' });
    }

    // Persist the acceptance only after the account/challenge transaction has
    // committed. This table is service-role-only. If the audit row cannot be
    // stored (for example the migration was not applied), fail closed and remove
    // the just-created account so there is no un-audited registration.
    const accepted = await supabase.from('account_terms_acceptances').insert({
      user_id: registration.id,
      terms_version: accountTerms.CURRENT_TERMS_VERSION,
      acceptance_source: 'registration'
    });
    if (accepted.error) {
      console.error('register-user terms audit failed');
      await rollbackIncompleteRegistration(supabase, registration.id);
      return res.status(503).json({ success: false, error: 'Pendaftaran belum tersedia. Coba lagi beberapa saat.' });
    }

    // The raw one-time code is returned to the client ONLY after the RPC committed.
    // The private channel invite link is NEVER exposed by the website.
    return res.status(200).json({
      success: true,
      pending: true,
      approval_status: 'pending',
      masked_username: maskUsername(registration.username),
      approval_code: generateApprovalCode({ id: registration.id, username: registration.username, created_at: registration.createdAt }),
      telegram_verification_code: registration.displayCode,
      telegram_verification_expires_at: registration.expiresAt,
      telegram_bot_url: telegramVerification.BOT_URL,
      terms_version: accountTerms.CURRENT_TERMS_VERSION
    });
  } catch (e) {
    console.error('register-user exception:', e);
    return res.status(500).json({ success: false, error: 'Gagal membuat akun. Silakan coba lagi beberapa saat lagi.' });
  }
};

// Exposed for focused unit tests only.
module.exports.__test = {
  normalizeDeviceId: normalizeDeviceId,
  rollbackIncompleteRegistration: rollbackIncompleteRegistration,
  registrationLimiter: registrationLimiter,
  PASSWORD_HASH_RE: PASSWORD_HASH_RE
};

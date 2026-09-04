const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const subscriptionManualHandler = require('../lib/subscription-manual-handler');
const subscriptionVoucherHandler = require('../lib/subscription-voucher-handler');
const { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');
const passwordCredential = require('../lib/password-credential');

// This endpoint's only gate is a static, source-visible token, so it needs a
// timing-safe comparison and a floor on how often it can be probed — same
// reasoning as the login/registration limiters (see lib/request-rate-limit.js).
const reviewAccessLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 8 });

/**
 * POST /api/review-access
 * Validates review token, seeds review user if needed, checks blocked status.
 *
 * Vercel Hobby is capped at 12 bundled Serverless Functions. Subscription
 * checkout/voucher routes are rewritten here and delegated immediately to
 * isolated handlers that enforce their own same-origin and signed-session gates.
 */
module.exports = async function handler(req, res) {
  const surface = String(req.query && req.query.surface || '').trim();
  if (surface === 'subscription-manual') return subscriptionManualHandler(req, res);
  if (surface === 'subscription-voucher') return subscriptionVoucherHandler(req, res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!reviewAccessLimiter.check(clientAddress(req))) {
    return res.status(403).json({ success: false, error: 'Token review tidak valid.' });
  }

  try {
    const { token } = req.body || {};

    // Fail closed. This used to fall back to a literal default token, which was
    // also written twice into public/index.html — so the gate's secret was
    // readable by anyone who opened the page or the (public) repository. There is
    // no safe default for a credential: an unset variable now closes the door
    // rather than opening it with a value everyone knows.
    const EXPECTED_TOKEN = String(process.env.REVIEW_ACCESS_TOKEN || '');
    if (!EXPECTED_TOKEN) {
      return res.status(403).json({ success: false, error: 'Token review tidak valid.' });
    }

    // Timing-safe comparison — a plain !== leaks early-mismatch timing, and every
    // other secret compare in this codebase (login-user.js, sector-hot.js cron
    // secret) already uses timingSafeEqual.
    const tokenBuf = Buffer.from(String(token || ''));
    const expectedBuf = Buffer.from(EXPECTED_TOKEN);
    const tokenValid = tokenBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(tokenBuf, expectedBuf);
    if (!tokenValid) {
      return res.status(403).json({ success: false, error: 'Token review tidak valid.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // The reviewer credential comes from the environment, never from source.
    //
    // The previous constant here was described as safe because the plaintext was
    // not recorded. It was not safe: the browser hashes passwords client-side
    // (public/index.html hashPassword), /api/login-user accepts that hash as the
    // submitted credential, and lib/password-credential.js compares a
    // legacy-format stored hash against it directly. For a legacy row the hash IS
    // the credential, so publishing it in a public repository published the
    // reviewer login. Fail closed when it is not configured.
    const REVIEW_PASSWORD_HASH = String(process.env.REVIEW_PASSWORD_HASH || '').trim().toLowerCase();
    const REVIEW_DEVICE_ID = 'REVIEW_ANY_DEVICE';
    const REVIEW_USERNAME = 'review';

    // Check if review user exists
    const { data: existingUser, error: findError } = await supabase
      .from('app_users')
      .select('id, username, is_blocked, device_id, password_hash')
      .eq('username', REVIEW_USERNAME)
      .maybeSingle();

    if (findError) {
      console.error('review-access find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa user review.' });
    }

    if (existingUser) {
      // User exists - check if blocked
      if (existingUser.is_blocked) {
        return res.status(403).json({ success: false, error: 'Akun review sedang diblokir.' });
      }

      // Ensure device_id is correct (don't change password or is_blocked)
      if (existingUser.device_id !== REVIEW_DEVICE_ID) {
        await supabase
          .from('app_users')
          .update({ device_id: REVIEW_DEVICE_ID })
          .eq('id', existingUser.id);
      }

      return res.status(200).json({ success: true, username: REVIEW_USERNAME, isReview: true });
    }

    // User does not exist - create it. Seeding requires the configured credential.
    if (!passwordCredential.normalizeClientHash(REVIEW_PASSWORD_HASH)) {
      console.error('review-access: REVIEW_PASSWORD_HASH is not configured');
      return res.status(503).json({ success: false, error: 'Akses review belum dikonfigurasi.' });
    }

    // Stored in the protected scrypt form, exactly as api/register-user.js does,
    // so the row is never a directly replayable legacy hash.
    const { error: insertError } = await supabase
      .from('app_users')
      .insert({
        username: REVIEW_USERNAME,
        password_hash: passwordCredential.protectClientHash(REVIEW_PASSWORD_HASH),
        device_id: REVIEW_DEVICE_ID,
        user_agent: 'review_seed',
        is_blocked: false
      });

    if (insertError) {
      console.error('review-access insert error:', insertError);
      return res.status(500).json({ success: false, error: 'Gagal membuat user review.' });
    }

    return res.status(200).json({ success: true, username: REVIEW_USERNAME, isReview: true });

  } catch (e) {
    console.error('review-access exception:', e);
    return res.status(500).json({ success: false, error: 'Server error. Silakan coba lagi.' });
  }
};

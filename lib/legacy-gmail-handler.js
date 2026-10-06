'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');
const googleOAuthService = require('./google-oauth-service');

function dbClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function createHandler(factory = dbClient) {
  return async function (req, res) {
    res.setHeader('Cache-Control', 'private, no-store');

    const queryAction = String((req.query && req.query.action) || '').trim();
    const bodyAction = String((req.body && req.body.action) || '').trim();
    const action = bodyAction || queryAction;

    // Allow GET only for OAuth callback redirect from Google
    if (req.method === 'GET') {
      if (action !== 'account-google-link-callback') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }
    } else if (req.method !== 'POST') {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    if (req.method === 'POST' && action !== 'account-google-link-callback' && !isSameOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
    }

    try {
      const db = factory();
      if (!db) {
        if (req.method === 'GET') {
          res.writeHead(302, { Location: '/?google_link_error=database_unavailable' });
          res.end();
          return;
        }
        return res.status(503).json({ success: false, error: 'Data akun belum tersedia. Coba lagi.' });
      }

      // ======================================================================
      // ACTION: account-google-link-callback
      // Cross-site GET callback from accounts.google.com does NOT have ac_sess
      // because ac_sess is intentionally SameSite=Strict.
      // Identity authority comes authoritatively from the single-use database state.
      // ======================================================================
      if (action === 'account-google-link-callback') {
        const state = (req.body && req.body.state) || (req.query && req.query.state);
        const code = (req.body && req.body.code) || (req.query && req.query.code);
        const providerError = (req.query && req.query.error) || (req.body && req.body.error);
        const testPayload = req.body && req.body.test_payload;

        if (providerError) {
          if (req.method === 'GET') {
            const errKey = providerError === 'access_denied' ? 'access_denied' : 'provider_error';
            res.writeHead(302, { Location: '/?google_link_error=' + errKey });
            res.end();
            return;
          }
          return res.status(400).json({ success: false, code: 'ACCESS_DENIED', error: 'Otorisasi Google dibatalkan atau gagal.' });
        }

        if (!state) {
          if (req.method === 'GET') {
            res.writeHead(302, { Location: '/?google_link_error=invalid_state' });
            res.end();
            return;
          }
          return res.status(400).json({ success: false, error: 'State OAuth tidak valid.' });
        }

        // Authoritatively consume short-lived server-side state from DB using state as authority
        const stateConsume = await googleOAuthService.consumeOAuthState(db, {
          stateToken: state
        });

        if (!stateConsume.ok) {
          if (req.method === 'GET') {
            const errKey = stateConsume.code === 'STATE_EXPIRED' ? 'state_expired' : (stateConsume.code === 'STATE_ALREADY_CONSUMED' ? 'state_consumed' : 'invalid_state');
            res.writeHead(302, { Location: '/?google_link_error=' + errKey });
            res.end();
            return;
          }
          return res.status(400).json({
            success: false,
            code: stateConsume.code || 'OAUTH_STATE_INVALID',
            error: 'Sesi OAuth kedaluwarsa atau tidak valid.'
          });
        }

        // State is validly consumed. Obtain user from authoritative state record
        const targetUserRes = await db.from('app_users')
          .select('id, username, is_blocked')
          .eq('id', stateConsume.userId)
          .maybeSingle();

        if (!targetUserRes.data || targetUserRes.data.is_blocked) {
          if (req.method === 'GET') {
            res.writeHead(302, { Location: '/?google_link_error=user_not_eligible' });
            res.end();
            return;
          }
          return res.status(403).json({ success: false, code: 'USER_NOT_ELIGIBLE', error: 'Akun tidak memenuhi syarat.' });
        }

        let verifiedSub = null;
        let verifiedEmail = null;

        if (testPayload) {
          if (!googleOAuthService.isTestFixtureAllowed()) {
            return res.status(403).json({
              success: false,
              code: 'TEST_FIXTURE_FORBIDDEN',
              error: 'Test fixture payload tidak diizinkan di lingkungan ini.'
            });
          }
          const tokenValidation = googleOAuthService.validateIdTokenPayload(testPayload, {
            expectedNonce: stateConsume.nonce
          });
          if (!tokenValidation.ok) {
            return res.status(400).json({ success: false, error: 'Verifikasi identitas Google gagal.' });
          }
          verifiedSub = tokenValidation.sub;
          verifiedEmail = tokenValidation.email;
        } else {
          if (!code) {
            if (req.method === 'GET') {
              res.writeHead(302, { Location: '/?google_link_error=code_missing' });
              res.end();
              return;
            }
            return res.status(400).json({ success: false, error: 'Kode otorisasi Google tidak ditemukan.' });
          }

          const cfg = googleOAuthService.getGoogleOAuthConfig();
          if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
            if (!googleOAuthService.isTestFixtureAllowed()) {
              if (req.method === 'GET') {
                res.writeHead(302, { Location: '/?google_link_error=config_error' });
                res.end();
                return;
              }
              return res.status(503).json({
                success: false,
                code: 'GOOGLE_OAUTH_CONFIGURATION_ERROR',
                error: 'Layanan Google OAuth belum dikonfigurasi.'
              });
            }
          }

          let tokenResponse;
          try {
            tokenResponse = await googleOAuthService.exchangeCodeForTokens({
              code,
              codeVerifier: stateConsume.codeVerifier,
              clientId: cfg.clientId,
              clientSecret: cfg.clientSecret,
              redirectUri: cfg.redirectUri
            });
          } catch (err) {
            if (req.method === 'GET') {
              res.writeHead(302, { Location: '/?google_link_error=token_failed' });
              res.end();
              return;
            }
            return res.status(502).json({
              success: false,
              code: 'GOOGLE_TOKEN_EXCHANGE_ERROR',
              error: 'Gagal menukarkan kode otorisasi dengan token Google.'
            });
          }

          if (!tokenResponse || !tokenResponse.id_token) {
            if (req.method === 'GET') {
              res.writeHead(302, { Location: '/?google_link_error=token_failed' });
              res.end();
              return;
            }
            return res.status(502).json({ success: false, error: 'Google tidak mengembalikan id_token.' });
          }

          const verification = await googleOAuthService.verifyGoogleIdToken(tokenResponse.id_token, {
            expectedAudience: cfg.clientId,
            expectedNonce: stateConsume.nonce
          });

          if (!verification.ok) {
            if (req.method === 'GET') {
              res.writeHead(302, { Location: '/?google_link_error=verification_failed' });
              res.end();
              return;
            }
            return res.status(400).json({
              success: false,
              code: 'ID_TOKEN_VERIFICATION_FAILED',
              error: 'Verifikasi kriptografis token identitas Google gagal.'
            });
          }

          verifiedSub = verification.sub;
          verifiedEmail = verification.email;
        }

        const linkResult = await googleOAuthService.linkGoogleIdentity(db, {
          userId: stateConsume.userId,
          googleSub: verifiedSub,
          googleEmail: verifiedEmail,
          emailVerified: true,
          idempotencyKey: crypto.randomUUID()
        });

        if (!linkResult.ok) {
          if (req.method === 'GET') {
            const errCode = (linkResult.code === 'GOOGLE_IDENTITY_CONFLICT') ? 'link_conflict' : ((linkResult.code === 'USER_GOOGLE_LINK_MISMATCH') ? 'account_mismatch' : 'link_failed');
            res.writeHead(302, { Location: '/?google_link_error=' + errCode });
            res.end();
            return;
          }
          if (linkResult.code === 'GOOGLE_IDENTITY_CONFLICT') {
            return res.status(409).json({ success: false, code: 'GOOGLE_IDENTITY_CONFLICT', error: 'Akun Google ini sudah terhubung ke akun Auto-Cuan lain.' });
          }
          if (linkResult.code === 'USER_GOOGLE_LINK_MISMATCH') {
            return res.status(409).json({ success: false, code: 'USER_GOOGLE_LINK_MISMATCH', error: 'Akun Auto-Cuan sudah terikat dengan identitas Google lain.' });
          }
          return res.status(400).json({ success: false, error: linkResult.error || 'Gagal menghubungkan akun Google.' });
        }

        if (req.method === 'GET') {
          // Clean 302 redirect back to same-origin. SameSite=Strict ac_sess is present on this navigation.
          res.writeHead(302, { Location: '/?google_linked=1' });
          res.end();
          return;
        }

        return res.status(200).json({
          success: true,
          linked: true,
          masked_email: googleOAuthService.maskEmail(verifiedEmail),
          bonus_granted: linkResult.data.bonus_granted === true,
          starts_at: linkResult.data.starts_at || null,
          expires_at: linkResult.data.expires_at || null,
          duration_days: linkResult.data.duration_days || null,
          already_claimed: linkResult.data.already_claimed === true,
          pre_rollout_eligible: linkResult.data.pre_rollout_eligible === true
        });
      }

      // ======================================================================
      // Authenticated actions (Same-origin requests with ac_sess cookie)
      // ======================================================================
      const auth = requireAuthenticatedSession(req);
      if (!auth.ok) {
        return res.status(401).json({ success: false, error: 'Silakan login kembali.' });
      }

      const result = await db.from('app_users')
        .select('id, username, email, is_blocked, created_at')
        .eq('id', auth.session.uid)
        .maybeSingle();

      const user = result.data;
      if (result.error || !user || String(user.username).toLowerCase() !== String(auth.session.un).toLowerCase()) {
        return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
      }
      if (user.is_blocked) return res.status(403).json({ success: false, error: 'Akun diblokir.' });

      // ======================================================================
      // ACTION: account-google-link-url
      // ======================================================================
      if (action === 'account-google-link-url') {
        if (!googleOAuthService.hasGoogleOAuthConfig() && !googleOAuthService.isTestFixtureAllowed()) {
          return res.status(503).json({
            success: false,
            code: 'GOOGLE_OAUTH_CONFIGURATION_ERROR',
            error: 'Layanan Google OAuth belum dikonfigurasi.'
          });
        }
        try {
          const cfg = googleOAuthService.getGoogleOAuthConfig();
          const stateData = googleOAuthService.createOauthState(auth.session.uid);
          await googleOAuthService.saveOAuthState(db, {
            userId: auth.session.uid,
            stateToken: stateData.stateToken,
            nonce: stateData.nonce,
            codeVerifier: stateData.codeVerifier,
            redirectUri: cfg.redirectUri,
            expiresAt: stateData.expiresAt
          });
          const authData = googleOAuthService.buildAuthorizationUrl({
            state: stateData.stateToken,
            nonce: stateData.nonce,
            codeVerifier: stateData.codeVerifier
          });
          return res.status(200).json({ success: true, auth_url: authData.url, state: stateData.stateToken });
        } catch (err) {
          if (err && err.code === 'GOOGLE_OAUTH_CONFIGURATION_ERROR') {
            return res.status(503).json({
              success: false,
              code: 'GOOGLE_OAUTH_CONFIGURATION_ERROR',
              error: 'Layanan Google OAuth belum dikonfigurasi.'
            });
          }
          if (err && err.code === 'OAUTH_STATE_SAVE_FAILED') {
            return res.status(500).json({
              success: false,
              code: 'OAUTH_STATE_SAVE_FAILED',
              error: 'Gagal membuat sesi otorisasi Google.'
            });
          }
          throw err;
        }
      }

      // ======================================================================
      // ACTION: account-google-status
      // ======================================================================
      if (action === 'account-google-status') {
        const linkRes = await db.from('app_user_google_links')
          .select('*')
          .eq('user_id', auth.session.uid)
          .maybeSingle();

        const linkRow = linkRes && linkRes.data;
        const googleLinked = Boolean(linkRow && linkRow.unlinked_at == null);
        const googleEmailMasked = (linkRow && linkRow.google_email) ? googleOAuthService.maskEmail(linkRow.google_email) : null;
        const googleBonusGranted = Boolean(linkRow && linkRow.bonus_granted_at != null);

        // Fail closed: default to false if rollout configuration is missing or unreadable
        let isPreRollout = false;
        try {
          const rolloutRes = await db.from('system_feature_rollouts')
            .select('cutoff_at')
            .eq('feature_key', 'google_link_bonus')
            .maybeSingle();
          if (rolloutRes && rolloutRes.data && rolloutRes.data.cutoff_at && user.created_at) {
            isPreRollout = new Date(user.created_at).getTime() < new Date(rolloutRes.data.cutoff_at).getTime();
          }
        } catch (_) {}

        const googleBonusEligible = isPreRollout && !googleBonusGranted;
        const isExempt = ['budi', 'review'].includes(String(user.username).toLowerCase());
        const googleLinkRequired = !googleLinked && !isExempt;

        return res.status(200).json({
          success: true,
          google_linked: googleLinked,
          google_email_masked: googleEmailMasked,
          google_bonus_eligible: googleBonusEligible,
          google_bonus_granted: googleBonusGranted,
          google_link_required: googleLinkRequired,
          required: googleLinkRequired
        });
      }

      // ======================================================================
      // ACTION: account-email-status (Dormant legacy email status)
      // ======================================================================
      if (action === 'account-email-status') {
        const hasEmail = Boolean(String(user.email || '').trim());
        return res.status(200).json({
          success: true,
          required: false,
          email: user.email || null,
          masked_email: hasEmail ? googleOAuthService.maskEmail(user.email) : null
        });
      }

      // ======================================================================
      // ACTION: account-email-complete (Dormant legacy manual email completion)
      // ======================================================================
      if (action === 'account-email-complete') {
        if (String(user.email || '').trim()) {
          return res.status(200).json({ success: true, required: false, email: user.email });
        }
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (email.length > 254 || !/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@gmail\.com$/.test(email)) {
          return res.status(400).json({ success: false, error: 'Masukkan alamat Gmail yang valid (@gmail.com).' });
        }

        let update = db.from('app_users').update({ email }).eq('id', auth.session.uid);
        update = user.email == null ? update.is('email', null) : update.eq('email', user.email);
        const updated = await update.select('email').maybeSingle();
        if (updated.error) {
          return res.status(updated.error.code === '23505' ? 409 : 503).json({
            success: false,
            error: updated.error.code === '23505' ? 'Gmail tidak dapat digunakan. Gunakan Gmail lain.' : 'Gmail belum tersimpan. Coba lagi.'
          });
        }
        if (!updated.data) return res.status(409).json({ success: false, error: 'Data akun berubah. Muat ulang halaman.' });
        return res.status(200).json({ success: true, required: false, email });
      }

      return res.status(400).json({ success: false, error: 'Aksi tidak valid.' });
    } catch (err) {
      console.error('legacy-gmail-handler exception:', err);
      return res.status(500).json({ success: false, error: 'Terjadi kesalahan sistem. Coba lagi.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

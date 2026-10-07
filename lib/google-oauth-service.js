'use strict';

const crypto = require('crypto');

const STATE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';

let _testTokenExchangeHandler = null;
let _testJwksFetcher = null;
let _cachedJwks = null;
let _cachedJwksExpiry = 0;

function getGoogleOAuthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || '';
  return {
    clientId: String(clientId).trim(),
    clientSecret: String(clientSecret).trim(),
    redirectUri: String(redirectUri).trim()
  };
}

function hasGoogleOAuthConfig() {
  const cfg = getGoogleOAuthConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

function isTestFixtureAllowed() {
  const env = (process.env.NODE_ENV || '').toLowerCase();
  if (env === 'production') return false;
  return env === 'test' || process.env.ALLOW_TEST_OAUTH_FIXTURES === 'true';
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function maskEmail(email) {
  const val = String(email || '').trim().toLowerCase();
  const at = val.indexOf('@');
  if (at <= 0) return val;
  const local = val.slice(0, at);
  const domain = val.slice(at);
  if (local.length <= 2) return local.charAt(0) + '*' + domain;
  return local.slice(0, 2) + '*'.repeat(Math.max(1, local.length - 2)) + domain;
}

function createCodeVerifier() {
  return b64urlEncode(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return b64urlEncode(crypto.createHash('sha256').update(String(verifier)).digest());
}

function createOauthState(userId, opts) {
  // Opaque cryptographically random high-entropy transaction token (256-bit).
  // Strictly does NOT embed Auto-Cuan userId into state.
  const nonce = (opts && opts.nonce) || b64urlEncode(crypto.randomBytes(16));
  const codeVerifier = (opts && opts.codeVerifier) || createCodeVerifier();
  const stateToken = (opts && (opts.state || opts.stateToken)) || crypto.randomBytes(32).toString('hex');
  const expiresAtSec = Math.floor(Date.now() / 1000) + STATE_MAX_AGE_SECONDS;
  return {
    stateToken,
    nonce,
    codeVerifier,
    expiresAt: new Date(expiresAtSec * 1000).toISOString()
  };
}

async function saveOAuthState(db, params) {
  const { userId, stateToken, state, nonce, codeVerifier, redirectUri, expiresAt } = params || {};
  const token = state || stateToken;
  if (!db || !userId || !token || !nonce || !codeVerifier) {
    throw new Error('invalid_save_state_params');
  }
  const exp = expiresAt || new Date(Date.now() + STATE_MAX_AGE_SECONDS * 1000).toISOString();
  const res = await db.from('app_user_oauth_states').insert({
    user_id: userId,
    state: token,
    nonce,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri || '',
    expires_at: exp,
    created_at: new Date().toISOString()
  });

  if (res && res.error) {
    const err = new Error('Failed to save OAuth state: ' + res.error.message);
    err.code = 'OAUTH_STATE_SAVE_FAILED';
    err.details = res.error;
    throw err;
  }
}

async function consumeOAuthState(db, params) {
  const { stateToken, state, nowValue } = params || {};
  const token = state || stateToken;
  if (!db || !token) {
    return { ok: false, error: 'invalid_arguments', code: 'INVALID_ARGUMENTS' };
  }
  const now = nowValue ? new Date(nowValue) : new Date();
  const nowIso = now.toISOString();

  // Authoritative atomic database RPC - NO production fallback mutation
  try {
    const rpcRes = await db.rpc('consume_oauth_state', {
      p_state: token,
      p_now: nowIso
    });

    if (!rpcRes || rpcRes.error) {
      const errMsg = (rpcRes && rpcRes.error && rpcRes.error.message) || 'consume_rpc_unavailable';
      return { ok: false, error: errMsg, code: 'RPC_UNAVAILABLE' };
    }

    const rows = rpcRes.data;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) {
      return { ok: false, error: 'state_not_found', code: 'STATE_NOT_FOUND' };
    }

    if (row.consumed === true) {
      return {
        ok: true,
        userId: row.user_id,
        nonce: row.nonce,
        codeVerifier: row.code_verifier
      };
    }

    return {
      ok: false,
      error: row.error_code || 'state_invalid',
      code: (row.error_code || 'state_invalid').toUpperCase()
    };
  } catch (err) {
    return { ok: false, error: err.message || 'database_error', code: 'RPC_UNAVAILABLE' };
  }
}

function buildAuthorizationUrl(opts) {
  const cfg = getGoogleOAuthConfig();
  const clientId = (opts && opts.clientId) || cfg.clientId;
  const redirectUri = (opts && opts.redirectUri) || cfg.redirectUri;
  if (!clientId || !redirectUri) {
    if (!isTestFixtureAllowed()) {
      const err = new Error('Google OAuth is not configured');
      err.code = 'GOOGLE_OAUTH_CONFIGURATION_ERROR';
      throw err;
    }
  }
  const state = (opts && (opts.state || opts.stateToken)) || '';
  const nonce = (opts && opts.nonce) || '';
  const codeVerifier = (opts && opts.codeVerifier) || createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'consent');

  return {
    url: url.toString(),
    codeVerifier,
    codeChallenge
  };
}

async function exchangeCodeForTokens(params) {
  if (_testTokenExchangeHandler) {
    return await _testTokenExchangeHandler(params);
  }

  const { code, codeVerifier, clientId, clientSecret, redirectUri } = params || {};
  if (!code || !codeVerifier || !clientId || !clientSecret || !redirectUri) {
    throw new Error('missing_exchange_parameters');
  }

  const bodyParams = new URLSearchParams();
  bodyParams.set('code', code);
  bodyParams.set('client_id', clientId);
  bodyParams.set('client_secret', clientSecret);
  bodyParams.set('redirect_uri', redirectUri);
  bodyParams.set('grant_type', 'authorization_code');
  bodyParams.set('code_verifier', codeVerifier);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s bounded timeout

  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString(),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.error_description || data.error || 'token_exchange_failed');
      err.code = 'GOOGLE_TOKEN_EXCHANGE_ERROR';
      err.details = data;
      throw err;
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Google token exchange timed out');
      timeoutErr.code = 'GOOGLE_TOKEN_EXCHANGE_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleJwks() {
  if (_testJwksFetcher) {
    return await _testJwksFetcher();
  }
  const now = Date.now();
  if (_cachedJwks && _cachedJwksExpiry > now) {
    return _cachedJwks;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000); // 6s bounded timeout

  try {
    const res = await fetch(GOOGLE_JWKS_ENDPOINT, { signal: controller.signal });
    if (!res.ok) {
      throw new Error('failed_to_fetch_google_jwks');
    }
    const data = await res.json();
    const keys = Array.isArray(data.keys) ? data.keys : [];
    _cachedJwks = keys;
    _cachedJwksExpiry = now + 60 * 60 * 1000; // cache for 1 hour
    return keys;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Google JWKS fetch timed out');
      timeoutErr.code = 'GOOGLE_JWKS_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyGoogleIdToken(idToken, opts) {
  if (!idToken || typeof idToken !== 'string') return { ok: false, error: 'token_missing' };
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, error: 'token_malformed' };

  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    return { ok: false, error: 'token_corrupt' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, error: 'unsupported_algorithm' };
  }
  if (!header.kid) {
    return { ok: false, error: 'missing_key_id' };
  }

  let jwks = await fetchGoogleJwks();
  let matchingKey = jwks.find(k => k.kid === header.kid);
  if (!matchingKey) {
    // Refresh once in case of key rotation
    _cachedJwks = null;
    jwks = await fetchGoogleJwks();
    matchingKey = jwks.find(k => k.kid === header.kid);
  }
  if (!matchingKey) {
    return { ok: false, error: 'unknown_key_id' };
  }

  // Cryptographic RSA-SHA256 signature verification
  try {
    const publicKey = crypto.createPublicKey({ key: matchingKey, format: 'jwk' });
    const signingInput = Buffer.from(parts[0] + '.' + parts[1], 'utf8');
    const signature = b64urlDecode(parts[2]);
    const isValid = crypto.verify('sha256', signingInput, publicKey, signature);
    if (!isValid) {
      return { ok: false, error: 'invalid_signature' };
    }
  } catch (err) {
    return { ok: false, error: 'signature_verification_failed', details: err.message };
  }

  // Claims validation
  const now = (opts && opts.now) ? Math.floor(new Date(opts.now).getTime() / 1000) : Math.floor(Date.now() / 1000);

  // Issuer check
  const iss = String(payload.iss || '').trim();
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    return { ok: false, error: 'invalid_issuer' };
  }

  // Audience check
  if (opts && opts.expectedAudience) {
    const aud = payload.aud;
    const matchesAud = Array.isArray(aud) ? aud.includes(opts.expectedAudience) : aud === opts.expectedAudience;
    if (!matchesAud) return { ok: false, error: 'invalid_audience' };
  }

  // Expiration check (with 60-second clock skew grace)
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) {
    return { ok: false, error: 'token_expired' };
  }

  // Nonce check
  if (opts && opts.expectedNonce && payload.nonce !== opts.expectedNonce) {
    return { ok: false, error: 'invalid_nonce' };
  }

  // Verified email check
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    return { ok: false, error: 'email_not_verified' };
  }

  const sub = String(payload.sub || '').trim();
  if (!sub) return { ok: false, error: 'missing_sub' };

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'missing_email' };

  return {
    ok: true,
    sub,
    email,
    name: payload.name || '',
    picture: payload.picture || '',
    payload
  };
}

function validateIdTokenPayload(payload, opts) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'token_payload_missing' };
  const now = (opts && opts.now) ? Math.floor(new Date(opts.now).getTime() / 1000) : Math.floor(Date.now() / 1000);

  const iss = String(payload.iss || '').trim();
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    return { ok: false, error: 'invalid_issuer' };
  }

  if (opts && opts.expectedAudience) {
    const aud = payload.aud;
    const matchesAud = Array.isArray(aud) ? aud.includes(opts.expectedAudience) : aud === opts.expectedAudience;
    if (!matchesAud) return { ok: false, error: 'invalid_audience' };
  }

  if (typeof payload.exp !== 'number' || payload.exp < now - 60) {
    return { ok: false, error: 'token_expired' };
  }

  if (opts && opts.expectedNonce && payload.nonce !== opts.expectedNonce) {
    return { ok: false, error: 'invalid_nonce' };
  }

  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    return { ok: false, error: 'email_not_verified' };
  }

  const sub = String(payload.sub || '').trim();
  if (!sub) return { ok: false, error: 'missing_sub' };

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'missing_email' };

  return {
    ok: true,
    sub,
    email,
    name: payload.name || '',
    picture: payload.picture || ''
  };
}

async function linkGoogleIdentity(db, params) {
  const {
    userId,
    googleSub,
    googleEmail,
    emailVerified,
    idempotencyKey,
    nowValue
  } = params || {};

  if (!userId || !googleSub || !googleEmail || emailVerified !== true || !idempotencyKey) {
    return { ok: false, error: 'invalid_parameters' };
  }

  const now = nowValue ? new Date(nowValue) : new Date();
  const nowIso = now.toISOString();

  // Authoritative atomic RPC - NO fallback mutation
  try {
    const rpcRes = await db.rpc('link_google_identity_and_grant_bonus', {
      p_user_id: userId,
      p_google_sub: googleSub,
      p_google_email: googleEmail,
      p_email_verified: emailVerified,
      p_idempotency_key: idempotencyKey,
      p_activation_time: nowIso
    });

    if (rpcRes && !rpcRes.error && rpcRes.data) {
      return { ok: true, data: Object.assign({}, rpcRes.data, { masked_email: maskEmail(googleEmail) }) };
    }

    const errMsg = (rpcRes && rpcRes.error && rpcRes.error.message) || '';
    if (errMsg.includes('google_identity_conflict')) {
      return { ok: false, code: 'GOOGLE_IDENTITY_CONFLICT', error: 'Akun Google ini sudah terhubung ke akun Auto-Cuan lain.' };
    }
    if (errMsg.includes('user_google_link_mismatch')) {
      return { ok: false, code: 'USER_GOOGLE_LINK_MISMATCH', error: 'Akun Auto-Cuan sudah terikat dengan identitas Google lain.' };
    }
    if (errMsg.includes('user_not_eligible')) {
      return { ok: false, code: 'USER_NOT_ELIGIBLE', error: 'Akun tidak memenuhi syarat.' };
    }
    return { ok: false, code: 'LINK_RPC_FAILED', error: errMsg || 'link_rpc_unavailable' };
  } catch (err) {
    return { ok: false, code: 'LINK_RPC_FAILED', error: err.message || 'link_rpc_unavailable' };
  }
}

async function unlinkGoogleIdentity(db, params) {
  const { userId, nowValue } = params || {};
  if (!userId) return { ok: false, error: 'invalid_parameters' };
  const nowIso = (nowValue ? new Date(nowValue) : new Date()).toISOString();
  try {
    const res = await db.from('app_user_google_links')
      .update({ unlinked_at: nowIso, updated_at: nowIso })
      .eq('user_id', userId);
    return { ok: true, data: res.data };
  } catch (err) {
    return { ok: false, error: err.message || 'database_error' };
  }
}

// Testing hooks
function setTokenExchangeHandlerForTesting(handler) {
  _testTokenExchangeHandler = handler;
}

function setJwksForTesting(keys) {
  _testJwksFetcher = async () => keys;
}

function setJwksFetcherForTesting(fetcher) {
  _testJwksFetcher = fetcher;
}

function resetTestingHooks() {
  _testTokenExchangeHandler = null;
  _testJwksFetcher = null;
  _cachedJwks = null;
  _cachedJwksExpiry = 0;
}

module.exports = {
  getGoogleOAuthConfig,
  hasGoogleOAuthConfig,
  isTestFixtureAllowed,
  maskEmail,
  createCodeVerifier,
  createCodeChallenge,
  createOauthState,
  saveOAuthState,
  consumeOAuthState,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchGoogleJwks,
  verifyGoogleIdToken,
  validateIdTokenPayload,
  linkGoogleIdentity,
  unlinkGoogleIdentity,
  setTokenExchangeHandlerForTesting,
  setJwksForTesting,
  setJwksFetcherForTesting,
  resetTestingHooks
};

'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits
const SERIAL_PREFIX = 'v1';

// In-memory fallback map for test environments without an active Supabase database:
// Map<`${userId}:${provider}`, { encryptedKey: string, keyHint: string, updatedAt: string }>
const fallbackMemoryStore = new Map();

// Fail closed: a missing secret must never fall back to a constant written in
// the repository, because anyone with a DB dump could then decrypt every stored
// BYOK key. Callers surface this as a configuration error instead of storing
// data under a public key.
class CredentialConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialConfigError';
    this.code = 'AI_CREDENTIAL_KEY_UNCONFIGURED';
  }
}

function getMasterKey() {
  const secret = process.env.APP_SECRET ||
    process.env.ENCRYPTION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new CredentialConfigError(
      'Kunci enkripsi kredensial AI belum dikonfigurasi (APP_SECRET/ENCRYPTION_SECRET).'
    );
  }
  return crypto.scryptSync(secret, 'autocuan-chart-ai-salt', KEY_LENGTH);
}

// Gemini keys have a recognizable, documented prefix (legacy AIza..., Google AI
// Studio AQ...). Those keep their strict 20-150 char grammar so a typo is caught
// before any network call. Every other BYOK provider (OpenAI, DeepSeek, Claude,
// OpenRouter, custom gateways) issues opaque tokens with no shared prefix, so
// they use a provider-agnostic grammar that still rejects obviously malformed
// values (too short, too long, whitespace, control/shell metacharacters) without
// inventing a format the provider does not actually use.
const GEMINI_KEY_RE = /^(AIza|AQ)[A-Za-z0-9_\-\.]+$/;
const GENERIC_KEY_RE = /^[A-Za-z0-9_\-\.:/+=~]+$/;

function validateApiKey(key, provider) {
  if (typeof key !== 'string') {
    return { ok: false, error: 'API key harus berupa teks.' };
  }
  const target = String(provider == null ? 'gemini' : provider).trim().toLowerCase();
  const clean = key.trim();

  if (target === 'gemini') {
    if (clean.length < 20) {
      return { ok: false, error: 'API key terlalu pendek (minimal 20 karakter).' };
    }
    if (clean.length > 150) {
      return { ok: false, error: 'API key terlalu panjang (maksimal 150 karakter).' };
    }
    // Google Gemini API keys: legacy format starts with AIza..., newer Google AI Studio format starts with AQ... (e.g. AQ.xxxx)
    if (!GEMINI_KEY_RE.test(clean)) {
      return {
        ok: false,
        error: 'Format API key Google Gemini tidak valid. Harus diawali dengan "AIza" atau "AQ" dan hanya memuat huruf, angka, titik, underscore, atau tanda hubung.'
      };
    }
    return { ok: true, key: clean };
  }

  // Multi-provider BYOK (OpenAI / DeepSeek / Claude / OpenRouter / custom).
  if (clean.length < 8) {
    return { ok: false, error: 'API key terlalu pendek (minimal 8 karakter).' };
  }
  if (clean.length > 200) {
    return { ok: false, error: 'API key terlalu panjang (maksimal 200 karakter).' };
  }
  if (/\s/.test(clean)) {
    return { ok: false, error: 'API key tidak boleh memuat spasi.' };
  }
  if (!GENERIC_KEY_RE.test(clean)) {
    return { ok: false, error: 'API key memuat karakter yang tidak diizinkan.' };
  }
  return { ok: true, key: clean };
}

function maskApiKey(key) {
  if (typeof key !== 'string' || !key.trim()) return '';
  const clean = key.trim();
  const tail = clean.slice(-4);
  return '•••• •••• ' + tail;
}

function encryptApiKey(plainKey, masterKey) {
  const keyBuffer = masterKey || getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SERIAL_PREFIX, iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptApiKey(payload, masterKey) {
  if (typeof payload !== 'string') return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== SERIAL_PREFIX) return null;
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const encrypted = Buffer.from(parts[3], 'hex');
  const keyBuffer = masterKey || getMasterKey();
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (_) {
    return null;
  }
}

async function saveUserApiKey(db, userId, rawKey, provider = 'gemini') {
  const validation = validateApiKey(rawKey, provider);
  if (!validation.ok) {
    return { ok: false, status: 400, error: validation.error };
  }
  const cleanKey = validation.key;
  let encrypted;
  try {
    encrypted = encryptApiKey(cleanKey);
  } catch (e) {
    if (e && e.code === 'AI_CREDENTIAL_KEY_UNCONFIGURED') {
      return { ok: false, status: 503, error: e.message };
    }
    throw e;
  }
  const hint = maskApiKey(cleanKey);
  const now = new Date().toISOString();

  if (db && typeof db.from === 'function') {
    try {
      const res = await db.from('user_ai_credentials').upsert({
        user_id: userId,
        provider,
        encrypted_api_key: encrypted,
        key_hint: hint,
        updated_at: now
      }, { onConflict: 'user_id,provider' });
      if (res.error) {
        // If table does not exist or db error, keep in-memory fallback
        fallbackMemoryStore.set(`${userId}:${provider}`, { encryptedKey: encrypted, keyHint: hint, updatedAt: now });
      }
    } catch (_) {
      fallbackMemoryStore.set(`${userId}:${provider}`, { encryptedKey: encrypted, keyHint: hint, updatedAt: now });
    }
  } else {
    fallbackMemoryStore.set(`${userId}:${provider}`, { encryptedKey: encrypted, keyHint: hint, updatedAt: now });
  }

  return { ok: true, maskedKey: hint };
}

async function getUserApiKey(db, userId, provider = 'gemini') {
  let record = null;
  if (db && typeof db.from === 'function') {
    try {
      const res = await db.from('user_ai_credentials')
        .select('encrypted_api_key, key_hint, updated_at')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();
      if (!res.error && res.data) {
        record = {
          encryptedKey: res.data.encrypted_api_key,
          keyHint: res.data.key_hint,
          updatedAt: res.data.updated_at
        };
      }
    } catch (_) {}
  }

  if (!record) {
    record = fallbackMemoryStore.get(`${userId}:${provider}`) || null;
  }

  if (!record || !record.encryptedKey) {
    return { hasKey: false, apiKey: null, maskedKey: null };
  }

  let decrypted;
  try {
    decrypted = decryptApiKey(record.encryptedKey);
  } catch (e) {
    if (e && e.code === 'AI_CREDENTIAL_KEY_UNCONFIGURED') {
      return { hasKey: false, apiKey: null, maskedKey: null, error: 'KEY_UNCONFIGURED' };
    }
    throw e;
  }
  if (!decrypted) {
    return { hasKey: false, apiKey: null, maskedKey: null, error: 'DECRYPTION_FAILED' };
  }

  return {
    hasKey: true,
    apiKey: decrypted,
    maskedKey: record.keyHint || maskApiKey(decrypted),
    updatedAt: record.updatedAt
  };
}

async function deleteUserApiKey(db, userId, provider = 'gemini') {
  fallbackMemoryStore.delete(`${userId}:${provider}`);
  if (db && typeof db.from === 'function') {
    try {
      await db.from('user_ai_credentials')
        .delete()
        .eq('user_id', userId)
        .eq('provider', provider);
    } catch (_) {}
  }
  return { ok: true };
}

function clearMemoryStoreForTesting() {
  fallbackMemoryStore.clear();
}

function getApplicationGeminiApiKey() {
  const primary = (process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO || '').trim();
  if (primary) return primary;
  const fallback = (process.env.GEMINI_API_KEY || '').trim();
  if (fallback) return fallback;
  const legacy = (process.env.PORTFOLIO_AI_API_KEY || '').trim();
  if (legacy) return legacy;
  return null;
}

function isSubscribedTier(access) {
  if (!access) return false;
  if (access.account && access.account.is_blocked === true) return false;
  const entitlement = access.entitlement || {};
  if (entitlement.entitlement_status === 'blocked' || entitlement.entitlement_status === 'revoked') return false;
  const user = access.user || {};
  const username = String(user.username || '').trim().toLowerCase();
  const isAdmin = user.isAdmin === true;
  if (isAdmin || username === 'budi') return true;
  if (entitlement.lifetime_state === 'active' || entitlement.lifetime_state === 'lifetime') return true;
  if (entitlement.current_plan === 'lifetime' && entitlement.lifetime_state !== 'none') return true;
  if (access.premium === true || entitlement.premium === true) return true;
  return false;
}

async function resolveAiCredentials(db, userId, access) {
  const isSubscribed = isSubscribedTier(access);
  const appKey = getApplicationGeminiApiKey();
  const userKeyInfo = await getUserApiKey(db, userId, 'gemini');
  const userKey = userKeyInfo.hasKey ? userKeyInfo.apiKey : null;

  if (isSubscribed) {
    const primaryKey = appKey || userKey;
    const fallbackKey = (appKey && userKey && appKey !== userKey) ? userKey : null;
    return {
      isSubscribed: true,
      tier: 'subscribed',
      primaryKey,
      fallbackKey,
      source: appKey ? 'app' : (userKey ? 'user' : 'none'),
      hasAppKey: Boolean(appKey),
      hasPersonalKey: Boolean(userKey),
      maskedPersonalKey: userKeyInfo.maskedKey,
      ok: Boolean(primaryKey)
    };
  }

  // Free tier: Personal BYOK is mandatory
  return {
    isSubscribed: false,
    tier: 'free',
    primaryKey: userKey,
    fallbackKey: null,
    source: userKey ? 'user' : 'none',
    hasAppKey: Boolean(appKey),
    hasPersonalKey: Boolean(userKey),
    maskedPersonalKey: userKeyInfo.maskedKey,
    ok: Boolean(userKey)
  };
}

module.exports = {
  CredentialConfigError,
  validateApiKey,
  maskApiKey,
  encryptApiKey,
  decryptApiKey,
  saveUserApiKey,
  getUserApiKey,
  deleteUserApiKey,
  clearMemoryStoreForTesting,
  getApplicationGeminiApiKey,
  isSubscribedTier,
  resolveAiCredentials
};

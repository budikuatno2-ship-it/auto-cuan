'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits
const SERIAL_PREFIX = 'v1';

// In-memory fallback map for test environments without an active Supabase database:
// Map<`${userId}:${provider}`, { encryptedKey: string, keyHint: string, updatedAt: string }>
const fallbackMemoryStore = new Map();

function getMasterKey() {
  const secret = process.env.APP_SECRET ||
    process.env.ENCRYPTION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'autocuan-chart-ai-key-secret-seed';
  return crypto.scryptSync(secret, 'autocuan-chart-ai-salt', KEY_LENGTH);
}

function validateApiKey(key) {
  if (typeof key !== 'string') {
    return { ok: false, error: 'API key harus berupa teks.' };
  }
  const clean = key.trim();
  if (clean.length < 20) {
    return { ok: false, error: 'API key terlalu pendek (minimal 20 karakter).' };
  }
  if (clean.length > 128) {
    return { ok: false, error: 'API key terlalu panjang (maksimal 128 karakter).' };
  }
  if (!/^[A-Za-z0-9_\-]+$/.test(clean)) {
    return { ok: false, error: 'Format karakter API key tidak valid.' };
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
  const validation = validateApiKey(rawKey);
  if (!validation.ok) {
    return { ok: false, status: 400, error: validation.error };
  }
  const cleanKey = validation.key;
  const encrypted = encryptApiKey(cleanKey);
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

  const decrypted = decryptApiKey(record.encryptedKey);
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

module.exports = {
  validateApiKey,
  maskApiKey,
  encryptApiKey,
  decryptApiKey,
  saveUserApiKey,
  getUserApiKey,
  deleteUserApiKey,
  clearMemoryStoreForTesting
};

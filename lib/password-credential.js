'use strict';

const crypto = require('crypto');

// Exactly 64 characters so this is compatible even with historical varchar(64)
// password_hash columns. The non-hex prefix also means the stored value cannot
// pass the browser/API 64-hex client-hash validator and be replayed as a login.
const PREFIX = 'k1$';
const CLIENT_HASH_RE = /^[a-f0-9]{64}$/i;
const STORED_RE = /^k1\$[a-f0-9]{61}$/i;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function normalizeClientHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return CLIENT_HASH_RE.test(hash) ? hash : null;
}

function normalizeAccountKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return key && key.length <= 160 ? key : null;
}

function safeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function derive(clientHash, accountKey) {
  const salt = 'autocuan-password-v1:' + accountKey;
  return crypto.scryptSync(clientHash, salt, KEY_BYTES, SCRYPT_OPTIONS).toString('hex');
}

function protectClientHash(value, accountKeyValue) {
  const clientHash = normalizeClientHash(value);
  const accountKey = normalizeAccountKey(accountKeyValue);
  if (!clientHash) throw new Error('invalid_client_password_hash');
  if (!accountKey) throw new Error('invalid_password_account_key');
  // 3-char prefix + 61 hex chars = exactly 64 chars (244 bits of derived key).
  return PREFIX + derive(clientHash, accountKey).slice(0, 61);
}

function isProtectedCredential(value) {
  return typeof value === 'string' && STORED_RE.test(value.trim());
}

function verifyStoredCredential(storedValue, clientValue, accountKeyValue) {
  const clientHash = normalizeClientHash(clientValue);
  const accountKey = normalizeAccountKey(accountKeyValue);
  if (!clientHash || !accountKey || typeof storedValue !== 'string') {
    return { ok: false, needsUpgrade: false };
  }

  const stored = storedValue.trim();
  if (isProtectedCredential(stored)) {
    let expected;
    try { expected = protectClientHash(clientHash, accountKey); }
    catch (_) { return { ok: false, needsUpgrade: false }; }
    return { ok: safeEqualText(stored.toLowerCase(), expected), needsUpgrade: false };
  }

  // Legacy rows contain the raw client SHA-256 prehash. Accept it only long
  // enough to migrate the row after a successful login; protected k1$ values
  // never enter this branch and therefore cannot be replayed as legacy hashes.
  const legacy = normalizeClientHash(stored);
  if (!legacy) return { ok: false, needsUpgrade: false };
  const ok = safeEqualText(legacy, clientHash);
  return { ok, needsUpgrade: ok };
}

module.exports = {
  PREFIX,
  CLIENT_HASH_RE,
  STORED_RE,
  normalizeClientHash,
  normalizeAccountKey,
  protectClientHash,
  isProtectedCredential,
  verifyStoredCredential
};

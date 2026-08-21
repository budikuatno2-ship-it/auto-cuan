'use strict';

const crypto = require('crypto');

// Fixed-width credential for compatibility with historical varchar(64) schemas.
// Layout: "k1" + 32 hex chars of random salt + 30 hex chars of scrypt output.
// The leading "k" makes the stored value fail the public 64-hex client-hash
// validator, so a database value cannot be replayed directly as a login hash.
const PREFIX = 'k1';
const CLIENT_HASH_RE = /^[a-f0-9]{64}$/i;
const STORED_RE = /^k1[a-f0-9]{62}$/i;
const SALT_BYTES = 16;
const KEY_BYTES = 15;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function normalizeClientHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return CLIENT_HASH_RE.test(hash) ? hash : null;
}

function safeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function derive(clientHash, saltHex) {
  return crypto.scryptSync(
    clientHash,
    Buffer.from(saltHex, 'hex'),
    KEY_BYTES,
    SCRYPT_OPTIONS
  ).toString('hex');
}

function protectClientHash(value) {
  const clientHash = normalizeClientHash(value);
  if (!clientHash) throw new Error('invalid_client_password_hash');
  const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex');
  const digestHex = derive(clientHash, saltHex);
  return PREFIX + saltHex + digestHex;
}

function isProtectedCredential(value) {
  return typeof value === 'string' && STORED_RE.test(value.trim());
}

function verifyStoredCredential(storedValue, clientValue) {
  const clientHash = normalizeClientHash(clientValue);
  if (!clientHash || typeof storedValue !== 'string') {
    return { ok: false, needsUpgrade: false };
  }

  const stored = storedValue.trim().toLowerCase();
  if (isProtectedCredential(stored)) {
    const saltHex = stored.slice(PREFIX.length, PREFIX.length + SALT_BYTES * 2);
    const expectedDigest = stored.slice(PREFIX.length + SALT_BYTES * 2);
    let actualDigest;
    try { actualDigest = derive(clientHash, saltHex); }
    catch (_) { return { ok: false, needsUpgrade: false }; }
    return { ok: safeEqualText(actualDigest, expectedDigest), needsUpgrade: false };
  }

  // Legacy rows contain the raw client SHA-256 prehash. Accept it only long
  // enough to migrate the row after a successful login; protected k1 values
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
  protectClientHash,
  isProtectedCredential,
  verifyStoredCredential
};

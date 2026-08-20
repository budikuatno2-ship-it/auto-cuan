'use strict';

const crypto = require('crypto');

const PREFIX = 'scrypt$v1$';
const CLIENT_HASH_RE = /^[a-f0-9]{64}$/i;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function normalizeClientHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return CLIENT_HASH_RE.test(hash) ? hash : null;
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  let left, right;
  try {
    left = Buffer.from(a, 'hex');
    right = Buffer.from(b, 'hex');
  } catch (_) { return false; }
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function derive(clientHash, saltHex) {
  return crypto.scryptSync(clientHash, Buffer.from(saltHex, 'hex'), KEY_BYTES, SCRYPT_OPTIONS).toString('hex');
}

function protectClientHash(value) {
  const clientHash = normalizeClientHash(value);
  if (!clientHash) throw new Error('invalid_client_password_hash');
  const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex');
  return PREFIX + saltHex + '$' + derive(clientHash, saltHex);
}

function isProtectedCredential(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function verifyStoredCredential(storedValue, clientValue) {
  const clientHash = normalizeClientHash(clientValue);
  if (!clientHash || typeof storedValue !== 'string') return { ok: false, needsUpgrade: false };

  const stored = storedValue.trim().toLowerCase();
  if (CLIENT_HASH_RE.test(stored)) {
    return { ok: safeEqualHex(stored, clientHash), needsUpgrade: safeEqualHex(stored, clientHash) };
  }

  if (!stored.startsWith(PREFIX)) return { ok: false, needsUpgrade: false };
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return { ok: false, needsUpgrade: false };
  const saltHex = parts[2];
  const expectedHex = parts[3];
  if (!/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{64}$/i.test(expectedHex)) return { ok: false, needsUpgrade: false };

  let actualHex;
  try { actualHex = derive(clientHash, saltHex); }
  catch (_) { return { ok: false, needsUpgrade: false }; }
  return { ok: safeEqualHex(actualHex, expectedHex), needsUpgrade: false };
}

module.exports = {
  PREFIX,
  CLIENT_HASH_RE,
  normalizeClientHash,
  protectClientHash,
  isProtectedCredential,
  verifyStoredCredential
};

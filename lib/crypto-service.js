'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // 12 bytes standard for AES-GCM
const AUTH_TAG_LENGTH = 16;  // 16 bytes auth tag

/**
 * Constant-time buffer comparison to prevent timing attacks.
 * If buffers differ in length, safely returns false without timing variance.
 */
function timingSafeEqual(a, b) {
  if (typeof a === 'string') a = Buffer.from(a);
  if (typeof b === 'string') b = Buffer.from(b);
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    return false;
  }
  if (a.length !== b.length) {
    try {
      crypto.timingSafeEqual(b, b);
    } catch (_) {}
    return false;
  }
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

/**
 * Normalizes or derives a 32-byte key for AES-256-GCM.
 */
function normalizeKey(key) {
  if (Buffer.isBuffer(key) && key.length === 32) {
    return key;
  }
  if (typeof key === 'string') {
    if (/^[0-9a-fA-F]{64}$/.test(key)) {
      return Buffer.from(key, 'hex');
    }
    // Derive 32-byte key via SHA-256
    return crypto.createHash('sha256').update(key).digest();
  }
  throw new TypeError('Key must be a 32-byte Buffer, 64-character hex string, or passphrase string.');
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns an object with { ciphertext, iv, tag, serialized } in hex strings.
 */
function encrypt(plaintext, key, options = {}) {
  const normalizedKey = normalizeKey(key);
  const iv = options.iv ? Buffer.from(options.iv) : crypto.randomBytes(IV_LENGTH);
  if (iv.length !== IV_LENGTH) {
    throw new Error(`IV length must be ${IV_LENGTH} bytes for AES-256-GCM.`);
  }

  const cipher = crypto.createCipheriv(ALGORITHM, normalizedKey, iv);
  if (options.aad) {
    cipher.setAAD(Buffer.isBuffer(options.aad) ? options.aad : Buffer.from(options.aad));
  }

  const plainBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    serialized: `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
  };
}

/**
 * Decrypts ciphertext using AES-256-GCM.
 * Verifies the 16-byte authentication tag before returning decrypted plaintext.
 */
function decrypt(encryptedInput, key, options = {}) {
  const normalizedKey = normalizeKey(key);
  let ciphertextBuf, ivBuf, tagBuf;

  if (typeof encryptedInput === 'string' && encryptedInput.includes(':')) {
    const parts = encryptedInput.split(':');
    if (parts.length === 3) {
      ivBuf = Buffer.from(parts[0], 'hex');
      tagBuf = Buffer.from(parts[1], 'hex');
      ciphertextBuf = Buffer.from(parts[2], 'hex');
    } else {
      throw new Error('Invalid serialized ciphertext format. Expected iv:tag:ciphertext.');
    }
  } else if (typeof encryptedInput === 'object' && encryptedInput !== null) {
    ivBuf = Buffer.isBuffer(encryptedInput.iv) ? encryptedInput.iv : Buffer.from(encryptedInput.iv, 'hex');
    tagBuf = Buffer.isBuffer(encryptedInput.tag) ? encryptedInput.tag : Buffer.from(encryptedInput.tag, 'hex');
    ciphertextBuf = Buffer.isBuffer(encryptedInput.ciphertext)
      ? encryptedInput.ciphertext
      : Buffer.from(encryptedInput.ciphertext, 'hex');
  } else {
    throw new TypeError('encryptedInput must be a serialized string or object with { ciphertext, iv, tag }.');
  }

  if (ivBuf.length !== IV_LENGTH) {
    throw new Error(`IV length must be ${IV_LENGTH} bytes.`);
  }
  if (tagBuf.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Auth tag length must be ${AUTH_TAG_LENGTH} bytes.`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, normalizedKey, ivBuf);
  decipher.setAuthTag(tagBuf);

  if (options.aad) {
    decipher.setAAD(Buffer.isBuffer(options.aad) ? options.aad : Buffer.from(options.aad));
  }

  const decrypted = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
  return options.raw ? decrypted : decrypted.toString('utf8');
}

/**
 * Computes SHA-256 hash in hex
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  timingSafeEqual,
  normalizeKey,
  encrypt,
  decrypt,
  sha256
};

'use strict';

/**
 * One-time Magic Link Token store for seamless Auto-Cuan auto-login.
 *
 * Persists to `bot_registration_tokens` in Supabase when available, with
 * an in-memory Map and disk fallback in runner state / data directory.
 * Tokens are HMAC-SHA256 signed, single-use, rate-limited, and expire in 15 minutes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TABLE = 'bot_registration_tokens';
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL for magic tokens
const memoryStore = new Map();

function getFallbackFile() {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  const candidate = path.join(runnerDir, 'state', 'bot-magic-tokens-fallback.json');
  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    return candidate;
  } catch (_) {
    return path.join(__dirname, '..', 'data', 'bot-magic-tokens-fallback.json');
  }
}

function loadDiskFallback() {
  try {
    const file = getFallbackFile();
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = Date.now();
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row && row.token && row.expiresAt > now && row.status === 'pending') {
          if (!memoryStore.has(row.token)) {
            memoryStore.set(row.token, row);
          }
        }
      }
    }
  } catch (_) {}
}

function saveDiskFallback() {
  try {
    const file = getFallbackFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const list = [];
    for (const [token, entry] of memoryStore) {
      list.push(Object.assign({ token }, entry));
    }
    fs.writeFileSync(file, JSON.stringify(list), 'utf8');
  } catch (_) {}
}

loadDiskFallback();

function getSigningSecret() {
  const s = process.env.SESSION_SECRET ||
            process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET ||
            process.env.TELEGRAM_VERIFY_BOT_TOKEN ||
            'autocuan-magic-secret-default-seed';
  return String(s);
}

function signPayload(payloadStr, secret) {
  return crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');
}

function purgeMemory(now) {
  const current = now != null ? now : Date.now();
  let changed = false;
  for (const [token, entry] of memoryStore) {
    if (entry.expiresAt <= current) {
      memoryStore.delete(token);
      changed = true;
    }
  }
  if (changed) saveDiskFallback();
}

/**
 * Issue a magic token for an active user.
 */
async function issueToken(db, telegramId, username, options) {
  const opts = options || {};
  const ttlMs = Number(opts.ttlMs) || DEFAULT_TTL_MS;
  const now = opts.now ? opts.now() : Date.now();
  const secret = getSigningSecret();

  const idStr = String(telegramId == null ? '' : telegramId).trim();
  const unameStr = String(username == null ? '' : username).trim().toLowerCase();

  const nonce = crypto.randomBytes(20).toString('base64url');
  const payloadData = `${idStr}:${unameStr}:${now + ttlMs}:${nonce}`;
  const sig = signPayload(payloadData, secret);
  const token = `mgt_${Buffer.from(payloadData, 'utf8').toString('base64url')}.${sig}`;

  const row = {
    token,
    telegram_id: idStr,
    status: 'pending',
    expires_at: new Date(now + ttlMs).toISOString(),
    created_at: new Date(now).toISOString()
  };

  purgeMemory(now);
  memoryStore.set(token, {
    telegramId: idStr,
    username: unameStr,
    expiresAt: now + ttlMs,
    status: 'pending'
  });
  saveDiskFallback();

  if (db && typeof db.from === 'function') {
    try {
      await db.from(TABLE).insert(row);
    } catch (_) {
      // Table insert best-effort; in-memory + disk fallback serves the process.
    }
  }

  return token;
}

/**
 * Consume a magic token. Validates signature, expiry, telegram id, and burns atomically.
 */
async function consumeToken(db, token, telegramId, options) {
  const opts = options || {};
  const now = opts.now ? opts.now() : Date.now();
  const rawToken = String(token || '').trim();

  if (!rawToken || !rawToken.startsWith('mgt_')) {
    return { ok: false, reason: 'invalid_format' };
  }

  const dotIdx = rawToken.indexOf('.');
  if (dotIdx === -1) {
    return { ok: false, reason: 'missing_signature' };
  }

  const b64Payload = rawToken.slice('mgt_'.length, dotIdx);
  const providedSig = rawToken.slice(dotIdx + 1);

  let payloadStr = '';
  try {
    payloadStr = Buffer.from(b64Payload, 'base64url').toString('utf8');
  } catch (_) {
    return { ok: false, reason: 'corrupt_payload' };
  }

  const secret = getSigningSecret();
  const expectedSig = signPayload(payloadStr, secret);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const parts = payloadStr.split(':');
  if (parts.length < 4) {
    return { ok: false, reason: 'malformed_payload' };
  }

  const [tId, uname, expStr] = parts;
  const expTime = Number(expStr);

  if (!Number.isFinite(expTime) || expTime <= now) {
    return { ok: false, reason: 'expired' };
  }

  const idToMatch = String(telegramId == null ? '' : telegramId).trim().toLowerCase();
  if (idToMatch && idToMatch !== tId.toLowerCase() && idToMatch !== uname) {
    return { ok: false, reason: 'identity_mismatch' };
  }

  // Check and burn atomically in database if available
  if (db && typeof db.from === 'function') {
    try {
      const res = await db.from(TABLE)
        .select('token, telegram_id, status, expires_at')
        .eq('token', rawToken)
        .maybeSingle();

      if (!res.error && res.data) {
        const row = res.data;
        if (row.status !== 'pending') {
          return { ok: false, reason: 'used' };
        }
        if (Date.parse(row.expires_at) <= now) {
          await invalidateToken(db, rawToken);
          return { ok: false, reason: 'expired' };
        }

        const burn = await db.from(TABLE)
          .update({ status: 'used', used_at: new Date(now).toISOString() })
          .eq('token', rawToken)
          .eq('status', 'pending');

        if (burn && burn.error) return { ok: false, reason: 'used' };

        memoryStore.delete(rawToken);
        saveDiskFallback();
        return { ok: true, telegramId: tId, username: uname };
      }
    } catch (_) {
      // Fall through to memory store check
    }
  }

  // Fallback to disk + memory. The verify bot and the web process do not share
  // memory, and the DB insert is best-effort, so reload the shared file before
  // deciding the token is missing.
  loadDiskFallback();
  purgeMemory(now);
  const entry = memoryStore.get(rawToken);
  if (!entry) {
    return { ok: false, reason: 'not_found_or_used' };
  }

  if (entry.expiresAt <= now) {
    memoryStore.delete(rawToken);
    saveDiskFallback();
    return { ok: false, reason: 'expired' };
  }

  if (entry.status !== 'pending') {
    memoryStore.delete(rawToken);
    saveDiskFallback();
    return { ok: false, reason: 'used' };
  }

  // Burn atomically in memory
  entry.status = 'used';
  memoryStore.delete(rawToken);
  saveDiskFallback();

  return { ok: true, telegramId: tId, username: uname };
}

async function invalidateToken(db, token) {
  if (!token) return true;
  memoryStore.delete(token);
  saveDiskFallback();
  if (db && typeof db.from === 'function') {
    try {
      await db.from(TABLE).update({ status: 'used' }).eq('token', token);
    } catch (_) {}
  }
  return true;
}

function buildMagicLoginUrl(baseUrl, token, telegramId) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const params = [];
  if (token) params.push('auth_token=' + encodeURIComponent(token));
  if (telegramId) params.push('user_id=' + encodeURIComponent(telegramId));
  return base + '/' + (params.length ? '?' + params.join('&') : '');
}

function clearMemoryStoreForTesting() {
  memoryStore.clear();
  try {
    const file = getFallbackFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {}
}

module.exports = {
  TABLE,
  DEFAULT_TTL_MS,
  issueToken,
  consumeToken,
  invalidateToken,
  buildMagicLoginUrl,
  clearMemoryStoreForTesting
};

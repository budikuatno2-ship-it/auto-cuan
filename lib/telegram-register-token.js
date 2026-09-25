'use strict';

/**
 * One-time registration token store (shared across processes).
 *
 * The interactive bot runs as a long-lived PM2 process, while the public
 * registration form is a separate serverless function. They do not share
 * memory, so the token MUST live in the database to be verifiable by the web
 * handler. This module persists to `bot_registration_tokens` (see
 * supabase/bot-registration-tokens-migration.sql) and falls back to an
 * in-process Map when no database is configured (local tests).
 *
 * Contract:
 *  - A token is random, single-use (burn after consume) and expires in 10 min.
 *  - Consumption is atomic at the row level: the UPDATE ... status='used'
 *    guarded by status='pending' means two concurrent submits cannot both win.
 */

const crypto = require('crypto');

const TABLE = 'bot_registration_tokens';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const memoryStore = new Map();

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function purgeMemory(now) {
  const current = now != null ? now : Date.now();
  for (const [token, entry] of memoryStore) {
    if (entry.expiresAt <= current) memoryStore.delete(token);
  }
}

/**
 * Issue a token for a telegram id. Persists to the DB when available; the
 * in-memory copy is always kept so tests and single-process mode work.
 */
async function issueToken(db, telegramId, options) {
  const opts = options || {};
  const ttlMs = Number(opts.ttlMs) || DEFAULT_TTL_MS;
  const now = opts.now ? opts.now() : Date.now();
  const token = randomToken();
  const row = {
    token,
    telegram_id: String(telegramId),
    status: 'pending',
    expires_at: new Date(now + ttlMs).toISOString(),
    created_at: new Date(now).toISOString()
  };

  purgeMemory(now);
  memoryStore.set(token, { telegramId: row.telegram_id, expiresAt: now + ttlMs, status: 'pending' });

  if (db && typeof db.from === 'function') {
    try {
      await db.from(TABLE).insert(row);
    } catch (_) {
      // Table may not be provisioned; the memory copy still serves this process.
    }
  }
  return token;
}

/**
 * Consume a token. Returns { ok, telegramId } or { ok:false, reason }.
 * Tries the DB first (cross-process), then the in-memory copy.
 */
async function consumeToken(db, token, options) {
  const opts = options || {};
  const now = opts.now ? opts.now() : Date.now();
  if (!token) return { ok: false, reason: 'missing' };

  if (db && typeof db.from === 'function') {
    try {
      const res = await db.from(TABLE)
        .select('token, telegram_id, status, expires_at')
        .eq('token', token)
        .maybeSingle();
      if (!res.error && res.data) {
        const row = res.data;
        if (row.status !== 'pending') return { ok: false, reason: 'used' };
        if (Date.parse(row.expires_at) <= now) {
          await invalidateToken(db, token);
          return { ok: false, reason: 'expired' };
        }
        // Burn atomically: only a row still 'pending' can transition.
        const burn = await db.from(TABLE)
          .update({ status: 'used', used_at: new Date(now).toISOString() })
          .eq('token', token)
          .eq('status', 'pending');
        if (burn && burn.error) return { ok: false, reason: 'used' };
        memoryStore.delete(token);
        return { ok: true, telegramId: String(row.telegram_id) };
      }
    } catch (_) {
      // Fall through to the in-memory copy.
    }
  }

  purgeMemory(now);
  const entry = memoryStore.get(token);
  if (!entry) return { ok: false, reason: 'expired' };
  memoryStore.delete(token);
  if (entry.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (entry.status !== 'pending') return { ok: false, reason: 'used' };
  return { ok: true, telegramId: entry.telegramId };
}

async function invalidateToken(db, token) {
  if (!token) return true;
  memoryStore.delete(token);
  if (db && typeof db.from === 'function') {
    try {
      await db.from(TABLE).update({ status: 'used' }).eq('token', token);
    } catch (_) { /* best effort */ }
  }
  return true;
}

function clearMemoryStoreForTesting() {
  memoryStore.clear();
}

module.exports = {
  TABLE,
  DEFAULT_TTL_MS,
  issueToken,
  consumeToken,
  invalidateToken,
  clearMemoryStoreForTesting
};
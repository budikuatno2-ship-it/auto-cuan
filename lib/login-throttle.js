'use strict';

// B2 (security): in-application login attempt throttle for /api/login-user.
//
// Independent of SECURITY_GUARD_MODE and of reCAPTCHA. Production was observed
// with SECURITY_GUARD_MODE unset, SECURITY_EVENT_PEPPER unset and no reCAPTCHA
// secret, so the durable guard failed OPEN for normal accounts and repeated
// password guesses were never slowed (8 consecutive bad attempts returned 400
// with no 429). This module adds a limit that is always on, keyed only on values
// the server observed (client IP and the normalized submitted username).
//
// Limits (defaults, configurable via env):
//   - per (account, IP) pair : 5 failures / 15 min  -> then blocked for 15 min
//   - per IP                 : 30 failures / 15 min -> then blocked for 15 min
//   - progressive delay      : each failure below the pair threshold sleeps
//                              400ms, 800ms, 1.6s, 3.2s (capped 5s)
//
// Adjusting the numbers: real login traffic is tiny (the 7-day nginx log holds
// only a handful of /api/login-user POSTs), so 5/15min per pair never touches a
// genuine user who mistypes a couple of times, while 30/15min per IP leaves room
// for a shared NAT. Raise them only if the login log shows real collisions.
//
// Persistence: counters live in a small SQLite file (node:sqlite, Node >=22.13,
// the same runtime primitive already used by lib/vps-market-store.js), so they
// survive a PM2 restart. The default path is OS temp (stable across process
// restarts, cleared on reboot); point LOGIN_THROTTLE_DB at a persistent path to
// survive reboots too.
//
// State is per-process. autocuan-web runs as a single forked process
// (ecosystem.config.js: exec_mode fork, instances 1), so the limit is exact.
// The module never throws: a throttle-storage error must never turn a login into
// a 500, and must never lock a user out permanently.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// node --test runs every file in its own process with NODE_TEST_CONTEXT set
// (child-v8). In that mode use an in-memory DB and never sleep, so unit tests do
// not touch the developer's filesystem or wall-clock.
const TEST_MODE = process.env.NODE_TEST_CONTEXT != null || process.env.LOGIN_THROTTLE_FORCE_TEST === '1';

const DEFAULT_PAIR_MAX = 5;
const DEFAULT_PAIR_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IP_MAX = 30;
const DEFAULT_IP_TTL_MS = 15 * 60 * 1000;
const DEFAULT_BACKOFF_BASE_MS = 400;
const DEFAULT_BACKOFF_MAX_MS = 5000;

const PUBLIC_ERROR = 'Terlalu banyak percobaan login. Coba lagi nanti.';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function flag(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  return fallback;
}

// Resolved on every call so tests (and an operator) can change env at runtime.
function getConfig() {
  return {
    enabled: flag(process.env.LOGIN_THROTTLE_ENABLED, true),
    pairMax: num(process.env.LOGIN_THROTTLE_PAIR_MAX, DEFAULT_PAIR_MAX),
    pairTtlMs: num(process.env.LOGIN_THROTTLE_PAIR_TTL_MS, DEFAULT_PAIR_TTL_MS),
    ipMax: num(process.env.LOGIN_THROTTLE_IP_MAX, DEFAULT_IP_MAX),
    ipTtlMs: num(process.env.LOGIN_THROTTLE_IP_TTL_MS, DEFAULT_IP_TTL_MS),
    backoffEnabled: flag(process.env.LOGIN_THROTTLE_ENABLE_BACKOFF, true),
    backoffBaseMs: num(process.env.LOGIN_THROTTLE_BACKOFF_BASE_MS, DEFAULT_BACKOFF_BASE_MS),
    backoffMaxMs: num(process.env.LOGIN_THROTTLE_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS)
  };
}

function normalizeAccount(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 80);
}

function normalizeIpValue(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 100) || 'unknown';
}

// Build the two bucket keys from SERVER-OBSERVED values only. `ip` should come
// from request-rate-limit.clientAddress (nginx-appended X-Forwarded-For); the
// username is normalized and only ever combined with the observed IP.
function keysFor(input) {
  const source = input || {};
  const ip = normalizeIpValue(source.ip);
  const account = normalizeAccount(source.username);
  return {
    pair: 'pair|' + ip + '|' + account,
    ip: 'ip|' + ip,
    account,
    ipValue: ip
  };
}

let db = null;
let dbInitFailed = false;

function dbPath() {
  if (TEST_MODE) return ':memory:';
  return process.env.LOGIN_THROTTLE_DB || path.join(os.tmpdir(), 'autocuan-login-throttle.sqlite');
}

function openDb() {
  if (db) return db;
  if (dbInitFailed) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const target = dbPath();
    if (target !== ':memory:') {
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (_) {}
    }
    const handle = new DatabaseSync(target);
    handle.exec(
      'CREATE TABLE IF NOT EXISTS login_throttle (' +
      'k TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL, failures INTEGER NOT NULL, ' +
      'last_failure_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)'
    );
    db = handle;
    return db;
  } catch (_) {
    // Storage unavailable: degrade to "no throttle" rather than 500 the login.
    dbInitFailed = true;
    return null;
  }
}

function getRow(handle, key) {
  try {
    const stmt = handle.prepare('SELECT window_started_at, failures, last_failure_at, blocked_until FROM login_throttle WHERE k = ?');
    return stmt.get(key) || null;
  } catch (_) {
    return null;
  }
}

function upsertRow(handle, key, windowStartedAt, failures, lastFailureAt, blockedUntil) {
  try {
    const stmt = handle.prepare(
      'INSERT INTO login_throttle (k, window_started_at, failures, last_failure_at, blocked_until) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET window_started_at = excluded.window_started_at, failures = excluded.failures, ' +
      'last_failure_at = excluded.last_failure_at, blocked_until = excluded.blocked_until'
    );
    stmt.run(key, windowStartedAt, failures, lastFailureAt, blockedUntil);
  } catch (_) { /* best-effort */ }
}

function deleteRow(handle, key) {
  try { handle.prepare('DELETE FROM login_throttle WHERE k = ?').run(key); } catch (_) {}
}

// Effective expiry of a row's active window (0 when the window has already
// elapsed). At the moment the threshold is crossed, blocked_until == the window
// end, so a block always auto-clears when the window rolls over.
function rowExpiry(row, now, ttlMs) {
  if (!row) return 0;
  const windowEnd = Number(row.window_started_at) + ttlMs;
  const blockedUntil = Number(row.blocked_until) || 0;
  const expiry = Math.max(windowEnd, blockedUntil);
  return now < expiry ? expiry : 0;
}

// Is this key currently blocked? Returns remaining seconds (0 when not blocked).
function check(keys, nowValue) {
  const cfg = getConfig();
  if (!cfg.enabled) return { limited: false, retryAfterSeconds: 0, reason: null };
  const now = nowValue == null ? Date.now() : Number(nowValue);
  const handle = openDb();
  if (!handle) return { limited: false, retryAfterSeconds: 0, reason: null };
  const buckets = keys || keysFor({});
  let retryAfterMs = 0;
  let reason = null;

  const pairRow = getRow(handle, buckets.pair);
  const pairExpiry = rowExpiry(pairRow, now, cfg.pairTtlMs);
  if (pairExpiry && Number(pairRow.failures) >= cfg.pairMax) {
    reason = 'pair';
    retryAfterMs = Math.max(retryAfterMs, pairExpiry - now);
  }
  const ipRow = getRow(handle, buckets.ip);
  const ipExpiry = rowExpiry(ipRow, now, cfg.ipTtlMs);
  if (ipExpiry && Number(ipRow.failures) >= cfg.ipMax) {
    reason = reason || 'ip';
    retryAfterMs = Math.max(retryAfterMs, ipExpiry - now);
  }

  if (retryAfterMs > 0) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)), reason };
  }
  return { limited: false, retryAfterSeconds: 0, reason: null };
}

function bump(handle, key, now, ttlMs, max) {
  const row = getRow(handle, key);
  let windowStartedAt = now;
  let failures = 0;
  if (row && (now - Number(row.window_started_at)) < ttlMs) {
    windowStartedAt = Number(row.window_started_at);
    failures = Number(row.failures) || 0;
  }
  failures += 1;
  const blockedUntil = failures >= max ? now + ttlMs : 0;
  upsertRow(handle, key, windowStartedAt, failures, now, blockedUntil);
  return failures;
}

// Record one credential failure against both buckets. Returns the pair-level
// failure count (used to size the progressive delay).
function recordFailure(keys, nowValue) {
  const cfg = getConfig();
  if (!cfg.enabled) return { recorded: false, pairFailures: 0 };
  const now = nowValue == null ? Date.now() : Number(nowValue);
  const handle = openDb();
  if (!handle) return { recorded: false, pairFailures: 0 };
  const buckets = keys || keysFor({});
  const pairFailures = bump(handle, buckets.pair, now, cfg.pairTtlMs, cfg.pairMax);
  bump(handle, buckets.ip, now, cfg.ipTtlMs, cfg.ipMax);
  return { recorded: true, pairFailures };
}

// Progressive delay applied to the client BEFORE the failure response is sent.
// Zero once the pair is blocked (the 429 + Retry-After governs instead).
function backoffMs(pairFailures) {
  const cfg = getConfig();
  if (!cfg.backoffEnabled || !(pairFailures > 0)) return 0;
  const raw = cfg.backoffBaseMs * Math.pow(2, pairFailures - 1);
  return Math.min(Math.round(raw), cfg.backoffMaxMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Primary entry point used by the login handler on a credential failure:
// record the failure, then wait out the progressive delay. Never throws.
async function registerFailure(keys, nowValue) {
  try {
    const outcome = recordFailure(keys, nowValue);
    if (TEST_MODE) return { ...outcome, delayMs: 0 };
    const delayMs = backoffMs(outcome.pairFailures);
    if (delayMs > 0) await sleep(delayMs);
    return { ...outcome, delayMs };
  } catch (_) {
    return { recorded: false, pairFailures: 0, delayMs: 0 };
  }
}

// A successful, password-verified login clears the pair and IP buckets so a
// genuine user is never penalized by earlier typos once they get it right.
function clearFailure(keys) {
  const handle = openDb();
  if (!handle) return { cleared: false };
  const buckets = keys || keysFor({});
  deleteRow(handle, buckets.pair);
  deleteRow(handle, buckets.ip);
  return { cleared: true };
}

module.exports = {
  PUBLIC_ERROR,
  getConfig,
  keysFor,
  normalizeAccount,
  normalizeIpValue,
  check,
  recordFailure,
  registerFailure,
  clearFailure,
  backoffMs,
  // test seam
  _reset() {
    const handle = openDb();
    if (handle) { try { handle.exec('DELETE FROM login_throttle'); } catch (_) {} }
  },
  _isTestMode() { return TEST_MODE; }
};
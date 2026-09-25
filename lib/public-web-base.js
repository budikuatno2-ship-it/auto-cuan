'use strict';

/**
 * Public Web Base URL — Single Source of Truth
 *
 * Why this module exists
 * ----------------------
 * The public web (register form, broker-summary viewer, chart view) used to be
 * advertised to members as a hard-coded `https://autocuan.web.id/...` literal in
 * two separate bot modules:
 *
 *   - lib/telegram-verification.js   -> REGISTER_FORM_URL
 *   - lib/telegram-interactive-bot.js -> PUBLIC_REGISTER_BASE
 *
 * When the Vercel deployment behind that domain is paused (it answers HTTP 402
 * `DEPLOYMENT_DISABLED`), every button the bot emits points at a dead host. The
 * Express app on the VPS (auto-cuan-local-app, port 3000) already serves the
 * same pages, so the only thing missing is a *stable way to discover its public
 * hostname*.
 *
 * Resolution order (first usable value wins)
 * ------------------------------------------
 *   1. `PUBLIC_WEB_BASE_URL`            — explicit operator override (wins always).
 *   2. `BOT_REGISTER_BASE_URL`          — legacy override kept for compatibility.
 *   3. Tunnel URL file                  — written by tools/cloudflared-web-supervisor.js
 *                                         whenever the quick tunnel (re)starts.
 *   4. `https://autocuan.web.id`        — the canonical public domain (fallback).
 *
 * Only an `https://` URL with a real host is ever accepted, so a partially
 * written or corrupt file can never produce a malformed button URL.
 */

const fs = require('fs');
const path = require('path');

// Canonical public domain. Kept as the last resort so behaviour on a healthy
// Vercel deployment is byte-for-byte identical to before this module existed.
const CANONICAL_BASE_URL = 'https://autocuan.web.id';

// The tunnel supervisor rewrites this file on every tunnel (re)start. Reading it
// is how the bots follow a quick tunnel whose hostname changes on restart.
const DEFAULT_RUNNER_DIR = '/home/ubuntu/auto-cuan-runner';
const TUNNEL_URL_FILENAME = 'cloudflared-web-url.txt';

// A file read per Telegram message would be wasteful; the tunnel hostname only
// changes on restart, so a short cache is enough to stay current.
const CACHE_TTL_MS = 30000;

let cache = { value: null, at: 0, source: null };

function runnerDir(env) {
  const e = env || process.env;
  return String(e.AUTO_CUAN_RUNNER_DIR || '').trim() || DEFAULT_RUNNER_DIR;
}

function tunnelUrlFilePath(env) {
  const e = env || process.env;
  const explicit = String(e.PUBLIC_WEB_URL_FILE || '').trim();
  if (explicit) return explicit;
  return path.join(runnerDir(env), TUNNEL_URL_FILENAME);
}

/**
 * Accept only a well-formed absolute https URL, and return it without any
 * trailing slash so callers can append a path safely.
 */
function normalizeBaseUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.hostname.indexOf('.') < 0) return null;
  return parsed.origin;
}

function readTunnelUrlFile(env) {
  const file = tunnelUrlFilePath(env);
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    // The file may contain a bare base URL, or a full deep link written by the
    // legacy webhook helper. Take the first https origin found on any line.
    const match = text.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? normalizeBaseUrl(match[0]) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the base URL the bot should advertise. Never throws.
 *
 * @param {Object} [env] - environment map (defaults to process.env)
 * @param {Object} [options]
 * @param {boolean} [options.bypassCache] - force a fresh resolution
 * @returns {{ base_url: string, source: string }}
 */
function resolvePublicWebBase(env, options) {
  const e = env || process.env;
  const opts = options || {};
  const now = Date.now();

  if (!opts.bypassCache && cache.value && (now - cache.at) < CACHE_TTL_MS) {
    return { base_url: cache.value, source: cache.source };
  }

  const candidates = [
    { source: 'env:PUBLIC_WEB_BASE_URL', value: normalizeBaseUrl(e.PUBLIC_WEB_BASE_URL) },
    { source: 'env:BOT_REGISTER_BASE_URL', value: normalizeBaseUrl(e.BOT_REGISTER_BASE_URL) },
    { source: 'file:tunnel', value: readTunnelUrlFile(e) },
    { source: 'canonical', value: CANONICAL_BASE_URL }
  ];

  for (const candidate of candidates) {
    if (candidate.value) {
      cache = { value: candidate.value, at: now, source: candidate.source };
      return { base_url: candidate.value, source: candidate.source };
    }
  }

  cache = { value: CANONICAL_BASE_URL, at: now, source: 'canonical' };
  return { base_url: CANONICAL_BASE_URL, source: 'canonical' };
}

/** Convenience accessor returning just the base URL string. */
function getPublicWebBase(env) {
  return resolvePublicWebBase(env).base_url;
}

/**
 * Build an absolute public URL for a local path.
 * @param {string} pathname - e.g. '/register.html' or '/analisis-saham?ticker=BBRI'
 */
function publicWebUrl(pathname, env) {
  const base = getPublicWebBase(env);
  const suffix = String(pathname == null ? '' : pathname);
  if (!suffix) return base;
  return base + (suffix.charAt(0) === '/' ? suffix : '/' + suffix);
}

/** Test/diagnostic helper — clears the memoised value. */
function clearCache() {
  cache = { value: null, at: 0, source: null };
}

module.exports = {
  CANONICAL_BASE_URL,
  DEFAULT_RUNNER_DIR,
  TUNNEL_URL_FILENAME,
  CACHE_TTL_MS,
  normalizeBaseUrl,
  tunnelUrlFilePath,
  resolvePublicWebBase,
  getPublicWebBase,
  publicWebUrl,
  clearCache
};

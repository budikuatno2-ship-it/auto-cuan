'use strict';

// Best-effort sliding-window limiter, shared by the endpoints that need one.
//
// Extracted from api/log.js, which already had a correct implementation and an
// honest comment about its scope. That scope is worth restating here because it
// is a deliberate design choice, not an oversight:
//
//   Vercel may run several instances of a function concurrently, and each holds
//   its own Map. A caller spread across N instances gets up to N times the
//   budget. This blunts floods and makes scripted abuse meaningfully harder; it
//   is not a hard global guarantee. A durable limit needs shared state (a Redis
//   or Postgres counter), which is a schema and infrastructure decision rather
//   than a web change.
//
// The bucket key must be built only from things the server observed. Keying on
// anything the caller controls — a username in the request body, a header they
// set — lets them mint a fresh bucket per request, which is a limiter that
// bounds nothing.

const DEFAULT_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 5000;

function createRateLimiter(options) {
  const windowMs = (options && options.windowMs) || DEFAULT_WINDOW_MS;
  const max = (options && options.max) || 60;
  const buckets = new Map();

  return {
    windowMs,
    max,
    // Returns true when the call is allowed, and records it.
    check(key) {
      const now = Date.now();
      // Bound memory on a long-lived instance. Clearing is safe: the worst case
      // is that a few callers get a fresh window.
      if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();
      const recent = (buckets.get(key) || []).filter(stamp => now - stamp < windowMs);
      if (recent.length >= max) return false;
      recent.push(now);
      buckets.set(key, recent);
      return true;
    },
    // Test seam.
    _reset() { buckets.clear(); }
  };
}

// C1 (22 Oct 2026): the caller's address may be trusted only from a proxy chain.
//
// This previously returned the FIRST `x-forwarded-for` entry — which is exactly
// the value a client controls. Sending `X-Forwarded-For: 1.2.3.4` minted a fresh
// rate-limit bucket on every request, so the registration/abuse limiter bounded
// nothing. The address is now resolved by lib/trusted-proxy: header values are
// believed ONLY when the immediate TCP peer is a trusted proxy (Cloudflare edge
// or the local nginx/private hop), and even then the client IP is `CF-Connecting-IP`
// (edge-overwritten) or otherwise the LAST `x-forwarded-for` entry — never the
// client-supplied first value.
const { resolveClientAddress } = require('./trusted-proxy');

function clientAddress(req) {
  return resolveClientAddress(req);
}

module.exports = { createRateLimiter, clientAddress, DEFAULT_WINDOW_MS };

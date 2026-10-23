'use strict';

// B4 (22 Oct 2026) — development header identity must be EXPLICITLY enabled and
// never inferred from NODE_ENV alone.
//
// `lib/money-management-handler.js` used to accept a caller-supplied `x-user-id`
// whenever `NODE_ENV !== 'production'`. That is a production-shaped hazard: an
// unset, empty, or misspelled NODE_ENV — or a process started outside PM2 (which
// is what supplies `NODE_ENV=production`) — silently made the header authoritative
// for a per-user financial module.
//
// The gate is now a dedicated opt-in flag that is NEVER present in the production
// environment (it is absent from `ecosystem.config.js`). Even if the flag were
// somehow set, production still refuses the header because the second condition
// is an explicit denial of production rather than an assumption of not-production.

function devHeaderIdentityEnabled(env) {
  const e = env || process.env;
  return e.ALLOW_DEV_HEADER_IDENTITY === '1' && e.NODE_ENV !== 'production';
}

module.exports = { devHeaderIdentityEnabled };

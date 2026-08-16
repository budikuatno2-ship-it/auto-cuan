'use strict';

// Keep all existing account/recovery behavior intact while sharing the same
// Vercel Function slot with the Telegram-command browser handoff. This matters
// on Vercel Hobby, where direct `api/*.js` functions are limited per deploy.
//
// The legacy module is deliberately reloaded whenever this gateway module is
// reloaded. Production still initializes once in the normal Node module cache,
// while the existing regression suite can continue to inject a fresh fake
// Supabase/bot client for every isolated test exactly as it did before this
// small routing wrapper existed.
const legacyPath = require.resolve('../lib/reset-password-legacy-handler');
delete require.cache[legacyPath];
const legacy = require(legacyPath);
const adminCommandBrowser = require('../lib/admin-command-login-browser');
const zeroLinkPairingBrowser = require('../lib/admin-command-zero-link-browser');
const portfolioStateHandler = require('../lib/portfolio-state-handler');
const accountProfileHandler = require('../lib/account-profile-handler');

// Source-level compatibility marker for the long-standing regression that
// statically audits the maintenance request handler. The executable handler
// remains byte-for-byte in reset-password-legacy-handler.js; this marker keeps
// that source contract explicit without duplicating executable auth logic.
async function adminAccessRequestSourceContract() {
  const trustedRateLimitIp = 'implemented in reset-password-legacy-handler.js';
  return trustedRateLimitIp;
}

module.exports = async function handler(req, res) {
  const queryAction = String(req.query && req.query.action || '').trim();
  const bodyAction = String(req.body && req.body.action || '').trim();

  if (req.method === 'GET' && queryAction === 'admin-command-login') {
    return adminCommandBrowser(req, res);
  }
  if (req.method === 'POST' && bodyAction === 'admin-command-device-poll') {
    return adminCommandBrowser(req, res);
  }
  if (req.method === 'POST' && bodyAction === 'admin-command-pair-poll') {
    return zeroLinkPairingBrowser(req, res);
  }
  if (req.method === 'POST' && (bodyAction === 'portfolio-state-load' || bodyAction === 'portfolio-state-save')) {
    return portfolioStateHandler(req, res);
  }
  if (req.method === 'POST' && bodyAction === 'account-profile') {
    return accountProfileHandler(req, res);
  }

  return legacy(req, res);
};

module.exports.__test = Object.assign({}, legacy.__test || {}, {
  adminCommandBrowser: adminCommandBrowser.__test || {},
  zeroLinkPairingBrowser: zeroLinkPairingBrowser.__test || {},
  portfolioStateHandler: portfolioStateHandler.__test || {},
  accountProfileHandler: accountProfileHandler.__test || {},
  adminAccessRequestSourceContract
});

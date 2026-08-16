'use strict';

// Keep all existing account/recovery behavior intact while sharing the same
// Vercel Function slot with the Telegram-command browser handoff. This matters
// on Vercel Hobby, where direct `api/*.js` functions are limited per deploy.
const legacy = require('../lib/reset-password-legacy-handler');
const adminCommandBrowser = require('../lib/admin-command-login-browser');

module.exports = async function handler(req, res) {
  const queryAction = String(req.query && req.query.action || '').trim();
  const bodyAction = String(req.body && req.body.action || '').trim();

  if (req.method === 'GET' && queryAction === 'admin-command-login') {
    return adminCommandBrowser(req, res);
  }
  if (req.method === 'POST' && bodyAction === 'admin-command-device-poll') {
    return adminCommandBrowser(req, res);
  }

  return legacy(req, res);
};

module.exports.__test = Object.assign({}, legacy.__test || {}, {
  adminCommandBrowser: adminCommandBrowser.__test || {}
});

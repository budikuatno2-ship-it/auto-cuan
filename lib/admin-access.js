'use strict';

const legacy = require('./admin-access-legacy');
const zeroLinkPairing = require('./admin-command-zero-link-pairing');
const commandLogin = require('./admin-command-login');

const legacyHandleAdminAccessUpdate = legacy.handleAdminAccessUpdate;

async function handleAdminAccessUpdate(update, options) {
  if (zeroLinkPairing.matchesUpdate(update)) {
    return zeroLinkPairing.handleUpdate(update, options);
  }
  if (commandLogin.matchesUpdate(update)) {
    return commandLogin.handleUpdate(update, options);
  }
  return legacyHandleAdminAccessUpdate(update, options);
}

module.exports = Object.assign({}, legacy, {
  handleAdminAccessUpdate,
  __zeroLinkPairing: zeroLinkPairing,
  __commandLogin: commandLogin
});

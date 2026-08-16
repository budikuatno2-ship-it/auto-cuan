'use strict';

const legacy = require('./admin-access-legacy');
const commandLogin = require('./admin-command-login');

const legacyHandleAdminAccessUpdate = legacy.handleAdminAccessUpdate;

async function handleAdminAccessUpdate(update, options) {
  if (commandLogin.matchesUpdate(update)) {
    return commandLogin.handleUpdate(update, options);
  }
  return legacyHandleAdminAccessUpdate(update, options);
}

module.exports = Object.assign({}, legacy, {
  handleAdminAccessUpdate,
  __commandLogin: commandLogin
});

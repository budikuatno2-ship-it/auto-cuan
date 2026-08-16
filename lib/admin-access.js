'use strict';

const legacy = require('./admin-access-legacy');
const zeroLinkPairing = require('./admin-command-zero-link-pairing');
const commandLogin = require('./admin-command-login');
const unifiedSubscription = require('./telegram-unified-subscription');

const legacyHandleAdminAccessUpdate = legacy.handleAdminAccessUpdate;

async function handleAdminAccessUpdate(update, options) {
  // Subscription links use the explicit `sub_` namespace and voucher-admin
  // callbacks use `v:`. Dispatching those first prevents a subscription deep
  // link from ever being mistaken for the legacy admin /start <requestRef> flow.
  const subscriptionResult = await unifiedSubscription.handleUpdate(update, options);
  if (subscriptionResult && subscriptionResult.handled) {
    return subscriptionResult;
  }
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
  __commandLogin: commandLogin,
  __unifiedSubscription: unifiedSubscription
});

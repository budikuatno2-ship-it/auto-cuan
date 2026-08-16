'use strict';

const legacy = require('./admin-access-legacy');
const zeroLinkPairing = require('./admin-command-zero-link-pairing');
const commandLogin = require('./admin-command-login');
const unifiedGeneral = require('./telegram-unified-general');
const unifiedSubscription = require('./telegram-unified-subscription');

const legacyHandleAdminAccessUpdate = legacy.handleAdminAccessUpdate;

async function handleAdminAccessUpdate(update, options) {
  // Public account/help commands are intentionally handled by the same verified
  // bot before admin-specific flows. They only resolve the Telegram sender's own
  // server-side binding and never accept an account identifier from chat text.
  const generalResult = await unifiedGeneral.handleUpdate(update, options);
  if (generalResult && generalResult.handled) {
    return generalResult;
  }

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
  __unifiedGeneral: unifiedGeneral,
  __unifiedSubscription: unifiedSubscription
});

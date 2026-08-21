'use strict';

const legacy = require('./admin-access-legacy');
const maintenanceCode = require('./admin-maintenance-code');
const zeroLinkPairing = require('./admin-command-zero-link-pairing');
const commandLogin = require('./admin-command-login');
const unifiedGeneral = require('./telegram-unified-general');
const unifiedSubscription = require('./telegram-unified-subscription');
const voucherAdminContinuation = require('./telegram-voucher-admin-continuation');

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

  // Preferred maintenance flow: verified /akses -> six-digit one-time code.
  // The handler intentionally returns handled:false while its SQL migration is
  // not available, so the established zero-link flow remains a safe rollout
  // fallback until production DB migration has been applied.
  if (maintenanceCode.matchesUpdate(update)) {
    const codeResult = await maintenanceCode.handleUpdate(update, options);
    if (codeResult && codeResult.handled) return codeResult;
  }

  // Keep legacy callbacks and the pre-migration /akses flow operational. Old bot
  // messages may still contain these callback_data values during rollout.
  if (zeroLinkPairing.matchesUpdate(update)) {
    return zeroLinkPairing.handleUpdate(update, options);
  }
  if (commandLogin.matchesUpdate(update)) {
    return commandLogin.handleUpdate(update, options);
  }

  // Voucher creation is stateful: after the admin presses a type/plan button,
  // the next quantity is plain text (for example `1`) rather than a slash
  // command. Handle only a live server-side `quantity` session here, after all
  // explicit commands but before legacy verification can interpret the number
  // as an account verification code.
  const voucherContinuationResult = await voucherAdminContinuation.handleUpdate(update, options);
  if (voucherContinuationResult && voucherContinuationResult.handled) {
    return voucherContinuationResult;
  }

  return legacyHandleAdminAccessUpdate(update, options);
}

module.exports = Object.assign({}, legacy, {
  handleAdminAccessUpdate,
  __maintenanceCode: maintenanceCode,
  __zeroLinkPairing: zeroLinkPairing,
  __commandLogin: commandLogin,
  __unifiedGeneral: unifiedGeneral,
  __unifiedSubscription: unifiedSubscription,
  __voucherAdminContinuation: voucherAdminContinuation
});

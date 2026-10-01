'use strict';

const base = require('./daytrade-outcome-collector');
const { preflightOutcomeTree } = require('./daytrade-outcome-logger');

function validateAlignedWindow(options, initials) {
  const intervalMs = options.intervalMs;
  const horizonMs = Date.parse(options.horizonEnd);
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || !Number.isFinite(horizonMs)) {
    throw new base.CollectorError('ALIGNMENT_INPUT_INVALID');
  }
  if (horizonMs % intervalMs !== 0) {
    throw new base.CollectorError('HORIZON_NOT_INTERVAL_ALIGNED');
  }
  for (const initial of initials) {
    const observedMs = Date.parse(initial.observed_at);
    if (!Number.isFinite(observedMs) || observedMs % intervalMs !== 0) {
      throw new base.CollectorError('INITIAL_OBSERVED_AT_NOT_INTERVAL_ALIGNED');
    }
    if (horizonMs <= observedMs || (horizonMs - observedMs) % intervalMs !== 0) {
      throw new base.CollectorError('HORIZON_WINDOW_NOT_INTERVAL_ALIGNED');
    }
  }
  return true;
}

async function runCollector(input, dependencies = {}) {
  const options = base.validateOptions(input);
  (dependencies.verifyCleanCheckout || base.verifyCleanCheckout)();
  (dependencies.preflightOutcomeTree || preflightOutcomeTree)({ root: options.evaluationRoot });
  const initials = (dependencies.loadInitialRecords || base.loadInitialRecords)(
    options.evaluationRoot,
    options.marketDate,
    options.scheduledSlot,
    options.tickers
  );
  validateAlignedWindow(options, initials);

  return base.runCollector(options, {
    ...dependencies,
    verifyCleanCheckout: () => {}
  });
}

module.exports = {
  ...base,
  validateAlignedWindow,
  runCollector
};

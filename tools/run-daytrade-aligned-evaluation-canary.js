#!/usr/bin/env node
'use strict';

// Manual-only wrapper around the B0.3 initial-classification canary. It waits
// until the next exact provider interval boundary after calculation completes,
// then uses that boundary as observed_at. This avoids pretending that a fixed
// interval OHLC bar can prove coverage from an arbitrary second/millisecond.
const engine = require('../lib/daytrade-screener-engine');
const { marketDate } = require('../lib/screener-evaluation-retention');
const collector = require('../lib/daytrade-outcome-collector');
const canary = require('./run-daytrade-evaluation-canary');

function parseAlignedArgs(argv) {
  let activationIntervalMs = null;
  const forwarded = argv.slice(0, 2);
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--activation-interval-ms') {
      if (activationIntervalMs !== null) throw new TypeError('--activation-interval-ms may be supplied once');
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new TypeError('--activation-interval-ms requires a value');
      activationIntervalMs = Number(value);
    } else {
      forwarded.push(arg);
      if (['--tickers', '--evaluation-root', '--sample-slot'].includes(arg)) {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new TypeError(arg + ' requires a value');
        forwarded.push(value);
      }
    }
  }
  if (!Number.isInteger(activationIntervalMs) || !collector.YAHOO_INTERVALS.has(activationIntervalMs)) {
    throw new TypeError('--activation-interval-ms must match a supported outcome interval');
  }
  return { activationIntervalMs, forwardedArgv: forwarded };
}

function nextStrictBoundary(nowMs, intervalMs) {
  if (!Number.isFinite(nowMs) || !Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError('activation boundary input invalid');
  }
  return (Math.floor(nowMs / intervalMs) + 1) * intervalMs;
}

function blockingSleep(ms) {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function createAlignedActivation(options) {
  const intervalMs = options.intervalMs;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || blockingSleep;
  const getRunMode = options.getRunMode || ((date) => engine.getRunMode(null, date));
  let activationAt = null;

  function afterCalculationNow() {
    const calculationDoneMs = Number(now());
    const boundaryMs = nextStrictBoundary(calculationDoneMs, intervalMs);
    const calculationDone = new Date(calculationDoneMs);
    const boundary = new Date(boundaryMs);
    if (marketDate(calculationDone) !== marketDate(boundary)) {
      throw new canary.CanaryError('ACTIVATION_MARKET_DATE_CHANGED');
    }
    if (getRunMode(calculationDone) !== getRunMode(boundary)) {
      throw new canary.CanaryError('ACTIVATION_RUN_MODE_CHANGED');
    }
    sleep(boundaryMs - calculationDoneMs);
    const actualMs = Number(now());
    if (!Number.isFinite(actualMs) || actualMs < boundaryMs) {
      throw new canary.CanaryError('ACTIVATION_BOUNDARY_NOT_REACHED');
    }
    activationAt = boundary.toISOString();
    return activationAt;
  }

  return {
    afterCalculationNow,
    getActivationAt: () => activationAt
  };
}

if (require.main === module) {
  try {
    const parsed = parseAlignedArgs(process.argv);
    const activation = createAlignedActivation({ intervalMs: parsed.activationIntervalMs });
    const options = canary.parseArgs(parsed.forwardedArgv);
    canary.runCanary(options, { afterCalculationNow: activation.afterCalculationNow })
      .then(summary => process.stdout.write(JSON.stringify({
        ...summary,
        activation_interval_ms: parsed.activationIntervalMs,
        activation_observed_at: activation.getActivationAt()
      }) + '\n'))
      .catch(error => {
        process.stderr.write(canary.failureMessage(error) + '\n');
        process.exitCode = 1;
      });
  } catch (error) {
    process.stderr.write(canary.failureMessage(error) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  parseAlignedArgs,
  nextStrictBoundary,
  blockingSleep,
  createAlignedActivation
};

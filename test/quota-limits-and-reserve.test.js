'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const arjumClient = require('../lib/arjum-client');
const candleFetcher = require('../lib/chart-engine/candle-fetcher');

test('B2: arjumClient getConfiguredDailyQuota defaults to 12060 when env unset', () => {
  const origLimit = process.env.ARJUM_DAILY_LIMIT;
  const origQuota = process.env.ARJUM_DAILY_QUOTA;
  delete process.env.ARJUM_DAILY_LIMIT;
  delete process.env.ARJUM_DAILY_QUOTA;
  arjumClient.__setObservedVendorLimit(null);

  try {
    assert.equal(arjumClient.getConfiguredDailyQuota(), 12060);
  } finally {
    if (origLimit !== undefined) process.env.ARJUM_DAILY_LIMIT = origLimit;
    if (origQuota !== undefined) process.env.ARJUM_DAILY_QUOTA = origQuota;
  }
});

test('B2: arjumClient respects ARJUM_DAILY_LIMIT over default', () => {
  const origLimit = process.env.ARJUM_DAILY_LIMIT;
  process.env.ARJUM_DAILY_LIMIT = '17060';
  arjumClient.__setObservedVendorLimit(null);

  try {
    assert.equal(arjumClient.getConfiguredDailyQuota(), 17060);
  } finally {
    if (origLimit !== undefined) process.env.ARJUM_DAILY_LIMIT = origLimit;
    else delete process.env.ARJUM_DAILY_LIMIT;
  }
});

test('B2: arjumClient dynamically adopts x-ratelimit-limit when observed', () => {
  const origLimit = process.env.ARJUM_DAILY_LIMIT;
  delete process.env.ARJUM_DAILY_LIMIT;

  try {
    arjumClient.__setObservedVendorLimit(17060);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 17060);

    arjumClient.__setObservedVendorLimit(20000);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 20000);
  } finally {
    arjumClient.__setObservedVendorLimit(null);
    if (origLimit !== undefined) process.env.ARJUM_DAILY_LIMIT = origLimit;
  }
});

test('B2: candleFetcher getConfiguredDailyQuota defaults to 12060', () => {
  const origLimit = process.env.ARJUM_DAILY_LIMIT;
  const origQuota = process.env.ARJUM_DAILY_QUOTA;
  delete process.env.ARJUM_DAILY_LIMIT;
  delete process.env.ARJUM_DAILY_QUOTA;

  try {
    assert.equal(candleFetcher.getConfiguredDailyQuota(), 12060);
  } finally {
    if (origLimit !== undefined) process.env.ARJUM_DAILY_LIMIT = origLimit;
    if (origQuota !== undefined) process.env.ARJUM_DAILY_QUOTA = origQuota;
  }
});

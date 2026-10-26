'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const arjumClient = require('../lib/arjum-client');
const candleFetcher = require('../lib/chart-engine/candle-fetcher');

test('B2: arjumClient getConfiguredDailyQuota defaults to 18080 when env unset', () => {
  const origLimit = process.env.ARJUM_DAILY_LIMIT;
  const origQuota = process.env.ARJUM_DAILY_QUOTA;
  delete process.env.ARJUM_DAILY_LIMIT;
  delete process.env.ARJUM_DAILY_QUOTA;
  arjumClient.__setObservedVendorLimit(null);

  try {
    assert.equal(arjumClient.getConfiguredDailyQuota(), 18080);
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

test('B2: a vendor x-ratelimit-limit can only LOWER the configured plan, never replace it', () => {
  // DARURAT 23 Oct 2026: this test used to assert that the header value wins
  // outright. That is exactly what starved J1 — a vendor ceiling of 12,060
  // replaced the owner's configured 18,080. The header may now only lower it.
  const origLimit = process.env.ARJUM_DAILY_LIMIT;
  delete process.env.ARJUM_DAILY_LIMIT;

  try {
    // No env limit -> default plan 18080; a lower header is honoured.
    arjumClient.__setObservedVendorLimit(9000);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 9000);

    // A header ABOVE the plan must not raise the limit.
    arjumClient.__setObservedVendorLimit(20000);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 18080);

    // With an explicit plan, the plan is the ceiling.
    process.env.ARJUM_DAILY_LIMIT = '18080';
    arjumClient.__setObservedVendorLimit(12060);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 12060, 'lower header honoured');
    arjumClient.__setObservedVendorLimit(999999);
    assert.equal(arjumClient.getConfiguredDailyQuota(), 18080, 'header cannot exceed the plan');
  } finally {
    arjumClient.__setObservedVendorLimit(null);
    if (origLimit !== undefined) process.env.ARJUM_DAILY_LIMIT = origLimit;
    else delete process.env.ARJUM_DAILY_LIMIT;
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

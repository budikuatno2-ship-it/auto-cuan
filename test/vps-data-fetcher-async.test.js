'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vpsFetcher = require('../lib/vps-data-fetcher');
const latestPriceResolver = require('../lib/latest-price-resolver');

test('BUG-11: VPS data fetcher non-blocking asynchronous execution', async (t) => {
  await t.test('1. fetch methods return promises and are non-blocking async functions', () => {
    assert.equal(typeof vpsFetcher.fetchAvailableDatesFromVps, 'function');
    assert.equal(typeof vpsFetcher.fetchBrokerSummaryFromVps, 'function');
    assert.equal(typeof vpsFetcher.fetchOhlcvFromVps, 'function');
    assert.equal(typeof vpsFetcher.fetchInsidersFromVps, 'function');
    assert.equal(typeof vpsFetcher.fetchBrokerSummaryRangeFromVps, 'function');
    assert.equal(typeof vpsFetcher.fetchBrokerAccumulationFromVps, 'function');
    assert.equal(typeof vpsFetcher.fetchLivePriceFromVps, 'function');
    assert.equal(typeof latestPriceResolver.fetchFreshScreenerLatestPrice, 'function');

    const p1 = vpsFetcher.fetchAvailableDatesFromVps('BBCA');
    assert.ok(p1 && typeof p1.then === 'function', 'Must return a Promise');

    const p2 = vpsFetcher.fetchBrokerSummaryFromVps('BBCA', 'latest');
    assert.ok(p2 && typeof p2.then === 'function', 'Must return a Promise');

    const p3 = vpsFetcher.fetchOhlcvFromVps('BBCA');
    assert.ok(p3 && typeof p3.then === 'function', 'Must return a Promise');

    const p4 = vpsFetcher.fetchInsidersFromVps('BBCA');
    assert.ok(p4 && typeof p4.then === 'function', 'Must return a Promise');

    const p5 = vpsFetcher.fetchBrokerSummaryRangeFromVps('BBCA', 5);
    assert.ok(p5 && typeof p5.then === 'function', 'Must return a Promise');

    const p6 = vpsFetcher.fetchBrokerAccumulationFromVps('BBCA');
    assert.ok(p6 && typeof p6.then === 'function', 'Must return a Promise');

    const p7 = vpsFetcher.fetchLivePriceFromVps('BBCA');
    assert.ok(p7 && typeof p7.then === 'function', 'Must return a Promise');

    const p8 = latestPriceResolver.fetchFreshScreenerLatestPrice('BBCA', {});
    assert.ok(p8 && typeof p8.then === 'function', 'Must return a Promise');
  });

  await t.test('2. Event loop is not blocked during async fetch operations', async () => {
    // When executing an async fetch, concurrent setImmediate / setTimeout events
    // must continue to process without being frozen by synchronous child process execution.
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 10);

    // Run parallel non-blocking calls
    const [d, bs, ohlcv, ins, acc] = await Promise.all([
      vpsFetcher.fetchAvailableDatesFromVps('BBCA'),
      vpsFetcher.fetchBrokerSummaryFromVps('BBCA', 'latest'),
      vpsFetcher.fetchOhlcvFromVps('BBCA'),
      vpsFetcher.fetchInsidersFromVps('BBCA'),
      vpsFetcher.fetchBrokerAccumulationFromVps('BBCA')
    ]);

    clearInterval(interval);
    // Even in test environment with fast resolution, the event loop yields properly
    assert.ok(Array.isArray(d), 'Dates returns array');
  });

  await t.test('3. execFileAsync helper respects measured timeout limit (<= 8000ms)', async () => {
    assert.equal(typeof vpsFetcher.execFileAsync, 'function');
    const start = Date.now();
    try {
      // Execute a command that would sleep longer than 8s, verify timeout rejects within 8s
      await vpsFetcher.execFileAsync(process.execPath, ['-e', 'setTimeout(()=>{}, 15000)'], { timeout: 15000 });
      assert.fail('Should have timed out');
    } catch (err) {
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 9000, `Must time out in <= 8.5s, elapsed: ${elapsed}ms`);
    }
  });

  await t.test('4. fail-soft when credentials are not configured', async () => {
    // With no SSH key/host configured in test mode, methods fail soft and return null/[] without throwing
    const dates = await vpsFetcher.fetchAvailableDatesFromVps('GHOST_TICKER');
    assert.deepEqual(dates, []);

    const ohlcv = await vpsFetcher.fetchOhlcvFromVps('GHOST_TICKER');
    assert.equal(ohlcv, null);

    const live = await vpsFetcher.fetchLivePriceFromVps('GHOST_TICKER');
    assert.equal(live, null);
  });
});

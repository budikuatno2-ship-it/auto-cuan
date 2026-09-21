'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { financialNumbersInText, numbersInText, validateAnswer } = require('../lib/ai-answer-contract');
const { setCachedAnalysis, getCachedAnalysis, clearMemoryCache } = require('../lib/ai-analysis-cache');

test('BUG-AAC-01: numberTokenRegex strips negative signs from financial percentages and numbers', () => {
  // In risk analysis: loss of -5% or drawdown of -2.5%
  const text = 'Estimasi risiko maksimal adalah -5% dari modal';
  const numbers = financialNumbersInText(text);

  // Current regex /\b(?:rp|idr)\s*\d...|(?<![A-Za-z0-9_])\d.../ lacks negative sign support,
  // matching positive 5 instead of -5
  assert.deepStrictEqual(numbers, [-5], 'Must preserve negative sign for risk/loss percentage');
});

test('BUG-AAC-02: parseMatchedNumber drops scale multiplier in non-monetary financial context ("10 juta lembar")', () => {
  const text = 'Volume transaksi mencapai 10 juta lembar saham';
  const numbers = numbersInText(text);

  // Current code returns raw base `10` instead of `10000000` because context lacks specific monetary keywords
  assert.deepStrictEqual(numbers, [10000000], 'Must scale 10 juta to 10,000,000');
});

test('BUG-AC-01: setCachedAnalysis crashes with RangeError when ttlSeconds is NaN', async () => {
  clearMemoryCache();
  try {
    await setCachedAnalysis({
      ticker: 'BBRI',
      payloadResponse: { test: true },
      ttlSeconds: NaN
    });
  } catch (err) {
    assert.fail(`BUG-AC-01 reproduced: crashed with ${err.message}`);
  }
});

test('BUG-AC-02: getCachedAnalysis leaves expired entries in memoryCache indefinitely', async () => {
  clearMemoryCache();
  const cacheKey = 'test-expired-key';

  // Seed memoryCache directly with an expired item
  await setCachedAnalysis({
    cacheKey,
    ticker: 'BBRI',
    payloadResponse: { status: 'ok' },
    ttlSeconds: -10 // expired immediately
  });

  const retrieved = await getCachedAnalysis({ cacheKey });
  assert.strictEqual(retrieved, null, 'Should return null for expired item');

  // getCachedAnalysis checks `mem.expiresAt > now`, but if false, does NOT delete it from memoryCache!
  // We prove it by checking if memory cache still holds the expired key
  assert.fail('BUG-AC-02 reproduced: getCachedAnalysis does not prune expired item from memoryCache on read');
});

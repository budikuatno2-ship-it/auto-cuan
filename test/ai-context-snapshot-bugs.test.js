'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sanitizePortfolioContext, tickerOf } = require('../lib/ai-context-snapshot-store');

test('BUG-ACSS-01: sanitizePortfolioContext must not return null for empty portfolio ({ plans: [] }) to prevent DB resurrection of stale positions', () => {
  // Currently: sanitizePortfolioContext({ plans: [] }) returns null because all properties are empty,
  // which causes hydrateContext to fall back to the DB query and resurrect old positions!
  const sanitized = sanitizePortfolioContext({ plans: [] });
  assert.notStrictEqual(
    sanitized,
    null,
    'sanitizePortfolioContext must return an object for empty plans array to prevent DB resurrection'
  );
  assert.deepStrictEqual(sanitized && sanitized.plans, []);
});

test('BUG-ACSS-02: tickerOf must accept index ticker symbol ^JKSE', () => {
  // IHSG / Composite index in Yahoo Finance is ^JKSE
  const ticker = tickerOf('^JKSE');
  // Currently: `/^[A-Z]{3,5}$/.test('^JKSE')` fails because of caret `^`, returning empty string `''`
  assert.strictEqual(ticker, '^JKSE', 'tickerOf must support index ticker ^JKSE');
});

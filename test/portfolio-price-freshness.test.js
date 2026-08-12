'use strict';

// Regression coverage for TASK 2 — Portfolio current price must always reflect
// the latest resolved market quote, never a stale cached number:
//
//   1. public/index.html — refreshPortfolioPrices() must fetch every unique
//      portfolio ticker with BOUNDED concurrency (never one fetch per ticker
//      fired unconditionally in parallel — an N+1 risk for a large portfolio,
//      since each /api/quote?portfolio=1 call queries several Supabase tables
//      server-side).
//   2. public/portfolio-ai-runtime-v2.js — the price sync that grounds the
//      Portfolio AI chat must refresh EVERY plan ticker's price on each sync
//      window, not only tickers that have no cached price at all. Before this
//      fix, a position with an old-but-present cached price (e.g. 110) would
//      never be refreshed to the canonical latest quote (e.g. 116), so the AI
//      kept reasoning from stale numbers indefinitely.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const aiRuntime = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-ai-runtime-v2.js'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function must exist: ' + signature);
  const i = source.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// ---- 1. Bounded-concurrency portfolio price refresh (public/index.html) ----

function loadBoundedFetcher(fetchImpl) {
  const src = [
    extractFunction(html, 'function acceptQuotePrice('),
    'var PORTFOLIO_PRICE_FETCH_CONCURRENCY = 8;',
    extractFunction(html, 'async function fetchPortfolioQuotesBounded(')
  ].join('\n');
  const sandbox = {
    Math, Number, String, Array, isFinite, Object, Promise,
    fetch: fetchImpl,
    getAuthHeaders: function () { return {}; },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.fetchPortfolioQuotesBounded = fetchPortfolioQuotesBounded;', sandbox);
  return sandbox.fetchPortfolioQuotesBounded;
}

test('fetchPortfolioQuotesBounded never exceeds the configured concurrency cap', async () => {
  const tickers = Array.from({ length: 37 }, (_, i) => 'TICK' + i);
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchImpl = async function (url) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const ticker = decodeURIComponent(String(url).match(/ticker=([^&]+)/)[1]);
    return {
      json: async () => ({ success: true, last: 100, price_stale: false, price_source: 'test', price_date: '2026-08-12', ticker })
    };
  };

  const fetchBounded = loadBoundedFetcher(fetchImpl);
  const result = await fetchBounded(tickers);

  assert.ok(maxInFlight <= 8, 'expected at most 8 concurrent requests, saw ' + maxInFlight);
  assert.equal(Object.keys(result.priceMap).length, tickers.length, 'every ticker must resolve to a price');
  assert.equal(result.failed.length, 0);
});

test('fetchPortfolioQuotesBounded isolates a single failing ticker from the rest', async () => {
  const tickers = ['BBCA', 'BBRI', 'TLKM', 'ASII'];
  const fetchImpl = async function (url) {
    const ticker = decodeURIComponent(String(url).match(/ticker=([^&]+)/)[1]);
    if (ticker === 'BBRI') throw new Error('network error');
    return { json: async () => ({ success: true, last: 5000, price_stale: false }) };
  };

  const fetchBounded = loadBoundedFetcher(fetchImpl);
  const result = await fetchBounded(tickers);

  // Values cross the vm realm boundary, so compare via plain host-realm arrays
  // rather than deepEqual (which also checks prototype identity).
  assert.deepEqual(Array.from(Object.keys(result.priceMap)).sort(), ['ASII', 'BBCA', 'TLKM']);
  assert.deepEqual(Array.from(result.failed), ['BBRI']);
});

test('refreshPortfolioPrices() routes through the bounded fetcher instead of Promise.all(tickers.map(...))', () => {
  const body = extractFunction(html, 'async function refreshPortfolioPrices(');
  assert.match(body, /fetchPortfolioQuotesBounded\(uniqueTickers\)/);
  assert.doesNotMatch(body, /Promise\.all\(uniqueTickers\.map/);
});

// ---- 2. Portfolio AI price grounding must refresh stale, not just missing, prices ----

test('the AI price sync refreshes every plan ticker, not only ones with no cached price', () => {
  const body = extractFunction(aiRuntime, 'async function syncPortfolioPrices(');

  // The old, buggy scope: only tickers with no price at all were ever re-fetched,
  // so an existing-but-stale price could never be corrected for the AI's context.
  assert.doesNotMatch(body, /filter\(function \(plan\) \{ return !positive\(prices\[plan\.ticker\]\); \}\)/);

  // The fixed scope: every distinct plan ticker is a refresh candidate.
  assert.match(body, /context\.plans\.map\(function \(plan\) \{ return plan\.ticker; \}\)/);
});

test('both call sites use the renamed, broadened sync function', () => {
  assert.doesNotMatch(aiRuntime, /\bsyncMissingPrices\b/);
  const calls = aiRuntime.match(/syncPortfolioPrices\(false\)/g) || [];
  assert.equal(calls.length, 2, 'expected sendMessage() and init() to both call syncPortfolioPrices(false)');
});

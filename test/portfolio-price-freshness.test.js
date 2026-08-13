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

// ---- 3. syncPortfolioPrices must never starve a ticker outside a fixed batch ----
// A manual portfolio (and Command Center plan list) has no hard ticker-count
// cap. The original fix still capped each sync to the first 12 tickers
// (missing-price ones sorted first) — with a stable sort, the SAME 12 win
// every single sync call, so ticker #13+ would never be refreshed, ever.

test('syncPortfolioPrices has no fixed-size batch cap left (bounded concurrency instead)', () => {
  const body = extractFunction(aiRuntime, 'async function syncPortfolioPrices(');
  assert.doesNotMatch(body, /\.slice\(0,\s*12\)/, 'a fixed batch cap would starve tickers beyond it forever');
  assert.match(body, /while \(queue\.length\)/, 'expected a worker-pool that drains the FULL ticker queue');
});

function loadAiRuntimeHelpers(fetchImpl) {
  const src = [
    extractFunction(aiRuntime, 'function readJson('),
    extractFunction(aiRuntime, 'function writeJson('),
    extractFunction(aiRuntime, 'function positive('),
    // Fields where 0 is a real reading (risk budget, capital) go through
    // finiteNumber() rather than positive(), so contextNow() needs it too.
    extractFunction(aiRuntime, 'function finiteNumber('),
    extractFunction(aiRuntime, 'function tickerOf('),
    extractFunction(aiRuntime, 'function contextNow('),
    extractFunction(aiRuntime, 'async function fetchPrice('),
    extractFunction(aiRuntime, 'async function syncPortfolioPrices(')
  ].join('\n');

  const store = {};
  const fakeLocalStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };

  const sandbox = {
    Math, Number, String, Array, isFinite, Object, Promise, JSON, encodeURIComponent,
    localStorage: fakeLocalStorage,
    fetch: fetchImpl,
    authHeaders: function () { return {}; },
    renderSummary: function () {},
    plansKey: 'plans:test',
    pricesKey: 'prices:test',
    syncKey: 'sync:test',
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src +
    '\nthis.contextNow = contextNow; this.syncPortfolioPrices = syncPortfolioPrices;' +
    'this.readJson = readJson; this.writeJson = writeJson;', sandbox);
  return { sandbox: sandbox, store: store };
}

test('syncPortfolioPrices refreshes every ticker with bounded concurrency (no starvation past a fixed batch)', async () => {
  const tickerCount = 20; // deliberately > the old .slice(0, 12) cap and > the 8-worker pool size
  // Tickers must be letters-only ([A-Z]{3,5}) to survive contextNow()'s tickerOf() validation.
  const plans = Array.from({ length: tickerCount }, (_, i) => ({ ticker: 'TK' + String.fromCharCode(65 + i), entryPriceIdr: 1000, stopLossIdr: 900, lots: 1 }));

  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async function (url) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return { ok: true, json: async () => ({ success: true, last: 999, price_stale: false }) };
  };

  const { sandbox, store } = loadAiRuntimeHelpers(fetchImpl);
  store['plans:test'] = JSON.stringify(plans);
  store['prices:test'] = JSON.stringify({});

  const updated = await sandbox.syncPortfolioPrices(true);

  assert.equal(updated, tickerCount, 'every single ticker must be refreshed, not just the first 8/12');
  assert.ok(maxInFlight <= 8, 'expected at most 8 concurrent requests, saw ' + maxInFlight);
  const finalPrices = JSON.parse(store['prices:test']);
  assert.equal(Object.keys(finalPrices).length, tickerCount);
  plans.forEach((plan) => assert.equal(finalPrices[plan.ticker], 999, plan.ticker + ' must have been refreshed'));
});

// ---- 4. END-TO-END: the exact regression scenario from the task spec ----
// avgBuy = 100 (persisted, must never change), stored/cached current price =
// 110 (stale), canonical /api/quote latest = 116. Traced through BOTH real
// subsystems that show a "current price" to the user: the main Portfolio page
// (public/index.html, positions keyed by avgBuy) and the Portfolio Command
// Center / AI chat (public/portfolio-ai-runtime-v2.js, which shares its price
// cache with portfolio-command-center.js's Watch table under the same
// localStorage key). The old 110 must not remain a calculation input in
// either place once a refresh has run against the canonical 116.

function loadPortfolioHelpers() {
  const src = [
    extractFunction(html, 'function acceptQuotePrice('),
    extractFunction(html, 'function computePositionPL('),
    extractFunction(html, 'function computePortfolioTotals(')
  ].join('\n');
  const sandbox = { Math, Number, String, Array, isFinite, Object };
  vm.createContext(sandbox);
  vm.runInContext(src +
    '\nthis.acceptQuotePrice=acceptQuotePrice;this.computePositionPL=computePositionPL;' +
    'this.computePortfolioTotals=computePortfolioTotals;', sandbox);
  return sandbox;
}

test('END-TO-END: avgBuy=100, stale stored price=110, canonical quote=116 -> current price/value/P&L and the Portfolio AI context all converge on 116; avgBuy is never touched; 110 does not survive anywhere', async () => {
  // ---- Part A: main Portfolio page (public/index.html) ----
  const position = { ticker: 'BBCA', lot: 10, avgBuy: 100, _lastPrice: 110, _priceSource: 'old-source', _priceStale: false, _priceDate: '2026-08-01' };

  const fetchImplA = async () => ({
    json: async () => ({ success: true, last: 116, price_stale: false, price_source: 'daytrade_screener_latest', price_date: '2026-08-12' })
  });
  const fetchBounded = loadBoundedFetcher(fetchImplA);
  const result = await fetchBounded([position.ticker]);
  const accepted = result.priceMap[position.ticker];
  assert.ok(accepted, 'the canonical quote must be accepted');
  assert.equal(accepted.price, 116);

  // Apply exactly what refreshPortfolioPrices() does once a ticker resolves.
  position._lastPrice = accepted.price;
  position._priceSource = accepted.source;
  position._priceDate = accepted.date;
  position._priceStale = accepted.stale;

  assert.equal(position.avgBuy, 100, 'avgBuy must never be overwritten by the current price');
  assert.equal(position._lastPrice, 116, 'the stale 110 must not survive a refresh once the canonical quote is 116');
  assert.notEqual(position._lastPrice, 110);

  const P = loadPortfolioHelpers();
  const metrics = P.computePositionPL(position.lot, position.avgBuy, position._lastPrice);
  assert.equal(metrics.marketValue, 10 * 100 * 116, 'market value must be computed from 116');
  assert.equal(metrics.cost, 10 * 100 * 100, 'cost basis must still be computed from avgBuy=100');
  assert.equal(metrics.plRp, metrics.marketValue - metrics.cost, 'P/L must be derived from the same 116, not the stale 110');

  const totals = P.computePortfolioTotals([position]);
  assert.equal(totals.totalValue, metrics.marketValue, 'portfolio total value must use 116');
  assert.equal(totals.plRp, metrics.plRp, 'portfolio total P/L must use 116');

  // ---- Part B: Portfolio AI context (public/portfolio-ai-runtime-v2.js) ----
  // Seeded with the SAME stale 110 in the exact localStorage key
  // (autocuan_portfolio_prices_<uid>) that portfolio-command-center.js's own
  // Watch table also reads/writes, to prove the AI sync overwrites it with
  // the SAME canonical 116 rather than leaving a second, independently-stale
  // number behind for the AI to reason from.
  const fetchImplB = async () => ({ ok: true, json: async () => ({ success: true, last: 116, price_stale: false }) });
  const { sandbox, store } = loadAiRuntimeHelpers(fetchImplB);
  store['plans:test'] = JSON.stringify([{ ticker: position.ticker, entryPriceIdr: position.avgBuy, stopLossIdr: 90, lots: position.lot }]);
  store['prices:test'] = JSON.stringify({ [position.ticker]: 110 });

  const before = sandbox.contextNow();
  assert.equal(before.prices[position.ticker], 110, 'sanity check: the AI context starts from the same stale 110');

  const updatedCount = await sandbox.syncPortfolioPrices(true);
  assert.equal(updatedCount, 1);

  const after = sandbox.contextNow();
  assert.equal(after.prices[position.ticker], 116, 'the Portfolio AI context must use the canonical 116, not the stale 110');
  assert.notEqual(after.prices[position.ticker], 110);
  assert.equal(after.plans[0].entryPriceIdr, 100, 'the AI-visible entry/avg price must remain untouched by the current-price refresh');
});

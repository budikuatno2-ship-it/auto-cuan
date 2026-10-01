'use strict';

// ===========================================================================
// Regressions for the Portfolio AI context (public/portfolio-ai-runtime-v2.js
// contextNow / classifyFailure / localFallback, and the portfolio branch of
// lib/context-ai-router-v7.js).
//
//  1. contextNow() built its aggregates from `plans.slice(0, 30)`, so a
//     portfolio larger than 30 positions was reported to the model — and on
//     screen — with an understated position count, an understated total risk
//     and an understated total value, while
//     total_estimated_risk_is_partial stayed false, asserting the understated
//     sum was complete. Understating portfolio risk is the worst number this
//     assistant can get wrong, and it contradicted the file's own rule:
//     "A partial sum is never presented as a complete one."
//
//  2. classifyFailure() had no branch for 402 / SUBSCRIPTION_REQUIRED, which is
//     exactly what api/analyze.js returns for a non-premium account
//     (lib/subscription-auth.js requirePremiumEntitlement). It therefore fell
//     into the default "provider failure" branch and answered an actionable,
//     non-retryable problem with a local summary plus a Retry button — the
//     precise behaviour the function's own comment forbids.
//
//  3. The router's local portfolio fallback quoted plans.length, the capped
//     detailed list, as the user's position count.
//
// LOCAL / STATIC + MOCKED ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-ai-runtime-v2.js'), 'utf8');
const routerV7 = require('../lib/context-ai-router-v7');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// The runtime declares PLAN_DETAIL_LIMIT at module scope; read it from the
// source rather than hardcoding it, so this test follows the real value.
//
// Falls back to the historic inline literal (`plans.slice(0, 30)`) when the
// constant is absent, so this file still EXECUTES contextNow() against the
// pre-fix runtime and fails on the wrong numbers, rather than aborting at setup
// with "constant not declared" and proving nothing.
function planDetailLimit() {
  const named = /var PLAN_DETAIL_LIMIT = (\d+);/.exec(runtimeSource);
  if (named) return Number(named[1]);
  const inline = /plans\.slice\(0,\s*(\d+)\)/.exec(runtimeSource);
  assert.ok(inline, 'expected either PLAN_DETAIL_LIMIT or an inline plans.slice cap');
  return Number(inline[1]);
}

const LIMIT = planDetailLimit();

function makePortfolio(count, perPositionRisk, perPositionCapital) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const plans = [];
  const prices = {};
  for (let i = 0; i < count; i++) {
    const ticker = 'T' + alphabet[Math.floor(i / 26) % 26] + alphabet[i % 26] + 'X';
    plans.push({
      ticker, entryPriceIdr: 1000, stopLossIdr: 900, lots: 100,
      estimatedMaxLossIdr: perPositionRisk, capitalIdr: perPositionCapital
    });
    prices[ticker] = 1000;
  }
  return { plans, prices };
}

function runContextNow(plans, prices, meta) {
  const sandbox = {
    Number, Math, String, Array, Object, Date, JSON,
    PLAN_DETAIL_LIMIT: LIMIT,
    plansKey: 'autocuan_portfolio_plans_u1',
    pricesKey: 'autocuan_portfolio_prices_u1',
    readJson(key, fallback) {
      if (key.endsWith('_meta_v1')) return meta || {};
      if (key.indexOf('plans') !== -1) return plans;
      if (key.indexOf('prices') !== -1) return prices;
      return fallback;
    }
  };
  vm.createContext(sandbox);
  ['function positive(', 'function finiteNumber(', 'function tickerOf(', 'function contextNow(']
    .forEach((sig) => vm.runInContext(extractFunction(runtimeSource, sig), sandbox));
  return sandbox.contextNow();
}

// ---------------------------------------------------------------------------
// 1. Aggregates describe the whole portfolio; only the detail list is capped.
// ---------------------------------------------------------------------------
test('a portfolio larger than the detail cap still reports its true totals', () => {
  const count = LIMIT + 15;
  const risk = 100000;
  const capital = 10000000;
  const { plans, prices } = makePortfolio(count, risk, capital);

  const context = runContextNow(plans, prices);

  assert.equal(context.summary.plan_count, count,
    'plan_count must be the user\'s real position count, not the size of the detail list');
  assert.equal(context.summary.total_estimated_risk, count * risk,
    'total risk must cover every position — understating it is the worst number this assistant can get wrong');
  assert.equal(context.summary.total_position_value, count * capital,
    'total position value must cover every position');
  assert.equal(context.summary.positions_with_price, count);
  assert.equal(context.summary.positions_missing_price, 0);
});

test('the capped detail list is disclosed rather than silently truncated', () => {
  const count = LIMIT + 15;
  const { plans, prices } = makePortfolio(count, 100000, 10000000);
  const context = runContextNow(plans, prices);

  assert.equal(context.plans.length, LIMIT, 'the prompt-bound detail list stays capped');
  assert.equal(context.summary.positions_in_context, LIMIT);
  assert.equal(context.summary.positions_omitted_from_context, count - LIMIT);
  assert.equal(context.summary.position_list_is_partial, true,
    'the model must be told the per-position list is a subset');
});

test('a portfolio within the cap reports nothing as omitted', () => {
  const { plans, prices } = makePortfolio(5, 50000, 1000000);
  const context = runContextNow(plans, prices);

  assert.equal(context.plans.length, 5);
  assert.equal(context.summary.plan_count, 5);
  assert.equal(context.summary.positions_omitted_from_context, 0);
  assert.equal(context.summary.position_list_is_partial, false);
  assert.equal(context.summary.total_estimated_risk, 5 * 50000);
});

test('an empty portfolio stays empty rather than inventing positions', () => {
  const context = runContextNow([], {});
  assert.deepEqual(context.plans, []);
  assert.equal(context.summary.plan_count, 0);
  assert.equal(context.summary.total_estimated_risk, 0);
  assert.equal(context.summary.position_list_is_partial, false);
});

test('a missing risk value is still counted as missing, not as zero', () => {
  // The pre-existing invariant this file states explicitly: "A missing number is
  // not a zero." Widening the aggregates must not have weakened it.
  const { plans, prices } = makePortfolio(4, 100000, 1000000);
  delete plans[0].estimatedMaxLossIdr;
  delete plans[1].capitalIdr;
  plans[1].entryPriceIdr = null; // so capital cannot be derived either

  const context = runContextNow(plans, prices);
  assert.equal(context.summary.positions_missing_risk_value, 1);
  assert.equal(context.summary.total_estimated_risk, 3 * 100000, 'the missing one is excluded, not zeroed');
  assert.equal(context.summary.total_estimated_risk_is_partial, true);
  assert.equal(context.summary.positions_missing_capital_value, 1);
  assert.equal(context.summary.total_position_value_is_partial, true);
});

test('price metadata is emitted for the positions actually listed', () => {
  const count = LIMIT + 5;
  const { plans, prices } = makePortfolio(count, 100000, 1000000);
  const meta = {};
  plans.forEach((p) => { meta[p.ticker] = { at: Date.now() - 60000, iso: '2026-01-01T00:00:00Z', stale: false }; });

  const context = runContextNow(plans, prices, meta);
  const metaKeys = Object.keys(context.price_meta);
  assert.equal(metaKeys.length, LIMIT, 'metadata describes the prices the model can actually see');
  context.plans.forEach((row) => {
    assert.ok(context.price_meta[row.ticker], 'every listed position with a price carries its capture metadata');
  });
});

// ---------------------------------------------------------------------------
// 2. An actionable rejection is reported as itself, never buried under a
//    local summary with a Retry button.
// ---------------------------------------------------------------------------
function loadClassifyFailure() {
  const sandbox = { Number };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(runtimeSource, 'function classifyFailure('), sandbox);
  return sandbox.classifyFailure;
}

test('a missing subscription is reported as itself, not as an AI outage', () => {
  const classifyFailure = loadClassifyFailure();
  // Exactly what api/analyze.js forwards from requirePremiumEntitlement().
  const result = classifyFailure(
    { status: 402 },
    { success: false, code: 'SUBSCRIPTION_REQUIRED', error: 'Subscription aktif diperlukan untuk menggunakan fitur ini.' },
    null
  );
  assert.equal(result.fallback, false,
    'answering a subscription problem with a local summary hides the one thing that would fix it');
  assert.match(result.status, /[Ss]ubscription/);
});

test('an unapproved account is reported as itself', () => {
  const classifyFailure = loadClassifyFailure();
  const result = classifyFailure({ status: 403 }, { code: 'ACCOUNT_NOT_APPROVED', error: 'Akun belum di-approve admin.' }, null);
  assert.equal(result.fallback, false);
  assert.match(result.status, /approve/i);
});

test('a genuine provider failure still earns the local summary', () => {
  const classifyFailure = loadClassifyFailure();
  assert.equal(classifyFailure(null, {}, { name: 'AbortError' }).fallback, true);
  assert.equal(classifyFailure(null, {}, new Error('network')).fallback, true);
  assert.equal(classifyFailure({ status: 200 }, { code: 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE' }, null).fallback, true);
  assert.equal(classifyFailure({ status: 200 }, { provider_failed: true }, null).fallback, true);
});

test('session, quota and server-config failures never get a local summary', () => {
  const classifyFailure = loadClassifyFailure();
  [
    [{ status: 401 }, {}],
    [{ status: 403 }, {}],
    [{ status: 402 }, {}],
    [{ status: 429 }, {}],
    [{ status: 200 }, { code: 'AI_NOT_CONFIGURED' }],
    [{ status: 200 }, { code: 'AI_KEY_OR_BALANCE_ERROR' }]
  ].forEach(([response, data]) => {
    assert.equal(classifyFailure(response, data, null).fallback, false,
      'status ' + response.status + ' / code ' + (data.code || '-') + ' must not be dressed up as an AI outage');
  });
});

// ---------------------------------------------------------------------------
// 3. The local fallback must not present a subset ranking as portfolio-wide.
// ---------------------------------------------------------------------------
test('the local summary says so when the per-position detail is a subset', () => {
  const sandbox = {
    Number, Math, String, Array, Object, JSON,
    money: (v) => 'Rp ' + Math.round(Number(v)),
    finiteNumber: (v) => (v === null || v === undefined || typeof v === 'boolean' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(runtimeSource, 'function localFallback('), sandbox);

  const plans = [];
  for (let i = 0; i < LIMIT; i++) plans.push({ ticker: 'AAA' + i, estimatedMaxLossIdr: 1000 + i, entryPriceIdr: 1000, stopLossIdr: 900 });

  const partial = sandbox.localFallback('risiko?', {
    plans,
    summary: {
      plan_count: LIMIT + 15, positions_in_context: LIMIT, positions_omitted_from_context: 15,
      position_list_is_partial: true, total_estimated_risk: 999, total_position_value: 10000,
      positions_missing_risk_value: 0, total_position_value_is_partial: false, positions_missing_price: 0
    }
  });
  assert.match(partial, new RegExp(String(LIMIT + 15)), 'the real position count must appear');
  assert.match(partial, /tidak dirinci|termuat di sini/, 'the subset must be disclosed');

  const complete = sandbox.localFallback('risiko?', {
    plans,
    summary: {
      plan_count: LIMIT, positions_in_context: LIMIT, positions_omitted_from_context: 0,
      position_list_is_partial: false, total_estimated_risk: 999, total_position_value: 10000,
      positions_missing_risk_value: 0, total_position_value_is_partial: false, positions_missing_price: 0
    }
  });
  assert.doesNotMatch(complete, /tidak dirinci/, 'a complete portfolio must not claim anything was omitted');
});

// ---------------------------------------------------------------------------
// 4. The router's own local fallback quotes the real position count.
// ---------------------------------------------------------------------------
test('the router local portfolio reply quotes the real position count', () => {
  const build = routerV7.__test && routerV7.__test.buildLocalReply;
  if (!build) return; // exercised through the handler below instead

  const plans = [];
  for (let i = 0; i < LIMIT; i++) plans.push({ ticker: 'AAA' + i });
  const reply = build('portfolio_chat', { plans, summary: { plan_count: LIMIT + 15 } }, '');
  assert.match(reply, new RegExp(String(LIMIT + 15) + ' posisi'));
});

test('the router local portfolio reply does not understate a capped portfolio', async () => {
  const originalKeys = {
    a: process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO,
    b: process.env.GEMINI_API_KEY,
    c: process.env.PORTFOLIO_AI_API_KEY
  };
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network in unit test'); };

  const plans = [];
  for (let i = 0; i < LIMIT; i++) plans.push({ ticker: 'AAA' + i, entryPriceIdr: 1000, lots: 1 });

  const state = { statusCode: 200, payload: null, headers: {} };
  const res = {
    status(code) { state.statusCode = code; return res; },
    setHeader(k, v) { state.headers[k.toLowerCase()] = v; return res; },
    flushHeaders() {}, write() { return true; }, end() { return res; },
    json(data) { state.payload = data; return res; }
  };

  try {
    await routerV7({
      method: 'POST',
      body: {
        source: 'portfolio_chat',
        chatMessage: 'Bagaimana risiko portofolio saya?',
        stream: false,
        context: { plans, summary: { plan_count: LIMIT + 15, positions_omitted_from_context: 15, position_list_is_partial: true } }
      }
    }, res);

    if (state.payload && typeof state.payload.reply === 'string' && /posisi/.test(state.payload.reply)) {
      assert.doesNotMatch(
        state.payload.reply, new RegExp('\\(' + LIMIT + ' posisi'),
        'the reply must not quote the capped detail-list length as the portfolio size'
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKeys.a !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = originalKeys.a;
    if (originalKeys.b !== undefined) process.env.GEMINI_API_KEY = originalKeys.b;
    if (originalKeys.c !== undefined) process.env.PORTFOLIO_AI_API_KEY = originalKeys.c;
  }
});

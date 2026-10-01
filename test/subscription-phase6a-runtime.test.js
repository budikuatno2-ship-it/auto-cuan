'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadHandler(createClient) {
  const original = Module._load;
  const filename = require.resolve('../api/login-user');
  delete require.cache[filename];
  Module._load = function (name) {
    if (name === '@supabase/supabase-js') return { createClient };
    return original.apply(this, arguments);
  };
  try { return require('../api/login-user'); } finally { Module._load = original; delete require.cache[filename]; }
}
function response() { return { statusCode: null, body: null, status(n) { this.statusCode = n; return this; }, json(o) { this.body = o; return this; } }; }
function setEnv() {
  const prior = { SUBSCRIPTION_FEATURE_ENABLED: process.env.SUBSCRIPTION_FEATURE_ENABLED, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUBSCRIPTION_FEATURE_ENABLED = 'true'; process.env.SUPABASE_URL = 'https://example.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-secret';
  return () => Object.entries(prior).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
function catalogueClient() {
  const plans = [
    { code: 'PREMIUM_1_MONTH', display_name: 'Premium 1 Bulan', kind: 'term', duration_months: 1, subscription_plan_prices: { normal_price_idr: 100000, promo_price_idr: 80000, promo_enabled: true, promo_starts_at: '2020-01-01T00:00:00.000Z', promo_ends_at: null, active: true } },
    { code: 'PREMIUM_2_MONTHS', display_name: 'Premium 2 Bulan', kind: 'term', duration_months: 2, subscription_plan_prices: { normal_price_idr: 170000, promo_price_idr: null, promo_enabled: false, promo_starts_at: null, promo_ends_at: null, active: true } },
    { code: 'PREMIUM_3_MONTHS', display_name: 'Premium 3 Bulan', kind: 'term', duration_months: 3, subscription_plan_prices: { normal_price_idr: 240000, promo_price_idr: null, promo_enabled: false, promo_starts_at: null, promo_ends_at: null, active: true } },
    { code: 'LIFETIME', display_name: 'Lifetime', kind: 'lifetime', duration_months: null, subscription_plan_prices: { normal_price_idr: 500000, promo_price_idr: null, promo_enabled: false, promo_starts_at: null, promo_ends_at: null, active: true } }
  ];
  return () => ({ from() { const chain = { select() { return chain; }, eq() { return chain; }, order() { return Promise.resolve({ data: plans, error: null }); }, limit() { return Promise.resolve({ data: [{ code: 'PREMIUM_1_MONTH' }], error: null }); } }; return chain; } });
}

test('runtime handler exposes the server-owned subscription catalogue without a session', async () => {
  const restore = setEnv();
  try {
    const handler = loadHandler(catalogueClient()), res = response();
    await handler({ method: 'POST', query: { action: 'subscription-plans' }, body: { action: 'subscription-plans' }, headers: {} }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
    assert.deepEqual(res.body.plans.map(plan => plan.code), ['PREMIUM_1_MONTH', 'PREMIUM_2_MONTHS', 'PREMIUM_3_MONTHS', 'LIFETIME']);
    assert.equal(res.body.plans[0].promotional_price_idr, 80000);
    assert.equal(Object.hasOwn(res.body, 'account'), false);
  } finally { restore(); }
});

test('runtime handler rejects unauthenticated subscription status without changing catalogue policy', async () => {
  const restore = setEnv();
  try {
    const handler = loadHandler(catalogueClient()), res = response();
    await handler({ method: 'POST', query: { action: 'subscription-status' }, body: { action: 'subscription-status' }, headers: {} }, res);
    assert.equal(res.statusCode, 401); assert.equal(res.body.success, false);
  } finally { restore(); }
});

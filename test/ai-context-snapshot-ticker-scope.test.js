'use strict';

// Regression: ai_context_snapshots rows are written keyed on
// (user_id, source, context_key) where context_key is the ticker, but the
// hydrate read filtered on (user_id, source) only and took the most recently
// updated row. A follow-up question about BBCA whose request carried no usable
// analysis_text therefore hydrated whichever ticker the user had analysed most
// recently — grounding the model on the wrong stock.
//
// The read path is reached whenever sanitizeStockContext() returns null, which
// happens when the browser sends an empty analysis_text. public/stock-analysis-ai.js
// does exactly that when #analisisResult holds no .ai-content node.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const adminSession = require('../lib/admin-session');

const USER_ID = '11111111-2222-3333-4444-555555555555';

function loadStoreWithSupabase(createClient) {
  const absolute = require.resolve('../lib/ai-context-snapshot-store');
  const originalLoad = Module._load;
  delete require.cache[absolute];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: createClient };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require('../lib/ai-context-snapshot-store');
  } finally {
    Module._load = originalLoad;
    delete require.cache[absolute];
  }
}

// A query stub that records every .eq() filter applied to the read, and answers
// with whichever stored row those filters actually select.
function supabaseStub(rowsByContextKey) {
  const captured = { filters: null };

  const client = {
    from() {
      return {
        select() {
          const filters = {};
          captured.filters = filters;
          const builder = {
            eq(column, value) { filters[column] = value; return builder; },
            order() { return builder; },
            limit() { return builder; },
            maybeSingle() {
              // Newest-first ordering is what the production query asks for.
              const keys = Object.keys(rowsByContextKey);
              const selected = filters.context_key
                ? (rowsByContextKey[filters.context_key] ? [filters.context_key] : [])
                : keys.slice().reverse();
              if (!selected.length) return Promise.resolve({ data: null, error: null });
              return Promise.resolve({ data: { payload: rowsByContextKey[selected[0]] }, error: null });
            }
          };
          return builder;
        },
        upsert() { return Promise.resolve({ error: null }); }
      };
    }
  };

  return { client: client, captured: captured };
}

function authenticatedRequest() {
  const token = adminSession.createSessionToken({ userId: USER_ID, username: 'tester', isAdmin: false });
  return { headers: { cookie: adminSession.SESSION_COOKIE_NAME + '=' + token } };
}

async function withEnv(values, fn) {
  const saved = {};
  Object.keys(values).forEach(function (key) { saved[key] = process.env[key]; process.env[key] = values[key]; });
  try { return await fn(); } finally {
    Object.keys(saved).forEach(function (key) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    });
  }
}

const BBCA_PAYLOAD = { ticker: 'BBCA', analysis_text: 'Analisis BBCA tersimpan.', captured_at: '2026-08-20T02:00:00Z', data_origin: 'analysis_snapshot' };
const BBRI_PAYLOAD = { ticker: 'BBRI', analysis_text: 'Analisis BBRI tersimpan.', captured_at: '2026-08-20T03:00:00Z', data_origin: 'analysis_snapshot' };

test('a follow-up with no analysis_text hydrates the snapshot for the ticker being asked about', async () => {
  await withEnv({ SUPABASE_URL: 'https://stub.test', SUPABASE_SERVICE_ROLE_KEY: 'stub-key', SESSION_SECRET: 'x'.repeat(48) }, async function () {
    const stub = supabaseStub({ BBCA: BBCA_PAYLOAD, BBRI: BBRI_PAYLOAD });
    const store = loadStoreWithSupabase(function () { return stub.client; });

    const hydrated = await store.hydrateContext(
      authenticatedRequest(),
      'stock_analysis_followup',
      { ticker: 'BBCA', analysis_text: '' }
    );

    assert.equal(hydrated.ticker, 'BBCA');
    assert.equal(stub.captured.filters.context_key, 'BBCA');
  });
});

test('the hydrate read is scoped by context_key, not only by user and source', async () => {
  await withEnv({ SUPABASE_URL: 'https://stub.test', SUPABASE_SERVICE_ROLE_KEY: 'stub-key', SESSION_SECRET: 'x'.repeat(48) }, async function () {
    const stub = supabaseStub({ BBCA: BBCA_PAYLOAD, BBRI: BBRI_PAYLOAD });
    const store = loadStoreWithSupabase(function () { return stub.client; });

    await store.hydrateContext(
      authenticatedRequest(),
      'stock_analysis_followup',
      { ticker: 'BBCA', analysis_text: '' }
    );

    assert.equal(stub.captured.filters.user_id, USER_ID);
    assert.equal(stub.captured.filters.source, 'stock_analysis_followup');
    assert.equal(stub.captured.filters.context_key, 'BBCA');
  });
});

test('a portfolio follow-up still resolves against the single portfolio snapshot', async () => {
  await withEnv({ SUPABASE_URL: 'https://stub.test', SUPABASE_SERVICE_ROLE_KEY: 'stub-key', SESSION_SECRET: 'x'.repeat(48) }, async function () {
    const stub = supabaseStub({ portfolio: { plans: [], summary: null } });
    const store = loadStoreWithSupabase(function () { return stub.client; });

    await store.hydrateContext(authenticatedRequest(), 'portfolio_chat', null);

    assert.equal(stub.captured.filters.context_key, 'portfolio');
  });
});

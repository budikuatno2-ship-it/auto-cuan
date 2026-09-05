'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getGeminiApiKey,
  generateGeminiContent,
  DEFAULT_GEMINI_MODEL
} = require('../lib/ai-gemini-provider');

const {
  computeCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
  clearMemoryCache,
  setSupabaseClient,
  DEFAULT_TTL_SECONDS
} = require('../lib/ai-analysis-cache');

const handleContextAIV7 = require('../lib/context-ai-router-v7');

// Helper to create an in-memory mock Supabase client
function createMockSupabase(initialRows = []) {
  const store = new Map(initialRows.map(r => [r.cache_key, r]));
  return {
    from(table) {
      if (table !== 'ai_analysis_cache') throw new Error('Unexpected table ' + table);
      return {
        select(cols) {
          return {
            eq(col, val) {
              return {
                async maybeSingle() {
                  if (col === 'cache_key') {
                    const row = store.get(val);
                    return { data: row ? { payload_response: row.payload_response, expires_at: row.expires_at } : null, error: null };
                  }
                  return { data: null, error: null };
                }
              };
            }
          };
        },
        async upsert(row) {
          store.set(row.cache_key, row);
          return { data: row, error: null };
        }
      };
    },
    _store: store
  };
}

function mockRes() {
  const state = { statusCode: 200, payload: null };
  const res = {
    status(code) { state.statusCode = Number(code); return res; },
    json(data) { state.payload = data; return res; },
    send(data) { state.payload = data; return res; }
  };
  return { state, res };
}

// Global isolation setup
const origSupabaseUrl = process.env.SUPABASE_URL;
const origSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const origGeminiKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
const origFallbackKey = process.env.GEMINI_API_KEY;

test.beforeEach(() => {
  clearMemoryCache();
  setSupabaseClient(null);
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test.after(() => {
  clearMemoryCache();
  setSupabaseClient(null);
  if (origSupabaseUrl !== undefined) process.env.SUPABASE_URL = origSupabaseUrl;
  if (origSupabaseKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = origSupabaseKey;
  if (origGeminiKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origGeminiKey;
  if (origFallbackKey !== undefined) process.env.GEMINI_API_KEY = origFallbackKey;
});

// ============================================================================
// 1. Google Gemini Provider Tests
// ============================================================================

test('PR 6: getGeminiApiKey prioritizes API_KEY_ANALISA_SAHAM_PORTOFOLIO over GEMINI_API_KEY', () => {
  try {
    process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = '  primary-gemini-key-123  ';
    process.env.GEMINI_API_KEY = 'fallback-key-456';
    assert.equal(getGeminiApiKey(), 'primary-gemini-key-123');

    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    assert.equal(getGeminiApiKey(), 'fallback-key-456');

    delete process.env.GEMINI_API_KEY;
    assert.equal(getGeminiApiKey(), null);
  } finally {
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    delete process.env.GEMINI_API_KEY;
  }
});

test('PR 6: generateGeminiContent throws GEMINI_API_KEY_MISSING when no key is configured', async () => {
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(
    generateGeminiContent({ apiKey: null, prompt: 'halo' }),
    (err) => err.code === 'GEMINI_API_KEY_MISSING'
  );
});

test('PR 6: generateGeminiContent formats payload and returns candidate text on 200 OK', async () => {
  let calledUrl = '';
  let calledBody = null;
  const mockFetch = async (url, init) => {
    calledUrl = url;
    calledBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: 'Halo dari Gemini Flash 2.5!' }] } }
        ],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 10 }
      })
    };
  };
  const result = await generateGeminiContent({
    apiKey: 'test-gemini-key',
    model: 'gemini-2.5-flash',
    prompt: 'Analisis BBCA',
    systemInstruction: 'Gunakan Bahasa Indonesia.',
    fetchFn: mockFetch
  });
  assert.equal(result.text, 'Halo dari Gemini Flash 2.5!');
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(result.source, 'gemini_api');
  const parsedCalledUrl = new URL(calledUrl);
  assert.equal(parsedCalledUrl.hostname, 'generativelanguage.googleapis.com');
  assert.ok(calledUrl.includes('gemini-2.5-flash:generateContent?key=test-gemini-key'));
  assert.equal(calledBody.contents[0].parts[0].text, 'Analisis BBCA');
  assert.equal(calledBody.systemInstruction.parts[0].text, 'Gunakan Bahasa Indonesia.');
});

test('PR 6: generateGeminiContent classifies HTTP 429 and 500 correctly', async () => {
  const rateLimitFetch = async () => ({ ok: false, status: 429, text: async () => 'Rate limit' });
  await assert.rejects(
    generateGeminiContent({ apiKey: 'k', prompt: 'test', fetchFn: rateLimitFetch }),
    (err) => err.code === 'GEMINI_RATE_LIMITED' && err.status === 429
  );
  const serverErrorFetch = async () => ({ ok: false, status: 500, text: async () => 'Error' });
  await assert.rejects(
    generateGeminiContent({ apiKey: 'k', prompt: 'test', fetchFn: serverErrorFetch }),
    (err) => err.code === 'GEMINI_HTTP_ERROR' && err.status === 500
  );
});

// ============================================================================
// 2. Database Response Cache Tests
// ============================================================================

test('PR 6: computeCacheKey produces deterministic SHA-256 hash', () => {
  const key1 = computeCacheKey({ ticker: 'bbca', analysisType: 'stock_analysis', prompt: 'gimana?', marketDate: '2026-09-02' });
  const key2 = computeCacheKey({ ticker: 'BBCA', analysisType: 'STOCK_ANALYSIS', prompt: 'gimana?', marketDate: '2026-09-02' });
  const key3 = computeCacheKey({ ticker: 'BBRI', analysisType: 'stock_analysis', prompt: 'gimana?', marketDate: '2026-09-02' });
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
  assert.equal(key1.length, 64);
});

test('PR 6: cache hit in memory returns payload with source=db_cache and cache_hit=true', async () => {
  const cacheKey = computeCacheKey({ ticker: 'TLKM', analysisType: 'stock_analysis', prompt: 'entry level?', marketDate: '2026-09-02' });
  await setCachedAnalysis({
    cacheKey,
    ticker: 'TLKM',
    analysisType: 'stock_analysis',
    payloadResponse: { reply: 'TLKM entry di 3800-3850', score: 85 },
    ttlSeconds: 3600
  });
  const cached = await getCachedAnalysis({ cacheKey });
  assert.ok(cached);
  assert.equal(cached.reply, 'TLKM entry di 3800-3850');
  assert.equal(cached.source, 'db_cache');
  assert.equal(cached.cache_hit, true);
});

test('PR 6: getCachedAnalysis and setCachedAnalysis work with mock Supabase client without network', async () => {
  const mockDb = createMockSupabase();
  const cacheKey = computeCacheKey({ ticker: 'BBCA', analysisType: 'stock_analysis', prompt: 'level breakout?', marketDate: '2026-09-02' });

  const stored = await setCachedAnalysis({
    cacheKey,
    ticker: 'BBCA',
    analysisType: 'stock_analysis',
    payloadResponse: { reply: 'BBCA breakout di 10200' },
    ttlSeconds: 3600,
    dbClient: mockDb
  });
  assert.equal(stored, true);
  assert.ok(mockDb._store.has(cacheKey));

  // Clear memory cache to force mock DB lookup
  clearMemoryCache();

  const cached = await getCachedAnalysis({ cacheKey, dbClient: mockDb });
  assert.ok(cached);
  assert.equal(cached.reply, 'BBCA breakout di 10200');
  assert.equal(cached.source, 'db_cache');
  assert.equal(cached.cache_hit, true);
});

test('PR 6: expired cache entry returns null (cache miss)', async () => {
  const cacheKey = computeCacheKey({ ticker: 'ASII', analysisType: 'stock_analysis', prompt: 'target?', marketDate: '2026-09-02' });
  await setCachedAnalysis({
    cacheKey,
    ticker: 'ASII',
    analysisType: 'stock_analysis',
    payloadResponse: { reply: 'ASII target 5200' },
    ttlSeconds: -10
  });
  const cached = await getCachedAnalysis({ cacheKey });
  assert.equal(cached, null);
});

// ============================================================================
// 3. Context AI Router V7 Integration & Fallback Tests
// ============================================================================

test('PR 6: handleContextAIV7 uses cache hit when available and does not call external API', async () => {
  const ticker = 'GOTO';
  const prompt = 'Gimana posisi saya?';
  const context = { ticker, plans: [{ ticker: 'GOTO', lots: 100 }] };
  // The portfolio_chat cache key includes a digest of the portfolio the answer
  // was computed from, so a seed must be written under the key the router itself
  // builds for THIS request. Seeding a context-free key would only pass while
  // two different portfolios still collided — see
  // test/ai-cache-cross-user-isolation.test.js.
  const cacheKey = computeCacheKey(handleContextAIV7._test.buildCacheParams(
    { ticker, analysisType: 'portfolio_chat', prompt, marketDate: new Date().toISOString().slice(0, 10) },
    'portfolio_chat', require('../lib/context-ai-router-v4')._test.portfolioContext(context), ''
  ));
  await setCachedAnalysis({
    cacheKey,
    ticker,
    analysisType: 'portfolio_chat',
    payloadResponse: { reply: 'Posisi GOTO aman di area support.', model: 'cached-gemini' },
    ttlSeconds: 7200
  });
  const req = {
    method: 'POST',
    body: {
      source: 'portfolio_chat',
      chatMessage: prompt,
      context
    }
  };
  const { state, res } = mockRes();
  await handleContextAIV7(req, res);
  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.success, true);
  assert.equal(state.payload.source, 'db_cache');
  assert.equal(state.payload.cache_hit, true);
  assert.equal(state.payload.reply, 'Posisi GOTO aman di area support.');
});

test('PR 6: handleContextAIV7 calls direct Gemini API and caches response on success (mocked fetch)', async () => {
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'mock-valid-gemini-key';
  delete process.env.PORTFOLIO_AI_API_KEY;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Respon live Gemini untuk BBCA' }] } }]
      })
    };
  };

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        chatMessage: 'Prospek breakout?',
        context: {
          ticker: 'BBCA',
          status: 'READY_BREAKOUT',
          analysis_text: 'BBCA breakout 10200.'
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.statusCode, 200);
    assert.equal(state.payload.success, true);
    assert.equal(state.payload.source, 'gemini_api');
    assert.equal(state.payload.reply, 'Respon live Gemini untuk BBCA');
  } finally {
    globalThis.fetch = origFetch;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  }
});

test('PR 6: handleContextAIV7 degrades gracefully to local deterministic response when Gemini fails', async () => {
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'invalid-key-that-will-fail';
  delete process.env.PORTFOLIO_AI_API_KEY;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error('Network timeout');
  };
  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        chatMessage: 'Validasi level support?',
        context: {
          ticker: 'BBCA',
          status: 'READY_BREAKOUT',
          analysis_text: 'BBCA breakout resistance 10200 dengan volume solid.'
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal(state.payload.success, true);
    assert.equal(state.payload.model, 'local-deterministic');
    assert.equal(state.payload.source, 'local_fallback');
    assert.equal(state.payload.local_fallback, true);
    assert.ok(state.payload.reply.includes('BBCA'));
  } finally {
    globalThis.fetch = origFetch;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  }
});

test('PR 6: handleContextAIV7 respects GEMINI_AI_DISABLED toggle', async () => {
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  process.env.GEMINI_AI_DISABLED = 'true';
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'valid-key';
  try {
    const req = {
      method: 'POST',
      body: {
        source: 'portfolio_chat',
        chatMessage: 'Rekomendasi alokasi dana?',
        context: {
          plans: [{ ticker: 'BBRI', lots: 50 }, { ticker: 'TLKM', lots: 40 }]
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal(state.payload.success, true);
    assert.equal(state.payload.source, 'local_fallback');
    assert.equal(state.payload.local_fallback, true);
    assert.ok(state.payload.reply.includes('Evaluasi Portofolio'));
  } finally {
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
    delete process.env.GEMINI_AI_DISABLED;
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  }
});

// The primary Gemini path can make up to 3 sequential upstream attempts
// (primary model, fallback model, backup key), each historically fixed at
// 25000ms with no cumulative check. 3 * 25000ms can exceed vercel.json's
// 60s maxDuration for api/analyze.js, so the platform kills the function
// before it reaches its own local-deterministic fallback - the client then
// sees a raw timeout/disconnect instead of a graceful degraded reply, which
// looks exactly like "every AI route is down" even though no model was ever
// actually rejected. See PR #529 follow-up investigation.
test('PR529 follow-up: Gemini primary-path attempts respect a cumulative time budget under Vercel maxDuration', () => {
  const { HARD_HANDLER_BUDGET_MS, GEMINI_ATTEMPT_TIMEOUT_MS, GEMINI_MIN_VIABLE_TIMEOUT_MS, nextGeminiTimeout } = handleContextAIV7._test;

  const VERCEL_MAX_DURATION_MS = 60000;
  assert.ok(HARD_HANDLER_BUDGET_MS < VERCEL_MAX_DURATION_MS, 'handler budget must leave margin under the platform hard limit');

  // Worst case (3 full-length attempts back to back) must not be allowed to
  // exceed the handler's own hard budget.
  assert.ok(3 * GEMINI_ATTEMPT_TIMEOUT_MS > HARD_HANDLER_BUDGET_MS,
    'sanity check: without budget-aware timeouts, 3 attempts really could exceed the budget');

  // Comfortable budget: the first attempt gets the full per-attempt timeout.
  const freshStart = Date.now();
  assert.equal(nextGeminiTimeout(freshStart), GEMINI_ATTEMPT_TIMEOUT_MS);

  // Only a few seconds left (but still above the minimum viable timeout): the
  // next attempt must be capped to what remains, not allowed to run for the
  // full fixed timeout.
  const remainingMs = GEMINI_MIN_VIABLE_TIMEOUT_MS + 2000;
  const almostOut = Date.now() - (HARD_HANDLER_BUDGET_MS - remainingMs);
  const cappedTimeout = nextGeminiTimeout(almostOut);
  assert.ok(cappedTimeout !== null && cappedTimeout <= remainingMs, 'a late attempt must be capped to the remaining budget');

  // Effectively no time left: the attempt must be skipped entirely (null)
  // rather than handed a token timeout too short for any real HTTP round trip.
  const exhausted = Date.now() - (HARD_HANDLER_BUDGET_MS - (GEMINI_MIN_VIABLE_TIMEOUT_MS - 1));
  assert.equal(nextGeminiTimeout(exhausted), null, 'an attempt with less than the minimum viable timeout must be skipped');
});

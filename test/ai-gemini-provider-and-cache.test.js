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
  clearMemoryCache
} = require('../lib/ai-analysis-cache');

const handleContextAIV7 = require('../lib/context-ai-router-v7');

function mockRes() {
  const state = { statusCode: 200, payload: null };
  const res = {
    status(code) { state.statusCode = Number(code); return res; },
    json(data) { state.payload = data; return res; },
    send(data) { state.payload = data; return res; }
  };
  return { state, res };
}

test('PR 6: getGeminiApiKey prioritizes API_KEY_ANALISA_SAHAM_PORTOFOLIO over GEMINI_API_KEY', () => {
  const origPrimary = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origFallback = process.env.GEMINI_API_KEY;
  try {
    process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = '  primary-gemini-key-123  ';
    process.env.GEMINI_API_KEY = 'fallback-key-456';
    assert.equal(getGeminiApiKey(), 'primary-gemini-key-123');
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    assert.equal(getGeminiApiKey(), 'fallback-key-456');
    delete process.env.GEMINI_API_KEY;
    assert.equal(getGeminiApiKey(), null);
  } finally {
    if (origPrimary !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origPrimary;
    else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    if (origFallback !== undefined) process.env.GEMINI_API_KEY = origFallback;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('PR 6: generateGeminiContent throws GEMINI_API_KEY_MISSING when no key is configured', async () => {
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
    model: 'gemini-3.6-flash',
    prompt: 'Analisis BBCA',
    systemInstruction: 'Gunakan Bahasa Indonesia.',
    fetchFn: mockFetch
  });
  assert.equal(result.text, 'Halo dari Gemini Flash 2.5!');
  assert.equal(result.model, 'gemini-3.6-flash');
  assert.equal(result.source, 'gemini_api');
  assert.ok(calledUrl.includes('generativelanguage.googleapis.com'));
  assert.ok(calledUrl.includes('gemini-3.6-flash:generateContent?key=test-gemini-key'));
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

test('PR 6: computeCacheKey produces deterministic SHA-256 hash', () => {
  const key1 = computeCacheKey({ ticker: 'bbca', analysisType: 'stock_analysis', prompt: 'gimana?', marketDate: '2026-09-02' });
  const key2 = computeCacheKey({ ticker: 'BBCA', analysisType: 'STOCK_ANALYSIS', prompt: 'gimana?', marketDate: '2026-09-02' });
  const key3 = computeCacheKey({ ticker: 'BBRI', analysisType: 'stock_analysis', prompt: 'gimana?', marketDate: '2026-09-02' });
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
  assert.equal(key1.length, 64);
});

test('PR 6: cache hit returns payload with source=db_cache and cache_hit=true', async () => {
  clearMemoryCache();
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

test('PR 6: expired cache entry returns null (cache miss)', async () => {
  clearMemoryCache();
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

test('PR 6: handleContextAIV7 uses cache hit when available and does not call external API', async () => {
  clearMemoryCache();
  const ticker = 'GOTO';
  const prompt = 'Gimana posisi saya?';
  const cacheKey = computeCacheKey({ ticker, analysisType: 'portfolio_chat', prompt });
  await setCachedAnalysis({
    cacheKey,
    ticker,
    analysisType: 'portfolio_chat',
    payloadResponse: { reply: 'Posisi GOTO aman di area support.', model: 'cached-gemini' },
    ttlSeconds: 7200
  });
  const req = {
    body: {
      source: 'portfolio_chat',
      chatMessage: prompt,
      context: { ticker, plans: [{ ticker: 'GOTO', lots: 100 }] }
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

test('PR 6: handleContextAIV7 degrades gracefully to local deterministic response when Gemini fails', async () => {
  clearMemoryCache();
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'invalid-key-that-will-fail';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      throw new Error('Network timeout');
    }
    return origFetch ? origFetch(url) : null;
  };
  try {
    const req = {
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
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  }
});

test('PR 6: handleContextAIV7 respects GEMINI_AI_DISABLED toggle', async () => {
  clearMemoryCache();
  const origDisabled = process.env.GEMINI_AI_DISABLED;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  process.env.GEMINI_AI_DISABLED = 'true';
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'valid-key';
  try {
    const req = {
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
    if (origDisabled !== undefined) process.env.GEMINI_AI_DISABLED = origDisabled;
    else delete process.env.GEMINI_AI_DISABLED;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  }
});

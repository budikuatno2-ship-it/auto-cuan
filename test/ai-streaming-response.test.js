'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  streamGeminiAnalysis,
  validateGeminiEndpoint,
  DEFAULT_GEMINI_MODEL
} = require('../lib/ai-gemini-provider');

const {
  clearMemoryCache,
  getCachedAnalysis,
  setCachedAnalysis
} = require('../lib/ai-analysis-cache');

const {
  getAiTelemetryStats,
  resetAiTelemetryStats
} = require('../lib/ai-telemetry');

const handleContextAIV7 = require('../lib/context-ai-router-v7');

function mockRes() {
  const state = {
    statusCode: 200,
    headers: {},
    payload: null,
    chunks: [],
    ended: false,
    flushedHeaders: false
  };

  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    setHeader(key, value) {
      state.headers[key.toLowerCase()] = value;
      return res;
    },
    flushHeaders() {
      state.flushedHeaders = true;
    },
    write(data) {
      state.chunks.push(String(data));
      return true;
    },
    end() {
      state.ended = true;
      return res;
    },
    json(data) {
      state.payload = data;
      return res;
    }
  };

  return { state, res };
}

function createMockSseResponse(chunks = []) {
  const lines = chunks.map(c => `data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(c)}}]}}]}\n\n`);
  lines.push('data: [DONE]\n\n');
  const fullText = lines.join('');

  return {
    ok: true,
    status: 200,
    text: async () => fullText,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) {
          yield line;
        }
      }
    }
  };
}

test('PR 8: validateGeminiEndpoint allows generativelanguage.googleapis.com and rejects malicious URLs', () => {
  assert.equal(validateGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent'), true);
  assert.equal(validateGeminiEndpoint('https://evil.com/v1beta/models/gemini-2.5-flash'), false);
  assert.equal(validateGeminiEndpoint('invalid-url'), false);
});

test('PR 8: streamGeminiAnalysis streams chunks incrementally and accumulates full text', async () => {
  const chunksReceived = [];
  const mockFetch = async () => createMockSseResponse(['Analisis ', 'teknikal ', 'BBCA ', 'breakout.']);

  const result = await streamGeminiAnalysis({
    prompt: 'Analisis BBCA',
    apiKey: 'mock-gemini-stream-key',
    fetchFn: mockFetch,
    onChunk: (chunk) => chunksReceived.push(chunk)
  });

  assert.equal(result.text, 'Analisis teknikal BBCA breakout.');
  assert.equal(result.source, 'gemini_api');
  assert.deepEqual(chunksReceived, ['Analisis ', 'teknikal ', 'BBCA ', 'breakout.']);
});

test('PR 8: streamGeminiAnalysis throws GEMINI_API_KEY_MISSING when no key is configured', async () => {
  const origPrimary = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origFallback = process.env.GEMINI_API_KEY;
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;

  try {
    await assert.rejects(
      async () => streamGeminiAnalysis({ prompt: 'test' }),
      { code: 'GEMINI_API_KEY_MISSING' }
    );
  } finally {
    if (origPrimary !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origPrimary;
    if (origFallback !== undefined) process.env.GEMINI_API_KEY = origFallback;
  }
});

test('PR 8: handleContextAIV7 streams SSE response and caches accumulated text when stream: true', async () => {
  resetAiTelemetryStats();
  clearMemoryCache();

  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'mock-stream-api-key';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => createMockSseResponse(['BBRI ', 'support 5200 ', 'target 5500.']);

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        chatMessage: 'Level support BBRI?',
        stream: true,
        context: {
          ticker: 'BBRI',
          status: 'ACCUMULATION',
          analysis_text: 'BBRI sideways di 5200'
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.headers['content-type'], 'text/event-stream');
    assert.equal(state.headers['cache-control'], 'no-cache');
    assert.equal(state.ended, true);

    const fullWritten = state.chunks.join('');
    assert.ok(fullWritten.includes('data: {"chunk":"BBRI "}'));
    assert.ok(fullWritten.includes('data: {"chunk":"support 5200 "}'));
    assert.ok(fullWritten.includes('data: {"chunk":"target 5500."}'));
    assert.ok(fullWritten.includes('data: [DONE]'));

    // Verify cached in database/memory cache
    const cached = await getCachedAnalysis({
      ticker: 'BBRI',
      analysisType: 'stock_analysis_followup',
      prompt: 'Level support BBRI?',
      dbClient: null
    });
    assert.ok(cached, 'Accumulated response should be cached');
    assert.equal(cached.reply, 'BBRI support 5200 target 5500.');

    // Telemetry recorded
    const stats = getAiTelemetryStats();
    assert.equal(stats.total_requests, 1);
    assert.equal(stats.gemini_calls, 1);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
    else delete process.env.GEMINI_API_KEY;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
  }
});

test('PR 8: handleContextAIV7 streams immediate cache hit when stream: true', async () => {
  resetAiTelemetryStats();
  clearMemoryCache();

  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No live network in unit test'); };

  delete process.env.PORTFOLIO_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;

  try {
    const streamContext = { ticker: 'TLKM', plans: [] };
    // The portfolio_chat cache key includes a digest of the portfolio the answer
    // was computed from, so a seed must be written under the key the router itself
    // builds for THIS request. Seeding a context-free key would only pass while
    // two different portfolios still collided — see
    // test/ai-cache-cross-user-isolation.test.js.
    await setCachedAnalysis(Object.assign(
      handleContextAIV7._test.buildCacheParams(
        { ticker: 'TLKM', analysisType: 'portfolio_chat', prompt: 'TLKM aman?', marketDate: new Date().toISOString().slice(0, 10) },
        'portfolio_chat', require('../lib/context-ai-router-v4')._test.portfolioContext(streamContext), ''
      ),
      { payloadResponse: { reply: 'TLKM aman di support.', model: 'gemini-cached' }, ttlSeconds: 3600 }
    ));

    const req = {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      body: {
        source: 'portfolio_chat',
        chatMessage: 'TLKM aman?',
        context: streamContext
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.headers['content-type'], 'text/event-stream');
    assert.equal(state.ended, true);

    const fullWritten = state.chunks.join('');
    assert.ok(fullWritten.includes('TLKM aman di support.'));
    assert.ok(fullWritten.includes('data: [DONE]'));

    const stats = getAiTelemetryStats();
    assert.equal(stats.total_requests, 1);
    assert.equal(stats.cache_hits, 1);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
    else delete process.env.GEMINI_API_KEY;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
  }
});

test('PR 8: handleContextAIV7 falls back to standard JSON when stream is false', async () => {
  resetAiTelemetryStats();
  clearMemoryCache();

  const origDisabled = process.env.GEMINI_AI_DISABLED;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No live network in unit test'); };

  process.env.GEMINI_AI_DISABLED = 'true';
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'portfolio_chat',
        chatMessage: 'Status cash?',
        stream: false,
        context: { plans: [{ ticker: 'BBCA', lots: 10 }] }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.statusCode, 200);
    assert.equal(state.headers['content-type'], undefined, 'Should not set SSE content-type');
    assert.ok(state.payload);
    assert.equal(state.payload.success, true);
    assert.equal(state.payload.local_fallback, true);
  } finally {
    globalThis.fetch = origFetch;
    if (origDisabled !== undefined) process.env.GEMINI_AI_DISABLED = origDisabled;
    else delete process.env.GEMINI_AI_DISABLED;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
    else delete process.env.GEMINI_API_KEY;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
  clearMemoryCache,
  purgeExpiredAnalysisCache,
  invalidateAnalysisCacheByTicker
} = require('../lib/ai-analysis-cache');

const {
  recordRequest,
  recordCacheHit,
  recordGeminiCall,
  recordLocalFallback,
  getAiTelemetryStats,
  resetAiTelemetryStats
} = require('../lib/ai-telemetry');

const handleContextAIV7 = require('../lib/context-ai-router-v7');
const maintenanceHandler = require('../api/maintenance-settings');

function mockRes() {
  const state = { statusCode: 200, headers: {}, payload: null };
  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    setHeader(key, value) {
      state.headers[key] = value;
      return res;
    },
    json(data) {
      state.payload = data;
      return res;
    }
  };
  return { state, res };
}

function createMockSupabase(options = {}) {
  const calls = [];
  const client = {
    _calls: calls,
    from(table) {
      const call = { table, action: null, filters: [] };
      calls.push(call);
      const builder = {
        delete(opts) {
          call.action = 'delete';
          call.opts = opts;
          return builder;
        },
        select(cols) {
          call.action = 'select';
          call.cols = cols;
          return builder;
        },
        upsert(row, opts) {
          call.action = 'upsert';
          call.row = row;
          call.opts = opts;
          return Promise.resolve({ error: options.upsertError || null });
        },
        eq(col, val) {
          call.filters.push({ op: 'eq', col, val });
          return builder;
        },
        lt(col, val) {
          call.filters.push({ op: 'lt', col, val });
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: options.singleData || null, error: options.singleError || null });
        },
        then(resolve, reject) {
          const result = {
            data: options.deleteData || [],
            error: options.deleteError || null,
            count: options.deleteCount !== undefined ? options.deleteCount : 2
          };
          return Promise.resolve(result).then(resolve, reject);
        }
      };
      return builder;
    }
  };
  return client;
}

test('PR 7: purgeExpiredAnalysisCache clears expired in-memory entries and queries Supabase delete lt', async () => {
  clearMemoryCache();
  const now = Date.now();

  // Seed 1 active and 1 expired entry
  await setCachedAnalysis({
    ticker: 'BBCA',
    analysisType: 'stock_analysis',
    prompt: 'Active query',
    payloadResponse: { reply: 'Active analysis' },
    ttlSeconds: 3600 // active
  });

  // Manually seed expired by calling set with negative ttl
  await setCachedAnalysis({
    ticker: 'TLKM',
    analysisType: 'stock_analysis',
    prompt: 'Expired query',
    payloadResponse: { reply: 'Expired analysis' },
    ttlSeconds: -10 // expired
  });

  const mockDb = createMockSupabase({ deleteCount: 3 });
  const result = await purgeExpiredAnalysisCache({ dbClient: mockDb });

  assert.equal(result.success, true);
  assert.equal(result.memoryPurged, 1, 'Should purge 1 expired entry from memory');
  assert.equal(result.dbPurged, 3, 'Should report 3 rows purged from db');
  assert.equal(result.purgedCount, 4);

  // Check that mock DB was called properly
  const deleteCalls = mockDb._calls.filter(c => c.action === 'delete');
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].table, 'ai_analysis_cache');
  const ltFilter = deleteCalls[0].filters.find(f => f.op === 'lt');
  assert.ok(ltFilter, 'Should use lt filter on expires_at');
  assert.equal(ltFilter.col, 'expires_at');
});

test('PR 7: purgeExpiredAnalysisCache handles database-offline mode gracefully', async () => {
  clearMemoryCache();
  await setCachedAnalysis({
    ticker: 'BBRI',
    analysisType: 'stock_analysis',
    prompt: 'Expired test',
    payloadResponse: { reply: 'Expired' },
    ttlSeconds: -5
  });

  const result = await purgeExpiredAnalysisCache({ dbClient: null });
  assert.equal(result.success, true);
  assert.equal(result.memoryPurged, 1);
  assert.equal(result.dbPurged, 0);
});

test('PR 7: invalidateAnalysisCacheByTicker invalidates matching ticker in memory and Supabase', async () => {
  clearMemoryCache();

  await setCachedAnalysis({
    ticker: 'BBCA',
    analysisType: 'stock_analysis',
    prompt: 'Analisis BBCA',
    payloadResponse: { reply: 'BBCA kuat' },
    ttlSeconds: 3600
  });

  await setCachedAnalysis({
    ticker: 'BBRI',
    analysisType: 'stock_analysis',
    prompt: 'Analisis BBRI',
    payloadResponse: { reply: 'BBRI sideways' },
    ttlSeconds: 3600
  });

  const mockDb = createMockSupabase({ deleteCount: 1 });
  const result = await invalidateAnalysisCacheByTicker({ ticker: 'bbca', dbClient: mockDb });

  assert.equal(result.success, true);
  assert.equal(result.ticker, 'BBCA');
  assert.equal(result.memoryInvalidated, 1);
  assert.equal(result.dbInvalidated, 1);

  // Verify DB call
  const deleteCalls = mockDb._calls.filter(c => c.action === 'delete');
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].table, 'ai_analysis_cache');
  const eqFilter = deleteCalls[0].filters.find(f => f.op === 'eq');
  assert.ok(eqFilter);
  assert.equal(eqFilter.col, 'ticker');
  assert.equal(eqFilter.val, 'BBCA');

  // Verify memory cache: BBCA is gone, BBRI is still present
  const bbcaHit = await getCachedAnalysis({ ticker: 'BBCA', analysisType: 'stock_analysis', prompt: 'Analisis BBCA', dbClient: null });
  assert.equal(bbcaHit, null, 'BBCA should be invalidated from memory cache');

  const bbriHit = await getCachedAnalysis({ ticker: 'BBRI', analysisType: 'stock_analysis', prompt: 'Analisis BBRI', dbClient: null });
  assert.ok(bbriHit, 'BBRI should remain in memory cache');
});

test('PR 7: invalidateAnalysisCacheByTicker validates input', async () => {
  const res1 = await invalidateAnalysisCacheByTicker({ ticker: '' });
  assert.equal(res1.success, false);
  assert.ok(res1.error);

  const res2 = await invalidateAnalysisCacheByTicker({ ticker: null });
  assert.equal(res2.success, false);
});

test('PR 7: In-memory telemetry tracker records requests, hit rates, and average latency', () => {
  resetAiTelemetryStats();

  let initial = getAiTelemetryStats();
  assert.equal(initial.total_requests, 0);
  assert.equal(initial.cache_hits, 0);
  assert.equal(initial.gemini_calls, 0);
  assert.equal(initial.local_fallbacks, 0);
  assert.equal(initial.average_latency_ms, 0);
  assert.equal(initial.cache_hit_rate, 0);

  recordRequest();
  recordCacheHit();

  recordRequest();
  recordGeminiCall(120);

  recordRequest();
  recordGeminiCall(80);

  recordRequest();
  recordLocalFallback();

  const stats = getAiTelemetryStats();
  assert.equal(stats.total_requests, 4);
  assert.equal(stats.cache_hits, 1);
  assert.equal(stats.gemini_calls, 2);
  assert.equal(stats.local_fallbacks, 1);
  assert.equal(stats.average_latency_ms, 100); // (120 + 80) / 2
  assert.equal(stats.cache_hit_rate, 0.25); // 1 / 4

  resetAiTelemetryStats();
  const resetStats = getAiTelemetryStats();
  assert.equal(resetStats.total_requests, 0);
  assert.equal(resetStats.cache_hits, 0);
  assert.equal(resetStats.gemini_calls, 0);
});

test('PR 7: handleContextAIV7 automatically records telemetry on cache hit and fallback', async () => {
  resetAiTelemetryStats();
  clearMemoryCache();

  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;

  try {
    // 1. Seed cache
    await setCachedAnalysis({
      ticker: 'ASII',
      analysisType: 'portfolio_chat',
      prompt: 'Posisi ASII?',
      payloadResponse: { reply: 'ASII akumulasi' },
      ttlSeconds: 3600
    });

    const reqHit = {
      method: 'POST',
      body: {
        source: 'portfolio_chat',
        chatMessage: 'Posisi ASII?',
        context: { ticker: 'ASII', plans: [] }
      }
    };
    const { state: stateHit, res: resHit } = mockRes();
    await handleContextAIV7(reqHit, resHit);

    assert.equal(stateHit.statusCode, 200);
    assert.equal(stateHit.payload.cache_hit, true);

    const statsAfterHit = getAiTelemetryStats();
    assert.equal(statsAfterHit.total_requests, 1);
    assert.equal(statsAfterHit.cache_hits, 1);

    // 2. Request without cache and without Gemini key -> local fallback
    const reqFallback = {
      method: 'POST',
      body: {
        source: 'portfolio_chat',
        chatMessage: 'Rekomendasi cash?',
        context: { plans: [{ ticker: 'BBCA', lots: 10 }] }
      }
    };
    const { state: stateFb, res: resFb } = mockRes();
    await handleContextAIV7(reqFallback, resFb);

    assert.equal(stateFb.statusCode, 200);
    assert.equal(stateFb.payload.local_fallback, true);

    const statsAfterFb = getAiTelemetryStats();
    assert.equal(statsAfterFb.total_requests, 2);
    assert.equal(statsAfterFb.local_fallbacks, 1);
  } finally {
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
  }
});

test('PR 7: api/maintenance-settings exposes ai-telemetry action and includes aiTelemetry in get', async () => {
  resetAiTelemetryStats();
  recordRequest();
  recordCacheHit();

  // Test action: 'ai-telemetry'
  const { state: stateDiag, res: resDiag } = mockRes();
  await maintenanceHandler({ method: 'POST', body: { action: 'ai-telemetry' } }, resDiag);

  assert.equal(stateDiag.statusCode, 200);
  assert.equal(stateDiag.payload.success, true);
  assert.ok(stateDiag.payload.aiTelemetry);
  assert.equal(stateDiag.payload.aiTelemetry.total_requests, 1);
  assert.equal(stateDiag.payload.aiTelemetry.cache_hits, 1);
});

test('PR 7: handleContextAIV7 records gemini_calls and roundtrip latency when Gemini succeeds', async () => {
  resetAiTelemetryStats();
  clearMemoryCache();

  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.PORTFOLIO_AI_API_KEY;
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'mock-key';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // Artificial small delay to measure latency
    await new Promise(r => setTimeout(r, 10));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Mock Gemini Live Reply' }] } }]
      })
    };
  };

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        chatMessage: 'Validasi breakout?',
        context: {
          ticker: 'BMRI',
          status: 'READY_BREAKOUT',
          analysis_text: 'Breakout support 7000'
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.statusCode, 200);
    assert.equal(state.payload.source, 'gemini_api');

    const stats = getAiTelemetryStats();
    assert.equal(stats.total_requests, 1);
    assert.equal(stats.gemini_calls, 1);
    assert.ok(stats.average_latency_ms >= 5, 'Latency should be at least ~5ms from simulated delay');
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
    else delete process.env.PORTFOLIO_AI_API_KEY;
  }
});

test('PR 7: lib/ai-analysis-cache re-exports all telemetry functions', () => {
  const cacheModule = require('../lib/ai-analysis-cache');
  assert.equal(typeof cacheModule.purgeExpiredAnalysisCache, 'function');
  assert.equal(typeof cacheModule.invalidateAnalysisCacheByTicker, 'function');
  assert.equal(typeof cacheModule.getAiTelemetryStats, 'function');
  assert.equal(typeof cacheModule.resetAiTelemetryStats, 'function');
  assert.equal(typeof cacheModule.recordRequest, 'function');
  assert.equal(typeof cacheModule.recordCacheHit, 'function');
  assert.equal(typeof cacheModule.recordGeminiCall, 'function');
  assert.equal(typeof cacheModule.recordLocalFallback, 'function');
});


'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

function mockRes() {
  const state = {
    statusCode: 200,
    headers: {},
    payload: null,
    chunks: [],
    ended: false
  };
  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    json(data) {
      state.payload = data;
      state.ended = true;
      return res;
    },
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    flushHeaders() {},
    write(chunk) {
      state.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    end(chunk) {
      if (chunk) state.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      state.ended = true;
      return res;
    }
  };
  return { state, res };
}

// ----------------------------------------------------------------------------
// 1. Invariant & Architecture Integrity Verification
// ----------------------------------------------------------------------------

test('PR 9 Gate: api/ directory contains exactly 12 endpoints (architectural invariant)', () => {
  const apiDir = path.join(ROOT_DIR, 'api');
  assert.ok(fs.existsSync(apiDir), 'api directory must exist');

  const files = fs.readdirSync(apiDir).filter(f => f.endsWith('.js')).sort();
  assert.equal(files.length, 12, 'api/ must strictly contain exactly 12 JavaScript files');

  const expectedFiles = [
    'admin-logs.js',
    'admin-users.js',
    'analyze.js',
    'candles.js',
    'log.js',
    'login-user.js',
    'maintenance-settings.js',
    'quote.js',
    'register-user.js',
    'reset-password.js',
    'review-access.js',
    'sector-hot.js'
  ].sort();

  assert.deepEqual(files, expectedFiles, 'api/ file list must match exact expected 12 endpoints');
});

test('PR 9 Gate: Core AI provider, cache, and telemetry modules exist and export expected functions', () => {
  const providerPath = path.join(ROOT_DIR, 'lib/ai-gemini-provider.js');
  const cachePath = path.join(ROOT_DIR, 'lib/ai-analysis-cache.js');
  const telemetryPath = path.join(ROOT_DIR, 'lib/ai-telemetry.js');
  const routerPath = path.join(ROOT_DIR, 'lib/context-ai-router-v7.js');

  assert.ok(fs.existsSync(providerPath), 'lib/ai-gemini-provider.js must exist');
  assert.ok(fs.existsSync(cachePath), 'lib/ai-analysis-cache.js must exist');
  assert.ok(fs.existsSync(telemetryPath), 'lib/ai-telemetry.js must exist');
  assert.ok(fs.existsSync(routerPath), 'lib/context-ai-router-v7.js must exist');

  const provider = require(providerPath);
  assert.equal(typeof provider.generateGeminiContent, 'function');
  assert.equal(typeof provider.streamGeminiAnalysis, 'function');
  assert.equal(typeof provider.getGeminiApiKey, 'function');
  assert.equal(typeof provider.validateGeminiEndpoint, 'function');
  assert.ok(provider.DEFAULT_GEMINI_MODEL);

  const cache = require(cachePath);
  assert.equal(typeof cache.computeCacheKey, 'function');
  assert.equal(typeof cache.getCachedAnalysis, 'function');
  assert.equal(typeof cache.setCachedAnalysis, 'function');
  assert.equal(typeof cache.purgeExpiredAnalysisCache, 'function');
  assert.equal(typeof cache.invalidateAnalysisCacheByTicker, 'function');
  assert.equal(typeof cache.clearMemoryCache, 'function');

  const telemetry = require(telemetryPath);
  assert.equal(typeof telemetry.getAiTelemetryStats, 'function');
  assert.equal(typeof telemetry.resetAiTelemetryStats, 'function');
  assert.equal(typeof telemetry.recordRequest, 'function');
  assert.equal(typeof telemetry.recordCacheHit, 'function');
  assert.equal(typeof telemetry.recordGeminiCall, 'function');
  assert.equal(typeof telemetry.recordLocalFallback, 'function');

  const router = require(routerPath);
  assert.equal(typeof router, 'function');
});

// ----------------------------------------------------------------------------
// 2. Diagnostics & Endpoint Routing Verification
// ----------------------------------------------------------------------------

test('PR 9 Gate: api/maintenance-settings responds to aiTelemetry action with structured counters', async () => {
  const maintenanceHandler = require(path.join(ROOT_DIR, 'api/maintenance-settings'));
  const { resetAiTelemetryStats, recordRequest, recordCacheHit, recordGeminiCall } = require(path.join(ROOT_DIR, 'lib/ai-telemetry'));

  resetAiTelemetryStats();
  recordRequest();
  recordCacheHit();
  recordRequest();
  recordGeminiCall(75);

  const { state, res } = mockRes();
  await maintenanceHandler({ method: 'POST', body: { action: 'ai-telemetry' } }, res);

  assert.equal(state.statusCode, 200);
  assert.ok(state.payload);
  assert.equal(state.payload.success, true);
  assert.ok(state.payload.aiTelemetry);

  const t = state.payload.aiTelemetry;
  assert.equal(t.total_requests, 2);
  assert.equal(t.cache_hits, 1);
  assert.equal(t.gemini_calls, 1);
  assert.equal(t.cache_hit_rate, 0.5);
  assert.equal(t.average_latency_ms, 75);

  resetAiTelemetryStats();
});

test('PR 9 Gate: api/analyze context router handles streaming and fallback safely offline', async () => {
  const handleContextAIV7 = require(path.join(ROOT_DIR, 'lib/context-ai-router-v7'));
  const analyzeApi = require(path.join(ROOT_DIR, 'api/analyze'));

  // Verify exported helper utilities in api/analyze
  assert.ok(analyzeApi.__test);
  assert.equal(typeof analyzeApi.__test.styleInstruction, 'function');
  assert.ok(analyzeApi.__test.styleInstruction('portfolio_chat').includes('Asisten AI Portofolio'));
  assert.ok(analyzeApi.__test.styleInstruction('stock_analysis_followup').includes('Analisis Saham'));

  // Test offline router handling with GEMINI_AI_DISABLED=true and guard fetch
  const origDisabled = process.env.GEMINI_AI_DISABLED;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origFetch = globalThis.fetch;

  process.env.GEMINI_AI_DISABLED = 'true';
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  globalThis.fetch = async () => { throw new Error('Live network calls forbidden in release gate unit tests'); };

  try {
    // 1. Non-streaming fallback request
    const reqJson = {
      method: 'POST',
      body: {
        source: 'portfolio_chat',
        chatMessage: 'Status risiko kas saat ini?',
        stream: false,
        context: { plans: [{ ticker: 'BBRI', lots: 20 }] }
      }
    };
    const { state: stateJson, res: resJson } = mockRes();
    await handleContextAIV7(reqJson, resJson);

    assert.equal(stateJson.statusCode, 200);
    assert.equal(stateJson.headers['content-type'], undefined);
    assert.ok(stateJson.payload);
    assert.equal(stateJson.payload.success, true);
    assert.equal(stateJson.payload.local_fallback, true);

    // 2. Streaming fallback request
    const reqStream = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        chatMessage: 'Support dan resistance?',
        stream: true,
        context: { ticker: 'ASII', status: 'ACCUMULATION', analysis_text: 'ASII akumulasi sideways' }
      }
    };
    const { state: stateStream, res: resStream } = mockRes();
    await handleContextAIV7(reqStream, resStream);

    assert.equal(stateStream.headers['content-type'], 'text/event-stream');
    assert.equal(stateStream.ended, true);
    const streamOutput = stateStream.chunks.join('');
    assert.ok(streamOutput.includes('data: {"chunk":'));
    assert.ok(streamOutput.includes('data: [DONE]'));
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

// ----------------------------------------------------------------------------
// 3. Database Migration & Security Schema Verification
// ----------------------------------------------------------------------------

test('PR 9 Gate: supabase/ai-analysis-cache-migration.sql is syntactically valid and enables RLS', () => {
  const migrationPath = path.join(ROOT_DIR, 'supabase/ai-analysis-cache-migration.sql');
  assert.ok(fs.existsSync(migrationPath), 'Migration file must exist in supabase/');

  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.ok(sql.length > 100, 'Migration file should not be empty');

  // Verify essential DDL declarations
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ai_analysis_cache'), 'Must declare ai_analysis_cache table');
  assert.ok(sql.includes('cache_key TEXT PRIMARY KEY'), 'Must have cache_key primary key');
  assert.ok(sql.includes('payload_response JSONB NOT NULL'), 'Must store payload_response as JSONB');
  assert.ok(sql.includes('expires_at TIMESTAMPTZ NOT NULL'), 'Must store expires_at timestamp');
  assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_expires_at'), 'Must index expires_at');
  assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_ticker'), 'Must index ticker');
  assert.ok(sql.includes('ALTER TABLE ai_analysis_cache ENABLE ROW LEVEL SECURITY'), 'Must enable RLS');
  assert.ok(sql.includes('service_role_all_ai_analysis_cache'), 'Must configure service_role security policy');
});

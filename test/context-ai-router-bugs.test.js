'use strict';

const test = require('node:test');
const assert = require('node:assert');
const handleContextAIV7 = require('../lib/context-ai-router-v7');
const { DEFAULT_GEMINI_MODEL, SAFETY_NET_GEMINI_MODEL } = require('../lib/ai-gemini-provider');
const { setCachedAnalysis, clearMemoryCache } = require('../lib/ai-analysis-cache');

test('BUG-CR7-01: SAFETY_NET_GEMINI_MODEL must not equal DEFAULT_GEMINI_MODEL by default to prevent dead Attempt 4 fallback', () => {
  // In context-ai-router-v7.js line 527 & 641:
  // if (!geminiResult && attempt4Timeout != null && primaryModel !== SAFETY_NET_GEMINI_MODEL && fallbackModel !== SAFETY_NET_GEMINI_MODEL)
  // When GEMINI_SAFETY_NET_MODEL is not set, SAFETY_NET_GEMINI_MODEL defaults to DEFAULT_GEMINI_MODEL,
  // making primaryModel !== SAFETY_NET_GEMINI_MODEL false, which renders Attempt 4 permanently unreachable.
  assert.notStrictEqual(
    SAFETY_NET_GEMINI_MODEL,
    DEFAULT_GEMINI_MODEL,
    'SAFETY_NET_GEMINI_MODEL must be distinct from DEFAULT_GEMINI_MODEL so safety net attempt can execute'
  );
});

test('BUG-CR7-02: handleContextAIV7 cache hit must not leak previous user quota in response payload', async () => {
  clearMemoryCache();

  const prompt = 'Evaluasi portofolio saya';
  const cacheParams = handleContextAIV7._test.buildCacheParams(
    { ticker: null, analysisType: 'portfolio_chat', prompt, marketDate: '2026-03-31' },
    'portfolio_chat',
    { plans: [{ ticker: 'BBCA', lots: 10, entryPriceIdr: 9000 }] },
    ''
  );

  // Cached response from User A who had 0 remaining quota
  await setCachedAnalysis({
    ...cacheParams,
    payloadResponse: {
      success: true,
      reply: 'Portofolio aman terkendali.',
      quota: { tier: 'free', usedToday: 10, remaining: 0 }
    },
    ttlSeconds: 60
  });

  // User B requests same query with fresh 49 remaining quota
  let responseBody = null;
  const req = {
    method: 'POST',
    body: {
      source: 'portfolio_chat',
      chatMessage: prompt,
      context: { plans: [{ ticker: 'BBCA', lots: 10, entryPriceIdr: 9000 }] }
    },
    _aiQuota: {
      tier: 'pro',
      userId: 'user-b',
      wibDate: '2026-03-31',
      quota: { maxDaily: 50 },
      usedToday: 1,
      remaining: 49
    }
  };
  const res = {
    status: () => res,
    json: (data) => { responseBody = data; }
  };

  await handleContextAIV7(req, res);
  assert.strictEqual(responseBody && responseBody.cache_hit, true);
  // User B should NOT receive User A's stale remaining quota: 0
  assert.notStrictEqual(
    responseBody && responseBody.quota && responseBody.quota.remaining,
    0,
    'Cached quota should not overwrite live User B quota'
  );
});

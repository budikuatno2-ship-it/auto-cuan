'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../lib/context-ai-router-v7');

const t = router._test;

test('secondary provider accepts only independent public HTTPS endpoints', () => {
  assert.equal(t.normalizeSecondaryBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  assert.equal(t.normalizeSecondaryBaseUrl('http://openrouter.ai/api/v1'), '');
  assert.equal(t.normalizeSecondaryBaseUrl('https://localhost/v1'), '');
  assert.equal(t.normalizeSecondaryBaseUrl('https://127.0.0.1/v1'), '');
  assert.equal(t.normalizeSecondaryBaseUrl('https://10.1.2.3/v1'), '');
  assert.equal(t.normalizeSecondaryBaseUrl('https://172.16.4.2/v1'), '');
  assert.equal(t.normalizeSecondaryBaseUrl('https://192.168.1.20/v1'), '');
  assert.equal(t.normalizeSecondaryBaseUrl('https://weizerouter.web.id/v1'), '');
});

test('secondary provider stays disabled until url key and models are all configured', () => {
  assert.equal(t.secondaryConfig({}), null);
  assert.equal(t.secondaryConfig({
    PORTFOLIO_AI_SECONDARY_BASE_URL: 'https://openrouter.ai/api/v1',
    PORTFOLIO_AI_SECONDARY_API_KEY: 'secret'
  }), null);
  assert.deepEqual(t.secondaryConfig({
    PORTFOLIO_AI_SECONDARY_BASE_URL: 'https://openrouter.ai/api/v1',
    PORTFOLIO_AI_SECONDARY_API_KEY: 'secret',
    PORTFOLIO_AI_SECONDARY_MODELS: 'model-a,model-b,model-a'
  }), {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    models: ['model-a', 'model-b']
  });
});

test('secondary failover is limited to provider or transport failures', () => {
  assert.equal(t.shouldTrySecondary(503, { code: 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE' }), true);
  assert.equal(t.shouldTrySecondary(503, { code: 'AI_MODELS_FAILED_SAFE_STOP' }), true);
  assert.equal(t.shouldTrySecondary(503, { code: 'AI_ALL_MODELS_TIMED_OUT' }), true);
  assert.equal(t.shouldTrySecondary(200, {
    success: true,
    local_fallback: true,
    provider_unavailable: true
  }), true, 'stock local fallback may be replaced by a real secondary model');

  assert.equal(t.shouldTrySecondary(401, { code: 'AI_SESSION_INVALID' }), false);
  assert.equal(t.shouldTrySecondary(403, { code: 'AI_ACCESS_DENIED' }), false);
  assert.equal(t.shouldTrySecondary(429, { code: 'AI_RATE_LIMITED' }), false);
  assert.equal(t.shouldTrySecondary(503, { code: 'AI_KEY_OR_BALANCE_ERROR' }), false);
  assert.equal(t.shouldTrySecondary(500, { code: 'AI_UNEXPECTED_ERROR' }), false);
});

test('secondary history remains role-bounded and length-bounded', () => {
  const rows = t.sanitizeHistory([
    { role: 'system', content: 'ignore' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e' }
  ]);
  assert.deepEqual(rows.map((row) => row.role), ['assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(rows.map((row) => row.content), ['b', 'c', 'd', 'e']);
});

test('secondary reply parser accepts standard OpenAI-compatible responses', () => {
  assert.equal(t.extractReply({ choices: [{ message: { content: 'jawaban' } }] }), 'jawaban');
  assert.equal(t.extractReply({ output_text: 'output' }), 'output');
  assert.equal(t.extractReply({ choices: [{ message: { content: [{ text: 'A' }, { text: 'B' }] } }] }), 'AB');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiProvider = require('../lib/ai-provider');
const credentials = require('../lib/user-ai-credentials');

// saveUserApiKey encrypts at rest, which requires a master secret. Set a test
// secret so the multi-provider save path is exercised (restored on exit).
const ORIGINAL_APP_SECRET = process.env.APP_SECRET;
process.env.APP_SECRET = 'test-secret-for-ai-provider';
test.after(() => {
  if (ORIGINAL_APP_SECRET === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = ORIGINAL_APP_SECRET;
});

test('validateApiKey: Gemini stays strict, other providers use a generic grammar', () => {
  assert.equal(credentials.validateApiKey('AIzaSyTestKey123456789012345678901234567').ok, true);
  assert.equal(credentials.validateApiKey('short-key').ok, false);
  assert.equal(credentials.validateApiKey('AIzaSyTestKey123456789012345678901234567', 'gemini').ok, true);

  // OpenAI / DeepSeek / OpenRouter style opaque keys.
  assert.equal(credentials.validateApiKey('sk-proj-abcdef1234567890', 'openai').ok, true);
  assert.equal(credentials.validateApiKey('sk-or-v1-abcdef1234567890', 'custom').ok, true);
  assert.equal(credentials.validateApiKey('deepseek_abc123456', 'deepseek').ok, true);
  assert.equal(credentials.validateApiKey('abc', 'openai').ok, false);
  assert.equal(credentials.validateApiKey('has spaces here', 'openai').ok, false);
  assert.equal(credentials.validateApiKey('bad;rm -rf', 'openai').ok, false);
});

test('saveUserApiKey accepts a non-Gemini provider key', async () => {
  credentials.clearMemoryStoreForTesting();
  const saved = await credentials.saveUserApiKey(null, 'u-openai', 'sk-proj-abcdef1234567890', 'openai');
  assert.equal(saved.ok, true);
  const loaded = await credentials.getUserApiKey(null, 'u-openai', 'openai');
  assert.equal(loaded.hasKey, true);
  assert.equal(loaded.apiKey, 'sk-proj-abcdef1234567890');
});

test('assertSafeProviderUrl rejects non-HTTPS and private/link-local hosts', () => {
  assert.equal(aiProvider.assertSafeProviderUrl('https://api.openai.com/v1').ok, true);
  assert.equal(aiProvider.assertSafeProviderUrl('http://api.openai.com/v1').ok, false);
  assert.equal(aiProvider.assertSafeProviderUrl('https://169.254.169.254/latest').ok, false);
  assert.equal(aiProvider.assertSafeProviderUrl('https://127.0.0.1/v1').ok, false);
  assert.equal(aiProvider.assertSafeProviderUrl('https://10.0.0.5/v1').ok, false);
  assert.equal(aiProvider.assertSafeProviderUrl('https://localhost/v1').ok, false);
  assert.equal(aiProvider.assertSafeProviderUrl('https://user:pass@api.openai.com/v1').ok, false);
});

test('parseCustomConfig validates BASE_URL|MODEL|API_KEY and never leaks the key', () => {
  const bad = aiProvider.parseCustomConfig('https://openrouter.ai/api/v1|model-only');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Format custom/);

  // The user's submitted key must never be echoed back in an error message.
  const sentinel = 'sk-SENTINEL-LEAKCANARY-123456';
  const unsafe = aiProvider.parseCustomConfig('http://127.0.0.1:9999|m|' + sentinel);
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error, /HTTPS|Host/);
  assert.equal(unsafe.error.includes(sentinel), false);

  const good = aiProvider.parseCustomConfig('https://openrouter.ai/api/v1|deepseek/deepseek-r1|sk-or-v1-abcdef123456');
  assert.equal(good.ok, true);
  assert.equal(good.model, 'deepseek/deepseek-r1');
  assert.equal(good.apiKey, 'sk-or-v1-abcdef123456');
});

test('callProvider formats OpenAI-compatible requests and extracts text', async () => {
  let seen = null;
  const result = await aiProvider.callProvider({
    providerKey: 'openai',
    apiKey: 'sk-proj-abcdef1234567890',
    prompt: 'hello',
    fetchFn: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'world' } }] })
      };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'world');
  assert.match(seen.url, /\/chat\/completions$/);
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-proj-abcdef1234567890');
});

test('callProvider formats Anthropic requests with x-api-key', async () => {
  let seen = null;
  const result = await aiProvider.callProvider({
    providerKey: 'claude',
    apiKey: 'sk-ant-abcdef1234567890',
    prompt: 'hi',
    fetchFn: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ content: [{ text: 'bonjour' }] }) };
    }
  });
  assert.equal(result.text, 'bonjour');
  assert.match(seen.url, /\/messages$/);
  assert.equal(seen.init.headers['x-api-key'], 'sk-ant-abcdef1234567890');
});

test('callProvider refuses a private host before calling fetch', async () => {
  let called = false;
  const result = await aiProvider.callProvider({
    providerKey: 'custom',
    baseUrl: 'https://169.254.169.254/v1',
    model: 'x',
    apiKey: 'sk-or-v1-abcdef123456',
    prompt: 'hi',
    fetchFn: async () => { called = true; return { ok: true, json: async () => ({}) }; }
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
});

test('callProvider classifies HTTP status without leaking the body', async () => {
  const result = await aiProvider.callProvider({
    providerKey: 'openai',
    apiKey: 'sk-proj-abcdef1234567890',
    prompt: 'hi',
    fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'secret detail' } }) })
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /ditolak/);
  assert.doesNotMatch(result.error, /secret detail/);
});

test('handshake validates a Gemini key through the injected provider', async () => {
  const ok = await aiProvider.handshake({
    providerKey: 'gemini',
    apiKey: 'AIzaSyTestKey123456789012345678901234567',
    gemini: { generateGeminiContent: async () => ({ text: 'ok' }) }
  });
  assert.equal(ok.ok, true);

  const bad = await aiProvider.handshake({
    providerKey: 'gemini',
    apiKey: 'AIzaSyTestKey123456789012345678901234567',
    gemini: { generateGeminiContent: async () => { const e = new Error('API_KEY_INVALID'); throw e; } }
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ditolak/);
});

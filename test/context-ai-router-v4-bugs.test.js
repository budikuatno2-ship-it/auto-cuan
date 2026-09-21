'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../lib/context-ai-router-v4');

test('BUG 1: extractReply returns empty string instead of fallback reasoning_content when content is ""', async () => {
  const origFetch = globalThis.fetch;
  router._test.resetState();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'Analisis teknikal BBCA bullish target 10500'
        }
      }]
    })
  });

  try {
    const outcome = await router._test.runModels({
      baseUrl: 'http://mock-ai.local',
      apiKey: 'mock-key',
      models: ['wz/deepseek-reasoner'],
      messages: [{ role: 'user', content: 'analisis BBCA' }],
      settings: { temperature: 0.2, maxTokens: 500 },
      perModel: 5000,
      totalLimit: 10000,
      source: 'stock_analysis_followup',
      task: 'heavy',
      userId: 'user-1'
    });

    assert.strictEqual(outcome.ok, true, 'runModels harus berhasil ketika model mengembalikan reasoning_content');
    assert.strictEqual(outcome.result.reply, 'Analisis teknikal BBCA bullish target 10500');
  } finally {
    globalThis.fetch = origFetch;
    router._test.resetState();
  }
});

test('BUG 2: priceFreshness gagal mencocokkan price_meta jika ticker memakai format IDX (.JK)', () => {
  const raw = {
    prices: { 'BBCA.JK': 9800 },
    price_meta: {
      'BBCA.JK': { at: '2025-05-01T10:00:00Z', age_minutes: 5, provider_marked_stale: false }
    },
    plans: [{ ticker: 'BBCA.JK', entry: 9000 }]
  };

  const ctx = router._test.portfolioContext(raw);

  assert.strictEqual(ctx.price_freshness.positions[0].age_minutes, 5, 'age_minutes harus terisi 5 menit');
  assert.deepStrictEqual(ctx.price_freshness.tickers_with_unknown_price_age, [], 'BBCA tidak boleh masuk tickers_with_unknown_price_age');
});

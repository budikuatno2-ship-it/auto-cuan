'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function rows(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function freshRequireV5() {
  delete require.cache[require.resolve('../lib/context-ai-router-v5')];
  return require('../lib/context-ai-router-v5');
}

test('validated healthy routes stay ahead of stale configured model ids', () => {
  const saved = {
    STOCK_ANALYSIS_AI_MODELS: process.env.STOCK_ANALYSIS_AI_MODELS,
    PORTFOLIO_AI_HEAVY_MODELS: process.env.PORTFOLIO_AI_HEAVY_MODELS,
    PORTFOLIO_AI_EMPATHY_MODELS: process.env.PORTFOLIO_AI_EMPATHY_MODELS,
    PORTFOLIO_AI_FAST_MODELS: process.env.PORTFOLIO_AI_FAST_MODELS
  };

  try {
    process.env.STOCK_ANALYSIS_AI_MODELS = 'wz/stale-stock-a,wz/stale-stock-b';
    process.env.PORTFOLIO_AI_HEAVY_MODELS = 'wz/stale-heavy-a,wz/stale-heavy-b';
    process.env.PORTFOLIO_AI_EMPATHY_MODELS = 'wz/stale-empathy-a';
    process.env.PORTFOLIO_AI_FAST_MODELS = 'wz/stale-fast-a';

    freshRequireV5();

    assert.deepEqual(rows(process.env.STOCK_ANALYSIS_AI_MODELS).slice(0, 4), [
      'wz/gemini-2.5-flash',
      'wz/claude-sonnet-4.6',
      'wz/gpt-5.6-luna',
      'wz/deepseek-v4-pro'
    ]);

    assert.deepEqual(rows(process.env.PORTFOLIO_AI_HEAVY_MODELS).slice(0, 4), [
      'wz/gemini-2.5-flash',
      'wz/claude-sonnet-4.6',
      'wz/gpt-5.6-luna',
      'wz/deepseek-v4-pro'
    ]);

    assert.deepEqual(rows(process.env.PORTFOLIO_AI_FAST_MODELS).slice(0, 4), [
      'wz/gemini-2.5-flash',
      'wz/claude-haiku-4.5',
      'wz/gpt-5.4-mini',
      'wz/gpt-5.6-luna'
    ]);

    assert.deepEqual(rows(process.env.PORTFOLIO_AI_EMPATHY_MODELS).slice(0, 4), [
      'wz/claude-sonnet-4.6',
      'wz/gemini-2.5-flash',
      'wz/claude-fable-5',
      'wz/gpt-5.6-luna'
    ]);

    assert.ok(rows(process.env.STOCK_ANALYSIS_AI_MODELS).includes('wz/stale-stock-a'));
    assert.ok(rows(process.env.PORTFOLIO_AI_HEAVY_MODELS).includes('wz/stale-heavy-a'));
  } finally {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    delete require.cache[require.resolve('../lib/context-ai-router-v5')];
  }
});

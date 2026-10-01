'use strict';

const test = require('node:test');
const assert = require('node:assert');
const narration = require('../lib/ai-narration');
const narrationPrompts = require('../lib/ai-narration-prompts');

test('BUG-NAR-01: narrateMonitorUpdate must not throw unhandled TypeError when evaluation is null', async () => {
  await assert.doesNotReject(async () => {
    await narration.narrateMonitorUpdate({ ticker: 'BBRI', entry1: 5000 }, null, null);
  }, /Cannot read properties of null/);
});

test('BUG-NAR-02: narrateMonitorUpdate must calculate profit_pct on TP1_HIT even when priceData is missing or last is 0', async () => {
  let capturedData = null;
  const originalBuildPrompt = narrationPrompts.buildNotePrompt;
  narrationPrompts.buildNotePrompt = (type, data) => {
    capturedData = data;
    return originalBuildPrompt(type, data);
  };

  try {
    const pick = { ticker: 'BBRI', entry1: 5000, tp1: 5500 };
    const evaluation = { status: 'TP1_HIT', note: 'TP1 hit reached' };
    await narration.narrateMonitorUpdate(pick, evaluation, null);

    assert.ok(capturedData, 'buildNotePrompt should have been invoked with prompt data');
    assert.strictEqual(capturedData.profit_pct, '10.00', 'profitPct requires lastPrice > 0 even when TP1/TP2 hit is determined by entry & target');
  } finally {
    narrationPrompts.buildNotePrompt = originalBuildPrompt;
  }
});

test('BUG-NAR-03: generateNote must not crash with TypeError when data is null', async () => {
  const prevEnabled = process.env.TELEGRAM_AI_NARRATION_ENABLED;
  const prevKey = process.env.GEMINI_API_KEY_PRIMARY;
  process.env.TELEGRAM_AI_NARRATION_ENABLED = 'true';
  process.env.GEMINI_API_KEY_PRIMARY = 'test-primary-key';

  try {
    await assert.doesNotReject(async () => {
      await narration.generateNote('new_signal', null);
    }, /Cannot read properties of null/);
  } finally {
    process.env.TELEGRAM_AI_NARRATION_ENABLED = prevEnabled;
    process.env.GEMINI_API_KEY_PRIMARY = prevKey;
  }
});

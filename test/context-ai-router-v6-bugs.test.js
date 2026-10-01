'use strict';

const test = require('node:test');
const assert = require('node:assert');
const handleContextAIV6 = require('../lib/context-ai-router-v6');

test('BUG-CR6-01: shouldUseLocalFallback must support AI_UNEXPECTED_ERROR from upstream router', () => {
  const { shouldUseLocalFallback } = handleContextAIV6._test;
  const req = {
    body: {
      source: 'stock_analysis_followup',
      context: {
        ticker: 'BBRI',
        analysis_text: 'Entry: 4500'
      }
    }
  };
  const payload = { code: 'AI_UNEXPECTED_ERROR', error: 'Provider crash' };
  const result = shouldUseLocalFallback(req, 500, payload);
  assert.strictEqual(result, true, 'shouldUseLocalFallback must return true for AI_UNEXPECTED_ERROR on status 500: false == true');
});

test('BUG-CR6-02: extractSnapshotFacts must not capture "2" as entry level when Entry 2 is present', () => {
  const { extractSnapshotFacts } = handleContextAIV6._test;
  const text = 'BBRI Analysis:\nEntry 2: 4400\nStop Loss: 4200';
  const facts = extractSnapshotFacts(text);
  assert.notStrictEqual(facts.entry, '2', 'facts.entry must not capture "2" from "Entry 2: 4400"');
});

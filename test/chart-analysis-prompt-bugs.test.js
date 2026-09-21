'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getChartAnalysisSystemPrompt } = require('../lib/chart-analysis-prompt');

test('BUG-CAP-01: getChartAnalysisSystemPrompt must strip .JK suffix instead of creating BBCAJK', () => {
  const prompt = getChartAnalysisSystemPrompt('BBCA.JK');
  assert.ok(
    prompt.includes('saham BBCA di Bursa'),
    `Prompt should contain "saham BBCA di Bursa", but was: ${prompt.slice(0, 300)}`
  );
  assert.ok(
    !prompt.includes('BBCAJK'),
    'Prompt must not contain corrupted ticker "BBCAJK"'
  );
});

test('BUG-CAP-02: getChartAnalysisSystemPrompt must fall back to SAHAM when ticker is whitespace or symbols', () => {
  const prompt = getChartAnalysisSystemPrompt('   ');
  assert.ok(
    prompt.includes('saham SAHAM di Bursa'),
    `Prompt should fall back to "saham SAHAM di Bursa" on whitespace, but was: ${prompt.slice(0, 300)}`
  );
});

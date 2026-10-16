'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateVisionAnalysisText,
  MANDATORY_SECTIONS,
  MANDATORY_DISCLAIMER_SUFFIX
} = require('../lib/chart-analysis-prompt.js');

test('FIX-16: validateVisionAnalysisText validates sections and appends disclaimer if missing', () => {
  assert.equal(typeof validateVisionAnalysisText, 'function', 'validateVisionAnalysisText must be exported');

  // 1. Empty text
  const emptyRes = validateVisionAnalysisText('');
  assert.equal(emptyRes.valid, false);
  assert.equal(emptyRes.sectionsValid, false);
  assert.equal(emptyRes.text, '');

  // 2. Partial text missing disclaimer and some sections
  const partialText = `## Tren Umum\nTren naik\n\n## Level Kunci yang Terlihat\nSupport 1000`;
  const partialRes = validateVisionAnalysisText(partialText);
  assert.equal(partialRes.sectionsValid, false);
  assert.ok(partialRes.missingSections.includes('## Pola Candlestick'));
  assert.ok(partialRes.text.endsWith(MANDATORY_DISCLAIMER_SUFFIX), 'Must automatically append mandatory disclaimer');

  // 3. Complete text with all 5 sections and disclaimer
  const fullText = MANDATORY_SECTIONS.map(s => `${s}\nUlasan untuk ${s}`).join('\n\n') + '\n\n' + MANDATORY_DISCLAIMER_SUFFIX;
  const fullRes = validateVisionAnalysisText(fullText);
  assert.equal(fullRes.sectionsValid, true);
  assert.equal(fullRes.missingSections.length, 0);
  assert.equal(fullRes.hasDisclaimer, true);
  assert.equal(fullRes.text, fullText);
});

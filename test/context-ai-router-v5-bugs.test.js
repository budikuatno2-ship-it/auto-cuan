'use strict';

const test = require('node:test');
const assert = require('node:assert');
const handleContextAIV5 = require('../lib/context-ai-router-v5');
const { allPrimaryFailuresAreTemporary, redactDiagnostic } = handleContextAIV5._weizeCompat;

test('BUG-CR5-01: allPrimaryFailuresAreTemporary must require at least 2 distinct models', () => {
  const payload = {
    code: 'AI_MODELS_FAILED_SAFE_STOP',
    attempted_models: ['wz/gpt-5.6-luna', 'wz/gpt-5.6-luna']
  };
  const trace = {
    rejections: [
      { model: 'wz/gpt-5.6-luna', provider_host: 'weizerouter.web.id', temporary_unavailable: true }
    ]
  };
  const result = allPrimaryFailuresAreTemporary(payload, trace);
  assert.strictEqual(
    result,
    false,
    'allPrimaryFailuresAreTemporary must return false when only 1 distinct model was attempted'
  );
});

test('BUG-CR5-02: redactDiagnostic must redact Google Gemini API keys (AIza...)', () => {
  const text = 'Provider rejected key AIzaSyD-12345678901234567890: quota exceeded';
  const redacted = redactDiagnostic(text);
  assert.ok(
    !redacted.includes('AIzaSyD-12345678901234567890'),
    'Gemini API key (AIza...) must be redacted from diagnostic logs'
  );
});

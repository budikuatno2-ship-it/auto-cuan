'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function loadRenderer() {
  const code = fs.readFileSync('public/ai-chat-renderer.js', 'utf8');
  const sandbox = {
    window: {},
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ appendChild: () => {}, querySelectorAll: () => [] })
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.AutoCuanAI;
}

test('BUG-ACR-01: normalizeSpacing corrupts floating-point numbers without leading zero (.382 -> . 382)', () => {
  const AutoCuanAI = loadRenderer();
  const input = 'Area beli terbaik di .382 Fib retracement atau .5% di bawah harga.';
  const output = AutoCuanAI.friendlyText(input);

  // Line 72: `.replace(/(^|[^0-9])\.([0-9])/g, '$1. $2')` incorrectly injects space after dot
  assert.ok(!output.includes('. 382'), 'Decimal without leading zero (.382) must not have space inserted');
  assert.ok(!output.includes('. 5%'), 'Percentage without leading zero (.5%) must not have space inserted');
});

test('BUG-PAIR-01: classifyFailure in portfolio-ai-runtime-v2.js masks QUOTA_EXCEEDED with rate-limit text', () => {
  const code = fs.readFileSync('public/portfolio-ai-runtime-v2.js', 'utf8');
  const match = code.match(/function classifyFailure\(response, data, error\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'classifyFailure must be found in portfolio-ai-runtime-v2.js');

  const classifyFailure = new Function('response', 'data', 'error', match[0] + '\nreturn classifyFailure(response, data, error);');
  const quotaErrorData = {
    code: 'QUOTA_EXCEEDED',
    error: 'Batas kuota harian Anda telah tercapai (10/10 analisis hari ini). Kuota akan direset pada pukul 00:00 WIB.'
  };

  const result = classifyFailure({ status: 429 }, quotaErrorData, null);
  // Current bug: `if (status === 429 || code === 'AI_RATE_LIMITED')` matches status 429 and displays rate limit message
  assert.strictEqual(
    result.status,
    quotaErrorData.error,
    'classifyFailure must display quota exceeded error message instead of rate limit message'
  );
});

test('BUG-SAI-01: describeFailure in stock-analysis-ai.js masks QUOTA_EXCEEDED with rate-limit text', () => {
  const code = fs.readFileSync('public/stock-analysis-ai.js', 'utf8');
  const match = code.match(/function describeFailure\(response, data, error\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'describeFailure must be found in stock-analysis-ai.js');

  const describeFailure = new Function('response', 'data', 'error', match[0] + '\nreturn describeFailure(response, data, error);');
  const quotaErrorData = {
    code: 'QUOTA_EXCEEDED',
    error: 'Batas kuota harian Anda telah tercapai (10/10 analisis hari ini).'
  };

  const result = describeFailure({ status: 429 }, quotaErrorData, null);
  assert.strictEqual(
    result.text,
    quotaErrorData.error,
    'describeFailure must display quota exceeded error message instead of rate limit message'
  );
});

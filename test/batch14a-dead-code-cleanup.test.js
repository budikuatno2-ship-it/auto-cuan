'use strict';

// Batch 14A — dead-code / dangling-function cleanup regression.
//
// Every assertion locks the POST-fix state so the removed dead code and the
// fixed latent bugs cannot silently come back:
//   F-006  context-ai-router-v4 CATALOG is env-overridable (single source)
//   F-011  no duplicate `var items` in bandarmologi-runtime buildBrokerBubbleItems
//   F-057  ticker-mode reports the provider that actually answered
//   F-061  explicitRatio dead variable removed
//   F-062  handleChartVision returns null on failure (not error HTML)
//   F-063  geminiSearchNews dead function removed
//   F-074  no undeclared nodeToMove in stock-analysis-ai mountRankingCardOnOwnPage
//   F-077  sendForeignFlowRecap uses the exported sendTelegramMessage

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('F-063: geminiSearchNews dead function is gone', () => {
  const src = read('lib/analyze-legacy.js');
  assert.doesNotMatch(src, /function\s+geminiSearchNews/);
});

test('F-062: handleChartVision returns null on failure rather than error HTML', () => {
  const src = read('lib/analyze-legacy.js');
  const start = src.indexOf('async function handleChartVision');
  assert.notEqual(start, -1, 'handleChartVision must still exist');
  const end = src.indexOf('\nasync function', start + 10);
  const body = src.slice(start, end === -1 ? src.length : end);
  // No branch may hand back a user-facing error string — failure must be null so
  // the caller (not the vision helper) owns the fallback message and provider label.
  assert.doesNotMatch(body, /return '<p class="text-sm/, 'failure branches must return null, not HTML');
  assert.match(body, /return null;/);
});

test('F-057: ticker-mode provider is tracked, not a constant deepseek label', () => {
  const src = read('lib/analyze-legacy.js');
  assert.doesNotMatch(src, /provider:\s*tHtml \? 'deepseek' : 'gemini-fallback'/);
  assert.match(src, /tProvider\s*=\s*'deepseek'/);
  assert.match(src, /tProvider\s*=\s*'gemini'/);
  assert.match(src, /provider:\s*tProvider/);
});

test('F-061: dead ratio variable removed from parseMatchedNumber', () => {
  const src = read('lib/ai-answer-contract.js');
  const start = src.indexOf('function parseMatchedNumber');
  assert.notEqual(start, -1);
  const end = src.indexOf('\nfunction ', start + 10);
  const body = src.slice(start, end === -1 ? src.length : end);
  // The dead `explicitRatio` local was removed here. (financialNumbersInText keeps
  // its own live `explicitRatio`; that is out of scope for F-061.)
  assert.doesNotMatch(body, /explicitRatio/, 'the unused local must not come back');
});

test('F-011: buildBrokerBubbleItems declares `var items` exactly once', () => {
  const src = read('public/bandarmologi-runtime.js');
  const start = src.indexOf('function buildBrokerBubbleItems');
  assert.notEqual(start, -1);
  const end = src.indexOf('\n  function ', start + 10);
  const body = src.slice(start, end === -1 ? start + 4000 : end);
  const decls = body.match(/var\s+items\s*=\s*\[\]/g) || [];
  assert.equal(decls.length, 1, 'duplicate `var items` redeclaration must not return');
});

test('F-074/F-075: mountRankingCardOnOwnPage has no undeclared nodeToMove and guards card', () => {
  const src = read('public/stock-analysis-ai.js');
  const start = src.indexOf('function mountRankingCardOnOwnPage');
  assert.notEqual(start, -1);
  let depth = 0;
  let bodyStart = -1;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') { if (depth === 0) bodyStart = i + 1; depth += 1; }
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(bodyStart, end);
  assert.doesNotMatch(body, /\bnodeToMove\b/, 'undeclared nodeToMove reference must not return');
  // Every card.style write must sit inside the `if (card)` guard: the text before
  // the first real write must already have opened the guard.
  const firstWrite = body.indexOf('card.style.background');
  assert.notEqual(firstWrite, -1, 'expected card styling to remain');
  assert.match(body.slice(0, firstWrite), /if\s*\(card\)\s*\{/, 'card.style writes must be inside the null guard');
});

test('F-077: sendForeignFlowRecap calls the exported sendTelegramMessage', () => {
  const src = read('lib/foreign-flow-recap.js');
  assert.doesNotMatch(src, /telegramNotifier\.sendMessage\b/, 'sendMessage is not exported by the notifier');
  assert.match(src, /telegramNotifier\.sendTelegramMessage\(/);
  // Sanity: the notifier really exports that name.
  const notifier = require('../lib/telegram-notifier.js');
  assert.equal(typeof notifier.sendTelegramMessage, 'function');
  assert.equal(notifier.sendMessage, undefined);
});

test('F-006: the WeizeRouter catalog is env-overridable from a single default source', () => {
  const src = read('lib/context-ai-router-v4.js');
  assert.match(src, /const\s+DEFAULT_CATALOG\s*=/);
  assert.match(src, /function\s+catalogFromEnv\s*\(/);
  assert.match(src, /process\.env\.WEIZEROUTER_CATALOG/);
  assert.match(src, /const\s+CATALOG\s*=\s*catalogFromEnv\(\)/);
});

test('F-006: catalogFromEnv honours WEIZEROUTER_CATALOG and falls back to the default', () => {
  const router = require('../lib/context-ai-router-v4.js');
  const { catalogFromEnv } = router._test;
  assert.equal(typeof catalogFromEnv, 'function');
  const original = process.env.WEIZEROUTER_CATALOG;
  try {
    delete process.env.WEIZEROUTER_CATALOG;
    const fallback = catalogFromEnv();
    assert.ok(Array.isArray(fallback) && fallback.length > 0);
    assert.ok(fallback.includes('wz/deepseek-v4-pro'));

    process.env.WEIZEROUTER_CATALOG = 'wz/alpha,wz/beta';
    assert.deepEqual(catalogFromEnv(), ['wz/alpha', 'wz/beta']);
  } finally {
    if (original == null) delete process.env.WEIZEROUTER_CATALOG;
    else process.env.WEIZEROUTER_CATALOG = original;
  }
});
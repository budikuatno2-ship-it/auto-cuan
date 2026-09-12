'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contextAiRouterV7 = require('../lib/context-ai-router-v7');
const geminiProvider = require('../lib/ai-gemini-provider');
const credentials = require('../lib/user-ai-credentials');
const chartService = require('../lib/chart-analysis-service');

const ROOT_DIR = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');
const aiChatRendererJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ai-chat-renderer.js'), 'utf8');
const chartAnalysisRuntimeJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'chart-analysis-runtime.js'), 'utf8');

test.beforeEach(() => {
  credentials.clearMemoryStoreForTesting();
  chartService.clearMemoryStoresForTesting();
});

// ===========================================================================
// CLUSTER 5 - TEST SUITE: AI VISION BYOK & UNIFIED COCKPIT INTEGRITY
// PRs: #505, #512, #525, #527, #528, #529, #537
// ===========================================================================

// --- 1. PR #505: Cross-User Portfolio AI Cache Isolation ---
test('PR #505: buildCacheParams isolates private portfolio cache across users', () => {
  const { buildCacheParams, stableSerialize } = contextAiRouterV7._test;
  assert.ok(typeof buildCacheParams === 'function', 'buildCacheParams must be exported for test');

  const baseIdentity = {
    ticker: 'BBCA',
    analysisType: 'portfolio_chat',
    prompt: 'Apakah posisi saya aman untuk di-hold?',
    marketDate: '2026-09-12'
  };

  const userPortfolioA = {
    cash: 50000000,
    holdings: [{ ticker: 'BBCA', avgPrice: 9500, lots: 100 }]
  };

  const userPortfolioB = {
    cash: 10000000,
    holdings: [{ ticker: 'BBCA', avgPrice: 10200, lots: 20 }]
  };

  // User A cache params
  const paramsA = buildCacheParams(baseIdentity, 'portfolio_chat', userPortfolioA, 'Gaya agresif');
  // User B cache params with different holdings
  const paramsB = buildCacheParams(baseIdentity, 'portfolio_chat', userPortfolioB, 'Gaya agresif');

  assert.ok(paramsA.extra && paramsA.extra.ctx, 'User A params must contain extra.ctx digest');
  assert.ok(paramsB.extra && paramsB.extra.ctx, 'User B params must contain extra.ctx digest');
  assert.notEqual(paramsA.extra.ctx, paramsB.extra.ctx, 'Different portfolios must produce distinct cache digests');

  // Same context with different key order must generate identical digest (stableSerialize)
  const portfolioReordered = {
    holdings: [{ avgPrice: 9500, ticker: 'BBCA', lots: 100 }],
    cash: 50000000
  };
  const paramsReordered = buildCacheParams(baseIdentity, 'portfolio_chat', portfolioReordered, 'Gaya agresif');
  assert.equal(paramsA.extra.ctx, paramsReordered.extra.ctx, 'Reordered keys must yield identical digest');

  // Public sources (stock_analysis) should NOT generate private extra.ctx
  const publicParams = buildCacheParams({ ...baseIdentity, analysisType: 'stock_analysis' }, 'stock_analysis', userPortfolioA);
  assert.equal(publicParams.extra, undefined, 'Public stock_analysis must not include private extra.ctx');

  // Unserializable context (circular reference) must fail closed to unserialisable-UUID
  const circularContext = {};
  circularContext.self = circularContext;
  const failClosedParams = buildCacheParams(baseIdentity, 'portfolio_chat', circularContext);
  assert.ok(failClosedParams.extra && failClosedParams.extra.ctx.startsWith('unserialisable-'),
    'Unserializable context must fail closed to unique random miss token');
});

// --- 2. PR #512: Gemini Provider Timeout & Abort Cleanups ---
test('PR #512: generateGeminiContent validates API key and handles abort timeout', async () => {
  // Reject missing API key immediately
  await assert.rejects(
    async () => {
      await geminiProvider.generateGeminiContent({ apiKey: '' });
    },
    { code: 'GEMINI_API_KEY_MISSING' }
  );

  // Verify AbortController timeout execution
  await assert.rejects(
    async () => {
      await geminiProvider.generateGeminiContent({
        apiKey: 'AIzaSyTestKey123456789012345678901234567',
        fetchFn: (url, opts) => {
          return new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          });
        },
        timeoutMs: 50
      });
    },
    (err) => {
      assert.equal(err.code, 'GEMINI_TIMEOUT');
      assert.ok(err.message.includes('GEMINI_TIMEOUT after 50ms'));
      return true;
    }
  );
});

// --- 3. PR #537: Model Deprecation Guard & Safe Routing ---
test('PR #537: sanitizeGeminiModel rejects deprecated models and defaults to modern models', () => {
  const { sanitizeGeminiModel, DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL } = geminiProvider;

  // Defaults
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  assert.equal(FALLBACK_GEMINI_MODEL, 'gemini-3.1-flash-lite');

  // Deprecated models must be redirected to fallback
  const deprecated = [
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3-flash',
    'gemini-3.0-flash',
    'gemini-3.1-flash'
  ];

  for (const m of deprecated) {
    assert.equal(
      sanitizeGeminiModel(m, 'gemini-3.8-flash'),
      'gemini-3.8-flash',
      `Deprecated model ${m} must be sanitized to default`
    );
  }

  // Modern models must be preserved
  assert.equal(sanitizeGeminiModel('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModel('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  assert.equal(sanitizeGeminiModel('gemini-exp-1206'), 'gemini-exp-1206');

  // Empty or whitespace returns fallback
  assert.equal(sanitizeGeminiModel('', 'gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModel('   ', 'gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModel(null, 'gemini-3.8-flash'), 'gemini-3.8-flash');
});

// --- 4. PR #525 & #527: BYOK Security: AES-256-GCM, Tamper-Resistance, Validation & Quota ---
test('PR #525 & #527: BYOK AES-256-GCM encryption, format validation, and tamper-resistance', () => {
  const sampleKeyAIza = 'AIzaSyA_SampleTestKey_ForUserA_12345678';
  const sampleKeyAQ = 'AQ.AbCdEf1234567890_test.key.format';

  // Format validation
  assert.equal(credentials.validateApiKey(sampleKeyAIza).ok, true);
  assert.equal(credentials.validateApiKey(sampleKeyAQ).ok, true);
  assert.equal(credentials.validateApiKey('invalid-key-short').ok, false);
  assert.equal(credentials.validateApiKey('AIzaSy with spaces').ok, false);

  // Masking
  assert.equal(credentials.maskApiKey(sampleKeyAIza), '•••• •••• 5678');
  assert.equal(credentials.maskApiKey(sampleKeyAQ), '•••• •••• rmat');

  // Symmetrical AES-256-GCM encryption & decryption roundtrip
  const encrypted = credentials.encryptApiKey(sampleKeyAIza);
  assert.ok(encrypted.startsWith('v1:'), 'Encrypted key must have v1: prefix');
  assert.ok(!encrypted.includes(sampleKeyAIza), 'Encrypted key must not contain plain text');

  const decrypted = credentials.decryptApiKey(encrypted);
  assert.equal(decrypted, sampleKeyAIza, 'Decrypted key must match original');

  // Tamper detection: modifying tag or payload returns null without throwing
  const parts = encrypted.split(':');
  parts[2] = 'ffff' + parts[2].slice(4); // Alter IV/tag
  const tampered = parts.join(':');
  assert.equal(credentials.decryptApiKey(tampered), null, 'Tampered ciphertext must fail authentication and return null');
});

test('PR #525 & #527: Quota Tiering and Unified AI Quota Guard', async () => {
  // Free tier
  const freeTier = chartService.resolveUserTier({ premium: false });
  assert.equal(freeTier.tier, 'free');
  assert.equal(freeTier.maxDaily, 3);

  // Premium tier
  const premTier = chartService.resolveUserTier({ premium: true });
  assert.equal(premTier.tier, 'premium');
  assert.equal(premTier.maxDaily, 10);

  // Lifetime tier
  const lifeTier = chartService.resolveUserTier({ user: { username: 'budi', isAdmin: true } });
  assert.equal(lifeTier.tier, 'lifetime');
  assert.equal(lifeTier.maxDaily, Infinity);

  // Unified quota enforcement
  const mockAccessFree = { ok: true, user: { id: 'test-user-quota', username: 'tester' }, premium: false };
  const wibDate = chartService.getWibDateString();

  // Usage at 0
  let quotaCheck = await chartService.checkUnifiedAiQuota(null, mockAccessFree);
  assert.equal(quotaCheck.ok, true);
  assert.equal(quotaCheck.quota.remaining, 3);

  // Increment usage to max (3)
  await chartService.incrementUserUsage(null, 'test-user-quota', wibDate);
  await chartService.incrementUserUsage(null, 'test-user-quota', wibDate);
  await chartService.incrementUserUsage(null, 'test-user-quota', wibDate);

  // 4th request must be rejected with 429 QUOTA_EXCEEDED
  quotaCheck = await chartService.checkUnifiedAiQuota(null, mockAccessFree);
  assert.equal(quotaCheck.ok, false);
  assert.equal(quotaCheck.status, 429);
  assert.equal(quotaCheck.code, 'QUOTA_EXCEEDED');
  assert.ok(quotaCheck.error.includes('Batas kuota harian') || quotaCheck.error.includes('Kuota harian AI Anda'));
});

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// --- 5. PR #528 & #529: Markdown Rendering, Tone Normalization, and XSS Sanitization ---
test('PR #528 & #529: AI Chat and Chart Vision Renderers escape XSS payloads and normalize tone', () => {
  // Extract functions from public/chart-analysis-runtime.js
  const escapeHtmlCode = extractFunction(chartAnalysisRuntimeJs, 'function escapeHtml(');
  const inlineMarkdownCode = extractFunction(chartAnalysisRuntimeJs, 'function inlineMarkdown(');
  const formatAnalysisCode = extractFunction(chartAnalysisRuntimeJs, 'function formatAnalysisText(');

  const chartSandbox = { String };
  vm.createContext(chartSandbox);
  vm.runInContext(escapeHtmlCode + '\n' + inlineMarkdownCode + '\n' + formatAnalysisCode, chartSandbox);
  const inlineMarkdown = chartSandbox.inlineMarkdown;
  const formatAnalysisText = chartSandbox.formatAnalysisText;

  assert.ok(typeof inlineMarkdown === 'function', 'inlineMarkdown must be defined');

  // Test XSS Neutralization
  const maliciousInput = '<img src=x onerror=alert(1)> **Target Support:** 9500 <script>alert(2)</script>';
  const rendered = inlineMarkdown(maliciousInput);
  assert.ok(!rendered.includes('<img'), 'Raw img tag must be escaped');
  assert.ok(!rendered.includes('<script'), 'Raw script tag must be escaped');
  assert.ok(rendered.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(rendered.includes('<strong>Target Support:</strong>'));

  // Test formatAnalysisText structured sections
  const sectionText = '## Tren Utama\nSideways akumulasi.\n- Entry 9500\n- TP 10000';
  const htmlOutput = formatAnalysisText(sectionText);
  assert.ok(htmlOutput.includes('📈') && htmlOutput.includes('Tren Utama'));
  assert.ok(htmlOutput.includes('<li'));
  assert.ok(htmlOutput.includes('Entry 9500'));

  // Extract functions from public/ai-chat-renderer.js
  const escapeChatCode = extractFunction(aiChatRendererJs, 'function escapeHtml(');
  const normalizeToneCode = extractFunction(aiChatRendererJs, 'function normalizeTone(');
  const inlineFormatCode = extractFunction(aiChatRendererJs, 'function inlineFormat(');

  const chatSandbox = { String };
  vm.createContext(chatSandbox);
  vm.runInContext(escapeChatCode + '\n' + normalizeToneCode + '\n' + inlineFormatCode, chatSandbox);
  const normalizeTone = chatSandbox.normalizeTone;
  const inlineFormat = chatSandbox.inlineFormat;

  assert.ok(typeof normalizeTone === 'function', 'normalizeTone must be defined');
  assert.ok(typeof inlineFormat === 'function', 'inlineFormat must be defined');

  // Tone Normalization
  const slangInput = 'Bro, lo jangan buru-buru nangkap pisau karena BBCA terjun bebas kemarin.';
  const normalized = normalizeTone(slangInput);
  assert.ok(!normalized.includes('Bro'), 'Bro slang removed');
  assert.ok(normalized.includes('Anda'), 'lo converted to Anda');
  assert.ok(normalized.includes('masuk sebelum ada konfirmasi pantulan'), 'nangkap pisau converted');
  assert.ok(normalized.includes('mengalami penurunan tajam'), 'terjun bebas converted');

  // Inline format escaping
  const xssChat = '`code` and <svg onload="alert(1)"> and **bold**';
  const formattedChat = inlineFormat(xssChat);
  assert.ok(formattedChat.includes('<code>code</code>'));
  assert.ok(formattedChat.includes('<strong>bold</strong>'));
  assert.ok(!formattedChat.includes('<svg onload'));
  assert.ok(formattedChat.includes('&lt;svg onload=&quot;alert(1)&quot;&gt;'));
});

// --- 6. PR #528: Unified Cockpit DOM Layout Integrity ---
test('PR #528: Unified Cockpit HTML preserves 2-column layout and all companion components', () => {
  // Page container & grid
  assert.ok(indexHtml.includes('id="page-analisis"'), '#page-analisis must exist');
  assert.ok(indexHtml.includes('class="unified-cockpit-grid"'), '.unified-cockpit-grid must exist');
  assert.ok(indexHtml.includes('class="unified-primary-col"'), '.unified-primary-col must exist');
  assert.ok(indexHtml.includes('class="unified-chat-col"'), '.unified-chat-col must exist');

  // Both subtabs exist: Text Analysis & Vision Analysis
  assert.ok(indexHtml.includes('id="tabAnalisisText"'), '#tabAnalisisText must exist');
  assert.ok(indexHtml.includes('id="tabAnalisisVision"'), '#tabAnalisisVision must exist');
  assert.ok(indexHtml.includes('id="panelAnalisisText"'), '#panelAnalisisText must exist');
  assert.ok(indexHtml.includes('id="panelAnalisisVision"'), '#panelAnalisisVision must exist');

  // Ticker synchronization badge & tag
  assert.ok(indexHtml.includes('id="unifiedActiveTickerBadge"'), '#unifiedActiveTickerBadge must exist in top bar');
  assert.ok(indexHtml.includes('id="chatActiveTickerTag"'), '#chatActiveTickerTag must exist in chat companion');

  // Standalone Chart page (#page-chart) remains preserved
  assert.ok(indexHtml.includes('id="page-chart"'), '#page-chart must be preserved for dedicated chart analysis');
});

'use strict';

// ===========================================================================
// Regression: Gemini model names must come from ONE source of truth.
//
// Pre-fix, deprecated model literals were duplicated and drifted:
//   lib/ai-narration.js        defaulted to 'gemini-3-flash' (deprecated/404)
//   api/quote.js               had its own 3-name skip-list
//   lib/analyze-legacy.js      had the SAME list copied 4x
//   lib/context-ai-router-v7.js hardcoded 'gemini-3.6-flash' as a safety net
//
// lib/ai-gemini-provider.js is authoritative. These tests assert (a) the helper
// rewrites every deprecated name, (b) narration resolves its model through it,
// (c) the API key fallback chain works, and (d) no consumer reintroduces a
// hardcoded deprecated literal.
//
// LOCAL / STATIC ONLY. No network.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const provider = require('../lib/ai-gemini-provider');
const narration = require('../lib/ai-narration');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const DEPRECATED = Array.from(provider.DEPRECATED_GEMINI_MODELS);

test('sanitizeGeminiModel rewrites EVERY deprecated name to a valid default', () => {
  assert.ok(DEPRECATED.length >= 7, 'deprecated list should be populated');
  for (const name of DEPRECATED) {
    assert.equal(
      provider.sanitizeGeminiModel(name),
      provider.DEFAULT_GEMINI_MODEL,
      'deprecated ' + name + ' must map to the default'
    );
  }
  assert.ok(!provider.DEPRECATED_GEMINI_MODELS.has(provider.DEFAULT_GEMINI_MODEL));
});

test('sanitizeGeminiModel keeps a live custom model and falls back when blank', () => {
  assert.equal(provider.sanitizeGeminiModel('gemini-9.9-flash'), 'gemini-9.9-flash');
  assert.equal(provider.sanitizeGeminiModel(''), provider.DEFAULT_GEMINI_MODEL);
  assert.equal(provider.sanitizeGeminiModel('   '), provider.DEFAULT_GEMINI_MODEL);
  assert.equal(provider.sanitizeGeminiModel(null), provider.DEFAULT_GEMINI_MODEL);
});

test('SAFETY_NET_GEMINI_MODEL is itself a non-deprecated model', () => {
  assert.ok(provider.SAFETY_NET_GEMINI_MODEL);
  assert.ok(!provider.DEPRECATED_GEMINI_MODELS.has(provider.SAFETY_NET_GEMINI_MODEL));
});

test('narration getModel never returns a deprecated model', () => {
  const original = process.env.GEMINI_MODEL;
  try {
    process.env.GEMINI_MODEL = 'gemini-3-flash';
    assert.equal(narration.getModel(), provider.DEFAULT_GEMINI_MODEL);
  } finally {
    if (original === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = original;
  }
});

test('getGeminiApiKey resolves PRIMARY, then portfolio, then GEMINI_API_KEY', () => {
  const saved = {
    p: process.env.GEMINI_API_KEY_PRIMARY,
    a: process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO,
    g: process.env.GEMINI_API_KEY
  };
  const restore = () => {
    const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    set('GEMINI_API_KEY_PRIMARY', saved.p);
    set('API_KEY_ANALISA_SAHAM_PORTOFOLIO', saved.a);
    set('GEMINI_API_KEY', saved.g);
  };
  try {
    delete process.env.GEMINI_API_KEY_PRIMARY;
    delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    delete process.env.GEMINI_API_KEY;
    assert.equal(provider.getGeminiApiKey(), null);

    process.env.GEMINI_API_KEY = 'g-key';
    assert.equal(provider.getGeminiApiKey(), 'g-key');

    process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'portfolio-key';
    assert.equal(provider.getGeminiApiKey(), 'portfolio-key');

    process.env.GEMINI_API_KEY_PRIMARY = 'primary-key';
    assert.equal(provider.getGeminiApiKey(), 'primary-key');
  } finally {
    restore();
  }
});

test('consumers contain no hardcoded deprecated model or hardcoded safety-net literal', () => {
  const quote = read('api/quote.js');
  const analyze = read('lib/analyze-legacy.js');
  const router = read('lib/context-ai-router-v7.js');
  const narrationSrc = read('lib/ai-narration.js');
  const chartUi = read('public/chart-analysis-runtime.js');

  // The old ad-hoc skip-lists recycled 'gemini-3-flash' as a comparison literal.
  for (const [file, src] of [['api/quote.js', quote], ['lib/analyze-legacy.js', analyze]]) {
    assert.ok(!src.includes("!== 'gemini-3-flash'"), file + ' must not re-declare the skip-list');
    assert.ok(!src.includes("!== 'gemini-2.5-flash'"), file + ' must not re-declare the skip-list');
  }
  assert.ok(!router.includes('gemini-3.6-flash'), 'router must not hardcode the safety-net model');
  assert.ok(!narrationSrc.includes("|| 'gemini-3-flash'"), 'narration must not default to a deprecated model');
  assert.ok(!chartUi.includes('Gemini 2.5 Flash'), 'chart UI must not fall back to a hardcoded model label');
});

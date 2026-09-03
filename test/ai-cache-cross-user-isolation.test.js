'use strict';

/**
 * Cross-user isolation of the AI response cache.
 *
 * The Portfolio AI answer is generated from the ASKING USER's own holdings —
 * tickers, entry prices, lots, capital, estimated max loss and journal entries
 * (portfolioContext, lib/context-ai-router-v4.js:646). lib/context-ai-router-v7.js
 * then stores that answer in a cache that is shared by every user: the Supabase
 * table `ai_analysis_cache`, plus a process-level Map in lib/ai-analysis-cache.js.
 *
 * The cache key must therefore depend on the portfolio the answer was computed
 * from. If it does not, two users who ask the same question on the same day
 * collide on one entry and the second user is served an answer derived from the
 * first user's portfolio.
 *
 * These tests drive the real handler end to end (Gemini stubbed at the provider
 * boundary, no Supabase) and assert the isolation property itself — not any
 * particular keying scheme. Any key that separates two different portfolios
 * passes.
 */

const test = require('node:test');
const assert = require('node:assert');

// Stub the provider BEFORE the router is required: the router destructures these
// functions at require time, so the patch has to land on the cached module first.
const provider = require('../lib/ai-gemini-provider');
provider.getGeminiApiKey = () => 'test-key-not-a-real-credential';
let nextGeminiReply = '';
provider.generateGeminiContent = async () => ({ text: nextGeminiReply, model: 'stub-model' });
provider.streamGeminiAnalysis = async (opts) => {
  if (opts && typeof opts.onChunk === 'function') opts.onChunk(nextGeminiReply);
  return { text: nextGeminiReply, model: 'stub-model' };
};

const cache = require('../lib/ai-analysis-cache');
const handleContextAIV7 = require('../lib/context-ai-router-v7');

const QUESTION = 'Tolong evaluasi portofolio saya.';
const CAPTURED_AT = '2026-09-03T02:00:00.000Z';

const PORTFOLIO_A = {
  captured_at: CAPTURED_AT,
  plans: [{ ticker: 'BBCA', entryPriceIdr: 9500, stopLossIdr: 9200, tp1Idr: 10000, lots: 10, capitalIdr: 95000000 }],
  prices: { BBCA: 9600 }
};

const PORTFOLIO_B = {
  captured_at: CAPTURED_AT,
  plans: [{ ticker: 'GOTO', entryPriceIdr: 62, stopLossIdr: 58, tp1Idr: 70, lots: 4000, capitalIdr: 24800000 }],
  prices: { GOTO: 64 }
};

/** Minimal res double capturing what the handler sends. */
function fakeRes() {
  const state = { statusCode: 200, payload: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = payload; return this; },
    send(payload) { state.payload = payload; return this; },
    end(payload) { if (payload !== undefined) state.payload = payload; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; }
  };
}

/**
 * Run one portfolio_chat request through the real handler.
 * `reply` is what the (stubbed) model would answer for THIS user.
 */
async function ask(context, reply, question) {
  nextGeminiReply = reply;
  const res = fakeRes();
  await handleContextAIV7(
    { body: { source: 'portfolio_chat', chatMessage: question || QUESTION, context } , headers: {} },
    res
  );
  return res.state.payload || {};
}

/** Isolate every test from the others and from any real environment. */
function isolate(t) {
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    legacy: process.env.PORTFOLIO_AI_API_KEY,
    disabled: process.env.GEMINI_AI_DISABLED
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  delete process.env.GEMINI_AI_DISABLED;
  cache.clearMemoryCache();
  t.after(() => {
    cache.clearMemoryCache();
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    if (saved.legacy === undefined) delete process.env.PORTFOLIO_AI_API_KEY; else process.env.PORTFOLIO_AI_API_KEY = saved.legacy;
    if (saved.disabled === undefined) delete process.env.GEMINI_AI_DISABLED; else process.env.GEMINI_AI_DISABLED = saved.disabled;
  });
}

test('1. the stub wiring works: a first ask reaches the model, not the cache', async (t) => {
  isolate(t);
  const a = await ask(PORTFOLIO_A, 'ANSWER-FOR-A');
  assert.strictEqual(a.reply, 'ANSWER-FOR-A');
  assert.notStrictEqual(a.cache_hit, true, 'a cold cache must not report a hit');
});

test('2. the same user asking twice is served from the cache (the cache still works)', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'ANSWER-FOR-A');
  const again = await ask(PORTFOLIO_A, 'THE-MODEL-WAS-CALLED-AGAIN');
  assert.strictEqual(again.reply, 'ANSWER-FOR-A', 'an identical repeat ask must hit the cache');
  assert.strictEqual(again.cache_hit, true);
});

test('3. user B is NOT served the answer computed from user A portfolio', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'BBCA 10 lot, risiko maksimal Rp3.000.000.');
  const b = await ask(PORTFOLIO_B, 'GOTO 4000 lot, risiko maksimal Rp1.600.000.');
  assert.strictEqual(
    b.reply, 'GOTO 4000 lot, risiko maksimal Rp1.600.000.',
    'user B received an answer computed from user A holdings — cross-user data leak'
  );
});

test('4. and the leaked answer is not merely relabelled: B must not be a cache hit on A', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'ANSWER-FOR-A');
  const b = await ask(PORTFOLIO_B, 'ANSWER-FOR-B');
  assert.notStrictEqual(
    b.cache_hit, true,
    'user B request was answered from user A cache entry'
  );
});

test('5. the same portfolio content from a different object identity still hits the cache', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'ANSWER-FOR-A');
  const clone = await ask(JSON.parse(JSON.stringify(PORTFOLIO_A)), 'SHOULD-NOT-BE-USED');
  assert.strictEqual(clone.reply, 'ANSWER-FOR-A', 'identical content must still share one cache entry');
});

test('6. adding a position invalidates the cached answer', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'SATU POSISI');
  const grown = await ask({
    captured_at: CAPTURED_AT,
    prices: PORTFOLIO_A.prices,
    plans: PORTFOLIO_A.plans.concat([{ ticker: 'TLKM', entryPriceIdr: 2700, lots: 20, capitalIdr: 54000000 }])
  }, 'DUA POSISI');
  assert.strictEqual(grown.reply, 'DUA POSISI', 'a changed portfolio must not reuse the previous answer');
});

test('7. changing only the lot size invalidates the cached answer', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'RISIKO UNTUK 10 LOT');
  const bigger = await ask({
    captured_at: CAPTURED_AT,
    prices: PORTFOLIO_A.prices,
    plans: [Object.assign({}, PORTFOLIO_A.plans[0], { lots: 20 })]
  }, 'RISIKO UNTUK 20 LOT');
  assert.strictEqual(
    bigger.reply, 'RISIKO UNTUK 20 LOT',
    'position size changes the correct answer, so it must not be served from the old entry'
  );
});

test('8. an empty portfolio does not collide with a populated one', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'ADA POSISI');
  const empty = await ask({ captured_at: CAPTURED_AT, plans: [], prices: {} }, 'BELUM ADA POSISI');
  assert.strictEqual(empty.reply, 'BELUM ADA POSISI');
});

test('9. a different question on the same portfolio is still separated', async (t) => {
  isolate(t);
  await ask(PORTFOLIO_A, 'JAWABAN PERTANYAAN 1', 'Berapa risiko saya?');
  const second = await ask(PORTFOLIO_A, 'JAWABAN PERTANYAAN 2', 'Apakah alokasi saya terlalu besar?');
  assert.strictEqual(second.reply, 'JAWABAN PERTANYAAN 2');
});

test('10. the streaming path is isolated too', async (t) => {
  isolate(t);
  const chunks = [];
  function streamRes() {
    const r = fakeRes();
    r.write = (line) => { chunks.push(line); return true; };
    r.flushHeaders = () => {};
    return r;
  }
  nextGeminiReply = 'STREAM-FOR-A';
  await handleContextAIV7({ body: { source: 'portfolio_chat', chatMessage: QUESTION, context: PORTFOLIO_A, stream: true }, headers: {} }, streamRes());
  chunks.length = 0;
  nextGeminiReply = 'STREAM-FOR-B';
  await handleContextAIV7({ body: { source: 'portfolio_chat', chatMessage: QUESTION, context: PORTFOLIO_B, stream: true }, headers: {} }, streamRes());
  const joined = chunks.join('');
  assert.ok(joined.includes('STREAM-FOR-B'), 'user B stream must carry user B answer, got: ' + joined.slice(0, 300));
  assert.ok(!joined.includes('STREAM-FOR-A'), 'user B stream carried user A answer — cross-user data leak');
});

// ---------------------------------------------------------------------------
// The stock-analysis follow-up key shape must NOT change: its context is public
// market data for one ticker on one date, already described by ticker +
// market_date + prompt. Widening it there would only cost cache hits.
// ---------------------------------------------------------------------------

test('11. stock_analysis_followup keeps the existing key shape', () => {
  const params = handleContextAIV7._test.buildCacheParams(
    { ticker: 'BBCA', analysisType: 'stock_analysis_followup', prompt: 'kenapa?', marketDate: '2026-09-03' },
    'stock_analysis_followup',
    { ticker: 'BBCA', analysis_text: 'x'.repeat(200) },
    'gaya-bahasa'
  );
  assert.deepStrictEqual(Object.keys(params).sort(), ['analysisType', 'marketDate', 'prompt', 'ticker']);
  assert.strictEqual(params.extra, undefined, 'the stock path must keep its existing, narrower key');
});

test('12. portfolio_chat carries a bounded digest, never the raw portfolio', () => {
  const big = { plans: [], prices: {} };
  for (let i = 0; i < 25; i++) big.plans.push({ ticker: 'AAA' + (i % 10), entryPriceIdr: 1000 + i, lots: i + 1 });
  const params = handleContextAIV7._test.buildCacheParams(
    { ticker: null, analysisType: 'portfolio_chat', prompt: 'p', marketDate: '2026-09-03' },
    'portfolio_chat', big, ''
  );
  const serialized = JSON.stringify(params.extra);
  assert.ok(serialized.length <= 128, 'key material must stay a bounded digest, got ' + serialized.length + ' chars');
  assert.ok(!serialized.includes('AAA0'), 'the raw portfolio must never be written into the key material');
});

test('13. stableSerialize is order-independent for equal content', () => {
  const s = handleContextAIV7._test.stableSerialize;
  assert.strictEqual(s({ a: 1, b: [2, { d: 4, c: 3 }] }), s({ b: [2, { c: 3, d: 4 }], a: 1 }));
  assert.notStrictEqual(s({ a: 1 }), s({ a: 2 }));
});

test('14. an unserialisable context fails closed — never onto a shared key', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const a = handleContextAIV7._test.contextFingerprint('portfolio_chat', cyclic, '');
  const b = handleContextAIV7._test.contextFingerprint('portfolio_chat', cyclic, '');
  assert.ok(a && a.ctx, 'a fingerprint must still be produced');
  assert.notStrictEqual(a.ctx, b.ctx, 'an unserialisable context must not share a key with anything');
});

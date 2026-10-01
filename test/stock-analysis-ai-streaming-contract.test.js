'use strict';

// Bug fix regression test: PR 8 added SSE streaming support to
// lib/context-ai-router-v7.js and a matching reader to public/index.html, but
// wired the reader into `runAnalisisFromDashboard()` (source: 'chat_mode'),
// which api/analyze.js always routes to lib/analyze-legacy.js — a handler
// with zero SSE support. The only request that actually reaches the
// SSE-capable router is `stock_analysis_followup`
// (public/stock-analysis-ai.js), and it never requested streaming, so the
// router's SSE support was 100% dead code in production.
//
// This test locks two things, all mocked — no live network/Supabase:
//   1. public/stock-analysis-ai.js now requests streaming for
//      stock_analysis_followup (stream:true + Accept: text/event-stream).
//   2. Its SSE frame parser (consumeSSELines) correctly reconstructs the
//      exact reply text that lib/context-ai-router-v7.js's real SSE writer
//      (sendSSEChunk/sendSSEDone) emits on the wire.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const handleContextAIV7 = require('../lib/context-ai-router-v7');
const { clearMemoryCache } = require('../lib/ai-analysis-cache');
const { resetAiTelemetryStats } = require('../lib/ai-telemetry');

const JS_PATH = path.resolve(__dirname, '..', 'public', 'stock-analysis-ai.js');
const src = fs.readFileSync(JS_PATH, 'utf8');

function extractFunction(source, signature) {
  var start = source.indexOf(signature);
  if (start < 0) return null;
  var i = source.indexOf('{', start);
  var depth = 0;
  for (var j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  return null;
}

function mockRouterRes() {
  const state = { statusCode: 200, headers: {}, chunks: [], ended: false };
  const res = {
    status(code) { state.statusCode = code; return res; },
    setHeader(k, v) { state.headers[k.toLowerCase()] = v; return res; },
    flushHeaders() {},
    write(data) { state.chunks.push(String(data)); return true; },
    end() { state.ended = true; return res; },
    json(data) { state.payload = data; return res; }
  };
  return { state, res };
}

// ---- 1. Request contract: stock-analysis-ai.js must ask the router to stream ----

test('stock-analysis-ai.js requests SSE streaming for stock_analysis_followup', () => {
  var sendFn = extractFunction(src, 'async function send');
  assert.ok(sendFn, 'send() must exist');
  assert.match(sendFn, /Accept['"]?\s*:\s*['"]text\/event-stream/, 'must ask for text/event-stream');
  assert.match(sendFn, /stream\s*:\s*true/, 'must set stream:true in the request body');
  assert.match(sendFn, /source\s*:\s*['"]stock_analysis_followup['"]/, 'source must stay stock_analysis_followup');
});

test('stock-analysis-ai.js only treats an ok + text/event-stream response as a stream', () => {
  var sendFn = extractFunction(src, 'async function send');
  assert.match(sendFn, /response\.ok\s*&&\s*contentType\.indexOf\('text\/event-stream'\)/,
    'a non-OK response (e.g. 401/402/400 from api/analyze.js) must fall through to the JSON error path, never be read as a stream');
});

// ---- 2. Wire-format contract: the frontend's SSE parser must match the
// router's real SSE writer exactly (sendSSEChunk / sendSSEDone) ----

function makeConsumeSSELines() {
  var fnSrc = extractFunction(src, 'function consumeSSELines');
  assert.ok(fnSrc, 'consumeSSELines must exist');
  var factory = new Function(fnSrc + '\nreturn consumeSSELines;');
  return factory();
}

test('consumeSSELines reconstructs a chunked reply and ignores [DONE]', () => {
  var consumeSSELines = makeConsumeSSELines();
  var replyText = '';
  var buffer = '';
  buffer = consumeSSELines(buffer + 'data: {"chunk":"BBRI "}\n\n', (p) => { if (p.chunk) replyText += p.chunk; });
  buffer = consumeSSELines(buffer + 'data: {"chunk":"support 5200."}\n\n', (p) => { if (p.chunk) replyText += p.chunk; });
  buffer = consumeSSELines(buffer + 'data: [DONE]\n\n', (p) => { if (p.chunk) replyText += p.chunk; });
  assert.equal(replyText, 'BBRI support 5200.');
});

test('consumeSSELines carries a frame split across two reads (partial buffer)', () => {
  var consumeSSELines = makeConsumeSSELines();
  var replyText = '';
  var buffer = '';
  // The frame is split mid-JSON, as a real ReadableStream chunk boundary would do.
  buffer = consumeSSELines(buffer + 'data: {"chu', () => { throw new Error('must not parse a partial frame'); });
  buffer = consumeSSELines(buffer + 'nk":"IHSG rebound."}\n\n', (p) => { if (p.chunk) replyText += p.chunk; });
  assert.equal(replyText, 'IHSG rebound.');
});

test('consumeSSELines surfaces local_fallback from any chunk payload', () => {
  var consumeSSELines = makeConsumeSSELines();
  var sawLocalFallback = false;
  consumeSSELines('data: {"chunk":"fallback text","local_fallback":true}\n\n', (p) => {
    if (p.local_fallback === true) sawLocalFallback = true;
  });
  assert.equal(sawLocalFallback, true);
});

// ---- 3. End-to-end wire compatibility: feed the router's *real* SSE output
// (mocked Gemini fetch, mocked cache/telemetry — no live network) through the
// frontend's parser and confirm it reconstructs the exact reply. ----

test('the router\'s real SSE stream output round-trips through the frontend parser', async () => {
  resetAiTelemetryStats();
  clearMemoryCache();

  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'mock-stream-key';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const lines = ['BBCA ', 'breakout ', 'di atas 9500.'].map(
      (c) => `data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(c)}}]}}]}\n\n`
    );
    lines.push('data: [DONE]\n\n');
    const full = lines.join('');
    return { ok: true, status: 200, text: async () => full, body: { async *[Symbol.asyncIterator]() { for (const l of lines) yield l; } } };
  };

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        chatMessage: 'Gimana BBCA?',
        stream: true,
        context: { ticker: 'BBCA', status: 'BREAKOUT', analysis_text: 'BBCA breakout candidate' }
      }
    };
    const { state, res } = mockRouterRes();
    await handleContextAIV7(req, res);

    assert.equal(state.headers['content-type'], 'text/event-stream');
    const wire = state.chunks.join('');

    // Exactly what stock-analysis-ai.js's send() does with response.body chunks.
    const consumeSSELines = makeConsumeSSELines();
    let replyText = '';
    let buffer = '';
    buffer = consumeSSELines(buffer + wire, (p) => { if (typeof p.chunk === 'string') replyText += p.chunk; });

    assert.equal(replyText, 'BBCA breakout di atas 9500.');
  } finally {
    globalThis.fetch = origFetch;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey; else delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini; else delete process.env.GEMINI_API_KEY;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy; else delete process.env.PORTFOLIO_AI_API_KEY;
  }
});

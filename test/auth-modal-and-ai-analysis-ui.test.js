'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT_DIR, 'public', 'index.html');
const handleContextAIV7 = require('../lib/context-ai-router-v7');

function mockRes() {
  const state = {
    statusCode: 200,
    headers: {},
    payload: null,
    chunks: [],
    ended: false,
    flushedHeaders: false
  };

  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    setHeader(key, value) {
      state.headers[key.toLowerCase()] = value;
      return res;
    },
    flushHeaders() {
      state.flushedHeaders = true;
    },
    write(data) {
      state.chunks.push(String(data));
      return true;
    },
    end() {
      state.ended = true;
      return res;
    },
    json(data) {
      state.payload = data;
      return res;
    }
  };

  return { state, res };
}

test('UI Fix 1: public/index.html contains login and register modals with necessary form fields', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // Verify dashboardScreen is opened
  const dashboardOpenIdx = html.indexOf('id="dashboardScreen"');
  assert.ok(dashboardOpenIdx > 0, 'dashboardScreen must exist in index.html');

  // Verify loginModal and registerModal exist
  const loginModalIdx = html.indexOf('id="loginModal"');
  const registerModalIdx = html.indexOf('id="registerModal"');
  assert.ok(loginModalIdx > 0, 'loginModal must exist');
  assert.ok(registerModalIdx > 0, 'registerModal must exist');

  // Verify essential modal form controls exist
  assert.ok(html.includes('id="loginUsername"'), 'loginUsername must exist');
  assert.ok(html.includes('id="loginPassword"'), 'loginPassword must exist');
  assert.ok(html.includes('id="regUsername"'), 'regUsername must exist');
  assert.ok(html.includes('id="regPassword"'), 'regPassword must exist');
  assert.ok(html.includes('id="regTermsAccepted"'), 'regTermsAccepted must exist');
});

test('UI Fix 1: All inline scripts in public/index.html are syntactically valid', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  let cursor = 0;
  let count = 0;
  const lower = html.toLowerCase();

  while (true) {
    const openTagStart = lower.indexOf('<script', cursor);
    if (openTagStart === -1) break;
    const openTagEnd = lower.indexOf('>', openTagStart);
    if (openTagEnd === -1) break;

    const closeTagStart = lower.indexOf('</script', openTagEnd);
    if (closeTagStart === -1) break;
    const closeTagEnd = lower.indexOf('>', closeTagStart);
    if (closeTagEnd === -1) break;

    const tagAttrs = lower.slice(openTagStart, openTagEnd);
    const scriptBody = html.slice(openTagEnd + 1, closeTagStart);
    cursor = closeTagEnd + 1;

    // Skip external script tags or empty script blocks
    if (tagAttrs.includes('src=') || !scriptBody.trim()) continue;

    count++;
    assert.doesNotThrow(() => {
      new Function(scriptBody);
    }, 'Inline script #' + count + ' must have valid syntax');
  }
  assert.ok(count >= 3, 'Must have inspected all inline scripts');
});

test('UI Fix 2: handleContextAIV7 responds with graceful local fallback when GEMINI_API_KEY is unset (non-streaming)', async () => {
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origFetch = globalThis.fetch;

  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  globalThis.fetch = async () => { throw new Error('Live network forbidden in unit test'); };

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        ticker: 'BBCA',
        chatMessage: 'Bagaimana tren harga saat ini?',
        stream: false,
        context: {
          ticker: 'BBCA',
          status: 'ACCUMULATION',
          analysis_text: 'BBCA berada dalam akumulasi sideways di area support kuat 9800.'
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.statusCode, 200);
    assert.ok(state.payload);
    assert.equal(state.payload.success, true);
    assert.equal(state.payload.local_fallback, true);
    assert.ok(state.payload.reply.includes('BBCA'));
    assert.ok(state.payload.reply.length > 0);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
  }
});

test('UI Fix 2: handleContextAIV7 streams SSE fallback when stream is true and GEMINI_API_KEY is unset', async () => {
  const origKey = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  const origGemini = process.env.GEMINI_API_KEY;
  const origLegacy = process.env.PORTFOLIO_AI_API_KEY;
  const origFetch = globalThis.fetch;

  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
  globalThis.fetch = async () => { throw new Error('Live network forbidden in unit test'); };

  try {
    const req = {
      method: 'POST',
      body: {
        source: 'stock_analysis_followup',
        ticker: 'BBRI',
        chatMessage: 'Apakah aman untuk swing trade?',
        stream: true,
        context: {
          ticker: 'BBRI',
          status: 'RADAR',
          analysis_text: 'BBRI menguji level support psikologis 5000 dengan volume transaksi stabil.'
        }
      }
    };
    const { state, res } = mockRes();
    await handleContextAIV7(req, res);

    assert.equal(state.headers['content-type'], 'text/event-stream');
    assert.equal(state.ended, true);

    const fullWritten = state.chunks.join('');
    assert.ok(fullWritten.includes('data: {"chunk":'));
    assert.ok(fullWritten.includes('BBRI'));
    assert.ok(fullWritten.includes('data: [DONE]'));
  } finally {
    globalThis.fetch = origFetch;
    if (origKey !== undefined) process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = origKey;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
    if (origLegacy !== undefined) process.env.PORTFOLIO_AI_API_KEY = origLegacy;
  }
});

test('UI Fix 2: handleContextAIV7 validates required fields and handles missing inputs gracefully', async () => {
  const req = {
    method: 'POST',
    body: {
      source: 'portfolio_chat',
      chatMessage: ''
    }
  };
  const { state, res } = mockRes();
  await handleContextAIV7(req, res);

  assert.equal(state.statusCode, 400);
  assert.ok(state.payload);
  assert.equal(state.payload.success, false);
  assert.equal(state.payload.code, 'AI_EMPTY_QUESTION');
});

test('Invariant Check: Exactly 12 files in api/ directory', () => {
  const apiFiles = fs.readdirSync(path.join(ROOT_DIR, 'api')).filter(f => f.endsWith('.js'));
  assert.equal(apiFiles.length, 12, 'api/ directory must have exactly 12 JavaScript files');
});

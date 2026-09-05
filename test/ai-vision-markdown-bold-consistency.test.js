'use strict';

// Regression test for the "raw **markdown**" bug: orderbook and broker-summary
// image uploads in Analisis Saham chat call Gemini directly and return its raw
// text to the client. handleChartVision/handleChartDeepSeek already convert
// **bold** -> <strong>, but handleOrderbook/handleBrokerSummary did not, so a
// literal "**BUY**" from Gemini reached the user unrendered while every other
// AI surface on the page (chart upload, follow-up chat) showed real bold text.
// This asserts every one of those raw-text handlers is now wired through the
// same convertMarkdownBold() helper.

const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const handler = require('../lib/analyze-legacy');

function geminiResponseWithText(text) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] })
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test.afterEach(() => { global.fetch = originalFetch; });

test('orderbook image upload converts raw ** markdown into <strong>', async () => {
  global.fetch = async () => geminiResponseWithText(
    'Ini saya baca sebagai bid-offer/orderbook. **Bid terlihat lebih tebal** dibanding offer.'
  );

  const req = {
    method: 'POST',
    body: {
      source: 'chart_upload',
      chatMessage: 'ini orderbook BBCA',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }]
    }
  };
  const res = fakeRes();
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'test-key';
  await handler(req, res);

  assert.equal(res.body.intent, 'orderbook_analysis');
  assert.match(res.body.html, /<strong>Bid terlihat lebih tebal<\/strong>/);
  assert.doesNotMatch(res.body.html, /\*\*/);
});

test('broker summary image upload converts raw ** markdown into <strong>', async () => {
  global.fetch = async () => geminiResponseWithText(
    'Ini broker summary. Top buyer **YP** dominan dengan akumulasi kuat.'
  );

  const req = {
    method: 'POST',
    body: {
      source: 'chart_upload',
      chatMessage: 'broker summary BBCA',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }]
    }
  };
  const res = fakeRes();
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = 'test-key';
  await handler(req, res);

  assert.equal(res.body.intent, 'broker_summary_analysis');
  assert.match(res.body.html, /<strong>YP<\/strong>/);
  assert.doesNotMatch(res.body.html, /\*\*/);
});

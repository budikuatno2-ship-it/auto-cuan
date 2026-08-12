'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The daily-market-context action is folded into api/quote.js (not a new
// api/*.js file) to preserve the project's fixed Vercel API function count
// (see other tests asserting "exactly 12 API JavaScript files").
const { normalizeDailyContextTicker } = require('../api/quote').__test;

function makeRes() {
  let _status = 200;
  let _body = null;
  return {
    status(code) { _status = code; return this; },
    json(data) { _body = data; return this; },
    getStatus() { return _status; },
    getBody() { return _body; }
  };
}

test('normalizeDailyContextTicker strips .JK suffix and uppercases', () => {
  assert.equal(normalizeDailyContextTicker('bbca.jk'), 'BBCA');
  assert.equal(normalizeDailyContextTicker(' tlkm '), 'TLKM');
});

test('action=daily-market-context rejects non-GET methods', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const handler = require('../api/quote');
  const res = makeRes();
  await handler({ method: 'POST', query: { action: 'daily-market-context' } }, res);
  assert.equal(res.getStatus(), 405);
});

test('action=daily-market-context rejects an invalid ticker', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const handler = require('../api/quote');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'daily-market-context', ticker: '???' } }, res);
  assert.equal(res.getStatus(), 400);
  assert.equal(res.getBody().success, false);
});

test('action=daily-market-context returns a configuration error (HTTP 200 envelope) when Supabase env vars are missing', async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  delete require.cache[require.resolve('../api/quote')];
  const handler = require('../api/quote');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'daily-market-context', ticker: 'BBCA' } }, res);

  assert.equal(res.getStatus(), 200);
  assert.equal(res.getBody().success, false);

  if (originalUrl) process.env.SUPABASE_URL = originalUrl;
  if (originalKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

// --- action=daily-market-context-list (Ranking Harian table) ---

test('action=daily-market-context-list rejects non-GET methods', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[require.resolve('../api/quote')];
  const handler = require('../api/quote');
  const res = makeRes();
  await handler({ method: 'POST', query: { action: 'daily-market-context-list' } }, res);
  assert.equal(res.getStatus(), 405);
});

test('action=daily-market-context-list returns a configuration error (HTTP 200 envelope) when Supabase env vars are missing', async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  delete require.cache[require.resolve('../api/quote')];
  const handler = require('../api/quote');
  const res = makeRes();
  await handler({ method: 'GET', query: { action: 'daily-market-context-list' } }, res);

  assert.equal(res.getStatus(), 200);
  assert.equal(res.getBody().success, false);

  if (originalUrl) process.env.SUPABASE_URL = originalUrl;
  if (originalKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

test('a request without action=daily-market-context still requires ticker (existing quote behavior untouched)', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[require.resolve('../api/quote')];
  const handler = require('../api/quote');
  const res = makeRes();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.getStatus(), 400);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTicker } = require('../api/daily-market-context').__test;

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

test('normalizeTicker strips .JK suffix and uppercases', () => {
  assert.equal(normalizeTicker('bbca.jk'), 'BBCA');
  assert.equal(normalizeTicker(' tlkm '), 'TLKM');
});

test('handler rejects non-GET methods', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const handler = require('../api/daily-market-context');
  const res = makeRes();
  await handler({ method: 'POST', query: {} }, res);
  assert.equal(res.getStatus(), 405);
});

test('handler rejects an invalid ticker', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const handler = require('../api/daily-market-context');
  const res = makeRes();
  await handler({ method: 'GET', query: { ticker: '???' } }, res);
  assert.equal(res.getStatus(), 400);
  assert.equal(res.getBody().success, false);
});

test('handler returns a configuration error (HTTP 200 envelope) when Supabase env vars are missing', async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  delete require.cache[require.resolve('../api/daily-market-context')];
  const handler = require('../api/daily-market-context');
  const res = makeRes();
  await handler({ method: 'GET', query: { ticker: 'BBCA' } }, res);

  assert.equal(res.getStatus(), 200);
  assert.equal(res.getBody().success, false);

  if (originalUrl) process.env.SUPABASE_URL = originalUrl;
  if (originalKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

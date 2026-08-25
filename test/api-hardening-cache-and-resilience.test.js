'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function requireApiWithSupabaseStub(relPath, createClientImpl) {
  const origLoad = Module._load;
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: createClientImpl || function () { return {}; } };
    return origLoad.apply(this, arguments);
  };
  try { return require(relPath); }
  finally { Module._load = origLoad; delete require.cache[abs]; }
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

test('api/admin-logs returns 503 when Supabase is unconfigured', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const adminSession = require('../lib/admin-session');
  const token = adminSession.createSessionToken({ userId: 'u1', username: 'budi', isAdmin: true });

  const handler = requireApiWithSupabaseStub('../api/admin-logs');
  const res = makeRes();
  await handler({
    method: 'POST',
    headers: { host: 'localhost', cookie: 'ac_sess=' + token },
    body: {}
  }, res);

  if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
  if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  if (prevSecret !== undefined) process.env.SESSION_SECRET = prevSecret;

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
});

test('api/candles returns 502 when upstream fetch throws exception', async () => {
  const handler = requireApiWithSupabaseStub('../api/candles');
  const prevFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };

  const res = makeRes();
  await handler({ method: 'GET', query: { ticker: 'BBCA' }, headers: { host: 'localhost' } }, res);

  global.fetch = prevFetch;
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
});

test('api/candles returns 400 when ticker is missing', async () => {
  const handler = requireApiWithSupabaseStub('../api/candles');
  const res = makeRes();
  await handler({ method: 'GET', query: {}, headers: { host: 'localhost' } }, res);

  assert.equal(res.statusCode, 400);
});

test('api/analyze returns 503 when subscription Supabase is unconfigured', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const handler = requireApiWithSupabaseStub('../api/analyze');
  const res = makeRes();
  await handler({ method: 'POST', body: { chatMessage: 'halo' }, headers: { host: 'localhost' } }, res);

  if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
  if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
});

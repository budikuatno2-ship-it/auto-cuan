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

  // Use a ticker with NO local disk cache (data/ohlcv|daily-candles/<T>.json),
  // so the handler is forced down the live-fetch path. BBCA now has a disk
  // cache in the recovery worktree, which would short-circuit the fetch and
  // make this assertion vacuous. ZZZZ is a valid ticker shape with no cache.
  const res = makeRes();
  await handler({ method: 'GET', query: { ticker: 'ZZZZ' }, headers: { host: 'localhost' } }, res);

  global.fetch = prevFetch;
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
  // Canonical contract: a thrown transport error carries an explicit error code
  // and is distinguishable from a genuinely-absent bar (200 + unavailable).
  assert.equal(res.body.error_code, 'UPSTREAM_TRANSPORT_ERROR');
  assert.equal(res.body.data_status, 'unavailable');
});

test('api/candles returns 200 + data_status unavailable (not 502) when upstream data is genuinely absent', async () => {
  const handler = requireApiWithSupabaseStub('../api/candles');
  const prevFetch = global.fetch;
  // Upstream responds OK but with no chart result — an honest "no data" answer,
  // which must NOT be reported as a transport failure (502).
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ chart: { result: [] } }) });

  const res = makeRes();
  await handler({ method: 'GET', query: { ticker: 'ZZZZ' }, headers: { host: 'localhost' } }, res);

  global.fetch = prevFetch;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.data_status, 'unavailable');
  assert.equal(res.body.error_code, undefined, 'absent data must not carry a transport error code');
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

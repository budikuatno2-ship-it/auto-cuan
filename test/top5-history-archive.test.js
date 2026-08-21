'use strict';

// Regression coverage for the Top5 History archive endpoint
// (action=web-top5-history-archive), which previously had no dedicated
// test file at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const CRON_SECRET = 'archive-test-secret';

function requireHandlerWithSupabaseStub(rows) {
  const origLoad = Module._load;
  const abs = require.resolve('../api/sector-hot');
  delete require.cache[abs];
  const updateCalls = [];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') {
      return {
        createClient: function () {
          return {
            from(table) {
              const builder = {
                _op: null,
                _eqId: null,
                select() { return this; },
                update(values) { this._op = 'update'; this._values = values; return this; },
                eq(col, val) { this._eqId = val; return this; },
                maybeSingle: () => {
                  const row = rows.find(r => r.id === builder._eqId);
                  return Promise.resolve({ data: row ? { id: row.id, raw_payload: row.raw_payload || {} } : null, error: null });
                },
                then: (resolve, reject) => {
                  try {
                    if (builder._op === 'update') {
                      const row = rows.find(r => r.id === builder._eqId);
                      if (row) {
                        row.raw_payload = builder._values.raw_payload;
                        updateCalls.push({ id: builder._eqId, raw_payload: builder._values.raw_payload });
                      }
                      resolve({ data: null, error: null });
                    } else {
                      resolve({ data: null, error: null });
                    }
                  } catch (e) { reject(e); }
                }
              };
              return builder;
            }
          };
        }
      };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return { handler: require('../api/sector-hot'), updateCalls };
  } finally {
    Module._load = origLoad;
    delete require.cache[abs];
  }
}

function makeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

function withEnv(fn) {
  const prev = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET: process.env.CRON_SECRET };
  process.env.SUPABASE_URL = 'https://stub.supabase.local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role';
  process.env.CRON_SECRET = CRON_SECRET;
  return Promise.resolve(fn()).finally(() => {
    Object.keys(prev).forEach(k => { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; });
  });
}

test('archive request without the correct Bearer CRON_SECRET is rejected (401), including via query string', async () => {
  await withEnv(async () => {
    const { handler } = requireHandlerWithSupabaseStub([{ id: 1, raw_payload: {} }]);
    const res = makeRes();
    await handler({ method: 'POST', query: { action: 'web-top5-history-archive', secret: CRON_SECRET }, headers: {}, body: { id: 1 } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  });
});

test('archiving a nonexistent row returns 404 and performs no write', async () => {
  await withEnv(async () => {
    const { handler, updateCalls } = requireHandlerWithSupabaseStub([{ id: 1, raw_payload: {} }]);
    const res = makeRes();
    await handler({ method: 'POST', query: { action: 'web-top5-history-archive' }, headers: { authorization: 'Bearer ' + CRON_SECRET }, body: { id: 999 } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
    assert.equal(updateCalls.length, 0);
  });
});

test('missing id is rejected without touching the database', async () => {
  await withEnv(async () => {
    const { handler, updateCalls } = requireHandlerWithSupabaseStub([{ id: 1, raw_payload: {} }]);
    const res = makeRes();
    await handler({ method: 'POST', query: { action: 'web-top5-history-archive' }, headers: { authorization: 'Bearer ' + CRON_SECRET }, body: {} }, res);
    assert.equal(res.body.success, false);
    assert.equal(updateCalls.length, 0);
  });
});

test('archiving a valid row sets history_archived_at and preserves other raw_payload fields', async () => {
  await withEnv(async () => {
    const rows = [{ id: 5, raw_payload: { ticker: 'BBCA', monitor_source: 'daytrade_signal' } }];
    const { handler, updateCalls } = requireHandlerWithSupabaseStub(rows);
    const res = makeRes();
    await handler({ method: 'POST', query: { action: 'web-top5-history-archive' }, headers: { authorization: 'Bearer ' + CRON_SECRET }, body: { id: 5 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.id, 5);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].raw_payload.ticker, 'BBCA', 'archiving must not clobber unrelated raw_payload fields');
    assert.ok(updateCalls[0].raw_payload.history_archived_at);
    assert.equal(updateCalls[0].raw_payload.history_archived_by, 'web-admin');
  });
});

test('archiving the same row twice is idempotent: both calls succeed and the row stays archived', async () => {
  await withEnv(async () => {
    const rows = [{ id: 7, raw_payload: {} }];
    const { handler, updateCalls } = requireHandlerWithSupabaseStub(rows);

    const res1 = makeRes();
    await handler({ method: 'POST', query: { action: 'web-top5-history-archive' }, headers: { authorization: 'Bearer ' + CRON_SECRET }, body: { id: 7 } }, res1);
    assert.equal(res1.body.success, true);

    const res2 = makeRes();
    await handler({ method: 'POST', query: { action: 'web-top5-history-archive' }, headers: { authorization: 'Bearer ' + CRON_SECRET }, body: { id: 7 } }, res2);
    assert.equal(res2.body.success, true, 're-archiving an already-archived row must not error');

    assert.equal(updateCalls.length, 2);
    assert.ok(rows[0].raw_payload.history_archived_at);
  });
});

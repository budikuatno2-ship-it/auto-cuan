'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const SESSION_SECRET = 'admin-foreign-upload-unit-test-secret';
process.env.SESSION_SECRET = SESSION_SECRET;

const session = require('../lib/admin-session');
const foreign = require('../lib/admin-foreign-upload');

function requireAdminUsersWithSupabaseStub() {
  const originalLoad = Module._load;
  const endpointPath = require.resolve('../api/admin-users');
  delete require.cache[endpointPath];

  Module._load = function patchedLoad(request) {
    if (request === '@supabase/supabase-js') {
      return { createClient: function createClient() { return {}; } };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require('../api/admin-users');
  } finally {
    Module._load = originalLoad;
    delete require.cache[endpointPath];
  }
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function makeAdminRequest(body, username) {
  const token = session.createSessionToken({
    userId: 'admin-test-user',
    username: username || 'budi',
    isAdmin: true,
    deviceId: 'test-device'
  });

  return {
    method: 'POST',
    headers: {
      host: 'app.test',
      origin: 'https://app.test',
      cookie: `ac_sess=${token}`,
      'content-type': 'application/json'
    },
    body
  };
}

const HEADER = 'date,ticker,open,high,low,close,volume,freq,valuasi,nbsa';

test('parser accepts ISO and US dates, .JK tickers, and computes foreign net', () => {
  const csv = [
    HEADER,
    '2026-07-30,BBCA.JK,8500,8600,8450,8575,1000,20,8575000,10',
    '7/31/2026,TLKM,3000,3050,2980,3020,2000,30,6040000,-5'
  ].join('\n');

  const parsed = foreign.parseForeignCsv(csv);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].ticker, 'BBCA');
  assert.equal(parsed.rows[0].foreign_net, 85750);
  assert.equal(parsed.rows[1].trade_date, '2026-07-31');
  assert.equal(parsed.rows[1].foreign_net, -15100);
  assert.equal(parsed.summary.ticker_count, 2);
  assert.equal(parsed.summary.date_count, 2);
});

test('parser accepts angle-bracket header labels', () => {
  const csv = [
    '<date>,<ticker>,<open>,<high>,<low>,<close>,<volume>,<freq>,<valuasi>,<nbsa>',
    '2026-07-30,BBRI,4000,4050,3980,4020,1000,10,4020000,25'
  ].join('\n');

  const parsed = foreign.parseForeignCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].ticker, 'BBRI');
});

test('parser rejects duplicate date and ticker rows', () => {
  const csv = [
    HEADER,
    '2026-07-30,BBCA,1,1,1,1,1,1,1,1',
    '2026-07-30,BBCA.JK,1,1,1,1,1,1,1,1'
  ].join('\n');

  assert.throws(
    () => foreign.parseForeignCsv(csv),
    /Data duplikat 2026-07-30\|BBCA/
  );
});

test('parser rejects missing required headers and invalid dates', () => {
  assert.throws(
    () => foreign.parseForeignCsv('date,ticker\n2026-07-30,BBCA'),
    /Kolom CSV wajib tidak ditemukan/
  );

  assert.throws(
    () => foreign.parseForeignCsv(`${HEADER}\n2026-02-31,BBCA,1,1,1,1,1,1,1,1`),
    /Tanggal tidak valid/
  );
});

test('preview works through existing admin-users endpoint with signed Budi session', async () => {
  const handler = requireAdminUsersWithSupabaseStub();
  const req = makeAdminRequest({
    action: 'foreign_upload',
    mode: 'preview',
    csv: `${HEADER}\n2026-07-30,BBCA,1,1,1,8575,1,1,1,10`
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.preview, true);
  assert.equal(res.body.summary.row_count, 1);
});

test('existing admin endpoint rejects missing session and non-Budi admin session', async () => {
  const handler = requireAdminUsersWithSupabaseStub();
  let res = makeRes();
  await handler({
    method: 'POST',
    headers: { host: 'app.test', origin: 'https://app.test' },
    body: {
      action: 'foreign_upload',
      mode: 'preview',
      csv: `${HEADER}\n2026-07-30,BBCA,1,1,1,1,1,1,1,1`
    }
  }, res);
  assert.equal(res.statusCode, 401);

  res = makeRes();
  await handler(makeAdminRequest({
    action: 'foreign_upload',
    mode: 'preview',
    csv: `${HEADER}\n2026-07-30,BBCA,1,1,1,1,1,1,1,1`
  }, 'alice'), res);
  assert.equal(res.statusCode, 403);
});

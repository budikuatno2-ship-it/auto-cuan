'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const maintenanceHandler = require('../api/maintenance-settings.js');
const analyzeHandler = require('../api/analyze.js');
const adminSession = require('../lib/admin-session');

process.env.SESSION_SECRET = 'test-secret-salt-session-54321';

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    }
  };
  return res;
}

test('FIX-05: maintenance-settings action="ai-telemetry" requires valid admin session', async () => {
  // 1. Without session / unauthenticated request
  const unauthReq = {
    method: 'POST',
    body: { action: 'ai-telemetry' },
    headers: { host: 'localhost:3000' }
  };
  const res1 = createMockRes();
  await maintenanceHandler(unauthReq, res1);

  assert.ok(res1.statusCode === 401 || res1.statusCode === 403, `Unauthenticated ai-telemetry must be rejected (got ${res1.statusCode})`);
  assert.equal(res1.body.success, false);

  // 2. With valid admin session
  const adminToken = adminSession.createSessionToken({ userId: 'adm-1', username: 'budi', isAdmin: true });
  const authReq = {
    method: 'POST',
    body: { action: 'ai-telemetry' },
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      cookie: `ac_sess=${adminToken}`
    }
  };
  const res2 = createMockRes();
  await maintenanceHandler(authReq, res2);

  assert.equal(res2.statusCode, 200, 'Authenticated admin must receive 200');
  assert.equal(res2.body.success, true);
  assert.ok(res2.body.aiTelemetry != null);
});

test('FIX-05: api/analyze rejects non-POST requests with 405 (cannot bypass auth gate)', async () => {
  const getReq = {
    method: 'GET',
    query: { ticker: 'BBCA' },
    headers: { host: 'localhost:3000' }
  };
  const res = createMockRes();
  await analyzeHandler(getReq, res);

  assert.equal(res.statusCode, 405, 'GET to api/analyze must be rejected with 405');
  assert.equal(res.body.success, false);
});

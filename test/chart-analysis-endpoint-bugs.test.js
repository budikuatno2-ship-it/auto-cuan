'use strict';

const test = require('node:test');
const assert = require('node:assert');

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function loadEndpointWithMocks(userAiCredsMock, adminSessionMock, chartServiceMock) {
  delete require.cache[require.resolve('../lib/chart-analysis-endpoint')];
  const userAiCreds = require('../lib/user-ai-credentials');
  const adminSession = require('../lib/admin-session');
  const chartService = require('../lib/chart-analysis-service');

  if (userAiCredsMock) Object.assign(userAiCreds, userAiCredsMock);
  if (adminSessionMock) Object.assign(adminSession, adminSessionMock);
  if (chartServiceMock) Object.assign(chartService, chartServiceMock);

  return require('../lib/chart-analysis-endpoint');
}

test('BUG-CAE-01: handleChartAnalysisEndpoint must not return success 200 when deleteUserApiKey fails', async () => {
  const handleChartAnalysisEndpoint = loadEndpointWithMocks(
    { deleteUserApiKey: async () => ({ ok: false, status: 500, error: 'DB deletion error' }) },
    { requireAuthenticatedSession: () => ({ ok: true, session: { uid: 'usr-123' } }) }
  );

  const req = {
    method: 'POST',
    query: { action: 'delete-key' },
    body: {}
  };
  const res = createMockRes();
  await handleChartAnalysisEndpoint(req, res);

  assert.notStrictEqual(res.statusCode, 200, 'Endpoint should return error status when deleteUserApiKey fails, got 200');
  assert.strictEqual(res.body && res.body.success, false, 'Expected body.success to be false on failed delete');
});

test('BUG-CAE-02: handleChartAnalysisEndpoint must reject mutating action=set-key on GET with 405 Method Not Allowed', async () => {
  const handleChartAnalysisEndpoint = loadEndpointWithMocks(
    null,
    { requireAuthenticatedSession: () => ({ ok: true, session: { uid: 'usr-123' } }) },
    { getAnalysisStatus: async () => ({ ok: true, status: 200, ticker: 'BBRI' }) }
  );

  const req = {
    method: 'GET',
    query: { action: 'set-key' }
  };
  const res = createMockRes();
  await handleChartAnalysisEndpoint(req, res);

  assert.strictEqual(res.statusCode, 405, 'Mutating GET ?action=set-key must return 405 Method Not Allowed, got 200');
});

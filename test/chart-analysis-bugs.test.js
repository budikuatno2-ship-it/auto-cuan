'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runChartAnalysis, getAnalysisStatus } = require('../lib/chart-analysis-service');

test('BUG-CAS-01: runChartAnalysis cached response must include quota information', async () => {
  const auth = { ok: true, session: { uid: 'user-cached', un: 'trader1' } };
  const access = {
    ok: true,
    user: { id: 'user-cached', username: 'trader1' },
    premium: true,
    entitlement: { premium: true, current_plan: 'premium' }
  };

  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                payload_response: {
                  ticker: 'BBCA',
                  date: '2026-03-31',
                  analysisText: 'Visual chart bullish breakout.',
                  model: 'gemini-3.8-flash'
                }
              }
            })
          })
        })
      })
    })
  };

  const result = await runChartAnalysis(null, mockDb, 'BBCA', {
    auth,
    access,
    forceFresh: false
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cached, true);
  // BUG: Currently result.quota is undefined when returned from cache!
  assert.ok(result.quota, 'Cached response must include quota information');
  assert.strictEqual(typeof result.quota.usedToday, 'number');
});

test('BUG-CAS-02: runChartAnalysis and getAnalysisStatus must reject blocked user instead of overriding access.ok to true', async () => {
  const auth = { ok: true, session: { uid: 'blocked-uid', un: 'blocked-user' } };
  const blockedAccess = {
    ok: false,
    status: 403,
    code: 'USER_BLOCKED',
    error: 'Akun Anda sedang diblokir.'
  };

  // Currently: `if ((!access || !access.ok) && auth && auth.session) access = { ok: true, ... }`
  // overrides the blocked status and un-blocks the user!
  const statusRes = await getAnalysisStatus(null, null, 'BBCA', {
    auth,
    access: blockedAccess
  });

  assert.strictEqual(statusRes.ok, false, 'getAnalysisStatus must reject blocked user with ok: false');
  assert.strictEqual(statusRes.status, 403, 'getAnalysisStatus must return HTTP 403 for blocked user');

  const runRes = await runChartAnalysis(null, null, 'BBCA', {
    auth,
    access: blockedAccess
  });

  assert.strictEqual(runRes.ok, false, 'runChartAnalysis must reject blocked user with ok: false');
  assert.strictEqual(runRes.status, 403, 'runChartAnalysis must return HTTP 403 for blocked user');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const credentials = require('../lib/user-ai-credentials');
const service = require('../lib/chart-analysis-service');
const analyzeHandler = require('../api/analyze');

const TEST_KEY_APP = 'AIzaSyApp_MasterSystemKey_0011223344';
const TEST_KEY_USER = 'AQ.UserPersonalKey_AABBCCDDEEFF9988';
const TEST_KEY_FALLBACK = 'AIzaSyUser_FallbackPersonalKey_77889900';

const savedEnv = {
  API_KEY_ANALISA_SAHAM_PORTOFOLIO: process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  PORTFOLIO_AI_API_KEY: process.env.PORTFOLIO_AI_API_KEY
};

test.beforeEach(() => {
  credentials.clearMemoryStoreForTesting();
  service.clearMemoryStoresForTesting();
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
});

test.afterEach(() => {
  delete process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PORTFOLIO_AI_API_KEY;
});

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
});

// --- 1. resolveAiCredentials Unit Tests ---

test('resolveAiCredentials: Free user without personal key is rejected', async () => {
  const access = { ok: true, user: { id: 'free-user-1', username: 'andi', isAdmin: false }, premium: false };
  const creds = await credentials.resolveAiCredentials(null, 'free-user-1', access);
  assert.equal(creds.ok, false);
  assert.equal(creds.isSubscribed, false);
  assert.equal(creds.tier, 'free');
  assert.equal(creds.primaryKey, null);
  assert.equal(creds.fallbackKey, null);
  assert.equal(creds.source, 'none');
  assert.equal(creds.hasPersonalKey, false);
});

test('resolveAiCredentials: Free user with personal key gets user key as primary', async () => {
  await credentials.saveUserApiKey(null, 'free-user-2', TEST_KEY_USER);
  const access = { ok: true, user: { id: 'free-user-2', username: 'bambang', isAdmin: false }, premium: false };
  const creds = await credentials.resolveAiCredentials(null, 'free-user-2', access);
  assert.equal(creds.ok, true);
  assert.equal(creds.isSubscribed, false);
  assert.equal(creds.tier, 'free');
  assert.equal(creds.primaryKey, TEST_KEY_USER);
  assert.equal(creds.fallbackKey, null);
  assert.equal(creds.source, 'user');
  assert.equal(creds.hasPersonalKey, true);
});

test('resolveAiCredentials: Subscribed user gets server app key, and personal key as automatic fallback', async () => {
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = TEST_KEY_APP;
  await credentials.saveUserApiKey(null, 'sub-user-1', TEST_KEY_FALLBACK);

  const access = {
    ok: true,
    user: { id: 'sub-user-1', username: 'citra', isAdmin: false },
    premium: true,
    entitlement: { premium: true, access_level: 'premium' }
  };
  const creds = await credentials.resolveAiCredentials(null, 'sub-user-1', access);
  assert.equal(creds.ok, true);
  assert.equal(creds.isSubscribed, true);
  assert.equal(creds.primaryKey, TEST_KEY_APP);
  assert.equal(creds.fallbackKey, TEST_KEY_FALLBACK);
  assert.equal(creds.source, 'app');
  assert.equal(creds.hasAppKey, true);
  assert.equal(creds.hasPersonalKey, true);
});

test('resolveAiCredentials: Admin budi is automatically treated as subscribed tier', async () => {
  process.env.GEMINI_API_KEY = TEST_KEY_APP;
  const access = {
    ok: true,
    user: { id: 'admin-budi', username: 'budi', isAdmin: true },
    premium: false
  };
  const creds = await credentials.resolveAiCredentials(null, 'admin-budi', access);
  assert.equal(creds.ok, true);
  assert.equal(creds.isSubscribed, true);
  assert.equal(creds.primaryKey, TEST_KEY_APP);
  assert.equal(creds.source, 'app');
});

test('resolveAiCredentials: Subscribed user without app key falls back to personal key if available', async () => {
  await credentials.saveUserApiKey(null, 'sub-user-no-appkey', TEST_KEY_USER);
  const access = {
    ok: true,
    user: { id: 'sub-user-no-appkey', username: 'dian', isAdmin: false },
    premium: true,
    entitlement: { premium: true, access_level: 'premium' }
  };
  const creds = await credentials.resolveAiCredentials(null, 'sub-user-no-appkey', access);
  assert.equal(creds.ok, true);
  assert.equal(creds.isSubscribed, true);
  assert.equal(creds.primaryKey, TEST_KEY_USER);
  assert.equal(creds.fallbackKey, null);
  assert.equal(creds.source, 'user');
});

// --- 2. api/analyze requireAnalyzeAccess Gate Tests ---

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; return res; },
    json(data) { res.body = data; return res; }
  };
  return res;
}

test('api/analyze requireAnalyzeAccess: Free user without BYOK key is rejected with BYOK_KEY_REQUIRED', async () => {
  const req = {
    method: 'POST',
    body: { source: 'stock_analysis_followup', chatMessage: 'Halo' },
    cookies: { autocuan_session: 'mock-session' }
  };
  const res = mockRes();
  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) })
        })
      })
    })
  };

  const origEntitlement = require('../lib/subscription-auth').requirePremiumEntitlement;
  require('../lib/subscription-auth').requirePremiumEntitlement = async () => ({
    ok: false,
    status: 402,
    code: 'SUBSCRIPTION_REQUIRED',
    user: { id: 'user-free-no-key', username: 'freeuser' },
    account: { id: 'user-free-no-key', is_approved: true },
    premium: false,
    entitlement: { premium: false }
  });

  try {
    const allowed = await analyzeHandler.__test.requireAnalyzeAccess(req, res, mockDb);
    assert.equal(allowed, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'BYOK_KEY_REQUIRED');
    assert.equal(res.body.needs_key, true);
  } finally {
    require('../lib/subscription-auth').requirePremiumEntitlement = origEntitlement;
  }
});

test('api/analyze requireAnalyzeAccess: Free user WITH BYOK key is granted access', async () => {
  await credentials.saveUserApiKey(null, 'user-free-has-key', TEST_KEY_USER);
  const req = {
    method: 'POST',
    body: { source: 'stock_analysis_followup', chatMessage: 'Halo' }
  };
  const res = mockRes();
  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) })
        })
      })
    })
  };

  const origEntitlement = require('../lib/subscription-auth').requirePremiumEntitlement;
  require('../lib/subscription-auth').requirePremiumEntitlement = async () => ({
    ok: false,
    status: 402,
    code: 'SUBSCRIPTION_REQUIRED',
    user: { id: 'user-free-has-key', username: 'freeuser' },
    account: { id: 'user-free-has-key', is_approved: true },
    premium: false,
    entitlement: { premium: false }
  });

  try {
    const allowed = await analyzeHandler.__test.requireAnalyzeAccess(req, res, mockDb);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.credentials.primaryKey, TEST_KEY_USER);
    assert.equal(allowed.credentials.source, 'user');
  } finally {
    require('../lib/subscription-auth').requirePremiumEntitlement = origEntitlement;
  }
});

// --- 3. Chart Analysis Service Failover Tests ---

test('Chart Analysis: Subscribed user automatically fails over to personal key on HTTP 429 rate limit', async () => {
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = TEST_KEY_APP;
  await credentials.saveUserApiKey(null, 'premium-user-failover', TEST_KEY_FALLBACK);

  const mockReq = {
    headers: {}
  };
  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) })
        })
      }),
      upsert: async () => ({})
    })
  };

  const calledKeys = [];
  const mockFetch = async (url, opts) => {
    const keyMatch = url.match(/key=([^&]+)/);
    const usedKey = keyMatch ? decodeURIComponent(keyMatch[1]) : '';
    calledKeys.push(usedKey);

    if (usedKey === TEST_KEY_APP) {
      // Simulate 429 Rate Limit from primary app key
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Quota exhausted on primary key' } })
      };
    }

    // Success on fallback key
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{
                text: '## Tren Umum\nBullish.\n\n## Level Kunci yang Terlihat\nSupport 9000.\n\n## Pola Candlestick\nHammer.\n\n## Volume (jika terlihat di gambar)\nDi atas rata-rata.\n\n## Catatan Risiko\nIni adalah pembacaan pola visual, bukan rekomendasi transaksi. Keputusan trading sepenuhnya tanggung jawab Anda.'
              }]
            }
          }
        ]
      })
    };
  };

  const sampleOhlc = [
    { time: '2026-08-01', open: 9000, high: 9200, low: 8900, close: 9150, volume: 100000 },
    { time: '2026-08-02', open: 9150, high: 9300, low: 9100, close: 9250, volume: 120000 },
    { time: '2026-08-03', open: 9250, high: 9400, low: 9200, close: 9350, volume: 150000 },
    { time: '2026-08-04', open: 9350, high: 9500, low: 9300, close: 9450, volume: 180000 },
    { time: '2026-08-05', open: 9450, high: 9600, low: 9400, close: 9550, volume: 200000 }
  ];

  const result = await service.runChartAnalysis(mockReq, mockDb, 'BBCA', {
    auth: { ok: true, session: { uid: 'premium-user-failover', un: 'citra' }, premium: true },
    ohlcRows: sampleOhlc,
    fetchFn: mockFetch
  });

  assert.equal(result.ok, true, 'Analysis should succeed via failover');
  assert.equal(calledKeys.length, 2, 'Should have called primary key then fallback key');
  assert.equal(calledKeys[0], TEST_KEY_APP, 'First call used primary app key');
  assert.equal(calledKeys[1], TEST_KEY_FALLBACK, 'Second call used personal fallback key');
  assert.ok(result.data.analysisText.includes('## Tren Umum'));
});

test('getAnalysisStatus: reports effectiveKeySource, hasAppKey, and hasPersonalKey correctly', async () => {
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO = TEST_KEY_APP;
  await credentials.saveUserApiKey(null, 'status-test-user', TEST_KEY_FALLBACK);

  const mockReq = { headers: {} };
  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) })
        })
      })
    })
  };

  const status = await service.getAnalysisStatus(mockReq, mockDb, 'BBCA', {
    auth: { ok: true, session: { uid: 'status-test-user', un: 'budi', adm: true } }
  });

  assert.equal(status.ok, true);
  assert.equal(status.hasAppKey, true);
  assert.equal(status.hasPersonalKey, true);
  assert.equal(status.effectiveKeySource, 'app');
  assert.equal(status.hasFallbackKey, true);
  assert.equal(status.tier, 'lifetime');
  assert.equal(status.needsKey, false);
});

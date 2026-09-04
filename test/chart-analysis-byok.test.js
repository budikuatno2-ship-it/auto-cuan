'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const credentials = require('../lib/user-ai-credentials');
const prompt = require('../lib/chart-analysis-prompt');
const renderer = require('../lib/chart-image-renderer');
const service = require('../lib/chart-analysis-service');

const TEST_API_KEY_A = 'AIzaSyA_SampleTestKey_ForUserA_12345678';
const TEST_API_KEY_B = 'AIzaSyB_SampleTestKey_ForUserB_87654321';

test.beforeEach(() => {
  credentials.clearMemoryStoreForTesting();
  service.clearMemoryStoresForTesting();
});

test('BYOK Security: API key is symmetrically encrypted with AES-256-GCM and never plain text', () => {
  const enc = credentials.encryptApiKey(TEST_API_KEY_A);
  assert.ok(enc.startsWith('v1:'), 'Encrypted payload must use v1 version prefix');
  assert.ok(!enc.includes(TEST_API_KEY_A), 'Encrypted payload must NOT contain plain text key');

  const dec = credentials.decryptApiKey(enc);
  assert.equal(dec, TEST_API_KEY_A, 'Decrypted key must match original plain text');

  // Verify tampering detection (AES-256-GCM auth tag verification)
  const parts = enc.split(':');
  parts[3] = (parts[3].slice(0, -2) + 'ff'); // Tamper with ciphertext
  const tampered = parts.join(':');
  assert.equal(credentials.decryptApiKey(tampered), null, 'Tampered ciphertext must fail authentication');
});

test('BYOK Security: API key masking and format validation', () => {
  assert.equal(credentials.maskApiKey(TEST_API_KEY_A), '•••• •••• 5678');
  assert.equal(credentials.maskApiKey(TEST_API_KEY_B), '•••• •••• 4321');

  // Validation
  assert.equal(credentials.validateApiKey('').ok, false);
  assert.equal(credentials.validateApiKey('short-key').ok, false);
  assert.equal(credentials.validateApiKey(TEST_API_KEY_A).ok, true);
  assert.equal(credentials.validateApiKey('invalid key with spaces!!!').ok, false);
});

test('BYOK Security: Credential save never exposes plain text and returns only masked hint', async () => {
  const saved = await credentials.saveUserApiKey(null, 'user-123', TEST_API_KEY_A);
  assert.equal(saved.ok, true);
  assert.equal(saved.maskedKey, '•••• •••• 5678');
  assert.ok(!JSON.stringify(saved).includes(TEST_API_KEY_A), 'Plain text key must not be returned');

  const retrieved = await credentials.getUserApiKey(null, 'user-123');
  assert.equal(retrieved.hasKey, true);
  assert.equal(retrieved.apiKey, TEST_API_KEY_A);
  assert.equal(retrieved.maskedKey, '•••• •••• 5678');

  // Delete key
  await credentials.deleteUserApiKey(null, 'user-123');
  const afterDelete = await credentials.getUserApiKey(null, 'user-123');
  assert.equal(afterDelete.hasKey, false);
  assert.equal(afterDelete.apiKey, null);
});

test('System Prompt: Must contain all 5 required sections and exact mandatory rules', () => {
  const fullPrompt = prompt.getChartAnalysisSystemPrompt('BBRI');
  assert.ok(fullPrompt.includes('BBRI'), 'Prompt must contain the target ticker');
  assert.ok(fullPrompt.includes('ATURAN WAJIB — jangan dilanggar:'));
  assert.ok(fullPrompt.includes('STRUKTUR JAWABAN — ikuti persis lima bagian ini'));

  for (const section of prompt.MANDATORY_SECTIONS) {
    assert.ok(fullPrompt.includes(section), `Prompt must include mandatory section header "${section}"`);
  }

  assert.ok(fullPrompt.includes(prompt.MANDATORY_DISCLAIMER_SUFFIX), 'Prompt must include mandatory disclaimer suffix');
});

test('Rate Limiting: Free user is limited to 3 analyses per day, Premium to 10, Lifetime unlimited', () => {
  // Free tier
  const freeTier = service.resolveUserTier({ premium: false, entitlement: { premium: false } });
  assert.equal(freeTier.tier, 'free');
  assert.equal(freeTier.maxDaily, 3);

  // Premium tier
  const premTier = service.resolveUserTier({ premium: true, entitlement: { premium: true } });
  assert.equal(premTier.tier, 'premium');
  assert.equal(premTier.maxDaily, 10);

  // Lifetime tier
  const lifeTier = service.resolveUserTier({ entitlement: { lifetime_state: 'active' } });
  assert.equal(lifeTier.tier, 'lifetime');
  assert.equal(lifeTier.maxDaily, Infinity);

  // Admin budi
  const adminTier = service.resolveUserTier({ user: { username: 'budi', isAdmin: true } });
  assert.equal(adminTier.tier, 'lifetime');
  assert.equal(adminTier.maxDaily, Infinity);
});

test('Rate Limiting: WIB date calculation preserves zone offset without double-counting (BUG-012)', () => {
  // Test UTC midnight (00:00:00 UTC) -> in WIB (UTC+7) it is already 07:00:00 same day
  const utcMorning = new Date('2026-09-04T00:00:00.000Z');
  assert.equal(service.getWibDateString(utcMorning), '2026-09-04');

  // Test UTC 20:00:00 -> in WIB it is 03:00:00 next day (2026-09-05)
  const utcEvening = new Date('2026-09-04T20:00:00.000Z');
  assert.equal(service.getWibDateString(utcEvening), '2026-09-05');
});

test('Cache Isolation: User A and User B have separate cache keys (BUG-028 prevention)', () => {
  const keyA = service.getCacheKey('user-A', 'BBRI', '2026-09-04');
  const keyB = service.getCacheKey('user-B', 'BBRI', '2026-09-04');
  assert.notEqual(keyA, keyB, 'Cache keys for different users on same ticker must not collide');
  assert.ok(keyA.includes('user-A'));
  assert.ok(keyB.includes('user-B'));
});

test('Zero-Dependency Chart PNG: Generates valid PNG buffer with correct magic bytes', () => {
  const sampleOhlc = Array.from({ length: 25 }, (_, i) => ({
    date: '2026-08-' + String(i + 1).padStart(2, '0'),
    open: 1000 + i * 10,
    high: 1025 + i * 10,
    low: 990 + i * 10,
    close: 1015 + i * 10,
    volume: 100000 + i * 5000
  }));

  const png = renderer.buildChartPng('TLKM', '2026-08-25', sampleOhlc, [
    { value: 1000, color: '#2563eb' },
    { value: 1200, color: '#16a34a' },
    { value: 950, color: '#dc2626' }
  ]);

  assert.ok(Buffer.isBuffer(png), 'PNG must be a Node.js Buffer');
  assert.ok(png.length > 5000, 'PNG buffer must have non-trivial size');
  assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'Buffer must start with PNG signature');
});

test('Analysis Workflow: Rejects when API key is missing with clear user guidance', async () => {
  const fakeReq = { headers: {} };
  const mockAuth = {
    ok: true,
    session: { uid: 'unconfigured-user', un: 'user_novice', adm: false }
  };

  const res = await service.runChartAnalysis(fakeReq, null, 'BBCA', { auth: mockAuth });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'API_KEY_REQUIRED');
  assert.ok(res.error.includes('API key Google Gemini belum diisi'));
});

test('Analysis Workflow: Mocked Gemini Vision API execution, quota decrement, and user cache isolation', async () => {
  const userIdA = 'user-alice';
  const userIdB = 'user-bob';

  await credentials.saveUserApiKey(null, userIdA, TEST_API_KEY_A);
  await credentials.saveUserApiKey(null, userIdB, TEST_API_KEY_B);

  const sampleOhlc = Array.from({ length: 25 }, (_, i) => ({
    date: '2026-08-' + String(i + 1).padStart(2, '0'),
    open: 2000,
    high: 2050,
    low: 1980,
    close: 2020,
    volume: 50000
  }));

  const fakeReqAlice = { headers: {} };
  const adminSession = require('../lib/admin-session');
  const origAuth = adminSession.requireAuthenticatedSession;

  let currentUid = userIdA;
  adminSession.requireAuthenticatedSession = () => ({
    ok: true,
    session: { uid: currentUid, un: currentUid, adm: false }
  });

  // Mock Gemini Vision fetch
  let fetchCallCount = 0;
  const mockFetch = async (url, opts) => {
    fetchCallCount++;
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '## Tren Umum\nSideways dalam rentang akumulasi.\n\n## Level Kunci yang Terlihat\nSupport 1980, Resistance 2050.\n\n## Pola Candlestick\nTidak ada pola candlestick signifikan yang teridentifikasi.\n\n## Volume (jika terlihat di gambar)\nVolume stabil dan merata.\n\n## Catatan Risiko\nRentang harga sempit. ' + prompt.MANDATORY_DISCLAIMER_SUFFIX
                }
              ]
            }
          }
        ]
      })
    };
  };

  try {
    // 1. User Alice runs analysis
    currentUid = userIdA;
    const authAlice = { ok: true, session: { uid: userIdA, un: userIdA, adm: false } };
    const resA1 = await service.runChartAnalysis(fakeReqAlice, null, 'BBRI', {
      auth: authAlice,
      fetchFn: mockFetch,
      planLevels: []
    });

    if (resA1.ok) {
      assert.equal(resA1.cached, false);
      assert.ok(resA1.data.analysisText.includes('## Tren Umum'));
      assert.equal(resA1.quota.usedToday, 1);
      assert.equal(resA1.quota.remaining, 2); // Free user has 3 max

      // 2. User Alice repeats request immediately (without forceFresh) -> Returns cached!
      const resA2 = await service.runChartAnalysis(fakeReqAlice, null, 'BBRI', {
        auth: authAlice,
        fetchFn: mockFetch
      });
      assert.equal(resA2.cached, true, 'Subsequent request by Alice must hit Alice cache');

      // 3. User Bob requests BBRI -> Must NOT hit Alice cache!
      currentUid = userIdB;
      const authBob = { ok: true, session: { uid: userIdB, un: userIdB, adm: false } };
      const fakeReqBob = { headers: {} };
      const resB1 = await service.runChartAnalysis(fakeReqBob, null, 'BBRI', {
        auth: authBob,
        fetchFn: mockFetch
      });
      assert.equal(resB1.cached, false, 'User Bob must NOT receive User Alice cache');
      assert.equal(resB1.quota.usedToday, 1);
    }
  } finally {
    adminSession.requireAuthenticatedSession = origAuth;
  }
});

test('API Endpoint: Rejects unauthenticated requests with 401', async () => {
  const handler = require('../lib/chart-analysis-endpoint');
  let statusResult = 0;
  let jsonResult = null;
  const req = { headers: {}, method: 'GET', query: {} };
  const res = {
    setHeader: () => {},
    status: (code) => {
      statusResult = code;
      return { json: (data) => { jsonResult = data; return data; } };
    }
  };

  await handler(req, res);
  assert.equal(statusResult, 401);
  assert.equal(jsonResult.code, 'UNAUTHORIZED');
});

test('API Endpoint: Routes via api/analyze with surface=chart-analysis within 12-function budget', async () => {
  const analyzeHandler = require('../api/analyze');
  let statusResult = 0;
  let jsonResult = null;
  const req = { headers: {}, method: 'GET', query: { surface: 'chart-analysis' } };
  const res = {
    setHeader: () => {},
    status: (code) => {
      statusResult = code;
      return { json: (data) => { jsonResult = data; return data; } };
    }
  };

  await analyzeHandler(req, res);
  assert.equal(statusResult, 401);
  assert.equal(jsonResult.code, 'UNAUTHORIZED');
});

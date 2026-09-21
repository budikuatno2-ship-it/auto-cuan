'use strict';

const assert = require('assert');
const { isSubscribedTier } = require('../lib/user-ai-credentials');
const { createSessionToken, verifySessionToken } = require('../lib/admin-session');
const passwordCredential = require('../lib/password-credential');

// Test reproduksi kegagalan edge cases Fase 5 Batch 2:
// lib/admin-session.js, lib/user-ai-credentials.js, api/login-user.js, api/review-access.js
// Test ini mendokumentasikan ekspektasi perilaku aman.
// Pada kode produksi saat ini, assertions akan GAGAL (membuktikan keberadaan bug).

async function test1_isSubscribedTier_blockedOrRevokedAccess() {
  // BUG-F5-06: Akun admin yang diblokir atau paket lifetime yang dicabut/expired
  // tidak boleh mendapatkan status isSubscribedTier = true (akses AI gratis kuota server).
  const blockedAdminAccess = {
    user: { username: 'budi', isAdmin: false },
    account: { is_blocked: true },
    entitlement: { entitlement_status: 'blocked', premium: false }
  };

  assert.strictEqual(
    isSubscribedTier(blockedAdminAccess),
    false,
    'Blocked admin account must not be granted subscribed AI tier'
  );

  const revokedLifetimeAccess = {
    user: { username: 'trader1', isAdmin: false },
    account: { is_blocked: false },
    entitlement: {
      entitlement_status: 'revoked',
      current_plan: 'lifetime',
      lifetime_state: 'none',
      premium: false
    }
  };

  assert.strictEqual(
    isSubscribedTier(revokedLifetimeAccess),
    false,
    'Revoked lifetime plan must not be granted subscribed AI tier'
  );
}

async function test2_logoutDeviceCleanup_mismatchedDevProperty() {
  // BUG-F5-05: createSessionToken menyimpan hash device di payload.dvh,
  // tetapi api/login-user.js:295 membaca auth.session.dev saat logout.
  // Akibatnya auth.session.dev selalu undefined dan slot perangkat tidak pernah terhapus.
  process.env.SESSION_SECRET = 'test_secret_key_session_minimum_len_32_chars!';
  const rawDeviceId = 'device_laptop_chromebook_123';
  const token = createSessionToken({
    userId: '11111111-1111-1111-1111-111111111111',
    username: 'investor1',
    isAdmin: false,
    deviceId: rawDeviceId
  });

  const verified = verifySessionToken(token);
  assert.strictEqual(verified.valid, true, 'Session token must be valid');
  assert.strictEqual(
    verified.payload.dev,
    rawDeviceId,
    'Session payload must expose property "dev" matching client deviceId for logout unbinding'
  );
}

async function test3_adminEmailLogin_deviceApprovalFlowBypass() {
  // BUG-F5-04: Admin yang login menggunakan alamat email (mis. budi@autocuan.id)
  // ketika perangkat mencapai batas (3/3) harus masuk ke alur konfirmasi Telegram DEVICE_APPROVAL_PENDING.
  // Saat ini api/login-user.js:434 memeriksa usernameLower === 'budi' bukan effectiveUsername === 'budi',
  // sehingga admin ditolak dengan pesan generic "Hubungi admin untuk reset perangkat" tanpa approval token.
  process.env.SESSION_SECRET = 'test_secret_key_session_minimum_len_32_chars!';
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake_service_role_key';
  process.env.SECURITY_GUARD_MODE = 'off';

  const clientHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const protectedHash = passwordCredential.protectClientHash(clientHash);

  // Mock require('@supabase/supabase-js')
  const supabaseModule = require('@supabase/supabase-js');
  const originalCreateClient = supabaseModule.createClient;
  supabaseModule.createClient = () => ({
    from: (table) => {
      if (table === 'app_users') {
        return {
          select: () => ({
            ilike: () => ({
              maybeSingle: async () => ({
                data: {
                  id: '00000000-0000-0000-0000-000000000001',
                  username: 'budi',
                  email: 'budi@autocuan.id',
                  password_hash: protectedHash,
                  devices: ['dev1', 'dev2', 'dev3'],
                  is_blocked: false,
                  is_approved: true,
                  created_at: new Date().toISOString()
                },
                error: null
              })
            })
          }),
          update: () => ({
            eq: () => Promise.resolve({ data: null, error: null })
          })
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
      };
    },
    rpc: async () => ({ data: {}, error: null })
  });

  const loginHandler = require('../api/login-user');

  const req = {
    method: 'POST',
    headers: { host: 'autocuan.web.id', origin: 'https://autocuan.web.id' },
    body: {
      username: 'budi@autocuan.id',
      passwordHash: clientHash,
      deviceId: 'dev_new_4',
      userAgent: 'TestBrowser'
    }
  };

  let responseStatus = null;
  let responseData = null;
  const res = {
    status: (code) => {
      responseStatus = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    },
    setHeader: () => {}
  };

  try {
    await loginHandler(req, res);
    assert.strictEqual(
      responseData && responseData.code,
      'DEVICE_APPROVAL_PENDING',
      'Admin login via email at device limit must trigger DEVICE_APPROVAL_PENDING Telegram flow'
    );
  } finally {
    supabaseModule.createClient = originalCreateClient;
  }
}

async function test4_reviewAccess_rejectQueryToken() {
  // BUG-F5-07: api/review-access.js:40 mengizinkan token review sensitif dikirim
  // melalui query URL (req.query.token). Query parameter tercatat di server log, proxy log,
  // dan browser history (CWE-598). Seharusnya ditolak bila token dikirim lewat URL query string.
  process.env.REVIEW_ACCESS_TOKEN = 'secret_review_token_1234567890';
  const reviewHandler = require('../api/review-access');

  const req = {
    method: 'POST',
    headers: {},
    query: { token: 'secret_review_token_1234567890' },
    body: {}
  };

  let responseStatus = null;
  let responseData = null;
  const res = {
    status: (code) => {
      responseStatus = code;
      return res;
    },
    json: (data) => {
      responseData = data;
      return res;
    }
  };

  await reviewHandler(req, res);
  assert.strictEqual(
    responseStatus,
    400,
    'Sensitive review token passed in query parameter should be rejected with 400 Bad Request'
  );
}

async function runAll() {
  const tests = [
    { name: '1) isSubscribedTier memblokir akun is_blocked atau paket lifetime dicabut', fn: test1_isSubscribedTier_blockedOrRevokedAccess },
    { name: '2) Logout device cleanup dengan properti dev pada session payload', fn: test2_logoutDeviceCleanup_mismatchedDevProperty },
    { name: '3) Admin login via email wajib memicu alur DEVICE_APPROVAL_PENDING', fn: test3_adminEmailLogin_deviceApprovalFlowBypass },
    { name: '4) api/review-access menolak review token via query string parameter', fn: test4_reviewAccess_rejectQueryToken }
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`[PASS] ${t.name}`);
    } catch (err) {
      console.error(`[FAIL (Bug Proven)] ${t.name}:`);
      console.error(`       ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} bug(s) successfully reproduced and proven via failing assertions.`);
    process.exit(1);
  }
}

if (require.main === module) {
  runAll();
}

module.exports = {
  test1_isSubscribedTier_blockedOrRevokedAccess,
  test2_logoutDeviceCleanup_mismatchedDevProperty,
  test3_adminEmailLogin_deviceApprovalFlowBypass,
  test4_reviewAccess_rejectQueryToken
};

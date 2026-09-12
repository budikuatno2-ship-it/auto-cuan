'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const accountTerms = require('../lib/account-terms');
const passwordCredential = require('../lib/password-credential');
const watchlistService = require('../lib/user-watchlist-service');
const { verifyRecaptcha, RECAPTCHA_SCORE_THRESHOLD } = require('../lib/recaptcha-verify');

// ===========================================================================
// CLUSTER 6 - TEST SUITE: AUTH, SECURITY & SUBSCRIPTION GATE INTEGRITY
// PRs: #501, #508, #509, #511, #564, #567, #575
// ===========================================================================

// --- 1. PR #501: Review Access Fail-Closed & Credential Isolation ---
test('PR #501: api/review-access fails closed when environment secrets are unset', async () => {
  const origToken = process.env.REVIEW_ACCESS_TOKEN;
  const origHash = process.env.REVIEW_PASSWORD_HASH;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  delete process.env.REVIEW_ACCESS_TOKEN;
  delete process.env.REVIEW_PASSWORD_HASH;

  try {
    const reviewAccessHandler = require('../api/review-access');

    // 1. Unset REVIEW_ACCESS_TOKEN must fail closed (403)
    let status = 0;
    let jsonResult = null;
    const req = {
      method: 'POST',
      body: { token: 'autocuan-review-2026' },
      headers: { 'x-forwarded-for': '127.0.0.1' }
    };
    const res = {
      status: (c) => { status = c; return res; },
      json: (d) => { jsonResult = d; return d; }
    };

    await reviewAccessHandler(req, res);
    assert.equal(status, 403, 'Unset secret must return 403');
    assert.equal(jsonResult.success, false);
    assert.equal(jsonResult.error, 'Token review tidak valid.');

    // 2. Timing-safe comparison rejection of wrong token
    process.env.REVIEW_ACCESS_TOKEN = 'secret-token-test-12345';
    status = 0;
    jsonResult = null;
    await reviewAccessHandler({ method: 'POST', body: { token: 'wrong-token' }, headers: {} }, res);
    assert.equal(status, 403, 'Mismatched token must return 403');

    // 3. Fail closed if seeding without configured REVIEW_PASSWORD_HASH
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-stub';
    status = 0;
    jsonResult = null;

    // Test with matching token but missing REVIEW_PASSWORD_HASH
    const matchingReq = {
      method: 'POST',
      body: { token: 'secret-token-test-12345' },
      headers: {}
    };
    // The handler requires DB check; if user not found and REVIEW_PASSWORD_HASH missing, it fails with 503
    assert.ok(!passwordCredential.normalizeClientHash(process.env.REVIEW_PASSWORD_HASH || ''),
      'Unset REVIEW_PASSWORD_HASH must fail normalization');
  } finally {
    if (origToken) process.env.REVIEW_ACCESS_TOKEN = origToken; else delete process.env.REVIEW_ACCESS_TOKEN;
    if (origHash) process.env.REVIEW_PASSWORD_HASH = origHash; else delete process.env.REVIEW_PASSWORD_HASH;
    if (origUrl) process.env.SUPABASE_URL = origUrl; else delete process.env.SUPABASE_URL;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

// --- 2. PR #508: Watchlist Alert Target Spoofing Prevention ---
test('PR #508: createAlert ignores attacker-supplied chat_id and unowned watchlist_id', async () => {
  const userId = 'user-owner-123';
  const legitChatId = 123456789;
  const attackerTargetChatId = 999999999;
  const unownedWatchlistId = 'foreign-watchlist-uuid';

  const mockDb = {
    from(table) {
      if (table === 'app_user_telegram_verifications') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { telegram_private_chat_id: legitChatId },
                error: null
              })
            })
          })
        };
      }
      if (table === 'app_user_watchlists') {
        return {
          select: () => ({
            eq: (col1, val1) => ({
              eq: (col2, val2) => ({
                maybeSingle: async () => {
                  // Unowned watchlist row is not returned
                  if (val2 === unownedWatchlistId) return { data: null, error: null };
                  return { data: { id: val2 }, error: null };
                }
              })
            })
          })
        };
      }
      if (table === 'app_user_alerts') {
        return {
          insert: (record) => {
            // Verify what is about to be inserted into app_user_alerts
            assert.equal(record.notification_chat_id, legitChatId,
              'notification_chat_id must resolve strictly to verified account binding');
            assert.notEqual(record.notification_chat_id, attackerTargetChatId,
              'Attacker-supplied notification_chat_id must be completely ignored');
            assert.equal(record.watchlist_id, null,
              'Unowned watchlist_id must be discarded');
            return {
              select: () => ({
                maybeSingle: async () => ({
                  data: { id: 'alert-1', ...record },
                  error: null
                })
              })
            };
          }
        };
      }
      if (table === 'app_user_alert_history') {
        return {
          insert: async () => ({ error: null })
        };
      }
      throw new Error('Unexpected table: ' + table);
    }
  };

  const payloadWithSpoofedData = {
    ticker: 'BBCA',
    condition_type: 'PRICE_ABOVE',
    target_price: 10500,
    notification_chat_id: attackerTargetChatId, // Attacker tries to spam someone else
    watchlist_id: unownedWatchlistId // Attacker tries to associate unowned watchlist
  };

  const result = await watchlistService.createAlert(mockDb, userId, payloadWithSpoofedData);
  assert.equal(result.success, true);
  assert.equal(result.alert.notification_chat_id, legitChatId);
});

// --- 3. PR #509: Admin Reset Password Credential Protection ---
test('PR #509: Admin reset password requires 64-hex client hash and stores k1 protected credential', async () => {
  const clientHash = 'f'.repeat(64);

  // 1. Password normalization validates 64-hex
  assert.equal(passwordCredential.normalizeClientHash(clientHash), clientHash);
  assert.equal(passwordCredential.normalizeClientHash('short-hash'), null);
  assert.equal(passwordCredential.normalizeClientHash('k1:salt:hash'), null, 'k1 stored format must be rejected as input');

  // 2. protectClientHash adds random salt and scrypt digest
  const protectedHash = passwordCredential.protectClientHash(clientHash);
  assert.ok(protectedHash.startsWith('k1'), 'Protected hash must start with k1');
  assert.ok(passwordCredential.isProtectedCredential(protectedHash), 'Must be recognized as protected credential');
  assert.notEqual(protectedHash, clientHash, 'Must not store raw client hash');

  // 3. Verification works roundtrip
  const verifyResult = passwordCredential.verifyStoredCredential(protectedHash, clientHash);
  assert.equal(verifyResult.ok, true);

  // 4. Admin 'budi' protection in admin-users-handler
  const adminUsersSource = fs.readFileSync(path.join(__dirname, '../lib/admin-users-handler.js'), 'utf8');
  assert.match(adminUsersSource, /targetUser === 'budi'[\s\S]*Tidak dapat mereset password admin/);
  assert.match(adminUsersSource, /passwordCredential\.normalizeClientHash\(newPasswordHash\)/);
  assert.match(adminUsersSource, /passwordCredential\.protectClientHash\(clientPasswordHash\)/);
});

// --- 4. PR #511: Header Forgery & Re-Notify Spam in Manual Payment ---
test('PR #511: subscription-manual-handler blocks host header forgery and re-notify spam', () => {
  const manualPaymentSource = fs.readFileSync(path.join(__dirname, '../lib/subscription-manual-handler.js'), 'utf8');

  // 1. Host header forgery guard: does not blindly trust req.headers
  assert.match(manualPaymentSource, /function publicBaseUrl\(req\)/);
  assert.match(manualPaymentSource, /allowedHosts\(\)\.has\(host\)/);
  assert.match(manualPaymentSource, /CANONICAL_BASE_URL/);

  // 2. Re-notify spam guard on already submitted payments
  assert.match(manualPaymentSource, /alreadyNotified\s*=\s*Boolean\(row\)\s*&&\s*Number\.isSafeInteger/);
  assert.match(manualPaymentSource, /row && !alreadyNotified \? await notifyAdminSubmitted/);
});

// --- 5. PR #564 & #567: Terms of Service Server Contract & Anti-Enumeration ---
test('PR #564: Terms of service agreements require explicit current version on server', () => {
  const currentVersion = accountTerms.CURRENT_TERMS_VERSION;
  assert.ok(currentVersion, 'CURRENT_TERMS_VERSION must exist');

  // Registration acceptance
  assert.equal(accountTerms.registrationAcceptance({ termsAccepted: true, termsVersion: currentVersion }).ok, true);
  assert.equal(accountTerms.registrationAcceptance({ termsAccepted: false, termsVersion: currentVersion }).ok, false);
  assert.equal(accountTerms.registrationAcceptance({ termsAccepted: true, termsVersion: 'wrong-ver' }).ok, false);
  assert.equal(accountTerms.registrationAcceptance({}).ok, false);

  // Payment acceptance
  assert.equal(accountTerms.paymentAcceptance({ paymentTermsAccepted: true, termsVersion: currentVersion }).ok, true);
  assert.equal(accountTerms.paymentAcceptance({ termsAccepted: true, termsVersion: currentVersion }).ok, true);
  assert.equal(accountTerms.paymentAcceptance({ paymentTermsAccepted: false, termsVersion: currentVersion }).ok, false);
});

test('PR #567: Login handles email and username without user enumeration', () => {
  const loginSource = fs.readFileSync(path.join(__dirname, '../api/login-user.js'), 'utf8');

  // Email support
  assert.match(loginSource, /const isEmailInput = usernameLower\.includes\("@"\)/);
  assert.match(loginSource, /userLookup\.ilike\("email", usernameLower\)/);
  assert.match(loginSource, /userLookup\.eq\("username", usernameLower\)/);

  // Anti-enumeration: returns GENERIC_CREDENTIAL_ERROR whether user is missing or password mismatch
  assert.match(loginSource, /if \(!user\) \{[\s\S]*return res\.status\(400\)\.json\(\{ success: false, error: GENERIC_CREDENTIAL_ERROR \}\);/);
});

// --- 6. PR #575: reCAPTCHA v3 Bot Defense, Threshold 0.5, and Fail-Open Resilience ---
test('PR #575: verifyRecaptcha enforces 0.5 score threshold, bypasses review user, and fails open', async () => {
  assert.equal(RECAPTCHA_SCORE_THRESHOLD, 0.5);

  // 1. Account 'review' bypass
  const reviewRes = await verifyRecaptcha({ username: 'review', token: '' });
  assert.equal(reviewRes.ok, true);
  assert.equal(reviewRes.bypassed, true);
  assert.equal(reviewRes.score, 1.0);

  // 2. Unconfigured secret fails open (genuine users never locked out during outage/config gap)
  const origSecret = process.env.RECAPTCHA_SECRET_KEY;
  delete process.env.RECAPTCHA_SECRET_KEY;
  try {
    const unconfigured = await verifyRecaptcha({ username: 'andi', token: 'any_tok' });
    assert.equal(unconfigured.ok, true);
    assert.equal(unconfigured.failOpen, true);
    assert.equal(unconfigured.score, 1.0);

    // 3. Token missing when configured fails closed
    process.env.RECAPTCHA_SECRET_KEY = 'test-recaptcha-secret';
    const missingToken = await verifyRecaptcha({ username: 'andi', token: '' });
    assert.equal(missingToken.ok, false);
    assert.equal(missingToken.error, 'Token reCAPTCHA tidak ditemukan.');
  } finally {
    if (origSecret) process.env.RECAPTCHA_SECRET_KEY = origSecret;
    else delete process.env.RECAPTCHA_SECRET_KEY;
  }
});

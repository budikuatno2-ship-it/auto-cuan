'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

test('every inline script in the production page parses', () => {
  let count = 0;
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    count += 1;
    assert.doesNotThrow(() => new Function(match[1]), `inline script ${count} must parse`);
  }
  assert.ok(count > 0);
});

test('startup always has a public landing fallback and a bounded watchdog', () => {
  assert.match(html, /function renderStartupFallback\(\)/);
  assert.match(html, /catch \(_\) \{[\s\S]{0,180}renderStartupFallback\(\)/);
  // Keep this semantic rather than coupled to comment length inside the finally block.
  assert.match(html, /finally \{[\s\S]{0,420}initialLoader[\s\S]{0,420}renderStartupFallback\(\)/);
  assert.match(html, /setTimeout\(function\(\) \{ if \(document\.getElementById\('initialLoader'\)\) renderStartupFallback\(\); \}, 4500\)/);
  assert.match(html, /Beberapa fitur sementara tidak tersedia\./);
});

test('unprovisioned subscription controls fail closed without startup requests', () => {
  assert.match(html, /id="subscriptionTelegramLink"[^>]*disabled/);
  assert.match(html, /id="subscriptionTrialActivate"[^>]*disabled/);
  assert.match(html, /Fitur langganan sedang disiapkan\./);
  assert.doesNotMatch(html.slice(html.indexOf('function safeRequestId')), /subscription-trial-activate[\s\S]{0,500}crypto\.randomUUID\(\)/);
  assert.match(html, /function safeRequestId\(\) \{ return generateDeviceUuid\(\); \}/);
  assert.match(html, /AbortController/);
  assert.match(html, /response\.ok/);
  assert.match(html, /application\/json/);
});

test('critical DOM ids are unique and api endpoint boundary remains unchanged', () => {
  for (const id of ['initialLoader', 'landingPage', 'dashboardScreen', 'blockedScreen', 'maintenanceScreen']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must be unique`);
  }
  assert.equal(fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.js')).length, 12);
  assert.equal((html.match(/id="deleteUser/gi) || []).length, 0, 'no Delete User control');
});

test('disabled capability hides all unfinished dashboard and admin subscription controls', () => {
  assert.match(html, /id="subscriptionIdentityCard"[^>]*(?:hidden|class="hidden)/);
  assert.match(html, /id="subscriptionPlansAdminButton"[^>]*disabled/);
  assert.match(html, /id="subscriptionPlansAdminButton"[^>]*(?:hidden|class="hidden)/);
  assert.equal((html.match(/voucher/gi) || []).length, 0, 'no voucher administration UI is rendered');
  const catalog = html.slice(html.indexOf('async function loadSubscriptionCatalog'));
  assert.match(catalog, /!subscriptionCapability\.ready\) return/);
  assert.ok(catalog.indexOf('catalogCall') > catalog.indexOf('!subscriptionCapability.ready'), 'catalog fetch is behind the disabled capability guard');
  assert.doesNotMatch(html, /subscriptionCapability\s*=\s*\{\s*enabled:true/);
});

test('server-owned capability defaults disabled and probes enabled schema safely', async () => {
  const capability = require('../lib/subscription-capability');
  for (const value of [undefined, '', 'false', '0', 'TRUE', 'yes', 'anything']) {
    assert.equal(capability.isSubscriptionFeatureEnabled({ SUBSCRIPTION_FEATURE_ENABLED: value }), false, String(value));
  }
  assert.equal(capability.isSubscriptionFeatureEnabled({ SUBSCRIPTION_FEATURE_ENABLED: 'true' }), true);
  assert.deepEqual(await capability.getSubscriptionCapability(null, { SUBSCRIPTION_FEATURE_ENABLED: 'true' }), { enabled: true, ready: false, reason: 'unavailable' });
  assert.deepEqual(await capability.getSubscriptionCapability({ from() { return { select() { return { limit() { return Promise.resolve({ error: { message: 'missing table' } }); } }; } }; } }, { SUBSCRIPTION_FEATURE_ENABLED: 'true' }), { enabled: true, ready: false, reason: 'unavailable' });
  assert.deepEqual(await capability.getSubscriptionCapability({ from() { return { select() { return { limit() { return Promise.resolve({ data: [], error: null }); } }; } }; } }, { SUBSCRIPTION_FEATURE_ENABLED: 'true' }), { enabled: true, ready: true });
});

test('API subscription actions are server-gated while normal admin functions stay separate', () => {
  const loginApi = fs.readFileSync(path.join(root, 'api', 'login-user.js'), 'utf8');
  const adminApi = fs.readFileSync(path.join(root, 'api', 'admin-users.js'), 'utf8');
  assert.match(loginApi, /subscriptionAction === 'subscription-capability'/);
  assert.match(loginApi, /if \(!isSubscriptionFeatureEnabled\(\)\) return res\.status\(503\)/);
  assert.match(adminApi, /catalogActions\.indexOf\(action\) >= 0 && !isSubscriptionFeatureEnabled\(\)/);
  assert.match(adminApi, /getSubscriptionCapability\(supabase\)/);
  assert.match(adminApi, /if \(action === 'list'\)/, 'normal admin list behavior remains outside catalog gate');
});

test('disabled server gate rejects subscription mutations without touching database configuration', async () => {
  const prior = process.env.SUBSCRIPTION_FEATURE_ENABLED;
  delete process.env.SUBSCRIPTION_FEATURE_ENABLED;
  const handler = require('../api/login-user');
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await handler({ method: 'POST', query: { action: 'subscription-trial-activate' }, body: { action: 'subscription-trial-activate' }, headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { success: false, error: 'Fitur langganan belum tersedia.' });
  } finally {
    if (prior === undefined) delete process.env.SUBSCRIPTION_FEATURE_ENABLED;
    else process.env.SUBSCRIPTION_FEATURE_ENABLED = prior;
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('subscription page stays dormant: markup preserved, every entry point hidden', () => {
  // The comparison page markup is kept for the future rollout…
  assert.match(html, /id="page-subscription"/);
  assert.match(html, /Paket Langganan/);
  // …but no navigation button or CTA can reach it while payment is postponed.
  assert.doesNotMatch(html, /data-page="subscription"/);
  assert.doesNotMatch(html, /onclick="openSubscriptionPage\(\)"/);
  assert.doesNotMatch(html, /onclick="navigateTo\('subscription'\)"/);
  assert.match(html, /grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3/);
  ['Free', 'Trial 10 Hari', 'Premium 1 Bulan', 'Premium 2 Bulan', 'Premium 3 Bulan', 'Lifetime'].forEach(label => assert.ok(html.includes(label), label));
  assert.match(html, /Paling Populer/);
  assert.match(html, /Lebih Hemat/);
  assert.match(html, /tujuh kursi bersama/);
  assert.doesNotMatch(html, /Trial\s+1[7] Hari/);
  assert.doesNotMatch(html, /1[7] hari · aktivasi mengikuti server/);
  assert.match(html, /subscriptionRemainingTime\(e\.expires_at\)/);
});

test('Phase 6A uses existing read-only catalogue and entitlement endpoints only', () => {
  assert.match(html, /action=subscription-plans/);
  assert.match(html, /safeSubscriptionRequest\('subscription-status'/);
  assert.match(html, /Pilihan pembayaran belum dibuka/);
  assert.doesNotMatch(html, /tersedia pada tahap berikutnya/);
  assert.doesNotMatch(html, /midtrans/i);
  assert.equal(fs.readdirSync(path.join(__dirname, '..', 'api')).filter(name => name.endsWith('.js')).length, 12);
});

test('Phase 6A keeps public catalogue loading independent from optional account status', () => {
  assert.match(html, /fetch\('\/api\/login-user\?action=subscription-plans'/);
  assert.match(html, /if\(isAutocuanLoggedIn\(\)\)try\{var x=await safeSubscriptionRequest\('subscription-status'/);
  assert.match(html, /else subscriptionExperience\.status=null;renderSubscriptionSummary\(\);renderSubscriptionPlans\(\);/);
  assert.match(html, /Masuk untuk melihat status langganan dan masa aktif Anda\./);
  assert.match(html, /Status langganan belum dapat dimuat\./);
  assert.match(html, /Data langganan belum dapat dimuat\./);
  assert.match(html, /Daftar paket belum dapat dimuat\./);
  assert.doesNotMatch(html, /Katalog tetap dapat dilihat/);
  assert.doesNotMatch(html, /pembayaran online hadir di fase berikutnya/);
});


test('startup uses one accessible top-level view and keeps a loading shell visible', () => {
  assert.match(html, /id="initialLoader"/);
  assert.match(html, /Memuat Auto-Cuan\.\.\./);
  assert.match(html, /function setTopLevelView\(state\)/);
  assert.match(html, /el\.setAttribute\('aria-hidden'/);
  assert.match(html, /el\.inert = !active/);
  assert.match(html, /setTopLevelView\('blocked'\)/);
  assert.match(html, /setTopLevelView\('maintenance'\)/);
  assert.match(html, /setTopLevelView\('landing'\)/);
  assert.match(html, /setTopLevelView\('app'\)/);
  assert.doesNotMatch(html, /Auto-CuanIDX Stock Radar/);
  assert.doesNotMatch(html, /FiturCara KerjaSafetyPreviewLogin/);
});

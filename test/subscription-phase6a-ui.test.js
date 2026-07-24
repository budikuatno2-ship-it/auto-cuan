'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('Phase 6A exposes public subscription entry points and a responsive comparison page', () => {
  assert.match(html, /data-page="subscription"/);
  assert.match(html, /Paket Subscription/);
  assert.match(html, /id="page-subscription"/);
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
  assert.match(html, /Pembayaran online akan tersedia pada Phase 6B/);
  assert.doesNotMatch(html, /midtrans/i);
  assert.equal(fs.readdirSync(path.join(__dirname, '..', 'api')).filter(name => name.endsWith('.js')).length, 12);
});

test('Phase 6A keeps public catalogue loading independent from optional account status', () => {
  assert.match(html, /fetch\('\/api\/login-user\?action=subscription-plans'/);
  assert.match(html, /if\(isAutocuanLoggedIn\(\)\)try\{var x=await safeSubscriptionRequest\('subscription-status'/);
  assert.match(html, /else subscriptionExperience\.status=null;renderSubscriptionSummary\(\);renderSubscriptionPlans\(\);/);
  assert.match(html, /Masuk untuk melihat status dan masa aktif Anda\./);
  assert.match(html, /Katalog belum tersedia\./);
  assert.match(html, /Status subscription belum tersedia\./);
});

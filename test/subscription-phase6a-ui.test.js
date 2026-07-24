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
  ['Free', 'Trial 17 Hari', 'Premium 1 Bulan', 'Premium 2 Bulan', 'Premium 3 Bulan', 'Lifetime'].forEach(label => assert.ok(html.includes(label), label));
  assert.match(html, /Paling Populer/);
  assert.match(html, /Lebih Hemat/);
  assert.match(html, /tujuh kursi bersama/);
});

test('Phase 6A uses existing read-only catalogue and entitlement endpoints only', () => {
  assert.match(html, /action=subscription-plans/);
  assert.match(html, /safeSubscriptionRequest\('subscription-status'/);
  assert.match(html, /Pembayaran online akan tersedia pada Phase 6B/);
  assert.doesNotMatch(html, /midtrans/i);
  assert.equal(fs.readdirSync(path.join(__dirname, '..', 'api')).filter(name => name.endsWith('.js')).length, 12);
});

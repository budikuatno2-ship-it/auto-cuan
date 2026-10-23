'use strict';

// C1 (22 Oct 2026) — a spoofed `X-Forwarded-For` header must not be able to mint
// a fresh rate-limit bucket.
//
// The registration limiter (`lib/request-rate-limit.js` -> `api/register-user.js`)
// used to read the FIRST `x-forwarded-for` entry, which the client supplies. These
// tests pin the corrected resolution: headers are trusted only behind a trusted
// proxy, and even then never the client-controlled first entry.

const test = require('node:test');
const assert = require('node:assert/strict');

const { clientAddress, createRateLimiter } = require('../lib/request-rate-limit');
const trustedProxy = require('../lib/trusted-proxy');

function req(peer, headers) {
  return { headers: headers || {}, socket: { remoteAddress: peer }, connection: { remoteAddress: peer } };
}

test('C1: a direct (untrusted peer) client cannot forge its address via X-Forwarded-For', () => {
  const r = req('203.0.113.9', { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' });
  // The TCP peer is authoritative; the forged headers are ignored entirely.
  assert.equal(clientAddress(r), '203.0.113.9');
});

test('C1: changing the spoofed X-Forwarded-For does NOT change the rate-limit key', () => {
  const a = clientAddress(req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' }));
  const b = clientAddress(req('203.0.113.9', { 'x-forwarded-for': '2.2.2.2' }));
  assert.equal(a, b);

  const limiter = createRateLimiter({ windowMs: 60000, max: 2 });
  // Two requests from the same real peer with DIFFERENT forged XFF headers must
  // share one bucket, so the third is refused.
  assert.equal(limiter.check(clientAddress(req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' }))), true);
  assert.equal(limiter.check(clientAddress(req('203.0.113.9', { 'x-forwarded-for': '2.2.2.2' }))), true);
  assert.equal(limiter.check(clientAddress(req('203.0.113.9', { 'x-forwarded-for': '3.3.3.3' }))), false);
});

test('C1: behind Cloudflare, CF-Connecting-IP wins over a spoofed XFF', () => {
  const r = req('104.16.0.5', {
    'cf-connecting-ip': '198.51.100.7',
    'x-forwarded-for': '9.9.9.9, 198.51.100.7'
  });
  assert.equal(clientAddress(r), '198.51.100.7');
});

test('C1: behind a local nginx hop, the LAST XFF entry is used, not the client-forged first', () => {
  // nginx (peer 127.0.0.1) appends the real client 198.51.100.7 after the client's
  // spoofed 9.9.9.9. The old code returned 9.9.9.9; the fix returns the last entry.
  const r = req('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 198.51.100.7' });
  assert.equal(clientAddress(r), '198.51.100.7');
});

test('C1: trusted-proxy classification is fail-closed for unknown peers', () => {
  assert.equal(trustedProxy.isTrustedProxyIp('104.16.0.5'), true, 'Cloudflare edge is trusted');
  assert.equal(trustedProxy.isTrustedProxyIp('127.0.0.1'), true, 'loopback nginx is trusted');
  assert.equal(trustedProxy.isTrustedProxyIp('10.0.0.4'), true, 'private hop is trusted');
  assert.equal(trustedProxy.isTrustedProxyIp('203.0.113.9'), false, 'public client is NOT trusted');
  assert.equal(trustedProxy.isTrustedProxyIp('::1'), true);
  assert.equal(trustedProxy.isTrustedProxyIp('198.51.100.7'), false);
});

test('C1: IPv6-mapped IPv4 peers are normalized', () => {
  assert.equal(trustedProxy.normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(clientAddress(req('::ffff:203.0.113.9', { 'x-forwarded-for': '1.2.3.4' })), '203.0.113.9');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const authHandler = require('../lib/auth-service');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    }
  };
  return res;
}

// Generate test RSA keypair for authentic token simulation in isolated test env
const testKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const testJwk = testKeyPair.publicKey.export({ format: 'jwk' });
testJwk.kid = 'test-valid-kid';
testJwk.alg = 'RS256';
const testInjectedJwks = [testJwk];

function createTestToken(payloadOverrides = {}, headerOverrides = {}) {
  const header = {
    alg: 'RS256',
    kid: 'test-valid-kid',
    typ: 'JWT',
    ...headerOverrides
  };
  const payload = {
    iss: 'https://accounts.google.com',
    aud: 'my-autocuan-client-id.apps.googleusercontent.com',
    sub: '109876543210987654321',
    email: 'investor_test@gmail.com',
    email_verified: true,
    name: 'Investor Test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...payloadOverrides
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sign = crypto.createSign('SHA256');
  sign.update(`${headerB64}.${payloadB64}`);
  const signatureB64 = sign.sign(testKeyPair.privateKey).toString('base64url');

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

test('AUTH-SEC-01: Raw email payload without Google ID token MUST be rejected with HTTP 400', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';
  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { email: 'budi@gmail.com' },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res);

  assert.equal(res.statusCode, 400, 'Raw email payload must be rejected with 400 Bad Request');
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /ID Token Google \(JWT\) wajib disertakan/);
  assert.equal(Boolean(res.headers['set-cookie']), false, 'No session cookie should be issued');
});

test('AUTH-SEC-02: Feature flag returns 503 if GOOGLE_CLIENT_ID is missing or not configured', async () => {
  const origClientId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: 'dummy-token' },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res);
  assert.equal(res.statusCode, 503, 'Must return 503 Service Unavailable when client ID not set');
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /tidak aktif atau belum dikonfigurasi/);

  if (origClientId) process.env.GOOGLE_CLIENT_ID = origClientId;
});

test('AUTH-SEC-03: Forged or invalid signature JWT must be rejected with 401', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';

  // Create a token signed by an untrusted rogue keypair
  const rogueKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-valid-kid', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: 'my-autocuan-client-id.apps.googleusercontent.com',
    sub: '999999999',
    email: 'attacker@gmail.com',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64url');
  const sign = crypto.createSign('SHA256');
  sign.update(`${headerB64}.${payloadB64}`);
  const signatureB64 = sign.sign(rogueKeyPair.privateKey).toString('base64url');
  const forgedToken = `${headerB64}.${payloadB64}.${signatureB64}`;

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: forgedToken },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res, { injectedJwks: testInjectedJwks });
  assert.equal(res.statusCode, 401, 'Forged signature must be rejected with 401');
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /tidak valid/);
});

test('AUTH-SEC-04: Expired Google ID token must be rejected with 401', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';

  const expiredToken = createTestToken({
    exp: Math.floor(Date.now() / 1000) - 300 // expired 5 minutes ago
  });

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: expiredToken },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res, { injectedJwks: testInjectedJwks });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /kedaluwarsa/);
});

test('AUTH-SEC-05: Audience (aud) mismatch must be rejected with 401', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';

  const mismatchedAudToken = createTestToken({
    aud: 'another-unrelated-app.apps.googleusercontent.com'
  });

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: mismatchedAudToken },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res, { injectedJwks: testInjectedJwks });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /Audience \(aud\) token tidak sesuai/);
});

test('AUTH-SEC-06: Unverified email (email_verified: false) must be rejected with 401', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';

  const unverifiedEmailToken = createTestToken({
    email_verified: false
  });

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: unverifiedEmailToken },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res, { injectedJwks: testInjectedJwks });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /Email Google belum terverifikasi/);
});

test('AUTH-SEC-07: Valid signed Google ID token is verified successfully', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';

  const validToken = createTestToken({
    email: 'trader_sukses@gmail.com',
    sub: 'google_user_unique_12345'
  });

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: validToken },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res, { injectedJwks: testInjectedJwks });
  assert.equal(res.statusCode, 200, 'Valid token must be accepted with 200 OK');
  assert.equal(res.body.success, true);
  assert.equal(res.body.email, 'trader_sukses@gmail.com');
  assert.equal(res.body.google_id, 'google_user_unique_12345');
});

test('AUTH-SEC-08: Admin session cookie (adm: true) is NEVER granted without verified DB admin record', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-autocuan-client-id.apps.googleusercontent.com';

  // An attacker claiming to be 'budi@gmail.com' via token
  const budiToken = createTestToken({
    email: 'budi_fake@gmail.com',
    sub: 'rogue_sub_999'
  });

  const req = {
    method: 'POST',
    url: '/api/auth/google',
    _authSubPath: 'google',
    query: {},
    body: { credential: budiToken },
    headers: { 'content-type': 'application/json' }
  };
  const res = mockRes();

  await authHandler(req, res, { injectedJwks: testInjectedJwks });
  // Since user doesn't exist in DB as approved admin, it must not return registered: true or set admin cookie
  assert.notEqual(res.body.registered, true);
  assert.equal(Boolean(res.headers['set-cookie']), false);
});

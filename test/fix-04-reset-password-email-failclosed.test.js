'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const resetPasswordHandler = require('../api/reset-password.js');
const adminSession = require('../lib/admin-session');

process.env.SESSION_SECRET = 'test-secret-session-salt-12345';

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    }
  };
  return res;
}

test('FIX-04: update-email rejects invalid email patterns like "a@", "@x", "a b@c", "no-tld@domain"', async () => {
  const token = adminSession.createSessionToken({ userId: 'usr-1', username: 'budi', isAdmin: true });
  const invalidEmails = ['a@', '@x', 'a b@c', 'user@domain'];

  for (const badEmail of invalidEmails) {
    const req = {
      method: 'POST',
      body: { action: 'update-email', email: badEmail },
      headers: {
        cookie: `ac_sess=${token}`
      }
    };
    const res = createMockRes();
    await resetPasswordHandler(req, res);

    assert.equal(res.statusCode, 400, `Email "${badEmail}" must be rejected with HTTP 400`);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'Email tidak valid.');
  }
});

test('FIX-04: update-email fails closed with HTTP 503 when Supabase env is missing', async () => {
  const token = adminSession.createSessionToken({ userId: 'usr-1', username: 'budi', isAdmin: true });
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const req = {
      method: 'POST',
      body: { action: 'update-email', email: 'valid.user@example.com' },
      headers: {
        cookie: `ac_sess=${token}`
      }
    };
    const res = createMockRes();
    await resetPasswordHandler(req, res);

    assert.equal(res.statusCode, 503, 'Must return HTTP 503 when Supabase credentials are missing');
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'Database belum dikonfigurasi.');
  } finally {
    if (oldUrl) process.env.SUPABASE_URL = oldUrl;
    if (oldKey) process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});

'use strict';

// B4 (22 Oct 2026) — the development header identity used by
// lib/money-management-handler.js must be gated on an EXPLICIT opt-in flag, not
// on `NODE_ENV !== 'production'`. A missing/typo'd NODE_ENV is not a security
// boundary for a per-user financial module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { devHeaderIdentityEnabled } = require('../lib/dev-header-identity');
const moneyHandler = require('../lib/money-management-handler');

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; }
  };
}

function mockReq(headers) {
  return { method: 'GET', headers: headers || {}, query: { action: 'get-cashflow', month: '2026-10' }, body: {} };
}

test('B4: the dev header identity flag requires the EXPLICIT flag and is never honored in production', () => {
  // The explicit flag is the actual gate.
  assert.equal(devHeaderIdentityEnabled({ ALLOW_DEV_HEADER_IDENTITY: '1', NODE_ENV: 'test' }), true);
  assert.equal(devHeaderIdentityEnabled({ ALLOW_DEV_HEADER_IDENTITY: '1', NODE_ENV: 'development' }), true);
  // No flag -> never enabled, regardless of NODE_ENV (this is the key fix: an
  // unset/typo'd NODE_ENV alone must NOT enable header identity).
  assert.equal(devHeaderIdentityEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(devHeaderIdentityEnabled({}), false);
  assert.equal(devHeaderIdentityEnabled({ NODE_ENV: '' }), false);
  // Production -> never enabled, even if the flag is somehow set.
  assert.equal(devHeaderIdentityEnabled({ ALLOW_DEV_HEADER_IDENTITY: '1', NODE_ENV: 'production' }), false);
});

test('B4: the handler no longer keys identity on a bare process.env.NODE_ENV check', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'money-management-handler.js'), 'utf8');
  assert.doesNotMatch(src, /process\.env\.NODE_ENV\s*!==\s*'production'/);
  assert.match(src, /devHeaderIdentityEnabled\(\)/);
});

test('B4: production PM2 config never sets the dev header flag', () => {
  const eco = fs.readFileSync(path.join(__dirname, '..', 'ecosystem.config.js'), 'utf8');
  assert.doesNotMatch(eco, /ALLOW_DEV_HEADER_IDENTITY/);
});

test('B4: a forged x-user-id without a session is rejected (401) when the flag is off', async () => {
  const savedFlag = process.env.ALLOW_DEV_HEADER_IDENTITY;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.ALLOW_DEV_HEADER_IDENTITY;
  process.env.NODE_ENV = 'test';
  try {
    const res = mockRes();
    await moneyHandler(mockReq({ 'x-user-id': '999999' }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body && res.body.code, 'UNAUTHORIZED');
  } finally {
    if (savedFlag !== undefined) process.env.ALLOW_DEV_HEADER_IDENTITY = savedFlag; else delete process.env.ALLOW_DEV_HEADER_IDENTITY;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv; else delete process.env.NODE_ENV;
  }
});

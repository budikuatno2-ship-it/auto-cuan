'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { runAudit, auditEnv, auditSource } = require('../tools/verify-production-readiness');

const ROOT = path.resolve(__dirname, '..');

const FULL_ENV = {
  APP_SECRET: 'a'.repeat(32),
  SUPABASE_SERVICE_ROLE_KEY: 'b'.repeat(40),
  GEMINI_API_KEY: 'AIza' + 'c'.repeat(30)
};

test('auditEnv passes when all required vars are present', () => {
  const results = auditEnv(FULL_ENV);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
});

test('auditEnv accepts ENCRYPTION_SECRET as APP_SECRET alias', () => {
  const env = { ...FULL_ENV, APP_SECRET: undefined, ENCRYPTION_SECRET: 'd'.repeat(32) };
  const appSecret = auditEnv(env).find((r) => r.check === 'env:APP_SECRET');
  assert.strictEqual(appSecret.ok, true);
  assert.match(appSecret.detail, /ENCRYPTION_SECRET/);
});

test('auditEnv accepts GEMINI_API_KEY_PRIMARY as GEMINI_API_KEY alias', () => {
  const env = { ...FULL_ENV, GEMINI_API_KEY: undefined, GEMINI_API_KEY_PRIMARY: 'AIza' + 'e'.repeat(30) };
  const gemini = auditEnv(env).find((r) => r.check === 'env:GEMINI_API_KEY');
  assert.strictEqual(gemini.ok, true);
});

test('auditEnv fails closed on missing or too-short secrets', () => {
  const results = auditEnv({ APP_SECRET: 'short', SUPABASE_SERVICE_ROLE_KEY: '', GEMINI_API_KEY: undefined });
  assert.ok(results.every((r) => r.ok === false), JSON.stringify(results));
});

test('auditSource finds no hardcoded credential patterns in shipped source', () => {
  const results = auditSource(ROOT);
  const failures = results.filter((r) => !r.ok);
  assert.deepStrictEqual(failures, [], JSON.stringify(failures));
});

test('runAudit is not ready when env is empty, ready when fully configured', () => {
  assert.strictEqual(runAudit({ env: {}, rootDir: ROOT }).ready, false);
  assert.strictEqual(runAudit({ env: FULL_ENV, rootDir: ROOT }).ready, true);
});

test('runAudit never leaks secret values in its report', () => {
  const report = runAudit({ env: FULL_ENV, rootDir: ROOT });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(FULL_ENV.APP_SECRET));
  assert.ok(!serialized.includes(FULL_ENV.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(!serialized.includes(FULL_ENV.GEMINI_API_KEY));
});
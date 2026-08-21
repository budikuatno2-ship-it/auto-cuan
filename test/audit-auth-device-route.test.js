'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('active auth-v2 login preserves Recovery V2 device retirement contract', () => {
  const client = fs.readFileSync('public/auth-v2.js', 'utf8');
  const gateway = fs.readFileSync('api/reset-password.js', 'utf8');
  const delegated = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  assert.doesNotMatch(client, /deviceId\s*:/);
  assert.doesNotMatch(gateway, /loginUserHandler/);
  assert.match(delegated, /async function login\(req, res, db\)/);
  assert.match(delegated, /createSessionToken/);
});

test('register, active login, direct legacy API login, and reset support protected credentials', () => {
  const register = fs.readFileSync('api/register-user.js', 'utf8');
  const delegated = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  const directLogin = fs.readFileSync('api/login-user.js', 'utf8');
  assert.match(register, /protectClientHash\(passwordHash\)/);
  assert.match(delegated, /p_new_password_hash: passwordCredential\.protectClientHash\(newPasswordHash\)/);
  assert.match(delegated, /verifyStoredCredential\(user\.password_hash, passwordHash\)/);
  assert.match(delegated, /credentialCheck\.needsUpgrade/);
  assert.match(directLogin, /verifyStoredCredential\(user\.password_hash, passwordHash\)/);
  assert.match(directLogin, /credentialCheck\.needsUpgrade/);
});

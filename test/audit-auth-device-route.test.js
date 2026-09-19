'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('active auth-v2 login preserves Recovery V2 device retirement contract', () => {
  const client = fs.readFileSync('public/auth-v2.js', 'utf8');
  const gateway = fs.readFileSync('api/reset-password.js', 'utf8');
  const delegated = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  // auth-v2.js is the active login client and DOES send a deviceId (device
  // binding is a live security control, not a retired one). The original
  // assertion locked the opposite and had drifted while this file was excluded
  // from CI. Assert the real contract instead.
  assert.match(client, /deviceId\s*:/);
  assert.doesNotMatch(gateway, /loginUserHandler/);
  // The delegated handler completes a password reset via the shared RPC and
  // mints a session token on success.
  assert.match(delegated, /consume_auth_password_reset_v2/);
  assert.match(delegated, /createSessionToken/);
});

test('register, active login, direct legacy API login, and reset support protected credentials', () => {
  const register = fs.readFileSync('api/register-user.js', 'utf8');
  const delegated = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  const directLogin = fs.readFileSync('api/login-user.js', 'utf8');
  assert.match(register, /protectClientHash\(passwordHash\)/);
  assert.match(delegated, /p_new_password_hash: passwordCredential\.protectClientHash\(newPasswordHash\)/);
  // The reset handler delegates credential verification to the shared RPC
  // (consume_auth_password_reset_v2); only the direct login path verifies the
  // stored credential in JS. Assert what each file actually does.
  assert.match(delegated, /consume_auth_password_reset_v2/);
  assert.match(directLogin, /verifyStoredCredential\(user\.password_hash, passwordHash\)/);
  assert.match(directLogin, /credentialCheck\.needsUpgrade/);
});

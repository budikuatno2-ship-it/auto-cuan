from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    p.write_text(text.replace(old, new, 1))


# Preserve the repository's intentional production contract: security guard
# enforcement stays deployment-opt-in until the rollout explicitly enables it.
replace_once(
    'lib/security-guard.js',
    "SECURITY_GUARD_MODE || 'enforce'",
    "SECURITY_GUARD_MODE || 'off'",
    'security guard restore'
)

# Auth Recovery V2 deliberately retired browser device IDs. The delegated
# reset-password handler already owns the active login/session contract, so undo
# the temporary reroute to the older device-bound API handler.
replace_once(
    'api/reset-password.js',
    "const accountProfileHandler = require('../lib/account-profile-handler');\nconst loginUserHandler = require('./login-user');\n",
    "const accountProfileHandler = require('../lib/account-profile-handler');\n",
    'gateway login import restore'
)
replace_once(
    'api/reset-password.js',
    "  if (req.method === 'POST' && bodyAction === 'login') {\n    return loginUserHandler(req, res);\n  }\n",
    '',
    'gateway login route restore'
)

# Remove the temporary browser device fingerprint helper/payload.
auth = Path('public/auth-v2.js')
auth_text = auth.read_text()
helper_start = auth_text.find("\n  function loginDeviceId() {\n")
helper_end = auth_text.find("\n  function ", helper_start + 5) if helper_start >= 0 else -1
if helper_start < 0 or helper_end < 0:
    raise SystemExit('auth-v2 loginDeviceId helper bounds not found')
auth_text = auth_text[:helper_start] + auth_text[helper_end:]
device_line = "        deviceId: loginDeviceId(),\n"
if auth_text.count(device_line) != 1:
    raise SystemExit('auth-v2 device payload line not found exactly once')
auth.write_text(auth_text.replace(device_line, '', 1))

# The delegated Recovery V2 login is the active frontend path. Protect it with
# the same fixed-width server-side KDF and transparently migrate legacy raw
# client hashes after successful verification.
legacy = Path('lib/reset-password-legacy-handler.js')
legacy_text = legacy.read_text()
old_login = """  const user = lookup.data;
  if (!user || !hashesMatch(user.password_hash, passwordHash)) {
    await loginGuard.failure(user ? 'bad_password' : 'unknown_account');
    return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
  }

  await loginGuard.credentialAccepted('credentials_valid');
"""
new_login = """  const user = lookup.data;
  const credentialCheck = user
    ? passwordCredential.verifyStoredCredential(user.password_hash, passwordHash)
    : { ok: false, needsUpgrade: false };
  if (!user || !credentialCheck.ok) {
    await loginGuard.failure(user ? 'bad_password' : 'unknown_account');
    return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
  }

  // Upgrade historical raw client prehashes after a successful credential
  // check. Compare-and-swap prevents concurrent logins from overwriting a newer
  // credential; migration failure is non-fatal and can retry next login.
  if (credentialCheck.needsUpgrade) {
    try {
      const protectedCredential = passwordCredential.protectClientHash(passwordHash);
      const upgraded = await db
        .from('app_users')
        .update({ password_hash: protectedCredential })
        .eq('id', user.id)
        .eq('password_hash', user.password_hash);
      if (upgraded.error) console.error('auth-v2 credential migration failed');
    } catch (_) {
      console.error('auth-v2 credential migration failed');
    }
  }

  await loginGuard.credentialAccepted('credentials_valid');
"""
if legacy_text.count(old_login) != 1:
    raise SystemExit('active recovery-v2 login credential anchor not found exactly once')
legacy.write_text(legacy_text.replace(old_login, new_login, 1))

# Normalize generated source-contract tests and make the auth regression model
# the actual Recovery V2 architecture rather than the retired device model.
for name in (
    'test/audit-portfolio-concurrency.test.js',
    'test/audit-cron-and-top5-lock.test.js',
):
    p = Path(name)
    text = p.read_text()
    if text.startswith('\\\n'):
        p.write_text(text[2:])

Path('test/audit-auth-device-route.test.js').write_text("""'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('active auth-v2 login preserves Recovery V2 device retirement contract', () => {
  const client = fs.readFileSync('public/auth-v2.js', 'utf8');
  const gateway = fs.readFileSync('api/reset-password.js', 'utf8');
  const delegated = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  assert.doesNotMatch(client, /deviceId\\s*:/);
  assert.doesNotMatch(gateway, /loginUserHandler/);
  assert.match(delegated, /async function login\\(req, res, db\\)/);
  assert.match(delegated, /createSessionToken/);
});

test('register, active login, direct legacy API login, and reset support protected credentials', () => {
  const register = fs.readFileSync('api/register-user.js', 'utf8');
  const delegated = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  const directLogin = fs.readFileSync('api/login-user.js', 'utf8');
  assert.match(register, /protectClientHash\\(passwordHash\\)/);
  assert.match(delegated, /p_new_password_hash: passwordCredential\\.protectClientHash\\(newPasswordHash\\)/);
  assert.match(delegated, /verifyStoredCredential\\(user\\.password_hash, passwordHash\\)/);
  assert.match(delegated, /credentialCheck\\.needsUpgrade/);
  assert.match(directLogin, /verifyStoredCredential\\(user\\.password_hash, passwordHash\\)/);
  assert.match(directLogin, /credentialCheck\\.needsUpgrade/);
});
""")

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

test('Security Phase 1 remains disabled by default and preserves API budget', () => {
  const security = read('lib/security-guard.js');
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (name) {
    return name.endsWith('.js');
  });
  assert.match(security, /SECURITY_GUARD_MODE\s*\|\|\s*'off'/);
  assert.equal(apiFiles.length, 12);
});

test('login integration records failures without changing credential authority', () => {
  const login = read('api/login-user.js');
  assert.match(login, /securityGuard\.beginLogin/);
  assert.match(login, /loginGuard\.failure\('unknown_account'\)/);
  assert.match(login, /'bad_password'/);
  assert.match(login, /loginGuard\.credentialAccepted/);
  // Superseded by lib/password-credential.js: passwords are no longer compared
  // via raw string equality, but through verifyStoredCredential (scrypt-derived
  // protected format, with a one-time transparent migration path for legacy rows).
  assert.match(login, /const credentialCheck = passwordCredential\.verifyStoredCredential\(user\.password_hash, passwordHash\)/);
  assert.match(login, /const databasePasswordMatches = credentialCheck\.ok/);
  assert.match(login, /const GENERIC_CREDENTIAL_ERROR = 'Username atau password salah\.'/);
  assert.doesNotMatch(login, /securityGuard[^\n]*(?:passwordHash|deviceId)/);
});

test('security storage is service-role only with RLS and atomic RPCs', () => {
  const sql = read('supabase/security-phase-1-migration.sql');
  assert.match(sql, /alter table public\.security_login_limits enable row level security/i);
  assert.match(sql, /alter table public\.security_events enable row level security/i);
  assert.match(sql, /revoke all on table public\.security_events from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.security_login_limits from public, anon, authenticated/i);
  assert.match(sql, /security definer/g);
  assert.match(sql, /create or replace function public\.security_login_precheck/);
  assert.match(sql, /create or replace function public\.security_login_record_failure/);
  assert.match(sql, /create or replace function public\.security_login_record_blocked/);
  assert.match(sql, /create or replace function public\.security_login_record_success/);
  assert.match(sql, /v_pair_threshold integer := case when coalesce\(p_is_admin_target, false\) then 3 else 6 end/);
  assert.match(sql, /v_distinct_accounts >= 5/);
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|execute)[^;]+\s+to\s+(?:anon|authenticated)/i);
});

test('security alert uses a dedicated chat and does not fall back to operational chat id', () => {
  const security = read('lib/security-guard.js');
  assert.match(security, /SECURITY_TELEGRAM_CHAT_ID/);
  assert.doesNotMatch(security, /SECURITY_TELEGRAM_CHAT_ID\s*\|\|\s*source\.TELEGRAM_CHAT_ID/);
  assert.doesNotMatch(security, /passwordHash|cookie header|deviceId/i);
});

test('admin Security Center uses the protected endpoint and escapes server values', () => {
  const runtime = read('public/security-admin-runtime.js');
  const loader = read('public/assets/fca-stocks.js');
  const adminApi = read('api/admin-logs.js');
  assert.match(loader, /security-admin-runtime\.js\?v=20260729-security-admin-v1/);
  assert.match(runtime, /fetch\('\/api\/admin-logs'/);
  assert.match(runtime, /credentials:\s*'same-origin'/);
  assert.match(runtime, /function esc\(value\)/);
  assert.match(runtime, /esc\(item\.ip/);
  assert.match(runtime, /esc\(agent\)/);
  assert.match(runtime, /esc\(error && error\.message/);
  assert.match(adminApi, /requireAdminSession/);
  assert.match(adminApi, /isSameOrigin/);
  assert.match(adminApi, /securityGuard\.loadSecurityDashboard/);
  assert.doesNotMatch(adminApi, /ip_hash|account_hash|pair_hash|user_agent_hash/);
});

test('security patch does not cross protected trading or VPS boundaries', () => {
  const security = read('lib/security-guard.js');
  const runtime = read('public/security-admin-runtime.js');
  const combined = security + '\n' + runtime;
  assert.doesNotMatch(combined, /daytrade-screener-engine|swing-screener|broker-order|createOrder|CRON_SECRET|intraday-fast-watcher/);
});

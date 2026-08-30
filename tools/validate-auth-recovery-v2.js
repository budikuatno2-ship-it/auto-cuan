'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function assertOk(condition, message) {
  if (!condition) throw new Error('Auth recovery validation failed: ' + message);
}

[
  'api/reset-password.js',
  'lib/reset-password-legacy-handler.js',
  'lib/auth-recovery.js',
  'public/auth-v2.js',
  'public/website-approved-access.js',
  'public/maintenance-auth-guard.js',
  'scripts/create-budi-telegram-enrollment.js'
].forEach(function (file) {
  new vm.Script(read(file), { filename: file });
});

// reset-password remains one Vercel Function, but its established account and
// recovery implementation is delegated to a same-process module so the new
// Telegram-command handoff does not create function #13. Validate the combined
// gateway + delegated implementation as one endpoint contract.
const endpoint = read('api/reset-password.js') + '\n' + read('lib/reset-password-legacy-handler.js');
const recovery = read('lib/auth-recovery.js');
const frontend = read('public/auth-v2.js');
const loader = read('public/website-approved-access.js');
const maintenanceGuard = read('public/maintenance-auth-guard.js');
const migration = read('supabase/auth-telegram-recovery-v1-migration.sql');
const hardening = read('supabase/auth-telegram-recovery-v1-device-retirement-hotfix.sql');
const rollout = read('docs/auth-recovery-v2-rollout.md');

assertOk(!endpoint.includes("action === 'login'"), 'login action must not be handled by reset-password gateway');
assertOk(endpoint.includes("action === 'session-status'"), 'server session validation is missing');
assertOk(endpoint.includes("action === 'request-password-reset'"), 'Telegram reset request is missing');
assertOk(endpoint.includes("action === 'complete-password-reset'"), 'one-time reset completion is missing');
assertOk(endpoint.includes("queryAction === 'telegram-verify-webhook-v3'"), 'combined recovery webhook is missing');
assertOk(!endpoint.includes('matchesLegacyBudiPassword') && !endpoint.includes('LEGACY_BUDI_PASSWORD_HASH'), 'legacy dot compatibility entered the new gateway');
assertOk(!/\.select\([^\n]*device_id/.test(endpoint), 'new gateway still reads device_id as credential state');

assertOk(frontend.includes("fetch('/api/login-user'"), 'frontend does not route login to canonical /api/login-user');
assertOk(frontend.includes("authRequest('session-status'"), 'frontend does not validate the server session');
assertOk(frontend.includes('clearLocalAuthState'), 'orphan local auth cleanup is missing');
assertOk(loader.includes('/auth-v2.js?v='), 'auth-v2 loader is missing');
assertOk(loader.includes('/maintenance-auth-guard.js?v='), 'maintenance auth guard loader is missing');
assertOk(
  loader.indexOf('/maintenance-auth-guard.js?v=') < loader.indexOf('/auth-v2.js?v='),
  'maintenance auth guard must load before auth-v2'
);
assertOk(!loader.includes("localStorage.setItem('autocuan_logged_in'"), 'loader still restores localStorage without server validation');
assertOk(maintenanceGuard.includes("visible('maintenanceScreen')") && maintenanceGuard.includes("visible('serviceStatusScreen')"), 'maintenance auth guard does not cover both fail-closed gate screens');
assertOk(maintenanceGuard.includes('window.openAuthChoiceModal = function'), 'maintenance auth guard does not intercept the login-choice modal');
assertOk(maintenanceGuard.includes('originalOpenAuthChoiceModal.apply'), 'maintenance auth guard does not preserve normal non-maintenance login UX');

assertOk(recovery.includes('auth-recovery-v1:'), 'domain-separated recovery HMAC is missing');
assertOk(recovery.includes('Konfirmasi Reset') && recovery.includes('Tolak'), 'Telegram confirmation controls are missing');
assertOk(recovery.includes('/?reset_token='), 'one-time website reset link is missing');
assertOk(!recovery.includes('TELEGRAM_BOT_TOKEN'), 'recovery can access the recommendation bot token');

assertOk(migration.includes('ALTER TABLE public.auth_recovery_requests ENABLE ROW LEVEL SECURITY'), 'recovery RLS is missing');
assertOk(migration.includes('REVOKE ALL ON public.auth_recovery_requests FROM anon, authenticated'), 'recovery table is exposed to browser roles');
assertOk(migration.includes('TO service_role'), 'service-role-only RPC grants are missing');
assertOk(hardening.includes("device_id = 'retired_' || pg_catalog.gen_random_uuid()::text"), 'legacy primary device is not retired');
assertOk(hardening.includes("devices = '[]'::jsonb"), 'legacy device array is not cleared');
assertOk(hardening.includes('SET password_hash = p_new_password_hash'), 'password/device retirement is not atomic in one RPC');

const migrationIndex = rollout.indexOf('auth-telegram-recovery-v1-migration.sql');
const hardeningIndex = rollout.indexOf('auth-telegram-recovery-v1-device-retirement-hotfix.sql');
const deployIndex = rollout.indexOf('Deploy the merged website/API revision');
const webhookIndex = rollout.indexOf('Switch the existing verification bot webhook');
assertOk(migrationIndex >= 0 && hardeningIndex > migrationIndex, 'hardening migration order is incorrect');
assertOk(deployIndex > hardeningIndex && webhookIndex > deployIndex, 'webhook could be switched before the new endpoint is deployed');

const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (name) {
  return name.endsWith('.js');
});
assertOk(apiFiles.length === 12, 'Vercel API function count changed: expected 12, got ' + apiFiles.length);

console.log('AUTH_RECOVERY_V2_BUILD_VALIDATION=PASS');

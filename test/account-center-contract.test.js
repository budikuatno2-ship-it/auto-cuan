'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const terms = require('../lib/account-terms');
const registerSource = fs.readFileSync(path.join(root, 'api', 'register-user.js'), 'utf8');
const profileSource = fs.readFileSync(path.join(root, 'lib', 'account-profile-handler.js'), 'utf8');
const gatewaySource = fs.readFileSync(path.join(root, 'api', 'reset-password.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(root, 'public', 'account-center-v1.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'public', 'account-center-v1.css'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(root, 'public', 'website-approved-access.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'lib', 'admin-users-handler.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(root, 'supabase', 'account-profile-terms-migration.sql'), 'utf8');

test('registration accepts only an explicit acceptance of the exact current terms version', () => {
  assert.equal(terms.registrationAcceptance({ termsAccepted:true, termsVersion:terms.CURRENT_TERMS_VERSION }).ok, true);
  assert.equal(terms.registrationAcceptance({ termsAccepted:false, termsVersion:terms.CURRENT_TERMS_VERSION }).ok, false);
  assert.equal(terms.registrationAcceptance({ termsAccepted:true, termsVersion:'old-version' }).ok, false);
  assert.equal(terms.registrationAcceptance({ termsAccepted:'true', termsVersion:terms.CURRENT_TERMS_VERSION }).ok, false);
});

test('browser and server ship the exact same versioned terms contract', () => {
  assert.match(runtimeSource, new RegExp("TERMS_VERSION = '" + terms.CURRENT_TERMS_VERSION.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + "'"));
  assert.match(registerSource, /accountTerms\.registrationAcceptance\(req\.body\)/);
  assert.match(registerSource, /TERMS_ACCEPTANCE_REQUIRED/);
  assert.match(registerSource, /account_terms_acceptances/);
  assert.match(registerSource, /rollbackIncompleteRegistration/);
});

test('registration UI requires a checkbox and sends acceptance only during register-user request', () => {
  assert.match(runtimeSource, /id="acRegTermsAccepted"/);
  assert.match(runtimeSource, /checkbox\.checked!==true/);
  assert.match(runtimeSource, /body\.termsAccepted=true/);
  assert.match(runtimeSource, /body\.termsVersion=TERMS_VERSION/);
  assert.match(runtimeSource, /url\.indexOf\('\/api\/register-user'\)/);
});

test('profile is derived from signed server identity and omits sensitive account fields', () => {
  assert.match(profileSource, /requireAuthenticatedSession\(req\)/);
  assert.match(profileSource, /isSameOrigin\(req\)/);
  assert.match(profileSource, /select\('id, username, is_approved, is_blocked, created_at, last_login_at'\)/);
  assert.doesNotMatch(profileSource, /select\([^\n]*password_hash/);
  assert.doesNotMatch(profileSource, /select\([^\n]*device_id/);
  assert.doesNotMatch(profileSource, /telegram_private_chat_id/);
  assert.match(gatewaySource, /bodyAction === 'account-profile'/);
});

test('account center exposes profile subscription terms and a scrollable rules document', () => {
  assert.match(runtimeSource, /data-ac-tab="profile"/);
  assert.match(runtimeSource, /data-ac-tab="subscription"/);
  assert.match(runtimeSource, /data-ac-tab="terms"/);
  assert.match(runtimeSource, /headerUserLabel/);
  assert.match(cssSource, /\.ac-terms-scroll\s*\{/);
  assert.match(cssSource, /overflow:auto/);
  assert.match(cssSource, /max-height:52dvh/);
  assert.match(bootstrapSource, /account-center-v1\.js/);
});

test('subscription cards read the narrow user catalog response, including promotion state', () => {
  assert.match(runtimeSource, /p\.normal_price_idr/);
  assert.match(runtimeSource, /p\.promotional_price_idr/);
  assert.match(runtimeSource, /p\.promotion_active === true/);
  assert.match(runtimeSource, /durationLabel\(p\)/);
});

test('voucher creation remains protected by signed budi admin checks and plaintext is not stored', () => {
  assert.match(adminSource, /requireAdminSession\(req\)/);
  assert.match(adminSource, /voucher_admin_create/);
  assert.match(adminSource, /String\(auth\.session\.un \|\| ''\)\.toLowerCase\(\) !== 'budi'/);
  assert.match(runtimeSource, /crypto\.getRandomValues/);
  assert.match(runtimeSource, /action:'voucher_admin_create'/);
  assert.match(adminSource, /vouchers\.voucherCodeHash/);
  assert.match(adminSource, /code\.slice\(-4\)/);
});

test('terms audit storage is private and versioned', () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS public\.account_terms_acceptances/);
  assert.match(migrationSource, /UNIQUE \(user_id, terms_version\)/);
  assert.match(migrationSource, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationSource, /REVOKE ALL ON TABLE public\.account_terms_acceptances FROM PUBLIC, anon, authenticated/);
});

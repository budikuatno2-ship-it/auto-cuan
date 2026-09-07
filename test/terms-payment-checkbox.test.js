'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const accountTerms = require('../lib/account-terms');

const root = path.join(__dirname, '..');
const accountCenterSource = fs.readFileSync(path.join(root, 'public', 'account-center-v1.js'), 'utf8');
const manualPaymentSource = fs.readFileSync(path.join(root, 'public', 'subscription-manual-payment-v1.js'), 'utf8');
const voucherClaimSource = fs.readFileSync(path.join(root, 'public', 'subscription-voucher-claim-v1.js'), 'utf8');
const voucherHandlerSource = fs.readFileSync(path.join(root, 'lib', 'subscription-voucher-handler.js'), 'utf8');
const paymentHandlerSource = fs.readFileSync(path.join(root, 'lib', 'subscription-manual-handler.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(root, 'supabase', 'patch-terms-payment-sources.sql'), 'utf8');

test('accountTerms.paymentAcceptance requires terms acceptance and exact current version', () => {
  assert.equal(accountTerms.paymentAcceptance({ paymentTermsAccepted: true, termsVersion: accountTerms.CURRENT_TERMS_VERSION }).ok, true);
  assert.equal(accountTerms.paymentAcceptance({ termsAccepted: true, termsVersion: accountTerms.CURRENT_TERMS_VERSION }).ok, true);
  assert.equal(accountTerms.paymentAcceptance({ paymentTermsAccepted: false, termsVersion: accountTerms.CURRENT_TERMS_VERSION }).ok, false);
  assert.equal(accountTerms.paymentAcceptance({ paymentTermsAccepted: true, termsVersion: 'wrong-version' }).ok, false);
  assert.equal(accountTerms.paymentAcceptance({}).ok, false);
});

test('terms of service UI in account center hides effective date from display', () => {
  // Effective date should NOT be displayed in the termsHtml intro
  assert.doesNotMatch(accountCenterSource, /Dokumen penggunaan[\s\S]*berlaku[\s\S]*TERMS_EFFECTIVE/);
  assert.doesNotMatch(accountCenterSource, /Versi ' \+ esc\(TERMS_VERSION\)/);
});

test('manual payment submit requires terms acceptance and sends payment source', () => {
  assert.match(paymentHandlerSource, /accountTerms\.paymentAcceptance\(req\.body\)/);
  assert.match(paymentHandlerSource, /accountTerms\.recordTermsAcceptance\(db,\s*auth\.account\.id,\s*'payment'\)/);
  assert.match(manualPaymentSource, /id="acPayTerms"/);
  assert.match(manualPaymentSource, /paymentTermsAccepted:true/);
});

test('100% voucher and direct voucher flows strictly require Checkbox 2 without bypass', () => {
  assert.match(voucherHandlerSource, /accountTerms\.paymentAcceptance\(req\.body\)/);
  assert.match(voucherHandlerSource, /accountTerms\.recordTermsAcceptance\(db,\s*auth\.account\.id,\s*'voucher'\)/);
  assert.match(manualPaymentSource, /id="acPayDirectTerms"/);
  assert.match(manualPaymentSource, /document\.getElementById\('acPayDirectTerms'\)[\s\S]*\.checked/);
  assert.match(accountCenterSource, /id="acVoucherTerms"/);
  assert.match(accountCenterSource, /acVoucherTerms[\s\S]*\.checked/);
  assert.match(voucherClaimSource, /acVoucherTerms/);
});

test('migration script expands acceptance_source check to include payment and voucher', () => {
  assert.match(migrationSource, /acceptance_source\s+IN\s+\('registration',\s*'profile',\s*'payment',\s*'voucher'\)/i);
  assert.match(migrationSource, /idx_account_terms_user_version_source/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TRIAL_DURATION_HOURS, TRIAL_DURATION_MS, getEntitlements } = require('../lib/entitlements');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'subscription-phase-2-migration.sql'), 'utf8');
const redemptionCorrection = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'subscription-phase-5c-redemption-correction.sql'), 'utf8');
const now = new Date('2026-07-23T12:00:00.000Z');
const account = { username: 'alice', is_blocked: false };
const entitlement = (overrides) => Object.assign({ plan_code: 'PREMIUM_1_MONTH', source: 'trial', status: 'active', starts_at: '2026-07-13T12:00:00.000Z', expires_at: '2026-07-23T12:00:00.000Z', lifetime: false }, overrides);

test('trial is exactly ten 24-hour days and has an exclusive expiry boundary', () => {
  assert.equal(TRIAL_DURATION_HOURS, 240); assert.equal(TRIAL_DURATION_MS, 10 * 24 * 60 * 60 * 1000);
  assert.equal(getEntitlements({}, account, [entitlement({ expires_at: '2026-07-23T12:00:00.000Z' })], new Date(now - 1)).premium, true);
  assert.equal(getEntitlements({}, account, [entitlement()], now).premium, false);
});
test('persistent entitlement priority is lifetime, paid term, then trial', () => {
  const rows = [entitlement(), entitlement({ source: 'payment', starts_at: '2026-07-20T00:00:00Z', expires_at: '2026-08-20T00:00:00Z' }), entitlement({ plan_code: 'LIFETIME', source: 'payment', lifetime: true, expires_at: null })];
  assert.equal(getEntitlements({}, account, rows, now).current_plan, 'LIFETIME');
  assert.equal(getEntitlements({}, { username: 'alice', is_blocked: true }, rows, now).premium, false);
  assert.equal(getEntitlements({}, { username: 'budi', is_blocked: true }, rows, now).access_level, 'admin');
});
test('migration pins Phase 2 safety invariants', () => {
  assert.match(migration, /interval '10 days'/); assert.doesNotMatch(migration, /17[ -]?day/i);
  for (const table of ['subscription_plans', 'subscription_plan_prices', 'user_entitlements', 'subscription_events']) assert.match(migration, new RegExp(`ALTER TABLE public\.${table} ENABLE ROW LEVEL SECURITY`));
  assert.doesNotMatch(migration, /seat[_ -]?(ledger|number)|allocate[_ -]?lifetime|generate_series\(1,7\)/i); assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /uq_one_trial_per_web_user/); assert.match(migration, /subscription_trial_telegram_users/);
});
test('voucher redemption correction stacks terms, treats lifetime as terminal, and uses catalog months', () => {
  assert.match(redemptionCorrection, /max\(expires_at\)/);
  assert.match(redemptionCorrection, /make_interval\(months\s*=>\s*p\.duration_months\)/);
  assert.match(redemptionCorrection, /already_lifetime/);
  assert.match(redemptionCorrection, /p\.kind\s*=\s*'lifetime'/);
  assert.match(redemptionCorrection, /already_redeemed/);
  assert.match(redemptionCorrection, /p_duration_days IS DISTINCT FROM expected_days/);
  assert.doesNotMatch(redemptionCorrection, /lifetime seats exhausted|generate_series\(1,7\)/i);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePriceInput, sanitizeEventMetadata } = require('../lib/subscription-catalog');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'subscription-phase-2-migration.sql'), 'utf8');

test('catalog price validation accepts open-ended promotions and rejects unsafe money', () => {
  const p = validatePriceInput({ normal_price_idr: '100000', promo_price_idr: '120000', promo_enabled: true, promo_starts_at: '2026-07-23T00:00:00+07:00', promo_ends_at: null, change_reason: 'owner pricing' });
  assert.equal(p.promo_ends_at, null); assert.equal(p.promo_price_idr, 120000);
  ['0', '-1', '1.5', '1e3', '9007199254740992'].forEach(v => assert.throws(() => validatePriceInput({ normal_price_idr: v, promo_enabled: false, change_reason: 'x' })));
  assert.throws(() => validatePriceInput({ normal_price_idr: '1', promo_enabled: true, promo_price_idr: '1', promo_starts_at: null, change_reason: 'x' }));
  assert.throws(() => validatePriceInput({ normal_price_idr: '1', promo_enabled: true, promo_price_idr: '1', promo_starts_at: '2026-01-02T00:00:00Z', promo_ends_at: '2026-01-01T00:00:00Z', change_reason: 'x' }));
});
test('catalog event metadata has a narrow allowlist', () => {
  const safe = sanitizeEventMetadata('plan_price_version_published', { plan_code: 'LIFETIME', new_price_version: 2, new_normal_price_idr: 500000, change_reason: 'ok', token: 'secret', nested: { password: 'no' }, telegram_user_id: 7 });
  assert.deepEqual(safe, { plan_code: 'LIFETIME', new_price_version: 2, new_normal_price_idr: 500000, change_reason: 'ok' });
  assert.throws(() => sanitizeEventMetadata('unknown', {}));
});
test('atomic publication RPC preserves catalog invariants and is service-role-only', () => {
  assert.match(migration, /publish_subscription_plan_price/); assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /FOR UPDATE/); assert.match(migration, /UPDATE public\.subscription_plan_prices SET active=false/);
  assert.match(migration, /INSERT INTO public\.subscription_plan_prices/); assert.match(migration, /publication_submission_id text UNIQUE/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.publish_subscription_plan_price[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.publish_subscription_plan_price[\s\S]*TO service_role/);
  assert.match(migration, /interval '10 days'/); assert.doesNotMatch(migration, /17[ -]?day/i);
});
test('admin router keeps signed-session, same-origin, budi, and safe-action guards', () => {
  // The wrapper lives in api/, the legacy admin actions in lib/.
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'admin-users.js'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-users-handler.js'), 'utf8');
  assert.match(source, /requireAdminSession/); assert.match(source, /isSameOrigin/);
  assert.match(source, /auth\.session\.un.*budi/); assert.match(source, /subscription_plan_price_publish/);
  // Deletion exists only as the guarded delete_user action (admin session,
  // same-origin, budi/review protected); no bare 'delete' action may appear.
  assert.doesNotMatch(source, /action\s*===\s*['"]delete['"]/i);
  assert.match(source, /action === 'delete_user'/);
  assert.match(source, /targetUsername === 'budi' \|\| targetUsername === 'review'/);
});

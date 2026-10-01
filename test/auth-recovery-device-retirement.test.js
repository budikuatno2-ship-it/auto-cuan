'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('password recovery atomically retires every legacy device binding', function () {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'auth-telegram-recovery-v1-device-retirement-hotfix.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.consume_auth_password_reset/);
  assert.match(sql, /SET password_hash = p_new_password_hash/);
  assert.match(sql, /device_id = 'retired_' \|\| pg_catalog\.gen_random_uuid\(\)::text/);
  assert.match(sql, /devices = '\[\]'::jsonb/);
  assert.match(sql, /state = 'consumed'/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.consume_auth_password_reset\(text,text\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.consume_auth_password_reset\(text,text\)[\s\S]*TO service_role/);
});

test('rollout applies the hardening SQL before deployment and switches webhook only afterward', function () {
  const rollout = fs.readFileSync(
    path.join(ROOT, 'docs', 'auth-recovery-v2-rollout.md'),
    'utf8'
  );

  const migration = rollout.indexOf('auth-telegram-recovery-v1-migration.sql');
  const hardening = rollout.indexOf('auth-telegram-recovery-v1-device-retirement-hotfix.sql');
  const deploy = rollout.indexOf('Deploy the merged website/API revision');
  const webhook = rollout.indexOf('Switch the existing verification bot webhook');

  assert.ok(migration >= 0);
  assert.ok(hardening > migration);
  assert.ok(deploy > hardening);
  assert.ok(webhook > deploy);
});

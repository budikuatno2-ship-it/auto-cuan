const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SUPABASE_DIR = path.join(__dirname, '..', 'supabase');

test('BUG-DB-001: admin_device_approvals table must enable RLS and revoke public/anon access', () => {
  const sqlPath = path.join(SUPABASE_DIR, 'admin-device-approval-migration.sql');
  const content = fs.readFileSync(sqlPath, 'utf8');

  const hasRLS = /ALTER\s+TABLE\s+.*admin_device_approvals\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(content);
  const hasRevoke = /REVOKE\s+ALL\s+ON\s+.*admin_device_approvals\s+FROM\s+.*anon/i.test(content);

  assert.strictEqual(hasRLS, true, 'admin_device_approvals must enable ROW LEVEL SECURITY');
  assert.strictEqual(hasRevoke, true, 'admin_device_approvals must revoke access from anon and authenticated roles');
});

test('BUG-DB-002: admin_device_approvals.user_id must have FOREIGN KEY with ON DELETE CASCADE', () => {
  const sqlPath = path.join(SUPABASE_DIR, 'admin-device-approval-migration.sql');
  const content = fs.readFileSync(sqlPath, 'utf8');

  const hasFK = /user_id\s+UUID\s+.*REFERENCES\s+.*app_users.*ON\s+DELETE\s+CASCADE/i.test(content);
  assert.strictEqual(hasFK, true, 'user_id in admin_device_approvals must reference app_users(id) with ON DELETE CASCADE');
});

test('BUG-DB-003: multi-device migration must enforce NOT NULL and jsonb array type constraint on devices', () => {
  const sqlPath = path.join(SUPABASE_DIR, 'multi-device-migration.sql');
  const content = fs.readFileSync(sqlPath, 'utf8');

  const hasNotNull = /ALTER\s+TABLE\s+app_users\s+ALTER\s+COLUMN\s+devices\s+SET\s+NOT\s+NULL/i.test(content);
  const hasArrayCheck = /jsonb_typeof\s*\(\s*devices\s*\)\s*=\s*'array'/i.test(content);

  assert.strictEqual(hasNotNull, true, 'devices column in app_users must have NOT NULL constraint');
  assert.strictEqual(hasArrayCheck, true, 'devices column in app_users must enforce CHECK (jsonb_typeof(devices) = \'array\')');
});

test('BUG-DB-004: consume_admin_command_device_grant must not return pending when grant is expired or missing', () => {
  const sqlPath = path.join(SUPABASE_DIR, 'admin-telegram-command-login-migration.sql');
  const content = fs.readFileSync(sqlPath, 'utf8');

  // Cari blok consume_admin_command_device_grant
  const fnMatch = content.match(/FUNCTION\s+public\.consume_admin_command_device_grant[\s\S]*?\$\$([\s\S]*?)\$\$/i);
  assert.ok(fnMatch, 'consume_admin_command_device_grant function must exist');

  const body = fnMatch[1];
  // Jika grant tidak ditemukan atau sudah expired, tidak boleh mengembalikan 'pending'
  const returnsPendingOnNotFound = /IF\s+NOT\s+FOUND\s+THEN\s+RETURN\s+QUERY\s+SELECT\s+'pending'/i.test(body);

  assert.strictEqual(returnsPendingOnNotFound, false, 'consume_admin_command_device_grant must not return "pending" when grant row is not found or expired');
});

test('BUG-DB-005: admin_device_approvals.status must have CHECK constraint for valid statuses', () => {
  const sqlPath = path.join(SUPABASE_DIR, 'admin-device-approval-migration.sql');
  const content = fs.readFileSync(sqlPath, 'utf8');

  const hasStatusCheck = /status\s+TEXT\s+.*CHECK\s*\(\s*status\s+IN\s*\(/i.test(content);
  assert.strictEqual(hasStatusCheck, true, 'admin_device_approvals must enforce CHECK constraint on status column');
});

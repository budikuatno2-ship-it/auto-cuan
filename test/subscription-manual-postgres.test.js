'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const hasPostgresHarness = Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD);

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    encoding: 'utf8'
  });
  assert.equal(
    result.status,
    0,
    command + ' failed\nSTDOUT:\n' + (result.stdout || '') + '\nSTDERR:\n' + (result.stderr || '')
  );
  return result;
}

test('manual subscription migrations apply and complete create-submit-approve runtime', {
  skip: hasPostgresHarness ? false : 'PostgreSQL harness environment is not available'
}, () => {
  const dbName = 'manual_subscription_' + process.pid;
  const dbEnv = { PGDATABASE: dbName };
  const files = [
    'test/sql/phase5c/bootstrap.sql',
    'supabase/subscription-phase-2-migration.sql',
    'supabase/subscription-phase-5c-voucher-admin-migration.sql',
    'supabase/subscription-phase-5c-lifecycle-correction.sql',
    'supabase/subscription-phase-5c-admin-command-correction.sql',
    'supabase/subscription-phase-5c-redemption-correction.sql',
    'supabase/subscription-manual-payment-migration.sql',
    'supabase/telegram-transient-message-migration.sql',
    'test/sql/manual-subscription-payment-runtime.sql'
  ];

  try {
    run('dropdb', ['--if-exists', dbName]);
    run('createdb', [dbName]);
    for (const rel of files) {
      run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', dbName, '-f', path.join(ROOT, rel)], dbEnv);
    }
  } finally {
    run('dropdb', ['--if-exists', dbName]);
  }
});

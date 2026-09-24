#!/usr/bin/env node
'use strict';

/**
 * One-off migration applier for bot_users via the Supabase service role.
 *
 * Supabase REST does not accept raw DDL, so this tool runs the migration as
 * a single RPC call if the user has already provisioned the table. Otherwise
 * it must be applied through the Supabase SQL editor. This script prints the
 * exact DDL so an operator can paste it in one shot.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  for (const name of ['.env', '.env.intraday-runtime', '.env.local']) {
    const filePath = path.join(ROOT, name);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
    }
  }
}

async function main() {
  loadEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
  }

  const sqlPath = path.join(ROOT, 'supabase', 'bot-users-migration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Service-role cannot run DDL through PostgREST; the SQL must be applied by
  // an operator with psql or the Supabase SQL editor. Print the DDL and try
  // a light liveness check so the operator knows the service is reachable.
  console.log('-- Paste the following DDL into the Supabase SQL editor --');
  console.log(sql);
  console.log('-- Checking service role liveness --');
  const response = await fetch(url.replace(/\/$/, '') + '/rest/v1/', {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  console.log('service_role_rest_status=' + response.status);
}

main().catch((err) => {
  console.error('migration helper failed:', err && err.message);
  process.exit(1);
});

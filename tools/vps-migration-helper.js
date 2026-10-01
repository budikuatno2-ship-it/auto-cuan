'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  for (const name of ['.env', '.env.intraday-runtime', '.env.local']) {
    const fp = path.join(ROOT, name);
    if (!fs.existsSync(fp)) continue;
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
    }
  }
}

async function main() {
  loadEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('missing env'); process.exit(1); }

  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const base = url.replace(/\/$/, '');

  console.log('[1] Checking if bot_users table exists...');
  const check = await fetch(base + '/rest/v1/bot_users?select=id&limit=1', { headers });
  const bodyText = await check.text();
  console.log('status=' + check.status + ' body=' + bodyText.slice(0, 300));
  if (check.status === 200) {
    console.log('Table already exists. Migration skipped.');
    return;
  }
  if (check.status !== 400 || !/does not exist/i.test(bodyText)) {
    console.log('Unexpected response. Apply DDL via Supabase SQL Editor manually.');
    return;
  }

  // bot_users is missing — try Supabase pg management endpoint
  console.log('[2] bot_users missing. Attempting Supabase pg management API...');
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'bot-users-migration.sql'), 'utf8');
  const pgPayload = { query: sql };
  const pgRes = await fetch(base + '/rest/v1/rpc/exec', {
    method: 'POST',
    headers,
    body: JSON.stringify(pgPayload)
  });
  if (pgRes.ok) {
    console.log('[OK] bot_users created via pg management API.');
    return;
  }
  const pgBody = await pgRes.text();
  console.log('pg_management status=' + pgRes.status + ' body=' + pgBody.slice(0, 200));

  // Try direct management SQL endpoint (Supabase v2 format)
  const altRes = await fetch(base + '/sql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: sql })
  });
  if (altRes.ok) {
    console.log('[OK] bot_users created via /sql endpoint.');
    return;
  }
  console.log('Alternative status=' + altRes.status + ' body=' + (await altRes.text()).slice(0, 200));

  console.log('[3] Please apply the following DDL via the Supabase SQL Editor:');
  console.log(sql);
}

main().catch(e => { console.error(e.message); process.exit(1); });

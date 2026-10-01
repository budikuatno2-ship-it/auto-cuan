'use strict';

/**
 * Direct landing snapshot refresh (no CRON_SECRET / no Vercel route).
 *
 * Loads Supabase credentials from a local/VPS env file, then calls the SAME
 * production refresh function used by the protected endpoint so the snapshot
 * shape stays identical: lib/landing-showcase-service.js#refreshSnapshot.
 *
 * Usage (from repo root, on VPS):
 *   set -a; . ./.env.ai-eval-once; set +a
 *   node tools/direct-refresh-landing.js
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const explicit = process.env.LANDING_ENV_FILE;
  const candidates = explicit
    ? [explicit]
    : ['.env.ai-eval-once', '.env.local', '.env'].map(name => path.join(__dirname, '..', name));
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
    } catch (_) {}
  }
}

async function main() {
  loadEnvFile();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak tersedia.');
    process.exit(1);
  }

  const { createClient } = require('@supabase/supabase-js');
  const landingShowcase = require('../lib/landing-showcase-service');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const result = await landingShowcase.refreshSnapshot(supabase);
  console.log(JSON.stringify({
    ok: result.ok,
    error: result.error || null,
    kv_key: landingShowcase.KV_KEY,
    sectors_count: result.snapshot && Array.isArray(result.snapshot.sectors) ? result.snapshot.sectors.length : 0,
    dt_signals_count: result.snapshot && Array.isArray(result.snapshot.dt_signals) ? result.snapshot.dt_signals.length : null
  }, null, 2));

  if (!result.ok) process.exitCode = 2;
}

main().catch(err => {
  console.error('Fatal:', err && err.message);
  process.exit(1);
});

/**
 * IDX 2026 Holiday Calendar — Seed / Upsert CLI
 *
 * ONE safe, idempotent command to (re)apply the 2026 exchange holiday
 * calendar to idx_trading_calendar. Upserts on the `trade_date` primary
 * key, so re-running this after a correction is safe — it never duplicates
 * rows and only overwrites the row(s) that changed.
 *
 * Usage:
 *   node scripts/seed-idx-holidays-2026.js           (apply)
 *   node scripts/seed-idx-holidays-2026.js --dry-run  (validate only, no writes)
 *
 * Requires environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Data source: lib/idx-holidays-2026-seed-data.js (see that file for
 * provenance notes). This script does NOT invent or adjust any date — it
 * only applies the list defined there.
 *
 * NOT run automatically by this change. An operator must run it manually
 * against the target database (this repo does not apply migrations or
 * seeds to production on its own).
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { buildSeedRows, SOURCE } = require('../lib/idx-holidays-2026-seed-data');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const rows = buildSeedRows();
  console.log('[seed-idx-holidays-2026] Source: ' + SOURCE);
  console.log('[seed-idx-holidays-2026] Rows to apply: ' + rows.length);
  console.log('[seed-idx-holidays-2026] Date range: ' + rows[0].trade_date + ' .. ' + rows[rows.length - 1].trade_date);

  if (isDryRun) {
    console.log('[seed-idx-holidays-2026] --dry-run: validation only, no writes performed.');
    rows.forEach((r) => console.log('  ' + r.trade_date + ' — ' + r.name));
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[seed-idx-holidays-2026] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const result = await supabase
    .from('idx_trading_calendar')
    .upsert(rows, { onConflict: 'trade_date' });

  if (result.error) {
    console.error('[seed-idx-holidays-2026] Upsert failed:', result.error.message);
    process.exit(1);
  }

  console.log('[seed-idx-holidays-2026] Upserted ' + rows.length + ' holiday rows successfully.');
}

main().catch((e) => {
  console.error('[seed-idx-holidays-2026] Unexpected error:', e && e.message);
  process.exit(1);
});

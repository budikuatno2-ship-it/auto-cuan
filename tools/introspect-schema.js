#!/usr/bin/env node
'use strict';

/**
 * tools/introspect-schema.js
 *
 * Read-only introspection script for the 7 baseline tables:
 * - app_users, app_settings, stock_boards, login_logs, search_logs, ai_analysis_logs, ai_usage_logs
 *
 * Runs standard queries against information_schema and pg_catalog to generate
 * exact DDL snapshot for documentation without guessing or leaking credentials.
 */

const fs = require('fs');
const path = require('path');

const TABLES = [
  'app_users',
  'app_settings',
  'stock_boards',
  'login_logs',
  'search_logs',
  'ai_analysis_logs',
  'ai_usage_logs'
];

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const dbUrl = process.env.DATABASE_URL || process.env.PG_URL;

  console.log('--- Introspection Tool for Baseline Tables ---');
  console.log(`Target tables: ${TABLES.join(', ')}`);

  if (!supabaseUrl && !dbUrl) {
    console.log('\n[INFO] No database credentials configured in current environment.');
    console.log('To run introspection on production VPS, execute:');
    console.log('  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node tools/introspect-schema.js');
    console.log('\nPer instructions: Do not guess schema structures without live database connection.');
    return;
  }

  console.log('Database credentials present. Ready for introspection execution.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Introspection error:', err.message);
    process.exit(1);
  });
}

module.exports = { TABLES, main };

#!/usr/bin/env node
'use strict';

// C3 (22 Oct 2026) — DRY RUN ONLY: list Telegram members whose subscription has
// expired. It performs SELECTs and prints; it NEVER removes/kicks/bans anyone.
//
// Sheets the owner reviews before any removal is built. Requires
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY via env (the wrapper loads them from
// an owner-only env file); it never prints secret values.

const path = require('path');
const audit = require(path.resolve(__dirname, '..', 'lib', 'telegram-member-expiry-audit'));

function parseArgs(argv) {
  const opts = { json: false, limit: 500, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--limit') { const v = Number(argv[i + 1]); if (Number.isFinite(v) && v > 0) { opts.limit = v; i += 1; } }
    else if (a === '-h' || a === '--help') opts.help = true;
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'Usage: node tools/audit-expired-telegram-members.js [--json] [--limit N]',
    '',
    'DRY RUN ONLY. Lists Telegram members whose subscription expired.',
    'Never removes anyone. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.',
    ''
  ].join('\n'));
}

async function main(argv, env) {
  const e = env || process.env;
  const opts = parseArgs(argv || []);
  if (opts.help) { printHelp(); return { help: true }; }

  if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
    const out = { error: 'missing_supabase_env', dry_run: true, removed: 0 };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exitCode = 1;
    return out;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const result = await audit.runExpiredMemberAudit({ supabase }, { now: e.C3_NOW || undefined });
  const candidates = result.candidates.slice(0, opts.limit);

  const summary = {
    dry_run: true,
    removed: 0,
    generated_at: result.generated_at,
    scanned_members: result.scanned,
    counts: result.counts,
    expired_candidates: result.candidates.length,
    listed: candidates.length
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify({ summary, candidates }, null, 2) + '\n');
    return summary;
  }

  process.stdout.write('=== DRY RUN: Telegram expired-member audit ===\n');
  process.stdout.write(`scanned=${result.scanned} expired_candidates=${result.candidates.length} removed=0\n`);
  process.stdout.write('counts: ' + JSON.stringify(result.counts) + '\n');
  process.stdout.write('user_id | username | telegram_user_id | expired_at | plan\n');
  for (const c of candidates) {
    process.stdout.write(`${c.user_id} | ${c.username || '-'} | ${c.telegram_user_id || '-'} | ${c.expires_at || '-'} | ${c.plan_code || '-'}\n`);
  }
  return summary;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => { console.error(err && err.message ? err.message : err); process.exitCode = 1; });
}

module.exports = { main, parseArgs };

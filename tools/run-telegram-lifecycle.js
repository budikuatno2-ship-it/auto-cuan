#!/usr/bin/env node
'use strict';

// ===========================================================================
// Manual/scheduled runner for Telegram member-lifecycle tasks:
//   * due legacy verification reminders (at most two per user, second >= 24h)
//   * due 30-day review requests (one per eligible member, never repeated)
//
// SAFETY
//  - Default mode is DRY-RUN (lists what is due; claims/sends nothing). Add
//    --execute to actually claim + send.
//  - Idempotent + safe to run daily: every due item is CLAIMED in SQL before its
//    message is sent, so re-runs cannot exceed the bounds or double-send.
//  - Uses SUPABASE service-role + TELEGRAM_VERIFY_BOT_TOKEN (via the verify bot)
//    ONLY. It never reads TELEGRAM_BOT_TOKEN and never imports the recommendation
//    notifier. This runner does NOT install cron.
//
// PROPOSED once-daily VPS cron (adjust path/time; runs 02:15 UTC):
//   15 2 * * *  cd /path/to/auto-cuan && SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     TELEGRAM_VERIFY_BOT_TOKEN=... TELEGRAM_VERIFY_CHANNEL_ID=... \
//     node tools/run-telegram-lifecycle.js --execute >> /var/log/auto-cuan-lifecycle.log 2>&1
// ===========================================================================

function printHelp() {
  console.log([
    'Usage: node tools/run-telegram-lifecycle.js [options]',
    '',
    'Runs due verification reminders and due 30-day review requests.',
    'Default is DRY-RUN (nothing is claimed or sent).',
    '',
    'Options:',
    '  --execute        Claim and send (otherwise dry-run only)',
    '  --reminders-only Only process verification reminders',
    '  --reviews-only   Only process 30-day review requests',
    '  --limit <n>      Max rows per batch (default 100)',
    '  --json           Print only the JSON summary',
    '  -h, --help       Show this help',
    '',
    'Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_VERIFY_BOT_TOKEN'
  ].join('\n'));
}

function parseArgs(argv) {
  const opts = { execute: false, remindersOnly: false, reviewsOnly: false, json: false, limit: 100, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--reminders-only') opts.remindersOnly = true;
    else if (arg === '--reviews-only') opts.reviewsOnly = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit requires a positive number');
      opts.limit = value; i += 1;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error('Unknown option: ' + arg);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw Object.assign(new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'), { exitCode: 1 });
  }
  if (opts.execute && !process.env.TELEGRAM_VERIFY_BOT_TOKEN) {
    throw Object.assign(new Error('TELEGRAM_VERIFY_BOT_TOKEN is required with --execute.'), { exitCode: 1 });
  }

  const { createClient } = require('@supabase/supabase-js');
  const { createVerifyBot } = require('../lib/telegram-verify-bot');
  const lifecycle = require('../lib/telegram-lifecycle');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const deps = { supabase: supabase, bot: createVerifyBot() };
  const runOpts = { limit: opts.limit, dryRun: !opts.execute };

  const summary = { mode: opts.execute ? 'execute' : 'dry_run', limit: opts.limit };
  if (!opts.reviewsOnly) summary.reminders = await lifecycle.runVerificationReminders(deps, runOpts);
  if (!opts.remindersOnly) summary.reviews = await lifecycle.runReviewRequests(deps, runOpts);

  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

main().then(function (code) {
  process.exitCode = code || 0;
}).catch(function (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
});

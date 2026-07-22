#!/usr/bin/env node
'use strict';

/**
 * Live Intraday Shadow Scoring CLI — evaluation ONLY
 * ==================================================
 *
 * Processes exactly ONE scheduled snapshot of already-collected intraday
 * samples in SHADOW MODE and writes live evaluation artifacts to a SEPARATE
 * output root. It adds a confirmed-candidate gate (provisional vs confirmed
 * Top 5) and forward-return tracking (+15m/+30m/+60m/EOD) on top of the
 * historical evaluator's scoring.
 *
 * It NEVER enables production scoring, NEVER mutates recommendation / portfolio
 * / user state, NEVER touches Supabase, NEVER sends Telegram, and NEVER rewrites
 * the source sample files. It requires an EXPLICIT --date and --time and never
 * silently uses the current wall-clock time.
 *
 * The CLI HARD-SETS these safety flags before doing anything, then ASSERTS them:
 *   DAYTRADE_INTRADAY_SCORE_ENABLED=false
 *   DAYTRADE_WORKER_ALLOW_MUTATION=false
 *   TELEGRAM_ENABLED=0
 *
 * Example (future) VPS command — run once per scheduled snapshot during market
 * hours on a supported collection day:
 *   node tools/intraday-shadow-scoring-live.js \
 *     --input-root /home/ubuntu/auto-cuan/data/intraday-samples \
 *     --output-root /home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live \
 *     --date 2026-07-21 \
 *     --time 10:15
 */

const path = require('node:path');
const live = require('../lib/intraday-shadow-scoring-live');
// Shared safety gate (pure — no Supabase / Telegram / DB mutation imports).
const shadow = require('../lib/intraday-shadow-scoring');

function parseArgs(argv) {
  const args = {
    inputRoot: null,
    outputRoot: null,
    date: null,
    time: null,
    supportedDates: null,
    lockFile: null,
    dryRun: false,
    json: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input-root' && argv[i + 1]) args.inputRoot = argv[++i];
    else if (a === '--output-root' && argv[i + 1]) args.outputRoot = argv[++i];
    else if (a === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (a === '--time' && argv[i + 1]) args.time = argv[++i];
    else if (a === '--supported-dates' && argv[i + 1]) args.supportedDates = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--lock-file' && argv[i + 1]) args.lockFile = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = [
  'Usage:',
  '  node tools/intraday-shadow-scoring-live.js \\',
  '    --input-root <dir> \\',
  '    --output-root <dir> \\',
  '    --date 2026-07-21 \\',
  '    --time 10:15',
  '',
  'Options:',
  '  --input-root <dir>        Root containing <date>/ sample directories (read-only).',
  '  --output-root <dir>       Root for live shadow outputs. MUST be outside --input-root.',
  '  --date <YYYY-MM-DD>       Explicit sample date (required; never defaults to today).',
  '  --time <HH:MM>            Explicit scheduled snapshot time (required; must be an approved time).',
  '  --supported-dates <...>   Override the allowed date set (default: the sample dates).',
  '  --lock-file <path>        Override the lock file path.',
  '  --dry-run                 Compute but do not write any output files.',
  '  --json                    Print the full result object as JSON.',
  '  -h, --help                Show this help.',
  '',
  'Safety: hard-sets DAYTRADE_INTRADAY_SCORE_ENABLED=false,',
  '        DAYTRADE_WORKER_ALLOW_MUTATION=false, TELEGRAM_ENABLED=0.',
  '        Processes one snapshot, uses a lock + atomic writes, never mutates',
  '        production state or the source sample files, and never sends Telegram.'
].join('\n');

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  // 1. HARD-SET the safe defaults before anything else runs.
  shadow.enforceShadowSafetyDefaults(process.env);
  // 2. ASSERT — refuse if something is still in an enabling state.
  const safety = shadow.assertShadowSafety(process.env);
  if (!safety.safe) {
    process.stderr.write('SAFETY VIOLATION — refusing to run live shadow scoring:\n');
    safety.errors.forEach((e) => process.stderr.write('  - ' + e + '\n'));
    return 2;
  }

  // 3. Required-arg validation with clear errors + non-zero exit.
  const missing = [];
  if (!args.inputRoot) missing.push('--input-root');
  if (!args.outputRoot) missing.push('--output-root');
  if (!args.date) missing.push('--date');
  if (!args.time) missing.push('--time');
  if (missing.length) {
    process.stderr.write('Missing required argument(s): ' + missing.join(', ') + '\n\n' + USAGE + '\n');
    return 2;
  }

  const result = await live.runLiveShadowSnapshot({
    inputRoot: path.resolve(args.inputRoot),
    outputRoot: path.resolve(args.outputRoot),
    date: args.date,
    scheduledTime: args.time,
    supportedDates: args.supportedDates,
    lockFile: args.lockFile ? path.resolve(args.lockFile) : null,
    dryRun: args.dryRun,
    env: process.env
  });

  if (result.status === 'skipped_due_to_lock') {
    process.stderr.write('Skipped: another live shadow run holds the lock (' + result.lock_file + ').\n');
    return 3;
  }

  if (result.status !== 'success') {
    process.stderr.write('Live shadow scoring failed: ' + result.status + '\n');
    (result.errors || []).forEach((e) => process.stderr.write('  - ' + e + '\n'));
    if (result.reason) process.stderr.write('  reason: ' + result.reason + '\n');
    return 1;
  }

  const s = result.evaluation.summary;
  process.stdout.write('Live shadow scoring complete (evaluation only — nothing deployed, no Telegram, no mutation).\n');
  process.stdout.write('Date: ' + result.date + '  Snapshot: ' + result.scheduled_time + '\n');
  process.stdout.write(
    '  snapshots_through=' + s.total_evaluated_snapshots +
    ', unique_candidates=' + s.candidate_counts.total_unique_candidates +
    ', confirmed=' + s.candidate_counts.confirmed_candidates +
    ', provisional_only=' + s.candidate_counts.provisional_only_candidates +
    ', transient_filtered=' + s.confirmation.transient_filtered_count +
    ', warnings=' + s.warnings.length + '\n'
  );
  if (!args.dryRun && result.outputs) {
    process.stdout.write('  wrote: ' + Object.values(result.outputs).join(', ') + '\n');
  } else {
    process.stdout.write('  (dry-run: no files written)\n');
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((e) => { process.stderr.write('FATAL: ' + (e && e.message ? e.message : String(e)) + '\n'); process.exitCode = 1; });
}

module.exports = { parseArgs, main, USAGE };

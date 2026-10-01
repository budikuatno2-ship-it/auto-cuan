#!/usr/bin/env node
'use strict';

/**
 * Intraday Shadow Scoring CLI — evaluation ONLY
 * =============================================
 *
 * Re-scores already-collected intraday day-trade samples in SHADOW MODE and
 * writes evaluation artifacts to a SEPARATE output root. It never enables
 * production scoring, never mutates recommendation/portfolio/user state, never
 * touches Supabase, never sends Telegram, and never rewrites the source sample
 * files.
 *
 * The CLI HARD-SETS the safety flags below before doing anything, and then
 * ASSERTS them — if the environment tried to enable scoring/mutation/telegram
 * the run refuses with a non-zero exit.
 *
 *   DAYTRADE_INTRADAY_SCORE_ENABLED=false
 *   DAYTRADE_WORKER_ALLOW_MUTATION=false
 *   TELEGRAM_ENABLED=0
 *
 * Example (future) VPS command:
 *   node tools/intraday-shadow-scoring.js \
 *     --input-root /home/ubuntu/auto-cuan/data/intraday-samples \
 *     --output-root /home/ubuntu/auto-cuan/data/intraday-shadow-scoring \
 *     --dates 2026-07-20,2026-07-21,2026-07-22
 */

const path = require('node:path');
const shadow = require('../lib/intraday-shadow-scoring');

function parseArgs(argv) {
  const args = {
    inputRoot: null,
    outputRoot: null,
    dates: null,
    supportedDates: null,
    dryRun: false,
    json: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input-root' && argv[i + 1]) args.inputRoot = argv[++i];
    else if (a === '--output-root' && argv[i + 1]) args.outputRoot = argv[++i];
    else if (a === '--dates' && argv[i + 1]) args.dates = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--supported-dates' && argv[i + 1]) args.supportedDates = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = [
  'Usage:',
  '  node tools/intraday-shadow-scoring.js \\',
  '    --input-root <dir> \\',
  '    --output-root <dir> \\',
  '    --dates 2026-07-20,2026-07-21,2026-07-22',
  '',
  'Options:',
  '  --input-root <dir>        Root containing <date>/ sample directories (read-only).',
  '  --output-root <dir>       Root for shadow outputs. MUST be outside --input-root.',
  '  --dates <d1,d2,...>       Comma-separated dates to evaluate.',
  '  --supported-dates <...>   Override the allowed date set (default: the 3 sample dates).',
  '  --dry-run                 Compute but do not write any output files.',
  '  --json                    Print the full result object as JSON.',
  '  -h, --help                Show this help.',
  '',
  'Safety: hard-sets DAYTRADE_INTRADAY_SCORE_ENABLED=false,',
  '        DAYTRADE_WORKER_ALLOW_MUTATION=false, TELEGRAM_ENABLED=0.',
  '        Never mutates production state or the source sample files.'
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
    process.stderr.write('SAFETY VIOLATION — refusing to run shadow scoring:\n');
    safety.errors.forEach((e) => process.stderr.write('  - ' + e + '\n'));
    return 2;
  }

  // 3. Required-arg validation with clear errors + non-zero exit.
  const missing = [];
  if (!args.inputRoot) missing.push('--input-root');
  if (!args.outputRoot) missing.push('--output-root');
  if (!args.dates || !args.dates.length) missing.push('--dates');
  if (missing.length) {
    process.stderr.write('Missing required argument(s): ' + missing.join(', ') + '\n\n' + USAGE + '\n');
    return 2;
  }

  const result = await shadow.runShadowScoring({
    inputRoot: path.resolve(args.inputRoot),
    outputRoot: path.resolve(args.outputRoot),
    dates: args.dates,
    supportedDates: args.supportedDates,
    dryRun: args.dryRun,
    env: process.env
  });

  if (result.status !== 'success') {
    process.stderr.write('Shadow scoring failed: ' + result.status + '\n');
    (result.errors || []).forEach((e) => process.stderr.write('  - ' + e + '\n'));
    if (result.reason) process.stderr.write('  reason: ' + result.reason + '\n');
    return 1;
  }

  // Concise, deterministic human summary (avoid dumping wall-clock time).
  process.stdout.write('Shadow scoring complete (evaluation only — nothing deployed, no Telegram, no mutation).\n');
  process.stdout.write('Dates evaluated: ' + result.dates.join(', ') + '\n');
  for (const ev of result.evaluations) {
    const s = ev.summary;
    process.stdout.write(
      '  ' + ev.date +
      ': snapshots=' + s.total_evaluated_snapshots +
      ', unique_candidates=' + s.total_unique_candidates +
      ', persistent=' + s.persistent_candidates.length +
      ', transient=' + s.transient_candidates.length +
      ', warnings=' + s.warnings.length + '\n'
    );
  }
  if (!args.dryRun) {
    for (const o of result.outputs) {
      process.stdout.write('  wrote: ' + o.files.scores + ', ' + o.files.top5 + ', ' + o.files.summary + '\n');
    }
    if (result.comparison_path) process.stdout.write('  wrote: ' + result.comparison_path + '\n');
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

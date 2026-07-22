#!/usr/bin/env node
'use strict';

/**
 * Deduplicated Intraday Shadow Trade Backtest CLI — evaluation ONLY
 * ================================================================
 *
 * Converts the repeated per-snapshot observations produced by the LIVE intraday
 * shadow-scoring evaluator into realistic, DEDUPLICATED shadow trade events and
 * evaluates a single candidate rule:
 *
 *     confirmation_state = CONFIRMED, confirmed_rank = 1, shadow_score >= --min-score
 *
 * Rank 2..5 are NEVER evaluated as production candidates. A signal at snapshot T
 * can only enter at the NEXT valid snapshot price (no look-ahead, no invented
 * prices). Two exit scenarios (+60 minutes and 16:00 EOD) and three round-trip
 * cost scenarios (0 / 30 / 50 bps) are evaluated separately.
 *
 * It NEVER enables production scoring, NEVER mutates recommendation / portfolio /
 * user state, NEVER touches Supabase, NEVER imports or sends Telegram, and NEVER
 * rewrites the source sample / shadow-scoring files. Dates are EXPLICIT.
 *
 * The CLI HARD-SETS these safety flags before doing anything, then ASSERTS them:
 *   DAYTRADE_INTRADAY_SCORE_ENABLED=false
 *   DAYTRADE_WORKER_ALLOW_MUTATION=false
 *   TELEGRAM_ENABLED=0
 *
 * Example (future) VPS command:
 *   node tools/intraday-shadow-trade-backtest.js \
 *     --shadow-root /home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live \
 *     --sample-root /home/ubuntu/auto-cuan/data/intraday-samples \
 *     --output-root /home/ubuntu/auto-cuan/data/intraday-shadow-trades \
 *     --dates 2026-07-20,2026-07-21,2026-07-22 \
 *     --min-score 16
 */

const path = require('node:path');
const backtest = require('../lib/intraday-shadow-trade-backtest');
// Shared safety gate (pure — no Supabase / Telegram / DB-mutation imports).
const shadow = require('../lib/intraday-shadow-scoring');

function parseIntList(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s));
}

function parseArgs(argv) {
  const args = {
    shadowRoot: null,
    sampleRoot: null,
    outputRoot: null,
    dates: null,
    minScore: null,
    costScenariosBps: null,
    primaryCostBps: null,
    exitFallbackNextValid: false,
    onePositionMode: false,
    dryRun: false,
    json: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shadow-root' && argv[i + 1]) args.shadowRoot = argv[++i];
    else if (a === '--sample-root' && argv[i + 1]) args.sampleRoot = argv[++i];
    else if (a === '--output-root' && argv[i + 1]) args.outputRoot = argv[++i];
    else if (a === '--dates' && argv[i + 1]) args.dates = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--min-score' && argv[i + 1]) args.minScore = Number(argv[++i]);
    else if (a === '--cost-scenarios-bps' && argv[i + 1]) args.costScenariosBps = parseIntList(argv[++i]);
    else if (a === '--primary-cost-bps' && argv[i + 1]) args.primaryCostBps = Number(argv[++i]);
    else if (a === '--exit-fallback-next-valid') args.exitFallbackNextValid = true;
    else if (a === '--one-position-mode') args.onePositionMode = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = [
  'Usage:',
  '  node tools/intraday-shadow-trade-backtest.js \\',
  '    --shadow-root <dir> \\',
  '    --sample-root <dir> \\',
  '    --output-root <dir> \\',
  '    --dates 2026-07-20,2026-07-21,2026-07-22 \\',
  '    --min-score 16',
  '',
  'Options:',
  '  --shadow-root <dir>          Root of live shadow-scoring outputs (<date>/shadow-scores.jsonl). Read-only.',
  '  --sample-root <dir>          Root of intraday samples (<date>/candidates.jsonl) for prices. Read-only.',
  '  --output-root <dir>          Root for backtest outputs. MUST be outside BOTH source roots.',
  '  --dates <d1,d2,...>          Explicit YYYY-MM-DD dates (required; never defaulted).',
  '  --min-score <n>              Minimum shadow_score for the candidate rule (default 16).',
  '  --cost-scenarios-bps <...>   Round-trip cost scenarios in bps (default 0,30,50).',
  '  --primary-cost-bps <n>       Which cost scenario populates the headline per-trade fields (default 30).',
  '  --exit-fallback-next-valid   Allow next-valid-snapshot exits when the exact exit snapshot is missing',
  '                               (the substitution is recorded explicitly). Off by default.',
  '  --one-position-mode          Also evaluate a max-one-open-position-at-a-time portfolio.',
  '  --dry-run                    Compute but do not write any output files.',
  '  --json                       Print the full result object as JSON.',
  '  -h, --help                   Show this help.',
  '',
  'Outputs (under --output-root): trades.jsonl, summary.json, comparison-cost-scenarios.json',
  '',
  'Safety: hard-sets DAYTRADE_INTRADAY_SCORE_ENABLED=false,',
  '        DAYTRADE_WORKER_ALLOW_MUTATION=false, TELEGRAM_ENABLED=0.',
  '        Deterministic, atomic writes, safe reruns; never mutates production',
  '        state or the source files, and never sends Telegram.'
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
    process.stderr.write('SAFETY VIOLATION — refusing to run the shadow trade backtest:\n');
    safety.errors.forEach((e) => process.stderr.write('  - ' + e + '\n'));
    return 2;
  }

  // 3. Required-arg validation with clear errors + non-zero exit.
  const missing = [];
  if (!args.shadowRoot) missing.push('--shadow-root');
  if (!args.sampleRoot) missing.push('--sample-root');
  if (!args.outputRoot) missing.push('--output-root');
  if (!args.dates || !args.dates.length) missing.push('--dates');
  if (missing.length) {
    process.stderr.write('Missing required argument(s): ' + missing.join(', ') + '\n\n' + USAGE + '\n');
    return 2;
  }

  if (args.minScore !== null && !Number.isFinite(args.minScore)) {
    process.stderr.write('Invalid --min-score (must be a number).\n');
    return 2;
  }

  const result = await backtest.runBacktest({
    shadowRoot: path.resolve(args.shadowRoot),
    sampleRoot: path.resolve(args.sampleRoot),
    outputRoot: path.resolve(args.outputRoot),
    dates: args.dates,
    minScore: args.minScore,
    costScenariosBps: args.costScenariosBps,
    primaryCostBps: args.primaryCostBps,
    allowNextValidFallback: args.exitFallbackNextValid,
    onePositionMode: args.onePositionMode,
    dryRun: args.dryRun,
    env: process.env
  });

  if (result.status !== 'success') {
    process.stderr.write('Shadow trade backtest failed: ' + result.status + '\n');
    (result.errors || []).forEach((e) => process.stderr.write('  - ' + e + '\n'));
    if (result.reason) process.stderr.write('  reason: ' + result.reason + '\n');
    return 1;
  }

  const s = result.summary;
  process.stdout.write('Shadow trade backtest complete (evaluation only — nothing deployed, no Telegram, no mutation).\n');
  process.stdout.write('Dates: ' + result.dates.join(', ') + '\n');
  process.stdout.write(
    '  unique_independent_trades=' + s.counts.unique_independent_trades +
    ', unavailable_entries=' + s.counts.unavailable_entry_signals +
    ', rank_2_5_rejected=' + s.counts.rejected_rows_by_rank_2_to_5 +
    ', low_score_rejected=' + s.counts.rejected_rows_by_low_score +
    ', warnings=' + s.warnings.length + '\n'
  );
  if (!args.dryRun && result.outputs) {
    process.stdout.write('  wrote: ' + Object.values(result.outputs).join(', ') + '\n');
  } else {
    process.stdout.write('  (dry-run: no files written)\n');
  }
  s.warnings.forEach((w) => process.stdout.write('  ! ' + w + '\n'));

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

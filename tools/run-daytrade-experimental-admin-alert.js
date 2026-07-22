#!/usr/bin/env node
'use strict';

/**
 * Day Trade EXPERIMENTAL admin-only alert CLI — evaluation ONLY
 * ============================================================
 *
 * Reads already-collected intraday samples, runs the LIVE shadow evaluation for
 * one explicit (date, snapshot) in a FORCED-SAFE environment (production scoring
 * / mutation / Telegram all off during the computation), then applies the strict
 * experimental admin-only gate and — ONLY when
 * DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED is explicitly true — sends a single
 * ADMIN-ONLY experimental alert per eligible confirmed rank-1 candidate.
 *
 * It NEVER modifies the base Day Trade scoring formula, NEVER touches Swing /
 * nightly Top5 / progress monitor / portfolios / Supabase, NEVER delivers to
 * public users or the verification channel, and NEVER introduces a new bot
 * token (it reuses lib/telegram-notifier.js + TELEGRAM_VERIFY_ADMIN_CHAT_ID).
 *
 * Safety:
 *   - The shadow computation is run with DAYTRADE_INTRADAY_SCORE_ENABLED=false,
 *     DAYTRADE_WORKER_ALLOW_MUTATION=false, TELEGRAM_ENABLED=0 (forced clone).
 *   - The alert step asserts DAYTRADE_INTRADAY_SCORE_ENABLED stays off and
 *     DAYTRADE_WORKER_ALLOW_MUTATION is not true.
 *   - Use --dry-run to VALIDATE gate decisions on the VPS WITHOUT sending.
 *
 * Example VPS VALIDATION command (no send, safe to run any time):
 *   node tools/run-daytrade-experimental-admin-alert.js \
 *     --input-root /home/ubuntu/auto-cuan/data/intraday-samples \
 *     --output-root /home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live \
 *     --date 2026-07-22 \
 *     --time 16:00 \
 *     --state-file /home/ubuntu/auto-cuan/data/experimental-daytrade-alerts/alerts.jsonl \
 *     --dry-run
 */

const path = require('node:path');
const live = require('../lib/intraday-shadow-scoring-live');
const alertLib = require('../lib/daytrade-experimental-admin-alert');

function parseArgs(argv) {
  const args = {
    inputRoot: null,
    outputRoot: null,
    date: null,
    time: null,
    stateFile: null,
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
    else if (a === '--state-file' && argv[i + 1]) args.stateFile = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = [
  'Usage:',
  '  node tools/run-daytrade-experimental-admin-alert.js \\',
  '    --input-root <dir> \\',
  '    --output-root <dir> \\',
  '    --date 2026-07-22 \\',
  '    --time 16:00 \\',
  '    [--state-file <path>] [--dry-run] [--json]',
  '',
  'Options:',
  '  --input-root <dir>    Root containing <date>/ sample directories (read-only).',
  '  --output-root <dir>   Root for the live shadow computation. MUST be outside --input-root.',
  '  --date <YYYY-MM-DD>   Explicit sample / trading day (required; never defaults to today).',
  '  --time <HH:MM>        Explicit scheduled snapshot time (required; must be an approved time).',
  '  --state-file <path>   Idempotency state file (default: data/experimental-daytrade-alerts/alerts.jsonl).',
  '  --dry-run             Evaluate + report gate decisions WITHOUT sending or recording (VPS validation).',
  '  --json                Print the full result object as JSON.',
  '  -h, --help            Show this help.',
  '',
  'An alert is only SENT when DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED is',
  'explicitly true AND TELEGRAM is configured. Delivery is ADMIN-ONLY',
  '(TELEGRAM_VERIFY_ADMIN_CHAT_ID) and never reaches public users.'
].join('\n');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  const missing = [];
  if (!args.inputRoot) missing.push('--input-root');
  if (!args.outputRoot) missing.push('--output-root');
  if (!args.date) missing.push('--date');
  if (!args.time) missing.push('--time');
  if (missing.length) {
    process.stderr.write('Missing required argument(s): ' + missing.join(', ') + '\n\n' + USAGE + '\n');
    return 2;
  }

  // 1. Compute the live shadow evaluation in a FORCED-SAFE env clone (pure /
  //    dry-run; no files needed, no Telegram, no mutation during scoring).
  const safeEnv = Object.assign({}, process.env, {
    DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
    DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
    TELEGRAM_ENABLED: '0'
  });
  const evalResult = await live.runLiveShadowSnapshot({
    inputRoot: path.resolve(args.inputRoot),
    outputRoot: path.resolve(args.outputRoot),
    date: args.date,
    scheduledTime: args.time,
    env: safeEnv,
    dryRun: true,
    skipLock: true
  });

  if (evalResult.status !== 'success') {
    process.stderr.write('Live shadow evaluation failed: ' + evalResult.status + '\n');
    (evalResult.errors || []).forEach((e) => process.stderr.write('  - ' + e + '\n'));
    if (evalResult.reason) process.stderr.write('  reason: ' + evalResult.reason + '\n');
    return 1;
  }

  // 2. Apply the experimental admin-only gate using the REAL process.env for the
  //    feature flag and admin destination.
  const result = await alertLib.runExperimentalAdminAlert({
    evaluation: evalResult.evaluation,
    tradingDay: args.date,
    env: process.env,
    stateFile: args.stateFile ? path.resolve(args.stateFile) : undefined,
    dryRun: args.dryRun
  });

  process.stdout.write('Experimental Day Trade admin-only alert — status=' + result.status +
    ', enabled=' + result.enabled + ', evaluated=' + result.evaluated + ', sent=' + result.sent + '\n');
  for (const a of (result.alerts || [])) {
    process.stdout.write('  ' + a.ticker + ': ' + (a.eligible ? 'ELIGIBLE' : 'rejected') +
      (a.reason ? (' (' + a.reason + ')') : '') + (a.sent ? ' — SENT (admin-only)' : (a.dry_run ? ' — dry-run (not sent)' : '')) + '\n');
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

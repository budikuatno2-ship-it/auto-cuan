#!/usr/bin/env node
'use strict';

/**
 * Combined Intraday EXPERIMENTAL Pipeline — date-parameterized, research ONLY
 * ===========================================================================
 *
 * One safe command that runs, in strict order, for one EXPLICIT (date, time):
 *
 *   1. Intraday sample collector      (tools/intraday-sample-collector.js)
 *   2. Live shadow scoring THROUGH t  (lib/intraday-shadow-scoring-live.js)
 *   3. Experimental admin-only gate   (lib/daytrade-experimental-admin-alert.js)
 *
 * The pipeline remains SHADOW / RESEARCH ONLY. It never enables production Day
 * Trade scoring, never mutates recommendation / portfolio / Supabase state,
 * never touches Swing Konglo / Swing Non-Konglo / nightly Top5 / Top5 progress
 * monitor / public Telegram delivery, and never introduces a new bot token.
 *
 * Date parameterization
 *   The collection date is EXPLICIT via --date YYYY-MM-DD and is used for every
 *   stage (sample validation + output dir, shadow evaluation, gate trading day).
 *   The date is NEVER silently taken from the current wall-clock date; the
 *   collector rejects the run when the actual WIB date differs from --date.
 *
 * No look-ahead / timing
 *   The gate may only alert a signal once its NEXT valid snapshot price already
 *   exists. Because each pipeline invocation evaluates cumulatively THROUGH the
 *   given --time, a signal created at the current (latest) snapshot has no later
 *   snapshot yet: it has no executable entry price and is rejected
 *   (REJECT_MISSING_NEXT_SNAPSHOT_PRICE). It only becomes eligible on a LATER
 *   pipeline run whose --time includes the next snapshot. There is never a
 *   same-snapshot executable entry and never any look-ahead.
 *
 * Safety
 *   - Hard-sets DAYTRADE_INTRADAY_SCORE_ENABLED=false and
 *     DAYTRADE_WORKER_ALLOW_MUTATION=false for every stage.
 *   - Runs the shadow computation in a forced-safe env clone (TELEGRAM_ENABLED=0).
 *   - Sends NOTHING to Telegram when --dry-run is supplied OR when
 *     DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED is not explicitly true.
 *   - Admin delivery reuses the EXISTING admin destination
 *     (TELEGRAM_VERIFY_ADMIN_CHAT_ID) and the EXISTING bot token
 *     (TELEGRAM_BOT_TOKEN). It never uses / falls back to TELEGRAM_CHAT_ID,
 *     TELEGRAM_DAYTRADE_CHAT_ID, TELEGRAM_TOP5_CHAT_ID, or
 *     TELEGRAM_VERIFY_CHANNEL_ID.
 *   - A dedicated pipeline lock prevents overlapping pipeline execution.
 *   - Idempotent: reruns can never send the same (date, ticker) alert twice.
 *
 * Output paths (for date YYYY-MM-DD):
 *   Samples:      <sample-root>/YYYY-MM-DD/
 *   Live shadow:  <shadow-root>/YYYY-MM-DD/
 *   Alert state:  <state-file>   (append-only JSONL, atomic append)
 *
 * Example VPS dry-run (safe to run any time — collects + evaluates, sends nothing):
 *   node tools/run-intraday-experimental-pipeline.js \
 *     --date 2026-07-23 \
 *     --time 16:00 \
 *     --sample-root /home/ubuntu/auto-cuan/data/intraday-samples \
 *     --shadow-root /home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live \
 *     --state-file /home/ubuntu/auto-cuan/data/experimental-daytrade-alerts/alerts.jsonl \
 *     --dry-run
 */

const path = require('node:path');

const collectorLib = require('./intraday-sample-collector');
const shadow = require('../lib/intraday-shadow-scoring');
const live = require('../lib/intraday-shadow-scoring-live');
const alertLib = require('../lib/daytrade-experimental-admin-alert');

// Hard safety values applied to EVERY stage of the pipeline.
const FORCED_SAFETY = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false'
});

// Telegram destination env vars that must NEVER be used by this pipeline.
const FORBIDDEN_TELEGRAM_ENV = Object.freeze([
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_DAYTRADE_CHAT_ID',
  'TELEGRAM_TOP5_CHAT_ID',
  'TELEGRAM_VERIFY_CHANNEL_ID'
]);

const DEFAULT_LOCK_FILE = path.join(process.cwd(), 'tmp', 'run-intraday-experimental-pipeline.lock');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    date: null,
    time: null,
    sampleRoot: null,
    shadowRoot: null,
    stateFile: null,
    lockFile: null,
    dryRun: false,
    json: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (a === '--time' && argv[i + 1]) args.time = argv[++i];
    else if (a === '--sample-root' && argv[i + 1]) args.sampleRoot = argv[++i];
    else if (a === '--shadow-root' && argv[i + 1]) args.shadowRoot = argv[++i];
    else if (a === '--state-file' && argv[i + 1]) args.stateFile = argv[++i];
    else if (a === '--lock-file' && argv[i + 1]) args.lockFile = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = [
  'Usage:',
  '  node tools/run-intraday-experimental-pipeline.js \\',
  '    --date 2026-07-23 \\',
  '    --time 16:00 \\',
  '    --sample-root <dir> \\',
  '    --shadow-root <dir> \\',
  '    [--state-file <path>] [--lock-file <path>] [--dry-run] [--json]',
  '',
  'Runs, in order: (1) intraday sample collector, (2) live shadow scoring',
  'through --time, (3) experimental admin-only Day Trade gate.',
  '',
  'Options:',
  '  --date <YYYY-MM-DD>   Explicit collection / trading day (required; never defaults to today).',
  '  --time <HH:MM>        Explicit scheduled snapshot time (required; must be an approved time).',
  '  --sample-root <dir>   Root for intraday samples. Collector writes <sample-root>/<date>/.',
  '  --shadow-root <dir>   Root for live shadow outputs. MUST be outside --sample-root.',
  '  --state-file <path>   Idempotency alert-state file (default: data/experimental-daytrade-alerts/alerts.jsonl).',
  '  --lock-file <path>    Dedicated pipeline lock (default: tmp/run-intraday-experimental-pipeline.lock).',
  '  --dry-run             Run collector + shadow scoring, PREVIEW gate decisions, send NOTHING, write NO alert state.',
  '  --json                Print the full result object as JSON.',
  '  -h, --help            Show this help.',
  '',
  'An alert is only SENT when DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED is',
  'explicitly true AND --dry-run is NOT supplied. Delivery is ADMIN-ONLY',
  '(TELEGRAM_VERIFY_ADMIN_CHAT_ID) using the existing bot token; it never',
  'reaches public users or the verification channel.'
].join('\n');

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * Run the combined intraday experimental pipeline for one explicit (date, time).
 *
 * @param {object} opts
 *   date          required — explicit collection/trading day (YYYY-MM-DD)
 *   time          required — explicit scheduled snapshot time (HH:MM)
 *   sampleRoot    required — root dir for intraday samples (<sampleRoot>/<date>/)
 *   shadowRoot    required — root dir for live shadow outputs (must be OUTSIDE sampleRoot)
 *   stateFile     optional — alert idempotency state file (default DEFAULT_STATE_FILE)
 *   dryRun        optional — collect + evaluate + preview gate, but never send / record
 *   env           optional — base env (defaults to process.env)
 *   lockFile      optional — dedicated pipeline lock file path
 *   skipLock      optional — bypass the pipeline lock (tests only)
 *   supportedDates optional — allowed date set for shadow scoring (default: [date])
 *   sender        optional — admin sender override (tests)
 *   adminChatId   optional — admin destination override (tests)
 *   now           optional — () => Date, for deterministic alert timestamps (tests)
 *   collector     optional — collector stage runner (default collectorLib.runSampleCollection)
 *   shadowScorer  optional — shadow stage runner (default live.runLiveShadowSnapshot)
 *   alerter       optional — gate stage runner (default alertLib.runExperimentalAdminAlert)
 *   collectorOptions optional — extra options merged into the collector call
 * @returns result object (never throws)
 */
async function runPipeline(opts) {
  opts = opts || {};
  const baseEnv = opts.env || process.env;
  const dryRun = opts.dryRun === true;

  // 1. Required arguments — NEVER default the date/time to the current clock.
  const missing = [];
  if (opts.date === undefined || opts.date === null || opts.date === '') missing.push('date');
  if (opts.time === undefined || opts.time === null || opts.time === '') missing.push('time');
  if (!opts.sampleRoot) missing.push('sampleRoot');
  if (!opts.shadowRoot) missing.push('shadowRoot');
  if (missing.length) {
    return { status: 'error', errors: ['missing required argument(s): ' + missing.join(', ')] };
  }

  // 2. Validate the explicit date + time up front (reject invalid / unsupported).
  const dateFmt = collectorLib.parseSampleDate(opts.date);
  if (!dateFmt.valid) {
    return { status: 'rejected', stage: 'validate', reason: 'invalid_date', detail: dateFmt };
  }
  const timeVal = live.validateScheduledTime(opts.time);
  if (!timeVal.valid) {
    return { status: 'rejected', stage: 'validate', reason: 'invalid_time', detail: timeVal };
  }
  const date = dateFmt.date;
  const time = timeVal.scheduledTime;

  // 3. Safe output-path guard (refuse shadow output inside the sample source).
  try {
    shadow.assertSafeOutputRoot(opts.sampleRoot, opts.shadowRoot);
  } catch (e) {
    return { status: 'unsafe_output_path', errors: [e.message] };
  }

  // 4. Build the hard-set-safe env used by every stage. Only ever a downgrade
  //    to the known-safe values; the operator's Telegram enable / feature flag /
  //    admin chat / bot token are preserved as-is.
  const pipelineEnv = Object.assign({}, baseEnv, FORCED_SAFETY);
  const shadowEnv = Object.assign({}, pipelineEnv, { TELEGRAM_ENABLED: '0' });

  // 5. Acquire the dedicated pipeline lock (prevents overlapping runs).
  const lockFile = opts.lockFile || DEFAULT_LOCK_FILE;
  let release = null;
  if (!opts.skipLock) {
    release = await live.acquireLock(lockFile);
    if (!release) {
      return { status: 'skipped_due_to_lock', date: date, scheduled_time: time, lock_file: lockFile };
    }
  }

  // Hard-set the safety flags on process.env for the duration of the run so the
  // collector (which reads process.env directly) cannot run with production
  // scoring / mutation enabled. Restored in the finally block.
  const savedScore = process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
  const savedMutation = process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
  process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = 'false';
  process.env.DAYTRADE_WORKER_ALLOW_MUTATION = 'false';

  const stagesCompleted = [];
  try {
    // === STAGE 1: intraday sample collector ===
    const collector = typeof opts.collector === 'function' ? opts.collector : collectorLib.runSampleCollection;
    const collectorOptions = Object.assign({
      scheduledTime: time,
      sampleDate: date,
      sampleRoot: opts.sampleRoot
    }, opts.collectorOptions || {});
    const collectorResult = await collector(collectorOptions);
    stagesCompleted.push('collector');
    if (!collectorResult || collectorResult.status !== 'success') {
      return {
        status: 'collector_failed',
        date: date,
        scheduled_time: time,
        dry_run: dryRun,
        stages_completed: stagesCompleted,
        collector: collectorResult,
        lock_file: opts.skipLock ? null : lockFile
      };
    }

    // === STAGE 2: live shadow scoring THROUGH the target time ===
    const shadowScorer = typeof opts.shadowScorer === 'function' ? opts.shadowScorer : live.runLiveShadowSnapshot;
    const shadowResult = await shadowScorer({
      inputRoot: opts.sampleRoot,
      outputRoot: opts.shadowRoot,
      date: date,
      scheduledTime: time,
      supportedDates: opts.supportedDates || [date],
      env: shadowEnv,
      // Shadow scoring always writes its research output; --dry-run only
      // suppresses the gate's Telegram send + alert-state write.
      dryRun: false
    });
    stagesCompleted.push('shadow_scoring');
    if (!shadowResult || shadowResult.status !== 'success') {
      return {
        status: 'shadow_failed',
        date: date,
        scheduled_time: time,
        dry_run: dryRun,
        stages_completed: stagesCompleted,
        collector: collectorResult,
        shadow_scoring: shadowResult,
        lock_file: opts.skipLock ? null : lockFile
      };
    }

    // === STAGE 3: experimental admin-only gate ===
    // The gate uses the hard-set-safe env for the feature flag / admin chat /
    // safety assertions. It sends nothing under --dry-run or when the feature
    // flag is not explicitly true. Delivery (when enabled) is ADMIN-ONLY.
    const alerter = typeof opts.alerter === 'function' ? opts.alerter : alertLib.runExperimentalAdminAlert;
    const alertResult = await alerter({
      evaluation: shadowResult.evaluation,
      tradingDay: date,
      env: pipelineEnv,
      stateFile: opts.stateFile || alertLib.DEFAULT_STATE_FILE,
      dryRun: dryRun,
      sender: opts.sender,
      adminChatId: opts.adminChatId,
      now: opts.now
    });
    stagesCompleted.push('admin_gate');

    return {
      status: 'success',
      date: date,
      scheduled_time: time,
      dry_run: dryRun,
      stages_completed: stagesCompleted,
      sample_dir: path.join(opts.sampleRoot, date),
      shadow_dir: path.join(opts.shadowRoot, date),
      state_file: opts.stateFile || alertLib.DEFAULT_STATE_FILE,
      collector: {
        status: collectorResult.status,
        candidates: collectorResult.candidates,
        scanned: collectorResult.scanned,
        summary_generated: !!collectorResult.summary_generated
      },
      shadow_scoring: {
        status: shadowResult.status,
        evaluated_snapshot_times: shadowResult.evaluation && shadowResult.evaluation.summary
          ? shadowResult.evaluation.summary.evaluated_snapshot_times : [],
        outputs: shadowResult.outputs || null
      },
      admin_gate: alertResult,
      lock_file: opts.skipLock ? null : lockFile,
      safety: {
        DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
        DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
        shadow_telegram_enabled: '0',
        dry_run: dryRun,
        feature_flag: alertLib.FEATURE_FLAG,
        feature_flag_enabled: alertLib.isExperimentalAdminAlertEnabled(pipelineEnv),
        admin_only: true,
        public_delivery_possible: false,
        forbidden_telegram_env_unused: FORBIDDEN_TELEGRAM_ENV.slice()
      }
    };
  } finally {
    // Restore process.env safety flags to their prior values.
    if (savedScore === undefined) delete process.env.DAYTRADE_INTRADAY_SCORE_ENABLED;
    else process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = savedScore;
    if (savedMutation === undefined) delete process.env.DAYTRADE_WORKER_ALLOW_MUTATION;
    else process.env.DAYTRADE_WORKER_ALLOW_MUTATION = savedMutation;
    if (release) await release();
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  const missing = [];
  if (!args.date) missing.push('--date');
  if (!args.time) missing.push('--time');
  if (!args.sampleRoot) missing.push('--sample-root');
  if (!args.shadowRoot) missing.push('--shadow-root');
  if (missing.length) {
    process.stderr.write('Missing required argument(s): ' + missing.join(', ') + '\n\n' + USAGE + '\n');
    return 2;
  }

  const result = await runPipeline({
    date: args.date,
    time: args.time,
    sampleRoot: path.resolve(args.sampleRoot),
    shadowRoot: path.resolve(args.shadowRoot),
    stateFile: args.stateFile ? path.resolve(args.stateFile) : undefined,
    lockFile: args.lockFile ? path.resolve(args.lockFile) : undefined,
    dryRun: args.dryRun
  });

  process.stdout.write('Intraday experimental pipeline — status=' + result.status +
    ', date=' + (result.date || args.date) + ', time=' + (result.scheduled_time || args.time) +
    ', dry_run=' + (result.dry_run === true) + '\n');
  process.stdout.write('  stages: ' + ((result.stages_completed || []).join(' -> ') || '(none)') + '\n');
  if (result.admin_gate) {
    const g = result.admin_gate;
    process.stdout.write('  gate: status=' + g.status + ', enabled=' + g.enabled +
      ', evaluated=' + g.evaluated + ', sent=' + g.sent + '\n');
    for (const a of (g.alerts || [])) {
      process.stdout.write('    ' + a.ticker + ': ' + (a.eligible ? 'ELIGIBLE' : 'rejected') +
        (a.reason ? (' (' + a.reason + ')') : '') +
        (a.sent ? ' — SENT (admin-only)' : (a.dry_run ? ' — dry-run (not sent)' : '')) + '\n');
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  // Non-success terminal states use a non-zero exit code (except dry-run/disabled).
  const okStatuses = ['success'];
  return okStatuses.includes(result.status) ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((e) => { process.stderr.write('FATAL: ' + (e && e.message ? e.message : String(e)) + '\n'); process.exitCode = 1; });
}

module.exports = {
  FORCED_SAFETY,
  FORBIDDEN_TELEGRAM_ENV,
  DEFAULT_LOCK_FILE,
  parseArgs,
  USAGE,
  runPipeline,
  main
};

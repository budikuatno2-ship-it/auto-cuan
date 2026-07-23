'use strict';

/**
 * Intraday Experimental Collector — VPS Rollout Audit (pure / deterministic)
 * =========================================================================
 *
 * Pure, side-effect-free helpers that VERIFY (and, on explicit request, build the
 * artefacts to INSTALL / REPAIR) the one-day experimental intraday collector on
 * the real VPS. This module performs NO IO itself — the CLI wrapper
 * (tools/verify-intraday-collector-vps.js) reads the filesystem / crontab and
 * feeds the raw text here. That separation keeps every rule unit-testable and
 * guarantees the audit can never run the screener, send Telegram, or touch cron.
 *
 * The collector was prepared for 2026-07-23:
 *   - 21 collection runs between 09:15 and 16:00 WIB
 *   - 1 cleanup run at 16:10 WIB (removes its OWN temporary cron entries)
 *   - runner: /home/ubuntu/auto-cuan-runner/intraday-experimental-20260723.sh
 *   - log:    /home/ubuntu/auto-cuan-runner/logs/intraday-experimental-2026-07-23.log
 *   - Node 22: /home/ubuntu/.local/node-v22/bin/node
 *
 * Required runner environment (all six MUST be present, exact values):
 *   TRADE_PLAN_V2_SHADOW_ENABLED=true
 *   TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED=true
 *   TRADE_PLAN_V2_PUBLIC_ENABLED=false
 *   DAYTRADE_INTRADAY_SCORE_ENABLED=false
 *   DAYTRADE_WORKER_ALLOW_MUTATION=false
 *   TELEGRAM_ENABLED=0
 */

const SAMPLE_DATE = '2026-07-23';
const RUNNER_PATH = '/home/ubuntu/auto-cuan-runner/intraday-experimental-20260723.sh';
const LOG_PATH = '/home/ubuntu/auto-cuan-runner/logs/intraday-experimental-2026-07-23.log';
const NODE_BIN = '/home/ubuntu/.local/node-v22/bin/node';
const REPO_DIR = '/home/ubuntu/auto-cuan';
const COLLECTOR_REL = 'tools/intraday-sample-collector.js';
const CLEANUP_TIME = '16:10';

// The 21 approved WIB collection times (must equal the collector's schedule).
const COLLECTION_TIMES = Object.freeze([
  '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00',
  '11:15', '11:30', '11:45', '13:45', '14:00', '14:15', '14:30', '14:45',
  '15:00', '15:15', '15:30', '15:45', '16:00'
]);

// Required env flags and their exact expected values.
const REQUIRED_FLAGS = Object.freeze({
  TRADE_PLAN_V2_SHADOW_ENABLED: 'true',
  TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED: 'true',
  TRADE_PLAN_V2_PUBLIC_ENABLED: 'false',
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0'
});
const REQUIRED_FLAG_NAMES = Object.freeze(Object.keys(REQUIRED_FLAGS));

// Stable crontab markers. Every managed line contains MANAGED_SUBSTR so a single
// grep -v can strip the whole managed block without touching unrelated entries.
const MANAGED_SUBSTR = 'auto-cuan-intraday-experimental-20260723';
const COLLECTION_TAG = '# ' + MANAGED_SUBSTR + ' collect';
const CLEANUP_TAG = '# ' + MANAGED_SUBSTR + ' cleanup';
const CRON_TZ_LINE = 'CRON_TZ=Asia/Jakarta';

function timeToCron(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) throw new Error('invalid HH:MM time: ' + hhmm);
  return Number(m[2]) + ' ' + Number(m[1]) + ' * * *';
}

/** A single collection cron line for one scheduled time. */
function buildCollectionLine(hhmm) {
  return timeToCron(hhmm) + ' ' + RUNNER_PATH + ' --scheduled-time ' + hhmm +
    ' >> ' + LOG_PATH + ' 2>&1 ' + COLLECTION_TAG;
}

/** The single self-cleanup cron line at 16:10 WIB. */
function buildCleanupLine() {
  return timeToCron(CLEANUP_TIME) + ' ' + RUNNER_PATH + ' --cleanup-cron' +
    ' >> ' + LOG_PATH + ' 2>&1 ' + CLEANUP_TAG;
}

/** The full managed crontab block (CRON_TZ + 21 collection + 1 cleanup). */
function buildManagedBlock() {
  const lines = [CRON_TZ_LINE + ' ' + COLLECTION_TAG];
  for (const t of COLLECTION_TIMES) lines.push(buildCollectionLine(t));
  lines.push(buildCleanupLine());
  return lines;
}

/** Split raw crontab text into trimmed, non-empty lines. */
function splitLines(text) {
  return String(text == null ? '' : text).split(/\r?\n/);
}

/**
 * Compute the desired crontab given the EXISTING crontab text. Idempotent: all
 * previously-managed lines are removed first, then a single fresh managed block
 * is appended. Unrelated entries are preserved verbatim and in order.
 */
function computeDesiredCrontab(existingText) {
  const kept = splitLines(existingText).filter((line) => line.indexOf(MANAGED_SUBSTR) < 0);
  // Drop trailing blank lines from the preserved section for a clean join.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const managed = buildManagedBlock();
  const out = kept.concat(managed);
  return out.join('\n') + '\n';
}

/** Extract the scheduled time from a managed collection line (or null). */
function scheduledTimeOf(line) {
  const m = /--scheduled-time\s+(\d{2}:\d{2})/.exec(line);
  return m ? m[1] : null;
}

/**
 * Audit a crontab: exactly 21 collection schedules, exactly 1 cleanup schedule,
 * no duplicate entries, and every scheduled time is an approved one.
 */
function auditCrontab(crontabText) {
  const lines = splitLines(crontabText);
  const collection = lines.filter((l) => l.indexOf(COLLECTION_TAG) >= 0 && l.indexOf('--scheduled-time') >= 0);
  const cleanup = lines.filter((l) => l.indexOf(CLEANUP_TAG) >= 0);
  const times = collection.map(scheduledTimeOf).filter(Boolean);

  const seen = Object.create(null);
  const duplicates = [];
  for (const t of times) {
    seen[t] = (seen[t] || 0) + 1;
    if (seen[t] === 2) duplicates.push(t);
  }
  const unexpected = times.filter((t) => COLLECTION_TIMES.indexOf(t) < 0);
  const missing = COLLECTION_TIMES.filter((t) => times.indexOf(t) < 0);

  const issues = [];
  if (collection.length !== 21) issues.push('expected 21 collection schedules, found ' + collection.length);
  if (cleanup.length !== 1) issues.push('expected exactly 1 cleanup schedule, found ' + cleanup.length);
  if (duplicates.length) issues.push('duplicate collection schedules: ' + duplicates.join(', '));
  if (unexpected.length) issues.push('unexpected scheduled times: ' + unexpected.join(', '));
  if (missing.length) issues.push('missing scheduled times: ' + missing.join(', '));

  return {
    collection_count: collection.length,
    cleanup_count: cleanup.length,
    duplicates: duplicates,
    unexpected_times: unexpected,
    missing_times: missing,
    has_no_duplicates: duplicates.length === 0,
    ok: issues.length === 0,
    issues: issues
  };
}

/** Parse `KEY=value` (optionally `export KEY=value`) assignments from a script. */
function parseScriptFlags(content) {
  const out = Object.create(null);
  for (const raw of splitLines(content)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'#\s]*)["']?/.exec(raw);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Audit the runner script CONTENT (+ optional stat metadata). Verifies the six
 * required flags with exact values, Node 22 usage, self-cleanup logic, Telegram
 * disabled, and no screener-scoring / Supabase mutation capability.
 *
 * @param {string} content runner script text
 * @param {object} meta { exists, executable }
 */
function auditRunnerScript(content, meta) {
  meta = meta || {};
  const flags = parseScriptFlags(content);
  const flag_values = {};
  const missing_flags = [];
  const wrong_flags = [];
  for (const name of REQUIRED_FLAG_NAMES) {
    flag_values[name] = Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : null;
    if (flag_values[name] === null) missing_flags.push(name);
    else if (flag_values[name] !== REQUIRED_FLAGS[name]) wrong_flags.push(name + '=' + flag_values[name] + ' (expected ' + REQUIRED_FLAGS[name] + ')');
  }

  const node22 = content.indexOf(NODE_BIN) >= 0;
  const telegram_disabled = flag_values.TELEGRAM_ENABLED === '0';
  const mutation_disabled = flag_values.DAYTRADE_WORKER_ALLOW_MUTATION === 'false';
  const score_disabled = flag_values.DAYTRADE_INTRADAY_SCORE_ENABLED === 'false';
  const public_disabled = flag_values.TRADE_PLAN_V2_PUBLIC_ENABLED === 'false';
  const has_cleanup = /--cleanup-cron/.test(content) && new RegExp(MANAGED_SUBSTR).test(content);
  const runs_collector = content.indexOf(COLLECTOR_REL) >= 0;

  const issues = [];
  if (meta.exists === false) issues.push('runner script does not exist at ' + RUNNER_PATH);
  if (meta.executable === false) issues.push('runner script is not executable');
  if (missing_flags.length) issues.push('missing required flags: ' + missing_flags.join(', '));
  if (wrong_flags.length) issues.push('incorrect flag values: ' + wrong_flags.join('; '));
  if (!node22) issues.push('runner does not use Node 22 at ' + NODE_BIN);
  if (!telegram_disabled) issues.push('Telegram is not disabled (TELEGRAM_ENABLED must be 0)');
  if (!mutation_disabled) issues.push('mutation not disabled (DAYTRADE_WORKER_ALLOW_MUTATION must be false)');
  if (!score_disabled) issues.push('intraday scoring not disabled (DAYTRADE_INTRADAY_SCORE_ENABLED must be false)');
  if (!has_cleanup) issues.push('runner is missing the 16:10 self-cleanup (--cleanup-cron) logic');
  if (!runs_collector) issues.push('runner does not invoke ' + COLLECTOR_REL);

  return {
    exists: meta.exists !== false,
    executable: meta.executable === true,
    flag_values: flag_values,
    missing_flags: missing_flags,
    wrong_flags: wrong_flags,
    node22: node22,
    telegram_disabled: telegram_disabled,
    mutation_disabled: mutation_disabled,
    score_disabled: score_disabled,
    public_disabled: public_disabled,
    has_self_cleanup: has_cleanup,
    runs_collector: runs_collector,
    ok: issues.length === 0,
    issues: issues
  };
}

/**
 * Build the canonical runner shell script written by --install / --repair. It
 * exports the six required flags, runs the collector under Node 22, logs to the
 * fixed log path, and self-removes its cron entries on --cleanup-cron. It NEVER
 * sends Telegram (TELEGRAM_ENABLED=0), never mutates scoring/Supabase
 * (DAYTRADE_WORKER_ALLOW_MUTATION=false, DAYTRADE_INTRADAY_SCORE_ENABLED=false),
 * and keeps public V2 off (TRADE_PLAN_V2_PUBLIC_ENABLED=false).
 */
function buildRunnerScript() {
  return [
    '#!/usr/bin/env bash',
    '# ' + MANAGED_SUBSTR + ' — one-day experimental intraday collector runner.',
    '# Generated by tools/verify-intraday-collector-vps.js (--install/--repair).',
    'set -euo pipefail',
    '',
    '# Required shadow/rollout + safety environment (exact values are audited).',
    'export TRADE_PLAN_V2_SHADOW_ENABLED=true',
    'export TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED=true',
    'export TRADE_PLAN_V2_PUBLIC_ENABLED=false',
    'export DAYTRADE_INTRADAY_SCORE_ENABLED=false',
    'export DAYTRADE_WORKER_ALLOW_MUTATION=false',
    'export TELEGRAM_ENABLED=0',
    '',
    'NODE_BIN=' + NODE_BIN,
    'REPO_DIR=' + REPO_DIR,
    'LOG_PATH=' + LOG_PATH,
    'SAMPLE_DATE=' + SAMPLE_DATE,
    'MANAGED_SUBSTR=' + MANAGED_SUBSTR,
    '',
    'mkdir -p "$(dirname "$LOG_PATH")"',
    '',
    '# 16:10 self-cleanup: remove this collector\'s OWN temporary cron entries,',
    '# preserving every unrelated crontab line.',
    'if [ "${1:-}" = "--cleanup-cron" ]; then',
    '  (crontab -l 2>/dev/null | grep -v "$MANAGED_SUBSTR" | crontab -) || true',
    '  echo "[cleanup] removed managed cron entries at $(date -Is)" >> "$LOG_PATH"',
    '  exit 0',
    'fi',
    '',
    'SCHEDULED_TIME="09:15"',
    'if [ "${1:-}" = "--scheduled-time" ]; then SCHEDULED_TIME="${2:-09:15}"; fi',
    '',
    '"$NODE_BIN" "$REPO_DIR/' + COLLECTOR_REL + '" \\',
    '  --scheduled-time "$SCHEDULED_TIME" \\',
    '  --sample-date "$SAMPLE_DATE" >> "$LOG_PATH" 2>&1',
    ''
  ].join('\n');
}

module.exports = {
  SAMPLE_DATE,
  RUNNER_PATH,
  LOG_PATH,
  NODE_BIN,
  REPO_DIR,
  COLLECTOR_REL,
  CLEANUP_TIME,
  COLLECTION_TIMES,
  REQUIRED_FLAGS,
  REQUIRED_FLAG_NAMES,
  MANAGED_SUBSTR,
  COLLECTION_TAG,
  CLEANUP_TAG,
  timeToCron,
  buildCollectionLine,
  buildCleanupLine,
  buildManagedBlock,
  computeDesiredCrontab,
  auditCrontab,
  parseScriptFlags,
  auditRunnerScript,
  buildRunnerScript
};

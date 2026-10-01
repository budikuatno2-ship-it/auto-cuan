#!/usr/bin/env node
'use strict';

/**
 * CLI — Verify / Install / Repair the experimental intraday collector on the VPS
 * =============================================================================
 *
 * SAFE BY DEFAULT. With NO arguments this tool is strictly READ-ONLY: it inspects
 * the runner script, the crontab, and the output paths and prints a JSON audit.
 * It NEVER runs the screener, NEVER sends Telegram, and NEVER modifies cron unless
 * an explicit --install or --repair argument is supplied.
 *
 *   node tools/verify-intraday-collector-vps.js            # read-only audit
 *   node tools/verify-intraday-collector-vps.js --install  # idempotent install
 *   node tools/verify-intraday-collector-vps.js --repair   # idempotent repair
 *
 * --install / --repair are idempotent and preserve every unrelated crontab entry
 * (only the collector's own managed block is replaced). All heavy verification
 * logic lives in lib/intraday-collector-vps-audit.js (pure + unit-tested).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/intraday-collector-vps-audit');

function parseArgs(argv) {
  const a = { install: false, repair: false, json: true };
  for (const x of argv.slice(2)) {
    if (x === '--install') a.install = true;
    else if (x === '--repair') a.repair = true;
    else if (x === '--text') a.json = false;
  }
  return a;
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function statSafe(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

function isExecutable(st) {
  if (!st) return false;
  return (st.mode & 0o111) !== 0;
}

/** Read the current crontab (read-only). Returns '' when none / unavailable. */
function readCrontab() {
  try { return execFileSync('crontab', ['-l'], { encoding: 'utf8' }); }
  catch (e) { return ''; }
}

/** Install a crontab text (only called under --install/--repair). */
function writeCrontab(text) {
  execFileSync('crontab', ['-'], { input: text });
}

/**
 * READ-ONLY writability probe: walk up to the nearest EXISTING ancestor and test
 * W_OK there. Never creates any directory (the verify path must not mutate the
 * filesystem). Returns true when the target dir exists and is writable, or when
 * its nearest existing ancestor is writable (i.e. it could be created).
 */
function canWriteReadOnly(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(cur)) {
      try { fs.accessSync(cur, fs.constants.W_OK); return true; } catch (e) { return false; }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function buildReport(mode) {
  const runnerContent = readFileSafe(audit.RUNNER_PATH);
  const runnerStat = statSafe(audit.RUNNER_PATH);
  const crontabText = readCrontab();

  const runnerAudit = audit.auditRunnerScript(runnerContent || '', {
    exists: runnerContent !== null,
    executable: isExecutable(runnerStat)
  });
  const cronAudit = audit.auditCrontab(crontabText);

  const logWritable = canWriteReadOnly(path.dirname(audit.LOG_PATH));
  const sampleDir = path.join(audit.REPO_DIR, 'data', 'intraday-samples', audit.SAMPLE_DATE);
  const outputWritable = canWriteReadOnly(sampleDir);

  const nodeBinPresent = statSafe(audit.NODE_BIN) !== null;

  const ok = runnerAudit.ok && cronAudit.ok && logWritable && outputWritable;
  return {
    tool: 'verify-intraday-collector-vps',
    mode: mode,
    sample_date: audit.SAMPLE_DATE,
    node_bin: audit.NODE_BIN,
    node_bin_present: nodeBinPresent,
    runner_path: audit.RUNNER_PATH,
    log_path: audit.LOG_PATH,
    runner: runnerAudit,
    crontab: cronAudit,
    output_paths_writable: outputWritable,
    log_path_writable: logWritable,
    cannot_send_telegram: runnerAudit.telegram_disabled,
    cannot_mutate_scoring_or_supabase: runnerAudit.mutation_disabled && runnerAudit.score_disabled,
    // Decoupled rollout: the internal intraday plan-lock is enabled while public
    // website / Telegram V2 stays disabled. Both are verified independently.
    intraday_lock_enabled: runnerAudit.intraday_lock_enabled,
    public_v2_disabled: runnerAudit.public_disabled,
    ok: ok
  };
}

function doInstall(mode) {
  // 1) Write the runner script (idempotent — canonical content) + chmod +x.
  fs.mkdirSync(path.dirname(audit.RUNNER_PATH), { recursive: true });
  fs.writeFileSync(audit.RUNNER_PATH, audit.buildRunnerScript(), { mode: 0o755 });
  try { fs.chmodSync(audit.RUNNER_PATH, 0o755); } catch (e) { /* best effort */ }
  // 2) Ensure the log directory exists.
  fs.mkdirSync(path.dirname(audit.LOG_PATH), { recursive: true });
  // 3) Install the managed crontab block idempotently, preserving unrelated
  //    entries. computeDesiredCrontab strips ALL prior managed lines first.
  const existing = readCrontab();
  const desired = audit.computeDesiredCrontab(existing);
  writeCrontab(desired);
  return buildReport(mode);
}

function main() {
  const args = parseArgs(process.argv);
  let report;
  if (args.install || args.repair) {
    const mode = args.repair && !args.install ? 'repair' : 'install';
    try {
      report = doInstall(mode);
      report.action_performed = mode;
    } catch (e) {
      report = { tool: 'verify-intraday-collector-vps', mode: mode, ok: false, error: e.message || String(e), action_performed: 'failed' };
      process.exitCode = 1;
    }
  } else {
    report = buildReport('verify');
    report.action_performed = 'none (read-only)';
  }

  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write((report.ok ? 'OK' : 'ISSUES') + ' — see --json for detail\n');
  if (!report.ok && process.exitCode == null) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { parseArgs, isExecutable, buildReport, doInstall };

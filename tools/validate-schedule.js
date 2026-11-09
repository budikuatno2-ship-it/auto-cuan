#!/usr/bin/env node
'use strict';

/**
 * tools/validate-schedule.js — static schedule validator (V5, BUG-V5-P0-006)
 * ============================================================================
 * Validates deploy/vps/final-schedule.cron against two invariants:
 *
 *   1. FORBIDDEN WINDOW: no cron entry that consumes Stock Arjum quota may
 *      START inside 23:50-00:10 WIB. Entries marked JOB_USES_QUOTA=0 are
 *      exempt (the wrapper only blocks quota jobs in the window).
 *      Additionally, quota jobs whose timeout would carry them past 23:50
 *      (start + timeout crossing 23:50) are flagged as warnings.
 *
 *   2. DOUBLE-SCHEDULING: no script may be scheduled by BOTH the cron table
 *      and the PM2 scheduler daemon (scripts/scheduler-daemon.js), and the
 *      PM2 ecosystem config must not register the daemon as an executing app
 *      (the daemon is observer-only in V5).
 *
 * Exit codes: 0 = valid, 1 = violations found, 2 = infrastructure failure.
 * Run in CI / before `install-cron-entries.sh` touches the live crontab.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CRON_FILE = path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron');
const DAEMON_FILE = path.join(ROOT, 'scripts', 'scheduler-daemon.js');
const ECO_FILE = path.join(ROOT, 'ecosystem.config.js');

// Forbidden window in minutes-of-day (WIB): [23:50, 00:10) wrapping midnight.
const WIN_START = 23 * 60 + 50; // 1430
const WIN_END = 0 * 60 + 10; // 10

function inForbiddenWindow(minOfDay) {
  return minOfDay >= WIN_START || minOfDay < WIN_END;
}

/** Parse one cron line. Returns { minute, hour, dom, month, dow, env, cmd } or null. */
function parseCronLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(/\s+/);
  // cron env assignments (CRON_TZ=..., TZ=..., etc.)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) return null;
  if (parts.length < 6) return null;
  const [minute, hour, dom, month, dow] = parts;
  const env = /^JOB_USES_QUOTA=0$/.test(parts[5]) ? parts[5] : '';
  const cmdStart = env ? 6 : 5;
  if (parts.length < cmdStart + 1) return null;
  return {
    minute, hour, dom, month, dow, env,
    cmd: parts.slice(cmdStart).join(' '),
    raw: trimmed
  };
}

/** Expand minute/hour fields into concrete start minutes-of-day. Returns null if unexpandable. */
function expandStartMinutes(entry) {
  const hours = expandField(entry.hour, 0, 23);
  const minutes = expandField(entry.minute, 0, 59);
  if (hours === null || minutes === null) return null;
  const out = [];
  for (const h of hours) for (const m of minutes) out.push(h * 60 + m);
  return out;
}

function expandField(field, lo, hi) {
  if (field === '*') return null; // wildcard: every slot — treated as unexpandable
  const values = new Set();
  for (const part of field.split(',')) {
    const stepMatch = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!stepMatch) return null;
    const [, range, stepStr] = stepMatch;
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let startVal, endVal;
    if (range === '*') { startVal = lo; endVal = hi; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      startVal = a; endVal = b;
    } else { startVal = endVal = Number(range); }
    if (!Number.isFinite(startVal) || !Number.isFinite(endVal) || !(step >= 1)) return null;
    for (let v = startVal; v <= endVal && v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

function jobNameOf(cmd) {
  const m = /job-wrapper\.sh\s+([a-zA-Z0-9_-]+)/.exec(cmd);
  return m ? m[1] : '(no job-wrapper)';
}

function timeoutSecondsOf(cmd) {
  const m = /job-wrapper\.sh\s+[a-zA-Z0-9_-]+\s+(\d+)/.exec(cmd);
  return m ? parseInt(m[1], 10) : null;
}

/* -------------------------------------------------------------------------- */
/* 1. Forbidden window check                                                  */
/* -------------------------------------------------------------------------- */
function checkForbiddenWindow(lines) {
  const violations = [];
  const warnings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const entry = parseCronLine(lines[i]);
    if (!entry) continue;
    const usesQuota = entry.env !== 'JOB_USES_QUOTA=0';
    const starts = expandStartMinutes(entry);
    const job = jobNameOf(entry.cmd);
    if (starts === null) {
      if (usesQuota) {
        violations.push({
          line: i + 1, job, reason: 'complex schedule pattern (wildcard) on a quota job — cannot prove it avoids 23:50-00:10',
          raw: entry.raw
        });
      }
      continue;
    }
    for (const start of starts) {
      if (usesQuota && inForbiddenWindow(start)) {
        const hh = String(Math.floor(start / 60)).padStart(2, '0');
        const mm = String(start % 60).padStart(2, '0');
        violations.push({
          line: i + 1, job,
          reason: 'quota job starts at ' + hh + ':' + mm + ' WIB — inside forbidden window 23:50-00:10',
          raw: entry.raw
        });
      }
      // Timeout crossing check (both quota and 0-quota jobs; 0-quota only warned).
      const timeoutSec = timeoutSecondsOf(entry.cmd);
      if (timeoutSec !== null) {
        const endMin = start + Math.ceil(timeoutSec / 60);
        const crosses = inForbiddenWindow(start)
          || (start < WIN_START && endMin > WIN_START && endMin < 24 * 60 + WIN_END)
          || (endMin >= 24 * 60 && (endMin - 24 * 60) < WIN_END);
        if (crosses && usesQuota && !inForbiddenWindow(start)) {
          warnings.push({
            line: i + 1, job,
            reason: 'quota job start + timeout crosses into 23:50 WIB hard stop (start=' +
              String(Math.floor(start / 60)).padStart(2, '0') + ':' + String(start % 60).padStart(2, '0') +
              ', timeout=' + timeoutSec + 's)'
          });
        }
      }
    }
  }
  return { violations, warnings };
}

/* -------------------------------------------------------------------------- */
/* 2. Double-scheduling check (cron vs PM2 daemon)                            */
/* -------------------------------------------------------------------------- */
function checkDoubleScheduling(lines) {
  const violations = [];

  // Daemon scripts it would execute (legacy shape kept for the validator;
  // the V5 observer daemon contains no runNode() calls, so this is empty).
  let daemonSource = '';
  try { daemonSource = fs.readFileSync(DAEMON_FILE, 'utf8'); } catch (_) {
    return [{ line: 0, job: '(daemon)', reason: 'scripts/scheduler-daemon.js unreadable', raw: '' }];
  }
  const daemonScripts = new Set();
  for (const m of daemonSource.matchAll(/runNode\(\s*'([^']+)'/g)) {
    daemonScripts.add(path.basename(m[1]));
  }
  // Also treat any direct spawn of a known tool from the daemon as execution.
  if (/spawnSync|spawn\(|execSync|exec\(/.test(daemonSource.replace(/\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, ''))) {
    // The observer must not spawn anything; flag as an execution-capable daemon.
    violations.push({
      line: 0, job: 'scripts/scheduler-daemon.js',
      reason: 'scheduler daemon still contains spawn/exec code — must be observer-only in V5',
      raw: ''
    });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const entry = parseCronLine(lines[i]);
    if (!entry) continue;
    for (const script of daemonScripts) {
      if (entry.cmd.includes(script)) {
        violations.push({
          line: i + 1, job: jobNameOf(entry.cmd),
          reason: 'script "' + script + '" scheduled by BOTH cron and scripts/scheduler-daemon.js',
          raw: entry.raw
        });
      }
    }
  }

  // PM2 ecosystem must not register the daemon as an executing app.
  let ecoSource = '';
  try { ecoSource = fs.readFileSync(ECO_FILE, 'utf8'); } catch (_) { ecoSource = ''; }
  if (ecoSource && /['"]auto-cuan-scheduler['"]/.test(ecoSource.replace(/\/\/.*$/gm, ''))) {
    violations.push({
      line: 0, job: 'ecosystem.config.js',
      reason: 'PM2 ecosystem still registers auto-cuan-scheduler as an app — remove it (cron owns execution)',
      raw: ''
    });
  }

  return violations;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */
function main() {
  let cronText;
  try { cronText = fs.readFileSync(CRON_FILE, 'utf8'); } catch (e) {
    console.error('[validate-schedule] FATAL: cannot read ' + CRON_FILE + ': ' + e.message);
    process.exit(2);
  }
  const lines = cronText.split(/\r?\n/);

  if (!/CRON_TZ=Asia\/Jakarta/.test(cronText)) {
    console.error('[validate-schedule] FAIL: CRON_TZ=Asia/Jakarta missing from canonical schedule');
    process.exit(1);
  }

  const window_ = checkForbiddenWindow(lines);
  const double = checkDoubleScheduling(lines);
  const violations = [...window_.violations, ...double];

  let entries = 0;
  for (const line of lines) { if (parseCronLine(line)) entries += 1; }

  console.log('[validate-schedule] canonical file: deploy/vps/final-schedule.cron');
  console.log('[validate-schedule] parsed entries: ' + entries);
  console.log('[validate-schedule] forbidden window (WIB): 23:50-00:10 (quota jobs must not start inside)');

  for (const w of window_.warnings) {
    console.log('[validate-schedule] WARN  line ' + w.line + ' (' + w.job + '): ' + w.reason);
  }
  for (const v of violations) {
    console.log('[validate-schedule] FAIL  line ' + v.line + ' (' + v.job + '): ' + v.reason);
    if (v.raw) console.log('    > ' + v.raw);
  }

  if (violations.length > 0) {
    console.log('[validate-schedule] RESULT: INVALID — ' + violations.length + ' violation(s)');
    process.exit(1);
  }
  console.log('[validate-schedule] RESULT: VALID — 0 violations (' + (window_.warnings.length) + ' warning(s))');
  process.exit(0);
}

main();

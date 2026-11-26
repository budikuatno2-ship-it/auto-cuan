'use strict';

/**
 * lib/v6-production-job-adapters.cjs
 *
 * Production single-cycle executor invoked ONLY when AUTO_CUAN_DISPATCHER_REALM=PRODUCTION.
 * Separate from lib/v6-scheduler-adapters.cjs so offline tests keep their strict
 * zero-child-process / zero-network / zero-production-DB contract.
 *
 * Safety contracts:
 *  - Exclusive file lock prevents overlapping cron runs.
 *  - Paid Arjum jobs check: (1) forbidden window 23:50-00:10 WIB, (2) remaining > 50,
 *    (3) reserve floor + killSwitch + pausedServices, (4) canary BBCA before batch.
 *  - Telegram recap refuses fail-closed unless admin schedule job.telegram.enabled === true
 *    AND TELEGRAM_ENABLED === '1' AND TELEGRAM_LIVE === 'true'.
 *  - Writes per-job heartbeats to data/job-heartbeat/<jobKey>.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const store = require('./admin-schedule-store');
const engine = require('./admin-schedule-engine');
const quotaState = require('./quota-state');
const calendar = require('./idx-trading-calendar');

const PAID_JOBS = new Set(['broksum-all', 'broksum-foreign', 'insider', 'fundamental', 'quota-backfill']);
const MIN_QUOTA_STOP_BUFFER = 50;

function atomicWriteJson(fp, value) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, fp);
}

function readJsonSafe(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return fallback; }
}

function writeHeartbeat(rootDir, jobKey, outcome, exitCode, detail) {
  try {
    const fp = path.join(rootDir, 'data', 'job-heartbeat', jobKey + '.json');
    atomicWriteJson(fp, {
      jobName: jobKey,
      updatedAt: new Date().toISOString(),
      exitCode: Number.isInteger(exitCode) ? exitCode : 0,
      outcome,
      status: outcome === 'SUCCESS' ? 'OK' : outcome,
      lastErrorSnippet: outcome === 'FAILED' ? String(detail || '').slice(0, 200) : ''
    });
  } catch (_) {}
}

function evaluatePaidJobGuard(jobKey, now, opts = {}) {
  const qs = opts.quotaState || quotaState;
  const cfg = typeof qs.loadConfig === 'function' ? qs.loadConfig() : {};
  if (cfg.killSwitch === true) {
    return { allowed: false, reason: 'BLOCKED_KILL_SWITCH', remaining: null };
  }
  const paused = cfg.pausedServices || {};
  if (paused.all === true || paused[jobKey] === true || (jobKey.startsWith('broksum') && paused.broksum === true)) {
    return { allowed: false, reason: 'BLOCKED_SERVICE_PAUSED', remaining: null };
  }
  if (typeof qs.isInForbiddenWindow === 'function' && qs.isInForbiddenWindow(now)) {
    return { allowed: false, reason: 'BLOCKED_FORBIDDEN_WINDOW', remaining: null };
  }
  const snap = typeof qs.getQuotaSnapshot === 'function' ? qs.getQuotaSnapshot(now) : null;
  if (!snap || snap.remaining == null || !Number.isFinite(Number(snap.remaining))) {
    return { allowed: false, reason: 'BLOCKED_QUOTA_UNKNOWN', remaining: null };
  }
  const remaining = Number(snap.remaining);
  if (remaining <= MIN_QUOTA_STOP_BUFFER) {
    return { allowed: false, reason: 'BLOCKED_QUOTA_BUFFER', remaining, buffer: MIN_QUOTA_STOP_BUFFER };
  }
  if (typeof qs.canConsumeQuota === 'function') {
    const decision = qs.canConsumeQuota(1, jobKey, now);
    if (!decision || decision.allowed !== true) {
      return { allowed: false, reason: (decision && decision.reason) || 'BLOCKED_QUOTA_POLICY', remaining };
    }
  }
  return { allowed: true, reason: 'READY', remaining };
}

function buildProductionCommandMap(rootDir) {
  const nodeBin = process.execPath;
  const vpsDir = path.join(rootDir, 'deploy', 'vps');
  return {
    'yahoo-ohlcv': [{ cmd: 'bash', args: [path.join(vpsDir, 'run-daily-candles.sh')], timeout: 1500000 }],
    'ihsg': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'fetch-ihsg-candle.js'), '--range=2y'], timeout: 300000 }],
    'prewarm-cache': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'prewarm-daily-cache.js')], timeout: 300000 }],
    'lifecycle': [{ cmd: 'bash', args: [path.join(vpsDir, 'run-lifecycle-evaluator.sh'), '--apply'], timeout: 600000 }],
    'market-context': [{ cmd: 'bash', args: [path.join(vpsDir, 'run-daily-market-context-collector.sh')], timeout: 900000 }],
    'sector-hot': [
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'regenerate-local-snapshots.js')], timeout: 600000 },
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'prewarm-daily-cache.js')], timeout: 300000 }
    ],
    'broksum-all': [
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'run-daily-broker-update.js'), '--tickers=BBCA'], timeout: 120000 },
      { cmd: 'bash', args: [path.join(vpsDir, 'run-daily-market-update.sh'), '--accum-source=api', '--insider-mode=daily'], timeout: 1800000 }
    ],
    'broksum-foreign': [
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'run-daily-broker-update.js'), '--tickers=BBCA', '--final'], timeout: 120000 },
      { cmd: 'bash', args: [path.join(vpsDir, 'run-daily-market-update.sh'), '--final', '--accum-source=api', '--insider-mode=daily'], timeout: 900000 }
    ],
    'insider': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'collect-insider-data.js'), '--tiered', '--floor', '5000'], timeout: 1500000 }],
    'domestic-compile': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'build-domestic-broksum-and-accum.js'), '--apply', '--force'], timeout: 600000 }],
    'accumulation': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'build-domestic-broksum-and-accum.js'), '--apply', '--skip-hunter'], timeout: 600000 }],
    'bandarmologi': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'run-bandarmologi-intel.js')], timeout: 600000 }],
    'top20': [
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'regenerate-local-snapshots.js')], timeout: 300000 },
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'prewarm-daily-cache.js')], timeout: 300000 },
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'direct-refresh-landing.js')], timeout: 120000 }
    ],
    'top5': [
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'run-after-market-top5-lock.js')], timeout: 300000 },
      { cmd: nodeBin, args: [path.join(rootDir, 'tools', 'direct-refresh-landing.js')], timeout: 300000 }
    ],
    'telegram': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'run-daily-afternoon-recap.js'), '--send'], timeout: 300000 }],
    'fundamental': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'run-fundamental-refresh.js'), '--batch=20', '--apply', '--floor', '5000'], timeout: 1200000 }],
    'quota-backfill': [{ cmd: nodeBin, args: [path.join(rootDir, 'tools', 'quota-burn.js'), '--floor', '5000', '--batch=25'], timeout: 2400000 }]
  };
}

const STALE_RUNNING_MAX_MS = 10 * 60 * 1000;

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 1) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function reapStaleRunningJobs(state, opts = {}) {
  if (!state || !state.jobs || typeof state.jobs !== 'object') return [];
  const nowMs = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  const maxRunningMs = opts.maxRunningMs != null ? Number(opts.maxRunningMs) : STALE_RUNNING_MAX_MS;
  const reaped = [];
  for (const [key, entry] of Object.entries(state.jobs)) {
    if (!entry || entry.status !== 'RUNNING') continue;
    const startedMs = entry.startedAt ? Date.parse(entry.startedAt) : NaN;
    const elapsedMs = Number.isFinite(startedMs) ? (nowMs - startedMs) : Infinity;
    const pidDead = entry.pid != null ? !isPidAlive(entry.pid) : false;
    if (elapsedMs > maxRunningMs || pidDead) {
      const nextStatus = elapsedMs > maxRunningMs ? 'TIMED_OUT' : 'FAILED';
      const nowIso = new Date(nowMs).toISOString();
      state.jobs[key] = Object.assign({}, entry, {
        status: nextStatus,
        finishedAt: entry.finishedAt || nowIso,
        reapedAt: nowIso,
        detail: pidDead ? 'stale_running_dead_pid_reaped' : 'stale_running_timeout_reaped'
      });
      reaped.push({ key, previousStatus: 'RUNNING', status: nextStatus });
    }
  }
  return reaped;
}

function defaultExecutor(steps, rootDir) {
  for (const step of steps) {
    const res = spawnSync(step.cmd, step.args, {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: step.timeout || 600000,
      env: process.env
    });
    if (res.status !== 0) {
      return { ok: false, exitCode: res.status || 1, detail: String(res.stderr || res.stdout || '').slice(-300) };
    }
  }
  return { ok: true, exitCode: 0, detail: 'OK' };
}

async function runProductionCycle(opts = {}) {
  const rootDir = opts.rootDir || ROOT;
  const stateDir = opts.stateDir || process.env.AUTO_CUAN_V6_DISPATCHER_STATE_DIR || '/home/ubuntu/auto-cuan-data/v6-dispatcher-state';
  const statePath = path.join(stateDir, 'production-worker.json');
  const lockPath = path.join(stateDir, 'production.lock');
  const now = opts.now instanceof Date ? opts.now : new Date();
  const executor = opts.executor || ((steps) => defaultExecutor(steps, rootDir));

  fs.mkdirSync(stateDir, { recursive: true });
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockFd, String(process.pid));
  } catch (err) {
    try {
      const st = fs.statSync(lockPath);
      const lockPid = Number(String(fs.readFileSync(lockPath, 'utf8') || '').trim() || 0);
      const lockDead = lockPid > 1 && !isPidAlive(lockPid);
      if (Date.now() - st.mtimeMs > STALE_RUNNING_MAX_MS || lockDead) {
        fs.unlinkSync(lockPath);
        lockFd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockFd, String(process.pid));
      } else {
        return { status: 'LOCKED', realm: 'PRODUCTION', ran: [], blocked: [] };
      }
    } catch (_) {
      return { status: 'LOCKED', realm: 'PRODUCTION', ran: [], blocked: [] };
    }
  }

  let activeRunningKey = null;
  let signalCleanup = null;
  const markInterruptedAndExit = (sig) => {
    try {
      if (activeRunningKey) {
        const curState = readJsonSafe(statePath, { schemaVersion: 1, realm: 'PRODUCTION', jobs: {} });
        if (curState && curState.jobs && curState.jobs[activeRunningKey] && curState.jobs[activeRunningKey].status === 'RUNNING') {
          curState.jobs[activeRunningKey] = Object.assign({}, curState.jobs[activeRunningKey], {
            status: 'TIMED_OUT',
            finishedAt: new Date().toISOString(),
            detail: 'interrupted_by_' + String(sig || 'SIGTERM')
          });
          atomicWriteJson(statePath, curState);
        }
      }
    } catch (_) {}
    try { if (lockFd != null) fs.closeSync(lockFd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onSigTerm = () => markInterruptedAndExit('SIGTERM');
  const onSigInt = () => markInterruptedAndExit('SIGINT');
  if (opts.installSignalTrap !== false) {
    process.on('SIGTERM', onSigTerm);
    process.on('SIGINT', onSigInt);
    signalCleanup = () => {
      try { process.removeListener('SIGTERM', onSigTerm); } catch (_) {}
      try { process.removeListener('SIGINT', onSigInt); } catch (_) {}
    };
  }

  try {
    const schedule = opts.schedule || store.get();
    if (!schedule || !schedule.ok || !schedule.doc || !schedule.doc.jobs) {
      return { status: 'SCHEDULE_UNKNOWN', realm: 'PRODUCTION', ran: [], blocked: [] };
    }
    const date = engine.jakartaDateKey(now);
    const holidaySet = new Set([...(calendar.getSeedHolidaySet ? calendar.getSeedHolidaySet() : []), ...(opts.holidays || [])]);
    const quotaCfg = typeof quotaState.loadConfig === 'function' ? quotaState.loadConfig() : {};
    if (quotaCfg.holidayManualMode === 'libur' && quotaCfg.holidayManualDateWIB === date) {
      holidaySet.add(date);
    }

    const state = readJsonSafe(statePath, { schemaVersion: 1, realm: 'PRODUCTION', jobs: {} });
    state.realm = 'PRODUCTION';
    if (!state.jobs || typeof state.jobs !== 'object') state.jobs = {};
    const reapedJobs = reapStaleRunningJobs(state, { nowMs: now.getTime(), maxRunningMs: opts.maxRunningMs });
    if (reapedJobs.length > 0) {
      atomicWriteJson(statePath, state);
    }

    const commandMap = opts.commandMap || buildProductionCommandMap(rootDir);
    const orderedJobs = store.JOB_CATALOG
      .map((def) => Object.assign({}, schedule.doc.jobs[def.key] || {}, { key: def.key, legacy_inactive: def.legacy_inactive === true }))
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));

    const ran = [];
    const blocked = [];

    for (const job of orderedJobs) {
      if (job.legacy_inactive || job.enabled !== true) continue;
      if (job.key === 'telegram') {
        if (process.env.TELEGRAM_ENABLED !== '1' || process.env.TELEGRAM_LIVE !== 'true') {
          blocked.push({ job: job.key, reason: 'SKIPPED_TELEGRAM_DISABLED' });
          writeHeartbeat(rootDir, job.key, 'SKIPPED', 0, 'TELEGRAM_ENV_OFF');
          continue;
        }
      }

      const slot = engine.computeTodaySlot(job, now, holidaySet);
      if (!slot || slot > now) continue;

      const key = date + '/' + job.key;
      const prior = state.jobs[key];
      if (prior && prior.status === 'DONE') continue;

      const retryWindowMs = Math.max(5, Number(job.retryWindowMinutes || 15)) * 60 * 1000;
      if (now.getTime() - slot.getTime() > retryWindowMs) {
        if (!prior) {
          state.jobs[key] = { job: job.key, date, status: 'MISSED', observedAt: now.toISOString() };
          atomicWriteJson(statePath, state);
        }
        blocked.push({ job: job.key, reason: 'MISSED_RETRY_WINDOW' });
        continue;
      }

      const missingDep = (job.dependsOn || []).find((dep) => {
        const depState = state.jobs[date + '/' + dep];
        return !depState || depState.status !== 'DONE';
      });
      if (missingDep) {
        blocked.push({ job: job.key, reason: 'DEPENDENCY_BLOCKED', dependency: missingDep });
        continue;
      }

      if (PAID_JOBS.has(job.key)) {
        let guard = evaluatePaidJobGuard(job.key, now, { quotaState: opts.quotaState });
        if (!guard.allowed && guard.reason === 'BLOCKED_QUOTA_UNKNOWN' && !opts.quotaState) {
          try {
            const { syncQuotaState } = require('../tools/sync-quota-state');
            syncQuotaState();
            guard = evaluatePaidJobGuard(job.key, now, { quotaState: opts.quotaState });
          } catch (_) {}
        }
        if (!guard.allowed) {
          blocked.push({ job: job.key, reason: guard.reason, remaining: guard.remaining });
          writeHeartbeat(rootDir, job.key, 'BLOCKED', 4, guard.reason);
          continue;
        }
      }

      const steps = commandMap[job.key];
      if (!steps || !steps.length) continue;

      activeRunningKey = key;
      state.jobs[key] = { job: job.key, date, status: 'RUNNING', startedAt: now.toISOString(), pid: process.pid };
      atomicWriteJson(statePath, state);

      const execRes = executor(steps, job);
      activeRunningKey = null;
      if (execRes && execRes.ok) {
        state.jobs[key] = { job: job.key, date, status: 'DONE', finishedAt: new Date().toISOString() };
        atomicWriteJson(statePath, state);
        writeHeartbeat(rootDir, job.key, 'SUCCESS', 0, 'OK');
        ran.push({ job: job.key });
      } else {
        state.jobs[key] = { job: job.key, date, status: 'FAILED', finishedAt: new Date().toISOString(), detail: execRes && execRes.detail };
        atomicWriteJson(statePath, state);
        writeHeartbeat(rootDir, job.key, 'FAILED', (execRes && execRes.exitCode) || 1, execRes && execRes.detail);
        blocked.push({ job: job.key, reason: 'EXEC_FAILED', detail: execRes && execRes.detail });
      }
    }

    return {
      status: 'OK',
      realm: 'PRODUCTION',
      date,
      scheduleVersion: schedule.doc.version,
      ran,
      blocked
    };
  } finally {
    if (signalCleanup) signalCleanup();
    try { if (lockFd != null) fs.closeSync(lockFd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

module.exports = {
  PAID_JOBS,
  MIN_QUOTA_STOP_BUFFER,
  STALE_RUNNING_MAX_MS,
  isPidAlive,
  reapStaleRunningJobs,
  evaluatePaidJobGuard,
  buildProductionCommandMap,
  runProductionCycle
};

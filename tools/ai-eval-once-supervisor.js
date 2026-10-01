'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = process.env.AUTO_CUAN_ROOT || '/home/ubuntu/auto-cuan';
const WORK_DIR = path.resolve(process.env.AI_EVAL_WORK_DIR || '/home/ubuntu/auto-cuan-ai-eval');
const POLL_MS = Math.max(5000, Math.min(60000, Number(process.env.AI_EVAL_SUPERVISOR_POLL_MS) || 10000));
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ENV_FILE = process.env.AI_EVAL_ENV_FILE || '/home/ubuntu/auto-cuan/.env.ai-eval-once';

let child = null;
let activeRunId = null;
let stopping = false;
let stopTimer = null;
let stopDesiredState = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(value) { try { return JSON.parse(value); } catch (_) { return null; } }
function boundedInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function safeDatasetPath(value) {
  if (!value) return null;
  const candidate = path.resolve(String(value));
  if (!candidate.startsWith(WORK_DIR + path.sep)) return null;
  if (!candidate.endsWith('.jsonl.gz')) return null;
  return candidate;
}
function desiredStateStopsWorker(value) {
  return ['PAUSED', 'STOPPED'].includes(String(value || '').toUpperCase());
}

function runtimeEnvForRun(run) {
  const row = run && typeof run === 'object' ? run : {};
  const config = row.config && typeof row.config === 'object' ? row.config : {};
  const dataset = safeDatasetPath(row.dataset_manifest_path);
  if (config.run_kind === 'failed_retry') {
    if (!dataset) throw new Error('Retry dataset path tidak aman atau tidak valid.');
    if (!fs.existsSync(dataset)) throw new Error('Retry dataset tidak ditemukan: ' + dataset);
  }
  const env = {
    AI_EVAL_ENV_FILE: ENV_FILE,
    AI_EVAL_RUN_ID: String(row.id || ''),
    AI_EVAL_RUN_MODEL: String(row.model || ''),
    AI_EVAL_RUN_CASE_TARGET: String(boundedInt(row.cases_target, 1000000, 1, 1000000)),
    AI_EVAL_RUN_TOKEN_BUDGET: String(boundedInt(row.token_budget, 50000000, 1000, 1000000000)),
    AI_EVAL_RUN_RPM: String(boundedInt(row.max_rpm, 30, 1, 600)),
    AI_EVAL_RUN_CONCURRENCY: String(boundedInt(row.concurrency, 4, 1, 32)),
    AI_EVAL_RUN_MAX_ATTEMPTS_PER_CASE: String(boundedInt(config.max_attempts_per_case, 3, 1, 10))
  };
  if (dataset) env.AI_EVAL_RUN_DATASET_GZ = dataset;
  return env;
}

async function request(pathname, options) {
  const response = await fetch(SUPABASE_URL + pathname, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      ...(options && options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error('Supabase ' + response.status + ': ' + text.slice(0, 500));
  return text ? safeJson(text) || text : null;
}

async function latestRun() {
  const select = [
    'id','name','desired_state','status','model','tokens_used','token_budget',
    'cases_completed','cases_target','max_rpm','concurrency','dataset_manifest_path',
    'config','started_at','created_at','updated_at'
  ].join(',');
  const rows = await request('/rest/v1/ai_eval_runs?select=' + encodeURIComponent(select) + '&order=created_at.desc&limit=1', { method: 'GET' });
  return Array.isArray(rows) && rows[0] || null;
}

async function patchRun(id, values) {
  return request('/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(values)
  });
}

async function claimRun(id) {
  const result = await request('/rest/v1/rpc/claim_ai_eval_run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_run_id: id })
  });
  return result === true;
}

function clearStopState() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  stopping = false;
  stopDesiredState = null;
}

function terminateChild(desiredState) {
  if (!child || stopping) return false;
  const target = child;
  stopping = true;
  stopDesiredState = String(desiredState || '').toUpperCase();
  console.log('ai-eval child termination requested', JSON.stringify({
    run_id: activeRunId,
    desired_state: stopDesiredState
  }));
  target.kill('SIGTERM');
  stopTimer = setTimeout(() => {
    if (child === target) target.kill('SIGKILL');
  }, 30000);
  stopTimer.unref();
  return true;
}

function startRun(run) {
  if (child) return;
  const runEnv = runtimeEnvForRun(run);
  const runId = String(run.id);
  activeRunId = runId;
  const launcher = path.join(ROOT_DIR, 'tools/run-ai-eval-once.sh');
  const launched = spawn('/usr/bin/env', ['bash', launcher, '--run-id=' + runId], {
    cwd: ROOT_DIR,
    env: { ...process.env, ...runEnv },
    stdio: 'inherit'
  });
  child = launched;

  launched.once('exit', (code, signal) => {
    const requestedState = stopDesiredState;
    console.log('ai-eval child exited', JSON.stringify({ run_id: runId, code, signal, requested_state: requestedState }));
    if (child === launched) {
      child = null;
      activeRunId = null;
    }
    clearStopState();

    if (requestedState === 'PAUSED') {
      patchRun(runId, {
        status: 'PAUSED',
        last_heartbeat_at: new Date().toISOString()
      }).catch((error) => console.error('ai-eval pause finalization failed', error.message));
    } else if (requestedState === 'STOPPED') {
      patchRun(runId, {
        desired_state: 'STOPPED',
        status: 'STOPPED',
        finished_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString()
      }).catch((error) => console.error('ai-eval stop finalization failed', error.message));
    }
  });

  launched.once('error', (error) => {
    console.error('ai-eval child spawn error', error.message);
    if (child === launched) {
      child = null;
      activeRunId = null;
    }
    clearStopState();
    patchRun(runId, { status: 'FAILED', last_error: error.message, finished_at: new Date().toISOString() }).catch(() => {});
  });
}

async function tick() {
  const run = await latestRun();
  if (!run) return;

  if (child && activeRunId === String(run.id)) {
    if (desiredStateStopsWorker(run.desired_state)) terminateChild(run.desired_state);
    return;
  }

  if (child) return;
  if (run.desired_state !== 'RUNNING') return;
  if (['COMPLETED','STOPPED','FAILED','BLOCKED'].includes(run.status)) return;

  try {
    runtimeEnvForRun(run);
  } catch (error) {
    await patchRun(run.id, {
      desired_state: 'STOPPED',
      status: 'BLOCKED',
      last_error: String(error.message || error).slice(0, 1000),
      finished_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString()
    });
    return;
  }

  // The database transition is the distributed lock. Exactly one supervisor
  // can move an eligible row to a fresh STARTING lease; concurrent supervisors
  // receive false and must not spawn a duplicate worker. A stale STARTING/
  // RUNNING lease can be reclaimed by the RPC after its safety window.
  const claimed = await claimRun(run.id);
  if (!claimed) return;
  startRun(run);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.');
  console.log('AI_EVAL_SUPERVISOR=READY');
  console.log('POLL_MS=' + POLL_MS);
  while (true) {
    try { await tick(); }
    catch (error) { console.error('ai-eval supervisor tick failed', error.message); }
    await sleep(POLL_MS);
  }
}

process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = {
  latestRun,
  patchRun,
  claimRun,
  safeDatasetPath,
  runtimeEnvForRun,
  desiredStateStopsWorker,
  terminateChild
};
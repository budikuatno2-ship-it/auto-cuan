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

function startRun(run) {
  if (child) return;
  const runEnv = runtimeEnvForRun(run);
  activeRunId = String(run.id);
  const launcher = path.join(ROOT_DIR, 'tools/run-ai-eval-once.sh');
  child = spawn('/usr/bin/env', ['bash', launcher, '--run-id=' + activeRunId], {
    cwd: ROOT_DIR,
    env: { ...process.env, ...runEnv },
    stdio: 'inherit'
  });
  child.once('exit', (code, signal) => {
    console.log('ai-eval child exited', JSON.stringify({ run_id: activeRunId, code, signal }));
    child = null;
    activeRunId = null;
  });
  child.once('error', (error) => {
    console.error('ai-eval child spawn error', error.message);
    patchRun(activeRunId, { status: 'FAILED', last_error: error.message, finished_at: new Date().toISOString() }).catch(() => {});
    child = null;
    activeRunId = null;
  });
}

async function tick() {
  const run = await latestRun();
  if (!run) return;

  if (child && activeRunId === String(run.id)) {
    if (run.desired_state === 'STOPPED' && !stopping) {
      stopping = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child) child.kill('SIGKILL');
        stopping = false;
      }, 30000).unref();
    }
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

  await patchRun(run.id, {
    status: 'STARTING',
    last_error: null,
    started_at: run.started_at || new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString()
  });
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

module.exports = { latestRun, patchRun, safeDatasetPath, runtimeEnvForRun };

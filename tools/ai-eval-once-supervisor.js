'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = process.env.AUTO_CUAN_ROOT || '/home/ubuntu/auto-cuan';
const POLL_MS = Math.max(5000, Math.min(60000, Number(process.env.AI_EVAL_SUPERVISOR_POLL_MS) || 10000));
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ENV_FILE = process.env.AI_EVAL_ENV_FILE || '/home/ubuntu/auto-cuan/.env.ai-eval-once';

let child = null;
let activeRunId = null;
let stopping = false;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(value) { try { return JSON.parse(value); } catch (_) { return null; } }

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
    'cases_completed','created_at','updated_at'
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
  activeRunId = String(run.id);
  const launcher = path.join(ROOT_DIR, 'tools/run-ai-eval-once.sh');
  child = spawn('/usr/bin/env', ['bash', launcher, '--run-id=' + activeRunId], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      AI_EVAL_ENV_FILE: ENV_FILE,
      AI_EVAL_RUN_ID: activeRunId
    },
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

module.exports = { latestRun, patchRun };

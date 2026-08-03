#!/usr/bin/env node
'use strict';

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

async function request(url, key, pathname, options) {
  const response = await fetch(String(url).replace(/\/+$/, '') + pathname, {
    ...options,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      ...(options && options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error('Supabase ' + response.status + ': ' + text.slice(0, 500));
  return text ? safeJson(text) || text : null;
}

async function fetchRun(url, key, id) {
  const rows = await request(
    url,
    key,
    '/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(id) + '&select=*',
    { method: 'GET' }
  );
  return Array.isArray(rows) && rows[0] || null;
}

function transition(run, action) {
  if (!run || typeof run !== 'object') throw new Error('Run tidak ditemukan.');
  const status = String(run.status || '');
  const desired = String(run.desired_state || '');
  const tokensUsed = Number(run.tokens_used) || 0;
  const tokenBudget = Number(run.token_budget) || 0;

  if (action === 'status') return null;

  if (action === 'start' || action === 'resume') {
    if (status === 'COMPLETED') throw new Error('Run COMPLETED tidak dapat dimulai ulang.');
    if (tokenBudget > 0 && tokensUsed >= tokenBudget) throw new Error('Token budget run sudah habis.');
    if (status === 'BLOCKED') throw new Error('Run BLOCKED harus diaudit sebelum dimulai.');
    return {
      desired_state: 'RUNNING',
      status: ['STOPPED','FAILED'].includes(status) ? 'PAUSED' : status,
      finished_at: null,
      last_error: ['FAILED'].includes(status) ? null : run.last_error || null
    };
  }

  if (action === 'pause') {
    if (['COMPLETED','STOPPED','BLOCKED'].includes(status)) return null;
    if (desired === 'PAUSED') return null;
    return { desired_state: 'PAUSED' };
  }

  if (action === 'stop') {
    if (status === 'COMPLETED') return null;
    if (status === 'STOPPED' && desired === 'STOPPED') return null;
    return {
      desired_state: 'STOPPED',
      status: status === 'CREATED' ? 'STOPPED' : status,
      finished_at: status === 'CREATED' ? new Date().toISOString() : run.finished_at || null
    };
  }

  throw new Error('Action harus status, start, resume, pause, atau stop.');
}

function publicRun(run) {
  if (!run) return null;
  const budget = Number(run.token_budget) || 0;
  const used = Number(run.tokens_used) || 0;
  return {
    id: String(run.id),
    name: run.name || null,
    desired_state: run.desired_state,
    status: run.status,
    model: run.model || null,
    cases_target: Number(run.cases_target) || 0,
    cases_attempted: Number(run.cases_attempted) || 0,
    cases_completed: Number(run.cases_completed) || 0,
    cases_passed: Number(run.cases_passed) || 0,
    cases_failed_eval: Number(run.cases_failed_eval) || 0,
    provider_failures: Number(run.provider_failures) || 0,
    retries: Number(run.retries) || 0,
    token_budget: budget,
    tokens_used: used,
    tokens_remaining: Math.max(0, budget - used),
    current_shard: Number(run.current_shard) || 0,
    last_error: run.last_error || null,
    last_heartbeat_at: run.last_heartbeat_at || null,
    started_at: run.started_at || null,
    finished_at: run.finished_at || null,
    updated_at: run.updated_at || null,
    config: run.config && typeof run.config === 'object' ? {
      run_kind: run.config.run_kind || null,
      source_run_id: run.config.source_run_id || null,
      retry_scope: run.config.retry_scope || null,
      derived_facts_version: run.config.derived_facts_version || null,
      retry_case_count: Number(run.config.retry_case_count) || null
    } : null
  };
}

async function control(options) {
  const config = options || {};
  const url = config.supabaseUrl;
  const key = config.supabaseKey;
  const runId = String(config.runId || '').trim();
  const action = String(config.action || 'status').trim().toLowerCase();
  if (!url || !key) throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.');
  if (!runId) throw new Error('--run-id wajib diisi.');

  let run = await fetchRun(url, key, runId);
  if (!run) throw new Error('Run tidak ditemukan: ' + runId);
  const patch = transition(run, action);
  if (patch) {
    const rows = await request(url, key, '/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(runId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    });
    run = Array.isArray(rows) && rows[0] || null;
    if (!run) throw new Error('Perubahan state run tidak terkonfirmasi.');
  }
  return { action, changed: Boolean(patch), run: publicRun(run) };
}

async function main() {
  const result = await control({
    runId: arg('run-id', ''),
    action: arg('action', 'status'),
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  });
  process.stdout.write(JSON.stringify({ success: true, ...result }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('FATAL: ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { fetchRun, transition, publicRun, control };

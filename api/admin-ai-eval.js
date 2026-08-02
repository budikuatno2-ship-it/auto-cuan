'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');

const RUN_NAME = 'one-time-ai-data-20260803';
const MODEL = 'claude-sonnet-4.6';
const BASE_URL = 'https://openagentic.id/api/v1';
const TOKEN_BUDGET = 50000000;
const CASE_TARGET = 1000000;
const RPM = 30;
const CONCURRENCY = 4;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function adminAccess(req) {
  if (!isSameOrigin(req)) return { ok: false, status: 403, error: 'Permintaan ditolak.' };
  const auth = requireAdminSession(req);
  if (!auth.ok) return auth;
  if (String(auth.session.un || '').trim().toLowerCase() !== 'budi') {
    return { ok: false, status: 403, error: 'Akses admin ditolak.' };
  }
  return { ok: true, auth };
}

function publicRun(row) {
  if (!row) return null;
  const budget = Number(row.token_budget) || TOKEN_BUDGET;
  const used = Number(row.tokens_used) || 0;
  const target = Number(row.cases_target) || CASE_TARGET;
  const completed = Number(row.cases_completed) || 0;
  return {
    id: String(row.id),
    name: row.name,
    desired_state: row.desired_state,
    status: row.status,
    model: row.model,
    base_url: BASE_URL,
    max_rpm: Number(row.max_rpm) || RPM,
    concurrency: Number(row.concurrency) || CONCURRENCY,
    token_budget: budget,
    tokens_used: used,
    tokens_remaining: Math.max(0, budget - used),
    token_progress_pct: budget ? Number((used / budget * 100).toFixed(4)) : 0,
    cases_target: target,
    cases_attempted: Number(row.cases_attempted) || 0,
    cases_completed: completed,
    cases_passed: Number(row.cases_passed) || 0,
    cases_failed_eval: Number(row.cases_failed_eval) || 0,
    provider_failures: Number(row.provider_failures) || 0,
    retries: Number(row.retries) || 0,
    current_shard: Number(row.current_shard) || 0,
    last_error: row.last_error || null,
    last_heartbeat_at: row.last_heartbeat_at || null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    one_time_only: true,
    raw_format: 'jsonl.gz',
    summary_format: 'md.gz'
  };
}

async function getRun(supabase) {
  const result = await supabase
    .from('ai_eval_runs')
    .select('*')
    .eq('name', RUN_NAME)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

async function createRun(supabase) {
  const insert = await supabase
    .from('ai_eval_runs')
    .insert({
      name: RUN_NAME,
      desired_state: 'RUNNING',
      status: 'CREATED',
      provider_kind: 'openai_compatible',
      model: MODEL,
      dataset_manifest_path: '/home/ubuntu/auto-cuan-ai-eval/dataset-1m.jsonl.gz',
      cases_target: CASE_TARGET,
      max_rpm: RPM,
      concurrency: CONCURRENCY,
      token_budget: TOKEN_BUDGET,
      config: {
        base_url: BASE_URL,
        answer_style: 'gen_z_natural_professional',
        answer_evaluation: 'deterministic_plus_same_model_judge_every_case',
        retry_policy: 'retry_until_pass_budget_stop_or_manual_stop',
        stock_ratio_pct: 60,
        portfolio_ratio_pct: 40,
        one_time_only: true,
        raw_format: 'jsonl.gz',
        summary_format: 'md.gz'
      }
    })
    .select('*')
    .single();
  if (insert.error) throw insert.error;
  return insert.data;
}

async function setState(supabase, row, action) {
  if (action === 'start' || action === 'resume') {
    if (row.status === 'COMPLETED') {
      const error = new Error('Uji satu kali ini sudah selesai dan tidak dapat dimulai ulang.');
      error.status = 409;
      throw error;
    }
    if (Number(row.tokens_used) >= Number(row.token_budget)) {
      const error = new Error('Budget 50 juta token sudah habis.');
      error.status = 409;
      throw error;
    }
    const recoverableStatus = ['STOPPED','FAILED','BLOCKED'].includes(row.status) ? 'PAUSED' : row.status;
    const result = await supabase
      .from('ai_eval_runs')
      .update({ desired_state: 'RUNNING', status: recoverableStatus, finished_at: null })
      .eq('id', row.id)
      .select('*')
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  if (action === 'pause') {
    if (['COMPLETED','STOPPED'].includes(row.status)) return row;
    const result = await supabase
      .from('ai_eval_runs')
      .update({ desired_state: 'PAUSED' })
      .eq('id', row.id)
      .select('*')
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  if (action === 'stop') {
    if (row.status === 'COMPLETED') return row;
    const result = await supabase
      .from('ai_eval_runs')
      .update({ desired_state: 'STOPPED', status: row.status === 'CREATED' ? 'STOPPED' : row.status })
      .eq('id', row.id)
      .select('*')
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  const error = new Error('Aksi tidak dikenal.');
  error.status = 400;
  throw error;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  const access = adminAccess(req);
  if (!access.ok) return res.status(access.status || 403).json({ success: false, error: access.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });

  try {
    if (req.method === 'GET') {
      const row = await getRun(supabase);
      return res.status(200).json({ success: true, run: publicRun(row), configuration: {
        model: MODEL,
        base_url: BASE_URL,
        max_rpm: RPM,
        concurrency: CONCURRENCY,
        token_budget: TOKEN_BUDGET,
        cases_target: CASE_TARGET,
        one_time_only: true
      } });
    }

    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    const action = String(req.body && req.body.action || '').trim().toLowerCase();
    let row = await getRun(supabase);

    if (!row && (action === 'start' || action === 'resume')) row = await createRun(supabase);
    else if (!row) return res.status(404).json({ success: false, error: 'Run satu kali belum dibuat.' });
    else row = await setState(supabase, row, action);

    return res.status(200).json({ success: true, run: publicRun(row) });
  } catch (error) {
    console.error('admin-ai-eval error', error && error.message);
    return res.status(error.status || 500).json({ success: false, error: error.message || 'Kontrol AI evaluation gagal.' });
  }
};

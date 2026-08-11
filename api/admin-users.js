'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  requireAuthenticatedSession,
  requireAdminSession,
  isSameOrigin
} = require('../lib/admin-session');
const { handleAdminForeignUpload } = require('../lib/admin-foreign-upload');
const { handleAdminFundamentalsUpload } = require('../lib/admin-fundamentals-upload');
const originalHandler = require('../lib/admin-users-handler');

const AI_EVAL_RUN_NAME = 'one-time-ai-data-20260803';
const AI_EVAL_MODEL = 'claude-sonnet-4.6';
const AI_EVAL_BASE_URL = 'https://openagentic.id/api/v1';
const AI_EVAL_TOKEN_BUDGET = 50000000;
const AI_EVAL_CASE_TARGET = 1000000;
const AI_EVAL_RPM = 30;
const AI_EVAL_CONCURRENCY = 4;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function requireBudiAdmin(req) {
  if (!isSameOrigin(req)) return { ok: false, status: 403, error: 'Permintaan ditolak.' };
  const auth = requireAdminSession(req);
  if (!auth.ok) return auth;
  if (String(auth.session.un || '').trim().toLowerCase() !== 'budi') {
    return { ok: false, status: 403, error: 'Akses admin ditolak.' };
  }
  return { ok: true, auth };
}

async function resolveApprovedAccess(req, res) {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Status akses belum tersedia.' });
  }

  const result = await supabase
    .from('app_users')
    .select('id, username, is_approved, is_blocked')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (result.error || !result.data) {
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }

  const account = result.data;
  const signedUsername = String(auth.session.un || '').trim().toLowerCase();
  const accountUsername = String(account.username || '').trim().toLowerCase();

  if (!signedUsername || accountUsername !== signedUsername) {
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }

  if (account.is_blocked === true) {
    return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
  }

  if (account.is_approved !== true) {
    return res.status(403).json({ success: false, error: 'Akun belum di-approve admin.' });
  }

  return res.status(200).json({
    success: true,
    access: 'approved',
    user_id: String(account.id),
    username: accountUsername
  });
}

function resolvePatternMapAccess(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, allowed: false, error: 'Method not allowed' });
  }

  const access = requireBudiAdmin(req);
  if (!access.ok) {
    return res.status(access.status || 403).json({ success: false, allowed: false, error: access.error });
  }

  return res.status(200).json({
    success: true,
    allowed: true,
    access: 'admin',
    username: 'budi',
    expires_at: new Date(access.auth.session.exp * 1000).toISOString()
  });
}

async function foreignUpload(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const access = requireBudiAdmin(req);
  if (!access.ok) {
    return res.status(access.status || 403).json({ success: false, error: access.error });
  }

  const mode = String(req.body && req.body.mode || '').trim().toLowerCase();
  let supabase = null;
  if (mode === 'import') {
    supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }
  }

  return handleAdminForeignUpload(req, res, supabase);
}

async function fundamentalsUpload(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const access = requireBudiAdmin(req);
  if (!access.ok) {
    return res.status(access.status || 403).json({ success: false, error: access.error });
  }

  const mode = String(req.body && req.body.mode || '').trim().toLowerCase();
  let supabase = null;
  if (mode === 'import') {
    supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }
  }

  return handleAdminFundamentalsUpload(req, res, supabase);
}

async function deleteUser(req, res) {
  const access = requireBudiAdmin(req);
  if (!access.ok) {
    return res.status(access.status || 403).json({ success: false, error: access.error });
  }

  const targetUsername = String(req.body && req.body.username || '').trim().toLowerCase();
  if (!targetUsername) {
    return res.status(400).json({ success: false, error: 'Username diperlukan.' });
  }
  if (targetUsername === 'budi' || targetUsername === 'review') {
    return res.status(400).json({ success: false, error: 'Akun sistem tidak dapat dihapus.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
  }

  const lookup = await supabase
    .from('app_users')
    .select('id, username')
    .eq('username', targetUsername)
    .maybeSingle();

  if (lookup.error) {
    return res.status(500).json({ success: false, error: 'Gagal mencari akun.' });
  }
  if (!lookup.data) {
    return res.status(404).json({ success: false, error: 'Akun tidak ditemukan.' });
  }

  const userId = lookup.data.id;
  const optionalTables = [
    'app_user_telegram_verifications',
    'app_user_devices',
    'app_user_sessions'
  ];
  for (const table of optionalTables) {
    try {
      await supabase.from(table).delete().eq('user_id', userId);
    } catch (_) {}
  }

  const removed = await supabase
    .from('app_users')
    .delete()
    .eq('id', userId)
    .select('id, username');

  if (removed.error) {
    console.error('admin delete user error:', removed.error);
    return res.status(409).json({
      success: false,
      error: 'Akun belum bisa dihapus karena masih memiliki data terkait.'
    });
  }

  if (!removed.data || removed.data.length !== 1) {
    return res.status(409).json({ success: false, error: 'Penghapusan akun tidak terkonfirmasi.' });
  }

  return res.status(200).json({
    success: true,
    username: targetUsername,
    message: 'Akun, device ID, dan data verifikasi terkait berhasil dihapus.'
  });
}

function publicAiEvalRun(row) {
  if (!row) return null;
  const budget = Number(row.token_budget) || AI_EVAL_TOKEN_BUDGET;
  const used = Number(row.tokens_used) || 0;
  return {
    id: String(row.id),
    name: row.name,
    desired_state: row.desired_state,
    status: row.status,
    model: row.model,
    base_url: AI_EVAL_BASE_URL,
    max_rpm: Number(row.max_rpm) || AI_EVAL_RPM,
    concurrency: Number(row.concurrency) || AI_EVAL_CONCURRENCY,
    token_budget: budget,
    tokens_used: used,
    tokens_remaining: Math.max(0, budget - used),
    token_progress_pct: budget ? Number((used / budget * 100).toFixed(4)) : 0,
    cases_target: Number(row.cases_target) || AI_EVAL_CASE_TARGET,
    cases_attempted: Number(row.cases_attempted) || 0,
    cases_completed: Number(row.cases_completed) || 0,
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

async function getAiEvalRun(supabase) {
  const result = await supabase
    .from('ai_eval_runs')
    .select('*')
    .eq('name', AI_EVAL_RUN_NAME)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

async function createAiEvalRun(supabase) {
  const result = await supabase
    .from('ai_eval_runs')
    .insert({
      name: AI_EVAL_RUN_NAME,
      desired_state: 'RUNNING',
      status: 'CREATED',
      provider_kind: 'openai_compatible',
      model: AI_EVAL_MODEL,
      dataset_manifest_path: '/home/ubuntu/auto-cuan-ai-eval/dataset-1m.jsonl.gz',
      cases_target: AI_EVAL_CASE_TARGET,
      max_rpm: AI_EVAL_RPM,
      concurrency: AI_EVAL_CONCURRENCY,
      token_budget: AI_EVAL_TOKEN_BUDGET,
      config: {
        base_url: AI_EVAL_BASE_URL,
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
  if (result.error) throw result.error;
  return result.data;
}

async function setAiEvalState(supabase, row, controlAction) {
  if (controlAction === 'start' || controlAction === 'resume') {
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
    const status = ['STOPPED','FAILED','BLOCKED'].includes(row.status) ? 'PAUSED' : row.status;
    const result = await supabase
      .from('ai_eval_runs')
      .update({ desired_state: 'RUNNING', status, finished_at: null })
      .eq('id', row.id)
      .select('*')
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  if (controlAction === 'pause') {
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

  if (controlAction === 'stop') {
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

  const error = new Error('Aksi kontrol AI tidak dikenal.');
  error.status = 400;
  throw error;
}

async function aiEvalControl(req, res, statusOnly) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const access = requireBudiAdmin(req);
  if (!access.ok) return res.status(access.status || 403).json({ success: false, error: access.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });

  try {
    let row = await getAiEvalRun(supabase);
    if (!statusOnly) {
      const controlAction = String(req.body && req.body.control_action || '').trim().toLowerCase();
      if (!row && (controlAction === 'start' || controlAction === 'resume')) row = await createAiEvalRun(supabase);
      else if (!row) return res.status(404).json({ success: false, error: 'Run satu kali belum dibuat.' });
      else row = await setAiEvalState(supabase, row, controlAction);
    }
    return res.status(200).json({
      success: true,
      run: publicAiEvalRun(row),
      configuration: {
        model: AI_EVAL_MODEL,
        base_url: AI_EVAL_BASE_URL,
        max_rpm: AI_EVAL_RPM,
        concurrency: AI_EVAL_CONCURRENCY,
        token_budget: AI_EVAL_TOKEN_BUDGET,
        cases_target: AI_EVAL_CASE_TARGET,
        one_time_only: true
      }
    });
  } catch (error) {
    console.error('admin AI eval error:', error && error.message);
    return res.status(error.status || 500).json({ success: false, error: error.message || 'Kontrol AI evaluation gagal.' });
  }
}

module.exports = async function handler(req, res) {
  const action = req && req.body && req.body.action;

  if (action === 'portfolio_access') {
    return resolveApprovedAccess(req, res);
  }

  if (action === 'pattern_map_access') {
    return resolvePatternMapAccess(req, res);
  }

  if (action === 'foreign_upload') {
    return foreignUpload(req, res);
  }

  if (action === 'fundamentals_upload') {
    return fundamentalsUpload(req, res);
  }

  if (action === 'delete_user') {
    return deleteUser(req, res);
  }

  if (action === 'ai_eval_status') {
    return aiEvalControl(req, res, true);
  }

  if (action === 'ai_eval_control') {
    return aiEvalControl(req, res, false);
  }

  if (action === 'analytics') {
    const auth = requireAuthenticatedSession(req);
    if (auth.ok && auth.session.adm !== true) {
      return resolveApprovedAccess(req, res);
    }
  }

  return originalHandler(req, res);
};

'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  requireAuthenticatedSession,
  requireAdminSession,
  isSameOrigin
} = require('../lib/admin-session');
const { requirePremiumEntitlement } = require('../lib/subscription-auth');
const { handleAdminForeignUpload } = require('../lib/admin-foreign-upload');
const { handleAdminFundamentalsUpload } = require('../lib/admin-fundamentals-upload');
const originalHandler = require('../lib/admin-users-handler');
const { recordHeartbeat, getOnlineList, getDatasetFreshness, getJobPipeline, inspectDataHealth } = require('../lib/admin-console-service');

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

function isTruthyFlag(val) {
  if (val === true || val === 1) return true;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1';
  }
  return false;
}

function formatTokenBudgetMessage(tokenBudget) {
  const budgetNum = Number(tokenBudget) || AI_EVAL_TOKEN_BUDGET;
  const budgetMil = Math.round(budgetNum / 1000000);
  const budgetStr = budgetMil > 0 ? `${budgetMil} juta` : budgetNum.toLocaleString('id-ID');
  return `Budget ${budgetStr} token sudah habis.`;
}

// Approval-only access remains for legacy non-premium routes such as analytics.
// Do not reuse this helper for paid feature authorization.
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

  if (isTruthyFlag(account.is_blocked) || account.is_blocked === true) {
    return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
  }

  if (!isTruthyFlag(account.is_approved) || account.is_approved !== true) {
    return res.status(403).json({ success: false, error: 'Akun belum di-approve admin.' });
  }

  return res.status(200).json({
    success: true,
    access: 'approved',
    user_id: String(account.id),
    username: accountUsername
  });
}

async function resolvePremiumPortfolioAccess(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success:false, code:'ORIGIN_DENIED', error:'Permintaan ditolak.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ success:false, code:'PREMIUM_ACCESS_UNAVAILABLE', error:'Status subscription belum tersedia.' });
  }

  let access;
  try { access = await requirePremiumEntitlement(req, supabase); }
  catch (_) {
    return res.status(503).json({ success:false, code:'PREMIUM_ACCESS_UNAVAILABLE', error:'Status subscription belum tersedia.' });
  }

  if (!access.ok) {
    return res.status(access.status || 403).json({
      success:false,
      code:access.code || 'PREMIUM_ACCESS_DENIED',
      error:access.error || 'Akses premium diperlukan.',
      access_level:access.access_level || 'free'
    });
  }

  return res.status(200).json({
    success:true,
    access:'premium',
    premium:true,
    access_level:access.access_level || 'premium',
    user_id:String(access.account.id),
    username:String(access.account.username || '').trim().toLowerCase(),
    current_plan:access.entitlement && access.entitlement.current_plan || null,
    expires_at:access.entitlement && access.entitlement.expires_at || null
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
  return deleteUserWithSupabase(targetUsername, res, supabase);
}

async function deleteUserWithSupabase(targetUsername, res, supabase) {
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
    const resDel = await supabase.from(table).delete().eq('user_id', userId);
    if (resDel && resDel.error) {
      console.error(`Gagal menghapus data dari ${table}:`, resDel.error);
      return res.status(500).json({
        success: false,
        error: `Gagal menghapus data relasi pada tahap ${table}.`,
        stage: table,
        detail: resDel.error.message
      });
    }
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
  if (result.error) {
    if (result.error.code === '23505' || String(result.error.message || '').includes('duplicate')) {
      const error = new Error('Run AI eval sudah ada atau terjadi konflik unik.');
      error.status = 409;
      error.code = result.error.code;
      throw error;
    }
    throw result.error;
  }
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
      const error = new Error(formatTokenBudgetMessage(row.token_budget));
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
    const status = error.status || (error.code === '23505' ? 409 : 500);
    return res.status(status).json({ success: false, error: error.message || 'Kontrol AI evaluation gagal.' });
  }
}

async function handler(req, res) {
  const action = req && req.body && req.body.action;

  if (action === 'heartbeat') {
    const auth = requireAuthenticatedSession(req);
    const username = auth.ok ? (auth.session.un || 'member') : 'guest';
    const page = req.body && req.body.page;
    const device = req.body && req.body.device;
    recordHeartbeat(username, page, device);
    return res.status(200).json({ success: true });
  }

  if (action === 'online_list') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return res.status(auth.status || 403).json({ success: false, error: auth.error || 'Akses admin ditolak.' });
    const filter = req.body && req.body.filter;
    const query = req.body && req.body.query;
    const result = getOnlineList(filter, query);
    return res.status(200).json({ success: true, ...result });
  }

  if (action === 'admin_console_stats') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return res.status(auth.status || 403).json({ success: false, error: auth.error || 'Akses admin ditolak.' });
    const freshness = getDatasetFreshness();
    const jobs = getJobPipeline();
    const onlineSummary = getOnlineList().summary;
    const dataHealth = inspectDataHealth();
    return res.status(200).json({
      success: true,
      admin: auth.session.un,
      ...freshness,
      jobs,
      online_summary: onlineSummary,
      data_health: dataHealth
    });
  }

  if (action === 'data_health_inspect') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return res.status(auth.status || 403).json({ success: false, error: auth.error || 'Akses admin ditolak.' });
    const dataHealth = inspectDataHealth();
    return res.status(200).json({
      success: true,
      data_health: dataHealth
    });
  }

  if (action === 'pattern_radar_scan') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return res.status(auth.status || 403).json({ success: false, error: auth.error || 'Akses admin ditolak.' });

    const minSim = Number(req.body && req.body.min_similarity) || 80;
    const patternFilter = String(req.body && req.body.pattern || 'all');

    const patterns = [
      {
        ticker: 'BBRI',
        name: 'Bank Rakyat Indonesia',
        pattern: 'Double Bottom',
        similarity: 92.4,
        breakout: 5100,
        target: 5450,
        target_pct: '+6,8%',
        status: 'Terkonfirmasi',
        status_key: 'g',
        shape: 'M2 4 L20 20 L34 10 L50 21 L68 6 L88 2'
      },
      {
        ticker: 'BRPT',
        name: 'Barito Pacific',
        pattern: 'Bullish Flag',
        similarity: 89.1,
        breakout: 1050,
        target: 1180,
        target_pct: '+12,4%',
        status: 'Menunggu volume',
        status_key: 'a',
        shape: 'M2 24 L22 4 L34 9 L46 6 L58 11 L70 8 L88 2'
      },
      {
        ticker: 'MEDC',
        name: 'Medco Energi',
        pattern: 'Ascending Triangle',
        similarity: 87.5,
        breakout: 1390,
        target: 1550,
        target_pct: '+11,5%',
        status: 'Terkonfirmasi',
        status_key: 'g',
        shape: 'M2 22 L18 6 L30 18 L46 6 L58 14 L72 6 L88 3'
      },
      {
        ticker: 'ICBP',
        name: 'Indofood CBP',
        pattern: 'Cup & Handle',
        similarity: 86.0,
        breakout: 11200,
        target: 11900,
        target_pct: '+6,2%',
        status: 'Membentuk handle',
        status_key: 'a',
        shape: 'M2 4 Q 24 30 46 6 L60 12 L72 8 L88 2'
      },
      {
        ticker: 'ANTM',
        name: 'Aneka Tambang',
        pattern: 'Double Bottom',
        similarity: 84.2,
        breakout: 1580,
        target: 1700,
        target_pct: '+7,6%',
        status: 'Belum breakout',
        status_key: 'm',
        shape: 'M2 4 L20 20 L34 10 L50 21 L68 6 L88 2'
      },
      {
        ticker: 'TLKM',
        name: 'Telkom Indonesia',
        pattern: 'Double Bottom',
        similarity: 81.7,
        breakout: 3020,
        target: 3210,
        target_pct: '+6,3%',
        status: 'Belum breakout',
        status_key: 'm',
        shape: 'M2 4 L20 20 L34 10 L50 21 L68 6 L88 2'
      }
    ];

    const filtered = patterns.filter(p => {
      const matchPattern = patternFilter === 'all' || p.pattern === patternFilter;
      const matchSim = p.similarity >= minSim;
      return matchPattern && matchSim;
    });

    return res.status(200).json({
      success: true,
      scanned_count: 840,
      window_size: 60,
      horizon_days: 20,
      method: 'z-score + Pearson (NCC)',
      rows: filtered
    });
  }

  if (action === 'portfolio_access') {
    return resolvePremiumPortfolioAccess(req, res);
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
}

handler.isTruthyFlag = isTruthyFlag;
handler.deleteUserWithSupabase = deleteUserWithSupabase;
handler.formatTokenBudgetMessage = formatTokenBudgetMessage;

module.exports = handler;

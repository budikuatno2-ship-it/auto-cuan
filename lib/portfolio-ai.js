'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const DEFAULT_MODEL_TIMEOUT_MS = 7000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MODEL_COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 2;
const buckets = new Map();
const modelHealth = new Map();
const stickyModels = new Map();

const DEFAULT_POOLS = Object.freeze({
  heavy: [
    'wz/gpt-5.6-sol',
    'wz/claude-sonnet-4.5',
    'wz/gpt-5-pro',
    'wz/o4-reasoning',
    'wz/gemini-3-pro',
    'wz/grok-4-heavy',
    'wz/deepseek-v4-pro'
  ],
  empathy: [
    'wz/claude-sonnet-4.5',
    'wz/gpt-5.6-sol',
    'wz/grok-4.2',
    'wz/gemini-2.5-flash',
    'wz/mimo-v2.5'
  ],
  fast: [
    'wz/gpt-5.6-sol-mini',
    'wz/gemini-2.5-flash',
    'wz/claude-haiku-4.5',
    'wz/grok-4.2-fast',
    'wz/mimo-v2.5'
  ]
});

function rateAllowed(key) {
  const now = Date.now();
  const current = buckets.get(key) || [];
  const active = current.filter((stamp) => now - stamp < WINDOW_MS);
  if (active.length >= MAX_REQUESTS) {
    buckets.set(key, active);
    return false;
  }
  active.push(now);
  buckets.set(key, active);
  return true;
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function splitModels(value) {
  const seen = new Set();
  return String(value || '').split(',').map((model) => model.trim()).filter((model) => {
    if (!model || seen.has(model)) return false;
    seen.add(model);
    return true;
  });
}

function configuredPool(kind) {
  const key = kind === 'heavy'
    ? 'PORTFOLIO_AI_HEAVY_MODELS'
    : kind === 'empathy'
      ? 'PORTFOLIO_AI_EMPATHY_MODELS'
      : 'PORTFOLIO_AI_FAST_MODELS';
  const dedicated = splitModels(process.env[key]);
  if (dedicated.length) return dedicated;
  const general = splitModels(process.env.PORTFOLIO_AI_MODELS);
  if (general.length) return general;
  return DEFAULT_POOLS[kind].slice();
}

function sanitizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const ticker = cleanText(plan.ticker, 8).toUpperCase().replace(/\.JK$/i, '');
  if (!/^[A-Z]{3,5}$/.test(ticker)) return null;
  return {
    ticker,
    entry: safeNumber(plan.entryPriceIdr != null ? plan.entryPriceIdr : plan.entry),
    stop_loss: safeNumber(plan.stopLossIdr != null ? plan.stopLossIdr : plan.stop),
    tp1: safeNumber(plan.tp1Idr != null ? plan.tp1Idr : plan.tp1),
    tp2: safeNumber(plan.tp2Idr != null ? plan.tp2Idr : plan.tp2),
    lots: safeNumber(plan.lots),
    estimated_max_loss: safeNumber(plan.estimatedMaxLossIdr != null ? plan.estimatedMaxLossIdr : plan.riskBudgetIdr),
    capital: safeNumber(plan.capitalIdr),
    created_at: safeNumber(plan.createdAt)
  };
}

function sanitizeContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 30).map(sanitizePlan).filter(Boolean);
  const prices = {};
  const sourcePrices = input.prices && typeof input.prices === 'object' ? input.prices : {};
  Object.keys(sourcePrices).slice(0, 50).forEach((key) => {
    const ticker = cleanText(key, 8).toUpperCase().replace(/\.JK$/i, '');
    const price = safeNumber(sourcePrices[key]);
    if (/^[A-Z]{3,5}$/.test(ticker) && price != null && price > 0) prices[ticker] = price;
  });
  const summary = input.summary && typeof input.summary === 'object' ? {
    plan_count: safeNumber(input.summary.plan_count),
    positions_with_price: safeNumber(input.summary.positions_with_price),
    positions_missing_price: safeNumber(input.summary.positions_missing_price),
    total_estimated_risk: safeNumber(input.summary.total_estimated_risk),
    total_position_value: safeNumber(input.summary.total_position_value)
  } : null;
  return {
    plans,
    prices,
    summary,
    data_note: 'Harga pada konteks berasal dari data yang tersimpan/diisi pengguna dan tidak boleh dianggap real-time tanpa bukti waktu.'
  };
}

function sanitizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-10).map((item) => {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) return null;
    const content = cleanText(item.content, 1200);
    return content ? { role: item.role, content } : null;
  }).filter(Boolean);
}

function extractReply(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return message.content.trim();
  if (message && Array.isArray(message.content)) {
    return message.content.map((part) => part && (part.text || part.content) || '').join('').trim();
  }
  if (message && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  if (choice && typeof choice.text === 'string') return choice.text.trim();
  if (typeof data.output_text === 'string') return data.output_text.trim();
  if (Array.isArray(data.output)) {
    return data.output.map((item) => {
      if (!item) return '';
      if (typeof item.text === 'string') return item.text;
      if (Array.isArray(item.content)) return item.content.map((part) => part && part.text || '').join('');
      return '';
    }).join('').trim();
  }
  return '';
}

function classifyTask(message, context) {
  const text = String(message || '').toLowerCase();
  const empathy = /\b(cemas|cemasnya|takut|panik|stres|stress|sedih|menyesal|curhat|khawatir|gelisah|bingung banget|putus asa|emosi)\b/i.test(text);
  if (empathy) return 'empathy';

  const heavy = /\b(analisis|evaluasi|bandingkan|skenario|simulasi|alokasi|diversifikasi|korelasi|risiko total|risk reward|average down|cut loss|stop loss|prioritas posisi|optimasi|strategi|portofolio keseluruhan|mana yang paling)\b/i.test(text);
  const hasPortfolio = context && Array.isArray(context.plans) && context.plans.length > 0;
  if (heavy || (hasPortfolio && text.length > 180)) return 'heavy';
  return 'fast';
}

function healthFor(model) {
  return modelHealth.get(model) || {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    successes: 0,
    failures: 0,
    averageLatencyMs: null,
    lastFailure: null,
    lastStatus: null
  };
}

function saveHealth(model, health) {
  modelHealth.set(model, health);
}

function isCoolingDown(model, now) {
  return healthFor(model).cooldownUntil > now;
}

function recordSuccess(model, latencyMs) {
  const health = healthFor(model);
  const successes = health.successes + 1;
  health.averageLatencyMs = health.averageLatencyMs == null
    ? latencyMs
    : Math.round(((health.averageLatencyMs * health.successes) + latencyMs) / successes);
  health.successes = successes;
  health.consecutiveFailures = 0;
  health.cooldownUntil = 0;
  health.lastFailure = null;
  health.lastStatus = 200;
  saveHealth(model, health);
}

function recordFailure(model, reason, status, retriable) {
  const health = healthFor(model);
  health.failures += 1;
  health.consecutiveFailures = retriable ? health.consecutiveFailures + 1 : health.consecutiveFailures;
  health.lastFailure = cleanText(reason, 160);
  health.lastStatus = status || null;
  if (retriable && health.consecutiveFailures >= FAILURE_THRESHOLD) {
    health.cooldownUntil = Date.now() + MODEL_COOLDOWN_MS;
  }
  saveHealth(model, health);
}

function orderedModels(kind, userId) {
  const now = Date.now();
  const pool = configuredPool(kind);
  const sticky = stickyModels.get(userId);
  const ordered = [];
  if (sticky && pool.includes(sticky) && !isCoolingDown(sticky, now)) ordered.push(sticky);
  pool.forEach((model) => {
    if (!ordered.includes(model) && !isCoolingDown(model, now)) ordered.push(model);
  });
  pool.forEach((model) => {
    if (!ordered.includes(model)) ordered.push(model);
  });
  return ordered;
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function taskSettings(kind) {
  if (kind === 'heavy') return { temperature: 0.2, maxTokens: 1100 };
  if (kind === 'empathy') return { temperature: 0.45, maxTokens: 850 };
  return { temperature: 0.25, maxTokens: 650 };
}

async function callModel(baseUrl, apiKey, model, messages, settings, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens
      }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      let body = '';
      try { body = cleanText(await response.text(), 300); } catch (_) {}
      return {
        ok: false,
        model,
        latencyMs,
        status: response.status,
        retriable: isRetriableStatus(response.status),
        reason: 'HTTP ' + response.status + (body ? ': ' + body : '')
      };
    }
    let data;
    try {
      data = await response.json();
    } catch (_) {
      return { ok: false, model, latencyMs, status: 502, retriable: true, reason: 'Respons provider bukan JSON.' };
    }
    const reply = cleanText(extractReply(data), 8000);
    if (!reply) return { ok: false, model, latencyMs, status: 502, retriable: true, reason: 'Respons model kosong.' };
    return { ok: true, model, latencyMs, status: 200, reply };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return {
      ok: false,
      model,
      latencyMs: Date.now() - startedAt,
      status: timedOut ? 504 : 502,
      retriable: true,
      reason: timedOut ? 'Timeout.' : cleanText(error && error.message || 'Provider error.', 160)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyApprovedUser(req) {
  if (!isSameOrigin(req)) return { ok: false, status: 403, error: 'Permintaan ditolak.' };
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return auth;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, status: 503, error: 'Status akses belum tersedia.' };

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await supabase.from('app_users')
    .select('id,username,is_approved,is_blocked')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (result.error || !result.data) return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  const account = result.data;
  if (String(account.username || '').trim().toLowerCase() !== String(auth.session.un || '').trim().toLowerCase()) {
    return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  }
  if (account.is_blocked === true) return { ok: false, status: 403, error: 'Akun sedang diblokir.' };
  if (account.is_approved !== true) return { ok: false, status: 403, error: 'Akun belum di-approve admin.' };
  return { ok: true, account };
}

module.exports = async function handlePortfolioAI(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    const access = await verifyApprovedUser(req);
    if (!access.ok) return res.status(access.status || 403).json({ success: false, error: access.error });
    const userId = String(access.account.id);
    if (!rateAllowed(userId)) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak pertanyaan. Tunggu sebentar lalu coba lagi.' });
    }

    const message = cleanText(req.body && req.body.chatMessage, 2500);
    if (!message) return res.status(400).json({ success: false, error: 'Pertanyaan belum diisi.' });

    const apiKey = process.env.PORTFOLIO_AI_API_KEY;
    const baseUrl = String(process.env.PORTFOLIO_AI_BASE_URL || 'https://weizerouter.web.id/v1').replace(/\/+$/, '');
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        code: 'PORTFOLIO_AI_NOT_CONFIGURED',
        error: 'Asisten AI Portofolio belum aktif. Admin perlu memasang PORTFOLIO_AI_API_KEY di server.'
      });
    }

    const context = sanitizeContext(req.body && req.body.context);
    const history = sanitizeHistory(req.body && req.body.history);
    const task = classifyTask(message, context);
    const settings = taskSettings(task);
    const systemPrompt = [
      'Anda adalah Asisten AI Portofolio Auto-Cuan berbahasa Indonesia.',
      'Karakter, format, dan aturan berikut tetap sama walaupun model penyedia berganti.',
      'Anda boleh membantu analisis portofolio, konsultasi pengambilan keputusan, penjelasan risiko, perencanaan, dan percakapan suportif ketika pengguna sedang cemas atau ingin bercerita.',
      'Pisahkan secara jelas: FAKTA DATA, ANALISIS LOGIS, PILIHAN TINDAKAN, dan DATA YANG MASIH KURANG bila relevan.',
      'Jangan mengarang harga, berita, kondisi pasar, transaksi, atau data real-time. Bila data tidak tersedia atau sudah lama, katakan secara eksplisit.',
      'Jangan menjanjikan keuntungan, jangan memerintah BUY/SELL secara mutlak, dan jangan membuat order. Tekankan konfirmasi manual dan batas risiko.',
      'Untuk curhat, jawab dengan empati dan masuk akal tanpa berpura-pura menjadi psikolog atau dokter. Jangan menghakimi.',
      'Gunakan angka dari konteks bila tersedia. Jangan mengubah angka yang diberikan.',
      'Jawab praktis dan mudah dipahami. Hindari istilah teknis yang tidak perlu.',
      'Konteks portofolio berikut berasal dari browser pengguna:',
      JSON.stringify(context)
    ].join('\n');
    const messages = [{ role: 'system', content: systemPrompt }].concat(history, [{ role: 'user', content: message }]);

    const timeoutMs = boundedInt(process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS, 3000, 15000);
    const maxAttempts = boundedInt(process.env.PORTFOLIO_AI_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 3);
    const models = orderedModels(task, userId).slice(0, maxAttempts);
    const attempts = [];

    for (const model of models) {
      const result = await callModel(baseUrl, apiKey, model, messages, settings, timeoutMs);
      attempts.push({ model, status: result.status, latency_ms: result.latencyMs, ok: result.ok, reason: result.ok ? null : cleanText(result.reason, 120) });
      if (result.ok) {
        recordSuccess(model, result.latencyMs);
        stickyModels.set(userId, model);
        console.log('portfolio-ai success', JSON.stringify({ task, model, latency_ms: result.latencyMs, fallback_count: attempts.length - 1 }));
        return res.status(200).json({
          success: true,
          reply: result.reply,
          grounded: true,
          portfolio_data_used: context.plans.length > 0,
          task_type: task,
          model_used: model,
          fallback_count: attempts.length - 1
        });
      }

      recordFailure(model, result.reason, result.status, result.retriable);
      console.warn('portfolio-ai attempt failed', JSON.stringify({ task, model, status: result.status, retriable: result.retriable, latency_ms: result.latencyMs }));
      if (!result.retriable) {
        const authProblem = result.status === 401 || result.status === 403;
        return res.status(authProblem ? 503 : 502).json({
          success: false,
          code: authProblem ? 'PORTFOLIO_AI_KEY_OR_ACCESS_ERROR' : 'PORTFOLIO_AI_REQUEST_ERROR',
          error: authProblem ? 'API key AI tidak valid atau tidak memiliki akses model.' : 'Permintaan AI ditolak provider. Periksa konfigurasi model.',
          task_type: task
        });
      }
    }

    return res.status(503).json({
      success: false,
      code: 'PORTFOLIO_AI_ALL_MODELS_FAILED',
      error: 'Semua model AI yang dipilih sedang mengalami gangguan. Coba lagi beberapa saat.',
      task_type: task,
      attempted_models: attempts.map((item) => item.model)
    });
  } catch (error) {
    console.error('portfolio-ai exception', error && error.message);
    return res.status(500).json({ success: false, error: 'Asisten AI mengalami gangguan.' });
  }
};

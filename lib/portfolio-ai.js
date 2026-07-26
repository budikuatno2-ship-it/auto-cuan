'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const DEFAULT_MODEL_TIMEOUT_MS = 5500;
const DEFAULT_TOTAL_TIMEOUT_MS = 25000;
const MODEL_COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 2;
const buckets = new Map();
const modelHealth = new Map();
const stickyModels = new Map();

const MODEL_CATALOG = Object.freeze([
  'wz/gpt-5.6-sol',
  'wz/gpt-5.6-terra',
  'wz/gpt-5.6-luna',
  'wz/kimi-k3',
  'wz/kimi-k2.7-code',
  'wz/kimi-k2.7-code-highspeed',
  'wz/kimi-k2.6',
  'wz/deepseek-v4-pro-max',
  'wz/deepseek-v4-pro',
  'wz/deepseek-v4-pro-none',
  'wz/deepseek-v4-flash',
  'wz/deepseek-chat',
  'wz/deepseek-reasoner',
  'wz/claude-fable-5',
  'wz/mimo-v2.5-pro',
  'wz/mimo-v2.5',
  'wz/grok-4.5',
  'wz/grok-4.5-low',
  'wz/grok-4.5-medium',
  'wz/grok-4.5-high',
  'wz/gpt-5.5',
  'wz/gpt-5.5-review',
  'wz/gpt-5.4',
  'wz/gpt-5.4-review',
  'wz/gpt-5.4-mini',
  'wz/gpt-5.4-mini-review',
  'wz/gemini-3.5-flash-extra-low',
  'wz/gemini-3-flash-agent',
  'wz/gemini-3.5-flash-low',
  'wz/gemini-pro-agent',
  'wz/gemini-3.1-pro-low',
  'wz/gemini-3-flash',
  'wz/gemini-3.1-flash-lite-preview',
  'wz/gemini-2.5-pro',
  'wz/gemini-2.5-flash',
  'wz/gemini-2.5-flash-lite'
]);

const DEFAULT_POOLS = Object.freeze({
  heavy: [
    'wz/gpt-5.6-sol',
    'wz/claude-fable-5',
    'wz/deepseek-v4-pro-max',
    'wz/deepseek-v4-pro',
    'wz/grok-4.5-high',
    'wz/gpt-5.6-terra',
    'wz/gpt-5.6-luna',
    'wz/deepseek-reasoner',
    'wz/gpt-5.5',
    'wz/gpt-5.5-review',
    'wz/gpt-5.4',
    'wz/gpt-5.4-review',
    'wz/gemini-2.5-pro',
    'wz/gemini-pro-agent',
    'wz/gemini-3.1-pro-low',
    'wz/grok-4.5',
    'wz/grok-4.5-medium',
    'wz/kimi-k3',
    'wz/kimi-k2.6',
    'wz/mimo-v2.5-pro',
    'wz/mimo-v2.5',
    'wz/deepseek-chat',
    'wz/deepseek-v4-flash',
    'wz/gemini-3-flash-agent',
    'wz/gemini-3-flash',
    'wz/gemini-2.5-flash',
    'wz/gpt-5.4-mini',
    'wz/gpt-5.4-mini-review',
    'wz/grok-4.5-low',
    'wz/gemini-3.5-flash-low',
    'wz/gemini-3.5-flash-extra-low',
    'wz/gemini-3.1-flash-lite-preview',
    'wz/gemini-2.5-flash-lite',
    'wz/kimi-k2.7-code-highspeed',
    'wz/kimi-k2.7-code',
    'wz/deepseek-v4-pro-none'
  ],
  empathy: [
    'wz/claude-fable-5',
    'wz/gpt-5.6-luna',
    'wz/gpt-5.6-sol',
    'wz/grok-4.5',
    'wz/grok-4.5-medium',
    'wz/gemini-2.5-flash',
    'wz/mimo-v2.5',
    'wz/gpt-5.6-terra',
    'wz/deepseek-v4-pro',
    'wz/gemini-2.5-pro',
    'wz/kimi-k3',
    'wz/kimi-k2.6',
    'wz/grok-4.5-high',
    'wz/deepseek-v4-pro-max',
    'wz/gpt-5.5',
    'wz/gpt-5.4',
    'wz/gemini-pro-agent',
    'wz/gemini-3-flash-agent',
    'wz/gemini-3-flash',
    'wz/gpt-5.4-mini',
    'wz/grok-4.5-low',
    'wz/deepseek-chat',
    'wz/deepseek-v4-flash',
    'wz/mimo-v2.5-pro',
    'wz/gemini-3.5-flash-low',
    'wz/gemini-3.5-flash-extra-low',
    'wz/gemini-3.1-flash-lite-preview',
    'wz/gemini-2.5-flash-lite',
    'wz/gpt-5.5-review',
    'wz/gpt-5.4-review',
    'wz/gpt-5.4-mini-review',
    'wz/gemini-3.1-pro-low',
    'wz/deepseek-reasoner',
    'wz/kimi-k2.7-code-highspeed',
    'wz/kimi-k2.7-code',
    'wz/deepseek-v4-pro-none'
  ],
  fast: [
    'wz/gemini-2.5-flash',
    'wz/mimo-v2.5',
    'wz/grok-4.5-low',
    'wz/deepseek-v4-flash',
    'wz/gpt-5.4-mini',
    'wz/gemini-2.5-flash-lite',
    'wz/gemini-3.5-flash-extra-low',
    'wz/gemini-3.5-flash-low',
    'wz/gemini-3.1-flash-lite-preview',
    'wz/kimi-k2.7-code-highspeed',
    'wz/grok-4.5-medium',
    'wz/deepseek-chat',
    'wz/gemini-3-flash',
    'wz/mimo-v2.5-pro',
    'wz/gpt-5.6-luna',
    'wz/claude-fable-5',
    'wz/gpt-5.6-sol',
    'wz/deepseek-v4-pro',
    'wz/gpt-5.6-terra',
    'wz/grok-4.5',
    'wz/gemini-2.5-pro',
    'wz/kimi-k2.6',
    'wz/kimi-k3',
    'wz/grok-4.5-high',
    'wz/deepseek-v4-pro-max',
    'wz/gpt-5.5',
    'wz/gpt-5.4',
    'wz/gemini-3-flash-agent',
    'wz/gemini-pro-agent',
    'wz/gemini-3.1-pro-low',
    'wz/deepseek-reasoner',
    'wz/gpt-5.5-review',
    'wz/gpt-5.4-review',
    'wz/gpt-5.4-mini-review',
    'wz/kimi-k2.7-code',
    'wz/deepseek-v4-pro-none'
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

function dedupeModels(models) {
  const seen = new Set();
  return models.filter((model) => {
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
  if (dedicated.length) return dedupeModels(dedicated.concat(MODEL_CATALOG));
  const general = splitModels(process.env.PORTFOLIO_AI_MODELS);
  if (general.length) return dedupeModels(general.concat(MODEL_CATALOG));
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
  const sticky = stickyModels.get(userId + ':' + kind);
  const healthy = [];
  const cooling = [];
  pool.forEach((model) => {
    if (isCoolingDown(model, now)) cooling.push(model);
    else healthy.push(model);
  });
  const ordered = [];
  if (sticky && healthy.includes(sticky)) ordered.push(sticky);
  healthy.forEach((model) => { if (!ordered.includes(model)) ordered.push(model); });
  cooling.forEach((model) => { if (!ordered.includes(model)) ordered.push(model); });
  return ordered;
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function taskSettings(kind) {
  if (kind === 'heavy') return { temperature: 0.2, maxTokens: 1100 };
  if (kind === 'empathy') return { temperature: 0.5, maxTokens: 900 };
  return { temperature: 0.3, maxTokens: 700 };
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
      'Karakter dan aturan ini wajib konsisten walaupun model penyedia berganti.',
      'Gunakan bahasa manusia yang santai, hangat, natural, dan mudah dipahami. Boleh memakai gaya Gen Z atau bahasa gaul secukupnya bila cocok, tetapi jangan dipaksakan, jangan cringe, dan jangan mengorbankan ketepatan.',
      'Jangan kaku seperti dokumen hukum. Tetap sopan, to the point, dan terasa seperti teman diskusi yang cerdas.',
      'Anda boleh membantu analisis portofolio, konsultasi pengambilan keputusan, penjelasan risiko, perencanaan, dan percakapan suportif ketika pengguna sedang cemas atau ingin bercerita.',
      'Bedakan dengan jelas antara fakta dari data, analisis atau inferensi logis, pilihan tindakan, dan data yang masih kurang. Gunakan judul hanya ketika membantu; jangan memaksa format yang terasa robotik.',
      'Jangan mengarang harga, berita, kondisi pasar, transaksi, atau data real-time. Bila data tidak tersedia atau sudah lama, katakan secara jujur.',
      'Jangan menjanjikan keuntungan, jangan memberi perintah BUY/SELL mutlak, dan jangan membuat order. Tekankan keputusan manual dan batas risiko.',
      'Untuk curhat, jawab dengan empati dan masuk akal tanpa berpura-pura menjadi psikolog atau dokter. Jangan menghakimi.',
      'Gunakan angka dari konteks bila tersedia dan jangan mengubah angka yang diberikan.',
      'Konteks portofolio berikut berasal dari browser pengguna:',
      JSON.stringify(context)
    ].join('\n');
    const messages = [{ role: 'system', content: systemPrompt }].concat(history, [{ role: 'user', content: message }]);

    const timeoutMs = boundedInt(process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS, 1500, 15000);
    const totalTimeoutMs = boundedInt(process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, 5000, 60000);
    const configuredAttempts = boundedInt(process.env.PORTFOLIO_AI_MAX_ATTEMPTS, MODEL_CATALOG.length, 1, MODEL_CATALOG.length);
    const models = orderedModels(task, userId).slice(0, configuredAttempts);
    const attempts = [];
    const startedAt = Date.now();

    for (const model of models) {
      const elapsed = Date.now() - startedAt;
      const remaining = totalTimeoutMs - elapsed;
      if (remaining < 1200) break;
      const perModelTimeout = Math.min(timeoutMs, remaining);
      const result = await callModel(baseUrl, apiKey, model, messages, settings, perModelTimeout);
      attempts.push({ model, status: result.status, latency_ms: result.latencyMs, ok: result.ok, reason: result.ok ? null : cleanText(result.reason, 120) });
      if (result.ok) {
        recordSuccess(model, result.latencyMs);
        stickyModels.set(userId + ':' + task, model);
        console.log('portfolio-ai success', JSON.stringify({ task, model, latency_ms: result.latencyMs, fallback_count: attempts.length - 1, total_elapsed_ms: Date.now() - startedAt }));
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
      error: attempts.length
        ? 'Model AI yang sempat dicoba sedang mengalami gangguan. Coba lagi sebentar ya.'
        : 'Waktu tunggu AI habis sebelum ada model yang bisa dicoba. Coba lagi sebentar ya.',
      task_type: task,
      attempted_models: attempts.map((item) => item.model),
      total_elapsed_ms: Date.now() - startedAt
    });
  } catch (error) {
    console.error('portfolio-ai exception', error && error.message);
    return res.status(500).json({ success: false, error: 'Asisten AI lagi gangguan. Coba lagi sebentar ya.' });
  }
};

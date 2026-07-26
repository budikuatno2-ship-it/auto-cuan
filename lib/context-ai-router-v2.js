'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const DEFAULT_MODEL_TIMEOUT_MS = 5500;
const DEFAULT_TOTAL_TIMEOUT_MS = 25000;
const COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 2;
const buckets = new Map();
const health = new Map();
const sticky = new Map();

const CATALOG = Object.freeze([
  'wz/gpt-5.6-sol','wz/claude-opus-5','wz/claude-opus-4.8','wz/claude-opus-4.7','wz/claude-opus-4.6','wz/claude-opus-4.5',
  'wz/claude-sonnet-4.6','wz/claude-sonnet-4.5','wz/claude-fable-5','wz/claude-haiku-4.5',
  'wz/gpt-5.6-terra','wz/gpt-5.6-luna',
  'wz/deepseek-v4-pro-max','wz/deepseek-v4-pro','wz/deepseek-reasoner','wz/grok-4.5-high','wz/grok-4.5','wz/grok-4.5-medium',
  'wz/gpt-5.5','wz/gpt-5.5-review','wz/gpt-5.4','wz/gpt-5.4-review','wz/gpt-5.4-mini','wz/gpt-5.4-mini-review',
  'wz/gemini-2.5-pro','wz/gemini-pro-agent','wz/gemini-3.1-pro-low','wz/kimi-k3','wz/kimi-k2.6','wz/mimo-v2.5-pro','wz/mimo-v2.5',
  'wz/deepseek-chat','wz/deepseek-v4-flash','wz/gemini-3-flash-agent','wz/gemini-3-flash','wz/gemini-2.5-flash',
  'wz/grok-4.5-low','wz/gemini-3.5-flash-low','wz/gemini-3.5-flash-extra-low','wz/gemini-3.1-flash-lite-preview','wz/gemini-2.5-flash-lite',
  'wz/kimi-k2.7-code-highspeed','wz/kimi-k2.7-code','wz/deepseek-v4-pro-none'
]);

const DEFAULT_HEAVY = Object.freeze([
  'wz/gpt-5.6-sol','wz/claude-opus-5','wz/claude-opus-4.8','wz/claude-opus-4.7','wz/claude-opus-4.6',
  'wz/claude-sonnet-4.6','wz/claude-fable-5','wz/deepseek-v4-pro-max','wz/deepseek-v4-pro','wz/grok-4.5-high',
  'wz/gpt-5.6-terra','wz/gpt-5.6-luna','wz/deepseek-reasoner','wz/gpt-5.5','wz/gpt-5.4','wz/gemini-2.5-pro'
]);
const DEFAULT_EMPATHY = Object.freeze([
  'wz/claude-sonnet-4.6','wz/claude-fable-5','wz/claude-opus-5','wz/gpt-5.6-luna','wz/gpt-5.6-sol',
  'wz/claude-sonnet-4.5','wz/grok-4.5','wz/grok-4.5-medium','wz/gemini-2.5-flash','wz/mimo-v2.5','wz/claude-haiku-4.5'
]);
const DEFAULT_FAST = Object.freeze([
  'wz/claude-haiku-4.5','wz/gemini-2.5-flash','wz/mimo-v2.5','wz/grok-4.5-low','wz/deepseek-v4-flash',
  'wz/gpt-5.4-mini','wz/gemini-2.5-flash-lite','wz/kimi-k2.7-code-highspeed','wz/grok-4.5-medium'
]);

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}
function bounded(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function split(value) {
  return clean(value, 30000).split(',').map((x) => x.trim()).filter(Boolean);
}
function dedupe(rows) {
  const seen = new Set();
  return rows.filter((x) => x && !seen.has(x) && seen.add(x));
}
function allowed(key) {
  const now = Date.now();
  const active = (buckets.get(key) || []).filter((stamp) => now - stamp < WINDOW_MS);
  if (active.length >= MAX_REQUESTS) return false;
  active.push(now);
  buckets.set(key, active);
  return true;
}
function modelHealth(model) {
  return health.get(model) || { failures: 0, consecutive: 0, cooldownUntil: 0, avgLatency: null, successes: 0 };
}
function recordSuccess(model, latency) {
  const h = modelHealth(model);
  const total = h.successes + 1;
  h.avgLatency = h.avgLatency == null ? latency : Math.round(((h.avgLatency * h.successes) + latency) / total);
  h.successes = total;
  h.consecutive = 0;
  h.cooldownUntil = 0;
  health.set(model, h);
}
function recordFailure(model, retriable) {
  const h = modelHealth(model);
  h.failures += 1;
  if (retriable) h.consecutive += 1;
  if (retriable && h.consecutive >= FAILURE_THRESHOLD) h.cooldownUntil = Date.now() + COOLDOWN_MS;
  health.set(model, h);
}
function configuredModels(source, task) {
  let dedicated = [];
  if (source === 'stock_analysis_followup') {
    dedicated = split(process.env.STOCK_ANALYSIS_AI_MODELS || process.env.PORTFOLIO_AI_HEAVY_MODELS);
  } else if (task === 'empathy') {
    dedicated = split(process.env.PORTFOLIO_AI_EMPATHY_MODELS);
  } else if (task === 'fast') {
    dedicated = split(process.env.PORTFOLIO_AI_FAST_MODELS);
  } else {
    dedicated = split(process.env.PORTFOLIO_AI_HEAVY_MODELS);
  }
  const general = split(process.env.PORTFOLIO_AI_MODELS);
  const defaults = source === 'stock_analysis_followup' || task === 'heavy'
    ? DEFAULT_HEAVY
    : task === 'empathy' ? DEFAULT_EMPATHY : DEFAULT_FAST;
  return dedupe(dedicated.concat(general, defaults, CATALOG));
}
function orderedModels(source, task, userId) {
  const pool = configuredModels(source, task);
  const now = Date.now();
  const stickyKey = userId + ':' + source + ':' + task;
  const preferred = sticky.get(stickyKey);
  const live = pool.filter((model) => modelHealth(model).cooldownUntil <= now);
  const cooling = pool.filter((model) => modelHealth(model).cooldownUntil > now);
  return dedupe((preferred && live.includes(preferred) ? [preferred] : []).concat(live, cooling));
}
function modelRouteFailure(status, body) {
  if (status === 401 || status === 402 || status === 403) return false;
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  if ([400, 404, 422].includes(status)) {
    return /model|route|provider|unsupported|not found|unavailable|disabled|capacity|overload|gangguan|nonaktif|paused|limit/i.test(body || '');
  }
  return false;
}
function extractReply(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return message.content.trim();
  if (message && Array.isArray(message.content)) return message.content.map((p) => p && (p.text || p.content) || '').join('').trim();
  if (message && typeof message.reasoning_content === 'string') return message.reasoning_content.trim();
  if (choice && typeof choice.text === 'string') return choice.text.trim();
  if (typeof data.output_text === 'string') return data.output_text.trim();
  return '';
}
async function callModel(baseUrl, apiKey, model, messages, settings, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, temperature: settings.temperature, max_tokens: settings.maxTokens }),
      signal: controller.signal
    });
    const latency = Date.now() - started;
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, model, latency, status: response.status, retriable: modelRouteFailure(response.status, raw), reason: clean(raw || ('HTTP ' + response.status), 300) };
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, model, latency, status: 502, retriable: true, reason: 'Respons provider bukan JSON.' }; }
    const reply = clean(extractReply(data), 12000);
    return reply
      ? { ok: true, model, latency, status: 200, reply }
      : { ok: false, model, latency, status: 502, retriable: true, reason: 'Respons model kosong.' };
  } catch (error) {
    return {
      ok: false,
      model,
      latency: Date.now() - started,
      status: error && error.name === 'AbortError' ? 504 : 502,
      retriable: true,
      reason: error && error.name === 'AbortError' ? 'Timeout.' : clean(error && error.message || 'Provider error.', 180)
    };
  } finally {
    clearTimeout(timer);
  }
}
async function verify(req) {
  if (!isSameOrigin(req)) return { ok: false, status: 403, error: 'Permintaan ditolak.' };
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return auth;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, status: 503, error: 'Status akses belum tersedia.' };
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await supabase.from('app_users').select('id,username,is_approved,is_blocked').eq('id', auth.session.uid).maybeSingle();
  if (result.error || !result.data) return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  const account = result.data;
  if (String(account.username || '').trim().toLowerCase() !== String(auth.session.un || '').trim().toLowerCase()) return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  if (account.is_blocked === true) return { ok: false, status: 403, error: 'Akun sedang diblokir.' };
  if (account.is_approved !== true) return { ok: false, status: 403, error: 'Akun belum di-approve admin.' };
  return { ok: true, account };
}
function sanitizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-10).map((row) => {
    if (!row || !['user', 'assistant'].includes(row.role)) return null;
    const content = clean(row.content, 1800);
    return content ? { role: row.role, content } : null;
  }).filter(Boolean);
}
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function portfolioContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const prices = {};
  const sourcePrices = input.prices && typeof input.prices === 'object' ? input.prices : {};
  Object.keys(sourcePrices).slice(0, 50).forEach((key) => {
    const ticker = clean(key, 8).toUpperCase().replace(/\.JK$/i, '');
    const price = number(sourcePrices[key]);
    if (/^[A-Z]{3,5}$/.test(ticker) && price > 0) prices[ticker] = price;
  });
  const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 30).map((p) => {
    if (!p || typeof p !== 'object') return null;
    const ticker = clean(p.ticker, 8).toUpperCase().replace(/\.JK$/i, '');
    if (!/^[A-Z]{3,5}$/.test(ticker)) return null;
    return {
      ticker,
      entry: number(p.entryPriceIdr != null ? p.entryPriceIdr : p.entry),
      stop_loss: number(p.stopLossIdr != null ? p.stopLossIdr : p.stop),
      tp1: number(p.tp1Idr != null ? p.tp1Idr : p.tp1),
      tp2: number(p.tp2Idr != null ? p.tp2Idr : p.tp2),
      lots: number(p.lots),
      estimated_max_loss: number(p.estimatedMaxLossIdr != null ? p.estimatedMaxLossIdr : p.riskBudgetIdr),
      capital: number(p.capitalIdr),
      source: clean(p.source, 40)
    };
  }).filter(Boolean);
  return { plans, prices, summary: input.summary && typeof input.summary === 'object' ? input.summary : null, data_note: 'Harga berasal dari data tersimpan/diisi pengguna dan tidak otomatis real-time.' };
}
function stockContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const ticker = clean(input.ticker, 10).toUpperCase().replace(/\.JK$/i, '');
  return {
    ticker: /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '',
    analysis_text: clean(input.analysis_text || input.analysisText, 18000),
    captured_at: clean(input.captured_at, 60),
    data_note: 'Ini adalah snapshot hasil analisis yang tampil di halaman, bukan jaminan harga real-time.'
  };
}
function classify(message, context) {
  const text = String(message || '').toLowerCase();
  if (/cemas|takut|panik|stres|sedih|menyesal|curhat|khawatir|gelisah/.test(text)) return 'empathy';
  if (/analisis|evaluasi|bandingkan|skenario|simulasi|alokasi|diversifikasi|risiko|average down|cut loss|stop loss|prioritas|strategi/.test(text) || (context.plans && context.plans.length)) return 'heavy';
  return 'fast';
}
function promptFor(source, context) {
  const common = [
    'Gunakan bahasa Indonesia yang manusiawi, hangat, natural, tidak kaku, dan boleh sedikit Gen Z bila cocok tanpa menjadi cringe.',
    'Jawab lengkap dan substantif. Berikan jawaban langsung, data yang dipakai, analisis atau pendapat logis, pilihan tindakan atau saran, risiko, serta data yang masih kurang bila relevan.',
    'Jangan mengarang harga, berita, transaksi, kondisi real-time, atau kepastian keuntungan. Bedakan fakta sistem dari inferensi dan opini.',
    'Jangan memberi perintah BUY atau SELL mutlak. Keputusan tetap manual dan wajib mempertimbangkan batas risiko.'
  ];
  if (source === 'stock_analysis_followup') {
    return [
      'Anda adalah AI Pendamping Analisis Saham Auto-Cuan.',
      'Fokus hanya pada ticker dan hasil analisis saham yang sedang terbuka. Jawab pertanyaan lanjutan dan jangan mengubahnya menjadi konsultasi seluruh portofolio.',
      'Gunakan seluruh angka, indikator, level, skenario, status, alasan, dan invalidasi dalam snapshot. Bila pengguna menanyakan hold atau cut tetapi harga beli, lot, atau horizon tidak tersedia, jelaskan batasnya dan minta data tersebut setelah memberi analisis yang masih bisa dibuat.',
      ...common,
      'SNAPSHOT ANALISIS SAHAM:',
      JSON.stringify(context)
    ].join('\n');
  }
  return [
    'Anda adalah Asisten AI Portofolio Auto-Cuan.',
    'Fokus pada posisi atau rencana yang disimpan, pembagian modal, risiko gabungan, prioritas perhatian, dan konsultasi keputusan portofolio. Jangan melakukan analisis saham tunggal dari nol; arahkan pengguna ke halaman Analisis Saham bila konteks ticker belum tersedia.',
    'Untuk curhat, jawab empatik dan masuk akal tanpa berpura-pura menjadi psikolog atau dokter.',
    ...common,
    'KONTEKS PORTOFOLIO:',
    JSON.stringify(context)
  ].join('\n');
}

module.exports = async function handleContextAI(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    const source = req.body && req.body.source;
    if (!['portfolio_chat', 'stock_analysis_followup'].includes(source)) return res.status(400).json({ success: false, error: 'Sumber AI tidak valid.' });
    const access = await verify(req);
    if (!access.ok) return res.status(access.status || 403).json({ success: false, error: access.error });
    const userId = String(access.account.id);
    if (!allowed(userId + ':' + source)) return res.status(429).json({ success: false, error: 'Terlalu banyak pertanyaan. Tunggu sebentar lalu coba lagi.' });
    const message = clean(req.body && req.body.chatMessage, 3500);
    if (!message) return res.status(400).json({ success: false, error: 'Pertanyaan belum diisi.' });

    const apiKey = process.env.PORTFOLIO_AI_API_KEY;
    const baseUrl = String(process.env.PORTFOLIO_AI_BASE_URL || 'https://weizerouter.web.id/v1').replace(/\/+$/, '');
    if (!apiKey) return res.status(503).json({ success: false, code: 'AI_NOT_CONFIGURED', error: 'Asisten AI belum aktif. Admin perlu memasang PORTFOLIO_AI_API_KEY di server.' });

    const context = source === 'stock_analysis_followup' ? stockContext(req.body.context) : portfolioContext(req.body.context);
    if (source === 'stock_analysis_followup' && (!context.ticker || !context.analysis_text)) return res.status(400).json({ success: false, error: 'Jalankan analisis ticker terlebih dahulu sebelum bertanya lanjutan.' });

    const historyRows = sanitizeHistory(req.body.history);
    const task = source === 'stock_analysis_followup' ? 'heavy' : classify(message, context);
    const settings = source === 'stock_analysis_followup'
      ? { temperature: 0.25, maxTokens: 1700 }
      : task === 'empathy' ? { temperature: 0.5, maxTokens: 1200 }
        : task === 'heavy' ? { temperature: 0.25, maxTokens: 1500 }
          : { temperature: 0.35, maxTokens: 1000 };
    const messages = [{ role: 'system', content: promptFor(source, context) }].concat(historyRows, [{ role: 'user', content: message }]);

    const perModel = bounded(process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS, 1500, 15000);
    const totalLimit = bounded(process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, 5000, 60000);
    const maxAttempts = bounded(process.env.PORTFOLIO_AI_MAX_ATTEMPTS, CATALOG.length, 1, CATALOG.length);
    const models = orderedModels(source, task, userId).slice(0, maxAttempts);
    const started = Date.now();
    const attempts = [];

    for (const model of models) {
      const remaining = totalLimit - (Date.now() - started);
      if (remaining < 1200) break;
      const result = await callModel(baseUrl, apiKey, model, messages, settings, Math.min(perModel, remaining));
      attempts.push({ model, status: result.status, ok: result.ok, latency_ms: result.latency, reason: result.ok ? null : result.reason });
      if (result.ok) {
        recordSuccess(model, result.latency);
        sticky.set(userId + ':' + source + ':' + task, model);
        console.log('context-ai success', JSON.stringify({ source, task, model, fallback_count: attempts.length - 1, elapsed_ms: Date.now() - started }));
        return res.status(200).json({
          success: true,
          reply: result.reply,
          model_used: model,
          fallback_count: attempts.length - 1,
          task_type: task,
          portfolio_data_used: source === 'portfolio_chat' && context.plans.length > 0,
          stock_analysis_used: source === 'stock_analysis_followup'
        });
      }
      recordFailure(model, result.retriable);
      console.warn('context-ai attempt failed', JSON.stringify({ source, model, status: result.status, retriable: result.retriable, latency_ms: result.latency }));
      if (!result.retriable) {
        const authProblem = [401, 402, 403].includes(result.status);
        return res.status(authProblem ? 503 : 502).json({
          success: false,
          code: authProblem ? 'AI_KEY_OR_BALANCE_ERROR' : 'AI_REQUEST_ERROR',
          error: authProblem ? 'API key tidak valid, akses model ditolak, atau saldo token bermasalah.' : 'Provider menolak permintaan. Periksa format atau konfigurasi AI.'
        });
      }
    }

    return res.status(503).json({
      success: false,
      code: 'AI_ALL_MODELS_FAILED',
      error: attempts.length ? 'Model yang sempat dicoba sedang gangguan atau traffic ramai. Coba lagi sebentar ya.' : 'Waktu tunggu AI habis sebelum model sehat ditemukan.',
      attempted_models: attempts.map((x) => x.model)
    });
  } catch (error) {
    console.error('context-ai exception', error && error.message);
    return res.status(500).json({ success: false, error: 'Asisten AI lagi gangguan. Coba lagi sebentar ya.' });
  }
};

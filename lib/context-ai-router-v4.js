'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 12;
const DEFAULT_MODEL_TIMEOUT_MS = 38000;
const DEFAULT_TOTAL_TIMEOUT_MS = 52000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_CACHE_MS = 30 * 1000;
const MODEL_DIRECTORY_TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 2;

const buckets = new Map();
const health = new Map();
const sticky = new Map();
const responseCache = new Map();
const failureCache = new Map();
const inFlight = new Map();
let modelDirectoryCache = { ids: null, expiresAt: 0 };

const CATALOG = Object.freeze([
  'wz/gpt-5.6-sol','wz/claude-opus-5','wz/claude-opus-4.8','wz/claude-opus-4.7','wz/claude-opus-4.6','wz/claude-opus-4.5',
  'wz/claude-sonnet-4.6','wz/claude-sonnet-4.5','wz/claude-fable-5','wz/claude-haiku-4.5',
  'wz/gpt-5.6-terra','wz/gpt-5.6-luna','wz/deepseek-v4-pro-max','wz/deepseek-v4-pro','wz/deepseek-reasoner',
  'wz/grok-4.5-high','wz/grok-4.5','wz/grok-4.5-medium','wz/gpt-5.5','wz/gpt-5.5-review','wz/gpt-5.4','wz/gpt-5.4-review',
  'wz/gpt-5.4-mini','wz/gpt-5.4-mini-review','wz/gemini-2.5-pro','wz/gemini-pro-agent','wz/gemini-3.1-pro-low',
  'wz/kimi-k3','wz/kimi-k2.6','wz/mimo-v2.5-pro','wz/mimo-v2.5','wz/deepseek-chat','wz/deepseek-v4-flash',
  'wz/gemini-3-flash-agent','wz/gemini-3-flash','wz/gemini-2.5-flash','wz/grok-4.5-low','wz/gemini-3.5-flash-low',
  'wz/gemini-3.5-flash-extra-low','wz/gemini-3.1-flash-lite-preview','wz/gemini-2.5-flash-lite','wz/kimi-k2.7-code-highspeed',
  'wz/kimi-k2.7-code','wz/deepseek-v4-pro-none'
]);

const DEFAULT_STOCK = Object.freeze([
  'wz/gpt-5.6-sol','wz/claude-sonnet-4.6','wz/claude-fable-5','wz/deepseek-v4-pro','wz/grok-4.5-high','wz/claude-opus-5'
]);
const DEFAULT_HEAVY = Object.freeze([
  'wz/gpt-5.6-sol','wz/claude-sonnet-4.6','wz/claude-fable-5','wz/deepseek-v4-pro','wz/grok-4.5-high','wz/claude-opus-5'
]);
const DEFAULT_EMPATHY = Object.freeze([
  'wz/claude-sonnet-4.6','wz/claude-fable-5','wz/gpt-5.6-luna','wz/claude-haiku-4.5','wz/grok-4.5-medium'
]);
const DEFAULT_FAST = Object.freeze([
  'wz/claude-haiku-4.5','wz/gemini-2.5-flash','wz/mimo-v2.5','wz/grok-4.5-low','wz/deepseek-v4-flash'
]);
const EXPENSIVE_MODELS = new Set([
  'wz/claude-opus-5','wz/claude-opus-4.8','wz/claude-opus-4.7','wz/claude-opus-4.6','wz/claude-opus-4.5'
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
function nowMs() { return Date.now(); }
function pruneMap(map, now) {
  if (map.size < 250) return;
  for (const [key, value] of map) {
    if (!value || !value.expiresAt || value.expiresAt <= now) map.delete(key);
  }
}
function allowed(key) {
  const now = nowMs();
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
  if (retriable && h.consecutive >= FAILURE_THRESHOLD) h.cooldownUntil = nowMs() + COOLDOWN_MS;
  health.set(model, h);
}
function envModels(source, task) {
  if (source === 'stock_analysis_followup') return split(process.env.STOCK_ANALYSIS_AI_MODELS);
  if (task === 'empathy') return split(process.env.PORTFOLIO_AI_EMPATHY_MODELS);
  if (task === 'fast') return split(process.env.PORTFOLIO_AI_FAST_MODELS);
  return split(process.env.PORTFOLIO_AI_HEAVY_MODELS);
}
function defaultsFor(source, task) {
  if (source === 'stock_analysis_followup') return DEFAULT_STOCK;
  if (task === 'empathy') return DEFAULT_EMPATHY;
  if (task === 'fast') return DEFAULT_FAST;
  return DEFAULT_HEAVY;
}
function economicalOrder(rows, source, task) {
  const unique = dedupe(rows);
  const normal = unique.filter((m) => !EXPENSIVE_MODELS.has(m));
  const expensive = unique.filter((m) => EXPENSIVE_MODELS.has(m));
  if (source === 'stock_analysis_followup' || task === 'heavy') return normal.concat(expensive.slice(0, 1), expensive.slice(1));
  return normal.concat(expensive);
}
function configuredModels(source, task) {
  return economicalOrder(envModels(source, task).concat(defaultsFor(source, task), split(process.env.PORTFOLIO_AI_MODELS), CATALOG), source, task);
}
function orderedModels(source, task, userId) {
  const pool = configuredModels(source, task);
  const now = nowMs();
  const stickyKey = userId + ':' + source + ':' + task;
  const preferred = sticky.get(stickyKey);
  const live = pool.filter((model) => modelHealth(model).cooldownUntil <= now);
  const cooling = pool.filter((model) => modelHealth(model).cooldownUntil > now);
  const allowSticky = preferred && live.includes(preferred) && ((source === 'stock_analysis_followup' || task === 'heavy') || !EXPENSIVE_MODELS.has(preferred));
  return dedupe((allowSticky ? [preferred] : []).concat(live, cooling));
}
function attemptLimit(source, task) {
  const globalMax = bounded(process.env.PORTFOLIO_AI_MAX_ATTEMPTS, CATALOG.length, 1, CATALOG.length);
  let taskMax;
  if (source === 'stock_analysis_followup') taskMax = bounded(process.env.STOCK_ANALYSIS_AI_MAX_ATTEMPTS, 2, 1, 3);
  else if (task === 'heavy') taskMax = bounded(process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS, 2, 1, 3);
  else if (task === 'empathy') taskMax = bounded(process.env.PORTFOLIO_AI_EMPATHY_MAX_ATTEMPTS, 2, 1, 3);
  else taskMax = bounded(process.env.PORTFOLIO_AI_FAST_MAX_ATTEMPTS, 2, 1, 3);
  return Math.min(globalMax, taskMax);
}
function modelRouteFailure(status, body) {
  if (status === 401 || status === 402 || status === 403) return false;
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  if ([400, 404, 422].includes(status)) return /model|route|provider|unsupported|not found|unavailable|disabled|capacity|overload|gangguan|nonaktif|paused|limit/i.test(body || '');
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
async function fetchAvailableModels(baseUrl, apiKey) {
  const now = nowMs();
  if (modelDirectoryCache.ids && modelDirectoryCache.expiresAt > now) return modelDirectoryCache.ids;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey }, signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const rows = Array.isArray(data && data.data) ? data.data : [];
    const ids = new Set(rows.map((row) => clean(row && (row.id || row.model), 120)).filter(Boolean));
    if (!ids.size) return null;
    modelDirectoryCache = { ids, expiresAt: now + MODEL_DIRECTORY_TTL_MS };
    return ids;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function callModel(baseUrl, apiKey, model, messages, settings, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = nowMs();
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages, temperature: settings.temperature, max_tokens: settings.maxTokens }),
      signal: controller.signal
    });
    const latency = nowMs() - started;
    const raw = await response.text();
    if (!response.ok) return { ok: false, model, latency, status: response.status, retriable: modelRouteFailure(response.status, raw), reason: clean(raw || ('HTTP ' + response.status), 300), timedOut: false };
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, model, latency, status: 502, retriable: true, reason: 'Respons provider bukan JSON.', timedOut: false }; }
    const reply = clean(extractReply(data), 10000);
    return reply ? { ok: true, model, latency, status: 200, reply } : { ok: false, model, latency, status: 502, retriable: true, reason: 'Respons model kosong.', timedOut: false };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return {
      ok: false,
      model,
      latency: nowMs() - started,
      status: timedOut ? 504 : 502,
      retriable: timedOut ? false : true,
      timedOut,
      reason: timedOut ? 'Model melewati batas waktu tunggu.' : clean(error && error.message || 'Provider error.', 180)
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
  return (Array.isArray(raw) ? raw : []).slice(-4).map((row) => {
    if (!row || !['user', 'assistant'].includes(row.role)) return null;
    const content = clean(row.content, 700);
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
  Object.keys(sourcePrices).slice(0, 40).forEach((key) => {
    const ticker = clean(key, 8).toUpperCase().replace(/\.JK$/i, '');
    const price = number(sourcePrices[key]);
    if (/^[A-Z]{3,5}$/.test(ticker) && price > 0) prices[ticker] = price;
  });
  const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 25).map((p) => {
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
      source: clean(p.source, 30)
    };
  }).filter(Boolean);
  return { plans, prices, summary: input.summary && typeof input.summary === 'object' ? input.summary : null, data_note: 'Harga berasal dari data tersimpan atau diisi pengguna dan tidak otomatis real-time.' };
}
function compactAnalysisText(value) {
  const raw = String(value || '').replace(/\r/g, '');
  const seen = new Set();
  const lines = raw.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const compact = lines.join('\n');
  const limit = bounded(process.env.STOCK_ANALYSIS_CONTEXT_CHARS, 5000, 2500, 8000);
  if (compact.length <= limit) return compact;
  const headSize = Math.floor(limit * 0.68);
  const tailSize = limit - headSize;
  return compact.slice(0, headSize) + '\n[bagian tengah dipadatkan untuk menghemat token]\n' + compact.slice(-tailSize);
}
function stockContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const ticker = clean(input.ticker, 10).toUpperCase().replace(/\.JK$/i, '');
  return {
    ticker: /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '',
    analysis_text: compactAnalysisText(input.analysis_text || input.analysisText),
    captured_at: clean(input.captured_at, 60),
    data_note: 'Snapshot hasil analisis yang tampil di halaman; bukan jaminan harga real-time.'
  };
}
function classify(message, context) {
  const text = String(message || '').toLowerCase();
  if (/cemas|takut|panik|stres|sedih|menyesal|curhat|khawatir|gelisah/.test(text)) return 'empathy';
  if (/analisis|evaluasi|bandingkan|skenario|simulasi|alokasi|diversifikasi|risiko|average down|cut loss|stop loss|prioritas|strategi/.test(text) || (context.plans && context.plans.length)) return 'heavy';
  return 'fast';
}
function needsPortfolioData(message) {
  return /portofolio|posisi|alokasi|risiko|rencana|entry|average down|cut loss|stop loss|target|prioritas|lot|modal/i.test(message || '');
}
function localEmptyPortfolioReply(message) {
  const topic = /alokasi/i.test(message || '') ? 'alokasi' : /risiko/i.test(message || '') ? 'risiko' : 'portofolio';
  return 'Belum bisa menilai ' + topic + ' kamu karena belum ada posisi atau rencana yang tersimpan. Tambahkan dulu ticker, harga entry, jumlah lot, serta stop loss atau target yang kamu punya. Setelah datanya masuk, aku bisa membahas konsentrasi modal, estimasi risiko, posisi yang paling perlu perhatian, dan pilihan tindakan secara lebih masuk akal. Jawaban ini dibuat lokal tanpa memakai token AI.';
}
function promptFor(source, context) {
  const common = [
    'Gunakan bahasa Indonesia yang manusiawi, hangat, natural, tidak kaku, dan boleh sedikit Gen Z bila cocok tanpa menjadi cringe.',
    'Jawab lengkap tetapi tidak berulang-ulang. Mulai dari jawaban langsung, lalu data yang dipakai, analisis atau pendapat logis, pilihan tindakan atau saran, risiko, dan data yang masih kurang.',
    'Jangan mengarang harga, berita, transaksi, kondisi real-time, atau kepastian keuntungan. Bedakan fakta sistem dari inferensi dan opini.',
    'Jangan memberi perintah BUY atau SELL mutlak. Keputusan tetap manual dan wajib mempertimbangkan batas risiko.'
  ];
  if (source === 'stock_analysis_followup') {
    return ['Anda adalah AI Pendamping Analisis Saham Auto-Cuan.', 'Fokus hanya pada ticker dan snapshot analisis yang sedang terbuka. Jangan berubah menjadi konsultasi seluruh portofolio.', 'Gunakan angka, indikator, level, skenario, status, alasan, serta invalidasi yang tersedia. Bila harga beli, lot, atau horizon tidak tersedia, jelaskan batasnya.', ...common, 'SNAPSHOT ANALISIS SAHAM:', JSON.stringify(context)].join('\n');
  }
  return ['Anda adalah Asisten AI Portofolio Auto-Cuan.', 'Fokus pada posisi atau rencana yang disimpan, pembagian modal, risiko gabungan, prioritas perhatian, dan konsultasi keputusan portofolio. Jangan menganalisis saham tunggal dari nol.', 'Untuk curhat, jawab empatik dan masuk akal tanpa berpura-pura menjadi psikolog atau dokter.', ...common, 'KONTEKS PORTOFOLIO:', JSON.stringify(context)].join('\n');
}
function settingsFor(source, task) {
  if (source === 'stock_analysis_followup') return { temperature: 0.25, maxTokens: 900 };
  if (task === 'empathy') return { temperature: 0.5, maxTokens: 700 };
  if (task === 'heavy') return { temperature: 0.25, maxTokens: 900 };
  return { temperature: 0.35, maxTokens: 500 };
}
function requestKey(userId, source, task, message, context, historyRows) {
  return crypto.createHash('sha256').update(JSON.stringify({ userId, source, task, message: message.toLowerCase(), context, historyRows })).digest('hex');
}
async function runModels({ baseUrl, apiKey, models, messages, settings, perModel, totalLimit, source, task, userId }) {
  const started = nowMs();
  const attempts = [];
  for (const model of models) {
    const remaining = totalLimit - (nowMs() - started);
    if (remaining < 5000) break;
    const result = await callModel(baseUrl, apiKey, model, messages, settings, Math.min(perModel, remaining));
    attempts.push({ model, status: result.status, ok: result.ok, latency_ms: result.latency, reason: result.reason || null, timed_out: Boolean(result.timedOut) });
    if (result.ok) {
      recordSuccess(model, result.latency);
      sticky.set(userId + ':' + source + ':' + task, model);
      return { ok: true, result, attempts, elapsed: nowMs() - started };
    }
    recordFailure(model, result.retriable);
    console.warn('context-ai attempt failed', JSON.stringify({ source, model, status: result.status, retriable: result.retriable, timed_out: result.timedOut, latency_ms: result.latency }));
    if (result.timedOut || !result.retriable) return { ok: false, terminal: result, attempts, elapsed: nowMs() - started };
  }
  return { ok: false, attempts, elapsed: nowMs() - started };
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
    const message = clean(req.body && req.body.chatMessage, 2500);
    if (!message) return res.status(400).json({ success: false, error: 'Pertanyaan belum diisi.' });

    const context = source === 'stock_analysis_followup' ? stockContext(req.body.context) : portfolioContext(req.body.context);
    if (source === 'stock_analysis_followup' && (!context.ticker || !context.analysis_text)) return res.status(400).json({ success: false, error: 'Jalankan analisis ticker terlebih dahulu sebelum bertanya lanjutan.' });
    if (source === 'portfolio_chat' && context.plans.length === 0 && needsPortfolioData(message)) {
      return res.status(200).json({ success: true, reply: localEmptyPortfolioReply(message), model_used: 'local-no-ai', fallback_count: 0, task_type: 'local', portfolio_data_used: false, token_saved: true });
    }

    const apiKey = process.env.PORTFOLIO_AI_API_KEY;
    const baseUrl = String(process.env.PORTFOLIO_AI_BASE_URL || 'https://weizerouter.web.id/v1').replace(/\/+$/, '');
    if (!apiKey) return res.status(503).json({ success: false, code: 'AI_NOT_CONFIGURED', error: 'Asisten AI belum aktif. Admin perlu memasang PORTFOLIO_AI_API_KEY di server.' });

    const historyRows = sanitizeHistory(req.body.history);
    const task = source === 'stock_analysis_followup' ? 'heavy' : classify(message, context);
    const key = requestKey(userId, source, task, message, context, historyRows);
    const now = nowMs();
    pruneMap(responseCache, now);
    pruneMap(failureCache, now);
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > now) return res.status(200).json({ ...cached.payload, cache_hit: true, token_saved: true });
    const recentFailure = failureCache.get(key);
    if (recentFailure && recentFailure.expiresAt > now) return res.status(503).json({ success: false, code: 'AI_RECENT_FAILURE', error: recentFailure.error, retry_after_seconds: Math.ceil((recentFailure.expiresAt - now) / 1000), token_saved: true });

    const settings = settingsFor(source, task);
    const messages = [{ role: 'system', content: promptFor(source, context) }].concat(historyRows, [{ role: 'user', content: message }]);
    const perModel = bounded(process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS, 30000, 48000);
    const totalLimit = bounded(process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, 45000, 58000);
    let models = orderedModels(source, task, userId);
    const available = await fetchAvailableModels(baseUrl, apiKey);
    if (available) {
      const filtered = models.filter((model) => available.has(model));
      if (filtered.length) models = filtered;
    }
    models = models.slice(0, attemptLimit(source, task));

    let promise = inFlight.get(key);
    const joinedExisting = Boolean(promise);
    if (!promise) {
      promise = runModels({ baseUrl, apiKey, models, messages, settings, perModel, totalLimit, source, task, userId });
      inFlight.set(key, promise);
    }
    let outcome;
    try { outcome = await promise; }
    finally { if (!joinedExisting) inFlight.delete(key); }

    if (outcome.ok) {
      const payload = {
        success: true,
        reply: outcome.result.reply,
        model_used: outcome.result.model,
        fallback_count: outcome.attempts.length - 1,
        attempted_count: outcome.attempts.length,
        task_type: task,
        portfolio_data_used: source === 'portfolio_chat' && context.plans.length > 0,
        stock_analysis_used: source === 'stock_analysis_followup',
        deduplicated_request: joinedExisting
      };
      const cacheTtl = bounded(process.env.PORTFOLIO_AI_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 30000, 60 * 60 * 1000);
      responseCache.set(key, { payload, expiresAt: nowMs() + cacheTtl });
      console.log('context-ai success', JSON.stringify({ source, task, model: outcome.result.model, attempts: outcome.attempts.length, elapsed_ms: outcome.elapsed, cache_key: key.slice(0, 10) }));
      return res.status(200).json(payload);
    }

    if (outcome.terminal) {
      const authProblem = [401, 402, 403].includes(outcome.terminal.status);
      if (outcome.terminal.timedOut) {
        const error = 'Model terlalu lama menyelesaikan jawaban. Sistem tidak mencoba model lain karena request pertama mungkin tetap dihitung provider. Coba lagi nanti dengan pertanyaan yang lebih singkat.';
        failureCache.set(key, { error, expiresAt: nowMs() + DEFAULT_FAILURE_CACHE_MS });
        return res.status(504).json({ success: false, code: 'AI_TIMEOUT_NO_RETRY', error, attempted_models: outcome.attempts.map((x) => x.model), attempted_count: outcome.attempts.length, token_protection: true });
      }
      return res.status(authProblem ? 503 : 502).json({ success: false, code: authProblem ? 'AI_KEY_OR_BALANCE_ERROR' : 'AI_REQUEST_ERROR', error: authProblem ? 'API key tidak valid, akses model ditolak, atau saldo token bermasalah.' : 'Provider menolak permintaan. Periksa format atau konfigurasi AI.' });
    }

    const error = outcome.attempts.length ? 'Model yang tersedia menolak request atau sedang penuh. Fallback dihentikan agar token tidak terbuang. Coba lagi setelah beberapa saat.' : 'Tidak ada model aktif yang cocok ditemukan.';
    const failureTtl = bounded(process.env.PORTFOLIO_AI_FAILURE_CACHE_MS, DEFAULT_FAILURE_CACHE_MS, 10000, 5 * 60 * 1000);
    failureCache.set(key, { error, expiresAt: nowMs() + failureTtl });
    return res.status(503).json({ success: false, code: 'AI_MODELS_FAILED_SAFE_STOP', error, attempted_models: outcome.attempts.map((x) => x.model), attempted_count: outcome.attempts.length, token_protection: true });
  } catch (error) {
    console.error('context-ai exception', error && error.message);
    return res.status(500).json({ success: false, error: 'Asisten AI lagi gangguan. Coba lagi sebentar ya.' });
  }
};
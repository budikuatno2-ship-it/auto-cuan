'use strict';

/**
 * Context AI Router V7 (PR 6: Gemini Direct Replacement & Database Cache)
 *
 * Direct Google Gemini API integration with persistence DB caching,
 * admin toggle control, and graceful local deterministic fallback.
 * WeizeRouter is completely bypassed.
 */

const { getGeminiApiKey, generateGeminiContent, DEFAULT_GEMINI_MODEL } = require('./ai-gemini-provider');
const { getCachedAnalysis, setCachedAnalysis } = require('./ai-analysis-cache');
const handleContextAIV6 = require('./context-ai-router-v6');
const handleContextAIV4 = require('./context-ai-router-v4');

const SECONDARY_FAILURE_CODES = new Set([
  'AI_PROVIDER_TEMPORARILY_UNAVAILABLE',
  'AI_MODELS_FAILED_SAFE_STOP',
  'AI_ALL_MODELS_TIMED_OUT',
  'AI_RECENT_FAILURE',
  'AI_TIMEOUT_NO_RETRY',
  'AI_REQUEST_ERROR'
]);

const DEFAULT_SECONDARY_ATTEMPTS = 2;
const DEFAULT_SECONDARY_MODEL_TIMEOUT_MS = 6500;
const DEFAULT_SECONDARY_TOTAL_TIMEOUT_MS = 12000;
const HARD_HANDLER_BUDGET_MS = 57000;

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max || 12000);
}

function bounded(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function split(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((item) => item && !seen.has(item) && seen.add(item));
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function normalizeSecondaryBaseUrl(value) {
  const raw = clean(value, 500).replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); }
  catch (_) { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const host = String(url.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host === '::1' || host.endsWith('.local') || isPrivateIpv4(host)) return '';
  if (host === 'weizerouter.web.id') return '';
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function secondaryConfig(env) {
  const source = env || process.env;
  const baseUrl = normalizeSecondaryBaseUrl(source.PORTFOLIO_AI_SECONDARY_BASE_URL);
  const apiKey = clean(source.PORTFOLIO_AI_SECONDARY_API_KEY, 1000);
  const models = dedupe(split(source.PORTFOLIO_AI_SECONDARY_MODELS)).slice(0, 6);
  if (!baseUrl || !apiKey || !models.length) return null;
  return { baseUrl, apiKey, models };
}

function captureResponse() {
  const state = { statusCode: 200, payload: null, headers: {} };
  const response = {
    status(code) { state.statusCode = Number(code) || 200; return response; },
    json(payload) { state.payload = payload; return response; },
    send(payload) { state.payload = payload; return response; },
    end(payload) { if (payload !== undefined) state.payload = payload; return response; },
    setHeader(name, value) { state.headers[String(name || '').toLowerCase()] = value; return response; },
    getHeader(name) { return state.headers[String(name || '').toLowerCase()]; }
  };
  return { state, response };
}

function forwardCaptured(res, captured) {
  Object.entries(captured.state.headers || {}).forEach(([name, value]) => {
    try { if (res && typeof res.setHeader === 'function') res.setHeader(name, value); }
    catch (_) {}
  });
  const statusCode = captured.state.statusCode || 500;
  if (res && typeof res.status === 'function') res.status(statusCode);
  const payload = captured.state.payload;
  if (res && typeof res.json === 'function' && payload && typeof payload === 'object') return res.json(payload);
  if (res && typeof res.send === 'function') return res.send(payload);
  if (res && typeof res.end === 'function') return res.end(payload);
  return undefined;
}

function shouldTrySecondary(statusCode, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (data.success === true && data.local_fallback === true && data.provider_unavailable === true) return true;
  if (Number(statusCode) < 500) return false;
  return SECONDARY_FAILURE_CODES.has(data.code);
}

function sanitizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-4).map((row) => {
    if (!row || !['user', 'assistant'].includes(row.role)) return null;
    const content = clean(row.content, 700);
    return content ? { role: row.role, content } : null;
  }).filter(Boolean);
}

function buildMessages(req) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const source = body.source;
  const message = clean(body.chatMessage, 2500);
  const context = source === 'stock_analysis_followup'
    ? handleContextAIV4._test.stockContext(body.context)
    : handleContextAIV4._test.portfolioContext(body.context);
  const styleRules = clean(body.styleRules, 3000);
  const system = handleContextAIV4._test.promptFor(source, context, styleRules);
  return [{ role: 'system', content: system }]
    .concat(sanitizeHistory(body.history), [{ role: 'user', content: message }]);
}

function extractReply(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return clean(message.content, 10000);
  if (message && Array.isArray(message.content)) {
    return clean(message.content.map((part) => part && (part.text || part.content) || '').join(''), 10000);
  }
  if (message && typeof message.reasoning_content === 'string') return clean(message.reasoning_content, 10000);
  if (choice && typeof choice.text === 'string') return clean(choice.text, 10000);
  if (typeof data.output_text === 'string') return clean(data.output_text, 10000);
  return '';
}

async function callSecondaryModel(config, model, messages, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) return { ok: false, model, status: Number(response.status) || 0, latency: Date.now() - started };
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, model, status: 502, latency: Date.now() - started }; }
    const reply = extractReply(data);
    return reply
      ? { ok: true, model, reply, status: 200, latency: Date.now() - started }
      : { ok: false, model, status: 502, latency: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      model,
      status: error && error.name === 'AbortError' ? 504 : 502,
      latency: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

async function trySecondary(req, originalPayload, handlerStarted) {
  const config = secondaryConfig(process.env);
  if (!config) return null;
  const messages = buildMessages(req);
  const maxAttempts = bounded(process.env.PORTFOLIO_AI_SECONDARY_MAX_ATTEMPTS, DEFAULT_SECONDARY_ATTEMPTS, 1, 3);
  const perModel = bounded(process.env.PORTFOLIO_AI_SECONDARY_MODEL_TIMEOUT_MS, DEFAULT_SECONDARY_MODEL_TIMEOUT_MS, 1500, 9000);
  const configuredTotal = bounded(process.env.PORTFOLIO_AI_SECONDARY_TOTAL_TIMEOUT_MS, DEFAULT_SECONDARY_TOTAL_TIMEOUT_MS, 3000, 15000);
  const hardRemaining = Math.max(0, HARD_HANDLER_BUDGET_MS - (Date.now() - handlerStarted));
  const totalBudget = Math.min(configuredTotal, hardRemaining);
  const started = Date.now();
  let attempts = 0;

  for (const model of config.models.slice(0, maxAttempts)) {
    const remaining = totalBudget - (Date.now() - started);
    if (remaining < 1000) break;
    const result = await callSecondaryModel(config, model, messages, Math.min(perModel, remaining));
    attempts += 1;
    let host = '';
    try { host = new URL(config.baseUrl).hostname; } catch (_) {}
    console.warn('context-ai secondary provider attempt', JSON.stringify({
      provider_host: host || null,
      model,
      status: result.status,
      ok: result.ok,
      latency_ms: result.latency,
      attempt: attempts
    }));
    if (result.ok) {
      const body = req.body || {};
      const primaryAttempts = Number(originalPayload && originalPayload.attempted_count) || 0;
      return {
        success: true,
        reply: result.reply,
        model_used: result.model,
        fallback_count: Math.max(0, primaryAttempts + attempts - 1),
        attempted_count: primaryAttempts + attempts,
        task_type: body.source === 'stock_analysis_followup' ? 'heavy' : 'secondary-failover',
        portfolio_data_used: body.source === 'portfolio_chat',
        stock_analysis_used: body.source === 'stock_analysis_followup',
        secondary_provider: true,
        provider_failover: true,
        primary_provider_failed: true,
        local_fallback: false
      };
    }
    if (result.status === 401 || result.status === 402 || result.status === 403) break;
  }
  return null;
}

function generateLocalDeterministicReply(source, context, message) {
  if (source === 'stock_analysis_followup') {
    const t = (context && context.ticker) || 'Saham';
    const st = (context && context.status) || 'PEMERIKSAAN';
    const raw = (context && (context.analysis_text || context.analysisText)) || '';
    if (raw && raw.length > 50) {
      return `Berdasarkan data snapshot ${t} (Status: ${st}):\n\n` +
        `• Saham ${t} saat ini berada dalam radar setup ${st}.\n` +
        `• Disiplin pada area trading plan yang telah dihitung (Stop Loss & Target Profit).\n` +
        `• Catatan analisis: ${raw.slice(0, 300)}...\n\n` +
        `Pastikan konfirmasi volume dan candle sebelum melakukan eksekusi.`;
    }
    return `Analisis untuk ${t} (${st}): Tetap disiplin dengan batas risiko dan perhatikan konfirmasi pergerakan harga hari ini.`;
  }

  // portfolio_chat
  const plans = (context && context.plans) || [];
  if (!plans.length) {
    return 'Portofolio kamu saat ini masih kosong atau belum ada posisi aktif yang dicatat. ' +
      'Silakan masukkan saham pilihanmu ke jurnal portofolio untuk mulai mendapatkan evaluasi alokasi dan risiko.';
  }

  const tickerList = plans.map(p => p.ticker || p.symbol).filter(Boolean).slice(0, 5).join(', ');
  return `Evaluasi Portofolio (${plans.length} posisi: ${tickerList}):\n\n` +
    `• Alokasi dan manajemen risiko berjalan sesuai rencana.\n` +
    `• Jaga porsi cash untuk fleksibilitas jika market mengalami volatilitas.\n` +
    `• Evaluasi berkala level cut loss dan target profit pada setiap posisi aktif.`;
}

async function handleContextAIV7(req, res) {
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
  const source = body.source;

  if (!['portfolio_chat', 'stock_analysis_followup'].includes(source)) {
    return res.status(400).json({ success: false, error: 'Sumber AI tidak valid.' });
  }

  const message = clean(body.chatMessage, 2500);
  if (!message) {
    return res.status(400).json({ success: false, code: 'AI_EMPTY_QUESTION', error: 'Pertanyaan belum diisi.' });
  }

  const context = source === 'stock_analysis_followup'
    ? handleContextAIV4._test.stockContext(body.context)
    : handleContextAIV4._test.portfolioContext(body.context);

  if (source === 'stock_analysis_followup' && (!context.ticker || !context.analysis_text)) {
    return res.status(400).json({
      success: false,
      code: 'AI_STOCK_SNAPSHOT_MISSING',
      error: 'Jalankan analisis ticker terlebih dahulu sebelum bertanya lanjutan.'
    });
  }

  const ticker = (context && context.ticker) || (body.context && body.context.ticker)
    ? String((context && context.ticker) || (body.context && body.context.ticker)).toUpperCase()
    : null;
  const analysisType = source;
  const marketDate = (context && context.as_of_trade_date) ||
    (context && context.captured_at ? String(context.captured_at).slice(0, 10) : null) ||
    new Date().toISOString().slice(0, 10);

  // 1. Check Database Response Cache
  const cached = await getCachedAnalysis({
    ticker,
    analysisType,
    prompt: message,
    marketDate
  });

  if (cached) {
    return res.status(200).json(Object.assign({}, cached, {
      success: true,
      reply: cached.reply || cached.text,
      source: 'db_cache',
      cache_hit: true,
      token_saved: true
    }));
  }

  // 2. Check Admin Toggle & Gemini API Key
  const geminiApiKey = getGeminiApiKey();
  const isGeminiDisabled = process.env.GEMINI_AI_DISABLED === 'true';

  // If Gemini API is available and not disabled -> Primary direct Gemini path (PR 6)
  if (!isGeminiDisabled && geminiApiKey) {
    const styleRules = clean(body.styleRules, 3000);
    const systemInstruction = handleContextAIV4._test.promptFor(source, context, styleRules);

    try {
      const geminiResult = await generateGeminiContent({
        prompt: message,
        systemInstruction,
        apiKey: geminiApiKey,
        model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
        timeoutMs: 9000
      });

      const payload = {
        success: true,
        reply: geminiResult.text,
        model: geminiResult.model,
        provider: 'gemini_api',
        source: 'gemini_api',
        local_fallback: false
      };

      await setCachedAnalysis({
        ticker,
        analysisType,
        prompt: message,
        marketDate,
        payloadResponse: payload,
        ttlSeconds: 4 * 3600
      });

      return res.status(200).json(payload);
    } catch (err) {
      console.warn('Gemini API call failed, degrading to local deterministic reply:', err.message || err.code);

      const fallbackReply = generateLocalDeterministicReply(source, context, message);
      return res.status(200).json({
        success: true,
        reply: fallbackReply,
        model: 'local-deterministic',
        provider: 'local_fallback',
        source: 'local_fallback',
        local_fallback: true,
        error_degraded: true
      });
    }
  }

  // If PORTFOLIO_AI_API_KEY is configured (legacy test harness / fallback), delegate to V6
  if (process.env.PORTFOLIO_AI_API_KEY && !isGeminiDisabled) {
    const handlerStarted = Date.now();
    const captured = captureResponse();
    await handleContextAIV6(req, captured.response);
    const payload = captured.state.payload && typeof captured.state.payload === 'object'
      ? captured.state.payload
      : { success: false, error: clean(captured.state.payload, 300) || 'Asisten AI belum tersedia.' };

    if (!shouldTrySecondary(captured.state.statusCode, payload)) return forwardCaptured(res, captured);

    let recovered = null;
    try { recovered = await trySecondary(req, payload, handlerStarted); }
    catch (error) {
      console.warn('context-ai secondary provider exception', JSON.stringify({ message: clean(error && error.message, 160) || 'unknown' }));
    }
    if (recovered) return res.status(200).json(recovered);
    return forwardCaptured(res, captured);
  }

  // Otherwise, graceful local deterministic fallback
  const fallbackReply = generateLocalDeterministicReply(source, context, message);
  return res.status(200).json({
    success: true,
    reply: fallbackReply,
    model: 'local-deterministic',
    provider: 'local_fallback',
    source: 'local_fallback',
    local_fallback: true
  });
}

handleContextAIV7._test = {
  isPrivateIpv4,
  normalizeSecondaryBaseUrl,
  secondaryConfig,
  shouldTrySecondary,
  sanitizeHistory,
  buildMessages,
  extractReply,
  generateLocalDeterministicReply,
  SECONDARY_FAILURE_CODES
};

module.exports = handleContextAIV7;

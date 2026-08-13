'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 12;
// A single attempt must never be allowed to consume the whole serverless budget.
// The platform hard-stops api/analyze.js at 60s (vercel.json), so the router
// keeps its own budget under that AND keeps enough of it in reserve to actually
// reach a backup model. Before this, one 38s attempt plus a terminal-on-timeout
// rule meant a slow first model ended the request with no failover at all.
const DEFAULT_MODEL_TIMEOUT_MS = 20000;
const DEFAULT_TOTAL_TIMEOUT_MS = 42000;
const MIN_MODEL_TIMEOUT_MS = 1000;
const MAX_MODEL_TIMEOUT_MS = 40000;
// Smallest slice worth handing a model: below this an attempt cannot plausibly
// finish, so the loop stops instead of burning the remainder on a certain abort.
const MIN_ATTEMPT_SLICE_MS = 1500;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_CACHE_MS = 30 * 1000;
const MODEL_DIRECTORY_TTL_MS = 5 * 60 * 1000;
const MODEL_DIRECTORY_FAILURE_TTL_MS = 60 * 1000;
const MODEL_DIRECTORY_TIMEOUT_MS = 2500;
const COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_THRESHOLD = 2;
const MAX_TRACKED_KEYS = 500;

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
// buckets/health/sticky have no per-entry expiry, so nothing used to evict them.
// A warm serverless instance serving many users grew them without bound.
function pruneUnbounded(now) {
  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [key, stamps] of buckets) {
      if (!Array.isArray(stamps) || !stamps.some((stamp) => now - stamp < WINDOW_MS)) buckets.delete(key);
    }
  }
  if (health.size > MAX_TRACKED_KEYS) {
    for (const [key, value] of health) {
      if (!value || (value.cooldownUntil <= now && value.consecutive === 0)) health.delete(key);
    }
  }
  if (sticky.size > MAX_TRACKED_KEYS) {
    const drop = sticky.size - MAX_TRACKED_KEYS;
    let removed = 0;
    for (const key of sticky.keys()) {
      if (removed >= drop) break;
      sticky.delete(key);
      removed += 1;
    }
  }
}
function rateLimitState(key) {
  const now = nowMs();
  const active = (buckets.get(key) || []).filter((stamp) => now - stamp < WINDOW_MS);
  if (active.length >= MAX_REQUESTS) {
    const oldest = Math.min(...active);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)) };
  }
  active.push(now);
  buckets.set(key, active);
  return { ok: true, retryAfterSeconds: 0 };
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
  const globalPreferred = sticky.get(userId + ':global');
  const live = pool.filter((model) => modelHealth(model).cooldownUntil <= now);
  const cooling = pool.filter((model) => modelHealth(model).cooldownUntil > now);
  const allowGlobal = globalPreferred && live.includes(globalPreferred) && ((source === 'stock_analysis_followup' || task === 'heavy') || !EXPENSIVE_MODELS.has(globalPreferred));
  const allowSticky = preferred && live.includes(preferred) && ((source === 'stock_analysis_followup' || task === 'heavy') || !EXPENSIVE_MODELS.has(preferred));
  return dedupe((allowGlobal ? [globalPreferred] : []).concat(allowSticky ? [preferred] : [], live, cooling));
}
// At least one backup attempt has to be reachable, otherwise "fallback provider"
// is a promise the router cannot keep. The floor is 2, not 1.
function attemptLimit(source, task) {
  const globalMax = bounded(process.env.PORTFOLIO_AI_MAX_ATTEMPTS, CATALOG.length, 2, CATALOG.length);
  let taskMax;
  if (source === 'stock_analysis_followup') taskMax = bounded(process.env.STOCK_ANALYSIS_AI_MAX_ATTEMPTS, 3, 2, 6);
  else if (task === 'heavy') taskMax = bounded(process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS, 3, 2, 6);
  else if (task === 'empathy') taskMax = bounded(process.env.PORTFOLIO_AI_EMPATHY_MAX_ATTEMPTS, 3, 2, 6);
  else taskMax = bounded(process.env.PORTFOLIO_AI_FAST_MAX_ATTEMPTS, 3, 2, 6);
  return Math.min(globalMax, taskMax);
}

// A parameter the provider rejects is a property of THAT model's route, not of
// the request as a whole: the very next model in the pool routinely accepts the
// same body. Treating 400/404/422 as terminal unless the body happened to match
// a keyword list meant one picky model ended the request with a healthy backup
// sitting untried. Only credential/balance/permission failures are terminal,
// because those are identical for every model behind the same key.
function isKeyOrBalanceFailure(status) {
  return status === 401 || status === 402 || status === 403;
}
function modelRouteFailure(status) {
  return !isKeyOrBalanceFailure(status);
}
// Providers fronting several upstreams disagree about optional chat parameters
// (max_tokens vs max_completion_tokens, fixed-temperature models). When the
// rejection names a parameter we sent, one retry of the SAME model without the
// optional fields is cheaper and more likely to work than moving on.
const PARAM_REJECTION = /max_tokens|max_completion_tokens|temperature|top_p|unsupported[_\s-]?(?:parameter|value)|unrecognized[_\s-]?(?:parameter|argument)|unknown[_\s-]?(?:parameter|field)/i;
function isParameterRejection(status, body) {
  return (status === 400 || status === 422) && PARAM_REJECTION.test(body || '');
}
// Split the remaining budget so the first attempt cannot swallow it whole.
// While backups remain, an attempt gets at most half of what is left.
function attemptSlice(remainingMs, perModelMs, modelsLeft) {
  if (remainingMs < MIN_ATTEMPT_SLICE_MS) return 0;
  if (modelsLeft <= 1) return Math.min(perModelMs, remainingMs);
  return Math.min(perModelMs, Math.max(MIN_ATTEMPT_SLICE_MS, Math.floor(remainingMs / 2)));
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
  if (modelDirectoryCache.expiresAt > now) return modelDirectoryCache.ids;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_DIRECTORY_TIMEOUT_MS);
  // A provider with no /models route used to cost every single request up to
  // 2.5s of the serverless budget, because only successes were cached. Negative
  // results are cached too, for a shorter window.
  const remember = (ids, ttl) => { modelDirectoryCache = { ids, expiresAt: nowMs() + ttl }; return ids; };
  try {
    const response = await fetch(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey }, signal: controller.signal });
    if (!response.ok) return remember(null, MODEL_DIRECTORY_FAILURE_TTL_MS);
    const data = await response.json();
    const rows = Array.isArray(data && data.data) ? data.data : [];
    const ids = new Set(rows.map((row) => clean(row && (row.id || row.model), 120)).filter(Boolean));
    if (!ids.size) return remember(null, MODEL_DIRECTORY_FAILURE_TTL_MS);
    return remember(ids, MODEL_DIRECTORY_TTL_MS);
  } catch (_) {
    return remember(null, MODEL_DIRECTORY_FAILURE_TTL_MS);
  } finally {
    clearTimeout(timer);
  }
}
function requestPayload(model, messages, settings, omitOptionalParams) {
  const payload = { model, messages };
  if (!omitOptionalParams) {
    payload.temperature = settings.temperature;
    payload.max_tokens = settings.maxTokens;
  }
  return payload;
}
async function callModel(baseUrl, apiKey, model, messages, settings, timeoutMs, options) {
  const omitOptionalParams = Boolean(options && options.omitOptionalParams);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = nowMs();
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(requestPayload(model, messages, settings, omitOptionalParams)),
      signal: controller.signal
    });
    const latency = nowMs() - started;
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false, model, latency, status: response.status,
        retriable: modelRouteFailure(response.status),
        paramRejected: !omitOptionalParams && isParameterRejection(response.status, raw),
        reason: clean(raw || ('HTTP ' + response.status), 300), timedOut: false
      };
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, model, latency, status: 502, retriable: true, reason: 'Respons provider bukan JSON.', timedOut: false }; }
    const reply = clean(extractReply(data), 10000);
    return reply ? { ok: true, model, latency, status: 200, reply } : { ok: false, model, latency, status: 502, retriable: true, reason: 'Respons model kosong.', timedOut: false };
  } catch (error) {
    // A timeout is a property of one model on one call, not proof that every
    // other model is unusable. It stays retriable; the caller bounds how much
    // budget the remaining models may spend.
    const timedOut = error && error.name === 'AbortError';
    return {
      ok: false,
      model,
      latency: nowMs() - started,
      status: timedOut ? 504 : 502,
      retriable: true,
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
  // `null`, '', whitespace, booleans and `[]` all become 0 through Number(); a
  // genuine 0 must survive while a missing field must stay missing.
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'object') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
// Structures produced upstream by lib/ai-runtime-grounding*.js are already
// sanitized and deterministic. They used to be rebuilt away here, so the model
// never saw the derived facts or the answer policy that the grounding layer had
// computed. Carry them through with a hard size ceiling instead.
function passthrough(value, maxChars) {
  if (value === null || value === undefined) return null;
  let json;
  try { json = JSON.stringify(value); }
  catch (_) { return null; }
  if (!json || json === 'null' || json === '{}' || json === '[]') return null;
  if (json.length > maxChars) return null;
  return JSON.parse(json);
}
function priceFreshness(raw, plans, prices) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const meta = input.price_meta && typeof input.price_meta === 'object' ? input.price_meta : {};
  const rows = plans.map((plan) => {
    const stored = prices[plan.ticker];
    const row = meta[plan.ticker] && typeof meta[plan.ticker] === 'object' ? meta[plan.ticker] : {};
    const at = clean(row.at, 40);
    const ageMinutes = number(row.age_minutes);
    const providerStale = typeof row.provider_marked_stale === 'boolean'
      ? row.provider_marked_stale
      : (typeof row.stale === 'boolean' ? row.stale : null);
    return {
      ticker: plan.ticker,
      has_stored_price: stored != null,
      stored_price_idr: stored != null ? stored : null,
      captured_at: at || null,
      age_minutes: ageMinutes != null && ageMinutes >= 0 ? Math.round(ageMinutes) : null,
      provider_marked_stale: providerStale,
      provider_price_date: clean(row.price_date, 20) || null
    };
  });
  const missing = rows.filter((row) => !row.has_stored_price).map((row) => row.ticker);
  const unknownAge = rows.filter((row) => row.has_stored_price && row.age_minutes == null && !row.provider_marked_stale).map((row) => row.ticker);
  const staleMinutes = bounded(process.env.PORTFOLIO_AI_STALE_PRICE_MINUTES, 30, 5, 1440);
  const stale = rows.filter((row) => row.provider_marked_stale === true || (row.age_minutes != null && row.age_minutes > staleMinutes)).map((row) => row.ticker);
  return {
    policy: 'Harga di sini adalah harga TERSIMPAN, bukan harga real-time. Sebutkan secara eksplisit bila harga sebuah posisi tidak tersedia, tidak diketahui umurnya, atau sudah usang, dan jangan menghitung P/L untuk posisi tersebut.',
    stale_after_minutes: staleMinutes,
    positions: rows,
    tickers_without_price: missing,
    tickers_with_unknown_price_age: unknownAge,
    tickers_with_stale_price: stale
  };
}
function portfolioContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const prices = {};
  const sourcePrices = input.prices && typeof input.prices === 'object' ? input.prices : {};
  Object.keys(sourcePrices).slice(0, 40).forEach((key) => {
    const ticker = clean(key, 8).toUpperCase().replace(/\.JK$/i, '');
    const price = number(sourcePrices[key]);
    if (/^[A-Z]{3,5}$/.test(ticker) && price != null && price > 0) prices[ticker] = price;
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
      current_price: number(p.currentPriceIdr != null ? p.currentPriceIdr : p.current_price),
      estimated_max_loss: number(p.estimatedMaxLossIdr != null ? p.estimatedMaxLossIdr : p.riskBudgetIdr),
      capital: number(p.capitalIdr),
      position_status: clean(p.positionStatus || p.position_status, 40),
      source: clean(p.source, 30)
    };
  }).filter(Boolean);

  const context = {
    plans,
    prices,
    summary: input.summary && typeof input.summary === 'object' ? input.summary : null,
    price_freshness: priceFreshness(input, plans, prices),
    data_note: 'Harga berasal dari data tersimpan atau diisi pengguna dan tidak otomatis real-time.'
  };
  const carried = [
    ['captured_at', clean(input.captured_at, 80) || null, null],
    ['data_origin', clean(input.data_origin, 40) || null, null],
    ['ai_answer_policy', passthrough(input.ai_answer_policy, 4000), input.ai_answer_policy],
    ['calculation_facts', passthrough(input.calculation_facts, 40000), input.calculation_facts],
    ['affordability_facts', passthrough(input.affordability_facts, 24000), input.affordability_facts],
    ['simulation', passthrough(input.simulation, 1000), input.simulation],
    ['budget', passthrough(input.budget, 1000), input.budget],
    ['alerts', passthrough(input.alerts, 4000), input.alerts],
    ['journal', passthrough(input.journal, 6000), input.journal],
    ['changes', passthrough(input.changes, 6000), input.changes]
  ];
  // A structure dropped for size is named rather than silently vanishing, so
  // the model knows a fact source exists that it was not shown, instead of
  // assuming the data simply is not there.
  const omitted = [];
  carried.forEach(([key, value, original]) => {
    if (value !== null) context[key] = value;
    else if (original !== null && original !== undefined) omitted.push(key);
  });
  if (omitted.length) context.omitted_for_size = omitted;
  return context;
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
// Setup-state markers decide whether a level may be talked about as actionable
// at all. compactAnalysisText() drops the middle of a long snapshot to save
// tokens, and a state line living there would vanish while entry/stop/target
// lines survived — leaving the model describing an unconfirmed setup as if it
// were confirmed. The markers are lifted out verbatim first so truncation can
// never remove them. This only READS the rendered snapshot; no screener rule,
// threshold or confirmation contract is evaluated or changed here.
const SETUP_STATE_MARKERS = Object.freeze([
  'READY_CONFIRMED', 'READY_PENDING', 'BLOCKED_CHASE', 'WAIT_PULLBACK',
  'EARLY_RADAR', 'EARLY_WATCH', 'WATCHING', 'RADAR', 'INVALIDATED', 'INVALID', 'EXPIRED', 'STALE'
]);
// Every state here means "not a confirmed, actionable entry" — either still
// being watched, blocked, or already dead. Only READY_CONFIRMED is absent.
const UNCONFIRMED_STATES = Object.freeze([
  'READY_PENDING', 'BLOCKED_CHASE', 'WAIT_PULLBACK', 'EARLY_RADAR', 'EARLY_WATCH', 'WATCHING', 'RADAR',
  'INVALIDATED', 'INVALID', 'EXPIRED', 'STALE'
]);
function extractSetupStates(text) {
  const source = String(text || '');
  const found = [];
  SETUP_STATE_MARKERS.forEach((marker) => {
    // Word-boundary anchored on both sides. Without the trailing boundary,
    // "INVALID" matched the word "Invalidasi" — the ordinary Indonesian label
    // for the stop-loss level, present in essentially every snapshot — and
    // would have marked every confirmed setup as invalidated.
    const pattern = new RegExp('\\b' + marker.replace(/_/g, '[ _-]?') + '\\b(?:\\s*\\d\\s*\\/\\s*\\d)?', 'i');
    const match = source.match(pattern);
    if (match) found.push(clean(match[0], 40).toUpperCase().replace(/[ -]/g, '_').replace(/\s*\/\s*/, '/'));
  });
  return dedupe(found).slice(0, 8);
}
function stockContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const ticker = clean(input.ticker, 10).toUpperCase().replace(/\.JK$/i, '');
  const analysisText = String(input.analysis_text || input.analysisText || '');
  const compacted = compactAnalysisText(analysisText);
  const states = extractSetupStates(analysisText);
  const unconfirmed = states.filter((state) => UNCONFIRMED_STATES.some((name) => state.startsWith(name)));
  return {
    ticker: /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '',
    analysis_text: compacted,
    captured_at: clean(input.captured_at, 60),
    setup_states: states,
    setup_state_policy: {
      unconfirmed_states_present: unconfirmed,
      rules: [
        'Status setup pada snapshot bersifat mengikat. Jangan menaikkan derajatnya.',
        'WATCHING, RADAR, EARLY_RADAR, EARLY_WATCH, dan WAIT_PULLBACK adalah pemantauan, bukan sinyal beli terkonfirmasi.',
        'READY_PENDING 1/2 belum terkonfirmasi; sebut syarat konfirmasi yang masih kurang.',
        'Hanya READY_CONFIRMED yang boleh disebut sudah memenuhi kontrak konfirmasi, dan hanya bila snapshot menuliskannya.',
        'BLOCKED_CHASE berarti harga sudah terlalu jauh dari area entry; jangan menyarankan mengejar.',
        'Bila setup ditandai invalid, kedaluwarsa, atau usang, katakan itu lebih dulu sebelum membahas level.'
      ]
    },
    truncated: compacted.length < analysisText.replace(/\r/g, '').length,
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
function promptFor(source, context, styleRules) {
  const common = [
    'Gunakan bahasa Indonesia yang manusiawi, hangat, natural, tidak kaku, dan boleh sedikit Gen Z bila cocok tanpa menjadi cringe.',
    'Jawab lengkap tetapi tidak berulang-ulang. Mulai dari jawaban langsung, lalu data yang dipakai, analisis atau pendapat logis, pilihan tindakan atau saran, risiko, dan data yang masih kurang.',
    'Jangan mengarang harga, berita, transaksi, kondisi real-time, atau kepastian keuntungan. Bedakan fakta sistem dari inferensi dan opini.',
    'Jangan memberi perintah BUY atau SELL mutlak. Keputusan tetap manual dan wajib mempertimbangkan batas risiko.'
  ];
  // The per-source style contract belongs in the system turn. It used to be
  // appended to `history` as a fake user turn, which both put two consecutive
  // user messages on the wire (rejected by some OpenAI-compatible upstreams) and
  // truncated the rules at the 700-char history clamp.
  const style = clean(styleRules, 3000);
  const styleBlock = style ? [style] : [];
  if (source === 'stock_analysis_followup') {
    return [
      'Anda adalah AI Pendamping Analisis Saham Auto-Cuan.',
      'Fokus hanya pada ticker dan snapshot analisis yang sedang terbuka. Jangan berubah menjadi konsultasi seluruh portofolio.',
      'Gunakan angka, indikator, level, skenario, status, alasan, serta invalidasi yang tersedia. Bila harga beli, lot, atau horizon tidak tersedia, jelaskan batasnya.',
      'Patuhi setup_state_policy pada snapshot: status pemantauan tidak boleh disebut sebagai sinyal beli terkonfirmasi.',
      ...common, ...styleBlock,
      'SNAPSHOT ANALISIS SAHAM:', JSON.stringify(context)
    ].join('\n');
  }
  return [
    'Anda adalah Asisten AI Portofolio Auto-Cuan.',
    'Fokus pada posisi atau rencana yang disimpan, pembagian modal, risiko gabungan, prioritas perhatian, dan konsultasi keputusan portofolio. Jangan menganalisis saham tunggal dari nol.',
    'Untuk curhat, jawab empatik dan masuk akal tanpa berpura-pura menjadi psikolog atau dokter.',
    'Patuhi price_freshness: harga yang tidak tersedia, tidak diketahui umurnya, atau usang wajib disebutkan apa adanya dan tidak boleh dipakai menghitung P/L.',
    'Angka turunan hanya boleh diambil dari calculation_facts atau affordability_facts bila tersedia; jangan menghitung ulang di luar itu.',
    ...common, ...styleBlock,
    'KONTEKS PORTOFOLIO:', JSON.stringify(context)
  ].join('\n');
}
function settingsFor(source, task) {
  if (source === 'stock_analysis_followup') return { temperature: 0.25, maxTokens: 900 };
  if (task === 'empathy') return { temperature: 0.5, maxTokens: 700 };
  if (task === 'heavy') return { temperature: 0.25, maxTokens: 900 };
  return { temperature: 0.35, maxTokens: 500 };
}
// The cache key must describe WHAT was asked about, not WHEN. `captured_at` is
// stamped fresh on every hydration and `age_minutes` ticks every minute, so
// hashing them verbatim gave every request a unique key: the positive cache
// never hit, and the negative cache could never short-circuit a retry storm.
// The freshness CLASSIFICATION is semantic and stays in the key, because an
// answer built on a stale price is not interchangeable with one built on a
// fresh price.
function cacheKeyContext(context) {
  const input = context && typeof context === 'object' ? context : {};
  const stable = {};
  Object.keys(input).forEach((key) => {
    if (key === 'captured_at' || key === 'price_meta') return;
    if (key === 'price_freshness') {
      const freshness = input[key] && typeof input[key] === 'object' ? input[key] : {};
      stable.price_freshness = {
        without_price: freshness.tickers_without_price || [],
        stale: freshness.tickers_with_stale_price || [],
        unknown_age: freshness.tickers_with_unknown_price_age || []
      };
      return;
    }
    stable[key] = input[key];
  });
  return stable;
}
function requestKey(userId, source, task, message, context, historyRows) {
  return crypto.createHash('sha256').update(JSON.stringify({
    userId, source, task, message: message.toLowerCase(), context: cacheKeyContext(context), historyRows
  })).digest('hex');
}
async function runModels({ baseUrl, apiKey, models, messages, settings, perModel, totalLimit, source, task, userId }) {
  const started = nowMs();
  const attempts = [];
  // One compatibility retry for the whole request, so a provider that rejects an
  // optional parameter cannot turn into an unbounded retry loop.
  let compatRetryUsed = false;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    let omitOptionalParams = false;

    for (;;) {
      const remaining = totalLimit - (nowMs() - started);
      const slice = attemptSlice(remaining, perModel, models.length - index);
      if (!slice) return { ok: false, budgetExhausted: true, attempts, elapsed: nowMs() - started };

      const result = await callModel(baseUrl, apiKey, model, messages, settings, slice, { omitOptionalParams });
      attempts.push({
        model, status: result.status, ok: result.ok, latency_ms: result.latency,
        reason: result.reason || null, timed_out: Boolean(result.timedOut),
        compatibility_retry: omitOptionalParams
      });

      if (result.ok) {
        recordSuccess(model, result.latency);
        sticky.set(userId + ':' + source + ':' + task, model);
        sticky.set(userId + ':global', model);
        return { ok: true, result, attempts, elapsed: nowMs() - started };
      }

      recordFailure(model, result.retriable);
      console.warn('context-ai attempt failed', JSON.stringify({
        source, model, status: result.status, retriable: result.retriable,
        timed_out: result.timedOut, latency_ms: result.latency, compatibility_retry: omitOptionalParams
      }));

      // An invalid key or an exhausted balance is the same for every model on
      // the pool, so trying more of them only wastes the remaining budget.
      if (!result.retriable) return { ok: false, terminal: result, attempts, elapsed: nowMs() - started };

      if (result.paramRejected && !compatRetryUsed && !omitOptionalParams) {
        compatRetryUsed = true;
        omitOptionalParams = true;
        continue;
      }
      break;
    }
  }
  return { ok: false, attempts, elapsed: nowMs() - started };
}

module.exports = async function handleContextAI(req, res) {
  // Everything before the first model call — session verification, the Supabase
  // account read, context hydration, the model-directory probe — spends the same
  // platform budget the model attempts do. Measuring from here keeps the total
  // under the function's hard limit instead of only bounding the model phase.
  const handlerStarted = nowMs();
  try {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    const source = req.body && req.body.source;
    if (!['portfolio_chat', 'stock_analysis_followup'].includes(source)) return res.status(400).json({ success: false, error: 'Sumber AI tidak valid.' });
    const access = await verify(req);
    if (!access.ok) return res.status(access.status || 403).json({ success: false, code: 'AI_ACCESS_DENIED', error: access.error });
    const userId = String(access.account.id);
    pruneUnbounded(nowMs());
    const limit = rateLimitState(userId + ':' + source);
    if (!limit.ok) {
      return res.status(429).json({
        success: false, code: 'AI_RATE_LIMITED',
        error: 'Terlalu banyak pertanyaan dalam waktu singkat. Tunggu sebentar lalu coba lagi.',
        retry_after_seconds: limit.retryAfterSeconds
      });
    }
    const message = clean(req.body && req.body.chatMessage, 2500);
    if (!message) return res.status(400).json({ success: false, code: 'AI_EMPTY_QUESTION', error: 'Pertanyaan belum diisi.' });

    const context = source === 'stock_analysis_followup' ? stockContext(req.body.context) : portfolioContext(req.body.context);
    if (source === 'stock_analysis_followup' && (!context.ticker || !context.analysis_text)) return res.status(400).json({ success: false, code: 'AI_STOCK_SNAPSHOT_MISSING', error: 'Jalankan analisis ticker terlebih dahulu sebelum bertanya lanjutan.' });
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
    // The negative cache exists to stop an automatic retry storm from burning
    // tokens, not to stand between a person and the button they just pressed.
    // A client-declared retry skips it; the per-user rate limit above still
    // bounds how often that can happen.
    const userRetry = req.body && req.body.retry === true;
    const recentFailure = failureCache.get(key);
    if (recentFailure && recentFailure.expiresAt > now && !userRetry) {
      return res.status(503).json({
        success: false, code: 'AI_RECENT_FAILURE', error: recentFailure.error,
        retry_after_seconds: Math.ceil((recentFailure.expiresAt - now) / 1000),
        provider_failed: true, token_saved: true
      });
    }
    if (userRetry) failureCache.delete(key);

    const settings = settingsFor(source, task);
    const styleRules = clean(req.body && req.body.styleRules, 3000);
    const messages = [{ role: 'system', content: promptFor(source, context, styleRules) }].concat(historyRows, [{ role: 'user', content: message }]);
    const perModel = bounded(process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS, MIN_MODEL_TIMEOUT_MS, MAX_MODEL_TIMEOUT_MS);
    const totalLimit = bounded(process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, 10000, 50000);
    let models = orderedModels(source, task, userId);
    const available = await fetchAvailableModels(baseUrl, apiKey);
    if (available) {
      const filtered = models.filter((model) => available.has(model));
      if (filtered.length) models = filtered;
    }
    models = models.slice(0, attemptLimit(source, task));
    const modelBudget = Math.max(MIN_ATTEMPT_SLICE_MS, totalLimit - (nowMs() - handlerStarted));

    let promise = inFlight.get(key);
    const joinedExisting = Boolean(promise);
    if (!promise) {
      promise = runModels({ baseUrl, apiKey, models, messages, settings, perModel, totalLimit: modelBudget, source, task, userId });
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

    const attemptedModels = outcome.attempts.map((x) => x.model);
    const timedOutCount = outcome.attempts.filter((x) => x.timed_out).length;
    const failureTtl = bounded(process.env.PORTFOLIO_AI_FAILURE_CACHE_MS, DEFAULT_FAILURE_CACHE_MS, 10000, 5 * 60 * 1000);

    // Only a credential/balance/permission rejection is terminal now, and it is
    // identical for every model behind the same key — so it is a configuration
    // problem to report, not a "provider is busy" state to retry around.
    if (outcome.terminal) {
      return res.status(503).json({
        success: false, code: 'AI_KEY_OR_BALANCE_ERROR',
        error: 'API key tidak valid, akses model ditolak, atau saldo token bermasalah. Hubungi admin.',
        attempted_models: attemptedModels, attempted_count: outcome.attempts.length,
        provider_failed: true
      });
    }

    const allTimedOut = outcome.attempts.length > 0 && timedOutCount === outcome.attempts.length;
    const error = !outcome.attempts.length
      ? 'Tidak ada model aktif yang cocok ditemukan.'
      : allTimedOut
        ? 'Semua model yang dicoba melewati batas waktu. Coba lagi, atau persingkat pertanyaannya.'
        : 'Semua model yang dicoba menolak request atau sedang penuh. Coba lagi setelah beberapa saat.';
    failureCache.set(key, { error, expiresAt: nowMs() + failureTtl });
    console.warn('context-ai exhausted', JSON.stringify({
      source, task, attempts: outcome.attempts.length, timed_out: timedOutCount,
      budget_exhausted: Boolean(outcome.budgetExhausted), elapsed_ms: outcome.elapsed
    }));
    return res.status(503).json({
      success: false,
      code: allTimedOut ? 'AI_ALL_MODELS_TIMED_OUT' : 'AI_MODELS_FAILED_SAFE_STOP',
      error,
      attempted_models: attemptedModels,
      attempted_count: outcome.attempts.length,
      timed_out_count: timedOutCount,
      budget_exhausted: Boolean(outcome.budgetExhausted),
      provider_failed: true,
      retry_after_seconds: Math.ceil(failureTtl / 1000),
      token_protection: true
    });
  } catch (error) {
    console.error('context-ai exception', error && error.message);
    return res.status(500).json({ success: false, code: 'AI_UNEXPECTED_ERROR', error: 'Asisten AI lagi gangguan. Coba lagi sebentar ya.' });
  }
};

module.exports._test = {
  attemptSlice,
  extractSetupStates,
  isParameterRejection,
  modelRouteFailure,
  isKeyOrBalanceFailure,
  number,
  portfolioContext,
  stockContext,
  priceFreshness,
  promptFor,
  attemptLimit,
  runModels,
  rateLimitState,
  buckets,
  health,
  sticky,
  responseCache,
  failureCache,
  resetState() {
    buckets.clear(); health.clear(); sticky.clear();
    responseCache.clear(); failureCache.clear(); inFlight.clear();
    modelDirectoryCache = { ids: null, expiresAt: 0 };
  }
};
'use strict';

const { resolvePremiumAccess } = require('./subscription-auth');
const { requireAuthenticatedSession } = require('./admin-session');
const { getChartAnalysisSystemPrompt, MANDATORY_SECTIONS } = require('./chart-analysis-prompt');
const { getUserApiKey } = require('./user-ai-credentials');
const { fetchChartOhlc, buildChartPng, normalizeForeignTicker } = require('./chart-image-renderer');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const PRIMARY_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODEL = 'gemini-1.5-flash';
const REQUEST_TIMEOUT_MS = 25000;
const ANTI_SPAM_DEBOUNCE_MS = 5000;

// Daily quota tiers
const QUOTA_TIERS = Object.freeze({
  FREE: { tier: 'free', maxDaily: 3, label: 'Gratis' },
  PREMIUM: { tier: 'premium', maxDaily: 10, label: 'Bulanan / Premium' },
  LIFETIME: { tier: 'lifetime', maxDaily: Infinity, label: 'Lifetime' }
});

// Memory fallbacks for test & DB-less modes
const memoryUsage = new Map(); // key: `${userId}:${wibDate}` -> { count: number, lastAt: number }
const memoryCache = new Map(); // key: `chart_ai:${userId}:${ticker}:${wibDate}` -> { result: string, timestamp: number }

function getWibDateString(date = new Date()) {
  const wib = new Date(date.getTime() + (7 * 60 * 60 * 1000));
  return wib.toISOString().slice(0, 10);
}

function resolveUserTier(access) {
  if (!access) return QUOTA_TIERS.FREE;
  const username = String(access.user && access.user.username || '').trim().toLowerCase();
  const isAdmin = access.user && access.user.isAdmin === true;
  const entitlement = access.entitlement;

  if (isAdmin || username === 'budi' || (entitlement && (entitlement.lifetime_state === 'active' || entitlement.lifetime_state === 'lifetime' || entitlement.current_plan === 'lifetime'))) {
    return QUOTA_TIERS.LIFETIME;
  }
  if (access.premium === true || (entitlement && entitlement.premium === true)) {
    return QUOTA_TIERS.PREMIUM;
  }
  return QUOTA_TIERS.FREE;
}

async function getUserUsage(db, userId, wibDate) {
  const memKey = `${userId}:${wibDate}`;
  let row = null;
  if (db && typeof db.from === 'function') {
    try {
      const res = await db.from('user_chart_analysis_usage')
        .select('analysis_count, updated_at')
        .eq('user_id', userId)
        .eq('usage_date', wibDate)
        .maybeSingle();
      if (!res.error && res.data) {
        row = {
          count: Number(res.data.analysis_count) || 0,
          lastAt: new Date(res.data.updated_at || 0).getTime()
        };
      }
    } catch (_) {}
  }
  if (!row) {
    row = memoryUsage.get(memKey) || { count: 0, lastAt: 0 };
  }
  return row;
}

async function incrementUserUsage(db, userId, wibDate) {
  const memKey = `${userId}:${wibDate}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const current = await getUserUsage(db, userId, wibDate);
  const nextCount = current.count + 1;

  memoryUsage.set(memKey, { count: nextCount, lastAt: now });

  if (db && typeof db.from === 'function') {
    try {
      await db.from('user_chart_analysis_usage').upsert({
        user_id: userId,
        usage_date: wibDate,
        analysis_count: nextCount,
        updated_at: nowIso
      }, { onConflict: 'user_id,usage_date' });
    } catch (_) {}
  }
  return nextCount;
}

function getCacheKey(userId, ticker, wibDate) {
  // STRICT USER ISOLATION: userId is embedded in cache key to guarantee
  // User A's AI output is NEVER returned to User B.
  return `chart_ai:${userId}:${ticker}:${wibDate}`;
}

async function getCachedAnalysis(db, userId, ticker, wibDate) {
  const key = getCacheKey(userId, ticker, wibDate);
  if (db && typeof db.from === 'function') {
    try {
      const res = await db.from('ai_analysis_cache')
        .select('payload_response, created_at')
        .eq('cache_key', key)
        .maybeSingle();
      if (!res.error && res.data && res.data.payload_response) {
        return res.data.payload_response;
      }
    } catch (_) {}
  }
  return memoryCache.get(key) || null;
}

async function setCachedAnalysis(db, userId, ticker, wibDate, payload) {
  const key = getCacheKey(userId, ticker, wibDate);
  memoryCache.set(key, payload);
  if (db && typeof db.from === 'function') {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + (24 * 60 * 60 * 1000));
      await db.from('ai_analysis_cache').upsert({
        cache_key: key,
        ticker,
        analysis_type: 'chart_vision_byok',
        payload_response: payload,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString()
      });
    } catch (_) {}
  }
}

async function callGeminiVision(apiKey, systemPrompt, ticker, base64Png, model = PRIMARY_MODEL, fetchFn = globalThis.fetch) {
  const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Analisis chart candlestick saham ${ticker} pada gambar berikut sesuai instruksi sistem.` },
          { inlineData: { mimeType: 'image/png', data: base64Png } }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 2048
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const status = res.status;
      let errorBody = {};
      try { errorBody = await res.json(); } catch (_) {}
      const errMsg = errorBody.error && errorBody.error.message ? errorBody.error.message : `HTTP ${status}`;
      if (status === 400 || status === 403) {
        return { ok: false, status, code: 'GEMINI_KEY_REJECTED', error: 'Google Gemini menolak API key Anda. Periksa kembali apakah API key valid dan memiliki kuota di Google AI Studio (' + errMsg + ').' };
      }
      if (status === 404 && model !== FALLBACK_MODEL) {
        return callGeminiVision(apiKey, systemPrompt, ticker, base64Png, FALLBACK_MODEL, fetchFn);
      }
      return { ok: false, status, code: 'GEMINI_API_ERROR', error: `Gemini API error: ${errMsg}` };
    }

    const data = await res.json();
    const candidates = data && data.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0 || !candidates[0].content) {
      return { ok: false, status: 502, code: 'GEMINI_EMPTY_RESPONSE', error: 'AI tidak menghasilkan respons visual untuk gambar ini.' };
    }
    const textPart = candidates[0].content.parts && candidates[0].content.parts.find(p => p.text);
    if (!textPart || !textPart.text) {
      return { ok: false, status: 502, code: 'GEMINI_NO_TEXT', error: 'Format respons AI kosong atau tidak sesuai.' };
    }

    return { ok: true, text: textPart.text.trim(), model };
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 504, code: 'GEMINI_TIMEOUT', error: 'Permintaan ke Gemini Vision melampaui batas waktu 25 detik. Silakan coba lagi.' };
    }
    return { ok: false, status: 500, code: 'GEMINI_NETWORK_ERROR', error: 'Gagal terhubung ke Google Gemini Vision.' };
  }
}

async function getAnalysisStatus(req, db, ticker, options = {}) {
  const auth = options.auth || requireAuthenticatedSession(req);
  if (!auth.ok) return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  const userId = auth.session.uid;

  let access = null;
  try { access = await resolvePremiumAccess(req, db); } catch (_) {}
  const tierConfig = resolveUserTier(access);

  const wibDate = getWibDateString();
  const [keyInfo, usage] = await Promise.all([
    getUserApiKey(db, userId),
    getUserUsage(db, userId, wibDate)
  ]);

  const maxDaily = tierConfig.maxDaily;
  const usedToday = usage.count;
  const remainingQuota = isFinite(maxDaily) ? Math.max(0, maxDaily - usedToday) : null;
  const isUnlimited = !isFinite(maxDaily);

  let cached = null;
  const safeTicker = normalizeForeignTicker(ticker);
  if (safeTicker) {
    cached = await getCachedAnalysis(db, userId, safeTicker, wibDate);
  }

  return {
    ok: true,
    status: 200,
    hasKey: keyInfo.hasKey,
    maskedKey: keyInfo.maskedKey,
    tier: tierConfig.tier,
    tierLabel: tierConfig.label,
    maxDaily: isUnlimited ? 'unlimited' : maxDaily,
    usedToday,
    remainingQuota: isUnlimited ? 'unlimited' : remainingQuota,
    wibDate,
    cached
  };
}

async function runChartAnalysis(req, db, ticker, options = {}) {
  const auth = options.auth || requireAuthenticatedSession(req);
  if (!auth.ok) return { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'Sesi tidak valid.' };
  const userId = auth.session.uid;

  const safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return { ok: false, status: 400, error: 'Kode saham (ticker) tidak valid.' };

  // 1. Check API key presence
  const keyInfo = await getUserApiKey(db, userId);
  if (!keyInfo.hasKey || !keyInfo.apiKey) {
    return {
      ok: false,
      status: 400,
      code: 'API_KEY_REQUIRED',
      error: 'API key Google Gemini belum diisi. Masukkan API key Gemini Anda terlebih dahulu di pengaturan.'
    };
  }

  // 2. Check quota and rate limit
  let access = null;
  try { access = await resolvePremiumAccess(req, db); } catch (_) {}
  const tierConfig = resolveUserTier(access);
  const wibDate = getWibDateString();
  const usage = await getUserUsage(db, userId, wibDate);

  // Anti-spam debounce
  const now = Date.now();
  if (usage.lastAt && (now - usage.lastAt) < ANTI_SPAM_DEBOUNCE_MS) {
    const waitSec = Math.ceil((ANTI_SPAM_DEBOUNCE_MS - (now - usage.lastAt)) / 1000);
    return {
      ok: false,
      status: 429,
      code: 'TOO_MANY_REQUESTS',
      error: `Harap tunggu ${waitSec} detik sebelum meminta analisis berikutnya.`
    };
  }

  // Daily quota check
  if (isFinite(tierConfig.maxDaily) && usage.count >= tierConfig.maxDaily) {
    return {
      ok: false,
      status: 429,
      code: 'QUOTA_EXCEEDED',
      error: `Batas kuota harian Anda telah tercapai (${usage.count}/${tierConfig.maxDaily} analisis hari ini). Kuota akan direset pada pukul 00:00 WIB.`
    };
  }

  // 3. Return cache if available and not forced
  if (!options.forceFresh) {
    const cached = await getCachedAnalysis(db, userId, safeTicker, wibDate);
    if (cached) {
      return {
        ok: true,
        status: 200,
        cached: true,
        data: cached
      };
    }
  }

  // 4. Fetch OHLC & render chart PNG
  const ohlc = await fetchChartOhlc(db, safeTicker, options);
  if (!ohlc.rows || ohlc.rows.length < 5) {
    return {
      ok: false,
      status: 422,
      code: 'INSUFFICIENT_DATA',
      error: `Data candlestick untuk ${safeTicker} belum cukup untuk dianalisis AI.`
    };
  }

  let pngBuffer;
  try {
    pngBuffer = buildChartPng(safeTicker, wibDate, ohlc.rows, options.planLevels || []);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      code: 'RENDER_FAILED',
      error: 'Gagal membuat gambar chart untuk analisis visual.'
    };
  }

  const base64Png = pngBuffer.toString('base64');
  const systemPrompt = getChartAnalysisSystemPrompt(safeTicker);

  // 5. Call Gemini Vision API
  const visionRes = await callGeminiVision(
    keyInfo.apiKey,
    systemPrompt,
    safeTicker,
    base64Png,
    PRIMARY_MODEL,
    options.fetchFn || globalThis.fetch
  );

  if (!visionRes.ok) {
    return visionRes;
  }

  // 6. Record usage & cache result
  await incrementUserUsage(db, userId, wibDate);

  const payload = {
    ticker: safeTicker,
    date: wibDate,
    analysisText: visionRes.text,
    model: visionRes.model,
    analyzedAt: new Date().toISOString()
  };

  await setCachedAnalysis(db, userId, safeTicker, wibDate, payload);

  const updatedUsage = await getUserUsage(db, userId, wibDate);
  const remaining = isFinite(tierConfig.maxDaily) ? Math.max(0, tierConfig.maxDaily - updatedUsage.count) : 'unlimited';

  return {
    ok: true,
    status: 200,
    cached: false,
    data: payload,
    quota: {
      usedToday: updatedUsage.count,
      maxDaily: isFinite(tierConfig.maxDaily) ? tierConfig.maxDaily : 'unlimited',
      remaining
    }
  };
}

function clearMemoryStoresForTesting() {
  memoryUsage.clear();
  memoryCache.clear();
}

module.exports = {
  QUOTA_TIERS,
  getWibDateString,
  resolveUserTier,
  getCacheKey,
  getAnalysisStatus,
  runChartAnalysis,
  callGeminiVision,
  clearMemoryStoresForTesting
};

'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const memoryCache = new Map();

let _customSupabaseClient = null;

function setSupabaseClient(client) {
  _customSupabaseClient = client;
}

function getSupabaseClient() {
  if (_customSupabaseClient !== null) return _customSupabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function computeCacheKey(params = {}) {
  const ticker = String(params.ticker || '').toUpperCase().trim();
  const analysisType = String(params.analysisType || 'stock_analysis').trim().toLowerCase();
  const prompt = String(params.prompt || '').trim();
  const marketDate = String(params.marketDate || new Date().toISOString().slice(0, 10)).trim();
  const extra = params.extra ? JSON.stringify(params.extra) : '';

  const raw = analysisType + '|' + ticker + '|' + marketDate + '|' + prompt + '|' + extra;
  return crypto.createHash('sha256').update(raw).digest('hex');
}
	async function getCachedAnalysis(params = {}) {
  const cacheKey = params.cacheKey || computeCacheKey(params);
  const now = Date.now();

  // Check memory cache first
  const mem = memoryCache.get(cacheKey);
  if (mem && mem.expiresAt > now) {
    return Object.assign({}, mem.payload, { source: 'db_cache', cache_hit: true });
  }

  const db = params.dbClient !== undefined ? params.dbClient : getSupabaseClient();
  if (!db) {
    return null;
  }

  try {
    const { data, error } = await db
      .from('ai_analysis_cache')
      .select('payload_response, expires_at')
      .eq('cache_key', cacheKey)
      .maybeSingle();

    if (error || !data) return null;

    const expiresAt = new Date(data.expires_at).getTime();
    if (expiresAt <= now) {
      return null;
    }

    const payload = typeof data.payload_response === 'string'
      ? JSON.parse(data.payload_response)
      : data.payload_response;

    // Refresh memory cache
    const tickerFromPayload = (payload && payload.ticker) ? String(payload.ticker).toUpperCase().trim() : null;
    memoryCache.set(cacheKey, {
      payload,
      expiresAt,
      ticker: (params.ticker ? String(params.ticker).toUpperCase().trim() : null) || tickerFromPayload
    });

    return Object.assign({}, payload, { source: 'db_cache', cache_hit: true });
  } catch (_) {
    return null;
  }
}

async function setCachedAnalysis(params = {}) {
  const cacheKey = params.cacheKey || computeCacheKey(params);
  const ticker = params.ticker ? String(params.ticker).toUpperCase().trim() : null;
  const analysisType = String(params.analysisType || 'stock_analysis').trim().toLowerCase();
  const payloadResponse = params.payloadResponse || {};
  const ttlSeconds = typeof params.ttlSeconds === 'number'
    ? params.ttlSeconds
    : DEFAULT_TTL_SECONDS;

  const now = Date.now();
  const expiresAtMs = now + (ttlSeconds * 1000);
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  // Update memory cache with ticker tag
  memoryCache.set(cacheKey, { payload: payloadResponse, expiresAt: expiresAtMs, ticker });

  const db = params.dbClient !== undefined ? params.dbClient : getSupabaseClient();
  if (!db) {
    return false;
  }

  try {
    const row = {
      cache_key: cacheKey,
      ticker,
      analysis_type: analysisType,
      payload_response: payloadResponse,
      created_at: new Date(now).toISOString(),
      expires_at: expiresAtIso
    };

    const { error } = await db
      .from('ai_analysis_cache')
      .upsert(row, { onConflict: 'cache_key' });

    return !error;
  } catch (_) {
    return false;
  }
}

async function purgeExpiredAnalysisCache(params = {}) {
  const now = Date.now();
  let memoryPurged = 0;

  for (const [key, item] of memoryCache.entries()) {
    if (!item || item.expiresAt <= now) {
      memoryCache.delete(key);
      memoryPurged++;
    }
  }

  const db = params.dbClient !== undefined ? params.dbClient : getSupabaseClient();
  if (!db) {
    return { success: true, memoryPurged, dbPurged: 0, purgedCount: memoryPurged };
  }

  try {
    const nowIso = new Date(now).toISOString();
    const { data, error, count } = await db
      .from('ai_analysis_cache')
      .delete({ count: 'exact' })
      .lt('expires_at', nowIso);

    if (error) {
      return { success: false, error: error.message, memoryPurged, dbPurged: 0, purgedCount: memoryPurged };
    }

    const dbPurged = typeof count === 'number' ? count : (Array.isArray(data) ? data.length : 0);
    return { success: true, memoryPurged, dbPurged, purgedCount: memoryPurged + dbPurged };
  } catch (err) {
    return { success: false, error: err.message, memoryPurged, dbPurged: 0, purgedCount: memoryPurged };
  }
}

async function invalidateAnalysisCacheByTicker(params = {}) {
  const rawTicker = params.ticker;
  if (!rawTicker || typeof rawTicker !== 'string' || !rawTicker.trim()) {
    return { success: false, error: 'Ticker is required for cache invalidation' };
  }
  const ticker = rawTicker.toUpperCase().trim();
  let memoryInvalidated = 0;

  for (const [key, item] of memoryCache.entries()) {
    if (item && item.ticker === ticker) {
      memoryCache.delete(key);
      memoryInvalidated++;
    }
  }

  const db = params.dbClient !== undefined ? params.dbClient : getSupabaseClient();
  if (!db) {
    return { success: true, ticker, memoryInvalidated, dbInvalidated: 0, invalidatedCount: memoryInvalidated };
  }

  try {
    const { data, error, count } = await db
      .from('ai_analysis_cache')
      .delete({ count: 'exact' })
      .eq('ticker', ticker);

    if (error) {
      return { success: false, error: error.message, ticker, memoryInvalidated, dbInvalidated: 0, invalidatedCount: memoryInvalidated };
    }

    const dbInvalidated = typeof count === 'number' ? count : (Array.isArray(data) ? data.length : 0);
    return { success: true, ticker, memoryInvalidated, dbInvalidated, invalidatedCount: memoryInvalidated + dbInvalidated };
  } catch (err) {
    return { success: false, error: err.message, ticker, memoryInvalidated, dbInvalidated: 0, invalidatedCount: memoryInvalidated };
  }
}

function clearMemoryCache() {
  memoryCache.clear();
}

const {
  getAiTelemetryStats,
  resetAiTelemetryStats,
  recordRequest,
  recordCacheHit,
  recordGeminiCall,
  recordLocalFallback
} = require('./ai-telemetry');

module.exports = {
  computeCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
  clearMemoryCache,
  setSupabaseClient,
  purgeExpiredAnalysisCache,
  invalidateAnalysisCacheByTicker,
  getAiTelemetryStats,
  resetAiTelemetryStats,
  recordRequest,
  recordCacheHit,
  recordGeminiCall,
  recordLocalFallback,
  DEFAULT_TTL_SECONDS
};

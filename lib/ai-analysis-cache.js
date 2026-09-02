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
    memoryCache.set(cacheKey, { payload,
expiresAt });

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

  // Update memory cache
  memoryCache.set(cacheKey, { payload: payloadResponse, expiresAt: expiresAtMs });

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

function clearMemoryCache() {
  memoryCache.clear();
}

module.exports = {
  computeCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
  clearMemoryCache,
  setSupabaseClient,
  DEFAULT_TTL_SECONDS
};
